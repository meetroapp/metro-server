"use strict";
const secrets = new WeakMap();
const KEYS = Object.freeze([
  "STRIPE_CONNECT_ENABLED", "STRIPE_CONNECT_SECRET_KEY", "STRIPE_CONNECT_THIN_WEBHOOK_SECRET",
  "STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET", "STRIPE_CONNECT_PROVIDER_SCOPE_ID", "STRIPE_CONNECT_APPLICATION_ID",
  "STRIPE_CONNECT_ENVIRONMENT", "STRIPE_CONNECT_RETURN_URL", "STRIPE_CONNECT_REFRESH_URL", "STRIPE_CONNECT_COUNTRY_CURRENCIES",
]);
const invalid = () => { throw new Error("STRIPE_CONNECT_CONFIGURATION_INVALID"); };
function callback(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !u.hostname) invalid();
    return u.href;
  } catch { invalid(); }
}
function readConnectConfig(env = {}) {
  const flag = env.STRIPE_CONNECT_ENABLED;
  if (flag == null || flag === "" || flag === "false" || flag === false) {
    const disabled = Object.freeze({ enabled: false }); secrets.set(disabled, null); return disabled;
  }
  if (flag !== "true" && flag !== true) invalid();
  const get = key => {
    const value = env[key];
    if (typeof value !== "string" || !value || value.trim() !== value || /\s/.test(value)) invalid();
    return value;
  };
  const environment = get("STRIPE_CONNECT_ENVIRONMENT");
  if (!["TEST", "LIVE"].includes(environment)) invalid();
  const key = get("STRIPE_CONNECT_SECRET_KEY");
  if (!new RegExp(`^sk_${environment === "LIVE" ? "live" : "test"}_[A-Za-z0-9]{12,}$`).test(key)) invalid();
  const thin = get("STRIPE_CONNECT_THIN_WEBHOOK_SECRET"), snapshot = get("STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET");
  if (![thin, snapshot].every(v => /^whsec_[A-Za-z0-9]{12,}$/.test(v)) || thin === snapshot) invalid();
  const providerScopeId = get("STRIPE_CONNECT_PROVIDER_SCOPE_ID"), applicationId = get("STRIPE_CONNECT_APPLICATION_ID");
  if (!/^[A-Za-z0-9_.:/-]{1,200}$/.test(providerScopeId) || !/^ca_[A-Za-z0-9]{1,97}$/.test(applicationId)) invalid();
  const callbacks = Object.freeze({ returnUrl: callback(get("STRIPE_CONNECT_RETURN_URL")), refreshUrl: callback(get("STRIPE_CONNECT_REFRESH_URL")) });
  let parsed;
  try { parsed = JSON.parse(env.STRIPE_CONNECT_COUNTRY_CURRENCIES); } catch { invalid(); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).length < 1 || Object.keys(parsed).length > 100) invalid();
  const currencies = new Set(Intl.supportedValuesOf("currency"));
  const regions = new Intl.DisplayNames(["en"], { type: "region" });
  for (const [country, currency] of Object.entries(parsed)) {
    if (!/^[a-z]{2}$/.test(country) || regions.of(country.toUpperCase()) === country.toUpperCase() || country === "zz" ||
      typeof currency !== "string" || !/^[a-z]{3}$/.test(currency) || !currencies.has(currency.toUpperCase())) invalid();
  }
  const config = Object.freeze({ enabled: true, environment, providerScopeId, applicationId,
    callbacks, countryCurrencies: Object.freeze({ ...parsed }) });
  // Credentials are closure-owned; serializing configuration or errors cannot expose them.
  secrets.set(config, Object.freeze({ key, thin, snapshot }));
  return config;
}
function isConnectConfig(config) { return secrets.has(config); }
function connectSecrets(config) {
  if (!isConnectConfig(config) || !config.enabled) invalid();
  return secrets.get(config);
}
module.exports = { KEYS, readConnectConfig, isConnectConfig, connectSecrets };
