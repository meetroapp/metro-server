"use strict";

const PLAN_DEFINITIONS = Object.freeze({
  COMMUNITY_2_USER_MONTHLY: Object.freeze({
    code: "COMMUNITY_2_USER_MONTHLY",
    name: "Starter",
    positioning: "For small businesses",
    amountMinor: 3499,
    currency: "USD",
    billingPeriod: "MONTH",
    seatLimit: 2,
    productEnvironmentKey: "APPLE_COMMUNITY_2_USER_MONTHLY_PRODUCT_ID",
    stripePriceEnvironmentKey: "STRIPE_COMMUNITY_2_USER_MONTHLY_PRICE_ID",
  }),
  COMMUNITY_5_USER_MONTHLY: Object.freeze({
    code: "COMMUNITY_5_USER_MONTHLY",
    name: "Growth",
    positioning: "For growing teams",
    amountMinor: 6999,
    currency: "USD",
    billingPeriod: "MONTH",
    seatLimit: 5,
    productEnvironmentKey: "APPLE_COMMUNITY_5_USER_MONTHLY_PRODUCT_ID",
    stripePriceEnvironmentKey: "STRIPE_COMMUNITY_5_USER_MONTHLY_PRICE_ID",
  }),
  COMMUNITY_10_USER_MONTHLY: Object.freeze({
    code: "COMMUNITY_10_USER_MONTHLY",
    name: "Professional",
    positioning: "For established teams",
    amountMinor: 12999,
    currency: "USD",
    billingPeriod: "MONTH",
    seatLimit: 10,
    productEnvironmentKey: "APPLE_COMMUNITY_10_USER_MONTHLY_PRODUCT_ID",
    stripePriceEnvironmentKey: "STRIPE_COMMUNITY_10_USER_MONTHLY_PRICE_ID",
  }),
});

function configuredProductId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && /^[A-Za-z0-9._-]{3,200}$/.test(normalized) ? normalized : null;
}

function getSubscriptionCatalog(environment = process.env) {
  return Object.values(PLAN_DEFINITIONS).map((plan) => {
    const appleProductId = configuredProductId(environment[plan.productEnvironmentKey]);
    const stripePriceId = configuredProductId(environment[plan.stripePriceEnvironmentKey]);
    return ({
    code: plan.code,
    name: plan.name,
    positioning: plan.positioning,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    billingPeriod: plan.billingPeriod,
    seatLimit: plan.seatLimit,
    provider: "APPLE_APP_STORE",
    providerProductId: appleProductId,
    providerConfigured: Boolean(appleProductId),
    providers: {
      APPLE_APP_STORE: { configured: Boolean(appleProductId), productId: appleProductId },
      STRIPE: { configured: Boolean(stripePriceId), priceId: stripePriceId },
    },
  });
  });
}

function planForStripePriceId(priceId, environment = process.env) {
  const normalized = configuredProductId(priceId);
  return normalized
    ? getSubscriptionCatalog(environment).find((plan) => plan.providers.STRIPE.priceId === normalized) || null
    : null;
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
  planForStripePriceId,
};
