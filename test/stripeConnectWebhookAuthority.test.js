"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const { harness,bind,fakeProvider }=require("./stripeConnectPersistence.test");
const webhook=require("../server/integrations/stripeConnectWebhookService");
const { API_VERSION }=require("../server/integrations/stripeConnectProvider");
function body(type="v2.core.account.updated",id="evt_fixture",accountId="acct_fixture") {
  return Buffer.from(JSON.stringify({id,type,livemode:false,related_object:{id:accountId,type:"v2.core.account",url:"https://untrusted.invalid/object"}}));
}
async function send(h,raw=body(),extra={}) {return webhook.receive({pool:h.pool,provider:h.provider,config:h.config,rawBody:raw,signature:h.sign(raw),format:"THIN",now:h.now,...extra});}
test("signature tampering, wrong verifier, old timestamp, mode and context fail closed",async t=>{
  const h=await harness(t);if(!h)return;const raw=body();
  assert.equal((await send(h,raw,{signature:h.sign(Buffer.from("different"))})).status,400);
  assert.equal((await send(h,raw,{signature:h.signAt(raw,Math.floor(Date.now()/1000)-301)})).status,400);
  assert.equal((await send(h,raw,{provider:fakeProvider().provider})).status,400);
  for(const change of [e=>e.livemode=true,e=>e.context="acct_untrusted",e=>e.related_object.id="cus_notmerchant"]){const e=JSON.parse(raw);change(e);assert.equal((await send(h,Buffer.from(JSON.stringify(e)))).status,400);}
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM business_provider_events")).rows[0].n,0);
});
test("verified unknown account quarantines and never binds Business",async t=>{
  const h=await harness(t);if(!h)return;assert.equal((await send(h)).status,200);
  const e=(await h.pool.query("SELECT * FROM business_provider_events")).rows[0];assert.equal(e.processing_status,"QUARANTINED");assert.equal(e.connection_id,null);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM business_provider_connections")).rows[0].n,0);assert.equal(h.calls.retrieve,0);
});
test("duplicate event delivery/process effects commit once with durable account binding",async t=>{
  const h=await harness(t);if(!h)return;const b=await bind(h);
  await Promise.all([send(h),send(h)]);
  const events=(await h.pool.query("SELECT * FROM business_provider_events")).rows;assert.equal(events.length,1);assert.equal(events[0].connection_id,b.connection.id);
  const outputs=await Promise.all([webhook.processEvent({...h,eventId:"evt_fixture"}),webhook.processEvent({...h,eventId:"evt_fixture"})]);
  assert.equal(outputs.filter(r=>r.ok).length,1);assert.equal(h.calls.retrieve,1);
  const e=(await h.pool.query("SELECT * FROM business_provider_events")).rows[0];assert.equal(e.processing_status,"PROCESSED");assert.equal(e.event_api_version,null);assert.equal(e.retrieval_api_version,API_VERSION);
  await send(h);assert.equal((await webhook.processEvent({...h,eventId:"evt_fixture"})).ok,false);assert.equal(h.calls.retrieve,1);
});
test("different hash quarantines immutable event without replacing original identity",async t=>{
  const h=await harness(t);if(!h)return;await bind(h);await send(h);
  const before=(await h.pool.query("SELECT payload_sha256 FROM business_provider_events")).rows[0].payload_sha256;
  assert.equal((await send(h,body("v2.core.account[requirements].updated"))).code,"EVENT_QUARANTINED");
  const after=(await h.pool.query("SELECT * FROM business_provider_events")).rows[0];assert.equal(after.payload_sha256,before);assert.equal(after.processing_status,"QUARANTINED");
});
test("financial event and onboarding return cannot satisfy payment or CONNECTED",async t=>{
  const h=await harness(t);if(!h)return;await bind(h);
  for(const type of ["payment_intent.succeeded","v2.core.account_link.returned"]){await send(h,body(type,"evt_"+type.replaceAll(".","_")));}
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM business_provider_events WHERE processing_status='IGNORED'")).rows[0].n,2);
  assert.equal((await h.pool.query("SELECT connection_status FROM business_provider_connections")).rows[0].connection_status,"UNAVAILABLE");assert.equal(h.calls.retrieve,0);
});
test("receipt durability failure returns retryable response, never acknowledgement",async t=>{
  const h=await harness(t);if(!h)return;
  const bad={async connect(){throw new Error("SIMULATED_DATABASE_FAILURE");}};
  assert.equal((await send(h,body(),{pool:bad})).status,503);
});
test("out-of-order events converge by retrieval; failures persist retry then atomic success",async t=>{
  const h=await harness(t);if(!h)return;await bind(h);
  await send(h,body("v2.core.account.updated","evt_new"));await send(h,body("v2.core.account.updated","evt_old"));
  h.hooks.retrieve=()=>{throw new Error("SIMULATED_429");};assert.equal((await webhook.processEvent({...h,eventId:"evt_old"})).ok,false);
  assert.equal((await h.pool.query("SELECT processing_status FROM business_provider_events WHERE provider_event_id='evt_old'")).rows[0].processing_status,"RETRY");
  h.hooks.retrieve=null;const later=new Date(h.now.getTime()+61000);assert.equal((await webhook.processEvent({...h,eventId:"evt_old",now:later})).ok,true);
  assert.equal((await webhook.processEvent({...h,eventId:"evt_new",now:later})).ok,true);
  assert.equal((await h.pool.query("SELECT connection_status FROM business_provider_connections")).rows[0].connection_status,"CONNECTED");
});
test("snapshot requires Event.account/object/application agreement and pinned version",async t=>{
  const h=await harness(t);if(!h)return;await bind(h);
  const raw=Buffer.from(JSON.stringify({id:"evt_snapshot",type:"account.updated",livemode:false,account:"acct_fixture",api_version:API_VERSION,data:{object:{id:"acct_other"}}}));
  assert.equal((await send(h,raw,{format:"SNAPSHOT"})).status,400);
  const e=JSON.parse(raw);e.data.object.id="acct_fixture";e.api_version="unsupported";assert.equal((await send(h,Buffer.from(JSON.stringify(e)),{format:"SNAPSHOT"})).status,200);
  assert.equal((await h.pool.query("SELECT processing_status FROM business_provider_events")).rows[0].processing_status,"QUARANTINED");
});
test("verified closure and deauthorization block immediately and stay terminal",async t=>{
  const h=await harness(t);if(!h)return;await bind(h);
  await send(h,body("v2.core.account.closed","evt_closed"));
  assert.equal((await h.pool.query("SELECT verification_status FROM business_provider_connection_readiness")).rows[0].verification_status,"TERMINAL");
  const raw=Buffer.from(JSON.stringify({id:"evt_deauth",type:"account.application.deauthorized",livemode:false,account:"acct_fixture",api_version:API_VERSION,data:{object:{id:"ca_fixture"}}}));
  assert.equal((await send(h,raw,{format:"SNAPSHOT"})).status,200);
  assert.equal((await h.pool.query("SELECT deauthorized FROM business_provider_connection_readiness")).rows[0].deauthorized,true);
  assert.equal((await webhook.processEvent({...h,eventId:"evt_closed"})).ok,true);
  const ready=(await h.pool.query("SELECT * FROM business_provider_connection_readiness")).rows[0];assert.equal(ready.closed,true);assert.equal(ready.deauthorized,true);
});
test("lost worker lease restarts from durable receipt without trusting event order",async t=>{
  const h=await harness(t);if(!h)return;await bind(h);await send(h);
  const repo=require("../server/integrations/stripeConnectEventRepository");
  const old=await repo.claim(h.pool,{providerScopeId:h.config.providerScopeId,environment:"TEST",eventId:"evt_fixture"},h.now);
  assert.equal(old.processing_status,"PROCESSING");
  assert.equal((await webhook.processEvent({...h,eventId:"evt_fixture",now:new Date(h.now.getTime()+121000)})).ok,true);
  assert.equal((await h.pool.query("SELECT processing_status FROM business_provider_events")).rows[0].processing_status,"PROCESSED");
  assert.equal(await repo.retry(h.pool,old,h.now),null);
});
