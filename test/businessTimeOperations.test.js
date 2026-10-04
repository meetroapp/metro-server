"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const settingsService = require("../server/team/businessTimeSettingsService");
const operationsService = require("../server/team/timeOperationsService");
const { ROLE_PERMISSIONS } = require("../server/team/teamService");
const { registerBusinessTimeSettingsRoutes } = require("../server/team/businessTimeSettings");
const { registerTimeOperationsRoutes } = require("../server/team/timeOperations");

const root = path.join(__dirname, "..");
const migration72Path = path.join(root, "migrations", "202608300008_create_business_time_evidence_authority.sql");
const migration73Path = path.join(root, "migrations", "202608300009_add_business_time_settings_authority.sql");
const migration73 = fs.readFileSync(migration73Path, "utf8");

function actor(overrides = {}) {
  return {
    id: 7,
    business_name: "Exact Business",
    membership_id: "11111111-1111-4111-8111-111111111111",
    role: "OWNER",
    status: "ACTIVE",
    time_zone: "America/New_York",
    week_start_day: "MONDAY",
    time_settings_updated_at: "2026-08-30T12:00:00.000Z",
    time_settings_updated_by_membership_id: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

function mockPool({ actorRow = actor(), operationRows = [], updateRow = null } = {}) {
  const queries = [];
  const pool = {
    queries,
    async connect() { return this; },
    release() {},
    async query(text, params = []) {
      queries.push({ text, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
      if (/SELECT profiles\.id, profiles\.business_name/.test(text)) {
        return { rows: actorRow ? [actorRow] : [] };
      }
      if (/UPDATE contractor_profiles/.test(text)) {
        return { rows: [updateRow || {
          ...actorRow,
          time_zone: params[1],
          week_start_day: params[2],
        }] };
      }
      return { rows: operationRows };
    },
  };
  return pool;
}

test("Migration 73 adds nullable governed Business time settings without rewriting deployed evidence", () => {
  assert.match(migration73, /ALTER TABLE contractor_profiles/i);
  assert.match(migration73, /ADD COLUMN IF NOT EXISTS time_zone TEXT/i);
  assert.match(migration73, /ADD COLUMN IF NOT EXISTS week_start_day TEXT/i);
  assert.match(migration73, /time_settings_updated_by_membership_id UUID/i);
  assert.match(migration73, /REFERENCES business_team_memberships\(id, contractor_profile_id\)/i);
  assert.match(migration73, /'SUNDAY'.*'MONDAY'.*'TUESDAY'/is);
  assert.doesNotMatch(migration73, /DEFAULT\s+(?:'UTC'|'America\/New_York'|'MONDAY'|'SUNDAY')/i);
  assert.doesNotMatch(migration73, /^\s*(?:INSERT|UPDATE|DELETE)\s/im);
  const checksum72 = crypto.createHash("sha256").update(fs.readFileSync(migration72Path)).digest("hex");
  assert.equal(checksum72, "221e30dd89fd080e13775722a0c264e555c91f602aed4905f6ad051861ec844d");
});

test("server normalizes supported IANA zones and governed week-start values", () => {
  assert.equal(settingsService.normalizeTimeZone("America/New_York"), "America/New_York");
  assert.equal(settingsService.normalizeTimeZone("US/Eastern"), "America/New_York");
  for (const invalid of ["", "EST", "EDT", "Eastern", "GMT-5", "Not/AZone"]) {
    assert.equal(settingsService.normalizeTimeZone(invalid), null);
  }
  assert.equal(settingsService.normalizeWeekStartDay(" monday "), "MONDAY");
  assert.equal(settingsService.normalizeWeekStartDay("PAYROLL_WEEK"), null);
});

test("only Owner has Business time-settings mutation permission", () => {
  assert.ok(ROLE_PERMISSIONS.OWNER.includes("TIME_SETTINGS_MANAGE"));
  for (const role of ["MANAGER", "BOOKKEEPER_FINANCE", "FIELD_EMPLOYEE"]) {
    assert.equal(ROLE_PERMISSIONS[role].includes("TIME_SETTINGS_MANAGE"), false);
  }
});

test("Owner can update exact Business settings and no canonical session is touched", async () => {
  const pool = mockPool();
  const result = await settingsService.updateBusinessTimeSettings({
    pool,
    authenticatedActor: { id: 10 },
    businessId: 7,
    timeZone: "America/Chicago",
    weekStartDay: "SUNDAY",
  });
  assert.equal(result.ok, true);
  assert.equal(result.settings.timeZone, "America/Chicago");
  assert.equal(result.settings.weekStartDay, "SUNDAY");
  assert.equal(result.settings.canManage, true);
  assert.equal(pool.queries.some(({ text }) => /UPDATE business_time_sessions/i.test(text)), false);
});

test("Manager, Bookkeeper, Field Employee, and cross-Business settings writes fail closed", async () => {
  for (const role of ["MANAGER", "BOOKKEEPER_FINANCE", "FIELD_EMPLOYEE"]) {
    const result = await settingsService.updateBusinessTimeSettings({
      pool: mockPool({ actorRow: actor({ role }) }),
      authenticatedActor: { id: 10 }, businessId: 7,
      timeZone: "America/New_York", weekStartDay: "MONDAY",
    });
    assert.equal(result.code, "BUSINESS_TIME_SETTINGS_OWNER_REQUIRED");
  }
  const crossBusiness = await settingsService.updateBusinessTimeSettings({
    pool: mockPool({ actorRow: null }), authenticatedActor: { id: 10 }, businessId: 8,
    timeZone: "America/New_York", weekStartDay: "MONDAY",
  });
  assert.equal(crossBusiness.code, "BUSINESS_TIME_SETTINGS_OWNER_REQUIRED");
});

test("invalid timezone and week start are rejected before persistence", async () => {
  const pool = mockPool();
  const badZone = await settingsService.updateBusinessTimeSettings({
    pool, authenticatedActor: { id: 10 }, businessId: 7, timeZone: "EST", weekStartDay: "MONDAY",
  });
  const badWeek = await settingsService.updateBusinessTimeSettings({
    pool, authenticatedActor: { id: 10 }, businessId: 7, timeZone: "America/New_York", weekStartDay: "PAYROLL_WEEK",
  });
  assert.equal(badZone.code, "BUSINESS_TIME_ZONE_INVALID");
  assert.equal(badWeek.code, "BUSINESS_WEEK_START_INVALID");
  assert.equal(pool.queries.length, 0);
});

test("missing settings block Today and This Week without persisting a device timezone", async () => {
  const pool = mockPool({ actorRow: actor({
    time_zone: null,
    week_start_day: null,
    time_settings_updated_at: null,
    time_settings_updated_by_membership_id: null,
  }) });
  const today = await operationsService.getTeamToday({ pool, authenticatedActor: { id: 10 }, businessId: 7 });
  const week = await operationsService.getTimesheets({ pool, authenticatedActor: { id: 10 }, businessId: 7, range: "THIS_WEEK" });
  assert.equal(today.code, "BUSINESS_TIME_SETTINGS_REQUIRED");
  assert.equal(week.code, "BUSINESS_TIME_SETTINGS_REQUIRED");
  assert.equal(pool.queries.some(({ text }) => /UPDATE contractor_profiles/i.test(text)), false);
});

test("Today and This Week boundaries use Business timezone and explicit week start", () => {
  const now = new Date("2026-08-30T15:00:00.000Z");
  const today = operationsService.buildTimeRange({
    now, timeZone: "America/New_York", weekStartDay: "MONDAY", range: "TODAY",
  });
  assert.deepEqual(today, {
    range: "TODAY",
    localStartDate: "2026-08-30",
    localEndDateExclusive: "2026-08-31",
    startsAt: "2026-08-30T04:00:00.000Z",
    endsAt: "2026-08-31T04:00:00.000Z",
  });
  const mondayWeek = operationsService.buildTimeRange({
    now, timeZone: "America/New_York", weekStartDay: "MONDAY", range: "THIS_WEEK",
  });
  assert.equal(mondayWeek.localStartDate, "2026-08-24");
  assert.equal(mondayWeek.localEndDateExclusive, "2026-08-31");
  const sundayWeek = operationsService.buildTimeRange({
    now, timeZone: "America/New_York", weekStartDay: "SUNDAY", range: "THIS_WEEK",
  });
  assert.equal(sundayWeek.localStartDate, "2026-08-30");
});

test("cross-midnight sessions group once by Business-local Clock In date", () => {
  const projected = operationsService.serializeProjectedSession({
    id: "session-1",
    membership_id: "member-1",
    employee_name: "Carlos",
    role: "FIELD_EMPLOYEE",
    category: "DRIVING",
    job_id: null,
    job_title: null,
    assignment_id: null,
    clocked_in_at: "2026-08-31T03:30:00.000Z",
    clocked_out_at: "2026-08-31T04:30:00.000Z",
    clock_in_location_status: "NOT_REQUESTED",
    clock_out_location_status: "NOT_REQUESTED",
  }, "America/New_York");
  assert.equal(projected.localDate, "2026-08-30");
  assert.equal(projected.durationSeconds, 3600);
  assert.equal(projected.jobId, null);
  assert.equal(projected.jobTitle, null);
});

test("completed totals exclude active provisional time and preserve exact Job identity", () => {
  const grouped = operationsService.groupTimesheetSessions([
    {
      id: "one", membershipId: "member-1", employeeName: "Carlos", role: "FIELD_EMPLOYEE",
      localDate: "2026-08-30", category: "JOB_WORK", jobId: "job-exact",
      durationSeconds: 3600, active: false,
    },
    {
      id: "two", membershipId: "member-1", employeeName: "Carlos", role: "FIELD_EMPLOYEE",
      localDate: "2026-08-30", category: "OFFICE", jobId: null,
      durationSeconds: null, active: true,
    },
  ]);
  assert.equal(grouped.completedTotalSeconds, 3600);
  assert.equal(grouped.categoryTotals.JOB_WORK, 3600);
  assert.equal(grouped.categoryTotals.OFFICE, undefined);
  assert.equal(grouped.groups[0].sessions[0].jobId, "job-exact");
  assert.equal(grouped.groups[0].sessions[1].jobId, null);
});

test("role-aware Timesheets return Team scope or exact self scope", async () => {
  for (const role of ["OWNER", "MANAGER", "BOOKKEEPER_FINANCE"]) {
    const pool = mockPool({ actorRow: actor({ role }) });
    const result = await operationsService.getTimesheets({
      pool, authenticatedActor: { id: 10 }, businessId: 7, range: "TODAY",
    });
    assert.equal(result.scope, "TEAM");
    const query = pool.queries.find(({ text }) => /FROM business_time_sessions sessions/.test(text));
    assert.equal(query.params[3], null);
  }
  const fieldPool = mockPool({ actorRow: actor({ role: "FIELD_EMPLOYEE" }) });
  const field = await operationsService.getTimesheets({
    pool: fieldPool, authenticatedActor: { id: 10 }, businessId: 7, range: "THIS_WEEK",
  });
  assert.equal(field.scope, "SELF");
  const query = fieldPool.queries.find(({ text }) => /FROM business_time_sessions sessions/.test(text));
  assert.equal(query.params[3], actor().membership_id);
});

test("Team Today excludes deactivated memberships at the authoritative query", async () => {
  const pool = mockPool({ actorRow: actor({ role: "MANAGER" }), operationRows: [] });
  const result = await operationsService.getTeamToday({
    pool, authenticatedActor: { id: 10 }, businessId: 7,
  });
  assert.equal(result.ok, true);
  const query = pool.queries.find(({ text }) => /FROM business_team_memberships memberships/.test(text) && /LEFT JOIN LATERAL/.test(text));
  assert.match(query.text, /memberships\.status = 'ACTIVE'/);
  assert.match(query.text, /sessions\.clocked_out_at IS NULL/);
  assert.equal(pool.queries.some(({ text }) => /^\s*(?:INSERT|UPDATE|DELETE)\s/im.test(text)), false);
});

test("Bookkeeper cannot view Team Today and Field Employee cannot view other Team time", async () => {
  const bookkeeper = await operationsService.getTeamToday({
    pool: mockPool({ actorRow: actor({ role: "BOOKKEEPER_FINANCE" }) }),
    authenticatedActor: { id: 10 }, businessId: 7,
  });
  assert.equal(bookkeeper.code, "TEAM_TODAY_PERMISSION_REQUIRED");
  const field = await operationsService.getTeamToday({
    pool: mockPool({ actorRow: actor({ role: "FIELD_EMPLOYEE" }) }),
    authenticatedActor: { id: 10 }, businessId: 7,
  });
  assert.equal(field.code, "TEAM_TODAY_PERMISSION_REQUIRED");
});

test("authenticated no-store routes expose only governed settings and projections", () => {
  const routes = [];
  const app = {
    get(pathname, ...handlers) { routes.push(["GET", pathname, handlers]); },
    put(pathname, ...handlers) { routes.push(["PUT", pathname, handlers]); },
  };
  const authMiddleware = () => {};
  const dependencies = {
    app, authMiddleware, getPool: () => ({}), sendPublicDatabaseError: () => {},
  };
  registerBusinessTimeSettingsRoutes(dependencies);
  registerTimeOperationsRoutes(dependencies);
  assert.deepEqual(routes.map(([method, pathname]) => `${method} ${pathname}`), [
    "GET /team/time-settings",
    "PUT /team/time-settings",
    "GET /team/today",
    "GET /team/timesheets",
  ]);
  assert.ok(routes.every(([, , handlers]) => handlers[0] === authMiddleware));
});
