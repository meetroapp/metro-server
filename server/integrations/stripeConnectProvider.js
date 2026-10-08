"use strict";
const API_VERSION = "2026-08-26.dahlia";
const INCLUDE = Object.freeze(["configuration.merchant", "defaults", "identity", "requirements", "future_requirements"]);
const ACCOUNT = /^acct_[A-Za-z0-9]{1,240}$/;

// Deterministic offline adapter retained alongside the explicitly configured live provider.
function createProvider({ fakeClient, providerScopeId } = {}) {
  if (fakeClient?.isFakeProvider !== true || typeof providerScopeId !== "string" || !providerScopeId) {
    throw new Error("STRIPE_CONNECT_FAKE_PROVIDER_REQUIRED");
  }
  const options = key => ({ apiVersion: API_VERSION, ...(key ? { idempotencyKey: key } : {}) });
  const checked = id => { if (!ACCOUNT.test(id || "")) throw new Error("STRIPE_CONNECT_INVALID_ACCOUNT"); return id; };
  return Object.freeze({
    isFakeProvider: true, apiVersion: API_VERSION, providerScopeId,
    createAccount(intent, key) {
      return fakeClient.v2.core.accounts.create({
        dashboard: "full", identity: { country: intent.country },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        defaults: { currency: intent.currency, responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
        metadata: { meetro_operation: intent.operationId, meetro_connection: intent.connectionId },
        include: [...INCLUDE],
      }, options(key));
    },
    retrieveAccount(id) { return fakeClient.v2.core.accounts.retrieve(checked(id), { include: [...INCLUDE] }, options()); },
    // Interface only, exercised by fakes. No transient link is persisted here.
    createOnboardingLink(id, { returnUrl, refreshUrl }, key) {
      for (const url of [returnUrl, refreshUrl]) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("STRIPE_CONNECT_INVALID_CALLBACK");
      }
      return fakeClient.v2.core.accountLinks.create({ account: checked(id), use_case: {
        type: "account_onboarding", account_onboarding: { configurations: ["merchant"],
          collection_options: { fields: "eventually_due" }, return_url: returnUrl, refresh_url: refreshUrl },
      } }, options(key));
    },
    verifyEvent(rawBody, signature, format) {
      if (!Buffer.isBuffer(rawBody) || rawBody.length > 262144 || typeof signature !== "string") throw new Error("STRIPE_CONNECT_INVALID_SIGNATURE");
      // Fake client's verifier must enforce the raw-byte signature/timestamp
      // contract. No secret is read or propagated to logs by this module.
      if (format === "THIN") return fakeClient.parseEventNotification(rawBody, signature, { tolerance: 300 });
      if (format === "SNAPSHOT") return fakeClient.webhooks.constructEvent(rawBody, signature, { tolerance: 300 });
      throw new Error("STRIPE_CONNECT_INVALID_FORMAT");
    },
  });
}
function assertProvider(provider, scope, config) {
  const live = require("./stripeConnectLiveProvider").isLiveProvider(provider);
  if (provider?.apiVersion !== API_VERSION || provider.providerScopeId !== scope?.providerScopeId ||
    (!live && provider?.isFakeProvider !== true) || (live && provider.environment !== scope?.environment) ||
    (config?.enabled === true && !live)) throw new Error("STRIPE_CONNECT_PROVIDER_REQUIRED");
}
module.exports = { API_VERSION, INCLUDE, ACCOUNT, createProvider, assertProvider };
