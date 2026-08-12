"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  CURRENT_LIFECYCLE_CONTRACT_VERSION,
} = require("./lifecycleContract");
const {
  hasActiveLifecycleGrant,
} = require("../authorization/lifecycleAuthorityService");
const {
  REQUEST_MODIFICATION_MODES,
  loadRequestModificationContext,
  resolveRequestModificationMode,
  serializeRequestModificationAuthority,
} = require("./requestModificationService");

const CLARIFICATION_SEMANTICS = Object.freeze([
  "CLARIFIES",
  "CORRECTS_INTERPRETATION",
  "WITHDRAWS",
  "SUPERSEDES_INTERPRETATION",
]);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function createConcernIntegrityHash({
  jobRequestId,
  reporterUserId,
  originalText,
  sequence,
  integrityVersion = 1,
}) {
  return hashValue({
    integrityVersion,
    jobRequestId: Number(jobRequestId),
    originalText: String(originalText),
    reporterUserId: Number(reporterUserId),
    sequence: Number(sequence),
  });
}

function serializeClarification(row = {}) {
  return {
    id: row.clarification_id || row.id,
    semantics: row.semantics,
    text: row.clarification_text,
    actorUserId: Number(row.clarification_actor_user_id || row.actor_user_id),
    actorParticipantId:
      row.clarification_actor_participant_id || row.actor_participant_id || null,
    createdAt: row.clarification_created_at || row.created_at,
  };
}

function serializeConcern(row = {}, clarifications = []) {
  return {
    id: row.concern_id || row.id,
    requestId: Number(row.job_request_id),
    reporterUserId: Number(row.reporter_user_id),
    originalText: row.original_text,
    reportedAt: row.reported_at,
    sequence: Number(row.sequence),
    integrity: {
      algorithm: row.integrity_algorithm,
      hash: row.integrity_hash,
      version: Number(row.integrity_version),
    },
    clarifications,
  };
}

async function createReportedConcern({
  client,
  post,
  actorUserId,
  sourceEvidenceId,
  logger = console,
} = {}) {
  const originalText = String(post?.description || "").trim();
  if (!originalText) {
    throw new Error("Lifecycle-v2 creation requires confirmed Reported Concern text.");
  }

  const concernId = randomUUID();
  const sequence = 1;
  const integrityHash = createConcernIntegrityHash({
    jobRequestId: post.id,
    reporterUserId: actorUserId,
    originalText,
    sequence,
  });
  const result = await client.query(
    `
    /* reported_concern:create */
    INSERT INTO reported_concerns
    (
      id, job_request_id, reporter_user_id, original_text,
      source_evidence_id, sequence, integrity_hash
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [
      concernId,
      post.id,
      actorUserId,
      originalText,
      sourceEvidenceId,
      sequence,
      integrityHash,
    ]
  );

  logger.info("Reported Concern created", {
    code: "REPORTED_CONCERN_CREATED",
    concernId,
    requestId: Number(post.id),
    reporterUserId: Number(actorUserId),
    sequence,
  });

  return serializeConcern(result.rows[0]);
}

async function loadRequestContext(client, postId, actorUserId, { lock = false } = {}) {
  const context = await loadRequestModificationContext(
    client,
    postId,
    actorUserId,
    { lock }
  );
  return context
    ? {
        ...context,
        id: context.id || context.post_id,
        post_id: context.id || context.post_id,
        user_id: context.user_id || context.homeowner_user_id,
        homeowner_user_id: context.user_id || context.homeowner_user_id,
        status: context.status || "open",
      }
    : null;
}

async function canReadContext(client, context, actorUserId, capability, concernId = null) {
  if (Number(context.homeowner_user_id) === Number(actorUserId)) return true;
  if (!context.job_id || !context.actor_participant_id) return false;
  return hasActiveLifecycleGrant({
    client,
    participantId: context.actor_participant_id,
    capability,
    jobId: context.job_id,
    concernId,
  });
}

async function loadConcerns(client, postId) {
  const result = await client.query(
    `
    /* reported_concern:list */
    SELECT
      reported_concerns.id AS concern_id,
      reported_concerns.job_request_id,
      reported_concerns.reporter_user_id,
      reported_concerns.original_text,
      reported_concerns.reported_at,
      reported_concerns.sequence,
      reported_concerns.integrity_algorithm,
      reported_concerns.integrity_hash,
      reported_concerns.integrity_version,
      concern_clarifications.id AS clarification_id,
      concern_clarifications.actor_user_id AS clarification_actor_user_id,
      concern_clarifications.actor_participant_id AS clarification_actor_participant_id,
      concern_clarifications.semantics,
      concern_clarifications.clarification_text,
      concern_clarifications.created_at AS clarification_created_at
    FROM reported_concerns
    LEFT JOIN concern_clarifications
      ON concern_clarifications.concern_id = reported_concerns.id
    WHERE reported_concerns.job_request_id = $1
    ORDER BY
      reported_concerns.sequence ASC,
      reported_concerns.reported_at ASC,
      reported_concerns.id ASC,
      concern_clarifications.created_at ASC,
      concern_clarifications.id ASC
    `,
    [postId]
  );

  const concerns = new Map();
  for (const row of result.rows) {
    if (!concerns.has(row.concern_id)) {
      concerns.set(row.concern_id, serializeConcern(row, []));
    }
    if (row.clarification_id) {
      concerns.get(row.concern_id).clarifications.push(
        serializeClarification(row)
      );
    }
  }
  return [...concerns.values()];
}

async function loadParticipants(client, jobId) {
  if (!jobId) return [];
  const result = await client.query(
    `
    /* reported_concern:list_participants */
    SELECT
      relationship_participants.id AS participant_id,
      relationship_participants.user_id,
      relationship_participants.identity_type,
      relationship_participants.created_at AS participant_created_at,
      users.username,
      participant_role_assignments.id AS role_assignment_id,
      participant_role_assignments.role,
      participant_role_assignments.valid_from,
      participant_role_assignments.valid_until,
      participant_role_revocations.revoked_at
    FROM relationship_participants
    INNER JOIN users
      ON users.id = relationship_participants.user_id
    LEFT JOIN participant_role_assignments
      ON participant_role_assignments.participant_id = relationship_participants.id
    LEFT JOIN participant_role_revocations
      ON participant_role_revocations.role_assignment_id =
        participant_role_assignments.id
    WHERE relationship_participants.job_id = $1
    ORDER BY
      relationship_participants.created_at ASC,
      relationship_participants.id ASC,
      participant_role_assignments.valid_from ASC,
      participant_role_assignments.id ASC
    `,
    [jobId]
  );

  const participants = new Map();
  for (const row of result.rows) {
    if (!participants.has(row.participant_id)) {
      participants.set(row.participant_id, {
        id: row.participant_id,
        userId: Number(row.user_id),
        displayName: row.username || "",
        identityType: row.identity_type,
        createdAt: row.participant_created_at,
        roles: [],
      });
    }
    if (row.role_assignment_id) {
      participants.get(row.participant_id).roles.push({
        assignmentId: row.role_assignment_id,
        role: row.role,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        revokedAt: row.revoked_at,
        active: Boolean(
          !row.revoked_at &&
          (!row.valid_until || new Date(row.valid_until).getTime() > Date.now()) &&
          new Date(row.valid_from).getTime() <= Date.now()
        ),
      });
    }
  }
  return [...participants.values()];
}

async function listRequestLifecycle({
  pool,
  authenticatedActor,
  postId: rawPostId,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const postId = positiveInteger(rawPostId);
  if (!actorUserId) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  if (!postId) {
    return failure(400, "INVALID_REQUEST_ID", "A valid request ID is required.");
  }

  const context = await loadRequestContext(pool, postId, actorUserId);
  if (!context) {
    return failure(404, "REQUEST_NOT_FOUND", "The request was not found.");
  }
  if (!(await canReadContext(
    pool,
    context,
    actorUserId,
    "reported_concern.read"
  ))) {
    return failure(404, "REQUEST_NOT_FOUND", "The request was not found.");
  }
  if (
    context.job_id &&
    Number(context.homeowner_user_id) !== actorUserId &&
    !(await canReadContext(pool, context, actorUserId, "participant.read"))
  ) {
    return failure(403, "PARTICIPANT_READ_AUTHORITY_REQUIRED", "Participant authority is required.");
  }

  const concerns = Number(context.lifecycle_contract_version) ===
    CURRENT_LIFECYCLE_CONTRACT_VERSION
    ? await loadConcerns(pool, postId)
    : [];
  const participants = await loadParticipants(pool, context.job_id);

  return {
    ok: true,
    status: 200,
    code: "REQUEST_LIFECYCLE_FOUND",
    lifecycle: {
      requestId: postId,
      contractVersion: Number(context.lifecycle_contract_version || 1),
      legacy: Number(context.lifecycle_contract_version || 1) !== 2,
      job: context.job_id
        ? {
            id: context.job_id,
            requestRelationshipId: Number(context.source_request_relationship_id),
          }
        : null,
      reportedConcerns: concerns,
      participants,
      modificationAuthority: serializeRequestModificationAuthority(
        context,
        actorUserId
      ),
    },
  };
}

function validateClarificationPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return failure(400, "INVALID_CONCERN_CLARIFICATION", "Clarification details are required.");
  }
  if (Object.keys(payload).some((key) => !["semantics", "text"].includes(key))) {
    return failure(400, "UNSUPPORTED_CONCERN_CLARIFICATION_FIELDS", "One or more clarification fields are not supported.");
  }
  const semantics = String(payload.semantics || "").trim().toUpperCase();
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!CLARIFICATION_SEMANTICS.includes(semantics)) {
    return failure(400, "INVALID_CLARIFICATION_SEMANTICS", "Clarification semantics are invalid.");
  }
  if (!text || text.length > 5000) {
    return failure(400, "INVALID_CLARIFICATION_TEXT", "Clarification text is required.");
  }
  return { ok: true, semantics, text };
}

async function appendConcernClarification({
  pool,
  authenticatedActor,
  postId: rawPostId,
  concernId: rawConcernId,
  payload,
  idempotencyKey: rawIdempotencyKey,
  logger = console,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const postId = positiveInteger(rawPostId);
  const concernId = uuid(rawConcernId);
  const idempotencyKey = String(rawIdempotencyKey || "").trim();
  const validation = validateClarificationPayload(payload);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!postId) return failure(400, "INVALID_REQUEST_ID", "A valid request ID is required.");
  if (!concernId) return failure(400, "INVALID_REPORTED_CONCERN_ID", "A valid Reported Concern ID is required.");
  if (!validation.ok) return validation;
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return failure(400, "INVALID_CONCERN_CLARIFICATION_IDEMPOTENCY_KEY", "A valid idempotency key is required.");
  }

  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const context = await loadRequestContext(client, postId, actorUserId, { lock: true });
    if (!context) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "REQUEST_NOT_FOUND", "The request was not found.");
    }
    if (Number(context.lifecycle_contract_version) !== 2) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "LIFECYCLE_V2_REQUIRED", "Reported Concern clarification is not available for this request.");
    }
    if (
      resolveRequestModificationMode(context) ===
      REQUEST_MODIFICATION_MODES.READ_ONLY
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_READ_ONLY",
        "The request is read-only."
      );
    }

    const concernResult = await client.query(
      `
      /* reported_concern:clarification_concern_lock */
      SELECT *
      FROM reported_concerns
      WHERE id = $1
        AND job_request_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [concernId, postId]
    );
    if (!concernResult.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "REPORTED_CONCERN_NOT_FOUND", "The Reported Concern was not found.");
    }

    if (!(await canReadContext(
      client,
      context,
      actorUserId,
      "reported_concern.clarify",
      concernId
    ))) {
      logger.warn("Reported Concern clarification denied", {
        code: "CONCERN_CLARIFICATION_AUTHORITY_DENIED",
        requestId: postId,
        concernId,
        actorUserId,
      });
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(403, "CONCERN_CLARIFICATION_AUTHORITY_REQUIRED", "Clarification authority is required.");
    }

    const fingerprint = hashValue({
      actorUserId,
      concernId,
      semantics: validation.semantics,
      text: validation.text,
    });
    const existing = await client.query(
      `
      /* reported_concern:clarification_existing */
      SELECT *
      FROM concern_clarifications
      WHERE actor_user_id = $1
        AND concern_id = $2
        AND idempotency_key = $3
      LIMIT 1
      `,
      [actorUserId, concernId, idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== fingerprint) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return failure(409, "CONCERN_CLARIFICATION_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different clarification.");
      }
      await client.query("COMMIT");
      transactionStarted = false;
      logger.info("Reported Concern clarification replayed", {
        code: "CONCERN_CLARIFICATION_REPLAYED",
        clarificationId: existing.rows[0].id,
        concernId,
        requestId: postId,
      });
      return {
        ok: true,
        status: 200,
        code: "CONCERN_CLARIFICATION_REPLAYED",
        replayed: true,
        clarification: serializeClarification(existing.rows[0]),
      };
    }

    const clarificationId = randomUUID();
    const inserted = await client.query(
      `
      /* reported_concern:clarification_insert */
      INSERT INTO concern_clarifications
      (
        id, concern_id, actor_user_id, actor_participant_id, semantics,
        clarification_text, idempotency_key, request_fingerprint,
        source_evidence_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1)
      RETURNING *
      `,
      [
        clarificationId,
        concernId,
        actorUserId,
        context.actor_participant_id || null,
        validation.semantics,
        validation.text,
        idempotencyKey,
        fingerprint,
      ]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    logger.info("Reported Concern clarification created", {
      code: "CONCERN_CLARIFICATION_CREATED",
      clarificationId,
      concernId,
      requestId: postId,
      actorUserId,
      semantics: validation.semantics,
    });
    return {
      ok: true,
      status: 201,
      code: "CONCERN_CLARIFICATION_CREATED",
      clarification: serializeClarification(inserted.rows[0]),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve failure */ }
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

module.exports = {
  CLARIFICATION_SEMANTICS,
  appendConcernClarification,
  createConcernIntegrityHash,
  createReportedConcern,
  listRequestLifecycle,
  serializeConcern,
  validateClarificationPayload,
};
