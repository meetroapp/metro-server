"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  getSubscriptionState,
  verifyAppleEvidence,
} = require("../server/subscriptions/subscriptionService");
const {
  createSubscriptionHandlers,
} = require("../server/subscriptions/subscriptions");
const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const environment = {
  NODE_ENV: "test",
  APPLE_COMMUNITY_2_USER_MONTHLY_PRODUCT_ID: "com.meetro.community.professional.2.monthly",
  APPLE_COMMUNITY_5_USER_MONTHLY_PRODUCT_ID: "com.meetro.community.professional.5.monthly",
};

function verifier(transaction, renewalInfo = { autoRenewStatus: 1 }) {
  return {
    configured: true,
    verifyTransaction: async () => transaction,
    verifyRenewalInfo: async () => renewalInfo,
  };
}

async function createBusiness(pool, label) {
  const user = await pool.query(
    `INSERT INTO users
       (username, email, password_hash, role, account_type, business_name)
     VALUES ($1, $2, 'test-only', 'contractor', 'professional', $3)
     RETURNING id`,
    [`subscription-${label}`, `subscription-${label}@example.test`, `Subscription ${label}`]
  );
  const profile = await pool.query(
    `INSERT INTO contractor_profiles (user_id, business_name, category)
     VALUES ($1, $2, 'testing')
     RETURNING id`,
    [user.rows[0].id, `Subscription ${label}`]
  );
  const state = await getSubscriptionState({
    pool,
    authenticatedActor: { id: user.rows[0].id },
    environment,
  });
  assert.equal(state.ok, true);
  return {
    userId: Number(user.rows[0].id),
    profileId: Number(profile.rows[0].id),
    appAccountToken: String(state.appAccountToken).toLowerCase(),
  };
}

async function authorityRows(pool, profileId) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS subscriptions,
       (SELECT count(*)::integer FROM professional_subscription_provider_events
         WHERE contractor_profile_id = $1) AS events,
       (SELECT version FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS version,
       (SELECT effective_plan FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS plan,
       (SELECT status FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS status,
       (SELECT seat_limit FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS seat_limit,
       (SELECT trial_eligible FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS trial_eligible,
       (SELECT trial_ends_at FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS trial_ends_at,
       (SELECT latest_provider_transaction_id FROM professional_subscriptions
         WHERE contractor_profile_id = $1) AS latest_transaction_id`,
    [profileId]
  );
  return result.rows[0];
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test(
  "PostgreSQL certifies subscription ownership and purchase, restore, notification, stale-event, and trial replay safety",
  { skip: !process.env.DATABASE_URL },
  async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL, {
      nodeEnv: process.env.NODE_ENV,
    });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    const suffix = randomUUID();
    const base = Date.now();
    const evidence = "verified-transaction-evidence".repeat(6);
    let businessA;
    let businessB;

    try {
      businessA = await createBusiness(pool, `${suffix}-a`);
      businessB = await createBusiness(pool, `${suffix}-b`);
      const trialTransaction = {
        productId: environment.APPLE_COMMUNITY_2_USER_MONTHLY_PRODUCT_ID,
        transactionId: `${suffix}-trial-transaction`,
        originalTransactionId: `${suffix}-original`,
        appAccountToken: businessA.appAccountToken,
        environment: "SANDBOX",
        purchaseDate: base - 1_000,
        signedDate: base,
        expiresDate: base + 14 * 86_400_000,
        offerType: 1,
        offerDiscountType: "FREE_TRIAL",
      };

      const purchased = await verifyAppleEvidence({
        pool,
        authenticatedActor: { id: businessA.userId },
        signedTransactionInfo: evidence,
        eventType: "PURCHASE_OR_REFRESH",
        verifier: verifier(trialTransaction),
        environment,
      });
      assert.equal(purchased.code, "SUBSCRIPTION_VERIFIED");
      assert.equal(purchased.subscription.status, "TRIAL");
      assert.equal(purchased.subscription.trialEligible, false);
      assert.equal(purchased.subscription.seatLimit, 2);
      const originalTrialEnd = purchased.subscription.trialEndsAt;

      const wrongBusiness = await verifyAppleEvidence({
        pool,
        authenticatedActor: { id: businessB.userId },
        signedTransactionInfo: evidence,
        eventType: "PURCHASE_OR_REFRESH",
        verifier: verifier(trialTransaction),
        environment,
      });
      assert.equal(wrongBusiness.code, "APPLE_TRANSACTION_BUSINESS_MISMATCH");
      assert.deepEqual(await authorityRows(pool, businessB.profileId), {
        subscriptions: 0,
        events: 0,
        version: null,
        plan: null,
        status: null,
        seat_limit: null,
        trial_eligible: null,
        trial_ends_at: null,
        latest_transaction_id: null,
      });

      const purchaseReplay = await verifyAppleEvidence({
        pool,
        authenticatedActor: { id: businessA.userId },
        signedTransactionInfo: evidence,
        eventType: "PURCHASE_OR_REFRESH",
        verifier: verifier(trialTransaction),
        environment,
      });
      assert.equal(purchaseReplay.code, "SUBSCRIPTION_VERIFICATION_REPLAYED");
      assert.equal(
        new Date(purchaseReplay.subscription.trialEndsAt).toISOString(),
        new Date(originalTrialEnd).toISOString()
      );

      const restored = await verifyAppleEvidence({
        pool,
        authenticatedActor: { id: businessA.userId },
        signedTransactionInfo: evidence,
        eventType: "RESTORE",
        verifier: verifier(trialTransaction),
        environment,
      });
      const restoreReplay = await verifyAppleEvidence({
        pool,
        authenticatedActor: { id: businessA.userId },
        signedTransactionInfo: evidence,
        eventType: "RESTORE",
        verifier: verifier(trialTransaction),
        environment,
      });
      assert.equal(restored.code, "SUBSCRIPTION_VERIFIED_NO_CHANGE");
      assert.equal(restoreReplay.code, "SUBSCRIPTION_VERIFICATION_REPLAYED");
      assert.equal(
        new Date(restoreReplay.subscription.trialEndsAt).toISOString(),
        new Date(originalTrialEnd).toISOString()
      );
      assert.deepEqual(await authorityRows(pool, businessA.profileId), {
        subscriptions: 1,
        events: 2,
        version: 1,
        plan: "COMMUNITY_2_USER_MONTHLY",
        status: "TRIAL",
        seat_limit: 2,
        trial_eligible: false,
        trial_ends_at: new Date(originalTrialEnd),
        latest_transaction_id: trialTransaction.transactionId,
      });

      const newerTransaction = {
        ...trialTransaction,
        productId: environment.APPLE_COMMUNITY_5_USER_MONTHLY_PRODUCT_ID,
        transactionId: `${suffix}-newer-transaction`,
        purchaseDate: base + 5_000,
        signedDate: base + 10_000,
        expiresDate: base + 30 * 86_400_000,
        offerType: undefined,
        offerDiscountType: undefined,
      };
      const newer = await verifyAppleEvidence({
        pool,
        authenticatedActor: { id: businessA.userId },
        signedTransactionInfo: `${evidence}-newer`,
        eventType: "PURCHASE_OR_REFRESH",
        verifier: verifier(newerTransaction),
        environment,
      });
      assert.equal(newer.subscription.plan, "COMMUNITY_5_USER_MONTHLY");
      assert.equal(newer.subscription.seatLimit, 5);

      const staleTransaction = {
        ...trialTransaction,
        transactionId: `${suffix}-stale-transaction`,
        purchaseDate: base - 10_000,
        signedDate: base - 5_000,
        expiresDate: base + 7 * 86_400_000,
      };
      const stale = await verifyAppleEvidence({
        pool,
        authenticatedActor: { id: businessA.userId },
        signedTransactionInfo: `${evidence}-stale`,
        eventType: "SERVER_NOTIFICATION_DID_RENEW_NONE_STALE",
        verifier: verifier(staleTransaction),
        environment,
      });
      assert.equal(stale.code, "SUBSCRIPTION_VERIFIED_NO_CHANGE");
      assert.equal(stale.subscription.plan, "COMMUNITY_5_USER_MONTHLY");
      assert.equal(stale.subscription.seatLimit, 5);
      assert.equal(stale.subscription.status, "ACTIVE");

      const notificationTransaction = {
        ...newerTransaction,
        transactionId: `${suffix}-notification-transaction`,
        signedDate: base + 20_000,
        expiresDate: base + 60 * 86_400_000,
      };
      const notification = {
        notificationType: "DID_RENEW",
        subtype: null,
        notificationUUID: `${suffix}-notification`,
        signedDate: base + 20_000,
        data: {
          signedTransactionInfo: `${evidence}-notification`,
          signedRenewalInfo: `${evidence}-renewal`,
        },
      };
      const handlers = createSubscriptionHandlers({
        getPool: () => pool,
        sendPublicDatabaseError: ({ error }) => { throw error; },
        environment,
        verifierFactory: () => ({
          configured: true,
          verifyNotification: async () => notification,
          verifyTransaction: async () => notificationTransaction,
          verifyRenewalInfo: async () => ({ autoRenewStatus: 1, signedDate: base + 20_000 }),
        }),
      });
      const request = { body: { signedPayload: "verified-notification-payload".repeat(6) } };
      const firstResponse = responseRecorder();
      const replayResponse = responseRecorder();
      await handlers.appleNotification(request, firstResponse);
      await handlers.appleNotification(request, replayResponse);
      assert.equal(firstResponse.statusCode, 200);
      assert.equal(firstResponse.body.code, "SUBSCRIPTION_VERIFIED");
      assert.equal(replayResponse.statusCode, 200);
      assert.equal(replayResponse.body.code, "SUBSCRIPTION_VERIFICATION_REPLAYED");

      const finalAuthority = await authorityRows(pool, businessA.profileId);
      assert.deepEqual(finalAuthority, {
        subscriptions: 1,
        events: 5,
        version: 3,
        plan: "COMMUNITY_5_USER_MONTHLY",
        status: "ACTIVE",
        seat_limit: 5,
        trial_eligible: null,
        trial_ends_at: null,
        latest_transaction_id: notificationTransaction.transactionId,
      });
    } finally {
      if (businessA || businessB) {
        await pool.query(
          `DELETE FROM users WHERE id = ANY($1::integer[])`,
          [[businessA?.userId, businessB?.userId].filter(Boolean)]
        );
      }
      await pool.end();
    }
  }
);
