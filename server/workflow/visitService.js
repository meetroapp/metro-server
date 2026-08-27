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
  fingerprint,
  isPlainObject,
  normalizedUuid,
  positiveInteger,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

const VISIT_CAPABILITIES = Object.freeze({
  READ: "visit.read",
  PROPOSE: "visit.propose",
  CONFIRM: "visit.confirm",
  CHANGE_REQUEST: "visit.change_request",
  RESCHEDULE: "visit.reschedule",
  CANCEL: "visit.cancel",
  COMPLETE: "visit.complete",
});

const VISIT_COMMANDS = Object.freeze({
  PROPOSE: "visit.propose",
  CONFIRM: "visit.confirm",
  CHANGE_REQUEST: "visit.change_request",
  RESCHEDULE: "visit.reschedule",
  CANCEL: "visit.cancel",
  COMPLETE: "visit.complete",
  LINK_EVALUATION: "visit.link_evaluation",
});

const VISIT_PURPOSES = Object.freeze([
  "EVALUATION",
  "APPROVED_WORK",
  "FOLLOW_UP",
]);
const VISIT_STATES = Object.freeze([
  "PROPOSED",
  "SCHEDULED",
  "CANCELLED",
  "COMPLETED",
]);
const VISIT_LOCATION_MODES = Object.freeze([
  "JOB_SERVICE_LOCATION",
  "REMOTE",
]);
const ACTIVE_VISIT_STATES = new Set(["PROPOSED", "SCHEDULED"]);
const MAX_WORKSTREAM_LINKS = 50;
const OFFSET_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SUPPORTED_TIME_ZONES = new Set([
  "UTC",
  ...(typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : []),
]);

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function boundedText(value, maximum, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function strictInstant(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  const match = OFFSET_INSTANT_PATTERN.exec(normalized);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00",
    fractionText = "", offsetText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const millisecond = Number(fractionText.padEnd(3, "0") || 0);
  const calendar = new Date(Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond
  ));
  const calendarValid =
    month >= 1 &&
    month <= 12 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
  if (!calendarValid) return null;
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function canonicalTimeZone(value) {
  if (typeof value !== "string") return null;
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > 100) return null;
  if (SUPPORTED_TIME_ZONES.size > 1) {
    return SUPPORTED_TIME_ZONES.has(timeZone) ? timeZone : null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone === "UTC" || timeZone.includes("/") ? timeZone : null;
  } catch {
    return null;
  }
}

function normalizedSchedule(input) {
  const scheduledStartAt = strictInstant(input.scheduledStartAt);
  const scheduledEndAt = input.scheduledEndAt == null
    ? null
    : strictInstant(input.scheduledEndAt);
  const timeZone = canonicalTimeZone(input.timeZone);
  const locationMode = VISIT_LOCATION_MODES.includes(input.locationMode)
    ? input.locationMode
    : null;
  if (
    !scheduledStartAt ||
    (input.scheduledEndAt != null && !scheduledEndAt) ||
    (scheduledEndAt && Date.parse(scheduledEndAt) <= Date.parse(scheduledStartAt)) ||
    !timeZone ||
    !locationMode
  ) {
    return null;
  }
  return {
    scheduledStartAt,
    scheduledEndAt,
    timeZone,
    locationMode,
  };
}

function normalizedWorkstreamIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_WORKSTREAM_LINKS) return null;
  const normalized = value.map(normalizedUuid);
  if (normalized.some((id) => !id) || new Set(normalized).size !== normalized.length) {
    return null;
  }
  return normalized.sort();
}

function validateInput(input, allowedFields) {
  if (!isPlainObject(input)) {
    return failure(400, "INVALID_VISIT_COMMAND", "The Visit operation is invalid.");
  }
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    return failure(
      400,
      "VISIT_AUTHORITY_FIELD_REJECTED",
      "Server-owned Visit fields cannot be supplied."
    );
  }
  return null;
}

function validateVisitIdempotencyKey(value) {
  const idempotencyKey = typeof value === "string" ? value.trim() : "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return {
      error: failure(
        400,
        "INVALID_VISIT_IDEMPOTENCY_KEY",
        "A valid Visit idempotency key is required."
      ),
    };
  }
  return { idempotencyKey };
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
      "clock",
      ...fields,
    ])
  );
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const idempotency = validateVisitIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  return { actorId: actor.id, idempotencyKey: idempotency.idempotencyKey };
}

function currentInstant(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("The Visit clock must return a valid instant.");
  }
  return parsed;
}

function iso(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function integrityHash(kind, value) {
  return createHash("sha256")
    .update(JSON.stringify({ kind, ...value }))
    .digest("hex");
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

async function invokeFailure(injector, stage) {
  if (typeof injector === "function") await injector(stage);
}

async function loadJobContext(client, jobId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    /* visit:job_context */
    SELECT
      jobs.id AS job_id,
      jobs.lifecycle_contract_version,
      relationships.status AS relationship_status,
      relationships.homeowner_id AS homeowner_user_id,
      relationships.professional_user_id AS selected_professional_user_id,
      participants.id AS actor_participant_id,
      participants.user_id AS actor_user_id,
      evaluation_subjects.evaluation_id AS canonical_evaluation_id,
      evaluation_subject_status.status AS canonical_evaluation_status,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'CUSTOMER_REPRESENTATIVE'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_customer_representative,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_primary_professional,
      ARRAY(
        SELECT grants.capability
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.scope_evaluation_id IS NULL
          AND grants.capability = ANY($3::text[])
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
        ORDER BY grants.capability
      ) AS active_job_visit_capabilities,
      ARRAY(
        SELECT grants.capability
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'evaluation'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.scope_evaluation_id = evaluation_subjects.evaluation_id
          AND grants.capability = ANY($3::text[])
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
        ORDER BY grants.capability
      ) AS active_evaluation_visit_capabilities,
      ARRAY(
        SELECT grants.capability
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'evaluation_visit'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.scope_evaluation_id IS NULL
          AND grants.scope_approved_quote_decision_id IS NULL
          AND grants.scope_approved_quote_decision IS NULL
          AND grants.capability = ANY($3::text[])
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
        ORDER BY grants.capability
      ) AS active_job_evaluation_visit_capabilities,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'decisionId', grants.scope_approved_quote_decision_id,
            'capability', grants.capability
          )
          ORDER BY grants.scope_approved_quote_decision_id, grants.capability
        )
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'approved_work'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.scope_evaluation_id IS NULL
          AND grants.scope_approved_quote_decision_id IS NOT NULL
          AND grants.scope_approved_quote_decision = 'APPROVED'
          AND grants.capability = ANY($3::text[])
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ), '[]'::jsonb) AS active_approved_work_visit_capabilities
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
    INNER JOIN relationship_participants participants
      ON participants.job_id = jobs.id
      AND participants.request_relationship_id = relationships.id
      AND participants.user_id = $2
    LEFT JOIN canonical_evaluation_job_subjects evaluation_subjects
      ON evaluation_subjects.job_id = jobs.id
    LEFT JOIN canonical_evaluations evaluation_subject_status
      ON evaluation_subject_status.id = evaluation_subjects.evaluation_id
    WHERE jobs.id = $1
      AND jobs.lifecycle_contract_version = 2
    LIMIT 1
    ${lock ? "FOR UPDATE OF jobs, relationships" : ""}
    `,
    [jobId, actorUserId, Object.values(VISIT_CAPABILITIES)]
  );
  return result.rows[0] || null;
}

function actorRole(context) {
  const actorUserId = Number(context?.actor_user_id);
  if (
    context?.actor_is_customer_representative === true &&
    Number(context.homeowner_user_id) === actorUserId
  ) {
    return "CUSTOMER";
  }
  if (
    context?.actor_is_primary_professional === true &&
    Number(context.selected_professional_user_id) === actorUserId
  ) {
    return "PROFESSIONAL";
  }
  return null;
}

async function requireActorRole({
  client,
  actorUserId,
  jobId,
  requiredRole,
  logger,
  lock = false,
}) {
  const context = await loadJobContext(client, jobId, actorUserId, { lock });
  if (!context) {
    return {
      error: failure(404, "VISIT_UNAVAILABLE", "The Visit authority is unavailable."),
    };
  }
  const role = actorRole(context);
  if (!role || (requiredRole !== "EITHER" && role !== requiredRole)) {
    logger.warn("Visit role authority denied", {
      code: "VISIT_ROLE_AUTHORITY_DENIED",
      actorUserId,
      jobId,
    });
    return {
      error: failure(403, "VISIT_AUTHORITY_REQUIRED", "Visit authority is required."),
    };
  }
  return { context, role };
}

async function requireAuthority({
  client,
  actorUserId,
  jobId,
  capability,
  requiredRole,
  logger,
  lock = false,
  evaluationId = null,
  approvedQuoteDecisionId = null,
  allowJobScope = true,
  allowEvaluationVisitScope = false,
}) {
  const authorized = await requireActorRole({
    client,
    actorUserId,
    jobId,
    requiredRole,
    logger,
    lock,
  });
  if (authorized.error) return authorized;
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: authorized.context.actor_participant_id,
    capability,
    jobId,
    evaluationId,
    approvedQuoteDecisionId,
    allowJobScope,
    allowEvaluationVisitScope,
    logger,
  });
  if (!granted) {
    logger.warn("Visit capability authority denied", {
      code: "VISIT_CAPABILITY_AUTHORITY_DENIED",
      actorUserId,
      participantId: authorized.context.actor_participant_id,
      jobId,
      capability,
    });
    return {
      error: failure(403, "VISIT_AUTHORITY_REQUIRED", "Visit authority is required."),
    };
  }
  return authorized;
}

function activeCapabilities(context, row = null) {
  const capabilities = new Set(
    row?.purpose === "APPROVED_WORK"
      ? []
      : context?.active_job_visit_capabilities || context?.active_visit_capabilities || []
  );
  if (!row || row.purpose === "EVALUATION") {
    for (const capability of
      context?.active_job_evaluation_visit_capabilities || []) {
      capabilities.add(capability);
    }
  }
  if (
    row?.purpose === "EVALUATION" &&
    row.evaluation_id &&
    row.evaluation_id === context?.canonical_evaluation_id
  ) {
    for (const capability of context.active_evaluation_visit_capabilities || []) {
      capabilities.add(capability);
    }
  }
  if (row?.purpose === "APPROVED_WORK" && row.approved_quote_decision_id) {
    for (const grant of context?.active_approved_work_visit_capabilities || []) {
      if (grant.decisionId === row.approved_quote_decision_id) {
        capabilities.add(grant.capability);
      }
    }
  }
  return capabilities;
}

function visitActions(context, row, now = new Date()) {
  const role = actorRole(context);
  const capabilities = activeCapabilities(context, row);
  const state = row.state;
  return {
    canConfirm:
      (role === "CUSTOMER" || role === "PROFESSIONAL") &&
      state === "PROPOSED" &&
      row.recorded_by_participant_id !== context?.actor_participant_id &&
      capabilities.has(VISIT_CAPABILITIES.CONFIRM),
    canRequestChange:
      role === "CUSTOMER" &&
      ACTIVE_VISIT_STATES.has(state) &&
      capabilities.has(VISIT_CAPABILITIES.CHANGE_REQUEST),
    canReschedule:
      role === "PROFESSIONAL" &&
      ACTIVE_VISIT_STATES.has(state) &&
      capabilities.has(VISIT_CAPABILITIES.RESCHEDULE),
    canCancel:
      role === "PROFESSIONAL" &&
      ACTIVE_VISIT_STATES.has(state) &&
      capabilities.has(VISIT_CAPABILITIES.CANCEL),
    canComplete:
      role === "PROFESSIONAL" &&
      state === "SCHEDULED" &&
      Date.parse(row.scheduled_start_at) <= now.getTime() &&
      capabilities.has(VISIT_CAPABILITIES.COMPLETE),
  };
}

function visitProjection(row, context, now) {
  return {
    id: row.id,
    jobId: row.job_id,
    purpose: row.purpose,
    state: row.state,
    currentVersion: Number(row.version),
    scheduledStartAt: iso(row.scheduled_start_at),
    scheduledEndAt: iso(row.scheduled_end_at),
    timeZone: row.time_zone,
    locationMode: row.location_mode,
    cancellationReason: row.cancellation_reason,
    cancelledAt: iso(row.cancelled_at),
    completedAt: iso(row.completed_at),
    evaluationId: row.evaluation_id || null,
    workstreamIds: (row.workstream_ids || []).map(String),
    approvedQuoteDecisionEvidence: row.approved_quote_decision_id
      ? {
          decisionId: row.approved_quote_decision_id,
          decision: row.approved_quote_decision,
        }
      : null,
    createdByParticipantId: row.created_by_participant_id,
    recordedByParticipantId: row.recorded_by_participant_id,
    createdAt: iso(row.created_at),
    versionCreatedAt: iso(row.version_created_at),
    actions: visitActions(context, row, now),
  };
}

function visitVersionProjection(row) {
  return {
    version: Number(row.version),
    state: row.state,
    scheduledStartAt: iso(row.scheduled_start_at),
    scheduledEndAt: iso(row.scheduled_end_at),
    timeZone: row.time_zone,
    locationMode: row.location_mode,
    cancellationReason: row.cancellation_reason,
    cancelledAt: iso(row.cancelled_at),
    completedAt: iso(row.completed_at),
    recordedByParticipantId: row.recorded_by_participant_id,
    createdAt: iso(row.created_at),
  };
}

function visitEventProjection(row) {
  return {
    id: row.id,
    type: row.event_type,
    visitVersion: Number(row.visit_version),
    previousVisitVersion: row.previous_visit_version == null
      ? null
      : Number(row.previous_visit_version),
    visitState: row.visit_state,
    reason: row.reason,
    recordedByParticipantId: row.recorded_by_participant_id,
    createdAt: iso(row.created_at),
  };
}

async function loadVisit(client, jobId, visitId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT
      visits.id, visits.job_id, visits.purpose,
      visits.created_by_participant_id,
      visits.approved_quote_decision_id,
      visits.approved_quote_decision,
      visits.created_at,
      versions.version, versions.state,
      versions.scheduled_start_at, versions.scheduled_end_at,
      versions.time_zone, versions.location_mode,
      versions.cancellation_reason, versions.cancelled_at,
      versions.completed_at, versions.recorded_by_participant_id,
      versions.created_at AS version_created_at,
      evaluation_links.evaluation_id,
      COALESCE(workstream_links.workstream_ids, ARRAY[]::uuid[]) AS workstream_ids
    FROM canonical_visits visits
    INNER JOIN LATERAL (
      SELECT
        version, state, scheduled_start_at, scheduled_end_at,
        time_zone, location_mode, cancellation_reason, cancelled_at,
        completed_at, recorded_by_participant_id, created_at
      FROM canonical_visit_versions
      WHERE visit_id = visits.id AND job_id = visits.job_id
      ORDER BY version DESC
      LIMIT 1
    ) versions ON TRUE
    LEFT JOIN canonical_visit_evaluation_links evaluation_links
      ON evaluation_links.visit_id = visits.id
      AND evaluation_links.job_id = visits.job_id
    LEFT JOIN LATERAL (
      SELECT array_agg(links.workstream_id ORDER BY links.created_at, links.workstream_id)
        AS workstream_ids
      FROM canonical_visit_workstream_links links
      WHERE links.visit_id = visits.id AND links.job_id = visits.job_id
    ) workstream_links ON TRUE
    WHERE visits.id = $1 AND visits.job_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF visits" : ""}
    `,
    [visitId, jobId]
  );
  return result.rows[0] || null;
}

async function loadVisitHistory(client, jobId, visitId) {
  const [versions, events] = await Promise.all([
    client.query(
      `SELECT version, state, scheduled_start_at, scheduled_end_at,
        time_zone, location_mode, cancellation_reason, cancelled_at,
        completed_at, recorded_by_participant_id, created_at
       FROM canonical_visit_versions
       WHERE visit_id = $1 AND job_id = $2
       ORDER BY version ASC`,
      [visitId, jobId]
    ),
    client.query(
      `SELECT id, event_type, visit_version, previous_visit_version,
        visit_state, reason, recorded_by_participant_id, created_at
       FROM canonical_visit_events
       WHERE visit_id = $1 AND job_id = $2
       ORDER BY created_at ASC, id ASC`,
      [visitId, jobId]
    ),
  ]);
  return {
    versions: versions.rows.map(visitVersionProjection),
    events: events.rows.map(visitEventProjection),
  };
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
    INSERT INTO canonical_visit_command_idempotency (
      id, actor_participant_id, job_id, command_name,
      command_scope, idempotency_key, request_fingerprint
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
    `SELECT *
     FROM canonical_visit_command_idempotency
     WHERE actor_participant_id = $1
       AND command_name = $2
       AND command_scope = $3
       AND idempotency_key = $4
     LIMIT 1
     FOR UPDATE`,
    [participantId, commandName, commandScope, idempotencyKey]
  );
  const reservation = existing.rows[0];
  if (!reservation || reservation.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "VISIT_IDEMPOTENCY_KEY_CONFLICT",
        "The idempotency key was already used for a different Visit command."
      ),
    };
  }
  if (!reservation.result_reference || !reservation.completed_at) {
    return {
      error: failure(
        409,
        "VISIT_COMMAND_IN_PROGRESS",
        "The Visit command is still being completed."
      ),
    };
  }
  return { reservation, replay: reservation.result_reference };
}

async function completeCommand(client, reservationId, result) {
  const completed = await client.query(
    `UPDATE canonical_visit_command_idempotency
     SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND result_reference IS NULL
       AND completed_at IS NULL
     RETURNING id`,
    [reservationId, JSON.stringify(result)]
  );
  if (!completed.rows[0]) {
    throw new Error("Visit command idempotency completion failed.");
  }
}

function replayOutcome(replay, logger, context) {
  return {
    result: { ...replay, replayed: true },
    afterCommit: () => logger.info("Visit command replayed", {
      code: "VISIT_COMMAND_REPLAYED",
      ...context,
    }),
  };
}

function commandResult(code, status, visit, extra = {}) {
  return {
    ok: true,
    success: true,
    status,
    code,
    visit,
    ...extra,
  };
}

function validateReadRequest(input = {}) {
  const inputError = validateInput(
    input,
    new Set(["pool", "authenticatedActor", "jobId", "visitId", "logger", "clock"])
  );
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return {
      error: failure(400, "INVALID_JOB_ID", "A valid Job ID is required."),
    };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  return {
    actorId: actor.id,
    jobId,
    logger: safeLogger(input.logger),
  };
}

async function authorizeRead(client, validated) {
  const authorized = await requireActorRole({
    client,
    actorUserId: validated.actorId,
    jobId: validated.jobId,
    requiredRole: "EITHER",
    logger: validated.logger,
  });
  if (authorized.error) return { error: authorized.error };
  const hasRead =
    activeCapabilities(authorized.context).has(VISIT_CAPABILITIES.READ) ||
    (authorized.context.active_approved_work_visit_capabilities || [])
      .some((grant) => grant.capability === VISIT_CAPABILITIES.READ);
  return hasRead
    ? {
        actorId: validated.actorId,
        jobId: validated.jobId,
        context: authorized.context,
        role: authorized.role,
        logger: validated.logger,
      }
    : { error: failure(403, "VISIT_AUTHORITY_REQUIRED", "Visit authority is required.") };
}

function validateEvaluationReadRequest(input = {}) {
  const inputError = validateInput(
    input,
    new Set([
      "pool",
      "authenticatedActor",
      "jobId",
      "evaluationId",
      "visitId",
      "logger",
      "clock",
    ])
  );
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const jobId = normalizedUuid(input.jobId);
  const evaluationId = normalizedUuid(input.evaluationId);
  if (!jobId || !evaluationId) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_VISIT_SUBJECT",
        "A valid Job and Evaluation are required."
      ),
    };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  return {
    actorId: actor.id,
    jobId,
    evaluationId,
    logger: safeLogger(input.logger),
  };
}

async function authorizeEvaluationRead(client, validated) {
  const authorized = await requireAuthority({
    client,
    actorUserId: validated.actorId,
    jobId: validated.jobId,
    capability: VISIT_CAPABILITIES.READ,
    requiredRole: "EITHER",
    logger: validated.logger,
    evaluationId: validated.evaluationId,
    allowJobScope: false,
    allowEvaluationVisitScope: true,
  });
  if (
    authorized.error ||
    authorized.context.canonical_evaluation_id !== validated.evaluationId
  ) {
    return {
      error: authorized.error || failure(
        404,
        "VISIT_UNAVAILABLE",
        "The Visit authority is unavailable."
      ),
    };
  }
  return {
    actorId: validated.actorId,
    jobId: validated.jobId,
    evaluationId: validated.evaluationId,
    context: authorized.context,
    role: authorized.role,
    logger: validated.logger,
  };
}

async function listEvaluationVisits(input = {}) {
  const validated = validateEvaluationReadRequest(input);
  if (validated.error) return validated.error;
  return runReadTransaction(input.pool, async (client) => {
    const authorized = await authorizeEvaluationRead(client, validated);
    if (authorized.error) return authorized.error;
    const result = await client.query(
      `SELECT visits.id
       FROM canonical_visits visits
       INNER JOIN canonical_visit_evaluation_links evaluation_links
         ON evaluation_links.visit_id = visits.id
         AND evaluation_links.job_id = visits.job_id
       WHERE visits.job_id = $1
         AND visits.purpose = 'EVALUATION'
         AND evaluation_links.evaluation_id = $2
       ORDER BY visits.created_at ASC, visits.id ASC`,
      [authorized.jobId, authorized.evaluationId]
    );
    const rows = [];
    for (const item of result.rows) {
      const row = await loadVisit(client, authorized.jobId, item.id);
      if (row) rows.push(row);
    }
    const now = currentInstant(input.clock);
    return {
      ok: true,
      success: true,
      status: 200,
      code: "EVALUATION_VISITS_FOUND",
      visits: rows.map((row) => visitProjection(row, authorized.context, now)),
      actions: {
        canProposeEvaluationVisit:
          authorized.role === "PROFESSIONAL" &&
          authorized.context.canonical_evaluation_status === "draft" &&
          activeCapabilities(authorized.context, {
            purpose: "EVALUATION",
            evaluation_id: authorized.evaluationId,
          }).has(VISIT_CAPABILITIES.PROPOSE),
      },
    };
  });
}

async function getEvaluationVisit(input = {}) {
  const validated = validateEvaluationReadRequest(input);
  if (validated.error) return validated.error;
  const visitId = normalizedUuid(input.visitId);
  if (!visitId) {
    return failure(400, "INVALID_VISIT_ID", "A valid Visit ID is required.");
  }
  return runReadTransaction(input.pool, async (client) => {
    const authorized = await authorizeEvaluationRead(client, validated);
    if (authorized.error) return authorized.error;
    const row = await loadVisit(client, authorized.jobId, visitId);
    if (
      !row ||
      row.purpose !== "EVALUATION" ||
      row.evaluation_id !== authorized.evaluationId
    ) {
      return failure(404, "VISIT_UNAVAILABLE", "The Visit is unavailable.");
    }
    const history = await loadVisitHistory(client, authorized.jobId, visitId);
    return commandResult(
      "EVALUATION_VISIT_FOUND",
      200,
      {
        ...visitProjection(row, authorized.context, currentInstant(input.clock)),
        history,
      }
    );
  });
}

async function listVisits(input = {}) {
  const validated = validateReadRequest(input);
  if (validated.error) return validated.error;
  return runReadTransaction(input.pool, async (client) => {
    const authorized = await authorizeRead(client, validated);
    if (authorized.error) return authorized.error;
    const result = await client.query(
      `
      SELECT
        visits.id, visits.job_id, visits.purpose,
        visits.created_by_participant_id,
        visits.approved_quote_decision_id,
        visits.approved_quote_decision,
        visits.created_at,
        versions.version, versions.state,
        versions.scheduled_start_at, versions.scheduled_end_at,
        versions.time_zone, versions.location_mode,
        versions.cancellation_reason, versions.cancelled_at,
        versions.completed_at, versions.recorded_by_participant_id,
        versions.created_at AS version_created_at,
        evaluation_links.evaluation_id,
        COALESCE(workstream_links.workstream_ids, ARRAY[]::uuid[]) AS workstream_ids
      FROM canonical_visits visits
      INNER JOIN LATERAL (
        SELECT
          version, state, scheduled_start_at, scheduled_end_at,
          time_zone, location_mode, cancellation_reason, cancelled_at,
          completed_at, recorded_by_participant_id, created_at
        FROM canonical_visit_versions
        WHERE visit_id = visits.id AND job_id = visits.job_id
        ORDER BY version DESC
        LIMIT 1
      ) versions ON TRUE
      LEFT JOIN canonical_visit_evaluation_links evaluation_links
        ON evaluation_links.visit_id = visits.id
        AND evaluation_links.job_id = visits.job_id
      LEFT JOIN LATERAL (
        SELECT array_agg(links.workstream_id ORDER BY links.created_at, links.workstream_id)
          AS workstream_ids
        FROM canonical_visit_workstream_links links
        WHERE links.visit_id = visits.id AND links.job_id = visits.job_id
      ) workstream_links ON TRUE
      WHERE visits.job_id = $1
      ORDER BY versions.scheduled_start_at ASC, visits.created_at ASC, visits.id ASC
      `,
      [authorized.jobId]
    );
    const now = currentInstant(input.clock);
    return {
      ok: true,
      success: true,
      status: 200,
      code: "VISITS_FOUND",
      visits: result.rows
        .filter((row) =>
          activeCapabilities(authorized.context, row).has(VISIT_CAPABILITIES.READ)
        )
        .map((row) => visitProjection(row, authorized.context, now)),
      actions: {
        canPropose:
          authorized.role === "PROFESSIONAL" &&
          activeCapabilities(authorized.context).has(VISIT_CAPABILITIES.PROPOSE),
      },
    };
  });
}

async function getVisit(input = {}) {
  const validated = validateReadRequest(input);
  if (validated.error) return validated.error;
  const visitId = normalizedUuid(input.visitId);
  if (!visitId) {
    return failure(400, "INVALID_VISIT_ID", "A valid Visit ID is required.");
  }
  return runReadTransaction(input.pool, async (client) => {
    const authorized = await authorizeRead(client, validated);
    if (authorized.error) return authorized.error;
    const row = await loadVisit(client, authorized.jobId, visitId);
    if (
      !row ||
      !activeCapabilities(authorized.context, row).has(VISIT_CAPABILITIES.READ)
    ) {
      return failure(404, "VISIT_UNAVAILABLE", "The Visit is unavailable.");
    }
    const history = await loadVisitHistory(client, authorized.jobId, visitId);
    return commandResult(
      "VISIT_FOUND",
      200,
      {
        ...visitProjection(row, authorized.context, currentInstant(input.clock)),
        history,
      }
    );
  });
}

async function validateProposedSubjects({
  client,
  jobId,
  purpose,
  evaluationId,
  workstreamIds,
  approvedQuoteDecisionId,
}) {
  if (evaluationId) {
    const evaluation = await client.query(
      `SELECT subjects.evaluation_id
       FROM canonical_evaluation_job_subjects subjects
       INNER JOIN canonical_evaluations evaluations
         ON evaluations.id = subjects.evaluation_id
         AND evaluations.status = 'draft'
       WHERE subjects.evaluation_id = $1 AND subjects.job_id = $2
       LIMIT 1`,
      [evaluationId, jobId]
    );
    if (!evaluation.rows[0]) return false;
  }
  if (approvedQuoteDecisionId) {
    const decision = await client.query(
      `SELECT id
       FROM canonical_quote_customer_decisions
       WHERE id = $1 AND job_id = $2 AND decision = 'APPROVED'
       LIMIT 1`,
      [approvedQuoteDecisionId, jobId]
    );
    if (!decision.rows[0]) return false;
  }
  if (workstreamIds.length > 0) {
    const workstreams = await client.query(
      `SELECT id
       FROM canonical_workstreams
       WHERE job_id = $1 AND id = ANY($2::uuid[])`,
      [jobId, workstreamIds]
    );
    if (workstreams.rows.length !== workstreamIds.length) return false;
  }
  return (
    (purpose === "EVALUATION" &&
      evaluationId === null &&
      approvedQuoteDecisionId === null) ||
    (purpose === "APPROVED_WORK" &&
      evaluationId === null &&
      approvedQuoteDecisionId !== null) ||
    (purpose === "FOLLOW_UP" &&
      evaluationId === null &&
      approvedQuoteDecisionId === null)
  );
}

async function proposeVisit(input = {}) {
  const validated = validateCommand(input, [
    "jobId",
    "purpose",
    "scheduledStartAt",
    "scheduledEndAt",
    "timeZone",
    "locationMode",
    "evaluationId",
    "workstreamIds",
    "approvedQuoteDecisionId",
    "reason",
  ]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const purpose = VISIT_PURPOSES.includes(input.purpose) ? input.purpose : null;
  const schedule = normalizedSchedule(input);
  const evaluationId = input.evaluationId == null
    ? null
    : normalizedUuid(input.evaluationId);
  const approvedQuoteDecisionId = input.approvedQuoteDecisionId == null
    ? null
    : normalizedUuid(input.approvedQuoteDecisionId);
  const workstreamIds = normalizedWorkstreamIds(input.workstreamIds);
  const reason = input.reason == null
    ? null
    : boundedText(input.reason, 2000, { optional: true });
  if (
    !jobId ||
    !purpose ||
    !schedule ||
    (input.evaluationId != null && !evaluationId) ||
    (input.approvedQuoteDecisionId != null && !approvedQuoteDecisionId) ||
    workstreamIds === null ||
    (input.reason != null && !reason)
  ) {
    return failure(400, "INVALID_VISIT_PROPOSAL", "The Visit proposal is invalid.");
  }
  if (Date.parse(schedule.scheduledStartAt) <= currentInstant(input.clock).getTime()) {
    return failure(
      400,
      "VISIT_START_TIME_NOT_FUTURE",
      "A proposed Visit must start in the future."
    );
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await requireAuthority({
      client,
      actorUserId: validated.actorId,
      jobId,
      capability: VISIT_CAPABILITIES.PROPOSE,
      requiredRole: "PROFESSIONAL",
      logger,
      lock: true,
      evaluationId: purpose === "EVALUATION" ? evaluationId : null,
      approvedQuoteDecisionId: purpose === "APPROVED_WORK"
        ? approvedQuoteDecisionId
        : null,
      allowJobScope: purpose === "FOLLOW_UP",
      allowEvaluationVisitScope: purpose === "EVALUATION",
    });
    if (authorized.error) return { abort: authorized.error };
    const participantId = authorized.context.actor_participant_id;
    const subjectValid = await validateProposedSubjects({
      client,
      jobId,
      purpose,
      evaluationId,
      workstreamIds,
      approvedQuoteDecisionId,
    });
    if (!subjectValid) {
      return {
        abort: failure(
          409,
          "VISIT_SUBJECT_SCOPE_MISMATCH",
          "The Visit subjects do not belong to the authorized Job context."
        ),
      };
    }
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName: VISIT_COMMANDS.PROPOSE,
      commandScope: `job:${jobId}:visits`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        purpose,
        ...schedule,
        evaluationId,
        workstreamIds,
        approvedQuoteDecisionId,
        reason,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: VISIT_COMMANDS.PROPOSE,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        visitId: idempotency.replay.visit?.id || null,
      });
    }

    const visitId = randomUUID();
    await client.query(
      `INSERT INTO canonical_visits (
        id, job_id, purpose, created_by_participant_id,
        created_command_idempotency_id,
        approved_quote_decision_id, approved_quote_decision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        visitId,
        jobId,
        purpose,
        participantId,
        idempotency.reservation.id,
        approvedQuoteDecisionId,
        approvedQuoteDecisionId ? "APPROVED" : null,
      ]
    );
    await insertVisitVersion(client, {
      visitId,
      version: 1,
      jobId,
      state: "PROPOSED",
      schedule,
      participantId,
      commandId: idempotency.reservation.id,
    });
    await insertVisitEvent(client, {
      visitId,
      visitVersion: 1,
      previousVisitVersion: null,
      jobId,
      eventType: "VISIT_PROPOSED",
      visitState: "PROPOSED",
      reason,
      participantId,
      commandId: idempotency.reservation.id,
    });
    for (const workstreamId of workstreamIds) {
      await client.query(
        `INSERT INTO canonical_visit_workstream_links (
          visit_id, workstream_id, job_id,
          linked_by_participant_id, command_idempotency_id
         ) VALUES ($1, $2, $3, $4, $5)`,
        [visitId, workstreamId, jobId, participantId, idempotency.reservation.id]
      );
    }
    await invokeFailure(input.failureInjector, "after_write");
    const row = await loadVisit(client, jobId, visitId);
    const result = commandResult(
      "VISIT_PROPOSED",
      201,
      visitProjection(row, authorized.context, currentInstant(input.clock))
    );
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Visit proposed", {
        code: "VISIT_PROPOSED",
        actorUserId: validated.actorId,
        participantId,
        jobId,
        visitId,
        purpose,
      }),
    };
  });
}

async function insertVisitVersion(client, {
  visitId,
  version,
  jobId,
  state,
  schedule,
  cancellationReason = null,
  cancelledAt = null,
  completedAt = null,
  participantId,
  commandId,
}) {
  await client.query(
    `INSERT INTO canonical_visit_versions (
      visit_id, version, job_id, state,
      scheduled_start_at, scheduled_end_at, time_zone, location_mode,
      cancellation_reason, cancelled_at, completed_at,
      recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14
     )`,
    [
      visitId,
      version,
      jobId,
      state,
      schedule.scheduledStartAt,
      schedule.scheduledEndAt,
      schedule.timeZone,
      schedule.locationMode,
      cancellationReason,
      cancelledAt,
      completedAt,
      participantId,
      commandId,
      integrityHash("visit_version", {
        visitId,
        version,
        jobId,
        state,
        ...schedule,
        cancellationReason,
        cancelledAt: iso(cancelledAt),
        completedAt: iso(completedAt),
        participantId,
      }),
    ]
  );
}

async function insertVisitEvent(client, {
  visitId,
  visitVersion,
  previousVisitVersion,
  jobId,
  eventType,
  visitState,
  reason,
  participantId,
  commandId,
}) {
  const result = await client.query(
    `INSERT INTO canonical_visit_events (
      id, visit_id, visit_version, previous_visit_version, job_id,
      event_type, visit_state, reason, recorded_by_participant_id,
      command_idempotency_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, event_type, visit_version, previous_visit_version,
       visit_state, reason, recorded_by_participant_id, created_at`,
    [
      randomUUID(),
      visitId,
      visitVersion,
      previousVisitVersion,
      jobId,
      eventType,
      visitState,
      reason,
      participantId,
      commandId,
    ]
  );
  return result.rows[0];
}

function currentSchedule(row) {
  return {
    scheduledStartAt: iso(row.scheduled_start_at),
    scheduledEndAt: iso(row.scheduled_end_at),
    timeZone: row.time_zone,
    locationMode: row.location_mode,
  };
}

async function linkDraftEvaluationOnVisitCompletion({
  client,
  context,
  visitId,
  jobId,
  participantId,
  idempotencyKey,
}) {
  const evaluationId = context?.canonical_evaluation_id || null;
  if (!evaluationId) {
    return { linked: false, evaluationId: null };
  }

  const remoteProvenance = await client.query(
    `SELECT id
     FROM canonical_evaluation_remote_provenance
     WHERE evaluation_id = $1
       AND job_id = $2
     LIMIT 1`,
    [evaluationId, jobId]
  );
  if (remoteProvenance.rows[0]) {
    return {
      error: failure(
        409,
        "EVALUATION_REMOTE_PROVENANCE_CONFLICT",
        "This Evaluation was completed through a remote assessment and cannot be linked to a Visit."
      ),
    };
  }
  if (context?.canonical_evaluation_status !== "draft") {
    return { linked: false, evaluationId: null };
  }

  const subject = await client.query(
    `SELECT subjects.evaluation_id
     FROM canonical_evaluation_job_subjects subjects
     INNER JOIN canonical_evaluations evaluations
       ON evaluations.id = subjects.evaluation_id
       AND evaluations.status = 'draft'
     WHERE subjects.evaluation_id = $1
       AND subjects.job_id = $2
     LIMIT 1`,
    [evaluationId, jobId]
  );
  if (!subject.rows[0]) {
    return {
      error: failure(
        409,
        "EVALUATION_VISIT_PROVENANCE_CONFLICT",
        "The Evaluation Visit cannot be linked to the current Evaluation."
      ),
    };
  }

  const existing = await client.query(
    `SELECT visit_id, evaluation_id
     FROM canonical_visit_evaluation_links
     WHERE job_id = $1
       AND (visit_id = $2 OR evaluation_id = $3)
     ORDER BY created_at ASC, visit_id ASC
     FOR UPDATE`,
    [jobId, visitId, evaluationId]
  );
  if (
    existing.rows.some(
      (row) => row.visit_id !== visitId || row.evaluation_id !== evaluationId
    )
  ) {
    return {
      error: failure(
        409,
        "EVALUATION_VISIT_PROVENANCE_CONFLICT",
        "The Evaluation already has different Visit provenance."
      ),
    };
  }
  if (existing.rows.length === 1) {
    return { linked: false, evaluationId };
  }

  const idempotency = await reserveCommand({
    client,
    participantId,
    jobId,
    commandName: VISIT_COMMANDS.LINK_EVALUATION,
    commandScope: `visit:${visitId}:evaluation-link`,
    idempotencyKey,
    requestFingerprint: fingerprint({
      commandName: VISIT_COMMANDS.LINK_EVALUATION,
      jobId,
      visitId,
      evaluationId,
    }),
  });
  if (idempotency.error) return { error: idempotency.error };
  if (idempotency.replay) {
    return { linked: false, evaluationId };
  }

  let inserted;
  try {
    inserted = await client.query(
      `INSERT INTO canonical_visit_evaluation_links (
         visit_id, job_id, evaluation_id,
         linked_by_participant_id, command_idempotency_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING visit_id`,
      [
        visitId,
        jobId,
        evaluationId,
        participantId,
        idempotency.reservation.id,
      ]
    );
  } catch (error) {
    if (
      /Physical and remote Evaluation provenance are mutually exclusive/i.test(
        String(error?.message || "")
      ) ||
      error?.constraint === "canonical_evaluation_provenance_claims_pkey"
    ) {
      return {
        error: failure(
          409,
          "EVALUATION_REMOTE_PROVENANCE_CONFLICT",
          "This Evaluation was completed through a remote assessment and cannot be linked to a Visit."
        ),
      };
    }
    throw error;
  }
  if (!inserted.rows[0]) {
    throw new Error("Canonical Evaluation Visit linkage failed.");
  }
  await completeCommand(client, idempotency.reservation.id, {
    ok: true,
    success: true,
    status: 200,
    code: "VISIT_EVALUATION_LINKED",
    visitId,
    evaluationId,
    jobId,
  });
  return { linked: true, evaluationId };
}

async function runVersionCommand({
  input,
  validated,
  jobId,
  visitId,
  expectedVersion,
  capability,
  commandName,
  permittedStates,
  targetState,
  eventType,
  schedule = null,
  reason = null,
  resultCode,
  requiredRole,
}) {
  const logger = safeLogger(input.logger);
  return runTransaction(input.pool, async (client) => {
    const authorized = await requireActorRole({
      client,
      actorUserId: validated.actorId,
      jobId,
      requiredRole,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const current = await loadVisit(client, jobId, visitId, { lock: true });
    if (!current) {
      return {
        abort: failure(404, "VISIT_UNAVAILABLE", "The Visit is unavailable."),
      };
    }
    const granted = await hasActiveLifecycleGrant({
      client,
      participantId: authorized.context.actor_participant_id,
      jobId,
      capability,
      evaluationId: current.purpose === "EVALUATION"
        ? current.evaluation_id
        : null,
      approvedQuoteDecisionId: current.purpose === "APPROVED_WORK"
        ? current.approved_quote_decision_id
        : null,
      allowJobScope: current.purpose === "FOLLOW_UP",
      allowEvaluationVisitScope: current.purpose === "EVALUATION",
      logger,
    });
    if (!granted) {
      return {
        abort: failure(
          403,
          "VISIT_AUTHORITY_REQUIRED",
          "Visit authority is required."
        ),
      };
    }
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId,
      commandName,
      commandScope: `visit:${visitId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId,
        visitId,
        expectedVersion,
        commandName,
        schedule,
        reason,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: commandName,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        visitId,
      });
    }

    if (Number(current.version) !== expectedVersion) {
      return {
        abort: failure(
          409,
          "STALE_VISIT_VERSION",
          "The Visit version is no longer current."
        ),
      };
    }
    if (!permittedStates.has(current.state)) {
      return {
        abort: failure(
          409,
          "INVALID_VISIT_TRANSITION",
          "The Visit transition is not permitted."
        ),
      };
    }
    if (
      commandName === VISIT_COMMANDS.CONFIRM &&
      current.recorded_by_participant_id === participantId
    ) {
      return {
        abort: failure(
          403,
          "VISIT_OPPOSITE_PARTY_CONFIRMATION_REQUIRED",
          "A Visit proposal must be confirmed by the opposite canonical party."
        ),
      };
    }

    const now = currentInstant(input.clock);
    if (
      commandName === VISIT_COMMANDS.CONFIRM &&
      Date.parse(current.scheduled_start_at) <= now.getTime()
    ) {
      return {
        abort: failure(
          409,
          "VISIT_START_TIME_PASSED",
          "A Visit whose start time has passed cannot be confirmed."
        ),
      };
    }
    if (schedule) {
      const priorSchedule = currentSchedule(current);
      if (
        priorSchedule.scheduledStartAt === schedule.scheduledStartAt &&
        priorSchedule.scheduledEndAt === schedule.scheduledEndAt &&
        priorSchedule.timeZone === schedule.timeZone &&
        priorSchedule.locationMode === schedule.locationMode
      ) {
        return {
          abort: failure(
            409,
            "VISIT_SCHEDULE_UNCHANGED",
            "The rescheduled Visit must change canonical schedule truth."
          ),
        };
      }
    }
    if (
      commandName === VISIT_COMMANDS.COMPLETE &&
      Date.parse(current.scheduled_start_at) > now.getTime()
    ) {
      return {
        abort: failure(
          409,
          "VISIT_HAS_NOT_STARTED",
          "A future Visit cannot be completed."
        ),
      };
    }
    const nextVersion = expectedVersion + 1;
    const resultingSchedule = schedule || currentSchedule(current);
    const cancelledAt = targetState === "CANCELLED" ? now : null;
    const completedAt = targetState === "COMPLETED" ? now : null;
    await insertVisitVersion(client, {
      visitId,
      version: nextVersion,
      jobId,
      state: targetState,
      schedule: resultingSchedule,
      cancellationReason: targetState === "CANCELLED" ? reason : null,
      cancelledAt,
      completedAt,
      participantId,
      commandId: idempotency.reservation.id,
    });
    await insertVisitEvent(client, {
      visitId,
      visitVersion: nextVersion,
      previousVisitVersion: expectedVersion,
      jobId,
      eventType,
      visitState: targetState,
      reason,
      participantId,
      commandId: idempotency.reservation.id,
    });
    if (
      commandName === VISIT_COMMANDS.COMPLETE &&
      current.purpose === "EVALUATION"
    ) {
      const linkage = await linkDraftEvaluationOnVisitCompletion({
        client,
        context: authorized.context,
        visitId,
        jobId,
        participantId,
        idempotencyKey: validated.idempotencyKey,
      });
      if (linkage.error) return { abort: linkage.error };
    }
    await invokeFailure(input.failureInjector, "after_write");
    const row = await loadVisit(client, jobId, visitId);
    const result = commandResult(
      resultCode,
      200,
      visitProjection(row, authorized.context, now)
    );
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Visit transitioned", {
        code: resultCode,
        actorUserId: validated.actorId,
        participantId,
        jobId,
        visitId,
        version: nextVersion,
        state: targetState,
      }),
    };
  });
}

function validatedVersionCommand(input, fields, invalidCode) {
  const validated = validateCommand(input, ["jobId", "visitId", "expectedVersion", ...fields]);
  if (validated.error) return { error: validated.error };
  const jobId = normalizedUuid(input.jobId);
  const visitId = normalizedUuid(input.visitId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  if (!jobId || !visitId || !expectedVersion) {
    return {
      error: failure(400, invalidCode, "The Visit command is invalid."),
    };
  }
  return { validated, jobId, visitId, expectedVersion };
}

async function confirmVisit(input = {}) {
  const command = validatedVersionCommand(input, [], "INVALID_VISIT_CONFIRMATION");
  if (command.error) return command.error;
  return runVersionCommand({
    input,
    ...command,
    capability: VISIT_CAPABILITIES.CONFIRM,
    commandName: VISIT_COMMANDS.CONFIRM,
    permittedStates: new Set(["PROPOSED"]),
    targetState: "SCHEDULED",
    eventType: "VISIT_CONFIRMED",
    resultCode: "VISIT_CONFIRMED",
    requiredRole: "EITHER",
  });
}

async function requestVisitChange(input = {}) {
  const command = validatedVersionCommand(
    input,
    [
      "reason",
      "scheduledStartAt",
      "scheduledEndAt",
      "timeZone",
      "locationMode",
    ],
    "INVALID_VISIT_CHANGE_REQUEST"
  );
  if (command.error) return command.error;
  const reasonIsEmpty =
    input.reason == null ||
    (typeof input.reason === "string" && input.reason.trim().length === 0);
  const reason = reasonIsEmpty ? null : boundedText(input.reason, 2000);
  if (!reasonIsEmpty && !reason) {
    return failure(
      400,
      "INVALID_VISIT_CHANGE_REQUEST",
      "The Visit change reason is invalid."
    );
  }
  const hasSchedule = [
    input.scheduledStartAt,
    input.scheduledEndAt,
    input.timeZone,
    input.locationMode,
  ].some((value) => value != null);
  if (hasSchedule) {
    const schedule = normalizedSchedule(input);
    if (!schedule) {
      return failure(
        400,
        "INVALID_VISIT_SCHEDULE_PROPOSAL",
        "The alternate Visit schedule is invalid."
      );
    }
    if (Date.parse(schedule.scheduledStartAt) <= currentInstant(input.clock).getTime()) {
      return failure(
        400,
        "VISIT_START_TIME_NOT_FUTURE",
        "An alternate Visit schedule must start in the future."
      );
    }
    return runVersionCommand({
      input,
      ...command,
      capability: VISIT_CAPABILITIES.CHANGE_REQUEST,
      commandName: VISIT_COMMANDS.CHANGE_REQUEST,
      permittedStates: ACTIVE_VISIT_STATES,
      targetState: "PROPOSED",
      eventType: "VISIT_SCHEDULE_PROPOSED",
      schedule,
      reason,
      resultCode: "VISIT_SCHEDULE_PROPOSED",
      requiredRole: "CUSTOMER",
    });
  }
  if (!reason) {
    return failure(
      400,
      "INVALID_VISIT_CHANGE_REQUEST",
      "A bounded Visit change reason is required."
    );
  }
  const logger = safeLogger(input.logger);
  return runTransaction(input.pool, async (client) => {
    const authorized = await requireActorRole({
      client,
      actorUserId: command.validated.actorId,
      jobId: command.jobId,
      requiredRole: "CUSTOMER",
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const current = await loadVisit(client, command.jobId, command.visitId, {
      lock: true,
    });
    if (!current) {
      return {
        abort: failure(404, "VISIT_UNAVAILABLE", "The Visit is unavailable."),
      };
    }
    const granted = await hasActiveLifecycleGrant({
      client,
      participantId: authorized.context.actor_participant_id,
      jobId: command.jobId,
      capability: VISIT_CAPABILITIES.CHANGE_REQUEST,
      evaluationId: current.purpose === "EVALUATION"
        ? current.evaluation_id
        : null,
      approvedQuoteDecisionId: current.purpose === "APPROVED_WORK"
        ? current.approved_quote_decision_id
        : null,
      allowJobScope: current.purpose === "FOLLOW_UP",
      allowEvaluationVisitScope: current.purpose === "EVALUATION",
      logger,
    });
    if (!granted) {
      return {
        abort: failure(
          403,
          "VISIT_AUTHORITY_REQUIRED",
          "Visit authority is required."
        ),
      };
    }
    const participantId = authorized.context.actor_participant_id;
    const idempotency = await reserveCommand({
      client,
      participantId,
      jobId: command.jobId,
      commandName: VISIT_COMMANDS.CHANGE_REQUEST,
      commandScope: `visit:${command.visitId}`,
      idempotencyKey: command.validated.idempotencyKey,
      requestFingerprint: fingerprint({
        jobId: command.jobId,
        visitId: command.visitId,
        expectedVersion: command.expectedVersion,
        reason,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return replayOutcome(idempotency.replay, logger, {
        command: VISIT_COMMANDS.CHANGE_REQUEST,
        actorUserId: command.validated.actorId,
        participantId,
        jobId: command.jobId,
        visitId: command.visitId,
      });
    }
    if (Number(current.version) !== command.expectedVersion) {
      return {
        abort: failure(
          409,
          "STALE_VISIT_VERSION",
          "The Visit version is no longer current."
        ),
      };
    }
    if (!ACTIVE_VISIT_STATES.has(current.state)) {
      return {
        abort: failure(
          409,
          "INVALID_VISIT_TRANSITION",
          "A terminal Visit cannot receive a change request."
        ),
      };
    }
    const eventRow = await insertVisitEvent(client, {
      visitId: command.visitId,
      visitVersion: command.expectedVersion,
      previousVisitVersion: command.expectedVersion,
      jobId: command.jobId,
      eventType: "VISIT_CHANGE_REQUESTED",
      visitState: current.state,
      reason,
      participantId,
      commandId: idempotency.reservation.id,
    });
    await invokeFailure(input.failureInjector, "after_write");
    const now = currentInstant(input.clock);
    const result = commandResult(
      "VISIT_CHANGE_REQUESTED",
      200,
      visitProjection(current, authorized.context, now),
      { event: visitEventProjection(eventRow) }
    );
    await completeCommand(client, idempotency.reservation.id, result);
    return {
      result,
      afterCommit: () => logger.info("Visit change requested", {
        code: "VISIT_CHANGE_REQUESTED",
        actorUserId: command.validated.actorId,
        participantId,
        jobId: command.jobId,
        visitId: command.visitId,
        version: command.expectedVersion,
      }),
    };
  });
}

async function rescheduleVisit(input = {}) {
  const command = validatedVersionCommand(
    input,
    ["scheduledStartAt", "scheduledEndAt", "timeZone", "locationMode", "reason"],
    "INVALID_VISIT_RESCHEDULE"
  );
  if (command.error) return command.error;
  const schedule = normalizedSchedule(input);
  const reason = input.reason == null
    ? null
    : boundedText(input.reason, 2000, { optional: true });
  if (!schedule || (input.reason != null && !reason)) {
    return failure(400, "INVALID_VISIT_RESCHEDULE", "The Visit schedule is invalid.");
  }
  if (Date.parse(schedule.scheduledStartAt) <= currentInstant(input.clock).getTime()) {
    return failure(
      400,
      "VISIT_START_TIME_NOT_FUTURE",
      "A rescheduled Visit must start in the future."
    );
  }
  return runVersionCommand({
    input,
    ...command,
    capability: VISIT_CAPABILITIES.RESCHEDULE,
    commandName: VISIT_COMMANDS.RESCHEDULE,
    permittedStates: ACTIVE_VISIT_STATES,
    targetState: "PROPOSED",
    eventType: "VISIT_SCHEDULE_PROPOSED",
    schedule,
    reason,
    resultCode: "VISIT_SCHEDULE_PROPOSED",
    requiredRole: "PROFESSIONAL",
  });
}

async function cancelVisit(input = {}) {
  const command = validatedVersionCommand(
    input,
    ["reason"],
    "INVALID_VISIT_CANCELLATION"
  );
  if (command.error) return command.error;
  const reason = input.reason == null
    ? null
    : boundedText(input.reason, 2000, { optional: true });
  if (input.reason != null && !reason) {
    return failure(
      400,
      "INVALID_VISIT_CANCELLATION",
      "The Visit cancellation reason is invalid."
    );
  }
  return runVersionCommand({
    input,
    ...command,
    capability: VISIT_CAPABILITIES.CANCEL,
    commandName: VISIT_COMMANDS.CANCEL,
    permittedStates: ACTIVE_VISIT_STATES,
    targetState: "CANCELLED",
    eventType: "VISIT_CANCELLED",
    reason,
    resultCode: "VISIT_CANCELLED",
    requiredRole: "PROFESSIONAL",
  });
}

async function completeVisit(input = {}) {
  const command = validatedVersionCommand(input, [], "INVALID_VISIT_COMPLETION");
  if (command.error) return command.error;
  return runVersionCommand({
    input,
    ...command,
    capability: VISIT_CAPABILITIES.COMPLETE,
    commandName: VISIT_COMMANDS.COMPLETE,
    permittedStates: new Set(["SCHEDULED"]),
    targetState: "COMPLETED",
    eventType: "VISIT_COMPLETED",
    resultCode: "VISIT_COMPLETED",
    requiredRole: "PROFESSIONAL",
  });
}

module.exports = {
  VISIT_CAPABILITIES,
  VISIT_COMMANDS,
  VISIT_LOCATION_MODES,
  VISIT_PURPOSES,
  VISIT_STATES,
  cancelVisit,
  completeVisit,
  confirmVisit,
  getEvaluationVisit,
  getVisit,
  listEvaluationVisits,
  listVisits,
  proposeVisit,
  requestVisitChange,
  rescheduleVisit,
  visitServiceInternals: Object.freeze({
    canonicalTimeZone,
    linkDraftEvaluationOnVisitCompletion,
    normalizedSchedule,
    strictInstant,
    visitEventProjection,
    visitProjection,
    visitVersionProjection,
  }),
};
