"use strict";

const { createHash } = require("node:crypto");
const { getSubscriptionCatalog, planForCode, planForProductId, planForStripePriceId } = require("./subscriptionCatalog");
const { createAppleSubscriptionVerifier } = require("./appleSubscriptionVerifier");
const {
  SUBSCRIPTION_ENFORCEMENT_MODES,
  resolveSubscriptionEnforcementMode,
} = require("./subscriptionEnforcementMode");

const MEETRO_BUSINESS_TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function entitledStatus(status, accessEndsAt, now = Date.now()) {
  return ["TRIAL", "ACTIVE", "GRACE", "CANCELED_AT_PERIOD_END"].includes(status) &&
    new Date(accessEndsAt).getTime() > now;
}

function serializeSubscription(row) {
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
    entitled: entitledStatus(row.status, row.access_ends_at),
  };
}

function serializeBusinessTrial(row, { providerConverted = false, now = Date.now() } = {}) {
  if (!row) return null;
  const startsAt = row.starts_at || null;
  const endsAt = row.ends_at || null;
  const convertedAt = row.converted_at || null;
  const endTime = endsAt ? new Date(endsAt).getTime() : Number.NaN;
  const converted = Boolean(convertedAt || providerConverted);
  const active = Boolean(startsAt && Number.isFinite(endTime) && endTime > now && !converted);
  const status = converted ? "CONVERTED" : !startsAt ? "PENDING" : active ? "ACTIVE" : "EXPIRED";
  return {
    source: "MEETRO_SERVER",
    status,
    startsAt,
    endsAt,
    convertedAt,
    trialDays: MEETRO_BUSINESS_TRIAL_DAYS,
    daysRemaining: active ? Math.max(1, Math.ceil((endTime - now) / DAY_MS)) : 0,
    entitled: active,
  };
}

async function activateReservedMeetroBusinessTrial({ pool, userId }) {
  if (!pool || !Number.isSafeInteger(Number(userId))) return null;
  const activated = await pool.query(
    `UPDATE meetro_business_trials trials
        SET starts_at = CURRENT_TIMESTAMP,
            ends_at = CURRENT_TIMESTAMP + INTERVAL '14 days'
      WHERE trials.user_id = $1
        AND trials.starts_at IS NULL
        AND EXISTS (
          SELECT 1 FROM users
          WHERE users.id = trials.user_id
            AND users.account_type = 'professional'
        )
      RETURNING trials.*`,
    [Number(userId)]
  );
  if (activated.rows[0]) return serializeBusinessTrial(activated.rows[0]);
  const current = await pool.query(
    `SELECT * FROM meetro_business_trials WHERE user_id = $1`,
    [Number(userId)]
  );
  return serializeBusinessTrial(current.rows[0] || null);
}

async function markBusinessTrialConverted(client, contractorProfileId) {
  await client.query(
    `UPDATE meetro_business_trials
        SET converted_at = COALESCE(converted_at, CURRENT_TIMESTAMP)
      WHERE contractor_profile_id = $1
        AND starts_at IS NOT NULL`,
    [Number(contractorProfileId)]
  );
}

async function loadBusinessContext(client, userId) {
  const result = await client.query(
    `SELECT users.id, users.email, users.account_type, profiles.id AS contractor_profile_id
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
     RETURNING contractor_profile_id, app_account_token, stripe_customer_id`,
    [contractorProfileId]
  );
  return result.rows[0];
}

async function hasActiveBusinessAuthority(database, userId, contractorProfileId) {
  const result = await database.query(
    `SELECT 1
       FROM business_team_memberships memberships
      WHERE memberships.user_id = $1
        AND memberships.contractor_profile_id = $2
        AND memberships.status = 'ACTIVE'
      LIMIT 1`,
    [Number(userId), Number(contractorProfileId)]
  );
  return Boolean(result.rows[0]);
}

async function getSubscriptionState({ pool, authenticatedActor, environment = process.env }) {
  if (!pool || !Number.isSafeInteger(Number(authenticatedActor?.id))) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  }
  const context = await loadBusinessContext(pool, Number(authenticatedActor.id));
  if (!context) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  const catalog = getSubscriptionCatalog(environment);
  const subscriptionEnforcementMode = resolveSubscriptionEnforcementMode(environment);
  if (context.account_type !== "professional") {
    return {
      ok: true,
      status: 200,
      code: "SUBSCRIPTION_NOT_APPLICABLE",
      applicable: false,
      businessAccessActive: true,
      subscriptionEnforcementMode,
      entitled: true,
      catalog: [],
    };
  }
  if (!context.contractor_profile_id) {
    return failure(409, "BUSINESS_PROFILE_REQUIRED", "Complete the business profile before managing a plan.");
  }
  const acceptanceMode =
    subscriptionEnforcementMode === SUBSCRIPTION_ENFORCEMENT_MODES.NON_BLOCKING_ACCEPTANCE;
  if (acceptanceMode && !await hasActiveBusinessAuthority(
    pool,
    context.id,
    context.contractor_profile_id
  )) {
    return failure(
      403,
      "BUSINESS_AUTHORITY_REQUIRED",
      "An active business membership is required."
    );
  }
  const account = await ensureSubscriptionAccount(pool, Number(context.contractor_profile_id));
  const result = await pool.query(
    `SELECT * FROM professional_subscriptions WHERE contractor_profile_id = $1`,
    [context.contractor_profile_id]
  );
  const subscription = result.rows[0] || null;
  const trialResult = await pool.query(
    `SELECT * FROM meetro_business_trials WHERE user_id = $1`,
    [context.id]
  );
  const trialRow = trialResult.rows[0] || null;
  const businessTrial = serializeBusinessTrial(trialRow, { providerConverted: Boolean(subscription) });
  const providerEntitled = Boolean(subscription && entitledStatus(subscription.status, subscription.access_ends_at));
  const trialEntitled = !subscription && businessTrial?.entitled === true;
  const businessAccessActive = acceptanceMode || trialEntitled || providerEntitled;
  const purchaseAvailable = catalog.some((plan) =>
    plan.providers.APPLE_APP_STORE.configured || plan.providers.STRIPE.configured);
  return {
    ok: true,
    status: 200,
    code: "SUBSCRIPTION_STATE_LOADED",
    applicable: true,
    businessAccessActive,
    subscriptionEnforcementMode,
    entitled: businessAccessActive,
    paidEntitlementActive: providerEntitled,
    purchaseAvailable,
    businessId: Number(context.contractor_profile_id),
    appAccountToken: account.app_account_token,
    catalog,
    productConfigurationRequired: catalog.some((plan) =>
      !plan.providers.APPLE_APP_STORE.configured && !plan.providers.STRIPE.configured),
    trialEligibility: businessTrial?.status || "NOT_RESERVED",
    businessTrial,
    subscription: serializeSubscription(subscription),
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
  if (providerState.status === "TRIAL") {
    return failure(422, "APPLE_PROVIDER_TRIAL_NOT_SUPPORTED", "Apple must confirm a paid Meetro subscription. The initial Meetro Business Trial is server-governed.");
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
    const existingAuthority = await client.query(
      `SELECT provider, status, access_ends_at FROM professional_subscriptions
       WHERE contractor_profile_id = $1 FOR UPDATE`,
      [context.contractor_profile_id]
    );
    if (existingAuthority.rows[0] && existingAuthority.rows[0].provider !== "APPLE_APP_STORE") {
      await client.query("ROLLBACK");
      return failure(409, "SUBSCRIPTION_PROVIDER_CHANGE_REQUIRES_REVIEW", "This business already has subscription authority from another provider.");
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
    if (subscription && entitledStatus(subscription.status, subscription.access_ends_at)) {
      await markBusinessTrialConverted(client, context.contractor_profile_id);
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

function stripePeriod(subscription) {
  const item = subscription?.items?.data?.[0] || null;
  const started = subscription?.current_period_start || item?.current_period_start || subscription?.start_date;
  const ends = subscription?.current_period_end || item?.current_period_end || subscription?.cancel_at || subscription?.ended_at;
  const iso = (seconds) => normalizeInstant(Number(seconds) * 1000);
  return { startedAt: iso(started), endsAt: iso(ends) };
}

function deriveStripeProviderState(subscription, now = Date.now()) {
  const period = stripePeriod(subscription);
  if (!period.startedAt || !period.endsAt) return null;
  const trialStart = normalizeInstant(Number(subscription.trial_start) * 1000);
  const trialEnd = normalizeInstant(Number(subscription.trial_end) * 1000);
  let status;
  if (subscription.status === "trialing" && trialStart && trialEnd) status = "TRIAL";
  else if (subscription.status === "active") status = subscription.cancel_at_period_end ? "CANCELED_AT_PERIOD_END" : "ACTIVE";
  else if (subscription.status === "past_due" && new Date(period.endsAt).getTime() > now) status = "GRACE";
  else status = "EXPIRED";
  return {
    status,
    startedAt: status === "TRIAL" ? trialStart : period.startedAt,
    endsAt: status === "TRIAL" ? trialEnd : period.endsAt,
    trialEligible: trialEnd ? false : null,
    trialEndsAt: status === "TRIAL" ? trialEnd : null,
    willAutoRenew: !subscription.cancel_at_period_end && !["canceled", "unpaid", "paused", "incomplete_expired"].includes(subscription.status),
    graceEndsAt: status === "GRACE" ? period.endsAt : null,
    canceledAt: subscription.canceled_at ? normalizeInstant(Number(subscription.canceled_at) * 1000) : null,
  };
}

function configuredReturnUrl(environment) {
  const value = String(environment.STRIPE_SUBSCRIPTION_RETURN_URL || "").trim();
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

async function createStripeCheckout({ pool, authenticatedActor, planCode, stripeProvider, environment = process.env }) {
  if (!pool || !Number.isSafeInteger(Number(authenticatedActor?.id))) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!stripeProvider?.checkoutConfigured) return failure(503, "STRIPE_SERVER_CONFIGURATION_REQUIRED", "Web subscription checkout is not configured.");
  const plan = planForCode(planCode, environment);
  const priceId = plan?.providers?.STRIPE?.priceId;
  const returnUrl = configuredReturnUrl(environment);
  if (!plan || !priceId) return failure(400, "STRIPE_PLAN_UNAVAILABLE", "That web subscription plan is unavailable.");
  if (!returnUrl) return failure(503, "STRIPE_RETURN_URL_REQUIRED", "Web subscription return routing is not configured.");
  const providerPrice = await stripeProvider.retrievePrice(priceId);
  if (providerPrice?.active !== true || Number(providerPrice.unit_amount) !== plan.amountMinor ||
      String(providerPrice.currency || "").toUpperCase() !== plan.currency ||
      providerPrice.recurring?.interval !== "month" || Number(providerPrice.recurring?.interval_count || 1) !== 1) {
    return failure(503, "STRIPE_PLAN_CONFIGURATION_MISMATCH", "The configured Stripe price does not match this Meetro plan.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = await loadBusinessContext(client, Number(authenticatedActor.id));
    if (!context || context.account_type !== "professional" || !context.contractor_profile_id) {
      await client.query("ROLLBACK");
      return failure(403, "PROFESSIONAL_BUSINESS_REQUIRED", "A professional business account is required.");
    }
    const existing = await client.query(
      `SELECT provider, status, access_ends_at FROM professional_subscriptions
       WHERE contractor_profile_id = $1 FOR UPDATE`, [context.contractor_profile_id]
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return failure(409, entitledStatus(existing.rows[0].status, existing.rows[0].access_ends_at)
        ? "ACTIVE_SUBSCRIPTION_EXISTS" : "SUBSCRIPTION_PROVIDER_CHANGE_REQUIRES_REVIEW",
      "This business already has subscription authority. Manage that subscription instead of purchasing another one.");
    }
    let account = await ensureSubscriptionAccount(client, Number(context.contractor_profile_id));
    let customerId = account.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeProvider.createCustomer({
        email: context.email || undefined,
        metadata: { meetro_business_id: String(context.contractor_profile_id), meetro_app_account_token: String(account.app_account_token) },
      }, { idempotencyKey: `meetro-stripe-customer-${account.app_account_token}` });
      customerId = customer.id;
      const saved = await client.query(
        `UPDATE professional_subscription_accounts SET stripe_customer_id = $1
         WHERE contractor_profile_id = $2 AND stripe_customer_id IS NULL
         RETURNING stripe_customer_id`, [customerId, context.contractor_profile_id]
      );
      customerId = saved.rows[0]?.stripe_customer_id || customerId;
    }
    const metadata = {
      meetro_business_id: String(context.contractor_profile_id),
      meetro_app_account_token: String(account.app_account_token),
      meetro_plan: plan.code,
    };
    const session = await stripeProvider.createCheckoutSession({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata },
      metadata,
      success_url: returnUrl,
      cancel_url: returnUrl,
    }, { idempotencyKey: `meetro-checkout-${account.app_account_token}-${plan.code}` });
    await client.query("COMMIT");
    return { ok: true, status: 201, code: "STRIPE_CHECKOUT_CREATED", provider: "STRIPE", url: session.url };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
}

async function createSubscriptionManagement({ pool, authenticatedActor, stripeProvider, environment = process.env }) {
  if (!pool || !Number.isSafeInteger(Number(authenticatedActor?.id))) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  const context = await loadBusinessContext(pool, Number(authenticatedActor.id));
  if (!context || context.account_type !== "professional" || !context.contractor_profile_id) return failure(403, "PROFESSIONAL_BUSINESS_REQUIRED", "A professional business account is required.");
  const result = await pool.query(
    `SELECT subscriptions.provider, accounts.stripe_customer_id
       FROM professional_subscriptions subscriptions
       JOIN professional_subscription_accounts accounts USING (contractor_profile_id)
      WHERE subscriptions.contractor_profile_id = $1`, [context.contractor_profile_id]
  );
  const row = result.rows[0];
  if (!row) return failure(404, "SUBSCRIPTION_NOT_FOUND", "No provider subscription is available to manage.");
  if (row.provider === "APPLE_APP_STORE") return { ok: true, status: 200, code: "APPLE_MANAGEMENT_REQUIRED", provider: row.provider, url: "https://apps.apple.com/account/subscriptions" };
  if (!stripeProvider?.checkoutConfigured || !row.stripe_customer_id) return failure(503, "STRIPE_MANAGEMENT_UNAVAILABLE", "Stripe subscription management is unavailable.");
  const returnUrl = configuredReturnUrl(environment);
  if (!returnUrl) return failure(503, "STRIPE_RETURN_URL_REQUIRED", "Web subscription return routing is not configured.");
  const session = await stripeProvider.createPortalSession({ customer: row.stripe_customer_id, return_url: returnUrl });
  return { ok: true, status: 200, code: "STRIPE_MANAGEMENT_CREATED", provider: "STRIPE", url: session.url };
}

async function processStripeSubscriptionEvent({ pool, event, subscription, providerRetrieved = false, environment = process.env }) {
  if (!providerRetrieved) return failure(422, "STRIPE_CURRENT_STATE_REQUIRED", "Current Stripe subscription state must be retrieved after webhook verification.");
  const businessId = Number(subscription?.metadata?.meetro_business_id);
  const accountToken = String(subscription?.metadata?.meetro_app_account_token || "").toLowerCase();
  const customerId = typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id;
  const priceId = subscription?.items?.data?.[0]?.price?.id;
  const plan = planForStripePriceId(priceId, environment);
  const providerState = deriveStripeProviderState(subscription);
  const verifiedAt = normalizeInstant(Number(event?.created) * 1000);
  if (!Number.isSafeInteger(businessId) || !accountToken || !customerId || !plan || !providerState || !verifiedAt || !event?.id || !subscription?.id) {
    return failure(422, "STRIPE_EVIDENCE_MISMATCH", "Stripe subscription evidence does not match a configured Meetro business and plan.");
  }
  if (providerState.status === "TRIAL") {
    return failure(422, "STRIPE_PROVIDER_TRIAL_NOT_SUPPORTED", "Stripe must confirm a paid Meetro subscription. The initial Meetro Business Trial is server-governed.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT contractor_profile_id FROM professional_subscription_accounts
       WHERE contractor_profile_id = $1 AND lower(app_account_token::text) = $2 AND stripe_customer_id = $3 FOR UPDATE`,
      [businessId, accountToken, customerId]
    );
    if (!owner.rows[0]) {
      await client.query("ROLLBACK");
      return failure(409, "STRIPE_SUBSCRIPTION_BUSINESS_MISMATCH", "This Stripe subscription belongs to another business account.");
    }
    const existing = await client.query(`SELECT provider FROM professional_subscriptions WHERE contractor_profile_id = $1 FOR UPDATE`, [businessId]);
    if (existing.rows[0] && existing.rows[0].provider !== "STRIPE") {
      await client.query("ROLLBACK");
      return failure(409, "SUBSCRIPTION_PROVIDER_CHANGE_REQUIRES_REVIEW", "This business already has subscription authority from another provider.");
    }
    const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const recorded = await client.query(
      `INSERT INTO professional_subscription_provider_events
        (provider, provider_event_id, provider_original_transaction_id, provider_transaction_id, contractor_profile_id, event_type, payload_sha256)
       VALUES ('STRIPE', $1, $2, $1, $3, $4, $5)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [event.id, subscription.id, businessId, event.type, digest]
    );
    if (recorded.rowCount === 0) {
      const current = await client.query(`SELECT * FROM professional_subscriptions WHERE contractor_profile_id = $1`, [businessId]);
      await client.query("COMMIT");
      return { ok: true, status: 200, code: "SUBSCRIPTION_VERIFICATION_REPLAYED", replayed: true, entitled: Boolean(current.rows[0] && entitledStatus(current.rows[0].status, current.rows[0].access_ends_at)), subscription: serializeSubscription(current.rows[0]) };
    }
    const result = await client.query(
      `INSERT INTO professional_subscriptions
        (contractor_profile_id, provider, provider_environment, provider_product_id, provider_original_transaction_id,
         latest_provider_transaction_id, effective_plan, status, seat_limit, access_started_at, access_ends_at,
         trial_eligible, trial_ends_at, will_auto_renew, grace_period_ends_at, canceled_at, last_verified_at)
       VALUES ($1, 'STRIPE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (contractor_profile_id) DO UPDATE SET
         provider_environment = EXCLUDED.provider_environment, provider_product_id = EXCLUDED.provider_product_id,
         latest_provider_transaction_id = EXCLUDED.latest_provider_transaction_id, effective_plan = EXCLUDED.effective_plan,
         status = EXCLUDED.status, seat_limit = EXCLUDED.seat_limit, access_started_at = EXCLUDED.access_started_at,
         access_ends_at = EXCLUDED.access_ends_at, trial_eligible = EXCLUDED.trial_eligible,
         trial_ends_at = EXCLUDED.trial_ends_at, will_auto_renew = EXCLUDED.will_auto_renew,
         grace_period_ends_at = EXCLUDED.grace_period_ends_at, canceled_at = EXCLUDED.canceled_at,
         last_verified_at = GREATEST(professional_subscriptions.last_verified_at, EXCLUDED.last_verified_at)
       WHERE professional_subscriptions.provider = 'STRIPE' RETURNING *`,
      [businessId, event.livemode ? "LIVE" : "TEST", priceId, subscription.id, event.id, plan.code,
        providerState.status, plan.seatLimit, providerState.startedAt, providerState.endsAt,
        providerState.trialEligible, providerState.trialEndsAt, providerState.willAutoRenew,
        providerState.graceEndsAt, providerState.canceledAt, verifiedAt]
    );
    let row = result.rows[0];
    if (!row) row = (await client.query(`SELECT * FROM professional_subscriptions WHERE contractor_profile_id = $1`, [businessId])).rows[0];
    if (row && entitledStatus(row.status, row.access_ends_at)) {
      await markBusinessTrialConverted(client, businessId);
    }
    await client.query("COMMIT");
    return { ok: true, status: 200, code: result.rowCount ? "SUBSCRIPTION_VERIFIED" : "SUBSCRIPTION_VERIFIED_NO_CHANGE", replayed: false, entitled: entitledStatus(row.status, row.access_ends_at), subscription: serializeSubscription(row) };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error?.code === "23505") return failure(409, "STRIPE_SUBSCRIPTION_BUSINESS_MISMATCH", "This Stripe subscription is already bound to another business account.");
    throw error;
  } finally { client.release(); }
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
  activateReservedMeetroBusinessTrial,
  assertSeatAvailable,
  createStripeCheckout,
  createSubscriptionManagement,
  deriveProviderState,
  deriveStripeProviderState,
  entitledStatus,
  getSubscriptionState,
  serializeBusinessTrial,
  serializeSubscription,
  processStripeSubscriptionEvent,
  verifyAppleEvidence,
};
