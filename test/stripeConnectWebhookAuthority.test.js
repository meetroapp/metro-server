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
function offlineLedger(t){
  const {fixture}=require("./stripeConnectLiveProvider.test");const f=fixture(),rows=new Map(),queries=[];let invalidations=0;
  const ready=require("../server/integrations/stripeConnectStateRepository");t.mock.method(ready,"invalidate",async()=>{invalidations++;});
  const client={release(){},async query(sql,args=[]){
    queries.push(sql);if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
    if(sql.includes("SELECT c.id"))return {rows:args[0]==="TEST"&&args[1]==="acct_fixture"&&args[2]===f.config.providerScopeId?[{id:"connection_fixture"}]:[]};
    if(sql.includes("INSERT INTO business_provider_events")){
      if(rows.has(args[2]))return {rows:[],rowCount:0};
      const row={id:"ledger_"+args[2],provider_event_id:args[2],provider_scope_id:args[0],provider_account_id:args[3],connection_id:args[4],payload_sha256:args[12],processing_status:args[13]};rows.set(args[2],row);return {rows:[row],rowCount:1};
    }
    if(sql.includes("SELECT * FROM business_provider_events"))return {rows:[rows.get(args[2])]};
    if(sql.includes("UPDATE business_provider_events")){const row=[...rows.values()].find(x=>x.id===args[0]);if(args[2])row.processing_status="QUARANTINED";return {rows:[row]};}
    if(sql.includes("UPDATE business_provider_connections"))return {rows:[],rowCount:1};
    throw Error("Unexpected fake-ledger SQL");
  }};
  return {...f,rows,queries,pool:{connect:async()=>client},invalidations:()=>invalidations};
}
test("offline live verified receipts are transactional, duplicate-safe, conflicting replay quarantined, unknown account isolated",async t=>{
  const h=offlineLedger(t),raw=body();const options={pool:h.pool,provider:h.provider,config:h.config,rawBody:raw,signature:"fixture",format:"THIN"};
  const first=await webhook.receive(options);assert.equal(first.processable,true);assert.equal(h.rows.size,1);assert.equal(h.invalidations(),1);
  await webhook.receive(options);assert.equal(h.rows.size,1);assert.equal(h.invalidations(),1);
  assert.equal((await webhook.receive({...options,rawBody:body("v2.core.account[requirements].updated")})).code,"EVENT_QUARANTINED");assert.equal(h.invalidations(),2);
  const unknown=await webhook.receive({...options,rawBody:body("v2.core.account.updated","evt_unknown","acct_unknown")});assert.equal(unknown.code,"EVENT_QUARANTINED");assert.equal(unknown.processable,false);assert.equal(h.rows.get("evt_unknown").connection_id,null);
  assert.equal(h.queries.filter(q=>q==="BEGIN").length,4);assert.equal(h.queries.filter(q=>q==="COMMIT").length,4);
  assert.ok(h.queries.every(q=>!(/canonical_|deposit|invoice|schedule|professional_subscription/.test(q))));
  assert.ok([...h.rows.values()].every(row=>!Object.hasOwn(row,"rawBody")&&!Object.hasOwn(row,"payload")));
});
test("offline live lifecycle rejects mode/context/application mismatch and cannot satisfy financial events",async t=>{
  const h=offlineLedger(t);let raw=JSON.parse(body());
  for(const change of [e=>e.livemode=true,e=>e.context="acct_other",e=>e.related_object.id="cus_fixture"]){const e=structuredClone(raw);change(e);assert.equal((await webhook.receive({pool:h.pool,provider:h.provider,config:h.config,rawBody:Buffer.from(JSON.stringify(e)),signature:"fixture",format:"THIN"})).status,400);}
  for(const type of ["payment_intent.succeeded","invoice.paid","v2.core.account_link.returned"]){const r=await webhook.receive({pool:h.pool,provider:h.provider,config:h.config,rawBody:body(type,"evt_"+type.replaceAll(".","_")),signature:"fixture",format:"THIN"});assert.equal(r.processable,false);}
  const snapshot={id:"evt_snapshot",type:"account.application.deauthorized",account:"acct_fixture",livemode:false,api_version:API_VERSION,data:{object:{id:"ca_other"}}};
  assert.equal((await webhook.receive({pool:h.pool,provider:h.provider,config:h.config,rawBody:Buffer.from(JSON.stringify(snapshot)),signature:"fixture",format:"SNAPSHOT"})).status,400);assert.equal(h.invalidations(),0);
});
test("offline out-of-order notifications refetch canonical state; retries and binding loss fail closed",async t=>{
  const {fixture}=require("./stripeConnectLiveProvider.test");const h=fixture(),eventRepo=require("../server/integrations/stripeConnectEventRepository"),stateRepo=require("../server/integrations/stripeConnectStateRepository");let retried=0,committed=0;
  t.mock.method(eventRepo,"claim",async(_p,s)=>({id:s.eventId,connection_id:"fixture",provider_account_id:"acct_fixture"}));t.mock.method(eventRepo,"retry",async()=>{retried++;});
  t.mock.method(stateRepo,"claim",async()=>({connection_id:"fixture",provider_account_id:"acct_fixture",creation_intent:{country:"us",currency:"usd"}}));t.mock.method(stateRepo,"commit",async()=>{committed++;return true;});t.mock.method(stateRepo,"failed",async()=>true);
  const pool={async query(sql,args){assert.ok(!/deposit|invoice|schedule/.test(sql));assert.equal(args[2],"acct_fixture");return {rows:[{contractor_profile_id:10}]};}};
  for(const eventId of ["evt_new","evt_old"])assert.equal((await webhook.processEvent({pool,provider:h.provider,config:h.config,eventId})).ok,true);
  assert.equal(h.calls.filter(c=>c.method==="retrieve").length,2);assert.equal(committed,2);
  t.mock.method(stateRepo,"claim",async()=>null);assert.equal((await webhook.processEvent({pool,provider:h.provider,config:h.config,eventId:"evt_retry"})).code,"RECONCILIATION_PENDING");assert.equal(retried,1);
  const missing={async query(){return {rows:[]};}};assert.equal((await webhook.processEvent({pool:missing,provider:h.provider,config:h.config,eventId:"evt_missing"})).code,"EVENT_BINDING_UNAVAILABLE");assert.equal(retried,2);
});
test("offline snapshot API mismatch quarantines; matching application deauthorization stays lifecycle-only",async t=>{
  const h=offlineLedger(t);const event={id:"evt_version",type:"account.updated",account:"acct_fixture",livemode:false,api_version:"unsupported",data:{object:{id:"acct_fixture"}}};
  const receive=e=>webhook.receive({pool:h.pool,provider:h.provider,config:h.config,rawBody:Buffer.from(JSON.stringify(e)),signature:"fixture",format:"SNAPSHOT"});
  const mismatch=await receive(event);assert.equal(mismatch.code,"EVENT_QUARANTINED");assert.equal(mismatch.processable,false);assert.equal(h.invalidations(),0);
  const deauth=await receive({...event,id:"evt_deauthorized",type:"account.application.deauthorized",api_version:API_VERSION,data:{object:{id:h.config.applicationId}}});
  assert.equal(deauth.processable,true);assert.equal(h.invalidations(),1);assert.ok(h.queries.some(sql=>sql.includes("connection_status='UNAVAILABLE'")));
  assert.ok(h.queries.every(sql=>!(/canonical_|deposit|invoice|schedule|professional_subscription/.test(sql))));
});
