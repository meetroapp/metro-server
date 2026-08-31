"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  FIELD_STATUSES,
  NEXT_FIELD_STATUS,
  fingerprint,
  listFieldOperations,
  normalizeIdempotencyKey,
} = require("../server/team/fieldOperationsService");
const { registerFieldOperationsRoutes } = require("../server/team/fieldOperations");
const { permissionForRole } = require("../server/team/teamService");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "migrations", "202608300007_create_business_job_field_operations_authority.sql"), "utf8");
const service = fs.readFileSync(path.join(root, "server", "team", "fieldOperationsService.js"), "utf8");
const JOB_ID = "072c8736-5d97-4253-ba3e-dd1bce281a20";
const ASSIGNMENT_ID = "a7c9a660-c087-4af1-b139-8d77f8d69b33";

function result(rows = []) { return { rows }; }

test("Migration 71 defines append-only exact-assignment field evidence without backfill", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS business_job_field_status_commands/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS business_job_field_status_events/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS business_job_field_messages/i);
  assert.match(migration, /ASSIGNED.+ON_MY_WAY.+ARRIVED.+WORKING.+FIELD_WORK_COMPLETED/is);
  assert.match(migration, /Field status transition is not the next exact transition/i);
  assert.match(migration, /Only the assigned Field Employee may record field status/i);
  assert.match(migration, /Field message sender lacks exact Job authority/i);
  assert.match(migration, /Business Job field evidence is append-only/i);
  assert.match(migration, /UNIQUE \(actor_membership_id, assignment_id, idempotency_key\)/i);
  assert.match(migration, /UNIQUE \(sender_membership_id, assignment_id, idempotency_key\)/i);
  assert.doesNotMatch(migration, /INSERT INTO (?:jobs|canonical_invoices|invoice_payments|deposit_requests|professional_subscriptions|canonical_alerts)/i);
});

test("field status authority is the exact strict forward lifecycle", () => {
  assert.deepEqual(FIELD_STATUSES, ["ASSIGNED", "ON_MY_WAY", "ARRIVED", "WORKING", "FIELD_WORK_COMPLETED"]);
  assert.deepEqual(NEXT_FIELD_STATUS, {
    ASSIGNED: "ON_MY_WAY",
    ON_MY_WAY: "ARRIVED",
    ARRIVED: "WORKING",
    WORKING: "FIELD_WORK_COMPLETED",
  });
  assert.equal(NEXT_FIELD_STATUS.FIELD_WORK_COMPLETED, undefined);
});

test("preset permissions preserve role boundaries", () => {
  assert.equal(permissionForRole("OWNER", "FIELD_OPERATIONS_VIEW"), true);
  assert.equal(permissionForRole("MANAGER", "FIELD_OPERATIONS_VIEW"), true);
  assert.equal(permissionForRole("OWNER", "FIELD_COMMUNICATION"), true);
  assert.equal(permissionForRole("MANAGER", "FIELD_COMMUNICATION"), true);
  assert.equal(permissionForRole("FIELD_EMPLOYEE", "FIELD_COMMUNICATION"), true);
  assert.equal(permissionForRole("FIELD_EMPLOYEE", "FIELD_STATUS_UPDATE"), true);
  assert.equal(permissionForRole("OWNER", "FIELD_STATUS_UPDATE"), false);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "FIELD_OPERATIONS_VIEW"), false);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "FIELD_COMMUNICATION"), false);
});

test("commands normalize fail closed and fingerprints bind exact request identity", () => {
  assert.equal(normalizeIdempotencyKey(" status-1 "), "status-1");
  assert.equal(normalizeIdempotencyKey(""), null);
  assert.equal(normalizeIdempotencyKey("x".repeat(201)), null);
  assert.match(fingerprint({ assignmentId: ASSIGNMENT_ID, status: "ARRIVED" }), /^[0-9a-f]{64}$/);
  assert.notEqual(
    fingerprint({ assignmentId: ASSIGNMENT_ID, status: "ARRIVED" }),
    fingerprint({ assignmentId: ASSIGNMENT_ID, status: "WORKING" })
  );
});

test("Bookkeeper access fails before assignment or field evidence is read", async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (/^BEGIN|^ROLLBACK/.test(sql)) return result();
      if (/FROM business_team_memberships memberships/.test(sql)) {
        return result([{ id: "ad20a676-c37a-48de-9e2c-7e4d443fdfc7", role: "BOOKKEEPER_FINANCE" }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const response = await listFieldOperations({
    pool, authenticatedActor: { id: 14 }, businessId: 17,
    jobId: JOB_ID, assignmentId: ASSIGNMENT_ID,
  });
  assert.equal(response.code, "FIELD_OPERATIONS_PERMISSION_REQUIRED");
  assert.equal(calls.some((sql) => /business_job_field_status_events/.test(sql)), false);
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("field communication is isolated from customer conversations and commercial state", () => {
  assert.doesNotMatch(service, /\bconversations\b|conversation_participants|quote_request_id/i);
  assert.doesNotMatch(service, /UPDATE\s+(?:jobs|canonical_|deposit_|invoice_|professional_subscriptions)/i);
  assert.match(service, /business_job_field_messages/);
  assert.match(service, /role IN \('OWNER', 'MANAGER'\)/);
  assert.match(service, /destination: \{ type: "job", payload: \{ jobId: assignment\.job_id \} \}/);
  assert.match(service, /\["ON_MY_WAY", "ARRIVED", "FIELD_WORK_COMPLETED"\]/);
});

test("field operation routes extend existing Team and My Jobs surfaces", () => {
  const routes = [];
  const app = {
    get(pathname, ...handlers) { routes.push(["GET", pathname, handlers.length]); },
    post(pathname, ...handlers) { routes.push(["POST", pathname, handlers.length]); },
  };
  registerFieldOperationsRoutes({
    app,
    authMiddleware() {},
    getPool() {},
    sendPublicDatabaseError() {},
  });
  assert.deepEqual(routes.map(([method, pathname]) => [method, pathname]), [
    ["GET", "/team/jobs/:jobId/field-communications"],
    ["GET", "/team/jobs/:jobId/field-operations"],
    ["POST", "/team/jobs/:jobId/field-messages"],
    ["GET", "/employee/jobs/:jobId/field-operations"],
    ["POST", "/employee/jobs/:jobId/field-status"],
    ["POST", "/employee/jobs/:jobId/field-messages"],
    ["GET", "/employee/alerts/:alertId/team-message-destination"],
  ]);
});
