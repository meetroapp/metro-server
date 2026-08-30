"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getSubscriptionCatalog,
  planForProductId,
} = require("../server/subscriptions/subscriptionCatalog");
const {
  assertSeatAvailable,
  deriveProviderState,
  entitledStatus,
  getSubscriptionState,
  stagingQaAccess,
  verifyAppleEvidence,
} = require("../server/subscriptions/subscriptionService");
const {
  decodeRootCertificates,
} = require("../server/subscriptions/appleSubscriptionVerifier");

const productEnvironment = {
  APPLE_COMMUNITY_2_USER_MONTHLY_PRODUCT_ID: "com.meetro.community.professional.2.monthly",
  APPLE_COMMUNITY_5_USER_MONTHLY_PRODUCT_ID: "com.meetro.community.professional.5.monthly",
  APPLE_COMMUNITY_10_USER_MONTHLY_PRODUCT_ID: "com.meetro.community.professional.10.monthly",
};

test("server-owned catalog exposes only the three approved monthly plans", () => {
  const plans = getSubscriptionCatalog(productEnvironment);
  assert.deepEqual(plans.map(({ code, name, amountMinor, seatLimit, trialDays }) => ({ code, name, amountMinor, seatLimit, trialDays })), [
    { code: "COMMUNITY_2_USER_MONTHLY", name: "Starter", amountMinor: 3499, seatLimit: 2, trialDays: 14 },
    { code: "COMMUNITY_5_USER_MONTHLY", name: "Growth", amountMinor: 6999, seatLimit: 5, trialDays: 14 },
    { code: "COMMUNITY_10_USER_MONTHLY", name: "Professional", amountMinor: 12999, seatLimit: 10, trialDays: 14 },
  ]);
  assert.equal(planForProductId("client.forged.product", productEnvironment), null);
});

test("missing product configuration remains explicit", () => {
  assert.equal(getSubscriptionCatalog({}).every((plan) => !plan.providerConfigured && plan.providerProductId === null), true);
});

test("provider trial inherits its plan and cannot be client-forged", () => {
  const state = deriveProviderState({
    purchaseDate: Date.now() - 1000,
    expiresDate: Date.now() + 86400000,
    offerType: 1,
    offerDiscountType: "FREE_TRIAL",
  }, { autoRenewStatus: 1 });
  assert.equal(state.status, "TRIAL");
  assert.equal(state.trialEndsAt, state.endsAt);
  assert.equal(state.trialEligible, false);
});

test("provider cancellation preserves access until verified end", () => {
  const state = deriveProviderState({ purchaseDate: Date.now() - 1000, expiresDate: Date.now() + 86400000 }, { autoRenewStatus: 0 });
  assert.equal(state.status, "CANCELED_AT_PERIOD_END");
  assert.equal(entitledStatus(state.status, state.endsAt), true);
});

test("provider expiration and revocation remove entitlement", () => {
  const expired = deriveProviderState({ purchaseDate: Date.now() - 86400000, expiresDate: Date.now() - 1000 }, {});
  const revoked = deriveProviderState({ purchaseDate: Date.now() - 1000, expiresDate: Date.now() + 86400000, revocationDate: Date.now() }, {});
  assert.equal(expired.status, "EXPIRED");
  assert.equal(revoked.status, "REVOKED");
  assert.equal(entitledStatus(expired.status, expired.endsAt), false);
  assert.equal(entitledStatus(revoked.status, revoked.endsAt), false);
});

test("verified Apple grace follows provider truth", () => {
  const state = deriveProviderState({ purchaseDate: Date.now() - 1000, expiresDate: Date.now() - 500 }, { gracePeriodExpiresDate: Date.now() + 86400000 });
  assert.equal(state.status, "GRACE");
  assert.equal(entitledStatus(state.status, state.endsAt), true);
});

test("seat enforcement counts owner and rejects Plan A third seat", () => {
  assert.equal(assertSeatAvailable({ entitlement: { entitled: true, seatLimit: 2 }, activeProfessionalSeats: 1 }).ok, true);
  const rejected = assertSeatAvailable({ entitlement: { entitled: true, seatLimit: 2 }, activeProfessionalSeats: 2 });
  assert.equal(rejected.code, "SUBSCRIPTION_SEAT_LIMIT_REACHED");
  assert.match(rejected.message, /up to 2 users/);
});

test("Plan B permits five total seats but rejects a sixth", () => {
  assert.equal(assertSeatAvailable({ entitlement: { entitled: true, seatLimit: 5 }, activeProfessionalSeats: 4 }).ok, true);
  assert.equal(assertSeatAvailable({ entitlement: { entitled: true, seatLimit: 5 }, activeProfessionalSeats: 5 }).ok, false);
});

test("Professional permits the owner plus nine employees but rejects an eleventh seat", () => {
  assert.equal(assertSeatAvailable({ entitlement: { entitled: true, seatLimit: 10 }, activeProfessionalSeats: 9 }).ok, true);
  const rejected = assertSeatAvailable({ entitlement: { entitled: true, seatLimit: 10 }, activeProfessionalSeats: 10 });
  assert.equal(rejected.code, "SUBSCRIPTION_SEAT_LIMIT_REACHED");
  assert.match(rejected.message, /up to 10 users/);
});

test("staging QA compatibility cannot activate in production", () => {
  assert.equal(stagingQaAccess({ NODE_ENV: "staging" }), true);
  assert.equal(stagingQaAccess({ NODE_ENV: "staging", SUBSCRIPTION_STAGING_QA_ACCESS: "enabled" }), true);
  assert.equal(stagingQaAccess({ NODE_ENV: "staging", SUBSCRIPTION_STAGING_QA_ACCESS: "disabled" }), false);
  assert.equal(stagingQaAccess({ NODE_ENV: "production", SUBSCRIPTION_STAGING_QA_ACCESS: "enabled" }), false);
  assert.equal(stagingQaAccess({ NODE_ENV: "development", SUBSCRIPTION_STAGING_QA_ACCESS: "enabled" }), false);
  assert.equal(stagingQaAccess({ NODE_ENV: "test", SUBSCRIPTION_STAGING_QA_ACCESS: "enabled" }), false);
});

test("homeowners are not subject to professional subscription", async () => {
  const calls = [];
  const pool = { query: async (sql) => {
    calls.push(sql);
    return { rows: [{ id: 7, account_type: "homeowner", contractor_profile_id: null }] };
  } };
  const result = await getSubscriptionState({ pool, authenticatedActor: { id: 7 } });
  assert.equal(result.applicable, false);
  assert.equal(result.entitled, true);
  assert.deepEqual(result.catalog, []);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /professional_subscription|invoice|quote|job|alerts/i);
});

function stagingProfessionalPool() {
  const calls = [];
  const pool = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes("FROM users")) return { rows: [{ id: 8, account_type: "professional", contractor_profile_id: 12 }] };
    if (sql.includes("INSERT INTO professional_subscription_accounts")) return { rows: [{ contractor_profile_id: 12, app_account_token: "123e4567-e89b-12d3-a456-426614174000" }] };
    if (sql.includes("FROM professional_subscriptions")) return { rows: [] };
    throw new Error("Unexpected SQL");
  } };
  return { calls, pool };
}

test("staging QA professional receives full server-owned access without purchase authority", async () => {
  const { calls, pool } = stagingProfessionalPool();
  const result = await getSubscriptionState({ pool, authenticatedActor: { id: 8 }, environment: { NODE_ENV: "staging" } });
  assert.equal(result.entitled, true);
  assert.equal(result.subscription, null);
  assert.deepEqual(result.qaAccess, {
    source: "STAGING_EXISTING_PROFESSIONAL_COMPATIBILITY",
    environment: "staging",
    productionAllowed: false,
  });
  assert.equal(calls.filter((sql) => /INSERT INTO professional_subscription_accounts/i.test(sql)).length, 1);
  assert.equal(calls.some((sql) => /INSERT INTO professional_subscriptions|professional_subscription_provider_events/i.test(sql)), false);
  assert.equal(calls.some((sql) => /canonical_invoices|invoice_payments|deposit|canonical_quotes|\bjobs\b|\balerts\b/i.test(sql)), false);
});

test("production ignores the staging QA setting and creates no fallback entitlement", async () => {
  const { calls, pool } = stagingProfessionalPool();
  const result = await getSubscriptionState({
    pool,
    authenticatedActor: { id: 8 },
    environment: { NODE_ENV: "production", SUBSCRIPTION_STAGING_QA_ACCESS: "enabled" },
  });
  assert.equal(result.entitled, false);
  assert.equal(result.subscription, null);
  assert.equal(result.qaAccess, null);
  assert.equal(calls.some((sql) => /INSERT INTO professional_subscriptions|professional_subscription_provider_events/i.test(sql)), false);
});

test("unconfigured Apple verification fails closed", async () => {
  const result = await verifyAppleEvidence({
    pool: {}, authenticatedActor: { id: 1 }, signedTransactionInfo: "x".repeat(120),
    verifier: { configured: false }, environment: productEnvironment,
  });
  assert.equal(result.code, "APPLE_SERVER_CONFIGURATION_REQUIRED");
});

test("verified but unknown product cannot forge plan or seat limit", async () => {
  const result = await verifyAppleEvidence({
    pool: { connect() { throw new Error("must not connect"); } },
    authenticatedActor: { id: 1 }, signedTransactionInfo: "x".repeat(120),
    verifier: { configured: true, verifyTransaction: async () => ({
      productId: "forged.product", transactionId: "1", originalTransactionId: "1",
      appAccountToken: "123e4567-e89b-12d3-a456-426614174000",
      purchaseDate: Date.now() - 1000, expiresDate: Date.now() + 1000,
    }), verifyRenewalInfo: async () => null }, environment: productEnvironment,
  });
  assert.equal(result.code, "APPLE_EVIDENCE_MISMATCH");
});

test("root certificates are configuration data rather than client secrets", () => {
  assert.equal(decodeRootCertificates(Buffer.from("root").toString("base64"))[0].toString(), "root");
});

test("Migration 65 is bounded, idempotent, and isolated from Job billing", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/202608300001_create_professional_subscription_foundation.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS professional_subscription_accounts/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS professional_subscriptions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS professional_subscription_provider_events/);
  assert.match(sql, /UNIQUE \(provider, provider_event_id\)/);
  assert.match(sql, /seat_limit INTEGER NOT NULL CHECK \(seat_limit IN \(2, 5\)\)/);
  assert.doesNotMatch(sql, /canonical_invoices|deposit_requests|invoice_payments|alerts|jobs\s+SET/i);
});
