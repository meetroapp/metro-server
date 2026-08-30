"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  LOCATION_STATUSES,
  TIME_CATEGORIES,
  fingerprint,
  normalizeIdempotencyKey,
  normalizeLocation,
} = require("../server/team/timeEvidenceService");
const { registerTimeEvidenceRoutes } = require("../server/team/timeEvidence");
const { permissionForRole } = require("../server/team/teamService");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "migrations", "202608300008_create_business_time_evidence_authority.sql"), "utf8");
const service = fs.readFileSync(path.join(root, "server", "team", "timeEvidenceService.js"), "utf8");

test("Migration 72 defines governed time evidence without rows or commercial mutation", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS business_time_commands/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS business_time_sessions/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS business_time_events/i);
  assert.match(migration, /business_time_sessions_one_active_uidx/i);
  assert.match(migration, /WHERE clocked_out_at IS NULL/i);
  assert.match(migration, /Job Work requires the exact active assignment/i);
  assert.match(migration, /Inactive Team membership cannot record a time action/i);
  assert.match(migration, /Business time evidence is durable/i);
  assert.doesNotMatch(migration, /INSERT INTO (?:business_time_|canonical_alerts|jobs|canonical_invoices|invoice_payments|deposit_requests|professional_subscriptions)/i);
});

test("time categories and location evidence are bounded", () => {
  assert.deepEqual(TIME_CATEGORIES, ["JOB_WORK", "DRIVING", "OFFICE", "SUPPLIES", "BREAK", "GENERAL"]);
  assert.deepEqual(LOCATION_STATUSES, ["CAPTURED", "UNAVAILABLE", "DENIED", "NOT_REQUESTED"]);
  assert.deepEqual(normalizeLocation(null), { status: "NOT_REQUESTED", latitude: null, longitude: null });
  assert.deepEqual(normalizeLocation({ status: "DENIED" }), { status: "DENIED", latitude: null, longitude: null });
  assert.deepEqual(normalizeLocation({ status: "CAPTURED", latitude: 40.7, longitude: -74 }), { status: "CAPTURED", latitude: 40.7, longitude: -74 });
  assert.equal(normalizeLocation({ status: "CAPTURED", latitude: 95, longitude: -74 }), null);
  assert.equal(normalizeLocation({ status: "DENIED", latitude: 1 }), null);
});

test("time command identity is replay-safe and exact", () => {
  assert.equal(normalizeIdempotencyKey(" clock-1 "), "clock-1");
  assert.equal(normalizeIdempotencyKey(""), null);
  assert.equal(normalizeIdempotencyKey("x".repeat(201)), null);
  assert.match(fingerprint({ action: "CLOCK_IN", category: "JOB_WORK" }), /^[0-9a-f]{64}$/);
  assert.notEqual(
    fingerprint({ action: "CLOCK_IN", category: "JOB_WORK" }),
    fingerprint({ action: "CLOCK_OUT", category: "JOB_WORK" })
  );
});

test("preset permissions separate self actions from governed Team visibility", () => {
  for (const role of ["OWNER", "MANAGER", "FIELD_EMPLOYEE"]) {
    assert.equal(permissionForRole(role, "TIME_SELF_VIEW"), true);
    assert.equal(permissionForRole(role, "TIME_SELF_ACTION"), true);
  }
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "TIME_SELF_VIEW"), true);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "TIME_SELF_ACTION"), false);
  assert.equal(permissionForRole("OWNER", "TIME_TEAM_VIEW"), true);
  assert.equal(permissionForRole("MANAGER", "TIME_TEAM_VIEW"), true);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "TIME_TEAM_VIEW"), true);
  assert.equal(permissionForRole("FIELD_EMPLOYEE", "TIME_TEAM_VIEW"), false);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "JOB_ASSIGNMENT_MANAGE"), false);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "FIELD_STATUS_UPDATE"), false);
});

test("time routes extend the existing authenticated Team surface", () => {
  const routes = [];
  const app = {
    get(pathname, ...handlers) { routes.push(["GET", pathname, handlers.length]); },
    post(pathname, ...handlers) { routes.push(["POST", pathname, handlers.length]); },
  };
  registerTimeEvidenceRoutes({
    app, authMiddleware() {}, getPool() {}, sendPublicDatabaseError() {},
  });
  assert.deepEqual(routes.map(([method, pathname]) => [method, pathname]), [
    ["GET", "/employee/time"],
    ["POST", "/employee/time/clock-in"],
    ["POST", "/employee/time/clock-out"],
    ["GET", "/team/time"],
  ]);
});

test("server timestamps remain canonical and time does not touch frozen domains", () => {
  assert.match(service, /clocked_out_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(service, /durationSeconds\s*[,}].*req\.|durationSeconds: req\./s);
  assert.doesNotMatch(service, /UPDATE\s+(?:jobs|canonical_|deposit_|invoice_|professional_subscriptions|meetro_business_trials)/i);
  assert.doesNotMatch(service, /createCanonicalLifecycleAlert|canonical_alerts|\bconversations\b/i);
  assert.match(service, /TIME_TIMER_ALREADY_ACTIVE/);
  assert.match(service, /TIME_NO_ACTIVE_TIMER/);
  assert.match(service, /TIME_JOB_ASSIGNMENT_REQUIRED/);
});
