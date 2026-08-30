"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  INVITABLE_TEAM_ROLES,
  ROLE_PERMISSIONS,
  TEAM_ROLES,
  TRIAL_SEAT_LIMIT,
  deactivateTeamMember,
  digestInvitationToken,
  inviteTeamMember,
  normalizeEmail,
  normalizeRole,
  permissionForRole,
  serializeMembershipWithIdentity,
} = require("../server/team/teamService");
const { createTeamHandlers, registerTeamRoutes } = require("../server/team/team");

const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  "202608300005_create_business_team_membership_authority.sql"
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const businessProfileSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "profile", "businessProfile.js"),
  "utf8"
);

test("Migration 69 defines durable Team invitation and membership authority", () => {
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS business_team_invitations/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS business_team_memberships/i);
  assert.match(migrationSql, /UNIQUE \(contractor_profile_id, user_id\)/i);
  assert.match(migrationSql, /WHERE status = 'PENDING'/i);
  assert.match(migrationSql, /OWNER.+MANAGER.+BOOKKEEPER_FINANCE.+FIELD_EMPLOYEE/is);
  assert.match(migrationSql, /INSERT INTO business_team_memberships[\s\S]+FROM contractor_profiles/i);
  assert.match(migrationSql, /reject_business_team_history_delete/i);
  assert.match(migrationSql, /ON DELETE RESTRICT/i);
  assert.doesNotMatch(migrationSql, /canonical_invoices|invoice_payments|deposit_requests|canonical_alerts|jobs|time_entries/i);
});

test("new professional signup and Personal-to-Business activation create the OWNER seat", () => {
  assert.match(indexSource, /created_owner_membership[\s\S]*INSERT INTO business_team_memberships[\s\S]*'OWNER'/i);
  assert.match(businessProfileSource, /created_owner_membership[\s\S]*INSERT INTO business_team_memberships[\s\S]*'OWNER'/i);
  assert.doesNotMatch(
    `${indexSource.match(/created_owner_membership[\s\S]{0,900}/)?.[0] || ""}${businessProfileSource.match(/created_owner_membership[\s\S]{0,900}/)?.[0] || ""}`,
    /professional_subscriptions|provider_events|invoice|deposit|alert/i
  );
});

test("preset roles expose bounded server permissions and never custom permission input", () => {
  assert.deepEqual(TEAM_ROLES, ["OWNER", "MANAGER", "BOOKKEEPER_FINANCE", "FIELD_EMPLOYEE"]);
  assert.deepEqual(INVITABLE_TEAM_ROLES, ["MANAGER", "BOOKKEEPER_FINANCE", "FIELD_EMPLOYEE"]);
  assert.equal(permissionForRole("OWNER", "TEAM_MANAGE_ROLES"), true);
  assert.equal(permissionForRole("MANAGER", "TEAM_INVITE"), true);
  assert.equal(permissionForRole("MANAGER", "TEAM_MANAGE_ROLES"), false);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "FINANCE_WORKSPACE"), true);
  assert.equal(permissionForRole("FIELD_EMPLOYEE", "ASSIGNED_WORK"), true);
  assert.equal(Object.hasOwn(ROLE_PERMISSIONS, "CUSTOM"), false);
});

test("trial authority reserves exactly two total professional seats", () => {
  assert.equal(TRIAL_SEAT_LIMIT, 2);
});

test("invitation identities and role input normalize fail closed", () => {
  assert.equal(normalizeEmail(" Employee@Example.Test "), "employee@example.test");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeRole("bookkeeper / finance", { invitableOnly: true }), "BOOKKEEPER_FINANCE");
  assert.equal(normalizeRole("owner", { invitableOnly: true }), null);
  assert.equal(normalizeRole("custom_admin", { invitableOnly: true }), null);
  assert.equal(digestInvitationToken("a".repeat(32)).length, 64);
  assert.equal(digestInvitationToken("short"), null);
});

test("membership serialization preserves durable membership identity over user identity", () => {
  const membershipId = "d5d34bb1-2c69-4dc8-af8d-31cf2d4f669b";
  const result = serializeMembershipWithIdentity({
    id: membershipId,
    contractor_profile_id: 17,
    user_id: 42,
    role: "FIELD_EMPLOYEE",
    status: "ACTIVE",
    version: 1,
  }, {
    id: 42,
    username: "Field Employee",
    email: "employee@example.test",
  });

  assert.equal(result.id, membershipId);
  assert.equal(result.userId, 42);
  assert.equal(result.displayName, "Field Employee");
  assert.equal(result.email, "employee@example.test");
});

test("malformed business and member authority fails before transactions", async () => {
  const pool = { connect() { throw new Error("must not connect"); } };
  const invalidBusiness = await inviteTeamMember({
    pool,
    authenticatedActor: { id: 7 },
    businessId: "7 OR 1=1",
    email: "employee@example.test",
    role: "FIELD_EMPLOYEE",
  });
  const invalidMember = await deactivateTeamMember({
    pool,
    authenticatedActor: { id: 7 },
    businessId: 12,
    membershipId: "not-a-uuid",
  });
  assert.equal(invalidBusiness.code, "TEAM_BUSINESS_INVALID");
  assert.equal(invalidMember.code, "TEAM_MEMBER_INVALID");
});

test("Team routes are authenticated and expose only governed commands", () => {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "patch"]) {
    app[method] = (pathValue, ...handlers) => routes.push({ method, path: pathValue, handlers });
  }
  const authMiddleware = (_req, _res, next) => next();
  const handlers = registerTeamRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError() {},
  });
  assert.ok(handlers);
  assert.deepEqual(routes.map(({ method, path: value }) => `${method.toUpperCase()} ${value}`), [
    "GET /team/me",
    "GET /team",
    "POST /team/invitations",
    "POST /team/invitations/accept",
    "POST /team/invitations/:invitationId/revoke",
    "PATCH /team/members/:membershipId/role",
    "POST /team/members/:membershipId/deactivate",
  ]);
  routes.forEach((route) => assert.equal(route.handlers[0], authMiddleware));
  assert.equal(typeof createTeamHandlers, "function");
});
