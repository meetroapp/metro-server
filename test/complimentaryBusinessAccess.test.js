"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  COMPLIMENTARY_ACCESS_DEFINITIONS,
  loadActiveComplimentaryAccess,
  serializeComplimentaryAccess,
} = require("../server/subscriptions/complimentaryAccess");

const {
  getSubscriptionState,
} = require("../server/subscriptions/subscriptionService");

const {
  listTeam,
} = require("../server/team/teamService");

function starterGrant(overrides = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    contractor_profile_id: 12,
    grant_type: "TESTFLIGHT_STARTER",
    effective_plan: "COMMUNITY_2_USER_MONTHLY",
    seat_limit: 2,
    grant_reason: "TESTFLIGHT_TESTER",
    granted_at: "2026-09-18T12:00:00.000Z",
    revoked_at: null,
    version: 1,
    ...overrides,
  };
}

function fullGrant(overrides = {}) {
  return starterGrant({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    grant_type: "FULL_COMPLIMENTARY",
    effective_plan: "COMMUNITY_10_USER_MONTHLY",
    seat_limit: 10,
    grant_reason: "BGONE_PERMANENT",
    ...overrides,
  });
}

test("complimentary definitions freeze Starter at 2 seats and Full at 10", () => {
  assert.deepEqual(
    COMPLIMENTARY_ACCESS_DEFINITIONS.TESTFLIGHT_STARTER,
    {
      code: "TESTFLIGHT_STARTER",
      plan: "COMMUNITY_2_USER_MONTHLY",
      seatLimit: 2,
      grantReason: "TESTFLIGHT_TESTER",
      permanent: false,
    }
  );

  assert.deepEqual(
    COMPLIMENTARY_ACCESS_DEFINITIONS.FULL_COMPLIMENTARY,
    {
      code: "FULL_COMPLIMENTARY",
      plan: "COMMUNITY_10_USER_MONTHLY",
      seatLimit: 10,
      grantReason: "BGONE_PERMANENT",
      permanent: true,
    }
  );
});

test("complimentary authority never fabricates Apple or Stripe billing", () => {
  const starter = serializeComplimentaryAccess(starterGrant());
  const full = serializeComplimentaryAccess(fullGrant());

  assert.equal(starter.entitled, true);
  assert.equal(starter.seatLimit, 2);
  assert.equal(starter.permanent, false);

  assert.equal(full.entitled, true);
  assert.equal(full.seatLimit, 10);
  assert.equal(full.permanent, true);

  for (const grant of [starter, full]) {
    assert.equal(grant.source, "MEETRO_COMPLIMENTARY");
    assert.equal(Object.hasOwn(grant, "provider"), false);
    assert.equal(Object.hasOwn(grant, "providerProductId"), false);
    assert.equal(Object.hasOwn(grant, "willAutoRenew"), false);
  }
});

test("revoked and malformed grants fail closed", () => {
  const revoked = serializeComplimentaryAccess(
    starterGrant({
      revoked_at: "2026-09-19T12:00:00.000Z",
    })
  );

  assert.equal(revoked.status, "REVOKED");
  assert.equal(revoked.entitled, false);

  assert.equal(
    serializeComplimentaryAccess(
      starterGrant({ seat_limit: 10 })
    ),
    null
  );

  assert.equal(
    serializeComplimentaryAccess(
      fullGrant({ grant_reason: "TESTFLIGHT_TESTER" })
    ),
    null
  );
});

test("active grant lookup is exact-business, active-only, and read-only", async () => {
  const calls = [];

  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [starterGrant()] };
    },
  };

  const result = await loadActiveComplimentaryAccess(pool, 12);

  assert.equal(result.grantType, "TESTFLIGHT_STARTER");
  assert.deepEqual(calls[0].params, [12]);
  assert.match(calls[0].sql, /contractor_profile_id = \$1/);
  assert.match(calls[0].sql, /revoked_at IS NULL/);
  assert.doesNotMatch(calls[0].sql, /INSERT|UPDATE|DELETE/i);
});

test("expired 14-day trial plus TestFlight grant retains ENFORCED Business access", async () => {
  const expiredTrial = {
    starts_at: new Date(Date.now() - 20 * 86400000).toISOString(),
    ends_at: new Date(Date.now() - 6 * 86400000).toISOString(),
    converted_at: null,
  };

  const pool = {
    async query(sql) {
      if (sql.includes("FROM users")) {
        return {
          rows: [{
            id: 8,
            email: "tester@example.test",
            account_type: "professional",
            contractor_profile_id: 12,
          }],
        };
      }

      if (sql.includes("INSERT INTO professional_subscription_accounts")) {
        return {
          rows: [{
            contractor_profile_id: 12,
            app_account_token: "123e4567-e89b-12d3-a456-426614174000",
            stripe_customer_id: null,
          }],
        };
      }

      if (sql.includes("FROM professional_subscriptions")) {
        return { rows: [] };
      }

      if (sql.includes("FROM meetro_business_trials")) {
        return { rows: [expiredTrial] };
      }

      if (sql.includes("FROM business_complimentary_access_grants")) {
        return { rows: [starterGrant()] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const state = await getSubscriptionState({
    pool,
    authenticatedActor: { id: 8 },
    environment: {},
  });

  assert.equal(state.subscriptionEnforcementMode, "ENFORCED");
  assert.equal(state.businessTrial.status, "EXPIRED");
  assert.equal(state.subscription, null);

  assert.equal(state.paidEntitlementActive, false);
  assert.equal(state.complimentaryEntitlementActive, true);
  assert.equal(state.businessAccessActive, true);
  assert.equal(state.entitled, true);

  assert.deepEqual(state.effectiveBusinessAccess, {
    source: "COMPLIMENTARY_ACCESS",
    grantType: "TESTFLIGHT_STARTER",
    plan: "COMMUNITY_2_USER_MONTHLY",
    seatLimit: 2,
  });
});

test("verified paid subscription retains precedence over Full Complimentary", async () => {
  const paid = {
    provider: "STRIPE",
    provider_product_id: "price_verified",
    effective_plan: "COMMUNITY_5_USER_MONTHLY",
    status: "ACTIVE",
    seat_limit: 5,
    access_started_at: new Date(Date.now() - 86400000).toISOString(),
    access_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    version: 1,
  };

  const pool = {
    async query(sql) {
      if (sql.includes("FROM users")) {
        return {
          rows: [{
            id: 8,
            email: "paid@example.test",
            account_type: "professional",
            contractor_profile_id: 12,
          }],
        };
      }

      if (sql.includes("INSERT INTO professional_subscription_accounts")) {
        return {
          rows: [{
            contractor_profile_id: 12,
            app_account_token: "123e4567-e89b-12d3-a456-426614174000",
            stripe_customer_id: "cus_verified",
          }],
        };
      }

      if (sql.includes("FROM professional_subscriptions")) {
        return { rows: [paid] };
      }

      if (sql.includes("FROM meetro_business_trials")) {
        return { rows: [] };
      }

      if (sql.includes("FROM business_complimentary_access_grants")) {
        return { rows: [fullGrant()] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const state = await getSubscriptionState({
    pool,
    authenticatedActor: { id: 8 },
    environment: {},
  });

  assert.equal(state.paidEntitlementActive, true);
  assert.equal(state.complimentaryEntitlementActive, true);

  assert.deepEqual(state.effectiveBusinessAccess, {
    source: "PAID_SUBSCRIPTION",
    plan: "COMMUNITY_5_USER_MONTHLY",
    seatLimit: 5,
  });
});

function ownerMembership() {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    contractor_profile_id: 12,
    user_id: 8,
    role: "OWNER",
    status: "ACTIVE",
    version: 1,
    business_name: "Test Business",
    category: "testing",
    username: "Owner",
    email: "owner@example.test",
  };
}

function teamPool(authorityRow) {
  const owner = ownerMembership();

  return {
    async query(sql) {
      if (
        sql.includes("FROM business_team_memberships memberships") &&
        sql.includes("JOIN contractor_profiles profiles")
      ) {
        return { rows: [owner] };
      }

      if (
        sql.includes("FROM business_team_memberships memberships") &&
        sql.includes("JOIN users ON")
      ) {
        return { rows: [owner] };
      }

      if (sql.includes("AS active_memberships")) {
        return {
          rows: [{
            active_memberships: 1,
            pending_invitations: 0,
          }],
        };
      }

      if (
        sql.includes("FROM contractor_profiles profiles") &&
        sql.includes("business_complimentary_access_grants")
      ) {
        return { rows: [authorityRow] };
      }

      if (sql.includes("FROM business_team_invitations")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test("TestFlight Starter Team authority permits exactly two total users", async () => {
  const result = await listTeam({
    pool: teamPool({
      subscription_status: null,
      seat_limit: null,
      access_ends_at: null,
      complimentary_grant_type: "TESTFLIGHT_STARTER",
      complimentary_effective_plan: "COMMUNITY_2_USER_MONTHLY",
      complimentary_seat_limit: 2,
      trial_starts_at: null,
      trial_ends_at: null,
      trial_converted_at: null,
    }),
    authenticatedActor: { id: 8 },
    businessId: 12,
    environment: {},
  });

  assert.equal(result.seatAuthority.source, "COMPLIMENTARY_ACCESS");
  assert.equal(result.seatAuthority.seatLimit, 2);
  assert.equal(result.seatAuthority.reservedSeats, 1);
  assert.equal(result.seatAuthority.seatsAvailable, 1);
});

test("Full Complimentary Team authority permits ten total users", async () => {
  const result = await listTeam({
    pool: teamPool({
      subscription_status: null,
      seat_limit: null,
      access_ends_at: null,
      complimentary_grant_type: "FULL_COMPLIMENTARY",
      complimentary_effective_plan: "COMMUNITY_10_USER_MONTHLY",
      complimentary_seat_limit: 10,
      trial_starts_at: null,
      trial_ends_at: null,
      trial_converted_at: null,
    }),
    authenticatedActor: { id: 8 },
    businessId: 12,
    environment: {},
  });

  assert.equal(result.seatAuthority.source, "COMPLIMENTARY_ACCESS");
  assert.equal(result.seatAuthority.seatLimit, 10);
  assert.equal(result.seatAuthority.reservedSeats, 1);
  assert.equal(result.seatAuthority.seatsAvailable, 9);
});

test("migration is additive and isolated from provider and Job financial authority", () => {
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "migrations",
      "202609180001_create_business_complimentary_access_authority.sql"
    ),
    "utf8"
  );

  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS business_complimentary_access_grants/
  );

  assert.match(sql, /TESTFLIGHT_STARTER/);
  assert.match(sql, /FULL_COMPLIMENTARY/);
  assert.match(sql, /seat_limit = 2/);
  assert.match(sql, /seat_limit = 10/);
  assert.match(sql, /WHERE revoked_at IS NULL/);

  assert.doesNotMatch(
    sql,
    /professional_subscription_provider_events|canonical_invoices|invoice_payments|deposit_requests|canonical_quotes|alerts|jobs\s+SET/i
  );
});
