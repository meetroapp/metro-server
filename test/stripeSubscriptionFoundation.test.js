"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createStripeCheckout,
  createSubscriptionManagement,
  deriveProviderState,
  deriveStripeProviderState,
  processStripeSubscriptionEvent,
  stagingQaAccess,
  verifyAppleEvidence,
} = require("../server/subscriptions/subscriptionService");
const { createSubscriptionHandlers } = require("../server/subscriptions/subscriptions");

const environment = {
  NODE_ENV: "test",
  STRIPE_COMMUNITY_2_USER_MONTHLY_PRICE_ID: "price_meetro_plan_a",
  STRIPE_COMMUNITY_5_USER_MONTHLY_PRICE_ID: "price_meetro_plan_b",
  STRIPE_SUBSCRIPTION_RETURN_URL: "https://staging.meetro.example/#professionalSubscription",
};
const token = "123e4567-e89b-12d3-a456-426614174000";

function responseRecorder() {
  return { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function checkoutPool(existing = null) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
      if (sql.includes("FROM users")) return { rows: [{ id: 8, email: "pro@example.test", account_type: "professional", contractor_profile_id: 12 }] };
      if (sql.includes("FROM professional_subscriptions") && sql.includes("FOR UPDATE")) return { rows: existing ? [existing] : [] };
      if (sql.includes("INSERT INTO professional_subscription_accounts")) return { rows: [{ contractor_profile_id: 12, app_account_token: token, stripe_customer_id: null }] };
      if (sql.includes("UPDATE professional_subscription_accounts")) return { rows: [{ stripe_customer_id: "cus_verified" }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  return { calls, pool: { connect: async () => client } };
}

test("Stripe checkout uses the exact server plan, provider trial, and business binding", async () => {
  const { calls, pool } = checkoutPool();
  let checkout;
  const provider = {
    checkoutConfigured: true,
    retrievePrice: async () => ({ active: true, unit_amount: 3499, currency: "usd", recurring: { interval: "month", interval_count: 1 } }),
    createCustomer: async (params) => {
      assert.equal(params.metadata.meetro_business_id, "12");
      return { id: "cus_verified" };
    },
    createCheckoutSession: async (params) => { checkout = params; return { url: "https://checkout.stripe.test/session" }; },
  };
  const result = await createStripeCheckout({ pool, authenticatedActor: { id: 8 }, planCode: "COMMUNITY_2_USER_MONTHLY", stripeProvider: provider, environment });
  assert.equal(result.code, "STRIPE_CHECKOUT_CREATED");
  assert.deepEqual(checkout.line_items, [{ price: "price_meetro_plan_a", quantity: 1 }]);
  assert.equal(checkout.subscription_data.trial_period_days, 14);
  assert.equal(checkout.subscription_data.metadata.meetro_app_account_token, token);
  assert.equal(calls.some(({ sql }) => /canonical_invoices|invoice_payments|deposit_requests|\bjobs\b/i.test(sql)), false);
});

test("an active Apple entitlement prevents accidental Stripe checkout", async () => {
  const { pool } = checkoutPool({ provider: "APPLE_APP_STORE", status: "ACTIVE", access_ends_at: new Date(Date.now() + 86400000) });
  let providerCalls = 0;
  const result = await createStripeCheckout({
    pool, authenticatedActor: { id: 8 }, planCode: "COMMUNITY_2_USER_MONTHLY", environment,
    stripeProvider: {
      checkoutConfigured: true,
      retrievePrice: async () => ({ active: true, unit_amount: 3499, currency: "usd", recurring: { interval: "month", interval_count: 1 } }),
      createCustomer: async () => { providerCalls++; },
    },
  });
  assert.equal(result.code, "ACTIVE_SUBSCRIPTION_EXISTS");
  assert.equal(providerCalls, 0);
});

test("mispriced or non-monthly Stripe configuration fails before checkout", async () => {
  let connected = false;
  const result = await createStripeCheckout({
    pool: { connect: async () => { connected = true; } }, authenticatedActor: { id: 8 },
    planCode: "COMMUNITY_2_USER_MONTHLY", environment,
    stripeProvider: { checkoutConfigured: true, retrievePrice: async () => ({ active: true, unit_amount: 3500, currency: "usd", recurring: { interval: "month" } }) },
  });
  assert.equal(result.code, "STRIPE_PLAN_CONFIGURATION_MISMATCH");
  assert.equal(connected, false);
});

test("an existing Stripe entitlement prevents an unnecessary Apple subscription", async () => {
  const client = {
    async query(sql) {
      if (/^BEGIN|^ROLLBACK/.test(sql)) return { rows: [] };
      if (sql.includes("FROM users")) return { rows: [{ id: 8, account_type: "professional", contractor_profile_id: 12 }] };
      if (sql.includes("INSERT INTO professional_subscription_accounts")) return { rows: [{ contractor_profile_id: 12, app_account_token: token, stripe_customer_id: "cus_verified" }] };
      if (sql.includes("SELECT provider, status, access_ends_at")) return { rows: [{ provider: "STRIPE", status: "ACTIVE", access_ends_at: new Date(Date.now() + 86400000) }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const now = Date.now();
  const result = await verifyAppleEvidence({
    pool: { connect: async () => client }, authenticatedActor: { id: 8 }, signedTransactionInfo: "verified".repeat(20), environment: {
      APPLE_COMMUNITY_2_USER_MONTHLY_PRODUCT_ID: "apple_plan_a",
    },
    verifier: { configured: true, verifyTransaction: async () => ({
      productId: "apple_plan_a", transactionId: "apple_tx", originalTransactionId: "apple_original",
      appAccountToken: token, purchaseDate: now - 1000, expiresDate: now + 86400000,
    }), verifyRenewalInfo: async () => ({ autoRenewStatus: 1 }) },
  });
  assert.equal(result.code, "SUBSCRIPTION_PROVIDER_CHANGE_REQUIRES_REVIEW");
});

test("Stripe trial dates and status come from provider subscription truth", () => {
  const start = 1_800_000_000;
  const state = deriveStripeProviderState({ status: "trialing", trial_start: start, trial_end: start + 14 * 86400, current_period_start: start, current_period_end: start + 14 * 86400 });
  assert.equal(state.status, "TRIAL");
  assert.equal(state.trialEligible, false);
  assert.equal(new Date(state.trialEndsAt).getTime() - new Date(state.startedAt).getTime(), 14 * 86400000);
});

test("Apple and Stripe provider truth resolve to the same business entitlement semantics", () => {
  const now = Date.now();
  const apple = deriveProviderState({ purchaseDate: now - 1000, expiresDate: now + 86400000 }, { autoRenewStatus: 1 }, now);
  const seconds = Math.floor(now / 1000);
  const stripe = deriveStripeProviderState({ status: "active", current_period_start: seconds - 1, current_period_end: seconds + 86400 }, now);
  assert.equal(apple.status, "ACTIVE");
  assert.equal(stripe.status, "ACTIVE");
  assert.equal(apple.willAutoRenew, true);
  assert.equal(stripe.willAutoRenew, true);
});

test("Stripe renewal, payment failure, cancellation, and expiration remain provider governed", () => {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const base = { current_period_start: seconds - 100, current_period_end: seconds + 86400 };
  assert.equal(deriveStripeProviderState({ ...base, status: "active" }, now).status, "ACTIVE");
  assert.equal(deriveStripeProviderState({ ...base, status: "past_due" }, now).status, "GRACE");
  assert.equal(deriveStripeProviderState({ ...base, status: "active", cancel_at_period_end: true }, now).status, "CANCELED_AT_PERIOD_END");
  assert.equal(deriveStripeProviderState({ ...base, status: "canceled", canceled_at: seconds }, now).status, "EXPIRED");
});

function stripeAuthorityPool({ ownerMatches = true } = {}) {
  const events = new Set();
  let subscriptionRow = null;
  const client = {
    async query(sql, params) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
      if (sql.includes("FROM professional_subscription_accounts") && sql.includes("FOR UPDATE")) return { rows: ownerMatches ? [{ contractor_profile_id: 12 }] : [] };
      if (sql.includes("SELECT provider FROM professional_subscriptions")) return { rows: subscriptionRow ? [{ provider: subscriptionRow.provider }] : [] };
      if (sql.includes("INSERT INTO professional_subscription_provider_events")) {
        if (events.has(params[0])) return { rowCount: 0, rows: [] };
        events.add(params[0]); return { rowCount: 1, rows: [{ id: "event-row" }] };
      }
      if (sql.includes("INSERT INTO professional_subscriptions")) {
        subscriptionRow = {
          provider: "STRIPE", provider_product_id: params[2], effective_plan: params[5], status: params[6], seat_limit: params[7],
          access_started_at: params[8], access_ends_at: params[9], trial_eligible: params[10], trial_ends_at: params[11],
          will_auto_renew: params[12], grace_period_ends_at: params[13], canceled_at: params[14], last_verified_at: params[15], version: 1,
        };
        return { rowCount: 1, rows: [subscriptionRow] };
      }
      if (sql.includes("SELECT * FROM professional_subscriptions")) return { rows: subscriptionRow ? [subscriptionRow] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  return { events, pool: { connect: async () => client } };
}

function stripeEvidence() {
  const start = Math.floor(Date.now() / 1000);
  return {
    event: { id: "evt_verified_1", type: "customer.subscription.created", created: start, livemode: false },
    subscription: {
      id: "sub_verified_1", customer: "cus_verified", status: "trialing", trial_start: start,
      trial_end: start + 14 * 86400, current_period_start: start, current_period_end: start + 14 * 86400,
      metadata: { meetro_business_id: "12", meetro_app_account_token: token, meetro_plan: "COMMUNITY_2_USER_MONTHLY" },
      items: { data: [{ price: { id: "price_meetro_plan_a" } }] },
    },
  };
}

test("verified Stripe webhook replay is idempotent and grants the shared business entitlement once", async () => {
  const { events, pool } = stripeAuthorityPool();
  const evidence = stripeEvidence();
  const first = await processStripeSubscriptionEvent({ pool, ...evidence, providerRetrieved: true, environment });
  const replay = await processStripeSubscriptionEvent({ pool, ...evidence, providerRetrieved: true, environment });
  assert.equal(first.code, "SUBSCRIPTION_VERIFIED");
  assert.equal(first.entitled, true);
  assert.equal(first.subscription.plan, "COMMUNITY_2_USER_MONTHLY");
  assert.equal(replay.code, "SUBSCRIPTION_VERIFICATION_REPLAYED");
  assert.equal(events.size, 1);
});

test("wrong business cannot claim a Stripe subscription", async () => {
  const { events, pool } = stripeAuthorityPool({ ownerMatches: false });
  const result = await processStripeSubscriptionEvent({ pool, ...stripeEvidence(), providerRetrieved: true, environment });
  assert.equal(result.code, "STRIPE_SUBSCRIPTION_BUSINESS_MISMATCH");
  assert.equal(events.size, 0);
});

test("forged browser webhook and Checkout success cannot create entitlement", async () => {
  let processed = 0;
  const handlers = createSubscriptionHandlers({
    getPool: () => ({}), environment, sendPublicDatabaseError: ({ error }) => { throw error; },
    stripeProviderFactory: () => ({ constructEvent() { throw new Error("bad signature"); } }),
    service: { processStripeSubscriptionEvent: async () => { processed++; } },
  });
  const response = responseRecorder();
  await handlers.stripeWebhook({ rawBody: Buffer.from('{"success":true}'), headers: {} }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STRIPE_WEBHOOK_NOT_VERIFIED");
  assert.equal(processed, 0);
});

test("verified webhook handling re-reads current Stripe state instead of trusting event delivery order", async () => {
  let retrieved = 0;
  let received;
  const handlers = createSubscriptionHandlers({
    getPool: () => ({}), environment, sendPublicDatabaseError: ({ error }) => { throw error; },
    stripeProviderFactory: () => ({
      constructEvent: () => ({ id: "evt_verified", type: "customer.subscription.updated", data: { object: { id: "sub_verified", status: "past_due" } } }),
      retrieveSubscription: async (id) => { retrieved++; assert.equal(id, "sub_verified"); return { id, status: "active" }; },
    }),
    service: { processStripeSubscriptionEvent: async (input) => { received = input; return { ok: true, status: 200, code: "SUBSCRIPTION_VERIFIED" }; } },
  });
  const response = responseRecorder();
  await handlers.stripeWebhook({ rawBody: Buffer.from("verified"), headers: { "stripe-signature": "verified" } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(retrieved, 1);
  assert.equal(received.providerRetrieved, true);
  assert.equal(received.subscription.status, "active");
});

test("provider-specific management routes Apple to Apple and Stripe to Billing Portal", async () => {
  const context = { id: 8, email: "pro@example.test", account_type: "professional", contractor_profile_id: 12 };
  const applePool = { query: async (sql) => ({ rows: sql.includes("FROM users") ? [context] : [{ provider: "APPLE_APP_STORE", stripe_customer_id: null }] }) };
  const apple = await createSubscriptionManagement({ pool: applePool, authenticatedActor: { id: 8 }, environment, stripeProvider: {} });
  assert.equal(apple.provider, "APPLE_APP_STORE");
  assert.match(apple.url, /apps\.apple\.com/);
  const stripePool = { query: async (sql) => ({ rows: sql.includes("FROM users") ? [context] : [{ provider: "STRIPE", stripe_customer_id: "cus_verified" }] }) };
  const stripe = await createSubscriptionManagement({
    pool: stripePool, authenticatedActor: { id: 8 }, environment,
    stripeProvider: { checkoutConfigured: true, createPortalSession: async () => ({ url: "https://billing.stripe.test/portal" }) },
  });
  assert.equal(stripe.provider, "STRIPE");
  assert.equal(stripe.url, "https://billing.stripe.test/portal");
});

test("dedicated staging provider-test businesses can disable QA access but production can never enable it", () => {
  assert.equal(stagingQaAccess({ NODE_ENV: "staging", SUBSCRIPTION_STAGING_QA_DISABLED_BUSINESS_IDS: "11,12" }, 12), false);
  assert.equal(stagingQaAccess({ NODE_ENV: "staging", SUBSCRIPTION_STAGING_QA_DISABLED_BUSINESS_IDS: "11,12" }, 13), true);
  assert.equal(stagingQaAccess({ NODE_ENV: "production", SUBSCRIPTION_STAGING_QA_ACCESS: "enabled" }, 13), false);
});

test("Migration 66 adds only Stripe subscription authority and remains isolated from customer Job billing", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/202608300002_add_stripe_subscription_authority.sql"), "utf8");
  assert.match(sql, /'APPLE_APP_STORE', 'STRIPE'/);
  assert.match(sql, /stripe_customer_id/);
  assert.doesNotMatch(sql, /canonical_invoices|invoice_payments|deposit_requests|\bjobs\b|canonical_quotes|alerts/i);
});
