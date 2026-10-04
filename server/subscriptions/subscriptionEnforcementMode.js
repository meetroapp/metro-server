"use strict";

const SUBSCRIPTION_ENFORCEMENT_MODE_ENV =
  "MEETRO_BUSINESS_SUBSCRIPTION_ENFORCEMENT_MODE";

const SUBSCRIPTION_ENFORCEMENT_MODES = Object.freeze({
  NON_BLOCKING_ACCEPTANCE: "NON_BLOCKING_ACCEPTANCE",
  ENFORCED: "ENFORCED",
});

function resolveSubscriptionEnforcementMode(environment = process.env) {
  const configured = String(
    environment?.[SUBSCRIPTION_ENFORCEMENT_MODE_ENV] || ""
  ).trim();
  return configured === SUBSCRIPTION_ENFORCEMENT_MODES.NON_BLOCKING_ACCEPTANCE
    ? SUBSCRIPTION_ENFORCEMENT_MODES.NON_BLOCKING_ACCEPTANCE
    : SUBSCRIPTION_ENFORCEMENT_MODES.ENFORCED;
}

function isNonBlockingAcceptance(environment = process.env) {
  return resolveSubscriptionEnforcementMode(environment) ===
    SUBSCRIPTION_ENFORCEMENT_MODES.NON_BLOCKING_ACCEPTANCE;
}

module.exports = {
  SUBSCRIPTION_ENFORCEMENT_MODE_ENV,
  SUBSCRIPTION_ENFORCEMENT_MODES,
  isNonBlockingAcceptance,
  resolveSubscriptionEnforcementMode,
};
