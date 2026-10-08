"use strict";
const { randomUUID } = require("node:crypto");
const { API_VERSION, ACCOUNT, createProvider } = require("./stripeConnectProvider");
const { connectSecrets } = require("./stripeConnectConfig");
const authorized = new WeakSet();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isLiveProvider(provider) { return authorized.has(provider); }
function createLiveProvider({ config, stripeClient, Stripe } = {}) {
  const credentials = connectSecrets(config);
  if (!stripeClient) {
    const Constructor = Stripe || require("stripe");
    if (Constructor.PACKAGE_VERSION !== "22.6.0" || Constructor.API_VERSION !== API_VERSION) throw new Error("STRIPE_CONNECT_SDK_CONTRACT_INVALID");
    try { stripeClient = new Constructor(credentials.key, { apiVersion: API_VERSION, maxNetworkRetries: 0 }); }
    catch { throw new Error("STRIPE_CONNECT_PROVIDER_UNAVAILABLE"); }
  }
  if (![stripeClient?.v2?.core?.accounts?.create, stripeClient?.v2?.core?.accounts?.retrieve,
    stripeClient?.v2?.core?.accountLinks?.create, stripeClient?.parseEventNotification,
    stripeClient?.webhooks?.constructEvent].every(f => typeof f === "function")) throw new Error("STRIPE_CONNECT_SDK_CONTRACT_INVALID");
  // Reuse the frozen request builder, not its fake verification contract.
  const adapter = createProvider({ providerScopeId: config.providerScopeId, fakeClient: {
    isFakeProvider: true, v2: stripeClient.v2,
  } });
  const unavailable = () => new Error("STRIPE_CONNECT_PROVIDER_UNAVAILABLE");
  async function guarded(work) { try { return await work(); } catch { throw unavailable(); } }
  function account(value, id) {
    if (value?.object !== "v2.core.account" || !ACCOUNT.test(value.id || "") || (id && value.id !== id) ||
      value.livemode !== (config.environment === "LIVE")) throw unavailable();
    return value;
  }
  const provider = Object.freeze({
    isFakeProvider: false, apiVersion: API_VERSION, providerScopeId: config.providerScopeId, environment: config.environment,
    createAccount(intent, key) {
      return guarded(async () => {
        if (!intent || config.countryCurrencies[intent.country] !== intent.currency || typeof key !== "string" ||
          !UUID.test(key) || !UUID.test(intent.operationId || "") || !UUID.test(intent.connectionId || "")) throw unavailable();
        const result = account(await adapter.createAccount(intent, key));
        if (result.metadata?.meetro_operation !== intent.operationId || result.metadata?.meetro_connection !== intent.connectionId) throw unavailable();
        return result;
      });
    },
    retrieveAccount(id) { return guarded(async () => account(await adapter.retrieveAccount(id), id)); },
    createOnboardingLink(id, callbacks, key = randomUUID()) {
      return guarded(async () => {
        if (!UUID.test(key) || callbacks?.returnUrl !== config.callbacks.returnUrl || callbacks?.refreshUrl !== config.callbacks.refreshUrl) throw unavailable();
        const link = await adapter.createOnboardingLink(id, config.callbacks, key);
        const u = new URL(link?.url);
        if (link?.object !== "v2.core.account_link" || link.account !== id || link.livemode !== (config.environment === "LIVE") ||
          u.protocol !== "https:" || u.hostname !== "connect.stripe.com" || u.username || u.password || u.hash ||
          !Number.isFinite(Date.parse(link.expires_at)) || Date.parse(link.expires_at) <= Date.now()) throw unavailable();
        return { url: link.url, expires_at: link.expires_at };
      });
    },
    verifyEvent(rawBody, signature, format) {
      return guarded(() => {
        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 262144 ||
          typeof signature !== "string" || !signature || signature.length > 8192) throw unavailable();
        if (format === "THIN") return stripeClient.parseEventNotification(rawBody, signature, credentials.thin, 300);
        if (format === "SNAPSHOT") return stripeClient.webhooks.constructEvent(rawBody, signature, credentials.snapshot, 300);
        throw unavailable();
      });
    },
  });
  authorized.add(provider); return provider;
}
module.exports = { createLiveProvider, isLiveProvider };
