"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const { harness,bind,account }=require("./stripeConnectPersistence.test");
const repo=require("../server/integrations/stripeConnectStateRepository");
const { reconcile,dueConnections }=require("../server/integrations/stripeConnectReconciliationService");
const { eligible,fresh }=require("../server/integrations/stripeConnectState");
test("reconciliation commits readiness/status together and schedules five-minute work",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);
  const result=await reconcile({...h,connectionId:b.connection.id});assert.equal(result.ok,true);
  const ready=await repo.load(h.pool,h.scope,b.connection.id);assert.equal(eligible(ready),true);assert.equal(fresh(ready,h.now),true);
  assert.equal(new Date(ready.next_reconcile_at)-h.now,300000);assert.equal(new Date(ready.stale_after)-h.now,900000);
  assert.equal((await h.pool.query("SELECT connection_status FROM business_provider_connections")).rows[0].connection_status,"CONNECTED");
  assert.equal((await dueConnections(h.pool,h.config,new Date(h.now.getTime()+300000))).length,1);
});
test("outage preserves last good eligibility/time and does not renew freshness",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);await reconcile({...h,connectionId:b.connection.id});
  const first=await repo.load(h.pool,h.scope,b.connection.id);h.hooks.retrieve=()=>{throw new Error("SIMULATED_OUTAGE");};
  const later=new Date(h.now.getTime()+60000);assert.equal((await reconcile({...h,connectionId:b.connection.id,now:later})).ok,false);
  const failed=await repo.load(h.pool,h.scope,b.connection.id);assert.equal(eligible(failed),true);assert.equal(fresh(failed,later),false);
  assert.deepEqual(failed.last_retrieved_at,first.last_retrieved_at);assert.deepEqual(failed.stale_after,first.stale_after);
  assert.equal(failed.verification_status,"FAILED");assert.equal((await h.pool.query("SELECT connection_status FROM business_provider_connections")).rows[0].connection_status,"UNAVAILABLE");
});
test("future deadlines accelerate reconciliation but elapsed deadlines resume normal cadence",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);
  const current=structuredClone(b.account);const deadline=new Date(h.now.getTime()+120000);
  current.future_requirements.summary={minimum_deadline:{status:"eventually_due",time:deadline.toISOString()}};
  h.hooks.retrieve=()=>current;
  assert.equal((await reconcile({...h,connectionId:b.connection.id})).ok,true);
  assert.equal(new Date((await repo.load(h.pool,h.scope,b.connection.id)).next_reconcile_at)-h.now,120000);
  current.future_requirements.summary.minimum_deadline.time=new Date(h.now.getTime()-1000).toISOString();
  assert.equal((await reconcile({...h,connectionId:b.connection.id})).ok,true);
  const ready=await repo.load(h.pool,h.scope,b.connection.id);
  assert.equal(new Date(ready.next_reconcile_at)-h.now,300000);
  assert.equal((await dueConnections(h.pool,h.config,h.now)).length,0);
});
test("event invalidation during fetch fences stale commit and permits later convergence",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);
  h.hooks.retrieve=async()=>{await repo.invalidate(h.pool,b.connection.id,h.scope.providerScopeId,null,h.now);return b.account;};
  assert.equal((await reconcile({...h,connectionId:b.connection.id})).code,"RECONCILIATION_CONFLICT");
  assert.equal((await repo.load(h.pool,h.scope,b.connection.id)).verification_status,"UNVERIFIED");
  h.hooks.retrieve=null;assert.equal((await reconcile({...h,connectionId:b.connection.id,now:new Date(h.now.getTime()+121000)})).ok,true);
});
test("late healthy retrieval cannot clear verified closure tombstone",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);
  await repo.invalidate(h.pool,b.connection.id,h.scope.providerScopeId,"CLOSED",h.now);
  assert.equal((await reconcile({...h,connectionId:b.connection.id})).ok,true);
  const ready=await repo.load(h.pool,h.scope,b.connection.id);assert.equal(ready.verification_status,"TERMINAL");assert.equal(ready.closed,true);assert.equal(eligible(ready),false);
  await assert.rejects(h.pool.query("UPDATE business_provider_connection_readiness SET verification_status='VERIFIED',closed=FALSE"));
});
test("wrong-account retrieval fails closed without advancing history",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);
  h.hooks.retrieve=()=>account({id:"acct_wrong"});assert.equal((await reconcile({...h,connectionId:b.connection.id})).code,"ACCOUNT_SCOPE_MISMATCH");
  assert.equal((await repo.load(h.pool,h.scope,b.connection.id)).last_retrieved_at,null);
});
test("cross-Business commit/failure cannot mutate another readiness record",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);const lease=await repo.claim(h.pool,h.scope,b.connection.id,h.now);
  assert.equal(await repo.failed(h.pool,{...h.scope,businessId:20},lease,{now:h.now}),false);
  assert.equal((await repo.load(h.pool,h.scope,b.connection.id)).verification_status,"UNVERIFIED");
  const {normalizeAccount}=require("../server/integrations/stripeConnectState");
  const {API_VERSION}=require("../server/integrations/stripeConnectProvider");
  const facts=normalizeAccount(b.account,{accountId:b.account.id,environment:"TEST",country:"us",currency:"usd",apiVersion:API_VERSION}).facts;
  assert.equal(await repo.commit(h.pool,{...h.scope,businessId:20},lease,facts,{now:h.now}),false);
  assert.equal(await repo.commit(h.pool,h.scope,lease,facts,{now:new Date(h.now.getTime()+120000)}),false);
});
test("Owner refresh coalesces and Manager cannot force provider reconciliation",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);await reconcile({...h,connectionId:b.connection.id});
  const {refresh}=require("../server/integrations/stripeConnectOnboardingService");
  const calls=h.calls.retrieve;
  assert.equal((await refresh({...h,authenticatedActor:{id:2}})).status,403);
  assert.equal((await refresh({...h,authenticatedActor:{id:1}})).status,202);assert.equal(h.calls.retrieve,calls);
  assert.equal((await refresh({...h,authenticatedActor:{id:1},now:new Date(h.now.getTime()+31000)})).status,200);assert.equal(h.calls.retrieve,calls+1);
});
test("bounded provider retry guidance and jitter are persisted without raw error data",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);
  h.hooks.retrieve=()=>{throw Object.assign(new Error("SIMULATED_429"),{retryAfterMs:300000});};
  await reconcile({...h,connectionId:b.connection.id,jitterMs:12000});
  const ready=await repo.load(h.pool,h.scope,b.connection.id);assert.equal(new Date(ready.next_reconcile_at)-h.now,312000);assert.equal(ready.last_error_code,"PROVIDER_UNAVAILABLE");
});
test("offline live reconciliation pins canonical Business/account and forwards only normalized lifecycle facts",async t=>{
  const {fixture}=require("./stripeConnectLiveProvider.test");const f=fixture(),scope={businessId:10,environment:"TEST",providerScopeId:f.config.providerScopeId};
  const lease={connection_id:"fixture",provider_account_id:"acct_fixture",creation_intent:{country:"us",currency:"usd"}};let committed=null,failed=null;
  t.mock.method(repo,"claim",async(_pool,s)=>{assert.deepEqual(s,scope);return lease;});t.mock.method(repo,"commit",async(_p,s,l,facts)=>{assert.deepEqual(s,scope);committed=facts;return facts;});t.mock.method(repo,"failed",async(_p,_s,_l,details)=>{failed=details;});
  assert.equal((await reconcile({pool:{},provider:f.provider,scope,connectionId:"fixture"})).ok,true);assert.equal(eligible(committed),true);assert.equal(f.calls[0].id,"acct_fixture");
  f.client.v2.core.accounts.retrieve=async()=>({...account(),livemode:true});assert.equal((await reconcile({pool:{},provider:f.provider,scope,connectionId:"fixture"})).ok,false);assert.equal(failed.code,"PROVIDER_UNAVAILABLE");
  assert.equal(Object.keys(committed).some(k=>/deposit|invoice|schedule|payment_satisfied/.test(k)),false);
});
