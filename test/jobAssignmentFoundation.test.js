"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ASSIGNABLE_ROLES,
  ASSIGNMENT_MANAGER_ROLES,
  assignmentFingerprint,
  listEmployeeJobs,
  listEmployeeSchedule,
  listManagedJobs,
  normalizeMembershipIds,
  projectJobs,
  setJobAssignments,
} = require("../server/team/jobAssignmentService");
const {
  registerJobAssignmentRoutes,
} = require("../server/team/jobAssignments");

const migrationSql = fs.readFileSync(path.join(
  __dirname,
  "..",
  "migrations",
  "202608300006_create_business_job_assignment_authority.sql"
), "utf8");
const serviceSource = fs.readFileSync(path.join(
  __dirname,
  "..",
  "server",
  "team",
  "jobAssignmentService.js"
), "utf8");

const BUSINESS_ID = 17;
const OWNER_USER_ID = 7;
const OWNER_MEMBERSHIP_ID = "8f0ad977-2018-48b2-a67c-2397cad84b85";
const FIELD_MEMBERSHIP_ID = "7ee4a7d1-216b-464b-a35d-19ee37a82bb2";
const JOB_ID = "072c8736-5d97-4253-ba3e-dd1bce281a20";

function result(rows = []) {
  return { rows };
}

function readPool(handler) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return result();
      return handler(sql, values, calls);
    },
  };
  return { ...client, calls };
}

test("Migration 70 defines exact assignment, command, and append-only lifecycle evidence", () => {
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS business_job_assignment_commands/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS business_job_assignments/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS business_job_assignment_events/i);
  assert.match(migrationSql, /UNIQUE \(contractor_profile_id, job_id, membership_id\)/i);
  assert.match(migrationSql, /ASSIGNED.+CHANGED.+REASSIGNED.+UNASSIGNED/is);
  assert.match(migrationSql, /Job does not belong to the exact business/i);
  assert.match(migrationSql, /role IN \('MANAGER', 'FIELD_EMPLOYEE'\)/i);
  assert.match(migrationSql, /role IN \('OWNER', 'MANAGER'\)/i);
  assert.match(migrationSql, /reject_business_job_assignment_history_mutation/i);
  assert.match(migrationSql, /DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(migrationSql, /Assignment state requires exact durable event evidence/i);
  assert.match(migrationSql, /ON DELETE RESTRICT/i);
  assert.doesNotMatch(migrationSql, /INSERT INTO business_job_assignments|INSERT INTO canonical_alerts|canonical_invoices|invoice_payments|professional_subscriptions/i);
});

test("role authority allows assignment management only for Owner and Manager", () => {
  assert.deepEqual(ASSIGNMENT_MANAGER_ROLES, ["OWNER", "MANAGER"]);
  assert.deepEqual(ASSIGNABLE_ROLES, ["MANAGER", "FIELD_EMPLOYEE"]);
  assert.equal(ASSIGNMENT_MANAGER_ROLES.includes("BOOKKEEPER_FINANCE"), false);
  assert.equal(ASSIGNMENT_MANAGER_ROLES.includes("FIELD_EMPLOYEE"), false);
  assert.equal(ASSIGNABLE_ROLES.includes("BOOKKEEPER_FINANCE"), false);
});

test("exact membership-set fingerprints are ordered, stable, and duplicate-free", () => {
  const other = "64296194-101d-4400-a078-7eed19dd315c";
  assert.deepEqual(
    normalizeMembershipIds([FIELD_MEMBERSHIP_ID, other, FIELD_MEMBERSHIP_ID]),
    [other, FIELD_MEMBERSHIP_ID]
  );
  const first = assignmentFingerprint({
    businessId: BUSINESS_ID,
    jobId: JOB_ID,
    membershipIds: [FIELD_MEMBERSHIP_ID, other],
  });
  const replay = assignmentFingerprint({
    businessId: BUSINESS_ID,
    jobId: JOB_ID,
    membershipIds: [other, FIELD_MEMBERSHIP_ID],
  });
  assert.equal(first, replay);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(normalizeMembershipIds(["not-a-membership"]), null);
});

test("employee Job projection contains authorized customer, location, scope, photos, and document summary", () => {
  const jobs = projectJobs([
    {
      job_id: JOB_ID,
      job_title: "Repair cabinet",
      job_description: "Protect the countertop before work.",
      job_category: "Carpentry",
      customer_name: "Antony Guzman",
      location_normalization_status: "normalized",
      location_intake_mode: "exact_on_file",
      service_address_line1: "10 Main St",
      service_city: "Miami",
      service_region: "FL",
      service_postal_code: "33101",
      service_country_code: "US",
      request_photos: [{ secure_url: "https://example.test/job.jpg", display_order: 0 }],
      job_created_at: "2026-08-30T12:00:00.000Z",
    },
  ], [
    {
      id: "a7c9a660-c087-4af1-b139-8d77f8d69b33",
      contractor_profile_id: BUSINESS_ID,
      job_id: JOB_ID,
      membership_id: FIELD_MEMBERSHIP_ID,
      member_user_id: 22,
      member_role: "FIELD_EMPLOYEE",
      member_status: "ACTIVE",
      state: "ACTIVE",
      version: 1,
      initial_assigned_at: "2026-08-30T12:01:00.000Z",
      last_state_changed_at: "2026-08-30T12:01:00.000Z",
    },
  ], [
    {
      job_id: JOB_ID,
      quote_id: "f1858dc5-0c68-4296-af12-2e714ee8a42a",
      quote_version: 3,
      decided_at: "2026-08-30T12:02:00.000Z",
      scope_item_id: "aa0e1c62-1411-47d2-b499-7ab53d1d57cd",
      sequence: 1,
      description: "Replace damaged trim",
      quantity: 3,
      classification: "LABOR_SERVICE",
    },
  ], { employeeMembershipId: FIELD_MEMBERSHIP_ID });
  assert.equal(jobs[0].customer.displayName, "Antony Guzman");
  assert.equal(jobs[0].location.address.line1, "10 Main St");
  assert.equal(jobs[0].instructions, "Protect the countertop before work.");
  assert.equal(jobs[0].approvedScope[0].description, "Replace damaged trim");
  assert.equal(jobs[0].photos[0].url, "https://example.test/job.jpg");
  assert.deepEqual(jobs[0].documents[0], {
    type: "APPROVED_QUOTE",
    id: "f1858dc5-0c68-4296-af12-2e714ee8a42a",
    version: 3,
    status: "APPROVED",
    approvedAt: "2026-08-30T12:02:00.000Z",
  });
});

test("FIELD_EMPLOYEE read is SQL-bound to only its active assignments", async () => {
  const pool = readPool((sql) => {
    if (/FROM business_team_memberships memberships/.test(sql)) {
      return result([{ id: FIELD_MEMBERSHIP_ID, role: "FIELD_EMPLOYEE", business_name: "Meetro Test" }]);
    }
    if (/FROM contractor_profiles profiles/.test(sql) && /business_job_assignments assignments/.test(sql)) {
      assert.match(sql, /assignments\.membership_id = \$2/);
      assert.match(sql, /assignments\.state = 'ACTIVE'/);
      return result([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const response = await listEmployeeJobs({
    pool,
    authenticatedActor: { id: 22 },
    businessId: BUSINESS_ID,
  });
  assert.equal(response.code, "EMPLOYEE_ASSIGNED_JOBS_LOADED");
  assert.deepEqual(response.jobs, []);
});

test("Bookkeeper/Finance and field roles fail closed at the server authority boundary", async () => {
  const bookkeeperPool = readPool((sql) => {
    if (/FROM business_team_memberships memberships/.test(sql)) {
      return result([{ id: FIELD_MEMBERSHIP_ID, role: "BOOKKEEPER_FINANCE" }]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const bookkeeper = await listEmployeeJobs({
    pool: bookkeeperPool,
    authenticatedActor: { id: 22 },
    businessId: BUSINESS_ID,
  });
  assert.equal(bookkeeper.code, "ASSIGNED_WORK_PERMISSION_REQUIRED");

  const fieldPool = readPool((sql) => {
    if (/FROM business_team_memberships memberships/.test(sql)) {
      return result([{ id: FIELD_MEMBERSHIP_ID, role: "FIELD_EMPLOYEE" }]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const field = await listManagedJobs({
    pool: fieldPool,
    authenticatedActor: { id: 22 },
    businessId: BUSINESS_ID,
  });
  assert.equal(field.code, "JOB_ASSIGNMENT_PERMISSION_REQUIRED");
});

test("employee Schedule is derived only from active assignments and canonical Visit versions", async () => {
  const pool = readPool((sql) => {
    if (/FROM business_team_memberships memberships/.test(sql)) {
      return result([{
        id: FIELD_MEMBERSHIP_ID,
        role: "FIELD_EMPLOYEE",
        business_name: "Meetro Test",
        time_zone: "America/New_York",
      }]);
    }
    if (/FROM business_job_assignments assignments/.test(sql) && /canonical_visits visits/.test(sql)) {
      assert.match(sql, /assignments\.membership_id = \$2/);
      assert.match(sql, /assignments\.state = 'ACTIVE'/);
      assert.match(sql, /versions\.state IN \('PROPOSED', 'SCHEDULED', 'STARTED'\)/);
      return result([{
        visit_id: "6f4d4f35-3f87-4db9-8a96-4f9c2fbe30c2",
        job_id: JOB_ID,
        purpose: "APPROVED_WORK",
        version: 2,
        state: "SCHEDULED",
        scheduled_start_at: "2026-09-01T13:00:00.000Z",
        scheduled_end_at: "2026-09-01T16:00:00.000Z",
        time_zone: "America/New_York",
        location_mode: "REMOTE",
        job_title: "Repair cabinet",
      }]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const response = await listEmployeeSchedule({
    pool,
    authenticatedActor: { id: 22 },
    businessId: BUSINESS_ID,
  });
  assert.equal(response.code, "EMPLOYEE_ASSIGNED_SCHEDULE_LOADED");
  assert.equal(response.timeZone, "America/New_York");
  assert.equal(response.schedule.length, 1);
  assert.equal(response.schedule[0].jobId, JOB_ID);
  assert.equal(response.schedule[0].location.remote, true);
});

test("completed exact-set command replays without another assignment or Alert mutation", async () => {
  const fingerprint = assignmentFingerprint({
    businessId: BUSINESS_ID,
    jobId: JOB_ID,
    membershipIds: [FIELD_MEMBERSHIP_ID],
  });
  const pool = readPool((sql) => {
    if (/FROM business_team_memberships memberships/.test(sql) && /business_name/.test(sql)) {
      return result([{ id: OWNER_MEMBERSHIP_ID, role: "OWNER", business_name: "Meetro Test" }]);
    }
    if (/SELECT jobs\.id AS job_id/.test(sql)) {
      return result([{ job_id: JOB_ID, job_title: "Repair cabinet" }]);
    }
    if (/INSERT INTO business_job_assignment_commands/.test(sql)) return result([]);
    if (/SELECT \* FROM business_job_assignment_commands/.test(sql)) {
      return result([{
        request_fingerprint: fingerprint,
        completed_at: "2026-08-30T13:00:00.000Z",
        result_reference: {
          businessId: BUSINESS_ID,
          jobId: JOB_ID,
          assignments: [],
          events: [],
        },
      }]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const response = await setJobAssignments({
    pool,
    authenticatedActor: { id: OWNER_USER_ID },
    businessId: BUSINESS_ID,
    jobId: JOB_ID,
    membershipIds: [FIELD_MEMBERSHIP_ID],
    idempotencyKey: "exact-command-replay",
  });
  assert.equal(response.code, "BUSINESS_JOB_ASSIGNMENTS_REPLAYED");
  assert.equal(response.replayed, true);
  assert.equal(pool.calls.some(({ sql }) => /INSERT INTO business_job_assignments|INSERT INTO business_job_assignment_events|createCanonical/i.test(sql)), false);
});

test("cross-business or non-field assignment targets fail before any assignment mutation", async () => {
  const pool = readPool((sql) => {
    if (/FROM business_team_memberships memberships/.test(sql) && /business_name/.test(sql)) {
      return result([{ id: OWNER_MEMBERSHIP_ID, role: "OWNER", business_name: "Meetro Test" }]);
    }
    if (/SELECT jobs\.id AS job_id/.test(sql)) {
      return result([{ job_id: JOB_ID, job_title: "Repair cabinet" }]);
    }
    if (/INSERT INTO business_job_assignment_commands/.test(sql)) {
      return result([{ id: "7ac29fbb-c90b-4da5-8476-86e2a9dc4980" }]);
    }
    if (/SELECT memberships\.id/.test(sql)) return result([]);
    throw new Error(`Unexpected query: ${sql}`);
  });
  const response = await setJobAssignments({
    pool,
    authenticatedActor: { id: OWNER_USER_ID },
    businessId: BUSINESS_ID,
    jobId: JOB_ID,
    membershipIds: [FIELD_MEMBERSHIP_ID],
    idempotencyKey: "exact-command-1",
  });
  assert.equal(response.code, "JOB_ASSIGNMENT_TARGET_INVALID");
  assert.equal(pool.calls.some(({ sql }) => /INSERT INTO business_job_assignments/.test(sql)), false);
  assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
});

test("assignment producer uses durable lifecycle events and canonical Alert identities", () => {
  assert.match(serviceSource, /eventType = "ASSIGNED"/);
  assert.match(serviceSource, /'CHANGED'/);
  assert.match(serviceSource, /eventType = "REASSIGNED"/);
  assert.match(serviceSource, /'UNASSIGNED'/);
  assert.match(serviceSource, /createCanonicalLifecycleAlertWithClient/);
  assert.match(serviceSource, /sourceEventId: event\.id/);
  assert.match(serviceSource, /sourceEntityId: assignment\.id/);
  assert.match(serviceSource, /type: "job"/);
  assert.match(serviceSource, /type: "notifications"/);
  assert.doesNotMatch(serviceSource, /canonical_invoices|invoice_payments|deposit_requests|professional_subscriptions|provider_events/i);
});

test("authenticated routes separate management, employee Jobs, and employee Schedule", () => {
  const routes = [];
  const app = {};
  for (const method of ["get", "put"]) {
    app[method] = (pathValue, ...handlers) => routes.push({ method, path: pathValue, handlers });
  }
  const authMiddleware = (_req, _res, next) => next();
  registerJobAssignmentRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError() {},
  });
  assert.deepEqual(routes.map(({ method, path: routePath }) => `${method.toUpperCase()} ${routePath}`), [
    "GET /team/jobs",
    "PUT /team/jobs/:jobId/assignments",
    "GET /employee/jobs",
    "GET /employee/schedule",
  ]);
  routes.forEach((route) => assert.equal(route.handlers[0], authMiddleware));
});
