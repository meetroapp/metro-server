"use strict";

const { createHash } = require("node:crypto");
const { permissionForRole } = require("./teamService");

const TIME_CATEGORIES = Object.freeze([
  "JOB_WORK", "DRIVING", "OFFICE", "SUPPLIES", "BREAK", "GENERAL",
]);
const LOCATION_STATUSES = Object.freeze([
  "CAPTURED", "UNAVAILABLE", "DENIED", "NOT_REQUESTED",
]);
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

function normalizeIdempotencyKey(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 200 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeLocation(value) {
  if (value == null) return { status: "NOT_REQUESTED", latitude: null, longitude: null };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const status = String(value.status || "").trim().toUpperCase();
  if (!LOCATION_STATUSES.includes(status)) return null;
  if (status !== "CAPTURED") {
    if (value.latitude != null || value.longitude != null) return null;
    return { status, latitude: null, longitude: null };
  }
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { status, latitude, longitude };
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

async function loadActor(database, actorUserId, businessId, { lock = false } = {}) {
  const result = await database.query(
    `SELECT memberships.*, users.username, users.email
       FROM business_team_memberships memberships
       JOIN users ON users.id = memberships.user_id
      WHERE memberships.user_id = $1
        AND memberships.contractor_profile_id = $2
        AND memberships.status = 'ACTIVE'
      ${lock ? "FOR UPDATE OF memberships" : ""}
      LIMIT 1`,
    [actorUserId, businessId]
  );
  return result.rows[0] || null;
}

async function loadAssignment(database, businessId, jobId, assignmentId, membershipId) {
  const result = await database.query(
    `SELECT assignments.*, posts.title AS job_title,
            activation.assignment_version AS activation_version
       FROM business_job_assignments assignments
       JOIN jobs ON jobs.id = assignments.job_id
       JOIN posts ON posts.id = jobs.job_request_id
       LEFT JOIN LATERAL (
         SELECT max(events.assignment_version) AS assignment_version
           FROM business_job_assignment_events events
          WHERE events.assignment_id = assignments.id
            AND events.event_type IN ('ASSIGNED', 'REASSIGNED')
       ) activation ON TRUE
      WHERE assignments.id = $1
        AND assignments.contractor_profile_id = $2
        AND assignments.job_id = $3
        AND assignments.membership_id = $4
      FOR UPDATE OF assignments`,
    [assignmentId, businessId, jobId, membershipId]
  );
  return result.rows[0] || null;
}

function durationSeconds(row) {
  if (!row.clocked_out_at) return null;
  const start = new Date(row.clocked_in_at).getTime();
  const end = new Date(row.clocked_out_at).getTime();
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 1000))
    : null;
}

function serializeSession(row = {}) {
  return {
    id: row.id,
    businessId: Number(row.contractor_profile_id),
    membershipId: row.membership_id,
    userId: Number(row.user_id),
    employeeName: row.employee_name || row.username || null,
    category: row.category,
    jobId: row.job_id || null,
    jobTitle: row.job_title || null,
    assignmentId: row.assignment_id || null,
    assignmentActivationVersion: row.assignment_activation_version == null
      ? null : Number(row.assignment_activation_version),
    clockedInAt: iso(row.clocked_in_at),
    clockedOutAt: iso(row.clocked_out_at),
    durationSeconds: durationSeconds(row),
    clockInLocation: {
      status: row.clock_in_location_status,
      latitude: row.clock_in_latitude == null ? null : Number(row.clock_in_latitude),
      longitude: row.clock_in_longitude == null ? null : Number(row.clock_in_longitude),
    },
    clockOutLocation: row.clock_out_location_status ? {
      status: row.clock_out_location_status,
      latitude: row.clock_out_latitude == null ? null : Number(row.clock_out_latitude),
      longitude: row.clock_out_longitude == null ? null : Number(row.clock_out_longitude),
    } : null,
  };
}

const TIME_HISTORY_SELECT = `
  SELECT sessions.*, users.username AS employee_name, posts.title AS job_title
    FROM business_time_sessions sessions
    JOIN users ON users.id = sessions.user_id
    LEFT JOIN jobs ON jobs.id = sessions.job_id
    LEFT JOIN posts ON posts.id = jobs.job_request_id`;

async function loadHistory(database, businessId, membershipId = null) {
  const result = await database.query(
    `${TIME_HISTORY_SELECT}
      WHERE sessions.contractor_profile_id = $1
        AND ($2::uuid IS NULL OR sessions.membership_id = $2)
      ORDER BY sessions.clocked_in_at DESC, sessions.id DESC
      LIMIT 200`,
    [businessId, membershipId]
  );
  return result.rows.map(serializeSession);
}

async function listOwnTime({ pool, authenticatedActor, businessId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "TIME_BUSINESS_INVALID", "Exact business identity is required.");
  return withTransaction(pool, async (client) => {
    const actor = await loadActor(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "TIME_SELF_VIEW")) {
      return failure(403, "TIME_SELF_PERMISSION_REQUIRED", "This Team role cannot view employee time.");
    }
    const sessions = await loadHistory(client, normalizedBusinessId, actor.id);
    return {
      ok: true, status: 200, code: "EMPLOYEE_TIME_LOADED",
      serverNow: new Date().toISOString(),
      activeSession: sessions.find((session) => !session.clockedOutAt) || null,
      sessions,
    };
  }, { readOnly: true });
}

async function listTeamTime({ pool, authenticatedActor, businessId, membershipId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedMembershipId = membershipId == null || String(membershipId).trim() === ""
    ? null : uuid(membershipId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || (membershipId && !normalizedMembershipId)) {
    return failure(400, "TIME_TEAM_REQUEST_INVALID", "Exact business and optional membership identity are required.");
  }
  return withTransaction(pool, async (client) => {
    const actor = await loadActor(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "TIME_TEAM_VIEW")) {
      return failure(403, "TIME_TEAM_PERMISSION_REQUIRED", "This Team role cannot view Team time evidence.");
    }
    return {
      ok: true, status: 200, code: "TEAM_TIME_LOADED",
      serverNow: new Date().toISOString(),
      sessions: await loadHistory(client, normalizedBusinessId, normalizedMembershipId),
    };
  }, { readOnly: true });
}

async function findCommand(database, actorMembershipId, key) {
  const result = await database.query(
    `SELECT * FROM business_time_commands
      WHERE actor_membership_id = $1 AND idempotency_key = $2
      FOR UPDATE`,
    [actorMembershipId, key]
  );
  return result.rows[0] || null;
}

function replay(command, expectedFingerprint, code) {
  if (command.request_fingerprint !== expectedFingerprint) {
    return failure(409, "TIME_IDEMPOTENCY_CONFLICT", "The idempotency key is already bound to another time action.");
  }
  if (!command.completed_at || !command.result_reference) {
    return failure(409, "TIME_COMMAND_IN_PROGRESS", "The time action is still in progress.");
  }
  return { ok: true, status: 200, code, replayed: true, ...command.result_reference };
}

async function clockIn({ pool, authenticatedActor, businessId, category, jobId, assignmentId, location, idempotencyKey }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedCategory = String(category || "").trim().toUpperCase();
  const normalizedJobId = jobId == null || String(jobId).trim() === "" ? null : uuid(jobId);
  const normalizedAssignmentId = assignmentId == null || String(assignmentId).trim() === "" ? null : uuid(assignmentId);
  const normalizedLocation = normalizeLocation(location);
  const key = normalizeIdempotencyKey(idempotencyKey);
  const jobWork = normalizedCategory === "JOB_WORK";
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !TIME_CATEGORIES.includes(normalizedCategory) || !normalizedLocation || !key ||
      (jobWork && (!normalizedJobId || !normalizedAssignmentId)) ||
      (!jobWork && (normalizedJobId || normalizedAssignmentId))) {
    return failure(400, "TIME_CLOCK_IN_REQUEST_INVALID", "Exact category and governed time identity are required.");
  }
  return withTransaction(pool, async (client) => {
    const actor = await loadActor(client, actorId, normalizedBusinessId, { lock: true });
    if (!actor || !permissionForRole(actor.role, "TIME_SELF_ACTION")) {
      return failure(403, "TIME_ACTION_PERMISSION_REQUIRED", "An active Team membership with time authority is required.");
    }
    let assignment = null;
    let activationVersion = null;
    if (jobWork) {
      assignment = await loadAssignment(client, normalizedBusinessId, normalizedJobId, normalizedAssignmentId, actor.id);
      activationVersion = positiveInteger(assignment?.activation_version);
      if (!assignment || assignment.state !== "ACTIVE" || !activationVersion) {
        return failure(403, "TIME_JOB_ASSIGNMENT_REQUIRED", "Job Work requires your exact active Job assignment.");
      }
    }
    const requestFingerprint = fingerprint({
      action: "CLOCK_IN", businessId: normalizedBusinessId, membershipId: actor.id,
      category: normalizedCategory, jobId: normalizedJobId, assignmentId: normalizedAssignmentId,
      assignmentActivationVersion: activationVersion, location: normalizedLocation,
    });
    const existing = await findCommand(client, actor.id, key);
    if (existing) return replay(existing, requestFingerprint, "TIME_CLOCKED_IN");
    const activeResult = await client.query(
      `SELECT id FROM business_time_sessions
        WHERE membership_id = $1 AND clocked_out_at IS NULL FOR UPDATE`,
      [actor.id]
    );
    if (activeResult.rows[0]) {
      return failure(409, "TIME_TIMER_ALREADY_ACTIVE", "Clock Out the current timer before starting another one.");
    }
    const commandResult = await client.query(
      `INSERT INTO business_time_commands
         (contractor_profile_id, actor_membership_id, action, idempotency_key, request_fingerprint)
       VALUES ($1,$2,'CLOCK_IN',$3,$4) RETURNING *`,
      [normalizedBusinessId, actor.id, key, requestFingerprint]
    );
    const sessionResult = await client.query(
      `INSERT INTO business_time_sessions
         (contractor_profile_id, membership_id, user_id, category, job_id, assignment_id,
          assignment_activation_version, clock_in_command_id, clock_in_location_status,
          clock_in_latitude, clock_in_longitude)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [normalizedBusinessId, actor.id, actorId, normalizedCategory, normalizedJobId,
        normalizedAssignmentId, activationVersion, commandResult.rows[0].id,
        normalizedLocation.status, normalizedLocation.latitude, normalizedLocation.longitude]
    );
    await client.query(
      `INSERT INTO business_time_events
         (session_id, contractor_profile_id, membership_id, actor_user_id, event_type, command_id, occurred_at)
       VALUES ($1,$2,$3,$4,'CLOCKED_IN',$5,$6)`,
      [sessionResult.rows[0].id, normalizedBusinessId, actor.id, actorId,
        commandResult.rows[0].id, sessionResult.rows[0].clocked_in_at]
    );
    const resultReference = { session: serializeSession({
      ...sessionResult.rows[0], employee_name: actor.username,
      job_title: assignment?.job_title || null,
    }) };
    await client.query(
      `UPDATE business_time_commands SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND completed_at IS NULL`,
      [commandResult.rows[0].id, JSON.stringify(resultReference)]
    );
    return { ok: true, status: 201, code: "TIME_CLOCKED_IN", replayed: false, ...resultReference };
  });
}

async function clockOut({ pool, authenticatedActor, businessId, sessionId, location, idempotencyKey }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedSessionId = uuid(sessionId);
  const normalizedLocation = normalizeLocation(location);
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedSessionId || !normalizedLocation || !key) {
    return failure(400, "TIME_CLOCK_OUT_REQUEST_INVALID", "Exact active timer identity is required.");
  }
  return withTransaction(pool, async (client) => {
    const actor = await loadActor(client, actorId, normalizedBusinessId, { lock: true });
    if (!actor || !permissionForRole(actor.role, "TIME_SELF_ACTION")) {
      return failure(403, "TIME_ACTION_PERMISSION_REQUIRED", "An active Team membership with time authority is required.");
    }
    const requestFingerprint = fingerprint({
      action: "CLOCK_OUT", businessId: normalizedBusinessId,
      membershipId: actor.id, sessionId: normalizedSessionId, location: normalizedLocation,
    });
    const existing = await findCommand(client, actor.id, key);
    if (existing) return replay(existing, requestFingerprint, "TIME_CLOCKED_OUT");
    const sessionResult = await client.query(
      `${TIME_HISTORY_SELECT}
        WHERE sessions.id = $1
          AND sessions.contractor_profile_id = $2
          AND sessions.membership_id = $3
        FOR UPDATE OF sessions`,
      [normalizedSessionId, normalizedBusinessId, actor.id]
    );
    const active = sessionResult.rows[0];
    if (!active || active.clocked_out_at) {
      return failure(409, "TIME_NO_ACTIVE_TIMER", "No matching active timer is available to Clock Out.");
    }
    const commandResult = await client.query(
      `INSERT INTO business_time_commands
         (contractor_profile_id, actor_membership_id, action, idempotency_key, request_fingerprint)
       VALUES ($1,$2,'CLOCK_OUT',$3,$4) RETURNING *`,
      [normalizedBusinessId, actor.id, key, requestFingerprint]
    );
    const closedResult = await client.query(
      `UPDATE business_time_sessions
          SET clock_out_command_id = $2, clock_out_source = 'MEETRO_CLIENT',
              clock_out_location_status = $3, clock_out_latitude = $4,
              clock_out_longitude = $5, clocked_out_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND clocked_out_at IS NULL RETURNING *`,
      [active.id, commandResult.rows[0].id, normalizedLocation.status,
        normalizedLocation.latitude, normalizedLocation.longitude]
    );
    if (!closedResult.rows[0]) return failure(409, "TIME_NO_ACTIVE_TIMER", "The timer is no longer active.");
    const closed = { ...closedResult.rows[0], employee_name: actor.username, job_title: active.job_title };
    await client.query(
      `INSERT INTO business_time_events
         (session_id, contractor_profile_id, membership_id, actor_user_id, event_type, command_id, occurred_at)
       VALUES ($1,$2,$3,$4,'CLOCKED_OUT',$5,$6)`,
      [closed.id, normalizedBusinessId, actor.id, actorId, commandResult.rows[0].id, closed.clocked_out_at]
    );
    const resultReference = { session: serializeSession(closed) };
    await client.query(
      `UPDATE business_time_commands SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND completed_at IS NULL`,
      [commandResult.rows[0].id, JSON.stringify(resultReference)]
    );
    return { ok: true, status: 200, code: "TIME_CLOCKED_OUT", replayed: false, ...resultReference };
  });
}

module.exports = {
  LOCATION_STATUSES,
  TIME_CATEGORIES,
  clockIn,
  clockOut,
  fingerprint,
  listOwnTime,
  listTeamTime,
  normalizeIdempotencyKey,
  normalizeLocation,
  serializeSession,
};
