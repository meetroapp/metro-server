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
  getMyTeamAuthority,
  inviteTeamMember,
  normalizeEmail,
  normalizeRole,
  permissionForRole,
  resendTeamInvitation,
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
  assert.equal(permissionForRole("FIELD_EMPLOYEE", "EMPLOYEE_SCHEDULE"), true);
  assert.equal(permissionForRole("OWNER", "JOB_ASSIGNMENT_MANAGE"), true);
  assert.equal(permissionForRole("MANAGER", "JOB_ASSIGNMENT_MANAGE"), true);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "JOB_ASSIGNMENT_VIEW"), false);
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

test("pending Team invitation projection names the exact Business before acceptance", async () => {
  const pool = {
    async query(text) {
      if (/SELECT id, email FROM users/.test(text)) {
        return { rows: [{ id: 42, email: "employee@example.test" }] };
      }
      if (/FROM business_team_memberships memberships/.test(text)) {
        return { rows: [] };
      }
      if (/FROM business_team_invitations invitations/.test(text)) {
        return { rows: [{
          id: "d5d34bb1-2c69-4dc8-af8d-31cf2d4f669b",
          contractor_profile_id: 17,
          business_name: "Example Electric",
          email_normalized: "employee@example.test",
          display_name: "Field Employee",
          role: "FIELD_EMPLOYEE",
          status: "PENDING",
          expires_at: new Date(Date.now() + 60_000),
          created_at: new Date(),
          version: 1,
        }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const result = await getMyTeamAuthority({ pool, authenticatedActor: { id: 42 } });
  assert.equal(result.pendingInvitations[0].businessName, "Example Electric");
  assert.equal(result.pendingInvitations[0].businessId, 17);
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

test("resend rotates the secret on the same pending invitation without creating another seat or invitation", async () => {
  const invitationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const queries = [];

  const client = {
    async query(text, params) {
      queries.push({ text, params });

      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }

      if (/FROM business_team_memberships memberships/.test(text)) {
        return {
          rows: [{
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            contractor_profile_id: 17,
            user_id: 7,
            role: "OWNER",
            status: "ACTIVE",
            business_name: "All Handyman Services",
            category: "Handyman",
          }],
        };
      }

      if (/FROM business_team_invitations invitations/.test(text)) {
        return {
          rows: [{
            id: invitationId,
            contractor_profile_id: 17,
            business_name: "All Handyman Services",
            email_normalized: "liam@example.test",
            display_name: "Liam Molina",
            role: "FIELD_EMPLOYEE",
            status: "PENDING",
            token_digest: "old-digest",
            expires_at: new Date(Date.now() + 60_000),
            created_at: new Date(),
            version: 1,
          }],
        };
      }

      if (/UPDATE business_team_invitations[\s\S]+SET token_digest/.test(text)) {
        return {
          rows: [{
            id: invitationId,
            contractor_profile_id: 17,
            email_normalized: "liam@example.test",
            display_name: "Liam Molina",
            role: "FIELD_EMPLOYEE",
            status: "PENDING",
            token_digest: params[0],
            expires_at: new Date(Date.now() + 60_000),
            created_at: new Date(),
            version: 1,
          }],
        };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release() {},
  };

  const pool = {
    async connect() {
      return client;
    },
  };

  const result = await resendTeamInvitation({
    pool,
    authenticatedActor: { id: 7 },
    businessId: 17,
    invitationId,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "BUSINESS_TEAM_INVITATION_RESEND_READY");
  assert.equal(result.invitation.id, invitationId);
  assert.equal(result.invitation.email, "liam@example.test");
  assert.equal(result.invitation.businessName, "All Handyman Services");
  assert.match(result.invitation.token, /^[A-Za-z0-9_-]{32,200}$/);

  const sql = queries.map((entry) => entry.text).join("\n");
  assert.match(sql, /SET token_digest/);
  assert.doesNotMatch(sql, /INSERT INTO business_team_invitations/i);
  assert.doesNotMatch(sql, /INSERT INTO business_team_memberships/i);
});

test("Team invite handler reports delivery failure truthfully while preserving successful canonical invitation creation", async () => {
  const service = {
    async inviteTeamMember() {
      return {
        ok: true,
        status: 201,
        code: "BUSINESS_TEAM_INVITATION_CREATED",
        invitation: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          businessId: 17,
          businessName: "All Handyman Services",
          email: "liam@example.test",
          displayName: "Liam Molina",
          role: "FIELD_EMPLOYEE",
          status: "PENDING",
          token: "t".repeat(43),
        },
        seatAuthority: {
          source: "MEETRO_BUSINESS_TRIAL",
          seatLimit: 2,
          reservedSeats: 2,
          seatsAvailable: 0,
        },
      };
    },
  };

  const emailDelivery = {
    async sendTeamInvitationEmail(payload) {
      assert.equal(payload.recipientEmail, "liam@example.test");
      assert.equal(payload.businessName, "All Handyman Services");
      assert.equal(payload.role, "FIELD_EMPLOYEE");
      assert.match(
        payload.joinUrl,
        /^https:\/\/meetro-client-staging\.vercel\.app\/login#teamMembers\?invitation=/
      );
      return {
        accepted: false,
        status: "provider_unavailable",
      };
    },
  };

  const handlers = createTeamHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError() {
      throw new Error("unexpected database failure");
    },
    service,
    emailDelivery,
    environment: {
      TEAM_INVITATION_CLIENT_BASE_URL:
        "https://meetro-client-staging.vercel.app",
    },
  });

  let statusCode = null;
  let responseBody = null;

  const req = {
    user: { id: 7 },
    body: {
      businessId: 17,
      email: "liam@example.test",
      displayName: "Liam Molina",
      role: "FIELD_EMPLOYEE",
    },
  };

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await handlers.invite(req, res);

  assert.equal(statusCode, 201);
  assert.equal(responseBody.success, true);
  assert.equal(
    responseBody.invitation.id,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  );
  assert.equal(responseBody.seatAuthority.reservedSeats, 2);
  assert.equal(responseBody.invitation.emailDeliveryStatus, "failed");
  assert.equal(
    responseBody.invitation.emailDelivery.status,
    "provider_unavailable"
  );
  assert.match(
    responseBody.invitation.joinUrl,
    /^https:\/\/meetro-client-staging\.vercel\.app\/login#teamMembers\?invitation=/
  );
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
    "POST /team/invitations/:invitationId/resend",
    "POST /team/invitations/:invitationId/revoke",
    "PATCH /team/members/:membershipId/role",
    "POST /team/members/:membershipId/deactivate",
  ]);
  routes.forEach((route) => assert.equal(route.handlers[0], authMiddleware));
  assert.equal(typeof createTeamHandlers, "function");
});
