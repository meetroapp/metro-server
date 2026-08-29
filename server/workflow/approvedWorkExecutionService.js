"use strict";

const { randomUUID } = require("node:crypto");

const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");
const {
  hasActiveLifecycleGrant,
} = require("../authorization/lifecycleAuthorityService");
const {
  evaluateApprovedWorkDepositGateWithClient,
} = require("../finance/preWorkDepositService");
const {
  evaluateWorkPreparationStartWithClient,
} = require("./workPreparationService");

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

const CONTRACT_VERSION = 1;
const CAPABILITIES = Object.freeze({
  MANAGE: "approved_work.execution.manage",
  EXECUTE: "approved_work.execute",
});
const COMMANDS = Object.freeze({
  MATERIALIZE: "approved_work.execution.materialize",
  BIND_WORKSTREAM: "approved_work.execution.bind_workstream",
  CLASSIFY_ACTIVITY: "approved_work.execution.classify_activity",
  SUPERSEDE: "approved_work.execution.supersede",
  CLOSE: "approved_work.execution.close",
  RECONCILE_LEGACY: "approved_work.execution.reconcile_legacy",
  START_RECORD: "approved_work.execution.start.record",
});
const QUOTE_READ_CAPABILITY = "quote.read";
const EXECUTION_STATES = new Set(["ACTIVE", "SUPERSEDED", "CLOSED"]);
const CLASSIFICATIONS = new Set(["EXECUTION", "NON_EXECUTION"]);
const SCOPE_BASES = new Set(["DECISION_WIDE", "QUOTE_SCOPE_ITEM"]);

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function boundedText(value, maximum) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= maximum ? normalized : null;
}

function iso(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function validateInput(input, allowedFields, { command = false } = {}) {
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    "logger",
    "failureInjector",
    ...allowedFields,
    ...(command ? ["idempotencyKey"] : []),
  ]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return {
      error: failure(
        400,
        "APPROVED_WORK_EXECUTION_FIELD_REJECTED",
        "Server-owned Approved Work execution authority fields cannot be supplied."
      ),
    };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return {
      error: failure(
        400,
        "INVALID_APPROVED_WORK_EXECUTION_JOB",
        "A valid Job is required."
      ),
    };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  let idempotencyKey = null;
  if (command) {
    const validated = validateIdempotencyKey(input.idempotencyKey);
    if (validated.error) return validated;
    idempotencyKey = validated.idempotencyKey;
  }
  return {
    actorId: actor.id,
    jobId,
    idempotencyKey,
    logger: safeLogger(input.logger),
  };
}

async function runTransaction(pool, mode, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${mode}`);
    started = true;
    const outcome = await action(client);
    if (outcome?.abort) {
      await rollback(client);
      started = false;
      return outcome.abort;
    }
    await client.query("COMMIT");
    started = false;
    if (outcome?.afterCommit) outcome.afterCommit();
    return outcome?.result ?? outcome;
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

async function loadProfessionalContext(client, jobId, actorId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.professional_user_id, relationships.homeowner_id,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      roles.id AS professional_role_assignment_id
     FROM jobs
     INNER JOIN posts ON posts.id = jobs.job_request_id
       AND posts.lifecycle_contract_version = 2
       AND posts.cancelled_at IS NULL
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
       AND relationships.post_id = jobs.job_request_id
       AND relationships.emergency_request_id IS NULL
       AND relationships.status = 'active'
       AND relationships.professional_user_id = $2
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id
       AND professional.request_relationship_id = relationships.id
       AND professional.user_id = relationships.professional_user_id
     INNER JOIN relationship_participants customer
       ON customer.job_id = jobs.id
       AND customer.request_relationship_id = relationships.id
       AND customer.user_id = relationships.homeowner_id
     INNER JOIN participant_role_assignments roles
       ON roles.participant_id = professional.id
       AND roles.job_id = jobs.id
       AND roles.role = 'PRIMARY_PROFESSIONAL'
       AND roles.valid_from <= CURRENT_TIMESTAMP
       AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
     LEFT JOIN participant_role_revocations role_revocations
       ON role_revocations.role_assignment_id = roles.id
     WHERE jobs.id = $1
       AND jobs.lifecycle_contract_version = 2
       AND role_revocations.id IS NULL
     ORDER BY roles.valid_from DESC, roles.id DESC
     LIMIT 1
     ${lock ? "FOR UPDATE OF jobs, relationships" : ""}`,
    [jobId, actorId]
  );
  return result.rows[0] || null;
}

function unavailable() {
  return failure(
    404,
    "APPROVED_WORK_EXECUTION_UNAVAILABLE",
    "Approved Work execution authority is unavailable."
  );
}

async function hasDecisionCapability(client, context, capability, decisionId) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM lifecycle_authority_grants grants
       LEFT JOIN lifecycle_authority_grant_revocations revocations
         ON revocations.authority_grant_id = grants.id
       WHERE grants.grantee_participant_id = $1
         AND grants.job_id = $2
         AND grants.capability = $3
         AND grants.scope_type = 'approved_work'
         AND grants.scope_job_id = $2
         AND grants.scope_approved_quote_decision_id = $4
         AND grants.scope_approved_quote_decision = 'APPROVED'
         AND grants.valid_from <= CURRENT_TIMESTAMP
         AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
         AND revocations.id IS NULL
     ) AS granted`,
    [context.professional_participant_id, context.job_id, capability, decisionId]
  );
  return result.rows[0]?.granted === true;
}

async function hasAnyExecutionCapability(client, context) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM lifecycle_authority_grants grants
       LEFT JOIN lifecycle_authority_grant_revocations revocations
         ON revocations.authority_grant_id = grants.id
       WHERE grants.grantee_participant_id = $1
         AND grants.job_id = $2
         AND grants.capability = ANY($3::text[])
         AND grants.scope_type = 'approved_work'
         AND grants.scope_job_id = $2
         AND grants.scope_approved_quote_decision IS NOT NULL
         AND grants.valid_from <= CURRENT_TIMESTAMP
         AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
         AND revocations.id IS NULL
     ) AS granted`,
    [context.professional_participant_id, context.job_id, Object.values(CAPABILITIES)]
  );
  return result.rows[0]?.granted === true;
}

async function requireBootstrapAuthority(client, context, logger) {
  if (!context) return unavailable();
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.professional_participant_id,
    capability: QUOTE_READ_CAPABILITY,
    jobId: context.job_id,
    logger,
  });
  return granted ? null : unavailable();
}

async function requireExecutionAuthority(client, context, capability, decisionId) {
  if (!context || !(await hasDecisionCapability(client, context, capability, decisionId))) {
    return unavailable();
  }
  return null;
}

async function requireReadAuthority(client, context, logger) {
  if (!context) return unavailable();
  if (await hasAnyExecutionCapability(client, context)) return null;
  return requireBootstrapAuthority(client, context, logger);
}

async function loadApprovedDecisionSource(client, jobId, decisionId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      decisions.id AS approved_customer_decision_id,
      decisions.decision, decisions.issued_quote_version,
      decisions.issued_integrity_hash,
      decisions.customer_participant_id AS decision_customer_participant_id,
      quotes.id AS quote_id, quotes.status AS quote_status,
      versions.status AS quote_version_status,
      versions.currency,
      versions.integrity_hash AS quote_version_integrity_hash,
      issuances.source_snapshot_integrity_hash AS issuance_integrity_hash
     FROM jobs
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
       AND relationships.post_id = jobs.job_request_id
       AND relationships.emergency_request_id IS NULL
       AND relationships.status = 'active'
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id
       AND professional.request_relationship_id = relationships.id
       AND professional.user_id = relationships.professional_user_id
     INNER JOIN relationship_participants customer
       ON customer.job_id = jobs.id
       AND customer.request_relationship_id = relationships.id
       AND customer.user_id = relationships.homeowner_id
     INNER JOIN canonical_quote_customer_decisions decisions
       ON decisions.id = $2
       AND decisions.job_id = jobs.id
       AND decisions.relationship_id = relationships.id
       AND decisions.customer_participant_id = customer.id
       AND decisions.decision = 'APPROVED'
     INNER JOIN canonical_quotes quotes
       ON quotes.id = decisions.quote_id
       AND quotes.job_id = jobs.id
       AND quotes.relationship_id = relationships.id
       AND quotes.status = 'ISSUED'
     INNER JOIN canonical_quote_versions versions
       ON versions.quote_id = quotes.id
       AND versions.job_id = jobs.id
       AND versions.version = decisions.issued_quote_version
       AND versions.status = 'ISSUED'
     INNER JOIN canonical_quote_issuances issuances
       ON issuances.quote_id = quotes.id
       AND issuances.job_id = jobs.id
       AND issuances.quote_version = decisions.issued_quote_version
       AND issuances.source_snapshot_integrity_hash = decisions.issued_integrity_hash
     WHERE jobs.id = $1
       AND jobs.lifecycle_contract_version = 2
     LIMIT 1
     ${lock ? "FOR UPDATE OF jobs, relationships, quotes, decisions" : ""}`,
    [jobId, decisionId]
  );
  const source = result.rows[0] || null;
  if (source && (
    source.decision !== "APPROVED" ||
    source.quote_status !== "ISSUED" ||
    source.quote_version_status !== "ISSUED" ||
    source.issued_integrity_hash !== source.quote_version_integrity_hash ||
    source.issued_integrity_hash !== source.issuance_integrity_hash ||
    source.customer_participant_id !== source.decision_customer_participant_id
  )) {
    throw new Error("Approved Work execution commercial source integrity failed.");
  }
  return source;
}

async function reserveCommand(client, {
  jobId,
  participantId,
  commandName,
  commandScope,
  idempotencyKey,
  requestFingerprint,
}) {
  const inserted = await client.query(
    `INSERT INTO canonical_approved_work_execution_command_idempotency (
       id, job_id, actor_participant_id, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [randomUUID(), jobId, participantId, commandName, commandScope,
      idempotencyKey, requestFingerprint]
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], replay: null };
  const existing = await client.query(
    `SELECT *
     FROM canonical_approved_work_execution_command_idempotency
     WHERE actor_participant_id = $1
       AND command_name = $2
       AND command_scope = $3
       AND idempotency_key = $4
     LIMIT 1 FOR UPDATE`,
    [participantId, commandName, commandScope, idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row || row.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "APPROVED_WORK_EXECUTION_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different execution command."
      ),
    };
  }
  if (!row.completed_at || !row.result_reference) {
    return {
      error: failure(
        409,
        "APPROVED_WORK_EXECUTION_COMMAND_IN_PROGRESS",
        "The execution command is still in progress."
      ),
    };
  }
  return { row, replay: row.result_reference };
}

async function completeCommand(client, commandId, result) {
  const updated = await client.query(
    `UPDATE canonical_approved_work_execution_command_idempotency
     SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND completed_at IS NULL
     RETURNING id`,
    [commandId, JSON.stringify(result)]
  );
  if (!updated.rows[0]) {
    throw new Error("Approved Work execution command completion failed.");
  }
}

function replayResult(value) {
  return { ...value, replayed: true };
}

async function loadExecution(client, jobId, executionId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT executions.*,
      current.version AS current_version,
      current.state AS current_state,
      current.successor_execution_id,
      current.created_at AS current_version_created_at
     FROM canonical_approved_work_executions executions
     INNER JOIN LATERAL (
       SELECT versions.version, versions.state,
         versions.successor_execution_id, versions.created_at
       FROM canonical_approved_work_execution_versions versions
       WHERE versions.execution_id = executions.id
         AND versions.job_id = executions.job_id
       ORDER BY versions.version DESC LIMIT 1
     ) current ON TRUE
     WHERE executions.id = $1 AND executions.job_id = $2
     LIMIT 1
     ${lock ? "FOR UPDATE OF executions" : ""}`,
    [executionId, jobId]
  );
  return result.rows[0] || null;
}

async function loadExecutions(client, jobId) {
  const result = await client.query(
    `SELECT executions.*,
      current.version AS current_version,
      current.state AS current_state,
      current.successor_execution_id,
      current.created_at AS current_version_created_at
     FROM canonical_approved_work_executions executions
     INNER JOIN LATERAL (
       SELECT versions.version, versions.state,
         versions.successor_execution_id, versions.created_at
       FROM canonical_approved_work_execution_versions versions
       WHERE versions.execution_id = executions.id
         AND versions.job_id = executions.job_id
       ORDER BY versions.version DESC LIMIT 1
     ) current ON TRUE
     WHERE executions.job_id = $1
     ORDER BY executions.created_at ASC, executions.id ASC`,
    [jobId]
  );
  return result.rows;
}

async function loadWorkstream(client, jobId, workstreamId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT workstreams.id, workstreams.job_id, workstreams.sequence,
      versions.version AS current_version, versions.title,
      versions.state, versions.created_at AS version_created_at
     FROM canonical_workstreams workstreams
     INNER JOIN LATERAL (
       SELECT version, title, state, created_at
       FROM canonical_workstream_versions
       WHERE workstream_id = workstreams.id AND job_id = workstreams.job_id
       ORDER BY version DESC LIMIT 1
     ) versions ON TRUE
     WHERE workstreams.id = $1 AND workstreams.job_id = $2
     LIMIT 1
     ${lock ? "FOR UPDATE OF workstreams" : ""}`,
    [workstreamId, jobId]
  );
  return result.rows[0] || null;
}

async function loadActivity(client, jobId, workstreamId, activityId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT activities.id, activities.workstream_id, activities.job_id,
      versions.version AS current_version, versions.activity_type,
      versions.statement, versions.status, versions.customer_visible,
      versions.performed_at, versions.created_at AS version_created_at
     FROM canonical_work_activities activities
     INNER JOIN LATERAL (
       SELECT version, activity_type, statement, status,
         customer_visible, performed_at, created_at
       FROM canonical_work_activity_versions
       WHERE activity_id = activities.id
         AND workstream_id = activities.workstream_id
         AND job_id = activities.job_id
       ORDER BY version DESC LIMIT 1
     ) versions ON TRUE
     WHERE activities.id = $1
       AND activities.workstream_id = $2
       AND activities.job_id = $3
     LIMIT 1
     ${lock ? "FOR UPDATE OF activities" : ""}`,
    [activityId, workstreamId, jobId]
  );
  return result.rows[0] || null;
}

function approvedWorkStartFailure(code) {
  const messages = {
    APPROVED_WORK_EXECUTION_REQUIRED:
      "Active Approved Work execution authority is required before Work can start.",
    APPROVED_WORK_EXECUTION_NOT_ACTIVE:
      "The Approved Work execution is no longer active.",
    APPROVED_WORK_EXECUTION_VERSION_CONFLICT:
      "The Approved Work execution changed before Work could start.",
    EXECUTION_ACTIVITY_CLASSIFICATION_REQUIRED:
      "The Work Activity is not classified for Approved Work execution.",
    EXECUTION_ACTIVITY_CLASSIFICATION_STALE:
      "The Work Activity changed after its execution classification was recorded.",
    EXECUTION_WORKSTREAM_BINDING_REQUIRED:
      "The Workstream is not bound to the Approved Work execution.",
    PRE_WORK_DEPOSIT_NOT_SATISFIED:
      "The required pre-work deposit must be fully satisfied before Work can start.",
    WORK_PREPARATION_NOT_READY:
      "Required materials and preparation must be ready before Work can start.",
    APPROVED_WORK_START_AUTHORITY_DENIED:
      "Approved Work start authority is unavailable.",
  };
  const versionConflict = code === "APPROVED_WORK_EXECUTION_VERSION_CONFLICT" ||
    code === "EXECUTION_ACTIVITY_CLASSIFICATION_STALE";
  return failure(
    versionConflict ? 409 : code === "APPROVED_WORK_START_AUTHORITY_DENIED" ? 404 : 409,
    code,
    messages[code] || "Approved Work cannot start."
  );
}

async function loadActivityClassificationForStart(
  client,
  { jobId, workstreamId, activityId }
) {
  const result = await client.query(
    `SELECT classifications.*,
      bindings.id AS binding_id
     FROM canonical_work_activity_execution_classifications classifications
     LEFT JOIN canonical_approved_work_execution_workstreams bindings
       ON bindings.execution_id = classifications.execution_id
       AND bindings.workstream_id = classifications.workstream_id
       AND bindings.job_id = classifications.job_id
       AND bindings.relationship_id = classifications.relationship_id
     WHERE classifications.activity_id = $1
       AND classifications.workstream_id = $2
       AND classifications.job_id = $3
     LIMIT 1`,
    [activityId, workstreamId, jobId]
  );
  return result.rows[0] || null;
}

function approvedWorkStartProjection({ execution, classification, deposit, materials }) {
  const depositRequired = deposit?.requirement?.kind !== "NOT_REQUIRED";
  return {
    ready: true,
    execution: {
      id: execution.id,
      version: Number(execution.current_version),
      approvedCustomerDecisionId: execution.approved_customer_decision_id,
    },
    activity: classification
      ? {
        id: classification.activity_id,
        version: Number(classification.classified_activity_version),
        classification: classification.classification,
      }
      : null,
    deposit: {
      required: depositRequired,
      satisfied: deposit?.allowed === true,
      state: deposit?.state || "UNAVAILABLE",
    },
    materials: {
      required: materials?.required === true,
      ready: materials?.allowed === true,
      planId: materials?.planId || null,
      planVersion: materials?.planVersion || null,
    },
    authority: { actorAuthorized: true },
    blockers: [],
  };
}

async function evaluateApprovedWorkStartReadinessWithClient({
  client,
  actorUserId,
  jobId,
  executionId,
  expectedExecutionVersion,
  sourceType,
  workstreamId = null,
  activityId = null,
  expectedActivityVersion = null,
  approvedCustomerDecisionId = null,
  logger = console,
}) {
  const context = await loadProfessionalContext(client, jobId, actorUserId, { lock: true });
  if (!context) {
    return { error: approvedWorkStartFailure("APPROVED_WORK_START_AUTHORITY_DENIED") };
  }
  const execution = await loadExecution(client, jobId, executionId, { lock: true });
  if (!execution) {
    return { error: approvedWorkStartFailure("APPROVED_WORK_EXECUTION_REQUIRED") };
  }
  if (Number(execution.current_version) !== Number(expectedExecutionVersion)) {
    return { error: approvedWorkStartFailure("APPROVED_WORK_EXECUTION_VERSION_CONFLICT") };
  }
  if (execution.current_state !== "ACTIVE") {
    return { error: approvedWorkStartFailure("APPROVED_WORK_EXECUTION_NOT_ACTIVE") };
  }
  if (
    approvedCustomerDecisionId &&
    execution.approved_customer_decision_id !== approvedCustomerDecisionId
  ) {
    return { error: approvedWorkStartFailure("APPROVED_WORK_EXECUTION_REQUIRED") };
  }
  const authorityError = await requireExecutionAuthority(
    client,
    context,
    CAPABILITIES.EXECUTE,
    execution.approved_customer_decision_id
  );
  if (authorityError) {
    logger.warn?.("Approved Work start authority denied", {
      code: "APPROVED_WORK_START_AUTHORITY_DENIED",
      actorUserId,
      jobId,
    });
    return { error: approvedWorkStartFailure("APPROVED_WORK_START_AUTHORITY_DENIED") };
  }

  let classification = null;
  if (sourceType === "EXECUTION_ACTIVITY") {
    classification = await loadActivityClassificationForStart(client, {
      jobId,
      workstreamId,
      activityId,
    });
    if (!classification || classification.classification !== "EXECUTION") {
      return { error: approvedWorkStartFailure("EXECUTION_ACTIVITY_CLASSIFICATION_REQUIRED") };
    }
    if (classification.execution_id !== execution.id) {
      return { error: approvedWorkStartFailure("APPROVED_WORK_EXECUTION_REQUIRED") };
    }
    if (!classification.binding_id) {
      return { error: approvedWorkStartFailure("EXECUTION_WORKSTREAM_BINDING_REQUIRED") };
    }
    if (
      Number(classification.classified_activity_version) !==
      Number(expectedActivityVersion)
    ) {
      return { error: approvedWorkStartFailure("EXECUTION_ACTIVITY_CLASSIFICATION_STALE") };
    }
  }

  const deposit = await evaluateApprovedWorkDepositGateWithClient({
    client,
    jobId,
    approvedQuoteDecisionId: execution.approved_customer_decision_id,
    lock: true,
  });
  if (!deposit.allowed) {
    return { error: approvedWorkStartFailure("PRE_WORK_DEPOSIT_NOT_SATISFIED") };
  }
  const materials = await evaluateWorkPreparationStartWithClient({
    client,
    jobId,
    approvedCustomerDecisionId: execution.approved_customer_decision_id,
    execution,
    lock: true,
  });
  if (!materials.allowed) {
    return { error: approvedWorkStartFailure("WORK_PREPARATION_NOT_READY") };
  }
  return {
    context,
    execution,
    classification,
    deposit,
    materials,
    projection: approvedWorkStartProjection({ execution, classification, deposit, materials }),
  };
}

async function recordApprovedWorkStartWithClient({
  client,
  readiness,
  sourceType,
  sourceId,
  sourceVersion,
  workstreamId = null,
  startedAt,
  idempotencyKey,
}) {
  const execution = readiness.execution;
  const context = readiness.context;
  const startedAtIso = iso(startedAt);
  const sourceName = sourceType === "EXECUTION_ACTIVITY" ? "activity" : "visit";
  const commandScope = `execution:${execution.id}:start:${sourceName}:${sourceId}`;
  const requestFingerprint = fingerprint({
    executionId: execution.id,
    executionVersion: Number(execution.current_version),
    sourceType,
    sourceId,
    sourceVersion: Number(sourceVersion),
    workstreamId,
    startedAt: startedAtIso,
  });
  const command = await reserveCommand(client, {
    jobId: execution.job_id,
    participantId: context.professional_participant_id,
    commandName: COMMANDS.START_RECORD,
    commandScope,
    idempotencyKey,
    requestFingerprint,
  });
  if (command.error) return { error: command.error };
  if (command.replay) {
    return { startEvent: command.replay.startEvent, replayed: true };
  }
  const eventId = randomUUID();
  const integrityHash = fingerprint({
    eventId,
    executionId: execution.id,
    jobId: execution.job_id,
    relationshipId: Number(execution.relationship_id),
    approvedCustomerDecisionId: execution.approved_customer_decision_id,
    sourceType,
    sourceId,
    sourceVersion: Number(sourceVersion),
    workstreamId,
    startedAt: startedAtIso,
    participantId: context.professional_participant_id,
    commandId: command.row.id,
  });
  await client.query(
    `INSERT INTO canonical_approved_work_execution_start_events (
       id, execution_id, job_id, relationship_id,
       approved_customer_decision_id, source_type,
       source_activity_id, source_activity_version, source_workstream_id,
       source_activity_classification, source_activity_status,
       source_visit_id, source_visit_version, source_visit_purpose,
       source_visit_state, started_at, recorded_by_participant_id,
       command_idempotency_id, integrity_hash
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9,$10,$11,
       $12,$13,$14,$15,$16,$17,$18,$19
     )`,
    [
      eventId,
      execution.id,
      execution.job_id,
      Number(execution.relationship_id),
      execution.approved_customer_decision_id,
      sourceType,
      sourceType === "EXECUTION_ACTIVITY" ? sourceId : null,
      sourceType === "EXECUTION_ACTIVITY" ? Number(sourceVersion) : null,
      sourceType === "EXECUTION_ACTIVITY" ? workstreamId : null,
      sourceType === "EXECUTION_ACTIVITY" ? "EXECUTION" : null,
      sourceType === "EXECUTION_ACTIVITY" ? "IN_PROGRESS" : null,
      sourceType === "APPROVED_WORK_VISIT" ? sourceId : null,
      sourceType === "APPROVED_WORK_VISIT" ? Number(sourceVersion) : null,
      sourceType === "APPROVED_WORK_VISIT" ? "APPROVED_WORK" : null,
      sourceType === "APPROVED_WORK_VISIT" ? "STARTED" : null,
      startedAtIso,
      context.professional_participant_id,
      command.row.id,
      integrityHash,
    ]
  );
  const startEvent = {
    id: eventId,
    executionId: execution.id,
    sourceType,
    sourceId,
    sourceVersion: Number(sourceVersion),
    startedAt: startedAtIso,
  };
  await completeCommand(client, command.row.id, {
    ok: true,
    success: true,
    code: "APPROVED_WORK_EXECUTION_START_RECORDED",
    startEvent,
  });
  return { startEvent, replayed: false };
}

function executionBaseProjection(row) {
  return {
    contractVersion: CONTRACT_VERSION,
    id: row.id,
    jobId: row.job_id,
    relationshipId: Number(row.relationship_id),
    source: {
      quoteId: row.quote_id,
      issuedQuoteVersion: Number(row.issued_quote_version),
      approvedCustomerDecisionId: row.approved_customer_decision_id,
      customerParticipantId: row.customer_participant_id,
      currency: row.commercial_currency,
    },
    currentVersion: Number(row.current_version),
    state: row.current_state,
    successorExecutionId: row.successor_execution_id || null,
    createdAt: iso(row.created_at),
    versionCreatedAt: iso(row.current_version_created_at),
  };
}

function bindingProjection(row) {
  return {
    id: row.binding_id || row.id,
    executionId: row.execution_id,
    workstreamId: row.workstream_id,
    jobId: row.job_id,
    workstream: {
      sequence: Number(row.sequence),
      title: row.title,
      state: row.workstream_state,
      currentVersion: Number(row.workstream_version),
    },
    createdAt: iso(row.binding_created_at || row.created_at),
  };
}

function classificationProjection(row) {
  return {
    activityId: row.activity_id,
    workstreamId: row.workstream_id,
    jobId: row.job_id,
    classification: row.classification,
    executionId: row.execution_id || null,
    scopeBasis: row.scope_basis || null,
    sourceScopeItemId: row.source_scope_item_id || null,
    classifiedActivityVersion: Number(row.classified_activity_version),
    activity: {
      type: row.activity_type,
      statement: row.statement,
      status: row.activity_status,
      currentVersion: Number(row.activity_version),
    },
    createdAt: iso(row.classification_created_at || row.created_at),
  };
}

async function loadBindings(client, executionId) {
  const result = await client.query(
    `SELECT bindings.id AS binding_id, bindings.execution_id,
      bindings.workstream_id, bindings.job_id, bindings.created_at AS binding_created_at,
      workstreams.sequence, versions.version AS workstream_version,
      versions.title, versions.state AS workstream_state
     FROM canonical_approved_work_execution_workstreams bindings
     INNER JOIN canonical_workstreams workstreams
       ON workstreams.id = bindings.workstream_id
       AND workstreams.job_id = bindings.job_id
     INNER JOIN LATERAL (
       SELECT version, title, state
       FROM canonical_workstream_versions
       WHERE workstream_id = workstreams.id AND job_id = workstreams.job_id
       ORDER BY version DESC LIMIT 1
     ) versions ON TRUE
     WHERE bindings.execution_id = $1
     ORDER BY workstreams.sequence, bindings.created_at, bindings.id`,
    [executionId]
  );
  return result.rows;
}

async function loadClassifications(client, execution) {
  const result = await client.query(
    `SELECT classifications.*,
      classifications.created_at AS classification_created_at,
      versions.version AS activity_version,
      versions.activity_type, versions.statement,
      versions.status AS activity_status
     FROM canonical_work_activity_execution_classifications classifications
     INNER JOIN LATERAL (
       SELECT version, activity_type, statement, status
       FROM canonical_work_activity_versions
       WHERE activity_id = classifications.activity_id
         AND workstream_id = classifications.workstream_id
         AND job_id = classifications.job_id
       ORDER BY version DESC LIMIT 1
     ) versions ON TRUE
     WHERE classifications.job_id = $1
       AND (
         classifications.execution_id = $2
         OR (
           classifications.classification = 'NON_EXECUTION'
           AND EXISTS (
             SELECT 1
             FROM canonical_approved_work_execution_workstreams bindings
             WHERE bindings.execution_id = $2
               AND bindings.workstream_id = classifications.workstream_id
               AND bindings.job_id = classifications.job_id
           )
         )
       )
     ORDER BY classifications.created_at, classifications.activity_id`,
    [execution.job_id, execution.id]
  );
  return result.rows;
}

async function loadStartSummary(client, executionId) {
  const result = await client.query(
    `SELECT count(*)::integer AS count,
      min(started_at) AS first_started_at,
      max(started_at) AS latest_started_at
     FROM canonical_approved_work_execution_start_events
     WHERE execution_id = $1`,
    [executionId]
  );
  const row = result.rows[0] || {};
  return {
    count: Number(row.count || 0),
    firstStartedAt: iso(row.first_started_at),
    latestStartedAt: iso(row.latest_started_at),
  };
}

async function projectExecutionWithClient(client, execution, context, { detail = true } = {}) {
  const projection = executionBaseProjection(execution);
  const canManage = await hasDecisionCapability(
    client,
    context,
    CAPABILITIES.MANAGE,
    execution.approved_customer_decision_id
  );
  const canExecute = await hasDecisionCapability(
    client,
    context,
    CAPABILITIES.EXECUTE,
    execution.approved_customer_decision_id
  );
  const actions = [];
  if (execution.current_state === "ACTIVE") {
    if (canExecute) {
      actions.push(
        "BIND_WORKSTREAM",
        "CLASSIFY_ACTIVITY",
        "RECONCILE_LEGACY",
        "COMPLETE_WORK"
      );
    }
    if (canManage) actions.push("SUPERSEDE");
  }
  projection.safeNextActions = actions;
  if (!detail) return projection;
  const bindings = await loadBindings(client, execution.id);
  const classifications = await loadClassifications(client, execution);
  const startSummary = await loadStartSummary(client, execution.id);
  projection.boundWorkstreams = bindings.map(bindingProjection);
  projection.activityClassifications = classifications.map(classificationProjection);
  projection.startEvents = startSummary;
  return projection;
}

async function insertExecutionGrants(client, context, execution) {
  for (const capability of Object.values(CAPABILITIES)) {
    const key = `approved-work-execution:${execution.approved_customer_decision_id}:${capability}`;
    await client.query(
      `INSERT INTO lifecycle_authority_grants (
         id, grantee_participant_id, grantor_participant_id, job_id,
         capability, scope_type, scope_job_id, scope_concern_id,
         scope_evaluation_id, scope_approved_quote_decision_id,
         scope_approved_quote_decision, source_evidence_type,
         source_evidence_reference, idempotency_key
       ) VALUES ($1,$2,$2,$3,$4,'approved_work',$3,NULL,NULL,$5,'APPROVED',
         'canonical_approved_work_execution',$6,$7)
       ON CONFLICT (
         grantor_participant_id, grantee_participant_id, capability,
         scope_type, scope_job_id, idempotency_key
       ) DO NOTHING`,
      [randomUUID(), context.professional_participant_id, context.job_id,
        capability, execution.approved_customer_decision_id, execution.id, key]
    );
  }
}

async function listApprovedWorkExecutions(input = {}) {
  const validated = validateInput(input, ["jobId"]);
  if (validated.error) return validated.error;
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId);
    const authorityError = await requireReadAuthority(client, context, validated.logger);
    if (authorityError) return { abort: authorityError };
    const rows = await loadExecutions(client, validated.jobId);
    const executions = [];
    for (const row of rows) {
      executions.push(await projectExecutionWithClient(client, row, context, { detail: false }));
    }
    return {
      result: {
        ok: true,
        success: true,
        status: 200,
        code: "APPROVED_WORK_EXECUTIONS_FOUND",
        executions,
      },
    };
  });
}

async function getApprovedWorkExecution(input = {}) {
  const validated = validateInput(input, ["jobId", "executionId"]);
  if (validated.error) return validated.error;
  const executionId = normalizedUuid(input.executionId);
  if (!executionId) return failure(400, "INVALID_APPROVED_WORK_EXECUTION", "A valid execution is required.");
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId);
    const authorityError = await requireReadAuthority(client, context, validated.logger);
    if (authorityError) return { abort: authorityError };
    const execution = await loadExecution(client, validated.jobId, executionId);
    if (!execution) return { abort: unavailable() };
    const canRead = await hasDecisionCapability(
      client,
      context,
      CAPABILITIES.MANAGE,
      execution.approved_customer_decision_id
    ) || await hasDecisionCapability(
      client,
      context,
      CAPABILITIES.EXECUTE,
      execution.approved_customer_decision_id
    );
    if (!canRead && await requireBootstrapAuthority(client, context, validated.logger)) {
      return { abort: unavailable() };
    }
    return {
      result: {
        ok: true,
        success: true,
        status: 200,
        code: "APPROVED_WORK_EXECUTION_FOUND",
        execution: await projectExecutionWithClient(client, execution, context),
      },
    };
  });
}

async function materializeApprovedWorkExecution(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "approvedCustomerDecisionId"],
    { command: true }
  );
  if (validated.error) return validated.error;
  const decisionId = normalizedUuid(input.approvedCustomerDecisionId);
  if (!decisionId) {
    return failure(
      400,
      "INVALID_APPROVED_CUSTOMER_DECISION",
      "An exact approved customer decision is required."
    );
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    const bootstrapError = await requireBootstrapAuthority(client, context, validated.logger);
    if (bootstrapError) return { abort: bootstrapError };
    const source = await loadApprovedDecisionSource(
      client,
      validated.jobId,
      decisionId,
      { lock: true }
    );
    if (!source ||
      source.professional_participant_id !== context.professional_participant_id ||
      source.customer_participant_id !== context.customer_participant_id ||
      Number(source.relationship_id) !== Number(context.relationship_id)) {
      return { abort: unavailable() };
    }
    const requestFingerprint = fingerprint({
      command: COMMANDS.MATERIALIZE,
      jobId: validated.jobId,
      decisionId,
      quoteId: source.quote_id,
      issuedQuoteVersion: Number(source.issued_quote_version),
      sourceIntegrityHash: source.issued_integrity_hash,
    });
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.MATERIALIZE,
      commandScope: `decision:${decisionId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    const existing = await client.query(
      `SELECT id FROM canonical_approved_work_executions
       WHERE approved_customer_decision_id = $1 LIMIT 1 FOR UPDATE`,
      [decisionId]
    );
    if (existing.rows[0]) {
      return {
        abort: failure(
          409,
          "APPROVED_WORK_EXECUTION_ALREADY_EXISTS",
          "The approved decision already has execution authority."
        ),
      };
    }
    const executionId = randomUUID();
    await client.query(
      `INSERT INTO canonical_approved_work_executions (
         id, job_id, job_request_id, relationship_id, quote_id,
         issued_quote_version, approved_customer_decision_id,
         commercial_currency, source_integrity_hash, customer_participant_id,
         created_by_professional_participant_id, created_by_role_assignment_id,
         created_command_idempotency_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [executionId, validated.jobId, Number(source.job_request_id),
        Number(source.relationship_id), source.quote_id,
        Number(source.issued_quote_version), decisionId, source.currency,
        source.issued_integrity_hash, source.customer_participant_id,
        context.professional_participant_id,
        context.professional_role_assignment_id, idempotency.row.id]
    );
    await client.query(
      `INSERT INTO canonical_approved_work_execution_versions (
         execution_id, version, job_id, relationship_id,
         customer_participant_id, state, successor_execution_id,
         recorded_by_participant_id, command_idempotency_id, integrity_hash
       ) VALUES ($1,1,$2,$3,$4,'ACTIVE',NULL,$5,$6,$7)`,
      [executionId, validated.jobId, Number(source.relationship_id),
        source.customer_participant_id, context.professional_participant_id,
        idempotency.row.id, requestFingerprint]
    );
    const execution = await loadExecution(client, validated.jobId, executionId);
    await insertExecutionGrants(client, context, execution);
    await invokeFailure(input.failureInjector, "after_execution_write");
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "APPROVED_WORK_EXECUTION_MATERIALIZED",
      execution: await projectExecutionWithClient(client, execution, context),
    };
    await completeCommand(client, idempotency.row.id, result);
    return {
      result,
      afterCommit: () => validated.logger.info("Approved Work execution materialized", {
        code: result.code,
        jobId: validated.jobId,
        executionId,
        decisionId,
        actorUserId: validated.actorId,
      }),
    };
  });
}

async function loadBindingForWorkstream(client, workstreamId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT * FROM canonical_approved_work_execution_workstreams
     WHERE workstream_id = $1 LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [workstreamId]
  );
  return result.rows[0] || null;
}

async function insertBinding(client, {
  execution,
  workstream,
  context,
  commandId,
}) {
  const id = randomUUID();
  const result = await client.query(
    `INSERT INTO canonical_approved_work_execution_workstreams (
       id, execution_id, workstream_id, job_id, relationship_id,
       bound_by_professional_participant_id, bound_by_role_assignment_id,
       command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id AS binding_id, execution_id, workstream_id, job_id,
       created_at AS binding_created_at`,
    [id, execution.id, workstream.id, execution.job_id,
      Number(execution.relationship_id), context.professional_participant_id,
      context.professional_role_assignment_id, commandId]
  );
  return {
    ...result.rows[0],
    sequence: workstream.sequence,
    title: workstream.title,
    workstream_state: workstream.state,
    workstream_version: workstream.current_version,
  };
}

async function bindWorkstreamToExecution(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "executionId", "workstreamId", "expectedExecutionVersion"],
    { command: true }
  );
  if (validated.error) return validated.error;
  const executionId = normalizedUuid(input.executionId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const expectedVersion = positiveInteger(input.expectedExecutionVersion);
  if (!executionId || !workstreamId || !expectedVersion) {
    return failure(400, "INVALID_EXECUTION_WORKSTREAM_BINDING", "The execution Workstream binding is invalid.");
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    if (!context) return { abort: unavailable() };
    const execution = await loadExecution(client, validated.jobId, executionId, { lock: true });
    if (!execution) return { abort: unavailable() };
    const authorityError = await requireExecutionAuthority(
      client,
      context,
      CAPABILITIES.EXECUTE,
      execution.approved_customer_decision_id
    );
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: COMMANDS.BIND_WORKSTREAM,
      jobId: validated.jobId,
      executionId,
      workstreamId,
      expectedVersion,
    });
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.BIND_WORKSTREAM,
      commandScope: `workstream:${workstreamId}:binding`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(execution.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_APPROVED_WORK_EXECUTION_VERSION", "The execution version is no longer current.") };
    }
    if (execution.current_state !== "ACTIVE") {
      return { abort: failure(409, "APPROVED_WORK_EXECUTION_NOT_ACTIVE", "Only an active execution can accept Workstreams.") };
    }
    const workstream = await loadWorkstream(client, validated.jobId, workstreamId, { lock: true });
    if (!workstream) return { abort: unavailable() };
    const existing = await loadBindingForWorkstream(client, workstreamId, { lock: true });
    if (existing) {
      return {
        abort: failure(
          409,
          existing.execution_id === executionId
            ? "WORKSTREAM_ALREADY_EXECUTION_BOUND"
            : "WORKSTREAM_BOUND_TO_OTHER_EXECUTION",
          "The Workstream already has immutable execution authority."
        ),
      };
    }
    const binding = await insertBinding(client, {
      execution,
      workstream,
      context,
      commandId: idempotency.row.id,
    });
    await invokeFailure(input.failureInjector, "after_binding_write");
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "WORKSTREAM_BOUND_TO_APPROVED_WORK_EXECUTION",
      binding: bindingProjection(binding),
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

function normalizeClassificationInput(input) {
  const classification = String(input.classification || "").trim().toUpperCase();
  const scopeBasis = input.scopeBasis == null
    ? null
    : String(input.scopeBasis).trim().toUpperCase();
  const sourceScopeItemId = input.sourceScopeItemId == null
    ? null
    : normalizedUuid(input.sourceScopeItemId);
  if (!CLASSIFICATIONS.has(classification)) return null;
  if (classification === "NON_EXECUTION") {
    return scopeBasis == null && sourceScopeItemId == null
      ? { classification, scopeBasis: null, sourceScopeItemId: null }
      : null;
  }
  if (!SCOPE_BASES.has(scopeBasis)) return null;
  if (scopeBasis === "DECISION_WIDE" && sourceScopeItemId == null) {
    return { classification, scopeBasis, sourceScopeItemId: null };
  }
  if (scopeBasis === "QUOTE_SCOPE_ITEM" && sourceScopeItemId) {
    return { classification, scopeBasis, sourceScopeItemId };
  }
  return null;
}

async function exactIncludedScope(client, execution, scopeItemId) {
  const result = await client.query(
    `SELECT scope_item_id
     FROM canonical_quote_scope_item_snapshots
     WHERE quote_id = $1
       AND quote_version = $2
       AND scope_item_id = $3
       AND job_id = $4
       AND included_in_total = TRUE
     LIMIT 1`,
    [execution.quote_id, Number(execution.issued_quote_version),
      scopeItemId, execution.job_id]
  );
  return result.rows[0] || null;
}

async function insertClassification(client, {
  execution,
  workstream,
  activity,
  normalized,
  context,
  commandId,
}) {
  let sourceQuoteId = null;
  let sourceQuoteVersion = null;
  let sourceScopeItemId = null;
  let sourceScopeIncluded = null;
  if (normalized.scopeBasis === "QUOTE_SCOPE_ITEM") {
    if (!(await exactIncludedScope(client, execution, normalized.sourceScopeItemId))) {
      return { error: failure(409, "APPROVED_WORK_SCOPE_ITEM_UNAVAILABLE", "The accepted Quote scope item is unavailable.") };
    }
    sourceQuoteId = execution.quote_id;
    sourceQuoteVersion = Number(execution.issued_quote_version);
    sourceScopeItemId = normalized.sourceScopeItemId;
    sourceScopeIncluded = true;
  }
  const inserted = await client.query(
    `INSERT INTO canonical_work_activity_execution_classifications (
       activity_id, classified_activity_version, workstream_id, job_id,
       relationship_id, classification, execution_id, scope_basis,
       source_quote_id, source_quote_version, source_scope_item_id,
       source_scope_included_in_total, classified_by_participant_id,
       command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [activity.id, Number(activity.current_version), workstream.id,
      execution.job_id, Number(execution.relationship_id),
      normalized.classification,
      normalized.classification === "EXECUTION" ? execution.id : null,
      normalized.scopeBasis, sourceQuoteId, sourceQuoteVersion,
      sourceScopeItemId, sourceScopeIncluded,
      context.professional_participant_id, commandId]
  );
  return {
    row: {
      ...inserted.rows[0],
      activity_type: activity.activity_type,
      statement: activity.statement,
      activity_status: activity.status,
      activity_version: activity.current_version,
    },
  };
}

async function classifyWorkActivity(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "executionId", "workstreamId", "activityId",
      "expectedExecutionVersion", "expectedActivityVersion", "classification",
      "scopeBasis", "sourceScopeItemId"],
    { command: true }
  );
  if (validated.error) return validated.error;
  const executionId = normalizedUuid(input.executionId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const activityId = normalizedUuid(input.activityId);
  const expectedExecutionVersion = positiveInteger(input.expectedExecutionVersion);
  const expectedActivityVersion = positiveInteger(input.expectedActivityVersion);
  const normalized = normalizeClassificationInput(input);
  if (!executionId || !workstreamId || !activityId ||
    !expectedExecutionVersion || !expectedActivityVersion || !normalized) {
    return failure(400, "INVALID_WORK_ACTIVITY_EXECUTION_CLASSIFICATION", "The Activity classification is invalid.");
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    if (!context) return { abort: unavailable() };
    const execution = await loadExecution(client, validated.jobId, executionId, { lock: true });
    if (!execution) return { abort: unavailable() };
    const authorityError = await requireExecutionAuthority(
      client,
      context,
      CAPABILITIES.EXECUTE,
      execution.approved_customer_decision_id
    );
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: COMMANDS.CLASSIFY_ACTIVITY,
      jobId: validated.jobId,
      executionId,
      workstreamId,
      activityId,
      expectedExecutionVersion,
      expectedActivityVersion,
      ...normalized,
    });
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.CLASSIFY_ACTIVITY,
      commandScope: `activity:${activityId}:classification`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(execution.current_version) !== expectedExecutionVersion) {
      return { abort: failure(409, "STALE_APPROVED_WORK_EXECUTION_VERSION", "The execution version is no longer current.") };
    }
    if (execution.current_state !== "ACTIVE") {
      return { abort: failure(409, "APPROVED_WORK_EXECUTION_NOT_ACTIVE", "Only an active execution can accept Activity classifications.") };
    }
    const workstream = await loadWorkstream(client, validated.jobId, workstreamId, { lock: true });
    const activity = await loadActivity(client, validated.jobId, workstreamId, activityId, { lock: true });
    if (!workstream || !activity) return { abort: unavailable() };
    if (Number(activity.current_version) !== expectedActivityVersion) {
      return { abort: failure(409, "STALE_WORK_ACTIVITY_VERSION", "The Activity version is no longer current.") };
    }
    const existing = await client.query(
      `SELECT activity_id FROM canonical_work_activity_execution_classifications
       WHERE activity_id = $1 LIMIT 1 FOR UPDATE`,
      [activityId]
    );
    if (existing.rows[0]) {
      return { abort: failure(409, "WORK_ACTIVITY_ALREADY_CLASSIFIED", "The Activity already has an immutable classification.") };
    }
    if (normalized.classification === "EXECUTION") {
      const binding = await loadBindingForWorkstream(client, workstreamId, { lock: true });
      if (!binding || binding.execution_id !== executionId) {
        return { abort: failure(409, "WORKSTREAM_EXECUTION_BINDING_REQUIRED", "The Activity Workstream is not bound to this execution.") };
      }
    }
    const inserted = await insertClassification(client, {
      execution,
      workstream,
      activity,
      normalized,
      context,
      commandId: idempotency.row.id,
    });
    if (inserted.error) return { abort: inserted.error };
    await invokeFailure(input.failureInjector, "after_classification_write");
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: normalized.classification === "EXECUTION"
        ? "WORK_ACTIVITY_CLASSIFIED_EXECUTION"
        : "WORK_ACTIVITY_CLASSIFIED_NON_EXECUTION",
      classification: classificationProjection(inserted.row),
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

async function transitionExecution(input, targetState) {
  const validated = validateInput(
    input,
    ["jobId", "executionId", "expectedVersion", ...(targetState === "SUPERSEDED" ? ["successorExecutionId"] : [])],
    { command: true }
  );
  if (validated.error) return validated.error;
  const executionId = normalizedUuid(input.executionId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const successorExecutionId = targetState === "SUPERSEDED"
    ? normalizedUuid(input.successorExecutionId)
    : null;
  if (!executionId || !expectedVersion ||
    (targetState === "SUPERSEDED" && (!successorExecutionId || successorExecutionId === executionId))) {
    return failure(400, "INVALID_APPROVED_WORK_EXECUTION_TRANSITION", "The execution transition is invalid.");
  }
  const commandName = targetState === "SUPERSEDED" ? COMMANDS.SUPERSEDE : COMMANDS.CLOSE;
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    if (!context) return { abort: unavailable() };
    const execution = await loadExecution(client, validated.jobId, executionId, { lock: true });
    if (!execution) return { abort: unavailable() };
    const authorityError = await requireExecutionAuthority(
      client,
      context,
      CAPABILITIES.MANAGE,
      execution.approved_customer_decision_id
    );
    if (authorityError) return { abort: authorityError };
    let successor = null;
    if (targetState === "SUPERSEDED") {
      successor = await loadExecution(client, validated.jobId, successorExecutionId, { lock: true });
      if (!successor || successor.current_state !== "ACTIVE" ||
        Number(successor.relationship_id) !== Number(execution.relationship_id) ||
        successor.customer_participant_id !== execution.customer_participant_id) {
        return { abort: failure(409, "INVALID_APPROVED_WORK_EXECUTION_SUCCESSOR", "The successor execution is unavailable.") };
      }
      const successorAuthority = await requireExecutionAuthority(
        client,
        context,
        CAPABILITIES.MANAGE,
        successor.approved_customer_decision_id
      );
      if (successorAuthority) return { abort: successorAuthority };
    }
    const requestFingerprint = fingerprint({
      command: commandName,
      jobId: validated.jobId,
      executionId,
      expectedVersion,
      successorExecutionId,
    });
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName,
      commandScope: `execution:${executionId}:state`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(execution.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_APPROVED_WORK_EXECUTION_VERSION", "The execution version is no longer current.") };
    }
    if (execution.current_state !== "ACTIVE") {
      return { abort: failure(409, "APPROVED_WORK_EXECUTION_NOT_ACTIVE", "Only an active execution can transition.") };
    }
    const nextVersion = expectedVersion + 1;
    await client.query(
      `INSERT INTO canonical_approved_work_execution_versions (
         execution_id, version, job_id, relationship_id,
         customer_participant_id, state, successor_execution_id,
         recorded_by_participant_id, command_idempotency_id, integrity_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [executionId, nextVersion, validated.jobId, Number(execution.relationship_id),
        execution.customer_participant_id, targetState, successorExecutionId,
        context.professional_participant_id, idempotency.row.id, requestFingerprint]
    );
    await invokeFailure(input.failureInjector, "after_execution_transition");
    const transitioned = await loadExecution(client, validated.jobId, executionId);
    const result = {
      ok: true,
      success: true,
      status: 200,
      code: targetState === "SUPERSEDED"
        ? "APPROVED_WORK_EXECUTION_SUPERSEDED"
        : "APPROVED_WORK_EXECUTION_CLOSED",
      execution: await projectExecutionWithClient(client, transitioned, context),
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

async function supersedeApprovedWorkExecution(input = {}) {
  return transitionExecution(input, "SUPERSEDED");
}

async function closeApprovedWorkExecution(input = {}) {
  return transitionExecution(input, "CLOSED");
}

function normalizeExpectedVersions(value, identityField, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 500) {
    return null;
  }
  const normalized = value.map((entry) => {
    if (!isPlainObject(entry) || Object.keys(entry).some((key) => ![
      identityField,
      "expectedVersion",
    ].includes(key))) return null;
    const id = normalizedUuid(entry[identityField]);
    const expectedVersion = positiveInteger(entry.expectedVersion);
    return id && expectedVersion ? { id, expectedVersion } : null;
  });
  if (normalized.some((entry) => !entry) ||
    new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
    return null;
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function expectedVersionsMatch(expected, rows) {
  if (expected.length !== rows.length) return false;
  const actual = new Map(rows.map((row) => [row.id, Number(row.current_version)]));
  return expected.every((entry) => actual.get(entry.id) === entry.expectedVersion);
}

function workflowIntegrityHash(type, value) {
  return fingerprint({ integrityVersion: 1, type, ...value });
}

async function loadCompletionWorkstreams(client, execution, { lock = false } = {}) {
  const result = await client.query(
    `SELECT workstreams.id, workstreams.job_id, workstreams.sequence,
      versions.version AS current_version, versions.title,
      versions.state, versions.created_at AS version_created_at
     FROM canonical_approved_work_execution_workstreams bindings
     INNER JOIN canonical_workstreams workstreams
       ON workstreams.id = bindings.workstream_id
       AND workstreams.job_id = bindings.job_id
     INNER JOIN LATERAL (
       SELECT version, title, state, created_at
       FROM canonical_workstream_versions
       WHERE workstream_id = workstreams.id AND job_id = workstreams.job_id
       ORDER BY version DESC LIMIT 1
     ) versions ON TRUE
     WHERE bindings.execution_id = $1 AND bindings.job_id = $2
     ORDER BY workstreams.sequence, workstreams.id
     ${lock ? "FOR UPDATE OF workstreams" : ""}`,
    [execution.id, execution.job_id]
  );
  return result.rows;
}

async function loadCompletionActivities(client, execution, { lock = false } = {}) {
  const result = await client.query(
    `SELECT activities.id, activities.workstream_id, activities.job_id,
      activities.actor_participant_id,
      classifications.classified_activity_version,
      versions.version AS current_version, versions.activity_type,
      versions.statement, versions.status,
      versions.temporary_intervention, versions.temporary_details,
      versions.customer_visible, versions.performed_at,
      versions.created_at AS version_created_at
     FROM canonical_work_activity_execution_classifications classifications
     INNER JOIN canonical_approved_work_execution_workstreams bindings
       ON bindings.execution_id = classifications.execution_id
       AND bindings.workstream_id = classifications.workstream_id
       AND bindings.job_id = classifications.job_id
     INNER JOIN canonical_work_activities activities
       ON activities.id = classifications.activity_id
       AND activities.workstream_id = classifications.workstream_id
       AND activities.job_id = classifications.job_id
     INNER JOIN LATERAL (
       SELECT version, activity_type, statement, status,
         temporary_intervention, temporary_details, customer_visible,
         performed_at, created_at
       FROM canonical_work_activity_versions
       WHERE activity_id = activities.id
         AND workstream_id = activities.workstream_id
         AND job_id = activities.job_id
       ORDER BY version DESC LIMIT 1
     ) versions ON TRUE
     WHERE classifications.execution_id = $1
       AND classifications.job_id = $2
       AND classifications.classification = 'EXECUTION'
     ORDER BY activities.workstream_id, activities.id
     ${lock ? "FOR UPDATE OF activities" : ""}`,
    [execution.id, execution.job_id]
  );
  return result.rows;
}

async function loadCompletionBlockers(client, jobId, workstreamIds) {
  const result = await client.query(
    `WITH latest_findings AS (
       SELECT DISTINCT ON (versions.finding_id)
         versions.finding_id, versions.confirmation_state,
         versions.resolution_state
       FROM canonical_finding_workstream_assignments assignments
       INNER JOIN canonical_evaluation_finding_versions versions
         ON versions.finding_id = assignments.finding_id
         AND versions.job_id = assignments.job_id
       WHERE assignments.job_id = $1
         AND assignments.workstream_id = ANY($2::uuid[])
       ORDER BY versions.finding_id, versions.version DESC
     ), latest_obligations AS (
       SELECT DISTINCT ON (versions.obligation_id)
         versions.obligation_id, versions.status
       FROM canonical_workstream_obligations obligations
       INNER JOIN canonical_workstream_obligation_versions versions
         ON versions.obligation_id = obligations.id
         AND versions.workstream_id = obligations.workstream_id
         AND versions.job_id = obligations.job_id
       WHERE obligations.job_id = $1
         AND obligations.workstream_id = ANY($2::uuid[])
       ORDER BY versions.obligation_id, versions.version DESC
     )
     SELECT
       (SELECT count(*) FROM latest_findings
         WHERE confirmation_state = 'CONFIRMED'
           AND resolution_state = 'OPEN')::integer AS open_findings,
       (SELECT count(*) FROM latest_findings
         WHERE confirmation_state = 'CONFIRMED'
           AND resolution_state = 'PARTIALLY_RESOLVED')::integer AS partial_findings,
       (SELECT count(*) FROM latest_obligations
         WHERE status = 'OPEN')::integer AS open_obligations`,
    [jobId, workstreamIds]
  );
  const row = result.rows[0] || {};
  return {
    openFindings: Number(row.open_findings || 0),
    partialFindings: Number(row.partial_findings || 0),
    openObligations: Number(row.open_obligations || 0),
  };
}

function completionBlockerReasons(workstreams, blockers) {
  const reasons = [];
  if (workstreams.some((row) => row.state === "BLOCKED")) {
    reasons.push("BLOCKED_WORKSTREAM");
  }
  if (workstreams.some((row) => !["OPEN", "ACTIVE", "COMPLETED"].includes(row.state))) {
    reasons.push("INELIGIBLE_WORKSTREAM_STATE");
  }
  if (blockers.openFindings > 0) reasons.push("OPEN_FINDING");
  if (blockers.partialFindings > 0) reasons.push("PARTIAL_FINDING");
  if (blockers.openObligations > 0) reasons.push("OPEN_OBLIGATION");
  return reasons;
}

async function completeApprovedWork(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "executionId", "expectedExecutionVersion",
      "expectedWorkstreams", "expectedActivities"],
    { command: true }
  );
  if (validated.error) return validated.error;
  const executionId = normalizedUuid(input.executionId);
  const expectedExecutionVersion = positiveInteger(input.expectedExecutionVersion);
  const expectedWorkstreams = normalizeExpectedVersions(
    input.expectedWorkstreams,
    "workstreamId"
  );
  const expectedActivities = normalizeExpectedVersions(
    input.expectedActivities,
    "activityId",
    { allowEmpty: true }
  );
  if (!executionId || !expectedExecutionVersion || !expectedWorkstreams || !expectedActivities) {
    return failure(
      400,
      "INVALID_APPROVED_WORK_COMPLETION",
      "The Complete Work command is invalid."
    );
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    if (!context) return { abort: unavailable() };
    const execution = await loadExecution(
      client,
      validated.jobId,
      executionId,
      { lock: true }
    );
    if (!execution) return { abort: unavailable() };
    const authorityError = await requireExecutionAuthority(
      client,
      context,
      CAPABILITIES.EXECUTE,
      execution.approved_customer_decision_id
    );
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: "approved_work.complete",
      jobId: validated.jobId,
      executionId,
      expectedExecutionVersion,
      expectedWorkstreams,
      expectedActivities,
    });
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.CLOSE,
      commandScope: `execution:${executionId}:complete-work`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(execution.current_version) !== expectedExecutionVersion) {
      return {
        abort: failure(
          409,
          "STALE_APPROVED_WORK_EXECUTION_VERSION",
          "The Approved Work execution version is no longer current."
        ),
      };
    }
    if (execution.current_state !== "ACTIVE") {
      return {
        abort: failure(
          409,
          "APPROVED_WORK_EXECUTION_NOT_ACTIVE",
          "Only active Approved Work can be completed."
        ),
      };
    }
    const source = await loadApprovedDecisionSource(
      client,
      validated.jobId,
      execution.approved_customer_decision_id,
      { lock: true }
    );
    if (!source || source.quote_id !== execution.quote_id ||
      Number(source.issued_quote_version) !== Number(execution.issued_quote_version) ||
      Number(source.relationship_id) !== Number(execution.relationship_id) ||
      source.customer_participant_id !== execution.customer_participant_id ||
      source.issued_integrity_hash !== execution.source_integrity_hash) {
      return {
        abort: failure(
          409,
          "APPROVED_WORK_EXECUTION_LINEAGE_INVALID",
          "The approved Work lineage is no longer valid."
        ),
      };
    }
    const startEvidenceResult = await client.query(
      `SELECT count(*)::integer AS count, min(started_at) AS first_started_at
       FROM canonical_approved_work_execution_start_events
       WHERE execution_id = $1 AND job_id = $2`,
      [executionId, validated.jobId]
    );
    const startEvidence = {
      count: Number(startEvidenceResult.rows[0]?.count || 0),
      firstStartedAt: iso(startEvidenceResult.rows[0]?.first_started_at),
    };
    if (startEvidence.count < 1) {
      return {
        abort: failure(
          409,
          "APPROVED_WORK_NOT_STARTED",
          "Approved Work must be started before it can be completed."
        ),
      };
    }
    const workstreams = await loadCompletionWorkstreams(client, execution, { lock: true });
    const activities = await loadCompletionActivities(client, execution, { lock: true });
    if (!expectedVersionsMatch(expectedWorkstreams, workstreams) ||
      !expectedVersionsMatch(expectedActivities, activities)) {
      return {
        abort: failure(
          409,
          "STALE_APPROVED_WORK_COMPLETION_SNAPSHOT",
          "The approved Work record changed before completion."
        ),
      };
    }
    if (activities.some((activity) => !["PLANNED", "IN_PROGRESS", "DONE"].includes(activity.status))) {
      return {
        abort: failure(
          409,
          "EXECUTION_ACTIVITY_NOT_COMPLETABLE",
          "An execution Activity cannot be completed."
        ),
      };
    }
    const blockers = await loadCompletionBlockers(
      client,
      validated.jobId,
      workstreams.map((row) => row.id)
    );
    const blockerReasons = completionBlockerReasons(workstreams, blockers);
    if (blockerReasons.length > 0) {
      return {
        abort: {
          ...failure(
            409,
            "APPROVED_WORK_COMPLETION_BLOCKED",
            "Approved Work has a blocker that must be resolved before completion."
          ),
          reasons: blockerReasons,
        },
      };
    }
    const completedAt = new Date();
    const activityReconciliation = [];
    for (const activity of activities) {
      const fromVersion = Number(activity.current_version);
      if (activity.status === "DONE") {
        activityReconciliation.push({
          activityId: activity.id,
          workstreamId: activity.workstream_id,
          fromVersion,
          toVersion: fromVersion,
          status: "DONE",
          changed: false,
        });
        continue;
      }
      const toVersion = fromVersion + 1;
      await client.query(
        `INSERT INTO canonical_work_activity_versions (
           activity_id, version, workstream_id, job_id, activity_type,
           statement, status, temporary_intervention, temporary_details,
           customer_visible, performed_at, created_by_participant_id, integrity_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,'DONE',$7,$8,$9,$10,$11,$12)`,
        [activity.id, toVersion, activity.workstream_id, validated.jobId,
          activity.activity_type, activity.statement,
          activity.temporary_intervention === true, activity.temporary_details,
          activity.customer_visible === true, completedAt,
          context.professional_participant_id,
          workflowIntegrityHash("work_activity", {
            activityId: activity.id,
            version: toVersion,
            workstreamId: activity.workstream_id,
            jobId: validated.jobId,
            activityType: activity.activity_type,
            statement: activity.statement,
            status: "DONE",
            temporaryIntervention: activity.temporary_intervention === true,
            temporaryDetails: activity.temporary_details,
            customerVisible: activity.customer_visible === true,
            performedAt: completedAt.toISOString(),
            participantId: context.professional_participant_id,
          })]
      );
      activityReconciliation.push({
        activityId: activity.id,
        workstreamId: activity.workstream_id,
        fromVersion,
        toVersion,
        status: "DONE",
        changed: true,
      });
    }
    await invokeFailure(input.failureInjector, "after_activity_reconciliation");
    const workstreamReconciliation = [];
    for (const workstream of workstreams) {
      const fromVersion = Number(workstream.current_version);
      if (workstream.state === "COMPLETED") {
        workstreamReconciliation.push({
          workstreamId: workstream.id,
          fromVersion,
          toVersion: fromVersion,
          state: "COMPLETED",
          changed: false,
        });
        continue;
      }
      const toVersion = fromVersion + 1;
      await client.query(
        `INSERT INTO canonical_workstream_versions (
           workstream_id, version, job_id, title, state,
           created_by_participant_id, integrity_hash
         ) VALUES ($1,$2,$3,$4,'COMPLETED',$5,$6)`,
        [workstream.id, toVersion, validated.jobId, workstream.title,
          context.professional_participant_id,
          workflowIntegrityHash("workstream", {
            workstreamId: workstream.id,
            version: toVersion,
            jobId: validated.jobId,
            title: workstream.title,
            state: "COMPLETED",
            participantId: context.professional_participant_id,
          })]
      );
      workstreamReconciliation.push({
        workstreamId: workstream.id,
        fromVersion,
        toVersion,
        state: "COMPLETED",
        changed: true,
      });
    }
    await invokeFailure(input.failureInjector, "after_workstream_reconciliation");
    const executionVersion = expectedExecutionVersion + 1;
    const completionIntegrityHash = fingerprint({
      command: "approved_work.complete",
      executionId,
      executionVersion,
      jobId: validated.jobId,
      relationshipId: Number(execution.relationship_id),
      quoteId: execution.quote_id,
      issuedQuoteVersion: Number(execution.issued_quote_version),
      approvedCustomerDecisionId: execution.approved_customer_decision_id,
      participantId: context.professional_participant_id,
      completedAt: completedAt.toISOString(),
      activityReconciliation,
      workstreamReconciliation,
    });
    await client.query(
      `INSERT INTO canonical_approved_work_execution_versions (
         execution_id, version, job_id, relationship_id,
         customer_participant_id, state, successor_execution_id,
         recorded_by_participant_id, command_idempotency_id, integrity_hash
       ) VALUES ($1,$2,$3,$4,$5,'CLOSED',NULL,$6,$7,$8)`,
      [executionId, executionVersion, validated.jobId,
        Number(execution.relationship_id), execution.customer_participant_id,
        context.professional_participant_id, idempotency.row.id,
        completionIntegrityHash]
    );
    await invokeFailure(input.failureInjector, "after_execution_completion");
    const transitioned = await loadExecution(client, validated.jobId, executionId);
    const completion = {
      contractVersion: CONTRACT_VERSION,
      state: "WORK_COMPLETED",
      jobId: validated.jobId,
      relationshipId: Number(execution.relationship_id),
      executionId,
      executionVersion: Number(transitioned.current_version),
      quoteId: execution.quote_id,
      issuedQuoteVersion: Number(execution.issued_quote_version),
      approvedCustomerDecisionId: execution.approved_customer_decision_id,
      completedByParticipantId: context.professional_participant_id,
      completedAt: iso(transitioned.current_version_created_at),
      evidence: {
        type: "APPROVED_WORK_EXECUTION_VERSION",
        commandId: idempotency.row.id,
        integrityHash: completionIntegrityHash,
      },
      startEvidence,
      activities: activityReconciliation,
      workstreams: workstreamReconciliation,
      nextAction: { code: "READY_TO_INVOICE", label: "Ready to Invoice" },
    };
    const result = {
      ok: true,
      success: true,
      status: 200,
      code: "APPROVED_WORK_COMPLETED",
      completion,
      execution: await projectExecutionWithClient(client, transitioned, context),
    };
    await completeCommand(client, idempotency.row.id, result);
    return {
      result,
      afterCommit: () => validated.logger.info("Approved Work completed", {
        code: result.code,
        actorUserId: validated.actorId,
        jobId: validated.jobId,
        executionId,
        executionVersion,
      }),
    };
  });
}

function childIdempotencyKey(rootKey, kind, identity) {
  return `reconcile:${fingerprint({ rootKey, kind, identity }).slice(0, 64)}`;
}

async function reconcileLegacyExecution(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "executionId", "workstreamId", "expectedExecutionVersion",
      "reason", "bindWorkstream", "activities"],
    { command: true }
  );
  if (validated.error) return validated.error;
  const executionId = normalizedUuid(input.executionId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const expectedExecutionVersion = positiveInteger(input.expectedExecutionVersion);
  const reason = boundedText(input.reason, 1000);
  if (!executionId || !workstreamId || !expectedExecutionVersion || !reason ||
    input.bindWorkstream !== true || !Array.isArray(input.activities) ||
    input.activities.length < 1 || input.activities.length > 100) {
    return failure(400, "INVALID_LEGACY_EXECUTION_RECONCILIATION", "The legacy reconciliation command is invalid.");
  }
  const activities = input.activities.map((entry) => {
    if (!isPlainObject(entry) || Object.keys(entry).some((key) => ![
      "activityId", "expectedActivityVersion", "classification",
      "scopeBasis", "sourceScopeItemId",
    ].includes(key))) return null;
    const activityId = normalizedUuid(entry.activityId);
    const expectedActivityVersion = positiveInteger(entry.expectedActivityVersion);
    const normalized = normalizeClassificationInput(entry);
    return activityId && expectedActivityVersion && normalized
      ? { activityId, expectedActivityVersion, ...normalized }
      : null;
  });
  if (activities.some((entry) => !entry) ||
    new Set(activities.map((entry) => entry.activityId)).size !== activities.length) {
    return failure(400, "INVALID_LEGACY_EXECUTION_RECONCILIATION", "The legacy reconciliation command is invalid.");
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    if (!context) return { abort: unavailable() };
    const execution = await loadExecution(client, validated.jobId, executionId, { lock: true });
    if (!execution) return { abort: unavailable() };
    const authorityError = await requireExecutionAuthority(
      client,
      context,
      CAPABILITIES.EXECUTE,
      execution.approved_customer_decision_id
    );
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: COMMANDS.RECONCILE_LEGACY,
      jobId: validated.jobId,
      executionId,
      workstreamId,
      expectedExecutionVersion,
      reason,
      bindWorkstream: true,
      activities,
    });
    const root = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.RECONCILE_LEGACY,
      commandScope: `execution:${executionId}:legacy-reconciliation`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (root.error) return { abort: root.error };
    if (root.replay) return { result: replayResult(root.replay) };
    if (Number(execution.current_version) !== expectedExecutionVersion) {
      return { abort: failure(409, "STALE_APPROVED_WORK_EXECUTION_VERSION", "The execution version is no longer current.") };
    }
    if (execution.current_state !== "ACTIVE") {
      return { abort: failure(409, "APPROVED_WORK_EXECUTION_NOT_ACTIVE", "Only an active execution can be reconciled.") };
    }
    const workstream = await loadWorkstream(client, validated.jobId, workstreamId, { lock: true });
    if (!workstream) return { abort: unavailable() };
    let binding = await loadBindingForWorkstream(client, workstreamId, { lock: true });
    if (binding && binding.execution_id !== executionId) {
      return { abort: failure(409, "WORKSTREAM_BOUND_TO_OTHER_EXECUTION", "The Workstream already has immutable execution authority.") };
    }
    if (!binding) {
      const child = await reserveCommand(client, {
        jobId: validated.jobId,
        participantId: context.professional_participant_id,
        commandName: COMMANDS.RECONCILE_LEGACY,
        commandScope: `workstream:${workstreamId}:legacy-binding`,
        idempotencyKey: childIdempotencyKey(validated.idempotencyKey, "binding", workstreamId),
        requestFingerprint: fingerprint({ root: requestFingerprint, workstreamId }),
      });
      if (child.error || child.replay) throw new Error("Legacy Workstream reconciliation reservation failed.");
      const inserted = await insertBinding(client, {
        execution,
        workstream,
        context,
        commandId: child.row.id,
      });
      binding = inserted;
      await completeCommand(client, child.row.id, {
        ok: true,
        success: true,
        status: 201,
        code: "LEGACY_WORKSTREAM_EXECUTION_BOUND",
        binding: bindingProjection(inserted),
      });
    } else {
      binding = {
        ...binding,
        binding_id: binding.id,
        binding_created_at: binding.created_at,
        sequence: workstream.sequence,
        title: workstream.title,
        workstream_state: workstream.state,
        workstream_version: workstream.current_version,
      };
    }
    const projected = [];
    for (const requested of activities) {
      const activity = await loadActivity(
        client,
        validated.jobId,
        workstreamId,
        requested.activityId,
        { lock: true }
      );
      if (!activity) return { abort: unavailable() };
      if (Number(activity.current_version) !== requested.expectedActivityVersion) {
        return { abort: failure(409, "STALE_WORK_ACTIVITY_VERSION", "An Activity version is no longer current.") };
      }
      const existing = await client.query(
        `SELECT activity_id FROM canonical_work_activity_execution_classifications
         WHERE activity_id = $1 LIMIT 1 FOR UPDATE`,
        [activity.id]
      );
      if (existing.rows[0]) {
        return { abort: failure(409, "WORK_ACTIVITY_ALREADY_CLASSIFIED", "An Activity already has an immutable classification.") };
      }
      const child = await reserveCommand(client, {
        jobId: validated.jobId,
        participantId: context.professional_participant_id,
        commandName: COMMANDS.RECONCILE_LEGACY,
        commandScope: `activity:${activity.id}:legacy-classification`,
        idempotencyKey: childIdempotencyKey(validated.idempotencyKey, "classification", activity.id),
        requestFingerprint: fingerprint({ root: requestFingerprint, activity: requested }),
      });
      if (child.error || child.replay) throw new Error("Legacy Activity reconciliation reservation failed.");
      const inserted = await insertClassification(client, {
        execution,
        workstream,
        activity,
        normalized: requested,
        context,
        commandId: child.row.id,
      });
      if (inserted.error) return { abort: inserted.error };
      const classification = classificationProjection(inserted.row);
      projected.push(classification);
      await completeCommand(client, child.row.id, {
        ok: true,
        success: true,
        status: 201,
        code: "LEGACY_WORK_ACTIVITY_CLASSIFIED",
        classification,
      });
    }
    await invokeFailure(input.failureInjector, "after_legacy_reconciliation");
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "LEGACY_APPROVED_WORK_EXECUTION_RECONCILED",
      reconciliation: {
        executionId,
        workstreamId,
        reason,
        binding: bindingProjection(binding),
        classifications: projected,
        startEventsCreated: 0,
      },
    };
    await completeCommand(client, root.row.id, result);
    return { result };
  });
}

module.exports = {
  CAPABILITIES,
  COMMANDS,
  EXECUTION_STATES,
  bindWorkstreamToExecution,
  classifyWorkActivity,
  closeApprovedWorkExecution,
  completeApprovedWork,
  evaluateApprovedWorkStartReadinessWithClient,
  getApprovedWorkExecution,
  listApprovedWorkExecutions,
  materializeApprovedWorkExecution,
  recordApprovedWorkStartWithClient,
  reconcileLegacyExecution,
  supersedeApprovedWorkExecution,
  approvedWorkExecutionServiceInternals: Object.freeze({
    childIdempotencyKey,
    completionBlockerReasons,
    executionBaseProjection,
    normalizeClassificationInput,
    normalizeExpectedVersions,
  }),
};
