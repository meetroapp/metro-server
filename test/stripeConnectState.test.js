"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { account } = require("./stripeConnectPersistence.test");
const { normalizeAccount,eligible,fresh,projectState,FRESH_MS } = require("../server/integrations/stripeConnectState");
const { API_VERSION } = require("../server/integrations/stripeConnectProvider");
const expected = { accountId: "acct_fixture",environment: "TEST",country: "us",currency: "usd",apiVersion: API_VERSION };
const now = new Date("2026-10-06T20:00:00Z");
const scope = { businessId: 10,environment: "TEST",providerScopeId: "fixture" };
const connection = { contractor_profile_id: 10,provider: "STRIPE_PAYMENTS",provider_environment: "TEST",provider_account_id: "acct_fixture" };
function row(facts) { return { ...facts,provider_scope_id: "fixture",verification_status: "VERIFIED",last_retrieved_at: now,
  stale_after: new Date(now.getTime()+FRESH_MS),invalidated_at: null }; }
test("eligibility has no clock dependency; freshness expires exactly at 15 minutes",() => {
  const facts = normalizeAccount(account(),expected).facts;
  assert.equal(eligible(facts),true);
  const ready = row(facts);
  assert.equal(fresh(ready,new Date(now.getTime()+FRESH_MS-1)),true);
  assert.equal(fresh(ready,new Date(now.getTime()+FRESH_MS)),false);
  assert.equal(fresh(ready,new Date(now.getTime()-1)),false);
  assert.equal(eligible(facts),true);
  assert.equal(projectState({ enabled: true,connection,readiness: ready,scope,now: new Date(now.getTime()+FRESH_MS) }).status,"UNAVAILABLE");
  assert.equal(projectState({ connection,scope,readiness: ready,now }).status,"COMING_SOON");
});
test("card-only, due, blocking, scope, liability configuration and closure cannot report CONNECTED",() => {
  for (const change of [a => a.configuration.merchant.capabilities.stripe_balance.payouts.status="pending",
    a => a.requirements.entries.push({ minimum_deadline: { status: "currently_due" },errors: [] }),
    a => a.requirements.entries.push({ minimum_deadline: { status: "past_due" },errors: [] }),
    a => a.requirements.entries.push({ minimum_deadline: { status: "eventually_due" },errors: [{ code: "verification_failed_other" }] }),
    a => a.defaults.responsibilities.losses_collector="application",a => a.closed=true,a => a.identity.country="gb",
    a => a.configuration.merchant.applied=false,a => a.configuration.merchant.capabilities.card_payments.status_details=[{ code: "restricted_other" }]]) {
    const a = account();change(a); const normalized = normalizeAccount(a,expected);
    assert.equal(normalized.valid,true); assert.equal(eligible(normalized.facts),false);
  }
  const a=account();a.requirements.entries.push({ minimum_deadline: { status: "eventually_due" },errors: [] });
  assert.equal(eligible(normalizeAccount(a,expected).facts),true);
});
test("missing includes, wrong account/mode and Endive truthiness fail closed",() => {
  for (const change of [a => delete a.requirements,a => delete a.future_requirements,a => a.configuration.merchant.applied="2026-10-01T00:00:00Z",
    a => a.configuration.merchant.capabilities.card_payments.status="unknown",a => a.id="acct_wrong",a => a.livemode=true]) {
    const a=account();change(a); assert.equal(normalizeAccount(a,expected).valid,false);
  }
});
test("verified invalidation/fetch failure/deadline blocks freshness without editing eligibility",() => {
  const facts=normalizeAccount(account(),expected).facts;
  for (const extra of [{ invalidated_at: now },{ verification_status: "FAILED" },{ future_requirements_due_at: new Date(now.getTime()-1),last_retrieved_at:new Date(now.getTime()-2) }]) {
    assert.equal(fresh({ ...row(facts),...extra },now),false);assert.equal(eligible(facts),true);
  }
  assert.equal(projectState({ enabled: true,scope }).status,"NOT_CONNECTED");
  assert.equal(projectState({ enabled: true,scope,operation: { operation_status: "AMBIGUOUS" } }).status,"UNAVAILABLE");
  assert.equal(projectState({ enabled: true,scope,connection,readiness: row({ ...facts,payouts_status: "pending" }),now }).status,"NEEDS_ATTENTION");
  assert.equal(projectState({ enabled: true,scope,connection,readiness: row(facts),now }).status,"CONNECTED");
});
test("freshly retrieved past-due state needs attention rather than becoming stale by an already-observed deadline",()=>{
  const a=account();a.requirements.entries.push({minimum_deadline:{status:"past_due"},errors:[]});
  a.requirements.summary={minimum_deadline:{status:"past_due",time:new Date(now.getTime()-60000).toISOString()}};
  const normalized=normalizeAccount(a,expected);assert.equal(normalized.valid,true);assert.equal(normalized.facts.future_requirements_due_at,null);
  const ready=row(normalized.facts);assert.equal(fresh(ready,now),true);assert.equal(eligible(ready),false);
  assert.equal(projectState({enabled:true,scope,connection,readiness:ready,now}).status,"NEEDS_ATTENTION");
});
