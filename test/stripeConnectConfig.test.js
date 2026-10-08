"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { KEYS, readConnectConfig, connectSecrets } = require("../server/integrations/stripeConnectConfig");
function fixtureEnv() {
  return {
    STRIPE_CONNECT_ENABLED: "true",
    STRIPE_CONNECT_SECRET_KEY: ["sk", "test", randomBytes(24).toString("hex")].join("_"),
    STRIPE_CONNECT_THIN_WEBHOOK_SECRET: ["whsec", randomBytes(24).toString("hex")].join("_"),
    STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET: ["whsec", randomBytes(24).toString("hex")].join("_"),
    STRIPE_CONNECT_PROVIDER_SCOPE_ID: "platform_fixture/sandbox_fixture", STRIPE_CONNECT_APPLICATION_ID: "ca_fixture",
    STRIPE_CONNECT_ENVIRONMENT: "TEST", STRIPE_CONNECT_RETURN_URL: "https://example.invalid/return",
    STRIPE_CONNECT_REFRESH_URL: "https://example.invalid/refresh", STRIPE_CONNECT_COUNTRY_CURRENCIES: '{"us":"usd","gb":"gbp","ca":"cad"}',
  };
}
module.exports = { fixtureEnv };
if (require.main === module) {
  test("disabled Connect never reads credentials or subscription fallbacks", () => {
    const env = new Proxy({}, { get: (_, name) => { assert.equal(name,"STRIPE_CONNECT_ENABLED"); return undefined; } });
    assert.deepEqual(readConnectConfig(env), { enabled: false });
    assert.deepEqual(readConnectConfig({ STRIPE_CONNECT_ENABLED: "false" }), { enabled: false });
    assert.throws(() => connectSecrets({ enabled: true }),/CONFIGURATION_INVALID/);
  });
  test("complete enabled config is frozen and cannot serialize its secret values", () => {
    const env = fixtureEnv(), c = readConnectConfig(env);
    assert.equal(c.enabled,true);assert.equal(c.environment,"TEST");assert.equal(c.countryCurrencies.us,"usd");
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.callbacks) && Object.isFrozen(c.countryCurrencies));
    const serialized = JSON.stringify(c);
    for (const key of KEYS.filter(k => k.includes("SECRET"))) assert.ok(!serialized.includes(env[key]));
  });
  for (const key of KEYS.filter(k => k !== "STRIPE_CONNECT_ENABLED")) {
    test(`enabled configuration fails closed without ${key}`, () => {
      const env = fixtureEnv(); delete env[key];
      // Existing subscription variables cannot repair missing Connect authority.
      env.STRIPE_SECRET_KEY = env.STRIPE_CONNECT_SECRET_KEY; env.STRIPE_WEBHOOK_SECRET = env.STRIPE_CONNECT_THIN_WEBHOOK_SECRET;
      assert.throws(() => readConnectConfig(env),/CONFIGURATION_INVALID/);
    });
  }
  test("invalid flag/mode/URL/country/currency and shared signing secrets fail closed", () => {
    const values = [
      ["STRIPE_CONNECT_ENABLED","TRUE"], ["STRIPE_CONNECT_ENVIRONMENT","production"],
      ["STRIPE_CONNECT_ENVIRONMENT","LIVE"], ["STRIPE_CONNECT_RETURN_URL","http://example.invalid/return"],
      ["STRIPE_CONNECT_REFRESH_URL","https://example.invalid/refresh?authority=CONNECTED"],
      ["STRIPE_CONNECT_RETURN_URL","https://user:pass@example.invalid/return"],
      ["STRIPE_CONNECT_COUNTRY_CURRENCIES",'[]'], ["STRIPE_CONNECT_COUNTRY_CURRENCIES",'{}'],
      ["STRIPE_CONNECT_COUNTRY_CURRENCIES",'{"zz":"usd"}'],["STRIPE_CONNECT_COUNTRY_CURRENCIES",'{"us":"zzz"}'],
      ["STRIPE_CONNECT_COUNTRY_CURRENCIES",'{"US":"USD"}'],["STRIPE_CONNECT_APPLICATION_ID","cus_fixture"],
    ];
    for (const [key,value] of values) assert.throws(() => readConnectConfig({ ...fixtureEnv(),[key]:value }),/CONFIGURATION_INVALID/);
    const e=fixtureEnv();e.STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET=e.STRIPE_CONNECT_THIN_WEBHOOK_SECRET;
    assert.throws(() => readConnectConfig(e),/CONFIGURATION_INVALID/);
  });
  test("serialized errors and configuration never contain credential values", () => {
    const e=fixtureEnv();e.STRIPE_CONNECT_COUNTRY_CURRENCIES="invalid";
    try { readConnectConfig(e);assert.fail("must reject"); } catch(error) {
      const serialized=JSON.stringify({name:error.name,message:error.message,stack:error.stack,...error});
      for(const key of KEYS.filter(k=>k.includes("SECRET")))assert.ok(!serialized.includes(e[key]));
    }
  });
}
