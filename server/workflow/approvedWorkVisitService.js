"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");
const {
  hasActiveLifecycleGrant,
} = require("../authorization/lifecycleAuthorityService");

const {
  databaseClient,
  failure,
  isPlainObject,
  normalizedUuid,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

const APPROVED_WORK_VISIT_AUTHORITY_SOURCE =
  "CANONICAL_APPROVED_WORK_VISIT_AUTHORITY";
const APPROVED_WORK_VISIT_SOURCE_TYPE = "approved_work_visit_activation";
const QUOTE_READ_CAPABILITY = "quote.read";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES = Object.freeze([
  "visit.read",
  "visit.confirm",
  "visit.change_request",
]);
const PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES = Object.freeze([
  "visit.read",
  "visit.propose",
  "visit.reschedule",
  "visit.cancel",
  "visit.complete",
]);

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validIdempotencyKey(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return IDEMPOTENCY_KEY_PATTERN.test(normalized) ? normalized : null;
}

async function runTransaction(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const outcome = await action(client);
    if (outcome.abort) {
      await rollback(client);
      started = false;
      return outcome.abort;
    }
    await client.query("COMMIT");
    started = false;
    if (outcome.afterCommit) outcome.afterCommit();
    return outcome.result;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function runReadTransaction(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    started = true;
    const result = await action(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadContext(client, { jobId, quoteId, actorUserId, lock = false }) {
  const result = await client.query(
    `
    /* approved_work_visit:context */
    SELECT
      jobs.id AS job_id,
      quotes.id AS quote_id,
      decisions.id AS approved_quote_decision_id,
      decisions.decision AS approved_quote_decision,
      decisions.issued_quote_version,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      relationships.professional_user_id,
      relationships.homeowner_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = professional.id
          AND roles.job_id = jobs.id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS professional_role_active,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = customer.id
          AND roles.job_id = jobs.id
          AND roles.role = 'CUSTOMER_REPRESENTATIVE'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS customer_role_active
    FROM jobs
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
      AND posts.cancelled_at IS NULL
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
      AND relationships.status = 'active'
      AND relationships.professional_user_id = $3
    INNER JOIN canonical_quotes quotes
      ON quotes.id = $2
      AND quotes.job_id = jobs.id
      AND quotes.relationship_id = jobs.source_request_relationship_id
      AND quotes.status = 'ISSUED'
    INNER JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id
      AND decisions.job_id = jobs.id
      AND decisions.decision = 'APPROVED'
    INNER JOIN relationship_participants professional
      ON professional.job_id = jobs.id
      AND professional.request_relationship_id = relationships.id
      AND professional.user_id = relationships.professional_user_id
    INNER JOIN relationship_participants customer
      ON customer.job_id = jobs.id
      AND customer.request_relationship_id = relationships.id
      AND customer.user_id = relationships.homeowner_id
    WHERE jobs.id = $1
      AND jobs.lifecycle_contract_version = 2
    LIMIT 1
    ${lock ? "FOR UPDATE OF jobs, relationships, quotes" : ""}
    `,
    [jobId, quoteId, actorUserId]
  );
  return result.rows[0] || null;
}

async function requireActivationAuthority({ client, context, actorUserId, logger }) {
  if (
    !context ||
    context.approved_quote_decision !== "APPROVED" ||
    context.professional_role_active !== true ||
    context.customer_role_active !== true ||
    Number(context.professional_user_id) !== actorUserId
  ) {
    logger.warn("Approved Work Visit activation context denied", {
      code: "APPROVED_WORK_VISIT_CONTEXT_DENIED",
      actorUserId,
    });
    return failure(
      404,
      "APPROVED_WORK_VISIT_AUTHORITY_UNAVAILABLE",
      "Approved Work Visit authority is unavailable."
    );
  }
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.professional_participant_id,
    capability: QUOTE_READ_CAPABILITY,
    jobId: context.job_id,
    logger,
  });
  return granted
    ? null
    : failure(403, "QUOTE_AUTHORITY_REQUIRED", "Quote authority is required.");
}

async function loadActivation(client, jobId, approvedQuoteDecisionId) {
  const result = await client.query(
    `SELECT id, quote_id, approved_quote_decision_id, approved_quote_decision,
      job_id, activated_by_participant_id, idempotency_key,
      request_fingerprint, created_at
     FROM canonical_approved_work_visit_authority_activations
     WHERE approved_quote_decision_id = $1 AND job_id = $2
     LIMIT 1`,
    [approvedQuoteDecisionId, jobId]
  );
  return result.rows[0] || null;
}

async function loadActiveCapabilities(client, context) {
  const result = await client.query(
    `SELECT grants.grantee_participant_id, grants.capability
     FROM lifecycle_authority_grants grants
     LEFT JOIN lifecycle_authority_grant_revocations revocations
       ON revocations.authority_grant_id = grants.id
     WHERE grants.job_id = $1
       AND grants.scope_type = 'approved_work'
       AND grants.scope_job_id = $1
       AND grants.scope_concern_id IS NULL
       AND grants.scope_evaluation_id IS NULL
       AND grants.scope_approved_quote_decision_id = $2
       AND grants.scope_approved_quote_decision = 'APPROVED'
       AND grants.grantee_participant_id = ANY($3::uuid[])
       AND grants.valid_from <= CURRENT_TIMESTAMP
       AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
       AND revocations.id IS NULL
     ORDER BY grants.grantee_participant_id, grants.capability`,
    [
      context.job_id,
      context.approved_quote_decision_id,
      [context.customer_participant_id, context.professional_participant_id],
    ]
  );
  return result.rows;
}

function capabilitiesFor(rows, participantId, expected) {
  const actual = new Set(
    rows
      .filter((row) => row.grantee_participant_id === participantId)
      .map((row) => row.capability)
  );
  return expected.filter((capability) => actual.has(capability));
}

function authorityProjection(context, activation, grantRows, { replayed = false } = {}) {
  const customerCapabilities = capabilitiesFor(
    grantRows,
    context.customer_participant_id,
    CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES
  );
  const professionalCapabilities = capabilitiesFor(
    grantRows,
    context.professional_participant_id,
    PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES
  );
  const complete = Boolean(
    activation &&
    customerCapabilities.length === CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES.length &&
    professionalCapabilities.length === PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES.length
  );
  return {
    ok: true,
    success: true,
    status: 200,
    code: complete
      ? "APPROVED_WORK_VISIT_AUTHORITY_ACTIVE"
      : "APPROVED_WORK_VISIT_AUTHORITY_AVAILABLE",
    authority: {
      authoritySource: APPROVED_WORK_VISIT_AUTHORITY_SOURCE,
      jobId: context.job_id,
      quoteId: context.quote_id,
      approvedQuoteDecisionId: context.approved_quote_decision_id,
      issuedQuoteVersion: Number(context.issued_quote_version),
      purpose: "APPROVED_WORK",
      state: complete ? "ACTIVE" : "AVAILABLE",
      activatedAt: activation?.created_at || null,
      customerCapabilities,
      professionalCapabilities,
      actions: {
        canActivate: !activation,
        canProposeApprovedWorkVisit: complete,
      },
    },
    ...(replayed ? { replayed: true } : {}),
  };
}

function validateRequest(input, { command = false } = {}) {
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    "jobId",
    "quoteId",
    "logger",
    ...(command ? ["idempotencyKey"] : []),
  ]);
  if (!isPlainObject(input) || Object.keys(input).some((field) => !allowed.has(field))) {
    return {
      error: failure(
        400,
        "APPROVED_WORK_VISIT_AUTHORITY_FIELD_REJECTED",
        "Server-owned Approved Work Visit authority fields cannot be supplied."
      ),
    };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const jobId = normalizedUuid(input.jobId);
  const quoteId = normalizedUuid(input.quoteId);
  if (!jobId || !quoteId) {
    return {
      error: failure(
        400,
        "INVALID_APPROVED_WORK_VISIT_AUTHORITY",
        "A valid Job and Quote are required."
      ),
    };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const idempotencyKey = command ? validIdempotencyKey(input.idempotencyKey) : null;
  if (command && !idempotencyKey) {
    return {
      error: failure(
        400,
        "INVALID_APPROVED_WORK_VISIT_IDEMPOTENCY_KEY",
        "A valid Approved Work Visit idempotency key is required."
      ),
    };
  }
  return {
    actorId: actor.id,
    jobId,
    quoteId,
    idempotencyKey,
    logger: safeLogger(input.logger),
  };
}

async function getApprovedWorkVisitAuthority(input = {}) {
  const validated = validateRequest(input);
  if (validated.error) return validated.error;
  return runReadTransaction(input.pool, async (client) => {
    const context = await loadContext(client, {
      jobId: validated.jobId,
      quoteId: validated.quoteId,
      actorUserId: validated.actorId,
    });
    const authorityError = await requireActivationAuthority({
      client,
      context,
      actorUserId: validated.actorId,
      logger: validated.logger,
    });
    if (authorityError) return authorityError;
    const activation = await loadActivation(
      client,
      validated.jobId,
      context.approved_quote_decision_id
    );
    const grants = await loadActiveCapabilities(client, context);
    return authorityProjection(context, activation, grants);
  });
}

async function insertGrant({ client, context, activationId, participantId, role, capability }) {
  const idempotencyKey =
    `approved-work-visit:${context.approved_quote_decision_id}:${role}:${capability}`;
  const result = await client.query(
    `INSERT INTO lifecycle_authority_grants (
      id, grantee_participant_id, grantor_participant_id, job_id,
      capability, scope_type, scope_job_id, scope_concern_id,
      scope_evaluation_id, scope_approved_quote_decision_id,
      scope_approved_quote_decision, source_evidence_type,
      source_evidence_reference, idempotency_key
     ) VALUES (
      $1, $2, $3, $4, $5, 'approved_work', $4, NULL,
      NULL, $6, 'APPROVED', $7, $8, $9
     )
     ON CONFLICT (
       grantor_participant_id, grantee_participant_id, capability,
       scope_type, scope_job_id, idempotency_key
     ) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      participantId,
      context.professional_participant_id,
      context.job_id,
      capability,
      context.approved_quote_decision_id,
      APPROVED_WORK_VISIT_SOURCE_TYPE,
      activationId,
      idempotencyKey,
    ]
  );
  if (result.rows[0]) return;
  const existing = await client.query(
    `SELECT id
     FROM lifecycle_authority_grants
     WHERE grantee_participant_id = $1
       AND grantor_participant_id = $2
       AND job_id = $3
       AND capability = $4
       AND scope_type = 'approved_work'
       AND scope_job_id = $3
       AND scope_concern_id IS NULL
       AND scope_evaluation_id IS NULL
       AND scope_approved_quote_decision_id = $5
       AND scope_approved_quote_decision = 'APPROVED'
       AND source_evidence_type = $6
       AND source_evidence_reference = $7
       AND idempotency_key = $8
     LIMIT 1`,
    [
      participantId,
      context.professional_participant_id,
      context.job_id,
      capability,
      context.approved_quote_decision_id,
      APPROVED_WORK_VISIT_SOURCE_TYPE,
      activationId,
      idempotencyKey,
    ]
  );
  if (!existing.rows[0]) {
    throw new Error("Approved Work Visit capability grant creation failed.");
  }
}

async function activateApprovedWorkVisitAuthority(input = {}) {
  const validated = validateRequest(input, { command: true });
  if (validated.error) return validated.error;
  return runTransaction(input.pool, async (client) => {
    const context = await loadContext(client, {
      jobId: validated.jobId,
      quoteId: validated.quoteId,
      actorUserId: validated.actorId,
      lock: true,
    });
    const authorityError = await requireActivationAuthority({
      client,
      context,
      actorUserId: validated.actorId,
      logger: validated.logger,
    });
    if (authorityError) return { abort: authorityError };

    const requestFingerprint = fingerprint({
      command: "approved_work.visit.activate",
      jobId: validated.jobId,
      quoteId: validated.quoteId,
      approvedQuoteDecisionId: context.approved_quote_decision_id,
      actorUserId: validated.actorId,
    });
    let activation = await loadActivation(
      client,
      validated.jobId,
      context.approved_quote_decision_id
    );
    let replayed = false;
    if (activation) {
      if (
        activation.request_fingerprint !== requestFingerprint ||
        activation.idempotency_key !== validated.idempotencyKey
      ) {
        return {
          abort: failure(
            409,
            "APPROVED_WORK_VISIT_AUTHORITY_ALREADY_ACTIVE",
            "Approved Work Visit authority is already active."
          ),
        };
      }
      replayed = true;
    } else {
      const inserted = await client.query(
        `INSERT INTO canonical_approved_work_visit_authority_activations (
          id, quote_id, approved_quote_decision_id, approved_quote_decision,
          job_id, activated_by_participant_id, idempotency_key,
          request_fingerprint
         ) VALUES ($1, $2, $3, 'APPROVED', $4, $5, $6, $7)
         RETURNING id, quote_id, approved_quote_decision_id,
           approved_quote_decision, job_id, activated_by_participant_id,
           idempotency_key, request_fingerprint, created_at`,
        [
          randomUUID(),
          context.quote_id,
          context.approved_quote_decision_id,
          context.job_id,
          context.professional_participant_id,
          validated.idempotencyKey,
          requestFingerprint,
        ]
      );
      activation = inserted.rows[0];
    }

    for (const capability of CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES) {
      await insertGrant({
        client,
        context,
        activationId: activation.id,
        participantId: context.customer_participant_id,
        role: "customer",
        capability,
      });
    }
    for (const capability of PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES) {
      await insertGrant({
        client,
        context,
        activationId: activation.id,
        participantId: context.professional_participant_id,
        role: "professional",
        capability,
      });
    }

    const grants = await loadActiveCapabilities(client, context);
    const result = authorityProjection(context, activation, grants, { replayed });
    if (result.authority.state !== "ACTIVE") {
      throw new Error("Approved Work Visit authority activation is incomplete.");
    }
    return {
      result: {
        ...result,
        status: replayed ? 200 : 201,
        code: "APPROVED_WORK_VISIT_AUTHORITY_ACTIVATED",
      },
      afterCommit: () => validated.logger.info(
        replayed
          ? "Approved Work Visit authority replayed"
          : "Approved Work Visit authority activated",
        {
          code: "APPROVED_WORK_VISIT_AUTHORITY_ACTIVATED",
          actorUserId: validated.actorId,
          jobId: validated.jobId,
          quoteId: validated.quoteId,
          approvedQuoteDecisionId: context.approved_quote_decision_id,
          replayed,
        }
      ),
    };
  });
}

module.exports = {
  APPROVED_WORK_VISIT_AUTHORITY_SOURCE,
  CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES,
  PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES,
  activateApprovedWorkVisitAuthority,
  approvedWorkVisitServiceInternals: Object.freeze({
    authorityProjection,
    fingerprint,
    validIdempotencyKey,
  }),
  getApprovedWorkVisitAuthority,
};
