"use strict";

const { createHash } = require("node:crypto");
const { getSubscriptionCatalog, planForProductId } = require("./subscriptionCatalog");
const { createAppleSubscriptionVerifier } = require("./appleSubscriptionVerifier");

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function entitledStatus(status, accessEndsAt, now = Date.now()) {
  return ["TRIAL", "ACTIVE", "GRACE", "CANCELED_AT_PERIOD_END"].includes(status) &&
    new Date(accessEndsAt).getTime() > now;
}

function serializeSubscription(row, { qaAccess = false } = {}) {
  if (!row) return null;
  return {
    provider: row.provider,
    providerProductId: row.provider_product_id,
    plan: row.effective_plan,
    status: row.status,
    seatLimit: Number(row.seat_limit),
    accessStartedAt: row.access_started_at,
    accessEndsAt: row.access_ends_at,
    trialEligible: row.trial_eligible,
    trialEndsAt: row.trial_ends_at,
    willAutoRenew: row.will_auto_renew,
    gracePeriodEndsAt: row.grace_period_ends_at,
    canceledAt: row.canceled_at,
    revokedAt: row.revoked_at,
    lastVerifiedAt: row.last_verified_at,
    version: Number(row.version || 1),
    entitled: qaAccess || entitledStatus(row.status, row.access_ends_at),
    qaAccess,
  };
}

async function loadBusinessContext(client, userId) {
  const result = await client.query(
    `SELECT users.id, users.account_type, profiles.id AS contractor_profile_id
       FROM users
       LEFT JOIN contractor_profiles profiles ON profiles.user_id = users.id
      WHERE users.id = $1
      ORDER BY profiles.created_at ASC NULLS LAST, profiles.id ASC NULLS LAST
      LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function ensureSubscriptionAccount(client, contractorProfileId) {
  const result = await client.query(
    `INSERT INTO professional_subscription_accounts (contractor_profile_id)
     VALUES ($1)
     ON CONFLICT (contractor_profile_id) DO UPDATE
       SET contractor_profile_id = EXCLUDED.contractor_profile_id
     RETURNING contractor_profile_id, app_account_token`,
    [contractorProfileId]
  );
  return result.rows[0];
}

function stagingQaAccess(environment = process.env) {
  return String(environment.NODE_ENV || "").toLowerCase() === "staging" &&
    String(environment.SUBSCRIPTION_STAGING_QA_ACCESS || "enabled").toLowerCase() === "enabled";
}

async function getSubscriptionState({ pool, authenticatedActor, environment = process.env }) {
  if (!pool || !Number.isSafeInteger(Number(authenticatedActor?.id))) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  }
  const context = await loadBusinessContext(pool, Number(authenticatedActor.id));
  if (!context) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  const catalog = getSubscriptionCatalog(environment);
  if (context.account_type !== "professional") {
    return { ok: true, status: 200, code: "SUBSCRIPTION_NOT_APPLICABLE", applicable: false, entitled: true, catalog: [] };
  }
  if (!context.contractor_profile_id) {
    return failure(409, "BUSINESS_PROFILE_REQUIRED", "Complete the business profile before managing a plan.");
  }
  const account = await ensureSubscriptionAccount(pool, Number(context.contractor_profile_id));
  const result = await pool.query(
    `SELECT * FROM professional_subscriptions WHERE contractor_profile_id = $1`,
    [context.contractor_profile_id]
  );
  const subscription = result.rows[0] || null;
  const qaAccess = !subscription && stagingQaAccess(environment);
  return {
    ok: true,
    status: 200,
    code: "SUBSCRIPTION_STATE_LOADED",
    applicable: true,
    entitled: qaAccess || Boolean(subscription && entitledStatus(subscription.status, subscription.access_ends_at)),
    businessId: Number(context.contractor_profile_id),
    appAccountToken: account.app_account_token,
    catalog,
    productConfigurationRequired: catalog.some((plan) => !plan.providerConfigured),
    trialEligibility: subscription?.trial_eligible === true ? "ELIGIBLE" :
      subscription?.trial_eligible === false ? "INELIGIBLE" : "PROVIDER_REQUIRED",
    subscription: serializeSubscription(subscription, { qaAccess }),
    qaAccess: qaAccess ? {
      source: "STAGING_EXISTING_PROFESSIONAL_COMPATIBILITY",
      environment: "staging",
      productionAllowed: false,
    } : null,
  };
}

function normalizeInstant(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deriveProviderState(transaction, renewalInfo, now = Date.now()) {
  const startedAt = normalizeInstant(transaction.purchaseDate || transaction.originalPurchaseDate);
  const endsAt = normalizeInstant(transaction.expiresDate);
  if (!startedAt || !endsAt) return null;
  const revokedAt = normalizeInstant(transaction.revocationDate);
  const graceEndsAt = normalizeInstant(renewalInfo?.gracePeriodExpiresDate);
  const introductory = Number(transaction.offerType) === 1;
  const freeTrial = introductory && String(transaction.offerDiscountType || "").toUpperCase() === "FREE_TRIAL";
  const autoRenew = renewalInfo?.autoRenewStatus == null ? null : Number(renewalInfo.autoRenewStatus) === 1;
  let status = "ACTIVE";
  if (revokedAt) status = "REVOKED";
  else if (graceEndsAt && new Date(graceEndsAt).getTime() > now) status = "GRACE";
  else if (new Date(endsAt).getTime() <= now) status = "EXPIRED";
  else if (autoRenew === false) status = "CANCELED_AT_PERIOD_END";
  else if (freeTrial) status = "TRIAL";
  const effectiveEndsAt = status === "GRACE" && graceEndsAt ? graceEndsAt : endsAt;
  return {
    status,
    startedAt,
    endsAt: effectiveEndsAt,
    trialEligible: introductory ? false : null,
    trialEndsAt: status === "TRIAL" ? endsAt : null,
    willAutoRenew: autoRenew,
    graceEndsAt,
    canceledAt: status === "CANCELED_AT_PERIOD_END" ? new Date().toISOString() : null,
    revokedAt,
  };
}

async function verifyAppleEvidence({
  pool,
  authenticatedActor,
  signedTransactionInfo,
  signedRenewalInfo,
  providerSignedAt,
  eventType = "CLIENT_VERIFICATION",
  verifier = createAppleSubscriptionVerifier(),
  environment = process.env,
}) {
  if (!pool || !Number.isSafeInteger(Number(authenticatedActor?.id))) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  }
  if (typeof signedTransactionInfo !== "string" || signedTransactionInfo.length < 100 ||
      (signedRenewalInfo != null && typeof signedRenewalInfo !== "string")) {
    return failure(400, "INVALID_APPLE_EVIDENCE", "Apple purchase evidence is invalid.");
  }
  if (!verifier.configured) {
    return failure(503, "APPLE_SERVER_CONFIGURATION_REQUIRED", "Apple purchase verification is not configured.");
  }
  let transaction;
  let renewalInfo;
  try {
    transaction = await verifier.verifyTransaction(signedTransactionInfo);
    renewalInfo = signedRenewalInfo ? await verifier.verifyRenewalInfo(signedRenewalInfo) : null;
  } catch {
    return failure(422, "APPLE_EVIDENCE_NOT_VERIFIED", "Apple could not verify this purchase.");
  }
  const plan = planForProductId(transaction.productId, environment);
  const providerState = deriveProviderState(transaction, renewalInfo);
  const providerVerifiedAt = normalizeInstant(
    providerSignedAt ||
    renewalInfo?.signedDate ||
    transaction.signedDate ||
    transaction.purchaseDate ||
    transaction.originalPurchaseDate
  );
  const originalId = String(transaction.originalTransactionId || "").trim();
  const transactionId = String(transaction.transactionId || "").trim();
  const appAccountToken = String(transaction.appAccountToken || "").toLowerCase();
  if (!plan || !providerState || !providerVerifiedAt || !originalId || !transactionId || !appAccountToken) {
    return failure(422, "APPLE_EVIDENCE_MISMATCH", "Apple purchase evidence does not match a configured Meetro plan.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = await loadBusinessContext(client, Number(authenticatedActor.id));
    if (!context || context.account_type !== "professional" || !context.contractor_profile_id) {
      await client.query("ROLLBACK");
      return failure(403, "PROFESSIONAL_BUSINESS_REQUIRED", "A professional business account is required.");
    }
    const account = await ensureSubscriptionAccount(client, Number(context.contractor_profile_id));
    if (String(account.app_account_token).toLowerCase() !== appAccountToken) {
      await client.query("ROLLBACK");
      return failure(409, "APPLE_TRANSACTION_BUSINESS_MISMATCH", "This purchase belongs to another business account.");
    }
    const claimed = await client.query(
      `SELECT contractor_profile_id FROM professional_subscriptions
       WHERE provider_original_transaction_id = $1 FOR UPDATE`,
      [originalId]
    );
    if (claimed.rows[0] && Number(claimed.rows[0].contractor_profile_id) !== Number(context.contractor_profile_id)) {
      await client.query("ROLLBACK");
      return failure(409, "APPLE_TRANSACTION_BUSINESS_MISMATCH", "This purchase belongs to another business account.");
    }
    const eventId = `${transactionId}:${eventType}`;
    const digest = createHash("sha256").update(signedTransactionInfo).digest("hex");
    const event = await client.query(
      `INSERT INTO professional_subscription_provider_events
        (provider, provider_event_id, provider_original_transaction_id, provider_transaction_id,
         contractor_profile_id, event_type, payload_sha256)
       VALUES ('APPLE_APP_STORE', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [eventId, originalId, transactionId, context.contractor_profile_id, eventType, digest]
    );
    const result = await client.query(
      `INSERT INTO professional_subscriptions
        (contractor_profile_id, provider, provider_environment, provider_product_id,
         provider_original_transaction_id, latest_provider_transaction_id, effective_plan,
         status, seat_limit, access_started_at, access_ends_at, trial_eligible, trial_ends_at,
         will_auto_renew, grace_period_ends_at, canceled_at, revoked_at, last_verified_at)
       VALUES ($1, 'APPLE_APP_STORE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (contractor_profile_id) DO UPDATE SET
         provider_environment = EXCLUDED.provider_environment,
         provider_product_id = EXCLUDED.provider_product_id,
         latest_provider_transaction_id = EXCLUDED.latest_provider_transaction_id,
         effective_plan = EXCLUDED.effective_plan,
         status = EXCLUDED.status,
         seat_limit = EXCLUDED.seat_limit,
         access_started_at = EXCLUDED.access_started_at,
         access_ends_at = EXCLUDED.access_ends_at,
         trial_eligible = EXCLUDED.trial_eligible,
         trial_ends_at = EXCLUDED.trial_ends_at,
         will_auto_renew = EXCLUDED.will_auto_renew,
         grace_period_ends_at = EXCLUDED.grace_period_ends_at,
         canceled_at = EXCLUDED.canceled_at,
         revoked_at = EXCLUDED.revoked_at,
         last_verified_at = EXCLUDED.last_verified_at
       WHERE EXCLUDED.last_verified_at > professional_subscriptions.last_verified_at
       RETURNING *`,
      [
        context.contractor_profile_id,
        String(transaction.environment || "SANDBOX").toUpperCase(),
        transaction.productId,
        originalId,
        transactionId,
        plan.code,
        providerState.status,
        plan.seatLimit,
        providerState.startedAt,
        providerState.endsAt,
        providerState.trialEligible,
        providerState.trialEndsAt,
        providerState.willAutoRenew,
        providerState.graceEndsAt,
        providerState.canceledAt,
        providerState.revokedAt,
        providerVerifiedAt,
      ]
    );
    let subscription = result.rows[0];
    if (!subscription) {
      const current = await client.query(
        `SELECT * FROM professional_subscriptions WHERE contractor_profile_id = $1`,
        [context.contractor_profile_id]
      );
      subscription = current.rows[0];
    }
    await client.query("COMMIT");
    return {
      ok: true,
      status: 200,
      code: event.rowCount === 0 ? "SUBSCRIPTION_VERIFICATION_REPLAYED" :
        result.rowCount === 0 ? "SUBSCRIPTION_VERIFIED_NO_CHANGE" : "SUBSCRIPTION_VERIFIED",
      replayed: event.rowCount === 0,
      entitled: entitledStatus(subscription.status, subscription.access_ends_at),
      subscription: serializeSubscription(subscription),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error?.code === "23505") {
      return failure(409, "APPLE_TRANSACTION_BUSINESS_MISMATCH", "This purchase is already bound to another business account.");
    }
    throw error;
  } finally {
    client.release();
  }
}

function assertSeatAvailable({ entitlement, activeProfessionalSeats, additionalSeats = 1 }) {
  const used = Number(activeProfessionalSeats);
  const adding = Number(additionalSeats);
  if (!entitlement?.entitled) return failure(402, "PROFESSIONAL_SUBSCRIPTION_REQUIRED", "Choose a plan to add professional users.");
  if (!Number.isSafeInteger(used) || used < 1 || !Number.isSafeInteger(adding) || adding < 1) {
    return failure(400, "INVALID_SEAT_REQUEST", "The requested seat change is invalid.");
  }
  if (used + adding > Number(entitlement.seatLimit)) {
    return failure(409, "SUBSCRIPTION_SEAT_LIMIT_REACHED", `Your plan includes up to ${entitlement.seatLimit} users.`);
  }
  return { ok: true, status: 200, code: "SUBSCRIPTION_SEAT_AVAILABLE" };
}

module.exports = {
  assertSeatAvailable,
  deriveProviderState,
  entitledStatus,
  getSubscriptionState,
  serializeSubscription,
  stagingQaAccess,
  verifyAppleEvidence,
};
