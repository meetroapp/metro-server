"use strict";

const PLAN_DEFINITIONS = Object.freeze({
  COMMUNITY_2_USER_MONTHLY: Object.freeze({
    code: "COMMUNITY_2_USER_MONTHLY",
    amountMinor: 3499,
    currency: "USD",
    billingPeriod: "MONTH",
    seatLimit: 2,
    trialDays: 14,
    productEnvironmentKey: "APPLE_COMMUNITY_2_USER_MONTHLY_PRODUCT_ID",
  }),
  COMMUNITY_5_USER_MONTHLY: Object.freeze({
    code: "COMMUNITY_5_USER_MONTHLY",
    amountMinor: 6999,
    currency: "USD",
    billingPeriod: "MONTH",
    seatLimit: 5,
    trialDays: 14,
    productEnvironmentKey: "APPLE_COMMUNITY_5_USER_MONTHLY_PRODUCT_ID",
  }),
});

function configuredProductId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && /^[A-Za-z0-9._-]{3,200}$/.test(normalized) ? normalized : null;
}

function getSubscriptionCatalog(environment = process.env) {
  return Object.values(PLAN_DEFINITIONS).map((plan) => ({
    code: plan.code,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    billingPeriod: plan.billingPeriod,
    seatLimit: plan.seatLimit,
    trialDays: plan.trialDays,
    provider: "APPLE_APP_STORE",
    providerProductId: configuredProductId(environment[plan.productEnvironmentKey]),
    providerConfigured: Boolean(configuredProductId(environment[plan.productEnvironmentKey])),
  }));
}

function planForCode(code, environment = process.env) {
  return getSubscriptionCatalog(environment).find((plan) => plan.code === code) || null;
}

function planForProductId(productId, environment = process.env) {
  const normalized = configuredProductId(productId);
  return normalized
    ? getSubscriptionCatalog(environment).find((plan) => plan.providerProductId === normalized) || null
    : null;
}

module.exports = {
  PLAN_DEFINITIONS,
  getSubscriptionCatalog,
  planForCode,
  planForProductId,
};
