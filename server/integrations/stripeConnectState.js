"use strict";
const { API_VERSION, ACCOUNT } = require("./stripeConnectProvider");
const FRESH_MS = 15 * 60 * 1000;
const RECONCILE_MS = 5 * 60 * 1000;
const STATUSES = ["active", "pending", "restricted", "unsupported"];
const DUE = ["currently_due", "past_due", "eventually_due"];
const time = value => value == null ? NaN : new Date(value).getTime();

function normalizeAccount(account, expected) {
  const bad = code => ({ valid: false, code });
  if (!account || account.object !== "v2.core.account" || !ACCOUNT.test(account.id || "") ||
      account.id !== expected.accountId || account.livemode !== (expected.environment === "LIVE")) return bad("ACCOUNT_SCOPE_MISMATCH");
  const merchant = account.configuration?.merchant;
  const capabilities = merchant?.capabilities;
  const card = capabilities?.card_payments;
  const payouts = capabilities?.stripe_balance?.payouts;
  if (expected.apiVersion !== API_VERSION || typeof merchant?.applied !== "boolean" ||
      !Array.isArray(account.applied_configurations) || typeof account.closed !== "boolean" ||
      !STATUSES.includes(card?.status) || !STATUSES.includes(payouts?.status) ||
      !Array.isArray(account.requirements?.entries) || !Array.isArray(account.future_requirements?.entries) ||
      !account.defaults?.responsibilities || typeof account.identity?.country !== "string" ||
      typeof account.defaults.currency !== "string") return bad("ACCOUNT_SHAPE_UNSUPPORTED");
  let current = 0, past = 0, errors = 0;
  for (const entry of [...account.requirements.entries, ...account.future_requirements.entries]) {
    if (!DUE.includes(entry.minimum_deadline?.status) || !Array.isArray(entry.errors)) return bad("ACCOUNT_SHAPE_UNSUPPORTED");
    if (entry.minimum_deadline.status === "currently_due") current++;
    if (entry.minimum_deadline.status === "past_due") past++;
    errors += entry.errors.length;
  }
  const deadlines = [];
  for (const collection of [account.requirements,account.future_requirements]) {
    const summary = collection.summary?.minimum_deadline;
    if (summary && (!DUE.includes(summary.status) || (summary.time != null && !Number.isFinite(time(summary.time))))) return bad("ACCOUNT_SHAPE_UNSUPPORTED");
    if (summary?.time && summary.status !== "past_due") deadlines.push(time(summary.time));
  }
  for (const capability of [card,payouts]) {
    if (capability.status_details != null && !Array.isArray(capability.status_details)) return bad("ACCOUNT_SHAPE_UNSUPPORTED");
    errors += capability.status_details?.length || 0;
  }
  const deadline = deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
  const responsibilities = account.defaults.responsibilities;
  return { valid: true, facts: {
    merchant_applied: merchant.applied && account.applied_configurations.includes("merchant"),
    card_payments_status: card.status, payouts_status: payouts.status,
    requirements_currently_due_count: current, requirements_past_due_count: past,
    blocking_error_count: errors, future_requirements_due_at: deadline,
    responsibilities_match: account.dashboard === "full" && responsibilities.fees_collector === "stripe" &&
      responsibilities.losses_collector === "stripe" && responsibilities.requirements_collector === "stripe",
    scope_match: account.identity.country === expected.country && account.defaults.currency === expected.currency,
    closed: account.closed, deauthorized: false,
  } };
}

// Eligibility deliberately has no clock, cache or Account Link dependency.
function eligible(facts) {
  return Boolean(facts && facts.scope_match === true && facts.responsibilities_match === true &&
    facts.merchant_applied === true && facts.card_payments_status === "active" && facts.payouts_status === "active" &&
    facts.requirements_currently_due_count === 0 && facts.requirements_past_due_count === 0 &&
    facts.blocking_error_count === 0 && facts.closed === false && facts.deauthorized === false);
}
function fresh(readiness, now = new Date()) {
  const age = time(now) - time(readiness?.last_retrieved_at);
  const deadline = time(readiness?.future_requirements_due_at);
  return Boolean(readiness?.verification_status === "VERIFIED" && readiness.invalidated_at == null &&
    Number.isFinite(age) && age >= 0 && age < FRESH_MS && time(now) < time(readiness.stale_after) &&
    (!Number.isFinite(deadline) || time(now) < deadline || time(readiness.last_retrieved_at) >= deadline));
}
function projectState({ enabled = false, connection, operation, readiness, scope, now } = {}) {
  if (!enabled) return { status: "COMING_SOON", reason: "ROLLOUT_DISABLED" };
  if (!scope || (connection && (connection.provider !== "STRIPE_PAYMENTS" ||
    connection.provider_environment !== scope.environment || (scope.businessId && connection.contractor_profile_id !== scope.businessId))) ||
    (readiness && readiness.provider_scope_id !== scope.providerScopeId)) return { status: "UNAVAILABLE", reason: "SCOPE_MISMATCH" };
  if (["AMBIGUOUS", "RECOVERY_REQUIRED", "REJECTED_NO_ACCOUNT"].includes(operation?.operation_status)) return { status: "UNAVAILABLE", reason: "CREATION_RECOVERY_REQUIRED" };
  if (!connection?.provider_account_id) return { status: "NOT_CONNECTED", reason: operation ? "SETUP_IN_PROGRESS" : "ACCOUNT_ABSENT" };
  if (readiness?.closed || readiness?.deauthorized || readiness?.verification_status === "TERMINAL") return { status: "UNAVAILABLE", reason: "ACCOUNT_TERMINAL" };
  if ([readiness?.card_payments_status, readiness?.payouts_status].includes("unsupported")) return { status: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED" };
  if (readiness && (readiness.scope_match === false || readiness.responsibilities_match === false)) return { status: "UNAVAILABLE", reason: "CONFIGURATION_MISMATCH" };
  if (!fresh(readiness, now)) return { status: "UNAVAILABLE", reason: readiness?.verification_status === "FAILED" ? "PROVIDER_UNAVAILABLE" : "STATE_UNVERIFIED_OR_STALE" };
  if (eligible(readiness)) return { status: "CONNECTED", reason: "ACCOUNT_ELIGIBLE" };
  const reason = !readiness.merchant_applied ? "ONBOARDING_REQUIRED" :
    readiness.requirements_currently_due_count + readiness.requirements_past_due_count + readiness.blocking_error_count > 0 ? "REQUIREMENTS_DUE" :
      [readiness.card_payments_status,readiness.payouts_status].includes("pending") ? "VERIFICATION_PENDING" : "PROVIDER_REVIEW_REQUIRED";
  return { status: "NEEDS_ATTENTION",reason };
}
module.exports = { normalizeAccount, eligible, fresh, projectState, FRESH_MS, RECONCILE_MS };
