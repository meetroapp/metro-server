"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  commercialAuthorityInternals,
} = require("./commercialAuthorityService");
const {
  hasActiveLifecycleGrant,
} = require("./lifecycleAuthorityService");

const {
  databaseClient,
  failure,
  fingerprint,
  isPlainObject,
  normalizedUuid,
  positiveInteger,
  rollback,
  validateAuthenticatedActor,
  validateIdempotencyKey,
} = commercialAuthorityInternals;

const RECOMMENDATION_CAPABILITIES = Object.freeze({
  CREATE: "recommendation.create",
  READ: "recommendation.read",
  TRANSITION: "recommendation.transition",
  RECORD_CONSTRAINT: "customer_constraint.record",
});

const RECOMMENDATION_COMMANDS = Object.freeze({
  CREATE: "recommendation.create",
  UPDATE: "recommendation.update",
  TRANSITION: "recommendation.transition",
  RECORD_CONSTRAINT: "customer_constraint.record",
});

const RECOMMENDATION_KINDS = Object.freeze(["PRIMARY", "ALTERNATIVE"]);
const RECOMMENDATION_STATUSES = Object.freeze([
  "ACTIVE",
  "ACCEPTED",
  "DECLINED",
  "DEFERRED",
  "SUPERSEDED",
  "WITHDRAWN",
  "EXCLUDED_FROM_CURRENT_QUOTE",
  "SEPARATE_PROPOSAL_REQUIRED",
]);
const RECOMMENDATION_TRANSITIONS = Object.freeze({
  ACTIVE: new Set(RECOMMENDATION_STATUSES.filter((status) => status !== "ACTIVE")),
});
const CUSTOMER_CONSTRAINT_TYPES = Object.freeze([
  "BUDGET",
  "AVAILABILITY",
  "ACCESS",
  "CUSTOMER_SUPPLIED_MATERIAL",
  "OTHER",
]);
const CUSTOMER_DECISION_STATUSES = new Set(["ACCEPTED", "DECLINED", "DEFERRED"]);

function safeLogger(logger) {
  return logger && typeof logger.info === "function" && typeof logger.warn === "function"
    ? logger
    : console;
}

function boundedText(value, maximum, required = true) {
  if (value == null) return required ? null : "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) return null;
  return normalized;
}

function validateInput(input, fields) {
  if (!isPlainObject(input)) {
    return failure(400, "INVALID_RECOMMENDATION_COMMAND", "The Recommendation command is invalid.");
  }
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    "idempotencyKey",
    "logger",
    "failureInjector",
    ...fields,
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return failure(
      400,
      "RECOMMENDATION_AUTHORITY_FIELD_REJECTED",
      "Server-owned Recommendation fields cannot be supplied."
    );
  }
  return null;
}

function validateCommand(input, fields) {
  const inputError = validateInput(input, fields);
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  return { actorId: actor.id, idempotencyKey: idempotency.idempotencyKey };
}

function validateRead(input, fields) {
  const inputError = validateInput(input, fields);
  if (inputError) return { error: inputError };
  return validateAuthenticatedActor(input.authenticatedActor);
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

async function invokeFailure(injector, stage) {
  if (typeof injector === "function") await injector(stage);
}

async function reserveCommand({
  client,
  participantId,
  jobId,
  commandName,
  commandScope,
  idempotencyKey,
  requestFingerprint,
}) {
  const inserted = await client.query(
    `
    INSERT INTO canonical_recommendation_command_idempotency (
      id, actor_participant_id, job_id, command_name, command_scope,
      idempotency_key, request_fingerprint
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (
      actor_participant_id, command_name, command_scope, idempotency_key
    ) DO NOTHING
    RETURNING *
    `,
    [
      randomUUID(),
      participantId,
      jobId,
      commandName,
      commandScope,
      idempotencyKey,
      requestFingerprint,
    ]
  );
  if (inserted.rows[0]) return { reservation: inserted.rows[0] };

  const existing = await client.query(
    `
    SELECT *
    FROM canonical_recommendation_command_idempotency
    WHERE actor_participant_id = $1
      AND command_name = $2
      AND command_scope = $3
      AND idempotency_key = $4
    LIMIT 1
    FOR UPDATE
    `,
    [participantId, commandName, commandScope, idempotencyKey]
  );
  const reservation = existing.rows[0];
  if (!reservation || reservation.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "RECOMMENDATION_IDEMPOTENCY_KEY_CONFLICT",
        "The idempotency key was already used for a different Recommendation command."
      ),
    };
  }
  if (!reservation.result_reference || !reservation.completed_at) {
    return {
      error: failure(
        409,
        "RECOMMENDATION_COMMAND_IN_PROGRESS",
        "The Recommendation command is still being completed."
      ),
    };
  }
  return { reservation, replay: reservation.result_reference };
}

async function completeCommand(client, reservationId, result) {
  const completed = await client.query(
    `
    UPDATE canonical_recommendation_command_idempotency
    SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND result_reference IS NULL AND completed_at IS NULL
    RETURNING id
    `,
    [reservationId, JSON.stringify(result)]
  );
  if (!completed.rows[0]) {
    throw new Error("Recommendation command idempotency completion failed.");
  }
}

async function loadFindingContext(client, findingId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT
      findings.id AS finding_id,
      findings.evaluation_id,
      findings.job_id,
      jobs.lifecycle_contract_version,
      relationships.status AS relationship_status,
      relationships.professional_user_id AS selected_professional_user_id,
      participants.id AS actor_participant_id,
      participants.user_id AS actor_user_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = findings.job_id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_primary_professional,
      current.version AS finding_version,
      current.evaluation_version,
      current.confirmation_state,
      current.resolution_state
    FROM canonical_evaluation_findings findings
    INNER JOIN jobs ON jobs.id = findings.job_id
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
    LEFT JOIN relationship_participants participants
      ON participants.job_id = findings.job_id
      AND participants.user_id = $2
    INNER JOIN LATERAL (
      SELECT version, evaluation_version, confirmation_state, resolution_state
      FROM canonical_evaluation_finding_versions versions
      WHERE versions.finding_id = findings.id
        AND versions.job_id = findings.job_id
      ORDER BY versions.version DESC
      LIMIT 1
    ) current ON TRUE
    WHERE findings.id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE OF findings" : ""}
    `,
    [findingId, actorUserId]
  );
  return result.rows[0] || null;
}

async function loadRecommendationContext(
  client,
  recommendationId,
  actorUserId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    SELECT
      recommendations.*,
      jobs.lifecycle_contract_version,
      relationships.status AS relationship_status,
      relationships.professional_user_id AS selected_professional_user_id,
      participants.id AS actor_participant_id,
      participants.user_id AS actor_user_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = recommendations.job_id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_primary_professional,
      current.version,
      current.evaluation_version,
      current.statement,
      current.status,
      current.customer_visible,
      current.created_at AS version_created_at
    FROM canonical_recommendations recommendations
    INNER JOIN jobs ON jobs.id = recommendations.job_id
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
    LEFT JOIN relationship_participants participants
      ON participants.job_id = recommendations.job_id
      AND participants.user_id = $2
    INNER JOIN LATERAL (
      SELECT version, evaluation_version, statement, status, customer_visible,
        created_at
      FROM canonical_recommendation_versions versions
      WHERE versions.recommendation_id = recommendations.id
      ORDER BY versions.version DESC
      LIMIT 1
    ) current ON TRUE
    WHERE recommendations.id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE OF recommendations" : ""}
    `,
    [recommendationId, actorUserId]
  );
  return result.rows[0] || null;
}

async function requireAuthority({ client, context, capability, logger }) {
  if (!context) {
    return failure(404, "RECOMMENDATION_UNAVAILABLE", "The Recommendation context is unavailable.");
  }
  if (Number(context.lifecycle_contract_version) !== 2) {
    return failure(409, "LIFECYCLE_V2_REQUIRED", "Recommendation authority requires a lifecycle-v2 Job.");
  }
  if (context.relationship_status !== "active") {
    return failure(409, "RECOMMENDATION_CONTEXT_INACTIVE", "The Recommendation context is inactive.");
  }
  if (
    !context.actor_participant_id ||
    Number(context.selected_professional_user_id) !== Number(context.actor_user_id) ||
    context.actor_is_primary_professional !== true
  ) {
    logger.warn("Recommendation authority denied", {
      code: "RECOMMENDATION_AUTHORITY_DENIED",
      capability,
      jobId: context.job_id,
    });
    return failure(403, "RECOMMENDATION_AUTHORITY_REQUIRED", "Recommendation authority is required.");
  }
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.actor_participant_id,
    capability,
    jobId: context.job_id,
    logger,
  });
  if (!granted) {
    logger.warn("Recommendation authority denied", {
      code: "RECOMMENDATION_AUTHORITY_DENIED",
      participantId: context.actor_participant_id,
      capability,
      jobId: context.job_id,
    });
    return failure(403, "RECOMMENDATION_AUTHORITY_REQUIRED", "Recommendation authority is required.");
  }
  return null;
}

function integrityHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadRecommendationProjection(client, recommendationId) {
  const identity = (await client.query(
    `
    SELECT recommendations.*,
      current.version, current.evaluation_version, current.statement,
      current.status, current.customer_visible,
      current.created_at AS version_created_at
    FROM canonical_recommendations recommendations
    INNER JOIN LATERAL (
      SELECT version, evaluation_version, statement, status, customer_visible,
        created_at
      FROM canonical_recommendation_versions versions
      WHERE versions.recommendation_id = recommendations.id
      ORDER BY versions.version DESC LIMIT 1
    ) current ON TRUE
    WHERE recommendations.id = $1
    LIMIT 1
    `,
    [recommendationId]
  )).rows[0];
  if (!identity) return null;
  const versions = await client.query(
    `SELECT version, evaluation_version, statement, status, customer_visible,
       created_at
     FROM canonical_recommendation_versions
     WHERE recommendation_id = $1 ORDER BY version ASC`,
    [recommendationId]
  );
  const constraints = await client.query(
    `SELECT id, constraint_type, statement, source_evidence_type, created_at
     FROM canonical_customer_constraints
     WHERE recommendation_id = $1 ORDER BY created_at ASC, id ASC`,
    [recommendationId]
  );
  const dispositions = await client.query(
    `SELECT id, previous_recommendation_version, recommendation_version,
      previous_status, disposition, authority_classification,
      decision_evidence_note, replacement_recommendation_id, created_at
     FROM canonical_recommendation_disposition_events
     WHERE recommendation_id = $1 ORDER BY created_at ASC, id ASC`,
    [recommendationId]
  );
  return {
    id: identity.id,
    jobId: identity.job_id,
    findingId: identity.finding_id,
    evaluationId: identity.evaluation_id,
    kind: identity.kind,
    primaryRecommendationId: identity.primary_recommendation_id,
    currentVersion: Number(identity.version),
    evaluationVersion: Number(identity.evaluation_version),
    statement: identity.statement,
    status: identity.status,
    customerVisible: identity.customer_visible === true,
    createdAt: identity.created_at,
    versionCreatedAt: identity.version_created_at,
    versions: versions.rows.map((row) => ({
      version: Number(row.version),
      evaluationVersion: Number(row.evaluation_version),
      statement: row.statement,
      status: row.status,
      customerVisible: row.customer_visible === true,
      createdAt: row.created_at,
    })),
    constraints: constraints.rows.map((row) => ({
      id: row.id,
      type: row.constraint_type,
      statement: row.statement,
      evidenceClassification: row.source_evidence_type,
      createdAt: row.created_at,
    })),
    dispositions: dispositions.rows.map((row) => ({
      id: row.id,
      previousVersion: Number(row.previous_recommendation_version),
      version: Number(row.recommendation_version),
      previousStatus: row.previous_status,
      disposition: row.disposition,
      authorityClassification: row.authority_classification,
      decisionEvidenceNote: row.decision_evidence_note,
      replacementRecommendationId: row.replacement_recommendation_id,
      createdAt: row.created_at,
    })),
  };
}

function commandResult(code, status, recommendation, extra = {}) {
  return { ok: true, success: true, status, code, recommendation, ...extra };
}

async function createRecommendation(input = {}) {
  const validated = validateCommand(input, [
    "findingId",
    "kind",
    "statement",
    "primaryRecommendationId",
    "customerVisible",
  ]);
  if (validated.error) return validated.error;
  const findingId = normalizedUuid(input.findingId);
  const kind = String(input.kind || "").trim().toUpperCase();
  const statement = boundedText(input.statement, 5000);
  const customerVisible = input.customerVisible === true;
  const primaryRecommendationId = input.primaryRecommendationId == null
    ? null
    : normalizedUuid(input.primaryRecommendationId);
  if (
    !findingId ||
    !RECOMMENDATION_KINDS.includes(kind) ||
    !statement ||
    (input.customerVisible != null && typeof input.customerVisible !== "boolean")
  ) {
    return failure(400, "INVALID_RECOMMENDATION", "The Recommendation is invalid.");
  }
  if ((kind === "PRIMARY" && primaryRecommendationId) ||
      (kind === "ALTERNATIVE" && !primaryRecommendationId)) {
    return failure(400, "INVALID_RECOMMENDATION_LINEAGE", "The Recommendation lineage is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadFindingContext(client, findingId, validated.actorId, { lock: true });
    const authorityError = await requireAuthority({
      client,
      context,
      capability: RECOMMENDATION_CAPABILITIES.CREATE,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    if (context.confirmation_state !== "CONFIRMED") {
      return { abort: failure(409, "CONFIRMED_FINDING_REQUIRED", "A confirmed Finding is required.") };
    }

    if (kind === "ALTERNATIVE") {
      const primary = await client.query(
        `SELECT id FROM canonical_recommendations
         WHERE id = $1 AND job_id = $2 AND finding_id = $3 AND kind = 'PRIMARY'
         LIMIT 1 FOR SHARE`,
        [primaryRecommendationId, context.job_id, findingId]
      );
      if (!primary.rows[0]) {
        logger.warn("Recommendation lineage scope rejected", {
          code: "RECOMMENDATION_LINEAGE_SCOPE_MISMATCH",
          jobId: context.job_id,
          findingId,
        });
        return {
          abort: failure(
            409,
            "RECOMMENDATION_LINEAGE_SCOPE_MISMATCH",
            "The Alternative and Primary Recommendation scopes do not match."
          ),
        };
      }
    }

    const requestFingerprint = fingerprint({
      command: RECOMMENDATION_COMMANDS.CREATE,
      findingId,
      kind,
      statement,
      primaryRecommendationId,
      customerVisible,
    });
    const idempotency = await reserveCommand({
      client,
      participantId: context.actor_participant_id,
      jobId: context.job_id,
      commandName: RECOMMENDATION_COMMANDS.CREATE,
      commandScope: `finding:${findingId}:recommendations`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Recommendation create replayed", {
          code: "RECOMMENDATION_CREATE_REPLAYED",
          jobId: context.job_id,
          findingId,
        }),
      };
    }

    const statementFingerprint = createHash("sha256")
      .update(statement.toLowerCase(), "utf8")
      .digest("hex");
    const existing = await client.query(
      `SELECT id FROM canonical_recommendations
       WHERE finding_id = $1 AND kind = $2 AND statement_fingerprint = $3
       LIMIT 1`,
      [findingId, kind, statementFingerprint]
    );
    if (existing.rows[0]) {
      const recommendation = await loadRecommendationProjection(client, existing.rows[0].id);
      const result = commandResult("RECOMMENDATION_FOUND", 200, recommendation);
      await completeCommand(client, idempotency.reservation.id, result);
      return { result };
    }

    const recommendationId = randomUUID();
    await client.query(
      `
      INSERT INTO canonical_recommendations (
        id, job_id, finding_id, evaluation_id, author_participant_id,
        kind, primary_recommendation_id, primary_recommendation_kind,
        statement_fingerprint, source_evidence_type,
        source_evidence_reference, idempotency_key
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        CASE WHEN $6 = 'ALTERNATIVE' THEN 'PRIMARY' ELSE NULL END,
        $8, 'recommendation_command', $9, $10
      )
      `,
      [
        recommendationId,
        context.job_id,
        findingId,
        context.evaluation_id,
        context.actor_participant_id,
        kind,
        primaryRecommendationId,
        statementFingerprint,
        idempotency.reservation.id,
        validated.idempotencyKey,
      ]
    );
    await client.query(
      `
      INSERT INTO canonical_recommendation_versions (
        recommendation_id, version, job_id, finding_id, evaluation_id,
        evaluation_version, statement, status, created_by_participant_id,
        customer_visible, integrity_hash
      )
      VALUES ($1, 1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9)
      `,
      [
        recommendationId,
        context.job_id,
        findingId,
        context.evaluation_id,
        Number(context.evaluation_version),
        statement,
        context.actor_participant_id,
        customerVisible,
        integrityHash({
          recommendationId,
          version: 1,
          jobId: context.job_id,
          findingId,
          evaluationId: context.evaluation_id,
          evaluationVersion: Number(context.evaluation_version),
          statement,
          status: "ACTIVE",
          customerVisible,
          actorParticipantId: context.actor_participant_id,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const recommendation = await loadRecommendationProjection(client, recommendationId);
    const result = commandResult("RECOMMENDATION_CREATED", 201, recommendation);
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Recommendation created", {
        code: kind === "ALTERNATIVE" ? "ALTERNATIVE_RECOMMENDATION_CREATED" : "PRIMARY_RECOMMENDATION_CREATED",
        recommendationId,
        jobId: context.job_id,
        findingId,
        kind,
        version: 1,
      }),
    };
  });
}

async function updateRecommendation(input = {}) {
  const validated = validateCommand(input, [
    "recommendationId",
    "expectedVersion",
    "statement",
    "customerVisible",
  ]);
  if (validated.error) return validated.error;
  const recommendationId = normalizedUuid(input.recommendationId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const statement = boundedText(input.statement, 5000);
  const customerVisible = input.customerVisible === true;
  if (
    !recommendationId ||
    !expectedVersion ||
    !statement ||
    (input.customerVisible != null && typeof input.customerVisible !== "boolean")
  ) {
    return failure(
      400,
      "INVALID_RECOMMENDATION_UPDATE",
      "The Recommendation update is invalid."
    );
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadRecommendationContext(
      client,
      recommendationId,
      validated.actorId,
      { lock: true }
    );
    const authorityError = await requireAuthority({
      client,
      context,
      capability: RECOMMENDATION_CAPABILITIES.CREATE,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const idempotency = await reserveCommand({
      client,
      participantId: context.actor_participant_id,
      jobId: context.job_id,
      commandName: RECOMMENDATION_COMMANDS.UPDATE,
      commandScope: `recommendation:${recommendationId}:update`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        recommendationId,
        expectedVersion,
        statement,
        customerVisible,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return { result: { ...idempotency.replay, replayed: true } };
    }
    if (Number(context.version) !== expectedVersion) {
      return {
        abort: failure(
          409,
          "STALE_RECOMMENDATION_VERSION",
          "The Recommendation version is stale."
        ),
      };
    }
    if (context.status !== "ACTIVE") {
      return {
        abort: failure(
          409,
          "RECOMMENDATION_IMMUTABLE",
          "Only an active Recommendation can be updated."
        ),
      };
    }
    const nextVersion = expectedVersion + 1;
    await client.query(
      `
      INSERT INTO canonical_recommendation_versions (
        recommendation_id, version, job_id, finding_id, evaluation_id,
        evaluation_version, statement, status, created_by_participant_id,
        customer_visible, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10)
      `,
      [
        recommendationId,
        nextVersion,
        context.job_id,
        context.finding_id,
        context.evaluation_id,
        Number(context.evaluation_version),
        statement,
        context.actor_participant_id,
        customerVisible,
        integrityHash({
          recommendationId,
          version: nextVersion,
          jobId: context.job_id,
          findingId: context.finding_id,
          evaluationId: context.evaluation_id,
          evaluationVersion: Number(context.evaluation_version),
          statement,
          status: "ACTIVE",
          customerVisible,
          actorParticipantId: context.actor_participant_id,
        }),
      ]
    );
    const recommendation = await loadRecommendationProjection(
      client,
      recommendationId
    );
    const result = commandResult(
      "RECOMMENDATION_UPDATED",
      200,
      recommendation
    );
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Recommendation updated", {
        code: "RECOMMENDATION_UPDATED",
        recommendationId,
        jobId: context.job_id,
        findingId: context.finding_id,
        version: nextVersion,
      }),
    };
  });
}

async function readRecommendationAuthority(input, capability) {
  const validated = validateRead(input, ["recommendationId"]);
  if (validated.error) return validated;
  const recommendationId = normalizedUuid(input.recommendationId);
  if (!recommendationId) {
    return { error: failure(400, "INVALID_RECOMMENDATION_ID", "A valid Recommendation ID is required.") };
  }
  const logger = safeLogger(input.logger);
  const context = await loadRecommendationContext(input.pool, recommendationId, validated.id);
  const authorityError = await requireAuthority({ client: input.pool, context, capability, logger });
  return authorityError ? { error: authorityError } : { context, recommendationId };
}

async function getRecommendation(input = {}) {
  const authorized = await readRecommendationAuthority(input, RECOMMENDATION_CAPABILITIES.READ);
  if (authorized.error) return authorized.error;
  const recommendation = await loadRecommendationProjection(input.pool, authorized.recommendationId);
  return commandResult("RECOMMENDATION_FOUND", 200, recommendation);
}

async function listRecommendationsByFinding(input = {}) {
  const validated = validateRead(input, ["findingId"]);
  if (validated.error) return validated.error;
  const findingId = normalizedUuid(input.findingId);
  if (!findingId) {
    return failure(400, "INVALID_FINDING_ID", "A valid Finding ID is required.");
  }
  const logger = safeLogger(input.logger);
  const context = await loadFindingContext(input.pool, findingId, validated.id);
  const authorityError = await requireAuthority({
    client: input.pool,
    context,
    capability: RECOMMENDATION_CAPABILITIES.READ,
    logger,
  });
  if (authorityError) return authorityError;
  const identities = await input.pool.query(
    `SELECT id FROM canonical_recommendations
     WHERE finding_id = $1 ORDER BY created_at ASC, id ASC`,
    [findingId]
  );
  const recommendations = [];
  for (const row of identities.rows) {
    recommendations.push(await loadRecommendationProjection(input.pool, row.id));
  }
  return {
    ok: true,
    success: true,
    status: 200,
    code: "RECOMMENDATIONS_FOUND",
    recommendations,
  };
}

async function recordCustomerConstraint(input = {}) {
  const validated = validateCommand(input, [
    "recommendationId",
    "constraintType",
    "statement",
  ]);
  if (validated.error) return validated.error;
  const recommendationId = normalizedUuid(input.recommendationId);
  const constraintType = String(input.constraintType || "").trim().toUpperCase();
  const statement = boundedText(input.statement, 2000);
  if (!recommendationId || !CUSTOMER_CONSTRAINT_TYPES.includes(constraintType) || !statement) {
    return failure(400, "INVALID_CUSTOMER_CONSTRAINT", "The customer constraint is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadRecommendationContext(
      client,
      recommendationId,
      validated.actorId,
      { lock: true }
    );
    const authorityError = await requireAuthority({
      client,
      context,
      capability: RECOMMENDATION_CAPABILITIES.RECORD_CONSTRAINT,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: RECOMMENDATION_COMMANDS.RECORD_CONSTRAINT,
      recommendationId,
      constraintType,
      statement,
    });
    const idempotency = await reserveCommand({
      client,
      participantId: context.actor_participant_id,
      jobId: context.job_id,
      commandName: RECOMMENDATION_COMMANDS.RECORD_CONSTRAINT,
      commandScope: `recommendation:${recommendationId}:constraints`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Customer constraint replayed", {
          code: "CUSTOMER_CONSTRAINT_REPLAYED",
          recommendationId,
          jobId: context.job_id,
        }),
      };
    }
    const constraintId = randomUUID();
    await client.query(
      `
      INSERT INTO canonical_customer_constraints (
        id, recommendation_id, job_id, finding_id, evaluation_id,
        constraint_type, statement, recorded_by_participant_id,
        request_fingerprint, source_evidence_type,
        source_evidence_reference, idempotency_key
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        'professional_recorded_customer_constraint', $10, $11
      )
      `,
      [
        constraintId,
        recommendationId,
        context.job_id,
        context.finding_id,
        context.evaluation_id,
        constraintType,
        statement,
        context.actor_participant_id,
        requestFingerprint,
        idempotency.reservation.id,
        validated.idempotencyKey,
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const recommendation = await loadRecommendationProjection(client, recommendationId);
    const constraint = recommendation.constraints.find((row) => row.id === constraintId);
    const result = commandResult(
      "CUSTOMER_CONSTRAINT_RECORDED",
      201,
      recommendation,
      { constraint }
    );
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Customer constraint recorded", {
        code: "CUSTOMER_CONSTRAINT_RECORDED",
        recommendationId,
        constraintId,
        jobId: context.job_id,
        constraintType,
      }),
    };
  });
}

async function transitionRecommendation(input = {}) {
  const validated = validateCommand(input, [
    "recommendationId",
    "expectedVersion",
    "targetStatus",
    "replacementRecommendationId",
    "decisionEvidenceNote",
  ]);
  if (validated.error) return validated.error;
  const recommendationId = normalizedUuid(input.recommendationId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const targetStatus = String(input.targetStatus || "").trim().toUpperCase();
  const replacementRecommendationId = input.replacementRecommendationId == null
    ? null
    : normalizedUuid(input.replacementRecommendationId);
  const decisionEvidenceNote = input.decisionEvidenceNote == null
    ? null
    : boundedText(input.decisionEvidenceNote, 2000);
  if (!recommendationId || !expectedVersion || !RECOMMENDATION_STATUSES.includes(targetStatus) ||
      targetStatus === "ACTIVE" || decisionEvidenceNote === null && input.decisionEvidenceNote != null) {
    return failure(400, "INVALID_RECOMMENDATION_TRANSITION", "The Recommendation transition is invalid.");
  }
  if ((targetStatus === "SUPERSEDED" && !replacementRecommendationId) ||
      (targetStatus !== "SUPERSEDED" && replacementRecommendationId)) {
    return failure(400, "INVALID_RECOMMENDATION_REPLACEMENT", "Replacement lineage is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadRecommendationContext(
      client,
      recommendationId,
      validated.actorId,
      { lock: true }
    );
    const authorityError = await requireAuthority({
      client,
      context,
      capability: RECOMMENDATION_CAPABILITIES.TRANSITION,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: RECOMMENDATION_COMMANDS.TRANSITION,
      recommendationId,
      expectedVersion,
      targetStatus,
      replacementRecommendationId,
      decisionEvidenceNote,
    });
    const idempotency = await reserveCommand({
      client,
      participantId: context.actor_participant_id,
      jobId: context.job_id,
      commandName: RECOMMENDATION_COMMANDS.TRANSITION,
      commandScope: `recommendation:${recommendationId}:transition`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Recommendation transition replayed", {
          code: "RECOMMENDATION_TRANSITION_REPLAYED",
          recommendationId,
          jobId: context.job_id,
        }),
      };
    }
    if (Number(context.version) !== expectedVersion) {
      return { abort: failure(409, "STALE_RECOMMENDATION_VERSION", "The Recommendation version is stale.") };
    }
    if (!RECOMMENDATION_TRANSITIONS[context.status]?.has(targetStatus)) {
      return { abort: failure(409, "INVALID_RECOMMENDATION_STATE_TRANSITION", "The Recommendation transition is not allowed.") };
    }
    if (replacementRecommendationId) {
      if (replacementRecommendationId === recommendationId) {
        return { abort: failure(409, "RECOMMENDATION_SELF_REPLACEMENT", "A Recommendation cannot replace itself.") };
      }
      const replacement = await client.query(
        `SELECT id FROM canonical_recommendations
         WHERE id = $1 AND job_id = $2 AND finding_id = $3
         LIMIT 1 FOR SHARE`,
        [replacementRecommendationId, context.job_id, context.finding_id]
      );
      if (!replacement.rows[0]) {
        return { abort: failure(409, "RECOMMENDATION_REPLACEMENT_SCOPE_MISMATCH", "Replacement scope does not match.") };
      }
    }
    const nextVersion = expectedVersion + 1;
    await client.query(
      `
      INSERT INTO canonical_recommendation_versions (
        recommendation_id, version, job_id, finding_id, evaluation_id,
        evaluation_version, statement, status, created_by_participant_id,
        customer_visible, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        recommendationId,
        nextVersion,
        context.job_id,
        context.finding_id,
        context.evaluation_id,
        Number(context.evaluation_version),
        context.statement,
        targetStatus,
        context.actor_participant_id,
        context.customer_visible === true,
        integrityHash({
          recommendationId,
          version: nextVersion,
          jobId: context.job_id,
          findingId: context.finding_id,
          evaluationId: context.evaluation_id,
          evaluationVersion: Number(context.evaluation_version),
          statement: context.statement,
          status: targetStatus,
          customerVisible: context.customer_visible === true,
          actorParticipantId: context.actor_participant_id,
        }),
      ]
    );
    const eventId = randomUUID();
    const authorityClassification = CUSTOMER_DECISION_STATUSES.has(targetStatus)
      ? "PROFESSIONAL_RECORDED_CUSTOMER_DECISION"
      : "PROFESSIONAL_DISPOSITION";
    await client.query(
      `
      INSERT INTO canonical_recommendation_disposition_events (
        id, recommendation_id, previous_recommendation_version,
        recommendation_version, job_id, finding_id, previous_status,
        disposition, authority_classification, decision_evidence_note,
        replacement_recommendation_id, recorded_by_participant_id,
        source_evidence_type, source_evidence_reference, idempotency_key
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        'recommendation_transition_command', $13, $14
      )
      `,
      [
        eventId,
        recommendationId,
        expectedVersion,
        nextVersion,
        context.job_id,
        context.finding_id,
        context.status,
        targetStatus,
        authorityClassification,
        decisionEvidenceNote,
        replacementRecommendationId,
        context.actor_participant_id,
        idempotency.reservation.id,
        validated.idempotencyKey,
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const recommendation = await loadRecommendationProjection(client, recommendationId);
    const dispositionEvent = recommendation.dispositions.find((event) => event.id === eventId);
    const result = commandResult(
      "RECOMMENDATION_TRANSITIONED",
      200,
      recommendation,
      { dispositionEvent }
    );
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Recommendation transitioned", {
        code: "RECOMMENDATION_TRANSITIONED",
        recommendationId,
        jobId: context.job_id,
        previousVersion: expectedVersion,
        version: nextVersion,
        previousStatus: context.status,
        status: targetStatus,
        authorityClassification,
      }),
    };
  });
}

module.exports = {
  CUSTOMER_CONSTRAINT_TYPES,
  RECOMMENDATION_CAPABILITIES,
  RECOMMENDATION_COMMANDS,
  RECOMMENDATION_KINDS,
  RECOMMENDATION_STATUSES,
  createRecommendation,
  getRecommendation,
  listRecommendationsByFinding,
  recordCustomerConstraint,
  transitionRecommendation,
  updateRecommendation,
};
