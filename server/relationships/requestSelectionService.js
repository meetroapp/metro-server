"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  parsePositiveInteger,
} = require("./requestRelationships");
const {
  ensureConversationParticipantStatesWithClient,
} = require("../conversations/conversationParticipantStateService");

const COMMAND_NAME = "request_selection.select";
const IMPLEMENTATION_MILESTONE_ID =
  "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-3";
const IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function requirePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

function normalizeActorId(authenticatedActor) {
  return parsePositiveInteger(authenticatedActor?.id);
}

function validateSelectionPayload(payload) {
  if (
    payload === undefined ||
    (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      [Object.prototype, null].includes(
        Object.getPrototypeOf(payload)
      ) &&
      Object.keys(payload).length === 0
    )
  ) {
    return { valid: true };
  }

  return {
    valid: false,
    code: "UNSUPPORTED_REQUEST_SELECTION_FIELDS",
    message: "Selection identity is managed by Meetro.",
  };
}

function validateSelectionIdempotencyKey(value) {
  const idempotencyKey =
    typeof value === "string" ? value.trim() : "";

  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return {
      valid: false,
      code: "INVALID_REQUEST_SELECTION_IDEMPOTENCY_KEY",
      message: "A valid selection idempotency key is required.",
    };
  }

  return { valid: true, value: idempotencyKey };
}

function createSelectionFingerprint({ postId, responseId }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        commandName: COMMAND_NAME,
        postId,
        responseId: String(responseId),
      })
    )
    .digest("hex");
}

function sameId(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function canonicalPairIsValid(response, relationship) {
  if (!response || !relationship) return false;

  const statusPairs = {
    submitted: "pending",
    selected: "active",
    withdrawn: "closed",
    declined: "closed",
    not_selected: "closed",
    expired: "closed",
    cancelled: "closed",
    closed: "closed",
  };

  return Boolean(
    sameId(response.request_relationship_id, relationship.id) &&
      sameId(response.id, relationship.professional_response_id) &&
      sameId(response.post_id, relationship.post_id) &&
      relationship.emergency_request_id == null &&
      sameId(response.homeowner_id, relationship.homeowner_id) &&
      sameId(response.contractor_id, relationship.contractor_id) &&
      sameId(
        response.professional_user_id,
        relationship.professional_user_id
      ) &&
      sameId(
        response.professional_user_id,
        response.profile_owner_user_id
      ) &&
      relationship.ordinary_authority_source ===
        "professional_response" &&
      Number(response.current_version) > 0 &&
      Number(response.current_version) ===
        Number(relationship.current_version) &&
      statusPairs[response.status] === relationship.status &&
      typeof response.content_fingerprint === "string" &&
      /^[0-9a-f]{64}$/.test(response.content_fingerprint)
  );
}

function selectionResultIsValid(row) {
  return Boolean(
    row &&
      row.selection_id &&
      sameId(row.selection_post_id, row.post_id) &&
      sameId(row.selection_response_id, row.response_id) &&
      sameId(row.selection_relationship_id, row.relationship_id) &&
      sameId(row.selection_homeowner_id, row.homeowner_id) &&
      sameId(row.selection_contractor_id, row.contractor_id) &&
      sameId(
        row.selection_professional_user_id,
        row.professional_user_id
      ) &&
      Number(row.selected_response_version) ===
        Number(row.response_current_version) &&
      row.response_status === "selected" &&
      row.relationship_status === "active" &&
      sameId(row.conversation_id, row.selection_conversation_id) &&
      sameId(row.conversation_selection_id, row.selection_id) &&
      sameId(row.conversation_relationship_id, row.relationship_id) &&
      sameId(row.conversation_homeowner_id, row.homeowner_id) &&
      sameId(row.conversation_contractor_id, row.contractor_id) &&
      sameId(
        row.conversation_professional_user_id,
        row.professional_user_id
      ) &&
      row.conversation_status === "active" &&
      row.selection_ended_at == null
  );
}

function serializeSelectionResult(row, {
  classification = "created",
  replayed = false,
} = {}) {
  return {
    selection: {
      id: row.selection_id,
      request_id: row.post_id,
      response_id: row.response_id,
      selected_response_version:
        row.selected_response_version,
      selected_at: row.selected_at,
    },
    response: {
      id: row.response_id,
      request_id: row.post_id,
      status: row.response_status,
      current_version: row.response_current_version,
      introduction_text: row.introduction_text,
      submitted_at: row.submitted_at,
      selected_at: row.response_selected_at,
      business_profile: {
        business_name: row.business_name || "",
        category: row.professional_category || "",
        image_url: row.business_image_url || "",
      },
    },
    relationship: {
      id: row.relationship_id,
      request_id: row.post_id,
      status: row.relationship_status,
      authority_source: row.ordinary_authority_source,
      current_version: row.relationship_current_version,
      activated_at: row.accepted_at,
    },
    conversation: {
      id: row.conversation_id,
      relationship_id: row.relationship_id,
      status: row.conversation_status,
    },
    privacy_stage: 3,
    resultClassification: classification,
    replayed,
  };
}

async function selectSelectionResult({
  client,
  postId,
  selectionId = null,
  lock = false,
}) {
  const result = await client.query(
    `
    /* request_selection:canonical_result */
    SELECT
      request_selections.id AS selection_id,
      request_selections.post_id AS selection_post_id,
      request_selections.professional_response_id
        AS selection_response_id,
      request_selections.request_relationship_id
        AS selection_relationship_id,
      request_selections.selected_by_user_id
        AS selection_homeowner_id,
      request_selections.contractor_id
        AS selection_contractor_id,
      request_selections.professional_user_id
        AS selection_professional_user_id,
      request_selections.selected_response_version,
      request_selections.conversation_id
        AS selection_conversation_id,
      request_selections.selected_at,
      request_selections.ended_at AS selection_ended_at,
      professional_responses.id AS response_id,
      professional_responses.post_id,
      professional_responses.homeowner_id,
      professional_responses.contractor_id,
      professional_responses.professional_user_id,
      professional_responses.status AS response_status,
      professional_responses.current_version
        AS response_current_version,
      professional_responses.introduction_text,
      professional_responses.submitted_at,
      professional_responses.selected_at AS response_selected_at,
      request_relationships.id AS relationship_id,
      request_relationships.status AS relationship_status,
      request_relationships.ordinary_authority_source,
      request_relationships.current_version
        AS relationship_current_version,
      request_relationships.accepted_at,
      conversations.id AS conversation_id,
      conversations.request_selection_id
        AS conversation_selection_id,
      conversations.relationship_id
        AS conversation_relationship_id,
      conversations.homeowner_id AS conversation_homeowner_id,
      conversations.contractor_id AS conversation_contractor_id,
      conversations.professional_user_id
        AS conversation_professional_user_id,
      conversations.status AS conversation_status,
      contractor_profiles.business_name,
      contractor_profiles.category AS professional_category,
      contractor_profiles.image_url AS business_image_url
    FROM request_selections
    INNER JOIN professional_responses
      ON professional_responses.id =
        request_selections.professional_response_id
    INNER JOIN request_relationships
      ON request_relationships.id =
        request_selections.request_relationship_id
    INNER JOIN conversations
      ON conversations.id = request_selections.conversation_id
    INNER JOIN contractor_profiles
      ON contractor_profiles.id = request_selections.contractor_id
      AND contractor_profiles.user_id =
        request_selections.professional_user_id
    WHERE request_selections.post_id = $1
      AND ($2::bigint IS NULL OR request_selections.id = $2)
      AND (
        $2::bigint IS NOT NULL
        OR request_selections.ended_at IS NULL
      )
    ORDER BY request_selections.id ASC
    LIMIT 2
    ${lock ? "FOR UPDATE OF request_selections, conversations" : ""}
    `,
    [postId, selectionId]
  );

  if (result.rows.length !== 1) return null;
  return selectionResultIsValid(result.rows[0])
    ? result.rows[0]
    : null;
}

async function loadLockedParticipation({ client, postId }) {
  const relationshipResult = await client.query(
    `
    /* request_selection:relationship_locks */
    SELECT
      request_relationships.*,
      EXISTS (
        SELECT 1
        FROM conversations
        WHERE conversations.relationship_id = request_relationships.id
      ) AS conversation_exists,
      EXISTS (
        SELECT 1
        FROM conversations
        INNER JOIN request_selections
          ON request_selections.id = conversations.request_selection_id
          AND request_selections.conversation_id = conversations.id
          AND request_selections.request_relationship_id =
            request_relationships.id
          AND request_selections.professional_response_id =
            request_relationships.professional_response_id
          AND request_selections.post_id = request_relationships.post_id
          AND request_selections.ended_at IS NULL
        WHERE conversations.relationship_id = request_relationships.id
      ) AS conversation_has_selection_authority
    FROM request_relationships
    WHERE request_relationships.post_id = $1
      AND request_relationships.emergency_request_id IS NULL
    ORDER BY request_relationships.id ASC
    FOR UPDATE
    `,
    [postId]
  );

  const responseResult = await client.query(
    `
    /* request_selection:response_locks */
    SELECT
      professional_responses.*,
      contractor_profiles.user_id AS profile_owner_user_id,
      contractor_profiles.business_name,
      contractor_profiles.category AS professional_category,
      contractor_profiles.image_url AS business_image_url,
      professional_response_versions.content_fingerprint
    FROM professional_responses
    LEFT JOIN contractor_profiles
      ON contractor_profiles.id = professional_responses.contractor_id
    LEFT JOIN professional_response_versions
      ON professional_response_versions.professional_response_id =
        professional_responses.id
      AND professional_response_versions.version =
        professional_responses.current_version
    WHERE professional_responses.post_id = $1
    ORDER BY professional_responses.id ASC
    FOR UPDATE OF professional_responses
    `,
    [postId]
  );

  const relationshipsById = new Map(
    relationshipResult.rows.map((row) => [String(row.id), row])
  );
  const responsesById = new Map(
    responseResult.rows.map((row) => [String(row.id), row])
  );

  const hasLegacyOrMalformedRelationship =
    relationshipResult.rows.some((relationship) => {
      const response = responsesById.get(
        String(relationship.professional_response_id || "")
      );
      return (
        !response ||
        !canonicalPairIsValid(response, relationship) ||
        (
          relationship.conversation_exists === true &&
          relationship.conversation_has_selection_authority !== true
        )
      );
    });

  const hasOrphanOrMalformedResponse =
    responseResult.rows.some((response) => {
      const relationship = relationshipsById.get(
        String(response.request_relationship_id || "")
      );
      return !canonicalPairIsValid(response, relationship);
    });

  return {
    relationshipRows: relationshipResult.rows,
    responseRows: responseResult.rows,
    relationshipsById,
    responsesById,
    unresolved:
      hasLegacyOrMalformedRelationship || hasOrphanOrMalformedResponse,
  };
}

async function listHomeownerProfessionalResponses({
  pool,
  authenticatedActor,
  postId: rawPostId,
}) {
  const actorUserId = normalizeActorId(authenticatedActor);
  const postId = parsePositiveInteger(rawPostId);

  if (!actorUserId) {
    return failure(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required."
    );
  }
  if (!postId) {
    return failure(
      400,
      "INVALID_REQUEST_ID",
      "A valid request ID is required."
    );
  }
  requirePool(pool);

  const requestResult = await pool.query(
    `
    /* request_selection:homeowner_request_read */
    SELECT id, title, status
    FROM posts
    WHERE id = $1
      AND user_id = $2
    LIMIT 1
    `,
    [postId, actorUserId]
  );

  if (!requestResult.rows[0]) {
    return failure(
      404,
      "REQUEST_NOT_FOUND",
      "The request was not found."
    );
  }

  const stateResult = await pool.query(
    `
    /* request_selection:homeowner_response_read */
    SELECT
      professional_responses.id AS response_id,
      professional_responses.status AS response_status,
      professional_responses.current_version AS response_current_version,
      professional_responses.introduction_text,
      professional_responses.submitted_at,
      professional_responses.selected_at,
      request_relationships.status AS relationship_status,
      request_relationships.ordinary_authority_source,
      request_relationships.current_version
        AS relationship_current_version,
      contractor_profiles.business_name,
      contractor_profiles.category AS professional_category,
      contractor_profiles.image_url AS business_image_url,
      request_selections.id AS selection_id,
      request_selections.ended_at AS selection_ended_at,
      conversations.id AS conversation_id,
      conversations.status AS conversation_status,
      EXISTS (
        SELECT 1
        FROM request_relationships AS unresolved_relationship
        LEFT JOIN professional_responses AS unresolved_response
          ON unresolved_response.id =
            unresolved_relationship.professional_response_id
          AND unresolved_response.request_relationship_id =
            unresolved_relationship.id
        WHERE unresolved_relationship.post_id = $1
          AND unresolved_relationship.emergency_request_id IS NULL
          AND (
            unresolved_response.id IS NULL
            OR unresolved_relationship.ordinary_authority_source IS DISTINCT FROM
              'professional_response'
          )
      ) AS unresolved_legacy_state,
      EXISTS (
        SELECT 1
        FROM request_selections AS active_selection
        WHERE active_selection.post_id = $1
          AND active_selection.ended_at IS NULL
      ) AS active_selection_exists
    FROM professional_responses
    INNER JOIN request_relationships
      ON request_relationships.id =
        professional_responses.request_relationship_id
      AND request_relationships.professional_response_id =
        professional_responses.id
      AND request_relationships.post_id =
        professional_responses.post_id
      AND request_relationships.homeowner_id =
        professional_responses.homeowner_id
      AND request_relationships.contractor_id =
        professional_responses.contractor_id
      AND request_relationships.professional_user_id =
        professional_responses.professional_user_id
      AND request_relationships.emergency_request_id IS NULL
      AND request_relationships.ordinary_authority_source =
        'professional_response'
      AND request_relationships.current_version =
        professional_responses.current_version
    INNER JOIN contractor_profiles
      ON contractor_profiles.id = professional_responses.contractor_id
      AND contractor_profiles.user_id =
        professional_responses.professional_user_id
    LEFT JOIN request_selections
      ON request_selections.professional_response_id =
        professional_responses.id
      AND request_selections.request_relationship_id =
        request_relationships.id
      AND request_selections.post_id = professional_responses.post_id
    LEFT JOIN conversations
      ON conversations.id = request_selections.conversation_id
      AND conversations.request_selection_id = request_selections.id
      AND conversations.relationship_id = request_relationships.id
    WHERE professional_responses.post_id = $1
      AND professional_responses.homeowner_id = $2
    ORDER BY professional_responses.submitted_at ASC,
      professional_responses.id ASC
    `,
    [postId, actorUserId]
  );

  const request = requestResult.rows[0];
  return {
    ok: true,
    status: 200,
    code: "PROFESSIONAL_RESPONSES_FOUND",
    request: {
      id: request.id,
      title: request.title,
      status: request.status,
    },
    responses: stateResult.rows.map((row) => {
      const canonicalSelected = Boolean(
        row.response_status === "selected" &&
          row.relationship_status === "active" &&
          row.selection_id &&
          row.selection_ended_at == null &&
          row.conversation_id &&
          row.conversation_status === "active"
      );
      const selectionAvailable = Boolean(
        request.status === "open" &&
          row.response_status === "submitted" &&
          row.relationship_status === "pending" &&
          row.ordinary_authority_source === "professional_response" &&
          Number(row.response_current_version) ===
            Number(row.relationship_current_version) &&
          row.unresolved_legacy_state !== true &&
          row.active_selection_exists !== true
      );

      return {
        id: row.response_id,
        request_id: request.id,
        status: row.response_status,
        current_version: row.response_current_version,
        introduction_text: row.introduction_text,
        submitted_at: row.submitted_at,
        selected_at: row.selected_at,
        relationship_status: row.relationship_status,
        selection_eligible: selectionAvailable,
        selected: canonicalSelected,
        conversation_available: canonicalSelected,
        conversation_id: canonicalSelected
          ? row.conversation_id
          : null,
        business_profile: {
          business_name: row.business_name || "",
          category: row.professional_category || "",
          image_url: row.business_image_url || "",
        },
      };
    }),
  };
}

async function invokeFailure(failureInjector, stage) {
  if (typeof failureInjector === "function") {
    await failureInjector(stage);
  }
}

async function insertResponseTransition({
  client,
  response,
  relationship,
  actorUserId,
  nextResponseStatus,
  nextRelationshipStatus,
  transitionReason,
  eventType,
  closureReason = null,
}) {
  const nextVersion = Number(response.current_version) + 1;
  const terminal = nextResponseStatus !== "selected";

  await client.query(
    `
    /* request_selection:response_version */
    INSERT INTO professional_response_versions
    (
      professional_response_id,
      version,
      previous_version,
      status,
      introduction_text,
      content_fingerprint,
      transition_reason,
      actor_type,
      actor_user_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'homeowner', $8)
    `,
    [
      response.id,
      nextVersion,
      response.current_version,
      nextResponseStatus,
      response.introduction_text,
      response.content_fingerprint,
      transitionReason,
      actorUserId,
    ]
  );

  const responseUpdate = await client.query(
    `
    /* request_selection:response_transition */
    UPDATE professional_responses
    SET
      status = $2,
      current_version = $3,
      selected_at = CASE
        WHEN $2 = 'selected' THEN CURRENT_TIMESTAMP
        ELSE selected_at
      END,
      terminal_at = CASE
        WHEN $4::boolean THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      last_transition_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND status = 'submitted'
      AND current_version = $5
    RETURNING *
    `,
    [
      response.id,
      nextResponseStatus,
      nextVersion,
      terminal,
      response.current_version,
    ]
  );

  if (!responseUpdate.rows[0]) {
    throw new Error("Professional Response transition failed.");
  }

  const relationshipUpdate = await client.query(
    `
    /* request_selection:relationship_transition */
    UPDATE request_relationships
    SET
      status = $2,
      current_version = $3,
      accepted_at = CASE
        WHEN $2 = 'active' THEN CURRENT_TIMESTAMP
        ELSE accepted_at
      END,
      closed_at = CASE
        WHEN $2 = 'closed' THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      closure_reason = $4,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND status = 'pending'
      AND current_version = $5
      AND professional_response_id = $6
      AND ordinary_authority_source = 'professional_response'
    RETURNING *
    `,
    [
      relationship.id,
      nextRelationshipStatus,
      nextVersion,
      closureReason,
      relationship.current_version,
      response.id,
    ]
  );

  if (!relationshipUpdate.rows[0]) {
    throw new Error("Request Relationship transition failed.");
  }

  await client.query(
    `
    /* request_selection:response_evidence */
    INSERT INTO professional_response_evidence
    (
      professional_response_id,
      request_relationship_id,
      post_id,
      contractor_id,
      actor_type,
      actor_user_id,
      event_type,
      previous_status,
      new_status,
      previous_version,
      resulting_version,
      idempotency_id,
      safe_payload,
      implementation_milestone_id
    )
    VALUES ($1, $2, $3, $4, 'homeowner', $5, $6,
      'submitted', $7, $8, $9, $10, $11::jsonb, $12)
    `,
    [
      response.id,
      relationship.id,
      response.post_id,
      response.contractor_id,
      actorUserId,
      eventType,
      nextResponseStatus,
      response.current_version,
      nextVersion,
      null,
      JSON.stringify({ command: COMMAND_NAME }),
      IMPLEMENTATION_MILESTONE_ID,
    ]
  );

  return {
    response: responseUpdate.rows[0],
    relationship: relationshipUpdate.rows[0],
    nextVersion,
  };
}

async function selectProfessionalResponse({
  pool,
  authenticatedActor,
  postId: rawPostId,
  responseId: rawResponseId,
  payload = {},
  idempotencyKey: rawIdempotencyKey,
  failureInjector,
}) {
  const actorUserId = normalizeActorId(authenticatedActor);
  const postId = parsePositiveInteger(rawPostId);
  const responseId = parsePositiveInteger(rawResponseId);
  const payloadValidation = validateSelectionPayload(payload);
  const idempotencyValidation =
    validateSelectionIdempotencyKey(rawIdempotencyKey);

  if (!actorUserId) {
    return failure(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required."
    );
  }
  if (!postId) {
    return failure(
      400,
      "INVALID_REQUEST_ID",
      "A valid request ID is required."
    );
  }
  if (!responseId) {
    return failure(
      400,
      "INVALID_PROFESSIONAL_RESPONSE_ID",
      "A valid Professional Response ID is required."
    );
  }
  if (!payloadValidation.valid) {
    return failure(
      400,
      payloadValidation.code,
      payloadValidation.message
    );
  }
  if (!idempotencyValidation.valid) {
    return failure(
      400,
      idempotencyValidation.code,
      idempotencyValidation.message
    );
  }
  requirePool(pool);

  const client =
    typeof pool.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const requestResult = await client.query(
      `
      /* request_selection:request_lock */
      SELECT id, user_id, title, status, location, unit_number
      FROM posts
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [postId, actorUserId]
    );
    const request = requestResult.rows[0];

    if (!request) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        404,
        "REQUEST_NOT_FOUND",
        "The request was not found."
      );
    }

    const participation = await loadLockedParticipation({
      client,
      postId,
    });

    if (participation.unresolved) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_SELECTION_RECONCILIATION_REQUIRED",
        "Existing participation requires governed review before selection."
      );
    }

    const response = participation.responsesById.get(String(responseId));
    const relationship = response
      ? participation.relationshipsById.get(
          String(response.request_relationship_id)
        )
      : null;

    if (!response || !relationship) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        404,
        "PROFESSIONAL_RESPONSE_NOT_FOUND",
        "The Professional Response was not found."
      );
    }

    const requestFingerprint = createSelectionFingerprint({
      postId,
      responseId,
    });
    const commandScope = `post:${postId}`;
    const existingIdempotencyResult = await client.query(
      `
      /* request_selection:idempotency_existing */
      SELECT *
      FROM request_selection_command_idempotency
      WHERE actor_user_id = $1
        AND command_name = $2
        AND command_scope = $3
        AND idempotency_key = $4
      LIMIT 1
      FOR UPDATE
      `,
      [
        actorUserId,
        COMMAND_NAME,
        commandScope,
        idempotencyValidation.value,
      ]
    );
    const existingIdempotency =
      existingIdempotencyResult.rows[0] || null;

    if (
      existingIdempotency &&
      existingIdempotency.request_fingerprint !== requestFingerprint
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_SELECTION_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different selection."
      );
    }

    const existingSelection = await selectSelectionResult({
      client,
      postId,
      selectionId:
        existingIdempotency?.request_selection_id || null,
      lock: true,
    });

    if (existingIdempotency) {
      if (
        !existingIdempotency.completed_at ||
        !existingSelection ||
        !sameId(existingSelection.response_id, responseId)
      ) {
        throw new Error(
          "Canonical Request Selection idempotency is incomplete."
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return {
        ok: true,
        status: 200,
        code: "REQUEST_SELECTION_REPLAYED",
        ...serializeSelectionResult(existingSelection, {
          classification: "replayed",
          replayed: true,
        }),
      };
    }

    const activeSelection = existingSelection ||
      await selectSelectionResult({
        client,
        postId,
        lock: true,
      });

    if (activeSelection) {
      if (sameId(activeSelection.response_id, responseId)) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return {
          ok: true,
          status: 200,
          code: "REQUEST_SELECTION_EXISTS",
          ...serializeSelectionResult(activeSelection, {
            classification: "existing",
          }),
        };
      }

      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_SELECTION_ALREADY_EXISTS",
        "A professional has already been selected for this request."
      );
    }

    if (request.status !== "open") {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_NOT_SELECTABLE",
        "The request is not available for selection."
      );
    }

    if (
      response.status !== "submitted" ||
      relationship.status !== "pending"
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "PROFESSIONAL_RESPONSE_NOT_SELECTABLE",
        "The Professional Response is no longer available for selection."
      );
    }

    const idempotencyId = randomUUID();
    const reservedIdempotency = await client.query(
      `
      /* request_selection:idempotency_reserve */
      INSERT INTO request_selection_command_idempotency
      (
        id,
        actor_user_id,
        post_id,
        requested_professional_response_id,
        command_name,
        command_scope,
        idempotency_key,
        request_fingerprint
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        idempotencyId,
        actorUserId,
        postId,
        responseId,
        COMMAND_NAME,
        commandScope,
        idempotencyValidation.value,
        requestFingerprint,
      ]
    );

    if (!reservedIdempotency.rows[0]) {
      throw new Error(
        "Canonical Request Selection idempotency could not be reserved."
      );
    }

    const identitiesResult = await client.query(
      `
      /* request_selection:reserve_identities */
      SELECT
        nextval(
          pg_get_serial_sequence('request_selections', 'id')
        ) AS request_selection_id,
        nextval(
          pg_get_serial_sequence('conversations', 'id')
        ) AS conversation_id
      `
    );
    const identities = identitiesResult.rows[0];

    if (!identities?.request_selection_id || !identities?.conversation_id) {
      throw new Error("Selection identities could not be reserved.");
    }

    const selectedVersion = Number(response.current_version) + 1;
    const selectionInsert = await client.query(
      `
      /* request_selection:insert_selection */
      INSERT INTO request_selections
      (
        id,
        post_id,
        professional_response_id,
        request_relationship_id,
        selected_by_user_id,
        contractor_id,
        professional_user_id,
        selected_response_version,
        conversation_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        identities.request_selection_id,
        postId,
        response.id,
        relationship.id,
        actorUserId,
        response.contractor_id,
        response.professional_user_id,
        selectedVersion,
        identities.conversation_id,
      ]
    );

    if (!selectionInsert.rows[0]) {
      throw new Error("Canonical Request Selection could not be created.");
    }
    await invokeFailure(failureInjector, "selection_insert");

    const selectedTransition = await insertResponseTransition({
      client,
      response,
      relationship,
      actorUserId,
      nextResponseStatus: "selected",
      nextRelationshipStatus: "active",
      transitionReason: "selected",
      eventType: "professional_response_selected",
    });
    await invokeFailure(failureInjector, "response_transition");
    await invokeFailure(failureInjector, "relationship_activation");

    const competingResponses = participation.responseRows.filter(
      (candidate) =>
        !sameId(candidate.id, response.id) &&
        candidate.status === "submitted" &&
        participation.relationshipsById.get(
          String(candidate.request_relationship_id)
        )?.status === "pending"
    );

    for (const competingResponse of competingResponses) {
      const competingRelationship =
        participation.relationshipsById.get(
          String(competingResponse.request_relationship_id)
        );
      await insertResponseTransition({
        client,
        response: competingResponse,
        relationship: competingRelationship,
        actorUserId,
        nextResponseStatus: "not_selected",
        nextRelationshipStatus: "closed",
        transitionReason: "not_selected",
        eventType: "professional_response_not_selected",
        closureReason: "other_professional_selected",
      });
    }
    await invokeFailure(
      failureInjector,
      "competing_response_disposition"
    );

    const conversationInsert = await client.query(
      `
      /* request_selection:insert_conversation */
      INSERT INTO conversations
      (
        id,
        relationship_id,
        homeowner_id,
        contractor_id,
        professional_user_id,
        status,
        request_selection_id
      )
      VALUES ($1, $2, $3, $4, $5, 'active', $6)
      RETURNING *
      `,
      [
        identities.conversation_id,
        relationship.id,
        actorUserId,
        response.contractor_id,
        response.professional_user_id,
        identities.request_selection_id,
      ]
    );

    if (!conversationInsert.rows[0]) {
      throw new Error("Canonical conversation could not be created.");
    }
    await invokeFailure(failureInjector, "conversation_creation");

    await ensureConversationParticipantStatesWithClient({
      client,
      conversationId: identities.conversation_id,
    });
    await invokeFailure(failureInjector, "participant_creation");

    const correlationId = randomUUID();
    await client.query(
      `
      /* request_selection:insert_evidence */
      INSERT INTO request_selection_evidence
      (
        request_selection_id,
        post_id,
        professional_response_id,
        selected_response_version,
        request_relationship_id,
        actor_user_id,
        contractor_id,
        professional_user_id,
        conversation_id,
        previous_response_status,
        new_response_status,
        previous_relationship_status,
        new_relationship_status,
        idempotency_id,
        correlation_id,
        safe_payload,
        implementation_milestone_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        'submitted', 'selected', 'pending', 'active', $10,
        $11, $12::jsonb, $13)
      `,
      [
        identities.request_selection_id,
        postId,
        response.id,
        selectedTransition.nextVersion,
        relationship.id,
        actorUserId,
        response.contractor_id,
        response.professional_user_id,
        identities.conversation_id,
        idempotencyId,
        correlationId,
        JSON.stringify({
          command: COMMAND_NAME,
          selectedResponsePreviousStatus: "submitted",
          selectedResponseNewStatus: "selected",
          relationshipPreviousStatus: "pending",
          relationshipNewStatus: "active",
          competingResponseCount: competingResponses.length,
        }),
        IMPLEMENTATION_MILESTONE_ID,
      ]
    );
    await invokeFailure(failureInjector, "evidence_creation");

    const resultReference = {
      requestSelectionId: String(identities.request_selection_id),
      professionalResponseId: String(response.id),
      requestRelationshipId: Number(relationship.id),
      conversationId: Number(identities.conversation_id),
      requestId: Number(postId),
    };
    const completedIdempotency = await client.query(
      `
      /* request_selection:idempotency_complete */
      UPDATE request_selection_command_idempotency
      SET
        request_selection_id = $2,
        request_relationship_id = $3,
        conversation_id = $4,
        result_classification = 'created',
        result_reference = $5::jsonb,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND completed_at IS NULL
      RETURNING *
      `,
      [
        idempotencyId,
        identities.request_selection_id,
        relationship.id,
        identities.conversation_id,
        JSON.stringify(resultReference),
      ]
    );

    if (!completedIdempotency.rows[0]) {
      throw new Error("Selection idempotency completion failed.");
    }
    await invokeFailure(failureInjector, "idempotency_completion");

    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await invokeFailure(failureInjector, "deferred_validation");
    await invokeFailure(failureInjector, "before_commit");
    await client.query("COMMIT");
    transactionStarted = false;

    const resultRow = {
      selection_id: identities.request_selection_id,
      selection_post_id: postId,
      selection_response_id: response.id,
      selection_relationship_id: relationship.id,
      selection_homeowner_id: actorUserId,
      selection_contractor_id: response.contractor_id,
      selection_professional_user_id: response.professional_user_id,
      selected_response_version: selectedTransition.nextVersion,
      selection_conversation_id: identities.conversation_id,
      selected_at: selectionInsert.rows[0].selected_at,
      selection_ended_at: null,
      response_id: response.id,
      post_id: postId,
      homeowner_id: actorUserId,
      contractor_id: response.contractor_id,
      professional_user_id: response.professional_user_id,
      response_status: "selected",
      response_current_version: selectedTransition.nextVersion,
      introduction_text: response.introduction_text,
      submitted_at: response.submitted_at,
      response_selected_at:
        selectedTransition.response.selected_at,
      relationship_id: relationship.id,
      relationship_status: "active",
      ordinary_authority_source: "professional_response",
      relationship_current_version: selectedTransition.nextVersion,
      accepted_at: selectedTransition.relationship.accepted_at,
      conversation_id: identities.conversation_id,
      conversation_selection_id: identities.request_selection_id,
      conversation_relationship_id: relationship.id,
      conversation_homeowner_id: actorUserId,
      conversation_contractor_id: response.contractor_id,
      conversation_professional_user_id:
        response.professional_user_id,
      conversation_status: "active",
      business_name: response.business_name,
      professional_category: response.professional_category,
      business_image_url: response.business_image_url,
    };

    return {
      ok: true,
      status: 201,
      code: "REQUEST_SELECTION_CREATED",
      ...serializeSelectionResult(resultRow),
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original operation error.
      }
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

module.exports = {
  COMMAND_NAME,
  IMPLEMENTATION_MILESTONE_ID,
  createSelectionFingerprint,
  listHomeownerProfessionalResponses,
  selectProfessionalResponse,
  validateSelectionIdempotencyKey,
  validateSelectionPayload,
};
