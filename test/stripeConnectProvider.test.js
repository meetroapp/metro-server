"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fakeProvider } = require("./stripeConnectPersistence.test");
const { createProvider,API_VERSION,INCLUDE } = require("../server/integrations/stripeConnectProvider");
test("adapter is fake-only and makes no bootstrap/provider call",() => {
  assert.throws(() => createProvider(),/FAKE_PROVIDER_REQUIRED/);
  assert.throws(() => createProvider({ fakeClient: { isFakeProvider: false },providerScopeId: "fixture" }),/FAKE_PROVIDER_REQUIRED/);
  const f=fakeProvider();assert.equal(f.calls.create,0);assert.equal(f.calls.retrieve,0);assert.equal(f.provider.apiVersion,API_VERSION);
});
test("v2 create pins version, merchant-only direct configuration and durable key",async () => {
  const f=fakeProvider();const key=randomUUID();
  f.hooks.create=(params,options) => {
    assert.deepEqual(options,{ apiVersion: API_VERSION,idempotencyKey: key });
    assert.deepEqual(params.include,[...INCLUDE]);assert.equal(params.dashboard,"full");
    assert.equal(params.configuration.customer,undefined);assert.equal(params.configuration.recipient,undefined);
    assert.deepEqual(params.defaults.responsibilities,{ fees_collector: "stripe",losses_collector: "stripe" });
    assert.equal(params.configuration.merchant.capabilities.card_payments.requested,true);
  };
  await f.provider.createAccount({ country: "us",currency: "usd",operationId: randomUUID(),connectionId: randomUUID() },key);
  assert.equal(f.calls.physicalCreations,1);
});
test("callback and account validation precede fake link provider calls",async () => {
  const f=fakeProvider();
  assert.throws(() => f.provider.retrieveAccount("cus_fixture"),/INVALID_ACCOUNT/);
  for (const bad of ["http://example.invalid/return","https://example.invalid/return?token=forbidden"]) {
    assert.throws(() => f.provider.createOnboardingLink("acct_fixture",{ returnUrl: bad,refreshUrl: "https://example.invalid/refresh" },randomUUID()));
  }
  assert.equal(f.calls.link,0);
});
