"use strict";

const { permissionForRole } = require("./teamService");
const { loadActorAndSettings, serializeSettings } = require("./businessTimeSettingsService");

const RANGE_VALUES = Object.freeze(["TODAY", "THIS_WEEK"]);

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function zonedParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const result = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return result;
}

function dateKeyFromParts(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localDateKey(value, timeZone) {
  return dateKeyFromParts(zonedParts(value, timeZone));
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw new TypeError("Invalid local date key.");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addLocalDays(dateKey, days) {
  const parts = parseDateKey(dateKey);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function localMidnightUtc(dateKey, timeZone) {
  const desired = parseDateKey(dateKey);
  const desiredStamp = Date.UTC(desired.year, desired.month - 1, desired.day, 0, 0, 0);
  let candidate = desiredStamp;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const actualStamp = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = desiredStamp - actualStamp;
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate);
}

function buildTimeRange({ now = new Date(), timeZone, weekStartDay, range }) {
  const normalizedRange = String(range || "TODAY").trim().toUpperCase();
  if (!RANGE_VALUES.includes(normalizedRange)) throw new TypeError("Unsupported timesheet range.");
  const today = localDateKey(now, timeZone);
  let startDate = today;
  if (normalizedRange === "THIS_WEEK") {
    const date = parseDateKey(today);
    const todayIndex = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    const weekIndex = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"].indexOf(weekStartDay);
    startDate = addLocalDays(today, -((todayIndex - weekIndex + 7) % 7));
  }
  const endDate = addLocalDays(startDate, normalizedRange === "TODAY" ? 1 : 7);
  return {
    range: normalizedRange,
    localStartDate: startDate,
    localEndDateExclusive: endDate,
    startsAt: localMidnightUtc(startDate, timeZone).toISOString(),
    endsAt: localMidnightUtc(endDate, timeZone).toISOString(),
  };
}

function serializeProjectedSession(row, timeZone) {
  const clockedInAt = iso(row.clocked_in_at);
  const clockedOutAt = iso(row.clocked_out_at);
  let durationSeconds = null;
  if (clockedOutAt) {
    durationSeconds = Math.max(0, Math.floor((new Date(clockedOutAt).getTime() - new Date(clockedInAt).getTime()) / 1000));
  }
  return {
    id: row.id,
    membershipId: row.membership_id,
    employeeName: row.employee_name || "",
    role: row.role || null,
    category: row.category,
    jobId: row.job_id || null,
    jobTitle: row.job_title || null,
    assignmentId: row.assignment_id || null,
    localDate: localDateKey(clockedInAt, timeZone),
    clockedInAt,
    clockedOutAt,
    active: !clockedOutAt,
    durationSeconds,
    clockInLocationStatus: row.clock_in_location_status,
    clockOutLocationStatus: row.clock_out_location_status || null,
  };
}

function groupTimesheetSessions(sessions) {
  const groups = new Map();
  const categoryTotals = {};
  let completedTotalSeconds = 0;
  for (const session of sessions) {
    const key = `${session.membershipId}:${session.localDate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        membershipId: session.membershipId,
        employeeName: session.employeeName,
        role: session.role,
        localDate: session.localDate,
        completedTotalSeconds: 0,
        categoryTotals: {},
        sessions: [],
      });
    }
    const group = groups.get(key);
    group.sessions.push(session);
    if (session.durationSeconds != null) {
      group.completedTotalSeconds += session.durationSeconds;
      group.categoryTotals[session.category] = (group.categoryTotals[session.category] || 0) + session.durationSeconds;
      categoryTotals[session.category] = (categoryTotals[session.category] || 0) + session.durationSeconds;
      completedTotalSeconds += session.durationSeconds;
    }
  }
  return {
    groups: [...groups.values()].sort((left, right) =>
      right.localDate.localeCompare(left.localDate) || left.employeeName.localeCompare(right.employeeName)
    ),
    completedTotalSeconds,
    categoryTotals,
  };
}

async function requireConfiguredActor(pool, authenticatedActor, businessId) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "TEAM_TIME_BUSINESS_INVALID", "Exact business identity is required.");
  const actor = await loadActorAndSettings(pool, actorId, normalizedBusinessId);
  if (!actor) return failure(403, "TEAM_TIME_MEMBERSHIP_REQUIRED", "An active membership in the exact Business is required.");
  if (!actor.time_zone || !actor.week_start_day) {
    return failure(409, "BUSINESS_TIME_SETTINGS_REQUIRED", "The Business Owner must confirm timezone and week start before calendar time can be grouped.");
  }
  return { ok: true, actor, businessId: normalizedBusinessId };
}

async function getTeamToday({ pool, authenticatedActor, businessId }) {
  const authority = await requireConfiguredActor(pool, authenticatedActor, businessId);
  if (!authority.ok) return authority;
  if (!permissionForRole(authority.actor.role, "TEAM_TODAY_VIEW")) {
    return failure(403, "TEAM_TODAY_PERMISSION_REQUIRED", "This Team role cannot view Team Today.");
  }
  const result = await pool.query(
    `SELECT memberships.id AS membership_id, memberships.role, memberships.status,
            users.username AS employee_name,
            timer.id AS timer_id, timer.category AS timer_category,
            timer.clocked_in_at AS timer_started_at,
            timer.job_id AS timer_job_id, timer.assignment_id AS timer_assignment_id,
            timer.clock_in_location_status,
            timer_job.title AS timer_job_title,
            assignment.id AS active_assignment_id, assignment.job_id AS active_assignment_job_id,
            assignment_job.title AS active_assignment_job_title,
            field_status.to_status AS field_status
       FROM business_team_memberships memberships
       JOIN users ON users.id = memberships.user_id
       LEFT JOIN LATERAL (
         SELECT sessions.*
           FROM business_time_sessions sessions
          WHERE sessions.contractor_profile_id = memberships.contractor_profile_id
            AND sessions.membership_id = memberships.id
            AND sessions.clocked_out_at IS NULL
          ORDER BY sessions.clocked_in_at DESC
          LIMIT 1
       ) timer ON TRUE
       LEFT JOIN jobs timer_jobs ON timer_jobs.id = timer.job_id
       LEFT JOIN posts timer_job ON timer_job.id = timer_jobs.job_request_id
       LEFT JOIN LATERAL (
         SELECT assignments.*
           FROM business_job_assignments assignments
          WHERE assignments.contractor_profile_id = memberships.contractor_profile_id
            AND assignments.membership_id = memberships.id
            AND assignments.state = 'ACTIVE'
          ORDER BY assignments.updated_at DESC, assignments.id DESC
          LIMIT 1
       ) assignment ON TRUE
       LEFT JOIN jobs assignment_jobs ON assignment_jobs.id = assignment.job_id
       LEFT JOIN posts assignment_job ON assignment_job.id = assignment_jobs.job_request_id
       LEFT JOIN LATERAL (
         SELECT events.to_status
           FROM business_job_field_status_events events
          WHERE events.assignment_id = COALESCE(timer.assignment_id, assignment.id)
          ORDER BY events.status_version DESC
          LIMIT 1
       ) field_status ON TRUE
      WHERE memberships.contractor_profile_id = $1
        AND memberships.status = 'ACTIVE'
      ORDER BY CASE memberships.role WHEN 'OWNER' THEN 0 ELSE 1 END,
               users.username ASC, memberships.id ASC`,
    [authority.businessId]
  );
  const serverNow = new Date();
  return {
    ok: true,
    status: 200,
    code: "TEAM_TODAY_LOADED",
    serverNow: serverNow.toISOString(),
    settings: serializeSettings(authority.actor),
    members: result.rows.map((row) => ({
      membershipId: row.membership_id,
      employeeName: row.employee_name || "",
      role: row.role,
      membershipStatus: row.status,
      fieldStatus: row.field_status || (row.active_assignment_id ? "ASSIGNED" : null),
      activeAssignment: row.active_assignment_id ? {
        id: row.active_assignment_id,
        jobId: row.active_assignment_job_id,
        jobTitle: row.active_assignment_job_title || null,
      } : null,
      activeTimer: row.timer_id ? {
        id: row.timer_id,
        category: row.timer_category,
        startedAt: iso(row.timer_started_at),
        jobId: row.timer_job_id || null,
        jobTitle: row.timer_job_title || null,
        assignmentId: row.timer_assignment_id || null,
        locationStatus: row.clock_in_location_status,
      } : null,
    })),
  };
}

async function getTimesheets({ pool, authenticatedActor, businessId, range }) {
  const authority = await requireConfiguredActor(pool, authenticatedActor, businessId);
  if (!authority.ok) return authority;
  const canViewTeam = permissionForRole(authority.actor.role, "TIME_TEAM_VIEW");
  const canViewSelf = permissionForRole(authority.actor.role, "TIME_SELF_VIEW");
  if (!canViewTeam && !canViewSelf) {
    return failure(403, "TIMESHEET_PERMISSION_REQUIRED", "This Team role cannot view time evidence.");
  }
  const normalizedRange = String(range || "TODAY").trim().toUpperCase();
  if (!RANGE_VALUES.includes(normalizedRange)) {
    return failure(400, "TIMESHEET_RANGE_INVALID", "Choose Today or This Week.");
  }
  const serverNow = new Date();
  const timeRange = buildTimeRange({
    now: serverNow,
    timeZone: authority.actor.time_zone,
    weekStartDay: authority.actor.week_start_day,
    range: normalizedRange,
  });
  const result = await pool.query(
    `SELECT sessions.*, users.username AS employee_name, memberships.role,
            posts.title AS job_title
       FROM business_time_sessions sessions
       JOIN business_team_memberships memberships
         ON memberships.id = sessions.membership_id
        AND memberships.contractor_profile_id = sessions.contractor_profile_id
       JOIN users ON users.id = sessions.user_id
       LEFT JOIN jobs ON jobs.id = sessions.job_id
       LEFT JOIN posts ON posts.id = jobs.job_request_id
      WHERE sessions.contractor_profile_id = $1
        AND sessions.clocked_in_at >= $2::timestamptz
        AND sessions.clocked_in_at < $3::timestamptz
        AND ($4::uuid IS NULL OR sessions.membership_id = $4)
      ORDER BY sessions.clocked_in_at ASC, sessions.id ASC`,
    [authority.businessId, timeRange.startsAt, timeRange.endsAt, canViewTeam ? null : authority.actor.membership_id]
  );
  const sessions = result.rows.map((row) => serializeProjectedSession(row, authority.actor.time_zone));
  const grouped = groupTimesheetSessions(sessions);
  return {
    ok: true,
    status: 200,
    code: "TIMESHEETS_LOADED",
    serverNow: serverNow.toISOString(),
    scope: canViewTeam ? "TEAM" : "SELF",
    settings: serializeSettings(authority.actor),
    timeRange,
    sessions,
    ...grouped,
  };
}

module.exports = {
  RANGE_VALUES,
  addLocalDays,
  buildTimeRange,
  getTeamToday,
  getTimesheets,
  groupTimesheetSessions,
  localDateKey,
  localMidnightUtc,
  serializeProjectedSession,
  zonedParts,
};

