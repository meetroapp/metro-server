"use strict";

const { randomUUID } = require("node:crypto");

const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");
const {
  hasActiveLifecycleGrant,
} = require("../authorization/lifecycleAuthorityService");

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

const WORKFLOW_CAPABILITIES = Object.freeze({
  CREATE_WORKSTREAM: "workstream.create",
  READ_WORKSTREAM: "workstream.read",
  ASSIGN_FINDING: "finding.assign_workstream",
  CREATE_ACTIVITY: "work_activity.create",
  PROGRESS_ACTIVITY: "work_activity.progress",
  READ_ACTIVITY: "work_activity.read",
  CREATE_OBLIGATION: "work_obligation.create",
  READ_OBLIGATION: "work_obligation.read",
  RESOLVE_FINDING: "finding.resolve",
  TRANSITION_OBLIGATION: "work_obligation.transition",
  COMPLETE_WORKSTREAM: "workstream.complete",
});

const WORKFLOW_COMMANDS = Object.freeze({
  CREATE_WORKSTREAM: "workstream.create",
  ASSIGN_FINDING: "finding.assign_workstream",
  CREATE_ACTIVITY: "work_activity.create",
  UPDATE_ACTIVITY: "work_activity.update",
  PROGRESS_ACTIVITY: "work_activity.progress",
  CREATE_OBLIGATION: "work_obligation.create",
  RESOLVE_FINDING: "finding.resolve",
  TRANSITION_OBLIGATION: "work_obligation.transition",
  COMPLETE_WORKSTREAM: "workstream.complete",
});

const WORKSTREAM_ACTIVITY_STATES = new Set(["OPEN", "ACTIVE", "BLOCKED"]);
const ACTIVITY_TRANSITIONS = Object.freeze({
  PLANNED: new Set(["IN_PROGRESS", "CANCELLED"]),
  IN_PROGRESS: new Set(["DONE", "CANCELLED"]),
  DONE: new Set(),
  CANCELLED: new Set(),
});
const ACTIVITY_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;
const FINDING_RESOLUTION_TRANSITIONS = Object.freeze({
  OPEN: new Set(["PARTIALLY_RESOLVED", "RESOLVED", "DEFERRED"]),
  PARTIALLY_RESOLVED: new Set(["RESOLVED", "DEFERRED"]),
  RESOLVED: new Set(),
  DEFERRED: new Set(),
});
const OBLIGATION_TRANSITIONS = Object.freeze({
  OPEN: new Set(["SATISFIED", "DEFERRED", "EXCLUDED"]),
  SATISFIED: new Set(),
  DEFERRED: new Set(),
  EXCLUDED: new Set(),
});

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function validateInput(input, allowedFields, code = "INVALID_WORKFLOW_COMMAND") {
  if (!isPlainObject(input)) {
    return failure(400, code, "The workflow command is invalid.");
  }
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    return failure(
      400,
      "WORKFLOW_AUTHORITY_FIELD_REJECTED",
      "Server-owned workflow fields cannot be supplied."
    );
  }
  return null;
}

function validateCommand(input, fields) {
  const inputError = validateInput(
    input,
    new Set([
      "pool",
      "authenticatedActor",
      "idempotencyKey",
      "logger",
      "failureInjector",
      ...fields,
    ])
  );
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  return { actorId: actor.id, idempotencyKey: idempotency.idempotencyKey };
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
    INSERT INTO canonical_workflow_command_idempotency (
      id, actor_participant_id, job_id, command_name, command_scope,
      idempotency_key, request_fingerprint
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (
      actor_participant_id, command_name, command_scope, idempotency_key
    )
    DO NOTHING
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
    FROM canonical_workflow_command_idempotency
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
        "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT",
        "The idempotency key was already used for a different workflow command."
      ),
    };
  }
  if (!reservation.result_reference || !reservation.completed_at) {
    return {
      error: failure(
        409,
        "WORKFLOW_COMMAND_IN_PROGRESS",
        "The workflow command is still being completed."
      ),
    };
  }
  return { reservation, replay: reservation.result_reference };
}

async function completeCommand(client, reservationId, result) {
  const completed = await client.query(
    `
    UPDATE canonical_workflow_command_idempotency
    SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND result_reference IS NULL
      AND completed_at IS NULL
    RETURNING id
    `,
    [reservationId, JSON.stringify(result)]
  );
  if (!completed.rows[0]) {
    throw new Error("Workflow command idempotency completion failed.");
  }
}

async function loadJobContext(client, jobId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    /* workstream:job_context */
    SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      jobs.lifecycle_contract_version,
      request_relationships.status AS relationship_status,
      relationship_participants.id AS actor_participant_id,
      relationship_participants.user_id AS actor_user_id
    FROM jobs
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
    INNER JOIN request_relationships
      ON request_relationships.id = jobs.source_request_relationship_id
      AND request_relationships.post_id = jobs.job_request_id
      AND request_relationships.emergency_request_id IS NULL
      AND request_relationships.status = 'active'
    INNER JOIN request_selections
      ON request_selections.id = jobs.source_request_selection_id
      AND request_selections.request_relationship_id = request_relationships.id
      AND request_selections.post_id = posts.id
    INNER JOIN relationship_participants
      ON relationship_participants.job_id = jobs.id
      AND relationship_participants.request_relationship_id = request_relationships.id
      AND relationship_participants.user_id = $2
    WHERE jobs.id = $1
      AND jobs.lifecycle_contract_version = 2
    LIMIT 1
    ${lock ? "FOR UPDATE OF jobs, request_relationships" : ""}
    `,
    [jobId, actorUserId]
  );
  return result.rows[0] || null;
}

async function requireAuthority({
  client,
  actorUserId,
  jobId,
  capability,
  logger,
  lock = false,
}) {
  const context = await loadJobContext(client, jobId, actorUserId, { lock });
  if (!context) {
    logger.warn("Workflow context denied", {
      code: "WORKFLOW_CONTEXT_DENIED",
      actorUserId,
      jobId,
      capability,
    });
    return {
      error: failure(404, "WORKFLOW_UNAVAILABLE", "The workflow is unavailable."),
    };
  }
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.actor_participant_id,
    capability,
    jobId,
    logger,
  });
  if (!granted) {
    logger.warn("Workflow authority denied", {
      code: "WORKFLOW_AUTHORITY_DENIED",
      actorUserId,
      participantId: context.actor_participant_id,
      jobId,
      capability,
    });
    return {
      error: failure(
        403,
        "WORKFLOW_AUTHORITY_REQUIRED",
        "Workflow authority is required."
      ),
    };
  }
  return { context };
}

function workstreamProjection(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    sequence: Number(row.sequence),
    title: row.title,
    state: row.state,
    currentVersion: Number(row.version),
    createdByParticipantId: row.created_by_participant_id,
    createdAt: row.created_at,
    versionCreatedAt: row.version_created_at,
  };
}

function activityProjection(row) {
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    jobId: row.job_id,
    actorParticipantId: row.actor_participant_id,
    activityType: row.activity_type,
    statement: row.statement,
    status: row.status,
    temporaryIntervention: row.temporary_intervention,
    temporaryDetails: row.temporary_details,
    customerVisible: row.customer_visible === true,
    performedAt: row.performed_at,
    currentVersion: Number(row.version),
    createdAt: row.created_at,
    versionCreatedAt: row.version_created_at,
  };
}

function obligationProjection(row) {
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    jobId: row.job_id,
    sequence: Number(row.sequence),
    sourceFindingId: row.source_finding_id,
    statement: row.statement,
    status: row.status,
    currentVersion: Number(row.version),
    createdByParticipantId: row.created_by_participant_id,
    createdAt: row.created_at,
    versionCreatedAt: row.version_created_at,
  };
}

async function loadWorkstream(client, jobId, workstreamId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT
      workstreams.id, workstreams.job_id, workstreams.sequence,
      workstreams.created_by_participant_id, workstreams.created_at,
      versions.version, versions.title, versions.state,
      versions.created_at AS version_created_at
    FROM canonical_workstreams AS workstreams
    INNER JOIN LATERAL (
      SELECT *
      FROM canonical_workstream_versions
      WHERE workstream_id = workstreams.id
        AND job_id = workstreams.job_id
      ORDER BY version DESC
      LIMIT 1
    ) AS versions ON TRUE
    WHERE workstreams.id = $1 AND workstreams.job_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF workstreams" : ""}
    `,
    [workstreamId, jobId]
  );
  return result.rows[0] || null;
}

async function loadActivity(
  client,
  jobId,
  workstreamId,
  activityId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    SELECT
      activities.id, activities.workstream_id, activities.job_id,
      activities.actor_participant_id, activities.created_at,
      versions.version, versions.activity_type, versions.statement,
      versions.status, versions.temporary_intervention,
      versions.temporary_details, versions.customer_visible,
      versions.performed_at,
      versions.created_at AS version_created_at
    FROM canonical_work_activities AS activities
    INNER JOIN LATERAL (
      SELECT *
      FROM canonical_work_activity_versions
      WHERE activity_id = activities.id
        AND workstream_id = activities.workstream_id
        AND job_id = activities.job_id
      ORDER BY version DESC
      LIMIT 1
    ) AS versions ON TRUE
    WHERE activities.id = $1
      AND activities.workstream_id = $2
      AND activities.job_id = $3
    LIMIT 1
    ${lock ? "FOR UPDATE OF activities" : ""}
    `,
    [activityId, workstreamId, jobId]
  );
  return result.rows[0] || null;
}

async function loadObligation(
  client,
  jobId,
  workstreamId,
  obligationId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    SELECT
      obligations.id, obligations.workstream_id, obligations.job_id,
      obligations.sequence, obligations.source_finding_id,
      obligations.created_by_participant_id, obligations.created_at,
      versions.version, versions.statement, versions.status,
      versions.created_at AS version_created_at
    FROM canonical_workstream_obligations AS obligations
    INNER JOIN LATERAL (
      SELECT *
      FROM canonical_workstream_obligation_versions
      WHERE obligation_id = obligations.id
        AND workstream_id = obligations.workstream_id
        AND job_id = obligations.job_id
      ORDER BY version DESC
      LIMIT 1
    ) AS versions ON TRUE
    WHERE obligations.id = $1
      AND obligations.workstream_id = $2
      AND obligations.job_id = $3
    LIMIT 1
    ${lock ? "FOR UPDATE OF obligations" : ""}
    `,
    [obligationId, workstreamId, jobId]
  );
  return result.rows[0] || null;
}

function commandResult(code, status, key, value, replayed = false) {
  return {
    ok: true,
    success: true,
    status,
    code,
    [key]: value,
    ...(replayed ? { replayed: true } : {}),
  };
}

function replayOutcome(result, logger, metadata) {
  return {
    result: { ...result, replayed: true },
    afterCommit: () => logger.info("Workflow command replayed", {
      code: "WORKFLOW_COMMAND_REPLAYED",
      ...metadata,
    }),
  };
}

function integrityHash(type, value) {
  return fingerprint({ integrityVersion: 1, type, ...value });
}

async function createWorkstream(input = {}) {
  const validated = validateCommand(input, ["jobId", "title", "sequence"]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const title = boundedText(input.title, 200);
  const sequence = positiveInteger(input.sequence);
  if (!jobId || !title || !sequence) {
    return failure(400, "INVALID_WORKSTREAM", "The Workstream is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.CREATE_WORKSTREAM,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.CREATE_WORKSTREAM,
      commandScope: `job:${jobId}:workstreams`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({ jobId, title, sequence }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.CREATE_WORKSTREAM,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId: idempotency.replay.workstream?.id || null,
      });
    }

    const workstreamId = randomUUID();
    await client.query(
      `
      INSERT INTO canonical_workstreams (
        id, job_id, sequence, created_by_participant_id,
        source_evidence_type, source_evidence_reference, idempotency_key
      )
      VALUES ($1, $2, $3, $4, 'workflow_command', $5, $6)
      `,
      [
        workstreamId,
        jobId,
        sequence,
        participantId,
        idempotency.reservation.id,
        validated.idempotencyKey,
      ]
    );
    await client.query(
      `
      INSERT INTO canonical_workstream_versions (
        workstream_id, version, job_id, title, state,
        created_by_participant_id, integrity_hash
      )
      VALUES ($1, 1, $2, $3, 'OPEN', $4, $5)
      `,
      [
        workstreamId,
        jobId,
        title,
        participantId,
        integrityHash("workstream", {
          workstreamId,
          version: 1,
          jobId,
          title,
          state: "OPEN",
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const workstream = workstreamProjection(
      await loadWorkstream(client, jobId, workstreamId)
    );
    const result = commandResult("WORKSTREAM_CREATED", 201, "workstream", workstream);
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Workstream created", {
        code: "WORKSTREAM_CREATED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        sequence,
      }),
    };
  });
}

async function readAuthority(input, capability) {
  const inputError = validateInput(
    input,
    new Set(["pool", "authenticatedActor", "jobId", "workstreamId", "activityId", "obligationId", "logger"])
  );
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return { error: failure(400, "INVALID_JOB_ID", "A valid Job ID is required.") };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const logger = safeLogger(input.logger);
  const authorized = await requireAuthority({
    client: input.pool,
    actorUserId: actor.id,
    jobId,
    capability,
    logger,
  });
  return authorized.error
    ? { error: authorized.error }
    : { actorId: actor.id, jobId, context: authorized.context, logger };
}

async function listWorkstreams(input = {}) {
  const authorized = await readAuthority(input, WORKFLOW_CAPABILITIES.READ_WORKSTREAM);
  if (authorized.error) return authorized.error;
  const result = await input.pool.query(
    `
    SELECT
      workstreams.id, workstreams.job_id, workstreams.sequence,
      workstreams.created_by_participant_id, workstreams.created_at,
      versions.version, versions.title, versions.state,
      versions.created_at AS version_created_at
    FROM canonical_workstreams AS workstreams
    INNER JOIN LATERAL (
      SELECT * FROM canonical_workstream_versions
      WHERE workstream_id = workstreams.id AND job_id = workstreams.job_id
      ORDER BY version DESC LIMIT 1
    ) AS versions ON TRUE
    WHERE workstreams.job_id = $1
    ORDER BY workstreams.sequence ASC, workstreams.created_at ASC, workstreams.id ASC
    `,
    [authorized.jobId]
  );
  return {
    ok: true,
    success: true,
    status: 200,
    code: "WORKSTREAMS_FOUND",
    workstreams: result.rows.map(workstreamProjection),
  };
}

async function getWorkstream(input = {}) {
  const authorized = await readAuthority(input, WORKFLOW_CAPABILITIES.READ_WORKSTREAM);
  if (authorized.error) return authorized.error;
  const workstreamId = normalizedUuid(input.workstreamId);
  if (!workstreamId) {
    return failure(400, "INVALID_WORKSTREAM_ID", "A valid Workstream ID is required.");
  }
  const row = await loadWorkstream(input.pool, authorized.jobId, workstreamId);
  return row
    ? commandResult("WORKSTREAM_FOUND", 200, "workstream", workstreamProjection(row))
    : failure(404, "WORKSTREAM_UNAVAILABLE", "The Workstream is unavailable.");
}

async function assignFindingToWorkstream(input = {}) {
  const validated = validateCommand(input, ["jobId", "workstreamId", "findingId"]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const findingId = normalizedUuid(input.findingId);
  if (!jobId || !workstreamId || !findingId) {
    return failure(400, "INVALID_FINDING_ASSIGNMENT", "The Finding assignment is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.ASSIGN_FINDING,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.ASSIGN_FINDING,
      commandScope: `job:${jobId}:finding:${findingId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({ jobId, workstreamId, findingId }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.ASSIGN_FINDING,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        findingId,
      });
    }

    const workstream = await loadWorkstream(client, jobId, workstreamId, { lock: true });
    if (!workstream) {
      logger.warn("Finding assignment scope mismatch", {
        code: "FINDING_WORKSTREAM_SCOPE_MISMATCH",
        actorUserId: validated.actorId,
        jobId,
        workstreamId,
        findingId,
      });
      return { abort: failure(409, "FINDING_WORKSTREAM_SCOPE_MISMATCH", "The Finding and Workstream scopes do not match.") };
    }
    const finding = await client.query(
      `
      SELECT findings.id, findings.job_id, versions.confirmation_state,
        versions.resolution_state
      FROM canonical_evaluation_findings AS findings
      INNER JOIN LATERAL (
        SELECT confirmation_state, resolution_state
        FROM canonical_evaluation_finding_versions
        WHERE finding_id = findings.id AND job_id = findings.job_id
        ORDER BY version DESC LIMIT 1
      ) AS versions ON TRUE
      WHERE findings.id = $1 AND findings.job_id = $2
      LIMIT 1
      FOR UPDATE OF findings
      `,
      [findingId, jobId]
    );
    if (!finding.rows[0]) {
      logger.warn("Finding assignment scope mismatch", {
        code: "FINDING_WORKSTREAM_SCOPE_MISMATCH",
        actorUserId: validated.actorId,
        jobId,
        workstreamId,
        findingId,
      });
      return { abort: failure(409, "FINDING_WORKSTREAM_SCOPE_MISMATCH", "The Finding and Workstream scopes do not match.") };
    }
    if (finding.rows[0].confirmation_state !== "CONFIRMED") {
      return { abort: failure(409, "FINDING_ASSIGNMENT_NOT_CONFIRMED", "Only a confirmed Finding can be assigned.") };
    }

    const assignment = (await client.query(
      `
      INSERT INTO canonical_finding_workstream_assignments (
        id, finding_id, workstream_id, job_id, assigned_by_participant_id,
        source_evidence_type, source_evidence_reference, idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, 'workflow_command', $6, $7)
      RETURNING *
      `,
      [
        randomUUID(),
        findingId,
        workstreamId,
        jobId,
        participantId,
        idempotency.reservation.id,
        validated.idempotencyKey,
      ]
    )).rows[0];
    await invokeFailure(input.failureInjector, "after_write");
    const result = commandResult("FINDING_ASSIGNED_TO_WORKSTREAM", 201, "assignment", {
      id: assignment.id,
      findingId: assignment.finding_id,
      workstreamId: assignment.workstream_id,
      jobId: assignment.job_id,
      assignedByParticipantId: assignment.assigned_by_participant_id,
      createdAt: assignment.created_at,
    });
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Finding assigned to Workstream", {
        code: "FINDING_ASSIGNED_TO_WORKSTREAM",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        findingId,
      }),
    };
  });
}

async function createWorkActivity(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "workstreamId",
    "activityType",
    "statement",
    "temporaryIntervention",
    "temporaryDetails",
    "customerVisible",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const activityType = String(input.activityType || "").trim().toUpperCase();
  const statement = boundedText(input.statement, 5000);
  const temporaryIntervention = input.temporaryIntervention === true;
  const temporaryDetails = temporaryIntervention
    ? boundedText(input.temporaryDetails, 2000)
    : input.temporaryDetails == null ? null : false;
  const customerVisible = input.customerVisible === true;
  if (
    !jobId ||
    !workstreamId ||
    !ACTIVITY_TYPE_PATTERN.test(activityType) ||
    !statement ||
    (temporaryIntervention && !temporaryDetails) ||
    temporaryDetails === false ||
    (input.customerVisible != null && typeof input.customerVisible !== "boolean")
  ) {
    return failure(400, "INVALID_WORK_ACTIVITY", "The Work Activity is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.CREATE_ACTIVITY,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const workstream = await loadWorkstream(client, jobId, workstreamId, { lock: true });
    if (!workstream || !WORKSTREAM_ACTIVITY_STATES.has(workstream.state)) {
      return { abort: failure(409, "WORKSTREAM_ACTIVITY_CLOSED", "The Workstream cannot accept Activities.") };
    }
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.CREATE_ACTIVITY,
      commandScope: `workstream:${workstreamId}:activities`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        workstreamId,
        activityType,
        statement,
        temporaryIntervention,
        temporaryDetails,
        customerVisible,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.CREATE_ACTIVITY,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        activityId: idempotency.replay.activity?.id || null,
      });
    }

    const activityId = randomUUID();
    await client.query(
      `
      INSERT INTO canonical_work_activities (
        id, workstream_id, job_id, actor_participant_id,
        source_evidence_type, source_evidence_reference, idempotency_key
      )
      VALUES ($1, $2, $3, $4, 'workflow_command', $5, $6)
      `,
      [
        activityId,
        workstreamId,
        jobId,
        participantId,
        idempotency.reservation.id,
        validated.idempotencyKey,
      ]
    );
    await client.query(
      `
      INSERT INTO canonical_work_activity_versions (
        activity_id, version, workstream_id, job_id, activity_type,
        statement, status, temporary_intervention, temporary_details,
        customer_visible, performed_at, created_by_participant_id, integrity_hash
      )
      VALUES ($1, 1, $2, $3, $4, $5, 'PLANNED', $6, $7, $8, NULL, $9, $10)
      `,
      [
        activityId,
        workstreamId,
        jobId,
        activityType,
        statement,
        temporaryIntervention,
        temporaryDetails,
        customerVisible,
        participantId,
        integrityHash("work_activity", {
          activityId,
          version: 1,
          workstreamId,
          jobId,
          activityType,
          statement,
          status: "PLANNED",
          temporaryIntervention,
          temporaryDetails,
          customerVisible,
          performedAt: null,
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const activity = activityProjection(
      await loadActivity(client, jobId, workstreamId, activityId)
    );
    const result = commandResult("WORK_ACTIVITY_CREATED", 201, "activity", activity);
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Work Activity created", {
        code: temporaryIntervention
          ? "TEMPORARY_INTERVENTION_RECORDED"
          : "WORK_ACTIVITY_CREATED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        activityId,
        temporaryIntervention,
      }),
    };
  });
}

async function updateWorkActivity(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "workstreamId",
    "activityId",
    "expectedVersion",
    "statement",
    "customerVisible",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const activityId = normalizedUuid(input.activityId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const statement = boundedText(input.statement, 5000);
  const customerVisible = input.customerVisible === true;
  if (
    !jobId ||
    !workstreamId ||
    !activityId ||
    !expectedVersion ||
    !statement ||
    (input.customerVisible != null && typeof input.customerVisible !== "boolean")
  ) {
    return failure(400, "INVALID_WORK_ACTIVITY_UPDATE", "The Work Activity update is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.PROGRESS_ACTIVITY,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.UPDATE_ACTIVITY,
      commandScope: `activity:${activityId}:update`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        workstreamId,
        activityId,
        expectedVersion,
        statement,
        customerVisible,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.UPDATE_ACTIVITY,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        activityId,
      });
    }

    const current = await loadActivity(
      client,
      jobId,
      workstreamId,
      activityId,
      { lock: true }
    );
    if (!current) {
      return { abort: failure(404, "WORK_ACTIVITY_UNAVAILABLE", "The Work Activity is unavailable.") };
    }
    if (Number(current.version) !== expectedVersion) {
      return { abort: failure(409, "STALE_WORK_ACTIVITY_VERSION", "The Work Activity version is no longer current.") };
    }
    if (!["PLANNED", "IN_PROGRESS"].includes(current.status)) {
      return { abort: failure(409, "WORK_ACTIVITY_UPDATE_CLOSED", "The Work Activity can no longer be updated.") };
    }

    const nextVersion = expectedVersion + 1;
    await client.query(
      `
      INSERT INTO canonical_work_activity_versions (
        activity_id, version, workstream_id, job_id, activity_type,
        statement, status, temporary_intervention, temporary_details,
        customer_visible, performed_at, created_by_participant_id, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        activityId,
        nextVersion,
        workstreamId,
        jobId,
        current.activity_type,
        statement,
        current.status,
        current.temporary_intervention,
        current.temporary_details,
        customerVisible,
        current.performed_at,
        participantId,
        integrityHash("work_activity", {
          activityId,
          version: nextVersion,
          workstreamId,
          jobId,
          activityType: current.activity_type,
          statement,
          status: current.status,
          temporaryIntervention: current.temporary_intervention,
          temporaryDetails: current.temporary_details,
          customerVisible,
          performedAt: current.performed_at?.toISOString?.() || current.performed_at || null,
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const activity = activityProjection(
      await loadActivity(client, jobId, workstreamId, activityId)
    );
    const result = commandResult("WORK_ACTIVITY_UPDATED", 200, "activity", activity);
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Work Activity updated", {
        code: "WORK_ACTIVITY_UPDATED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        activityId,
        version: nextVersion,
        customerVisible,
      }),
    };
  });
}

async function progressWorkActivity(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "workstreamId",
    "activityId",
    "expectedVersion",
    "targetStatus",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const activityId = normalizedUuid(input.activityId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const targetStatus = String(input.targetStatus || "").trim().toUpperCase();
  if (
    !jobId ||
    !workstreamId ||
    !activityId ||
    !expectedVersion ||
    !["IN_PROGRESS", "DONE", "CANCELLED"].includes(targetStatus)
  ) {
    return failure(400, "INVALID_ACTIVITY_PROGRESSION", "The Activity progression is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.PROGRESS_ACTIVITY,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.PROGRESS_ACTIVITY,
      commandScope: `activity:${activityId}:progress`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        workstreamId,
        activityId,
        expectedVersion,
        targetStatus,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.PROGRESS_ACTIVITY,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        activityId,
      });
    }

    const current = await loadActivity(
      client,
      jobId,
      workstreamId,
      activityId,
      { lock: true }
    );
    if (!current) {
      return { abort: failure(404, "WORK_ACTIVITY_UNAVAILABLE", "The Work Activity is unavailable.") };
    }
    if (Number(current.version) !== expectedVersion) {
      return { abort: failure(409, "STALE_WORK_ACTIVITY_VERSION", "The Work Activity version is no longer current.") };
    }
    if (!ACTIVITY_TRANSITIONS[current.status]?.has(targetStatus)) {
      return { abort: failure(409, "INVALID_WORK_ACTIVITY_TRANSITION", "The Work Activity transition is not permitted.") };
    }

    const nextVersion = expectedVersion + 1;
    const performedAt = targetStatus === "DONE" ? new Date() : null;
    await client.query(
      `
      INSERT INTO canonical_work_activity_versions (
        activity_id, version, workstream_id, job_id, activity_type,
        statement, status, temporary_intervention, temporary_details,
        customer_visible, performed_at, created_by_participant_id, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        activityId,
        nextVersion,
        workstreamId,
        jobId,
        current.activity_type,
        current.statement,
        targetStatus,
        current.temporary_intervention,
        current.temporary_details,
        current.customer_visible === true,
        performedAt,
        participantId,
        integrityHash("work_activity", {
          activityId,
          version: nextVersion,
          workstreamId,
          jobId,
          activityType: current.activity_type,
          statement: current.statement,
          status: targetStatus,
          temporaryIntervention: current.temporary_intervention,
          temporaryDetails: current.temporary_details,
          customerVisible: current.customer_visible === true,
          performedAt: performedAt?.toISOString() || null,
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const activity = activityProjection(
      await loadActivity(client, jobId, workstreamId, activityId)
    );
    const result = commandResult("WORK_ACTIVITY_PROGRESSED", 200, "activity", activity);
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Work Activity progressed", {
        code: "WORK_ACTIVITY_PROGRESSED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        activityId,
        version: nextVersion,
        status: targetStatus,
        temporaryIntervention: current.temporary_intervention,
      }),
    };
  });
}

async function listWorkActivities(input = {}) {
  const authorized = await readAuthority(input, WORKFLOW_CAPABILITIES.READ_ACTIVITY);
  if (authorized.error) return authorized.error;
  const workstreamId = normalizedUuid(input.workstreamId);
  if (!workstreamId || !(await loadWorkstream(input.pool, authorized.jobId, workstreamId))) {
    return failure(404, "WORKSTREAM_UNAVAILABLE", "The Workstream is unavailable.");
  }
  const result = await input.pool.query(
    `
    SELECT
      activities.id, activities.workstream_id, activities.job_id,
      activities.actor_participant_id, activities.created_at,
      versions.version, versions.activity_type, versions.statement,
      versions.status, versions.temporary_intervention,
      versions.temporary_details, versions.customer_visible,
      versions.performed_at,
      versions.created_at AS version_created_at
    FROM canonical_work_activities AS activities
    INNER JOIN LATERAL (
      SELECT * FROM canonical_work_activity_versions
      WHERE activity_id = activities.id
        AND workstream_id = activities.workstream_id
        AND job_id = activities.job_id
      ORDER BY version DESC LIMIT 1
    ) AS versions ON TRUE
    WHERE activities.job_id = $1 AND activities.workstream_id = $2
    ORDER BY activities.created_at ASC, activities.id ASC
    `,
    [authorized.jobId, workstreamId]
  );
  return {
    ok: true,
    success: true,
    status: 200,
    code: "WORK_ACTIVITIES_FOUND",
    activities: result.rows.map(activityProjection),
  };
}

async function getWorkActivity(input = {}) {
  const authorized = await readAuthority(input, WORKFLOW_CAPABILITIES.READ_ACTIVITY);
  if (authorized.error) return authorized.error;
  const workstreamId = normalizedUuid(input.workstreamId);
  const activityId = normalizedUuid(input.activityId);
  if (!workstreamId || !activityId) {
    return failure(400, "INVALID_WORK_ACTIVITY_ID", "A valid Work Activity ID is required.");
  }
  const row = await loadActivity(
    input.pool,
    authorized.jobId,
    workstreamId,
    activityId
  );
  return row
    ? commandResult("WORK_ACTIVITY_FOUND", 200, "activity", activityProjection(row))
    : failure(404, "WORK_ACTIVITY_UNAVAILABLE", "The Work Activity is unavailable.");
}

async function createWorkObligation(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "workstreamId",
    "sequence",
    "statement",
    "sourceFindingId",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const sequence = positiveInteger(input.sequence);
  const statement = boundedText(input.statement, 5000);
  const sourceFindingId = input.sourceFindingId == null
    ? null
    : normalizedUuid(input.sourceFindingId);
  if (!jobId || !workstreamId || !sequence || !statement || (input.sourceFindingId != null && !sourceFindingId)) {
    return failure(400, "INVALID_WORK_OBLIGATION", "The Workstream Obligation is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.CREATE_OBLIGATION,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const workstream = await loadWorkstream(client, jobId, workstreamId, { lock: true });
    if (!workstream || !WORKSTREAM_ACTIVITY_STATES.has(workstream.state)) {
      return { abort: failure(409, "WORKSTREAM_OBLIGATION_CLOSED", "The Workstream cannot accept obligations.") };
    }
    if (sourceFindingId) {
      const assignment = await client.query(
        `
        SELECT id
        FROM canonical_finding_workstream_assignments
        WHERE finding_id = $1 AND workstream_id = $2 AND job_id = $3
        LIMIT 1
        `,
        [sourceFindingId, workstreamId, jobId]
      );
      if (!assignment.rows[0]) {
        return { abort: failure(409, "WORK_OBLIGATION_FINDING_SCOPE_MISMATCH", "The obligation Finding is not assigned to this Workstream.") };
      }
    }
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.CREATE_OBLIGATION,
      commandScope: `workstream:${workstreamId}:obligations`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        workstreamId,
        sequence,
        statement,
        sourceFindingId,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.CREATE_OBLIGATION,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        obligationId: idempotency.replay.obligation?.id || null,
      });
    }

    const obligationId = randomUUID();
    await client.query(
      `
      INSERT INTO canonical_workstream_obligations (
        id, workstream_id, job_id, sequence, source_finding_id,
        created_by_participant_id, source_evidence_type,
        source_evidence_reference, idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'workflow_command', $7, $8)
      `,
      [
        obligationId,
        workstreamId,
        jobId,
        sequence,
        sourceFindingId,
        participantId,
        idempotency.reservation.id,
        validated.idempotencyKey,
      ]
    );
    await client.query(
      `
      INSERT INTO canonical_workstream_obligation_versions (
        obligation_id, version, workstream_id, job_id, statement,
        status, created_by_participant_id, integrity_hash
      )
      VALUES ($1, 1, $2, $3, $4, 'OPEN', $5, $6)
      `,
      [
        obligationId,
        workstreamId,
        jobId,
        statement,
        participantId,
        integrityHash("work_obligation", {
          obligationId,
          version: 1,
          workstreamId,
          jobId,
          statement,
          status: "OPEN",
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const obligation = obligationProjection(
      await loadObligation(client, jobId, workstreamId, obligationId)
    );
    const result = commandResult("WORK_OBLIGATION_CREATED", 201, "obligation", obligation);
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Workstream Obligation created", {
        code: "WORK_OBLIGATION_CREATED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        obligationId,
        sourceFindingId,
      }),
    };
  });
}

async function listWorkObligations(input = {}) {
  const authorized = await readAuthority(input, WORKFLOW_CAPABILITIES.READ_OBLIGATION);
  if (authorized.error) return authorized.error;
  const workstreamId = normalizedUuid(input.workstreamId);
  if (!workstreamId || !(await loadWorkstream(input.pool, authorized.jobId, workstreamId))) {
    return failure(404, "WORKSTREAM_UNAVAILABLE", "The Workstream is unavailable.");
  }
  const result = await input.pool.query(
    `
    SELECT
      obligations.id, obligations.workstream_id, obligations.job_id,
      obligations.sequence, obligations.source_finding_id,
      obligations.created_by_participant_id, obligations.created_at,
      versions.version, versions.statement, versions.status,
      versions.created_at AS version_created_at
    FROM canonical_workstream_obligations AS obligations
    INNER JOIN LATERAL (
      SELECT * FROM canonical_workstream_obligation_versions
      WHERE obligation_id = obligations.id
        AND workstream_id = obligations.workstream_id
        AND job_id = obligations.job_id
      ORDER BY version DESC LIMIT 1
    ) AS versions ON TRUE
    WHERE obligations.job_id = $1 AND obligations.workstream_id = $2
    ORDER BY obligations.sequence ASC, obligations.created_at ASC, obligations.id ASC
    `,
    [authorized.jobId, workstreamId]
  );
  return {
    ok: true,
    success: true,
    status: 200,
    code: "WORK_OBLIGATIONS_FOUND",
    obligations: result.rows.map(obligationProjection),
  };
}

async function getWorkObligation(input = {}) {
  const authorized = await readAuthority(input, WORKFLOW_CAPABILITIES.READ_OBLIGATION);
  if (authorized.error) return authorized.error;
  const workstreamId = normalizedUuid(input.workstreamId);
  const obligationId = normalizedUuid(input.obligationId);
  if (!workstreamId || !obligationId) {
    return failure(400, "INVALID_WORK_OBLIGATION_ID", "A valid Workstream Obligation ID is required.");
  }
  const row = await loadObligation(
    input.pool,
    authorized.jobId,
    workstreamId,
    obligationId
  );
  return row
    ? commandResult("WORK_OBLIGATION_FOUND", 200, "obligation", obligationProjection(row))
    : failure(404, "WORK_OBLIGATION_UNAVAILABLE", "The Workstream Obligation is unavailable.");
}

async function loadFindingForResolution(
  client,
  jobId,
  findingId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    SELECT
      findings.id, findings.evaluation_id, findings.job_id,
      findings.author_participant_id, findings.created_at,
      versions.version, versions.evaluation_version, versions.statement,
      versions.confirmation_state, versions.resolution_state,
      versions.customer_visible,
      versions.created_by_participant_id,
      versions.created_at AS version_created_at
    FROM canonical_evaluation_findings AS findings
    INNER JOIN LATERAL (
      SELECT *
      FROM canonical_evaluation_finding_versions
      WHERE finding_id = findings.id AND job_id = findings.job_id
      ORDER BY version DESC
      LIMIT 1
    ) AS versions ON TRUE
    WHERE findings.id = $1 AND findings.job_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF findings" : ""}
    `,
    [findingId, jobId]
  );
  return result.rows[0] || null;
}

function resolvedFindingProjection(row) {
  return {
    id: row.id,
    evaluationId: row.evaluation_id,
    jobId: row.job_id,
    currentVersion: Number(row.version),
    confirmationState: row.confirmation_state,
    resolutionState: row.resolution_state,
    createdAt: row.created_at,
    versionCreatedAt: row.version_created_at,
  };
}

async function resolveFinding(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "findingId",
    "expectedVersion",
    "expectedResolutionState",
    "targetResolutionState",
    "resolutionStatement",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const findingId = normalizedUuid(input.findingId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const expectedResolutionState = String(
    input.expectedResolutionState || ""
  ).trim().toUpperCase();
  const targetResolutionState = String(
    input.targetResolutionState || ""
  ).trim().toUpperCase();
  const resolutionStatement = boundedText(input.resolutionStatement, 5000);
  if (
    !jobId ||
    !findingId ||
    !expectedVersion ||
    !FINDING_RESOLUTION_TRANSITIONS[expectedResolutionState] ||
    !FINDING_RESOLUTION_TRANSITIONS[expectedResolutionState].has(
      targetResolutionState
    ) ||
    !resolutionStatement
  ) {
    return failure(
      400,
      "INVALID_FINDING_RESOLUTION",
      "The Finding resolution command is invalid."
    );
  }
  const logger = safeLogger(input.logger);
  logger.info("Finding resolution attempted", {
    code: "FINDING_RESOLUTION_ATTEMPTED",
    actorUserId: validated.actorId,
    jobId,
    findingId,
    expectedVersion,
    expectedResolutionState,
    targetResolutionState,
  });

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.RESOLVE_FINDING,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.RESOLVE_FINDING,
      commandScope: `finding:${findingId}:resolution`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        findingId,
        expectedVersion,
        expectedResolutionState,
        targetResolutionState,
        resolutionStatement,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.RESOLVE_FINDING,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        findingId,
      });
    }

    const current = await loadFindingForResolution(
      client,
      jobId,
      findingId,
      { lock: true }
    );
    if (!current) {
      logger.warn("Finding resolution scope mismatch", {
        code: "FINDING_RESOLUTION_SCOPE_MISMATCH",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        findingId,
      });
      return {
        abort: failure(404, "FINDING_UNAVAILABLE", "The Finding is unavailable."),
      };
    }
    if (current.confirmation_state !== "CONFIRMED") {
      return {
        abort: failure(
          409,
          "FINDING_RESOLUTION_NOT_CONFIRMED",
          "Only a confirmed Finding can be resolved."
        ),
      };
    }
    if (
      Number(current.version) !== expectedVersion ||
      current.resolution_state !== expectedResolutionState
    ) {
      return {
        abort: failure(
          409,
          "STALE_FINDING_RESOLUTION",
          "The Finding resolution state is no longer current."
        ),
      };
    }
    if (!FINDING_RESOLUTION_TRANSITIONS[current.resolution_state]?.has(
      targetResolutionState
    )) {
      return {
        abort: failure(
          409,
          "INVALID_FINDING_RESOLUTION_TRANSITION",
          "The Finding resolution transition is not permitted."
        ),
      };
    }

    const nextVersion = expectedVersion + 1;
    const findingIntegrity = integrityHash("finding_resolution", {
      findingId,
      version: nextVersion,
      evaluationId: current.evaluation_id,
      evaluationVersion: Number(current.evaluation_version),
      jobId,
      statement: current.statement,
      confirmationState: current.confirmation_state,
      resolutionState: targetResolutionState,
      customerVisible: current.customer_visible === true,
      participantId,
    });
    await client.query(
      `
      INSERT INTO canonical_evaluation_finding_versions (
        finding_id, version, evaluation_id, evaluation_version, job_id,
        statement, confirmation_state, resolution_state,
        customer_visible, created_by_participant_id, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        findingId,
        nextVersion,
        current.evaluation_id,
        Number(current.evaluation_version),
        jobId,
        current.statement,
        current.confirmation_state,
        targetResolutionState,
        current.customer_visible === true,
        participantId,
        findingIntegrity,
      ]
    );
    const eventId = randomUUID();
    await client.query(
      `
      INSERT INTO canonical_finding_resolution_events (
        id, finding_id, previous_finding_version, finding_version, job_id,
        previous_resolution_state, resolution_state, resolution_statement,
        recorded_by_participant_id, source_evidence_type,
        source_evidence_reference, idempotency_key, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        'workflow_command', $10, $11, $12)
      `,
      [
        eventId,
        findingId,
        expectedVersion,
        nextVersion,
        jobId,
        expectedResolutionState,
        targetResolutionState,
        resolutionStatement,
        participantId,
        idempotency.reservation.id,
        validated.idempotencyKey,
        integrityHash("finding_resolution_event", {
          eventId,
          findingId,
          previousFindingVersion: expectedVersion,
          findingVersion: nextVersion,
          jobId,
          previousResolutionState: expectedResolutionState,
          resolutionState: targetResolutionState,
          resolutionStatement,
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const finding = resolvedFindingProjection(
      await loadFindingForResolution(client, jobId, findingId)
    );
    const result = {
      ok: true,
      success: true,
      status: 200,
      code: "FINDING_RESOLUTION_RECORDED",
      finding,
      resolutionEvent: {
        id: eventId,
        findingId,
        previousFindingVersion: expectedVersion,
        findingVersion: nextVersion,
        jobId,
        previousResolutionState: expectedResolutionState,
        resolutionState: targetResolutionState,
      },
    };
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Finding resolution recorded", {
        code: "FINDING_RESOLUTION_RECORDED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        findingId,
        eventId,
        previousFindingVersion: expectedVersion,
        findingVersion: nextVersion,
        previousResolutionState: expectedResolutionState,
        resolutionState: targetResolutionState,
      }),
    };
  });
}

async function transitionWorkObligation(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "workstreamId",
    "obligationId",
    "expectedVersion",
    "targetStatus",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const obligationId = normalizedUuid(input.obligationId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const targetStatus = String(input.targetStatus || "").trim().toUpperCase();
  if (
    !jobId ||
    !workstreamId ||
    !obligationId ||
    !expectedVersion ||
    !OBLIGATION_TRANSITIONS.OPEN.has(targetStatus)
  ) {
    return failure(
      400,
      "INVALID_WORK_OBLIGATION_TRANSITION",
      "The Workstream Obligation transition is invalid."
    );
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.TRANSITION_OBLIGATION,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.TRANSITION_OBLIGATION,
      commandScope: `obligation:${obligationId}:transition`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        workstreamId,
        obligationId,
        expectedVersion,
        targetStatus,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.TRANSITION_OBLIGATION,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        obligationId,
      });
    }

    const current = await loadObligation(
      client,
      jobId,
      workstreamId,
      obligationId,
      { lock: true }
    );
    if (!current) {
      return {
        abort: failure(
          404,
          "WORK_OBLIGATION_UNAVAILABLE",
          "The Workstream Obligation is unavailable."
        ),
      };
    }
    if (Number(current.version) !== expectedVersion) {
      return {
        abort: failure(
          409,
          "STALE_WORK_OBLIGATION_VERSION",
          "The Workstream Obligation version is no longer current."
        ),
      };
    }
    if (!OBLIGATION_TRANSITIONS[current.status]?.has(targetStatus)) {
      return {
        abort: failure(
          409,
          "INVALID_WORK_OBLIGATION_TRANSITION",
          "The Workstream Obligation transition is not permitted."
        ),
      };
    }
    const nextVersion = expectedVersion + 1;
    await client.query(
      `
      INSERT INTO canonical_workstream_obligation_versions (
        obligation_id, version, workstream_id, job_id, statement,
        status, created_by_participant_id, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        obligationId,
        nextVersion,
        workstreamId,
        jobId,
        current.statement,
        targetStatus,
        participantId,
        integrityHash("work_obligation", {
          obligationId,
          version: nextVersion,
          workstreamId,
          jobId,
          statement: current.statement,
          status: targetStatus,
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const obligation = obligationProjection(
      await loadObligation(client, jobId, workstreamId, obligationId)
    );
    const result = commandResult(
      "WORK_OBLIGATION_TRANSITIONED",
      200,
      "obligation",
      obligation
    );
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Workstream Obligation transitioned", {
        code: "WORK_OBLIGATION_TRANSITIONED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        obligationId,
        version: nextVersion,
        status: targetStatus,
      }),
    };
  });
}

async function calculateCompletionEligibility(client, jobId, workstreamId) {
  const workstream = await loadWorkstream(client, jobId, workstreamId);
  if (!workstream) return null;
  const result = await client.query(
    `
    WITH latest_findings AS (
      SELECT DISTINCT ON (versions.finding_id)
        versions.finding_id, versions.confirmation_state,
        versions.resolution_state
      FROM canonical_finding_workstream_assignments AS assignments
      INNER JOIN canonical_evaluation_finding_versions AS versions
        ON versions.finding_id = assignments.finding_id
        AND versions.job_id = assignments.job_id
      WHERE assignments.workstream_id = $1 AND assignments.job_id = $2
      ORDER BY versions.finding_id, versions.version DESC
    ), latest_obligations AS (
      SELECT DISTINCT ON (versions.obligation_id)
        versions.obligation_id, versions.status
      FROM canonical_workstream_obligations AS obligations
      INNER JOIN canonical_workstream_obligation_versions AS versions
        ON versions.obligation_id = obligations.id
        AND versions.workstream_id = obligations.workstream_id
        AND versions.job_id = obligations.job_id
      WHERE obligations.workstream_id = $1 AND obligations.job_id = $2
      ORDER BY versions.obligation_id, versions.version DESC
    ), latest_activities AS (
      SELECT DISTINCT ON (versions.activity_id)
        versions.activity_id, versions.status
      FROM canonical_work_activities AS activities
      INNER JOIN canonical_work_activity_versions AS versions
        ON versions.activity_id = activities.id
        AND versions.workstream_id = activities.workstream_id
        AND versions.job_id = activities.job_id
      WHERE activities.workstream_id = $1 AND activities.job_id = $2
      ORDER BY versions.activity_id, versions.version DESC
    )
    SELECT
      (SELECT count(*) FROM latest_findings
        WHERE confirmation_state = 'CONFIRMED'
          AND resolution_state = 'OPEN')::integer AS open_findings,
      (SELECT count(*) FROM latest_findings
        WHERE confirmation_state = 'CONFIRMED'
          AND resolution_state = 'PARTIALLY_RESOLVED')::integer
        AS partial_findings,
      (SELECT count(*) FROM latest_findings
        WHERE confirmation_state = 'CONFIRMED'
          AND resolution_state = 'DEFERRED')::integer AS deferred_findings,
      (SELECT count(*) FROM latest_obligations
        WHERE status = 'OPEN')::integer AS open_obligations,
      (SELECT count(*) FROM latest_obligations
        WHERE status IN ('DEFERRED', 'EXCLUDED'))::integer
        AS deferred_or_excluded_obligations,
      (SELECT count(*) FROM latest_activities
        WHERE status IN ('PLANNED', 'IN_PROGRESS'))::integer
        AS active_activities
    `,
    [workstreamId, jobId]
  );
  const counts = result.rows[0];
  const reasons = [];
  if (!["OPEN", "ACTIVE"].includes(workstream.state)) {
    reasons.push("INELIGIBLE_WORKSTREAM_STATE");
  }
  if (counts.open_findings > 0) reasons.push("OPEN_FINDING");
  if (counts.partial_findings > 0) reasons.push("PARTIAL_FINDING");
  if (counts.open_obligations > 0) reasons.push("OPEN_OBLIGATION");
  if (counts.active_activities > 0) reasons.push("ACTIVE_ACTIVITY");
  return {
    eligible: reasons.length === 0,
    reasons,
    workstreamId,
    jobId,
    workstreamState: workstream.state,
    workstreamVersion: Number(workstream.version),
    blockers: {
      openFindings: counts.open_findings,
      partialFindings: counts.partial_findings,
      openObligations: counts.open_obligations,
      activeActivities: counts.active_activities,
    },
    deferredScope: {
      findings: counts.deferred_findings,
      obligations: counts.deferred_or_excluded_obligations,
    },
  };
}

async function getWorkstreamCompletionEligibility(input = {}) {
  const authorized = await readAuthority(
    input,
    WORKFLOW_CAPABILITIES.READ_WORKSTREAM
  );
  if (authorized.error) return authorized.error;
  const workstreamId = normalizedUuid(input.workstreamId);
  if (!workstreamId) {
    return failure(
      400,
      "INVALID_WORKSTREAM_ID",
      "A valid Workstream ID is required."
    );
  }
  const eligibility = await calculateCompletionEligibility(
    input.pool,
    authorized.jobId,
    workstreamId
  );
  return eligibility
    ? {
      ok: true,
      success: true,
      status: 200,
      code: "WORKSTREAM_COMPLETION_ELIGIBILITY_FOUND",
      eligibility,
    }
    : failure(404, "WORKSTREAM_UNAVAILABLE", "The Workstream is unavailable.");
}

async function completeWorkstream(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "workstreamId",
    "expectedVersion",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const workstreamId = normalizedUuid(input.workstreamId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  if (!jobId || !workstreamId || !expectedVersion) {
    return failure(
      400,
      "INVALID_WORKSTREAM_COMPLETION",
      "The Workstream completion command is invalid."
    );
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: WORKFLOW_CAPABILITIES.COMPLETE_WORKSTREAM,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: WORKFLOW_COMMANDS.COMPLETE_WORKSTREAM,
      commandScope: `workstream:${workstreamId}:completion`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({ jobId, workstreamId, expectedVersion }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: WORKFLOW_COMMANDS.COMPLETE_WORKSTREAM,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
      });
    }

    const current = await loadWorkstream(client, jobId, workstreamId, {
      lock: true,
    });
    if (!current) {
      return {
        abort: failure(404, "WORKSTREAM_UNAVAILABLE", "The Workstream is unavailable."),
      };
    }
    if (Number(current.version) !== expectedVersion) {
      return {
        abort: failure(
          409,
          "STALE_WORKSTREAM_VERSION",
          "The Workstream version is no longer current."
        ),
      };
    }
    const eligibility = await calculateCompletionEligibility(
      client,
      jobId,
      workstreamId
    );
    if (!eligibility.eligible) {
      logger.warn("Workstream completion eligibility rejected", {
        code: "WORKSTREAM_COMPLETION_INELIGIBLE",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        reasons: eligibility.reasons,
      });
      return {
        abort: {
          ...failure(
            409,
            "WORKSTREAM_COMPLETION_INELIGIBLE",
            "The Workstream is not eligible for completion."
          ),
          reasons: eligibility.reasons,
          eligibility,
        },
      };
    }

    const nextVersion = expectedVersion + 1;
    await client.query(
      `
      INSERT INTO canonical_workstream_versions (
        workstream_id, version, job_id, title, state,
        created_by_participant_id, integrity_hash
      )
      VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6)
      `,
      [
        workstreamId,
        nextVersion,
        jobId,
        current.title,
        participantId,
        integrityHash("workstream", {
          workstreamId,
          version: nextVersion,
          jobId,
          title: current.title,
          state: "COMPLETED",
          participantId,
        }),
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const workstream = workstreamProjection(
      await loadWorkstream(client, jobId, workstreamId)
    );
    const result = {
      ...commandResult(
        "WORKSTREAM_COMPLETED",
        200,
        "workstream",
        workstream
      ),
      eligibility,
    };
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Workstream completed", {
        code: "WORKSTREAM_COMPLETED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        workstreamId,
        version: nextVersion,
      }),
    };
  });
}

module.exports = {
  ACTIVITY_TRANSITIONS,
  FINDING_RESOLUTION_TRANSITIONS,
  OBLIGATION_TRANSITIONS,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_COMMANDS,
  assignFindingToWorkstream,
  completeWorkstream,
  createWorkActivity,
  createWorkObligation,
  createWorkstream,
  getWorkActivity,
  getWorkObligation,
  getWorkstream,
  getWorkstreamCompletionEligibility,
  listWorkActivities,
  listWorkObligations,
  listWorkstreams,
  progressWorkActivity,
  resolveFinding,
  transitionWorkObligation,
  updateWorkActivity,
};
