"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  parsePositiveInteger,
  serializeCanonicalProfessionalResponse,
  validateProfessionalResponseIdempotencyKey,
  validateProfessionalResponsePayload,
} = require("./requestRelationships");

const COMMAND_NAME = "professional_response.submit";
const IMPLEMENTATION_MILESTONE_ID =
  "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-2C";

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function requirePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

function normalizedActorId(authenticatedActor) {
  return parsePositiveInteger(authenticatedActor?.id);
}

function createCommandFingerprint({
  postId,
  contractorId,
  introductionText,
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        commandName: COMMAND_NAME,
        postId,
        contractorId,
        introductionText,
      })
    )
    .digest("hex");
}

function resultReference(row, classification) {
  return {
    professionalResponseId: String(row.response_id),
    requestRelationshipId: Number(row.relationship_id),
    requestId: Number(row.post_id),
    resultClassification: classification,
  };
}

function canonicalPairIsValid(row, {
  postId,
  contractorId,
  professionalUserId,
} = {}) {
  if (!row) return false;

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
    String(row.response_id || "") &&
      Number(row.post_id) === Number(postId) &&
      Number(row.response_contractor_id) === Number(contractorId) &&
      Number(row.response_professional_user_id) ===
        Number(professionalUserId) &&
      Number(row.relationship_id) > 0 &&
      String(row.relationship_response_id) === String(row.response_id) &&
      Number(row.relationship_post_id) === Number(row.post_id) &&
      row.relationship_emergency_request_id == null &&
      Number(row.relationship_homeowner_id) === Number(row.homeowner_id) &&
      Number(row.relationship_contractor_id) ===
        Number(row.response_contractor_id) &&
      Number(row.relationship_professional_user_id) ===
        Number(row.response_professional_user_id) &&
      row.ordinary_authority_source === "professional_response" &&
      Number(row.relationship_current_version) ===
        Number(row.response_current_version) &&
      statusPairs[row.response_status] === row.relationship_status
  );
}

async function selectCanonicalPairByBusiness({
  client,
  postId,
  contractorId,
  professionalUserId,
}) {
  const result = await client.query(
    `
    /* professional_response:canonical_pair_by_business */
    SELECT
      professional_responses.id AS response_id,
      professional_responses.post_id,
      professional_responses.homeowner_id,
      professional_responses.contractor_id AS response_contractor_id,
      professional_responses.professional_user_id
        AS response_professional_user_id,
      professional_responses.status AS response_status,
      professional_responses.current_version
        AS response_current_version,
      professional_responses.introduction_text
        AS response_introduction_text,
      professional_responses.submitted_at AS response_submitted_at,
      professional_responses.updated_at AS response_updated_at,
      request_relationships.id AS relationship_id,
      request_relationships.professional_response_id
        AS relationship_response_id,
      request_relationships.post_id AS relationship_post_id,
      request_relationships.emergency_request_id
        AS relationship_emergency_request_id,
      request_relationships.homeowner_id AS relationship_homeowner_id,
      request_relationships.contractor_id AS relationship_contractor_id,
      request_relationships.professional_user_id
        AS relationship_professional_user_id,
      request_relationships.status AS relationship_status,
      request_relationships.ordinary_authority_source,
      request_relationships.current_version
        AS relationship_current_version,
      request_relationships.created_at AS relationship_created_at,
      contractor_profiles.business_name,
      contractor_profiles.category AS professional_category,
      contractor_profiles.image_url AS business_image_url
    FROM professional_responses
    LEFT JOIN request_relationships
      ON request_relationships.id =
        professional_responses.request_relationship_id
    LEFT JOIN contractor_profiles
      ON contractor_profiles.id = professional_responses.contractor_id
      AND contractor_profiles.user_id =
        professional_responses.professional_user_id
    WHERE professional_responses.post_id = $1
      AND professional_responses.contractor_id = $2
      AND professional_responses.professional_user_id = $3
    ORDER BY professional_responses.id ASC
    LIMIT 2
    FOR UPDATE OF professional_responses
    `,
    [postId, contractorId, professionalUserId]
  );

  return result.rows;
}

async function selectCanonicalPairByResult({
  client,
  responseId,
  relationshipId,
  postId,
  contractorId,
  professionalUserId,
}) {
  const result = await client.query(
    `
    /* professional_response:canonical_pair_by_result */
    SELECT
      professional_responses.id AS response_id,
      professional_responses.post_id,
      professional_responses.homeowner_id,
      professional_responses.contractor_id AS response_contractor_id,
      professional_responses.professional_user_id
        AS response_professional_user_id,
      professional_responses.status AS response_status,
      professional_responses.current_version
        AS response_current_version,
      professional_responses.introduction_text
        AS response_introduction_text,
      professional_responses.submitted_at AS response_submitted_at,
      professional_responses.updated_at AS response_updated_at,
      request_relationships.id AS relationship_id,
      request_relationships.professional_response_id
        AS relationship_response_id,
      request_relationships.post_id AS relationship_post_id,
      request_relationships.emergency_request_id
        AS relationship_emergency_request_id,
      request_relationships.homeowner_id AS relationship_homeowner_id,
      request_relationships.contractor_id AS relationship_contractor_id,
      request_relationships.professional_user_id
        AS relationship_professional_user_id,
      request_relationships.status AS relationship_status,
      request_relationships.ordinary_authority_source,
      request_relationships.current_version
        AS relationship_current_version,
      request_relationships.created_at AS relationship_created_at,
      contractor_profiles.business_name,
      contractor_profiles.category AS professional_category,
      contractor_profiles.image_url AS business_image_url
    FROM professional_responses
    INNER JOIN request_relationships
      ON request_relationships.id = $2
      AND request_relationships.id =
        professional_responses.request_relationship_id
    INNER JOIN contractor_profiles
      ON contractor_profiles.id = professional_responses.contractor_id
      AND contractor_profiles.user_id =
        professional_responses.professional_user_id
    WHERE professional_responses.id = $1
      AND professional_responses.post_id = $3
      AND professional_responses.contractor_id = $4
      AND professional_responses.professional_user_id = $5
    LIMIT 1
    FOR UPDATE OF professional_responses, request_relationships
    `,
    [
      responseId,
      relationshipId,
      postId,
      contractorId,
      professionalUserId,
    ]
  );

  return result.rows[0] || null;
}

async function reserveIdempotency({
  client,
  actorUserId,
  contractorId,
  postId,
  idempotencyKey,
  requestFingerprint,
}) {
  const commandScope = `post:${postId}:business:${contractorId}`;
  const id = randomUUID();
  const inserted = await client.query(
    `
    /* professional_response:idempotency_reserve */
    INSERT INTO professional_response_command_idempotency
    (
      id,
      actor_user_id,
      contractor_id,
      post_id,
      command_name,
      command_scope,
      idempotency_key,
      request_fingerprint
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key
    )
    DO NOTHING
    RETURNING *
    `,
    [
      id,
      actorUserId,
      contractorId,
      postId,
      COMMAND_NAME,
      commandScope,
      idempotencyKey,
      requestFingerprint,
    ]
  );

  if (inserted.rows[0]) {
    return { reservation: inserted.rows[0], replay: false };
  }

  const existing = await client.query(
    `
    /* professional_response:idempotency_existing */
    SELECT *
    FROM professional_response_command_idempotency
    WHERE actor_user_id = $1
      AND command_name = $2
      AND command_scope = $3
      AND idempotency_key = $4
    LIMIT 1
    FOR UPDATE
    `,
    [actorUserId, COMMAND_NAME, commandScope, idempotencyKey]
  );
  const reservation = existing.rows[0];

  if (!reservation) {
    return {
      error: failure(
        500,
        "PROFESSIONAL_RESPONSE_INVARIANT_VIOLATION",
        "The professional response could not be completed."
      ),
    };
  }

  if (reservation.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "PROFESSIONAL_RESPONSE_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different response."
      ),
    };
  }

  if (
    !reservation.professional_response_id ||
    !reservation.request_relationship_id ||
    !reservation.result_classification ||
    !reservation.result_reference ||
    !reservation.completed_at
  ) {
    return {
      error: failure(
        500,
        "PROFESSIONAL_RESPONSE_INVARIANT_VIOLATION",
        "The professional response could not be completed."
      ),
    };
  }

  return { reservation, replay: true };
}

async function completeIdempotency({
  client,
  reservationId,
  row,
  classification,
}) {
  const completed = await client.query(
    `
    /* professional_response:idempotency_complete */
    UPDATE professional_response_command_idempotency
    SET
      professional_response_id = $2,
      request_relationship_id = $3,
      result_classification = $4,
      result_reference = $5::jsonb,
      completed_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND completed_at IS NULL
    RETURNING *
    `,
    [
      reservationId,
      row.response_id,
      row.relationship_id,
      classification,
      JSON.stringify(resultReference(row, classification)),
    ]
  );

  if (!completed.rows[0]) {
    throw new Error(
      "Canonical Professional Response idempotency completion failed."
    );
  }

  return completed.rows[0];
}

async function submitProfessionalResponse({
  pool,
  authenticatedActor,
  postId: rawPostId,
  payload = {},
  idempotencyKey: rawIdempotencyKey,
  professionalCanSeeRequest,
}) {
  const actorUserId = normalizedActorId(authenticatedActor);
  const postId = parsePositiveInteger(rawPostId);
  const responseValidation = validateProfessionalResponsePayload(payload);
  const idempotencyValidation =
    validateProfessionalResponseIdempotencyKey(rawIdempotencyKey);

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
  if (!responseValidation.valid) {
    return failure(
      400,
      responseValidation.code,
      responseValidation.message
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
  if (typeof professionalCanSeeRequest !== "function") {
    throw new TypeError("professionalCanSeeRequest is required.");
  }

  const client =
    typeof pool.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const profileResult = await client.query(
      `
      /* professional_response:owned_profiles */
      SELECT
        id,
        user_id,
        business_name,
        category,
        image_url,
        profile_details
      FROM contractor_profiles
      WHERE user_id = $1
      ORDER BY id ASC
      LIMIT 2
      `,
      [actorUserId]
    );

    if (profileResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        403,
        "PROFESSIONAL_PROFILE_REQUIRED",
        "A business profile is required to respond to requests."
      );
    }
    if (profileResult.rows.length > 1) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "PROFESSIONAL_PROFILE_AMBIGUOUS",
        "A single business profile is required to respond to this request."
      );
    }
    const profile = profileResult.rows[0];

    const requestResult = await client.query(
      `
      /* professional_response:request_lock */
      SELECT
        id,
        user_id,
        title,
        description,
        category,
        request_category,
        service_domain,
        service_specialty,
        location,
        location_intake_mode,
        location_normalization_status,
        service_address_line1,
        service_city,
        service_region,
        service_postal_code,
        service_country_code,
        discovery_area_label,
        unit_number,
        access_notes,
        status,
        created_at,
        updated_at,
        image_url,
        request_photos
      FROM posts
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [postId]
    );
    const request = requestResult.rows[0];

    if (!request) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        404,
        "REQUEST_NOT_AVAILABLE",
        "The request is not available for response."
      );
    }
    if (Number(request.user_id) === actorUserId) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        403,
        "SELF_RESPONSE_NOT_ALLOWED",
        "You cannot respond to your own request."
      );
    }

    const requestFingerprint = createCommandFingerprint({
      postId,
      contractorId: profile.id,
      introductionText: responseValidation.value.introductionText,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId,
      contractorId: profile.id,
      postId,
      idempotencyKey: idempotencyValidation.value,
      requestFingerprint,
    });

    if (idempotency.error) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return idempotency.error;
    }

    if (idempotency.replay) {
      const row = await selectCanonicalPairByResult({
        client,
        responseId: idempotency.reservation.professional_response_id,
        relationshipId: idempotency.reservation.request_relationship_id,
        postId,
        contractorId: profile.id,
        professionalUserId: actorUserId,
      });

      if (
        !canonicalPairIsValid(row, {
          postId,
          contractorId: profile.id,
          professionalUserId: actorUserId,
        })
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return failure(
          500,
          "PROFESSIONAL_RESPONSE_INVARIANT_VIOLATION",
          "The professional response could not be completed."
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return {
        ok: true,
        status: 200,
        code: "PROFESSIONAL_RESPONSE_REPLAYED",
        replayed: true,
        ...serializeCanonicalProfessionalResponse(
          row,
          idempotency.reservation.result_classification
        ),
      };
    }

    const existingRows = await selectCanonicalPairByBusiness({
      client,
      postId,
      contractorId: profile.id,
      professionalUserId: actorUserId,
    });

    if (existingRows.length > 1) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        500,
        "PROFESSIONAL_RESPONSE_INVARIANT_VIOLATION",
        "The professional response could not be completed."
      );
    }

    if (existingRows[0]) {
      const row = existingRows[0];
      if (
        !canonicalPairIsValid(row, {
          postId,
          contractorId: profile.id,
          professionalUserId: actorUserId,
        })
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return failure(
          409,
          "PROFESSIONAL_RESPONSE_RECONCILIATION_REQUIRED",
          "Existing participation requires governed review."
        );
      }

      await completeIdempotency({
        client,
        reservationId: idempotency.reservation.id,
        row,
        classification: "existing",
      });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
      transactionStarted = false;

      return {
        ok: true,
        status: 200,
        code: "PROFESSIONAL_RESPONSE_EXISTS",
        ...serializeCanonicalProfessionalResponse(row, "existing"),
      };
    }

    if (request.status !== "open") {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_NOT_AVAILABLE",
        "The request is not available for response."
      );
    }
    if (!professionalCanSeeRequest(profile, request)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        403,
        "REQUEST_NOT_ELIGIBLE",
        "This business is not eligible to respond to the request."
      );
    }

    const relationshipResult = await client.query(
      `
      /* professional_response:legacy_relationships */
      SELECT
        request_relationships.id,
        request_relationships.contractor_id,
        request_relationships.professional_user_id,
        request_relationships.status,
        request_relationships.professional_response_id,
        request_relationships.ordinary_authority_source,
        professional_responses.status AS linked_response_status,
        EXISTS (
          SELECT 1
          FROM conversations
          WHERE conversations.relationship_id = request_relationships.id
        ) AS conversation_exists
      FROM request_relationships
      LEFT JOIN professional_responses
        ON professional_responses.id =
          request_relationships.professional_response_id
      WHERE request_relationships.post_id = $1
        AND request_relationships.emergency_request_id IS NULL
      ORDER BY request_relationships.id ASC
      FOR UPDATE OF request_relationships
      `,
      [postId]
    );

    const exactBusinessRows = relationshipResult.rows.filter(
      (row) =>
        Number(row.contractor_id) === Number(profile.id) &&
        Number(row.professional_user_id) === actorUserId
    );
    if (exactBusinessRows.length > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "PROFESSIONAL_RESPONSE_RECONCILIATION_REQUIRED",
        "Existing participation requires governed review."
      );
    }

    const unresolvedSelection = relationshipResult.rows.some(
      (row) =>
        row.status === "active" ||
        row.linked_response_status === "selected" ||
        row.conversation_exists === true
    );
    if (unresolvedSelection) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_SELECTION_STATE_UNRESOLVED",
        "The request is not available for another response."
      );
    }

    const identitiesResult = await client.query(
      `
      /* professional_response:reserve_identities */
      SELECT
        nextval(
          pg_get_serial_sequence('professional_responses', 'id')
        ) AS professional_response_id,
        nextval(
          pg_get_serial_sequence('request_relationships', 'id')
        ) AS request_relationship_id
      `
    );
    const identities = identitiesResult.rows[0];
    if (
      !identities?.professional_response_id ||
      !identities?.request_relationship_id
    ) {
      throw new Error(
        "Canonical Professional Response identities could not be reserved."
      );
    }

    const responseInsert = await client.query(
      `
      /* professional_response:insert_response */
      INSERT INTO professional_responses
      (
        id,
        post_id,
        request_relationship_id,
        homeowner_id,
        contractor_id,
        professional_user_id,
        status,
        introduction_text,
        origin,
        current_version
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'submitted', $7,
        'canonical_command', 1)
      RETURNING *
      `,
      [
        identities.professional_response_id,
        postId,
        identities.request_relationship_id,
        request.user_id,
        profile.id,
        actorUserId,
        responseValidation.value.introductionText,
      ]
    );

    const relationshipInsert = await client.query(
      `
      /* professional_response:insert_relationship */
      INSERT INTO request_relationships
      (
        id,
        post_id,
        homeowner_id,
        contractor_id,
        professional_user_id,
        status,
        introduction_text,
        professional_response_id,
        ordinary_authority_source,
        current_version
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', '', $6,
        'professional_response', 1)
      RETURNING *
      `,
      [
        identities.request_relationship_id,
        postId,
        request.user_id,
        profile.id,
        actorUserId,
        identities.professional_response_id,
      ]
    );

    await client.query(
      `
      /* professional_response:insert_version */
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
      VALUES ($1, 1, NULL, 'submitted', $2, $3, 'submitted',
        'professional', $4)
      `,
      [
        identities.professional_response_id,
        responseValidation.value.introductionText,
        requestFingerprint,
        actorUserId,
      ]
    );

    await client.query(
      `
      /* professional_response:insert_evidence */
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
      VALUES ($1, $2, $3, $4, 'professional', $5,
        'professional_response_submitted', NULL, 'submitted', 0, 1,
        $6, $7::jsonb, $8)
      `,
      [
        identities.professional_response_id,
        identities.request_relationship_id,
        postId,
        profile.id,
        actorUserId,
        idempotency.reservation.id,
        JSON.stringify({ command: COMMAND_NAME }),
        IMPLEMENTATION_MILESTONE_ID,
      ]
    );

    const response = responseInsert.rows[0];
    const relationship = relationshipInsert.rows[0];
    if (!response || !relationship) {
      throw new Error(
        "Canonical Professional Response persistence was incomplete."
      );
    }

    const row = {
      response_id: response.id,
      post_id: response.post_id,
      homeowner_id: response.homeowner_id,
      response_contractor_id: response.contractor_id,
      response_professional_user_id: response.professional_user_id,
      response_status: response.status,
      response_current_version: response.current_version,
      response_introduction_text: response.introduction_text,
      response_submitted_at: response.submitted_at,
      response_updated_at: response.updated_at,
      relationship_id: relationship.id,
      relationship_response_id: relationship.professional_response_id,
      relationship_post_id: relationship.post_id,
      relationship_emergency_request_id: relationship.emergency_request_id,
      relationship_homeowner_id: relationship.homeowner_id,
      relationship_contractor_id: relationship.contractor_id,
      relationship_professional_user_id: relationship.professional_user_id,
      relationship_status: relationship.status,
      ordinary_authority_source: relationship.ordinary_authority_source,
      relationship_current_version: relationship.current_version,
      relationship_created_at: relationship.created_at,
      business_name: profile.business_name,
      professional_category: profile.category,
      business_image_url: profile.image_url,
    };

    if (
      !canonicalPairIsValid(row, {
        postId,
        contractorId: profile.id,
        professionalUserId: actorUserId,
      })
    ) {
      throw new Error(
        "Canonical Professional Response linkage was invalid."
      );
    }

    await completeIdempotency({
      client,
      reservationId: idempotency.reservation.id,
      row,
      classification: "created",
    });
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
    transactionStarted = false;

    return {
      ok: true,
      status: 201,
      code: "PROFESSIONAL_RESPONSE_CREATED",
      ...serializeCanonicalProfessionalResponse(row, "created"),
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
  createCommandFingerprint,
  submitProfessionalResponse,
};
