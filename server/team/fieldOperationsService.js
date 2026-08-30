"use strict";

const { createHash } = require("node:crypto");
const { createCanonicalLifecycleAlertWithClient } = require("../alerts/lifecycleAlertService");
const { permissionForRole } = require("./teamService");

const FIELD_STATUSES = Object.freeze([
  "ASSIGNED", "ON_MY_WAY", "ARRIVED", "WORKING", "FIELD_WORK_COMPLETED",
]);
const NEXT_FIELD_STATUS = Object.freeze({
  ASSIGNED: "ON_MY_WAY",
  ON_MY_WAY: "ARRIVED",
  ARRIVED: "WORKING",
  WORKING: "FIELD_WORK_COMPLETED",
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function boundedText(value, maximum, { required = false } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) return required ? null : null;
  return normalized.length <= maximum && !/[\u0000]/.test(normalized) ? normalized : null;
}

function normalizeIdempotencyKey(value) {
  const normalized = boundedText(value, 200, { required: true });
  return normalized && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : null;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function databaseClient(pool) {
  return typeof pool.connect === "function" ? pool.connect() : pool;
}

async function withTransaction(pool, action, { readOnly = false } = {}) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query(readOnly
      ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : "BEGIN");
    started = true;
    const result = await action(client);
    if (result?.ok === false) {
      await client.query("ROLLBACK");
      started = false;
      return result;
    }
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadActor(database, actorUserId, businessId) {
  const result = await database.query(
    `SELECT memberships.*, profiles.business_name
       FROM business_team_memberships memberships
       JOIN contractor_profiles profiles ON profiles.id = memberships.contractor_profile_id
      WHERE memberships.user_id = $1
        AND memberships.contractor_profile_id = $2
        AND memberships.status = 'ACTIVE'
      LIMIT 1`,
    [actorUserId, businessId]
  );
  return result.rows[0] || null;
}

async function loadAssignment(database, businessId, jobId, assignmentId, { lock = false } = {}) {
  const result = await database.query(
    `SELECT assignments.*, memberships.user_id AS member_user_id,
            memberships.role AS member_role, memberships.status AS member_status,
            users.username AS member_name, posts.title AS job_title
       FROM business_job_assignments assignments
       JOIN business_team_memberships memberships
         ON memberships.id = assignments.membership_id
        AND memberships.contractor_profile_id = assignments.contractor_profile_id
       JOIN users ON users.id = memberships.user_id
       JOIN jobs ON jobs.id = assignments.job_id
       JOIN posts ON posts.id = jobs.job_request_id
      WHERE assignments.id = $1
        AND assignments.contractor_profile_id = $2
        AND assignments.job_id = $3
      ${lock ? "FOR UPDATE OF assignments" : ""}`,
    [assignmentId, businessId, jobId]
  );
  return result.rows[0] || null;
}

async function loadActivationVersion(database, assignmentId) {
  const result = await database.query(
    `SELECT assignment_version
       FROM business_job_assignment_events
      WHERE assignment_id = $1 AND event_type IN ('ASSIGNED', 'REASSIGNED')
      ORDER BY assignment_version DESC LIMIT 1`,
    [assignmentId]
  );
  return positiveInteger(result.rows[0]?.assignment_version);
}

async function loadCurrentStatus(database, assignmentId, activationVersion) {
  const result = await database.query(
    `SELECT * FROM business_job_field_status_events
      WHERE assignment_id = $1 AND assignment_activation_version = $2
      ORDER BY status_version DESC LIMIT 1`,
    [assignmentId, activationVersion]
  );
  const row = result.rows[0];
  return row
    ? { status: row.to_status, version: Number(row.status_version), event: row }
    : { status: "ASSIGNED", version: 0, event: null };
}

function assignmentAuthorityFailure(actor, assignment) {
  if (!assignment) return failure(404, "FIELD_ASSIGNMENT_NOT_FOUND", "The exact Job assignment was not found.");
  if (assignment.state !== "ACTIVE" || assignment.member_status !== "ACTIVE" || assignment.member_role !== "FIELD_EMPLOYEE") {
    return failure(409, "FIELD_ASSIGNMENT_INACTIVE", "Field operations require an active Field Employee assignment.");
  }
  if (actor.role === "FIELD_EMPLOYEE" && actor.id !== assignment.membership_id) {
    return failure(403, "FIELD_ASSIGNMENT_PERMISSION_REQUIRED", "A Field Employee may access only their exact active Job assignment.");
  }
  return null;
}

function serializeStatusEvent(row) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    activationVersion: Number(row.assignment_activation_version),
    version: Number(row.status_version),
    fromStatus: row.from_status,
    status: row.to_status,
    note: row.note || null,
    actorMembershipId: row.actor_membership_id,
    occurredAt: iso(row.occurred_at),
  };
}

function serializeMessage(row) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    senderMembershipId: row.sender_membership_id,
    senderUserId: Number(row.sender_user_id),
    senderName: row.sender_name || "Team member",
    senderRole: row.sender_role || null,
    message: row.message_text,
    createdAt: iso(row.created_at),
  };
}

async function loadOperations(database, assignment, activationVersion) {
  const [statusResult, messageResult] = await Promise.all([
    database.query(
      `SELECT * FROM business_job_field_status_events
        WHERE assignment_id = $1 AND assignment_activation_version = $2
        ORDER BY status_version ASC`,
      [assignment.id, activationVersion]
    ),
    database.query(
      `SELECT messages.*, users.username AS sender_name, memberships.role AS sender_role
         FROM business_job_field_messages messages
         JOIN business_team_memberships memberships ON memberships.id = messages.sender_membership_id
         JOIN users ON users.id = messages.sender_user_id
        WHERE messages.assignment_id = $1
        ORDER BY messages.created_at ASC, messages.id ASC
        LIMIT 500`,
      [assignment.id]
    ),
  ]);
  const events = statusResult.rows.map(serializeStatusEvent);
  const currentStatus = events.at(-1)?.status || "ASSIGNED";
  return {
    assignmentId: assignment.id,
    jobId: assignment.job_id,
    jobTitle: assignment.job_title || "Job",
    membershipId: assignment.membership_id,
    employee: { userId: Number(assignment.member_user_id), name: assignment.member_name || "Team member" },
    activationVersion,
    currentStatus,
    nextStatus: NEXT_FIELD_STATUS[currentStatus] || null,
    statusEvents: events,
    messages: messageResult.rows.map(serializeMessage),
  };
}

async function listFieldOperations({ pool, authenticatedActor, businessId, jobId, assignmentId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedJobId = uuid(jobId);
  const normalizedAssignmentId = uuid(assignmentId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedJobId || !normalizedAssignmentId) {
    return failure(400, "FIELD_OPERATION_IDENTITY_INVALID", "Exact business, Job, and assignment identity are required.");
  }
  return withTransaction(pool, async (client) => {
    const actor = await loadActor(client, actorId, normalizedBusinessId);
    if (!actor || (!permissionForRole(actor.role, "FIELD_OPERATIONS_VIEW") && !permissionForRole(actor.role, "FIELD_COMMUNICATION"))) {
      return failure(403, "FIELD_OPERATIONS_PERMISSION_REQUIRED", "This Team role cannot access field operations.");
    }
    const assignment = await loadAssignment(client, normalizedBusinessId, normalizedJobId, normalizedAssignmentId);
    const authorityFailure = assignmentAuthorityFailure(actor, assignment);
    if (authorityFailure) return authorityFailure;
    const activationVersion = await loadActivationVersion(client, assignment.id);
    if (!activationVersion) return failure(409, "FIELD_ASSIGNMENT_EVIDENCE_REQUIRED", "The assignment activation evidence is unavailable.");
    return { ok: true, status: 200, code: "FIELD_OPERATIONS_LOADED", operations: await loadOperations(client, assignment, activationVersion) };
  }, { readOnly: true });
}

async function alertRecipients(database, businessId, assignment, senderRole = null) {
  if (senderRole === "FIELD_EMPLOYEE") {
    const result = await database.query(
      `SELECT user_id FROM business_team_memberships
        WHERE contractor_profile_id = $1 AND status = 'ACTIVE' AND role IN ('OWNER', 'MANAGER')
        ORDER BY id`,
      [businessId]
    );
    return result.rows.map((row) => Number(row.user_id));
  }
  return [Number(assignment.member_user_id)];
}

async function emitAlert(database, { recipientUserId, assignment, entityType, entityId, eventId, eventType, titleKey, messageKey, shortPreview }) {
  await createCanonicalLifecycleAlertWithClient({
    client: database,
    recipientUserId,
    sourceDomain: "business",
    sourceEventType: eventType,
    sourceEntityType: entityType,
    sourceEntityId: entityId,
    sourceEventId: eventId,
    category: "work",
    titleKey,
    messageKey,
    safePayload: {
      jobTitle: String(assignment.job_title || "Job").slice(0, 160),
      employeeName: String(assignment.member_name || "Team member").slice(0, 160),
      shortPreview: String(shortPreview || assignment.job_title || "Job").slice(0, 160),
    },
    destination: { type: "job", payload: { jobId: assignment.job_id } },
  });
}

async function transitionFieldStatus({ pool, authenticatedActor, businessId, jobId, assignmentId, toStatus, note, idempotencyKey }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedJobId = uuid(jobId);
  const normalizedAssignmentId = uuid(assignmentId);
  const normalizedStatus = String(toStatus || "").trim().toUpperCase();
  const normalizedNote = note == null || String(note).trim() === "" ? null : boundedText(note, 1000);
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedJobId || !normalizedAssignmentId || !FIELD_STATUSES.includes(normalizedStatus) || normalizedStatus === "ASSIGNED" || !normalizedKey || (note != null && String(note).trim() && !normalizedNote)) {
    return failure(400, "FIELD_STATUS_REQUEST_INVALID", "Exact field status command identity is required.");
  }
  return withTransaction(pool, async (client) => {
    const actor = await loadActor(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "FIELD_STATUS_UPDATE")) {
      return failure(403, "FIELD_STATUS_PERMISSION_REQUIRED", "Only the assigned Field Employee may update field status.");
    }
    const assignment = await loadAssignment(client, normalizedBusinessId, normalizedJobId, normalizedAssignmentId, { lock: true });
    const authorityFailure = assignmentAuthorityFailure(actor, assignment);
    if (authorityFailure) return authorityFailure;
    const activationVersion = await loadActivationVersion(client, assignment.id);
    if (!activationVersion) return failure(409, "FIELD_ASSIGNMENT_EVIDENCE_REQUIRED", "The assignment activation evidence is unavailable.");
    const requestFingerprint = fingerprint({ businessId: normalizedBusinessId, jobId: normalizedJobId, assignmentId: normalizedAssignmentId, activationVersion, toStatus: normalizedStatus, note: normalizedNote });
    const existingResult = await client.query(
      `SELECT * FROM business_job_field_status_commands
        WHERE actor_membership_id = $1 AND assignment_id = $2 AND idempotency_key = $3
        FOR UPDATE`,
      [actor.id, assignment.id, normalizedKey]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) return failure(409, "FIELD_STATUS_IDEMPOTENCY_CONFLICT", "The idempotency key is already bound to a different field status command.");
      if (!existing.completed_at || !existing.result_reference) return failure(409, "FIELD_STATUS_COMMAND_IN_PROGRESS", "The field status command is still in progress.");
      return { ok: true, status: 200, code: "FIELD_STATUS_UPDATED", replayed: true, ...existing.result_reference };
    }
    const current = await loadCurrentStatus(client, assignment.id, activationVersion);
    if (NEXT_FIELD_STATUS[current.status] !== normalizedStatus) {
      return failure(409, "FIELD_STATUS_TRANSITION_INVALID", `The next field status must be ${NEXT_FIELD_STATUS[current.status] || "none"}.`);
    }
    const commandResult = await client.query(
      `INSERT INTO business_job_field_status_commands
         (assignment_id, contractor_profile_id, job_id, membership_id,
          assignment_activation_version, actor_membership_id, idempotency_key, request_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [assignment.id, normalizedBusinessId, normalizedJobId, assignment.membership_id, activationVersion, actor.id, normalizedKey, requestFingerprint]
    );
    const eventResult = await client.query(
      `INSERT INTO business_job_field_status_events
         (assignment_id, contractor_profile_id, job_id, membership_id,
          assignment_activation_version, status_version, from_status, to_status,
          note, actor_membership_id, actor_user_id, command_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [assignment.id, normalizedBusinessId, normalizedJobId, assignment.membership_id,
        activationVersion, current.version + 1, current.status, normalizedStatus,
        normalizedNote, actor.id, actorId, commandResult.rows[0].id]
    );
    const event = serializeStatusEvent(eventResult.rows[0]);
    if (["ON_MY_WAY", "ARRIVED", "FIELD_WORK_COMPLETED"].includes(normalizedStatus)) {
      const recipients = await alertRecipients(client, normalizedBusinessId, assignment, actor.role);
      const copyName = normalizedStatus.toLowerCase();
      for (const recipientUserId of recipients) {
        await emitAlert(client, {
          recipientUserId, assignment,
          entityType: "business_job_field_status", entityId: assignment.id, eventId: event.id,
          eventType: `job.field_status.${copyName}`,
          titleKey: `alerts.work.fieldStatus.${copyName}.title`,
          messageKey: `alerts.work.fieldStatus.${copyName}.message`,
          shortPreview: normalizedStatus,
        });
      }
    }
    const resultReference = { operations: { ...(await loadOperations(client, assignment, activationVersion)), currentStatus: normalizedStatus }, event };
    await client.query(
      `UPDATE business_job_field_status_commands
          SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND completed_at IS NULL`,
      [commandResult.rows[0].id, JSON.stringify(resultReference)]
    );
    return { ok: true, status: 200, code: "FIELD_STATUS_UPDATED", replayed: false, ...resultReference };
  });
}

async function sendFieldMessage({ pool, authenticatedActor, businessId, jobId, assignmentId, message, idempotencyKey }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedJobId = uuid(jobId);
  const normalizedAssignmentId = uuid(assignmentId);
  const normalizedMessage = boundedText(message, 5000, { required: true });
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedJobId || !normalizedAssignmentId || !normalizedMessage || !normalizedKey) {
    return failure(400, "FIELD_MESSAGE_REQUEST_INVALID", "Exact Job message identity and content are required.");
  }
  return withTransaction(pool, async (client) => {
    const actor = await loadActor(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "FIELD_COMMUNICATION")) {
      return failure(403, "FIELD_COMMUNICATION_PERMISSION_REQUIRED", "This Team role cannot use internal Job communication.");
    }
    const assignment = await loadAssignment(client, normalizedBusinessId, normalizedJobId, normalizedAssignmentId, { lock: true });
    const authorityFailure = assignmentAuthorityFailure(actor, assignment);
    if (authorityFailure) return authorityFailure;
    const requestFingerprint = fingerprint({ businessId: normalizedBusinessId, jobId: normalizedJobId, assignmentId: normalizedAssignmentId, message: normalizedMessage });
    const existingResult = await client.query(
      `SELECT messages.*, users.username AS sender_name, memberships.role AS sender_role
         FROM business_job_field_messages messages
         JOIN users ON users.id = messages.sender_user_id
         JOIN business_team_memberships memberships ON memberships.id = messages.sender_membership_id
        WHERE messages.sender_membership_id = $1 AND messages.assignment_id = $2 AND messages.idempotency_key = $3
        FOR UPDATE OF messages`,
      [actor.id, assignment.id, normalizedKey]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) return failure(409, "FIELD_MESSAGE_IDEMPOTENCY_CONFLICT", "The idempotency key is already bound to a different message.");
      return { ok: true, status: 200, code: "FIELD_MESSAGE_SENT", replayed: true, message: serializeMessage(existing) };
    }
    const inserted = await client.query(
      `INSERT INTO business_job_field_messages
         (assignment_id, contractor_profile_id, job_id, membership_id,
          sender_membership_id, sender_user_id, message_text, idempotency_key, request_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [assignment.id, normalizedBusinessId, normalizedJobId, assignment.membership_id,
        actor.id, actorId, normalizedMessage, normalizedKey, requestFingerprint]
    );
    const row = { ...inserted.rows[0], sender_name: authenticatedActor?.username || actor.username || "Team member", sender_role: actor.role };
    const recipients = await alertRecipients(client, normalizedBusinessId, assignment, actor.role);
    for (const recipientUserId of recipients.filter((id) => id !== actorId)) {
      await emitAlert(client, {
        recipientUserId, assignment,
        entityType: "business_job_field_message", entityId: row.id, eventId: row.id,
        eventType: "job.field_message.received",
        titleKey: "alerts.work.fieldMessage.title",
        messageKey: "alerts.work.fieldMessage.message",
        shortPreview: normalizedMessage,
      });
    }
    return { ok: true, status: 201, code: "FIELD_MESSAGE_SENT", replayed: false, message: serializeMessage(row) };
  });
}

module.exports = {
  FIELD_STATUSES,
  NEXT_FIELD_STATUS,
  fingerprint,
  listFieldOperations,
  normalizeIdempotencyKey,
  sendFieldMessage,
  serializeMessage,
  serializeStatusEvent,
  transitionFieldStatus,
};
