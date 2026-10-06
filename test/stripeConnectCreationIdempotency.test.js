"use strict";
const test=require("node:test");const assert=require("node:assert/strict");const { randomUUID }=require("node:crypto");
const { harness,bind }=require("./stripeConnectPersistence.test");
const ops=require("../server/integrations/stripeConnectOperationRepository");
const { onboard }=require("../server/integrations/stripeConnectOnboardingService");
test("racing Owners reserve one intent/key and one provider creation",async t => {
  const h=await harness(t);if(!h)return;
  const results=await Promise.all([1,3].map(actorUserId => ops.reserve(h.pool,h.scope,{ country:"us",currency:"usd",actorUserId })));
  assert.equal(results[0].operation.id,results[1].operation.id);
  assert.equal(results[0].operation.stripe_idempotency_key,results[1].operation.stripe_idempotency_key);
  const leases=await Promise.all(results.map(r=>ops.claim(h.pool,h.scope,r.operation.id,h.now)));
  assert.equal(leases.filter(Boolean).length,1);
  const lease=leases.find(Boolean);const account=await h.provider.createAccount(lease.creation_intent,lease.stripe_idempotency_key);
  await ops.complete(h.pool,h.scope,lease,account,h.now);assert.equal(h.calls.physicalCreations,1);
});
test("timeout after provider creation and crash before binding replay identical frozen key",async t => {
  const h=await harness(t);if(!h)return;
  const reserved=await ops.reserve(h.pool,h.scope,{ country:"us",currency:"usd",actorUserId:1 });
  const first=await ops.claim(h.pool,h.scope,reserved.operation.id,h.now);
  h.hooks.create=()=>{throw new Error("SIMULATED_TIMEOUT");};
  await assert.rejects(h.provider.createAccount(first.creation_intent,first.stripe_idempotency_key));
  await ops.uncertain(h.pool,h.scope,first,false,h.now);h.hooks.create=null;
  const later=new Date(h.now.getTime()+61000);const second=await ops.claim(h.pool,h.scope,first.id,later);
  assert.equal(second.stripe_idempotency_key,first.stripe_idempotency_key);assert.deepEqual(second.creation_intent,first.creation_intent);
  const account=await h.provider.createAccount(second.creation_intent,second.stripe_idempotency_key);
  // Another process dies after this success; lease expires, original key survives.
  const recoveryTime=new Date(later.getTime()+121000);const third=await ops.claim(h.pool,h.scope,first.id,recoveryTime);
  const recovered=await h.provider.createAccount(third.creation_intent,third.stripe_idempotency_key);
  assert.equal(recovered.id,account.id);assert.equal(h.calls.physicalCreations,1);
  await assert.rejects(ops.complete(h.pool,h.scope,second,account,recoveryTime),/LEASE_CONFLICT/);
  await ops.complete(h.pool,h.scope,third,recovered,recoveryTime);
});
test("29-day recovery cutoff refuses new automatic key or account",async t => {
  const h=await harness(t);if(!h)return;
  const r=await ops.reserve(h.pool,h.scope,{ country:"us",currency:"usd",actorUserId:1 });
  const old=new Date(h.now.getTime()-30*86400000);const first=await ops.claim(h.pool,h.scope,r.operation.id,old);
  await ops.uncertain(h.pool,h.scope,first,false,old);
  assert.equal(await ops.claim(h.pool,h.scope,first.id,h.now),null);
  const again=await ops.reserve(h.pool,h.scope,{ country:"us",currency:"usd",actorUserId:3 });
  assert.equal(again.operation.operation_status,"RECOVERY_REQUIRED");assert.equal(again.operation.stripe_idempotency_key,first.stripe_idempotency_key);
  assert.equal(h.calls.physicalCreations,0);
});
test("correlation conflict cannot bind a second account",async t => {
  const h=await harness(t);if(!h)return;const b=await bind(h);
  await assert.rejects(ops.complete(h.pool,h.scope,b.lease,{...b.account,id:"acct_other"},h.now),/ACCOUNT_CONFLICT/);
  await assert.rejects(ops.complete(h.pool,h.scope,b.lease,{...b.account,metadata:{}},h.now),/CORRELATION_MISMATCH/);
  await assert.rejects(ops.reserve(h.pool,h.scope,{country:"gb",currency:"gbp",actorUserId:1}),/INTENT_CONFLICT/);
});
test("onboarding denies Manager/ambiguous/body-spoof before any provider call",async t => {
  const h=await harness(t);if(!h)return;
  const input={pool:h.pool,provider:h.provider,config:h.config,command:{intent:"CONNECT",country:"us"},idempotencyKey:randomUUID(),now:h.now};
  assert.equal((await onboard({...input,authenticatedActor:{id:2}})).status,403);
  assert.equal((await onboard({...input,authenticatedActor:{id:1},command:{...input.command,accountId:"acct_override"}})).status,400);
  await h.pool.query("INSERT INTO business_team_memberships(contractor_profile_id,user_id,role,status) VALUES(20,1,'MANAGER','ACTIVE')");
  assert.equal((await onboard({...input,authenticatedActor:{id:1}})).status,409);assert.equal(h.calls.create,0);
});
test("Continue never creates; ready Connect returns no onboarding credential",async t => {
  const h=await harness(t);if(!h)return;
  const base={pool:h.pool,provider:h.provider,config:h.config,authenticatedActor:{id:1},idempotencyKey:randomUUID(),now:h.now};
  assert.equal((await onboard({...base,command:{intent:"CONTINUE"}})).status,409);assert.equal(h.calls.create,0);
  const result=await onboard({...base,command:{intent:"CONNECT",country:"us"}});
  assert.equal(result.code,"ALREADY_CONNECTED");assert.equal(result.onboardingUrl,undefined);assert.equal(h.calls.create,1);assert.equal(h.calls.link,0);
  assert.equal((await onboard({...base,command:{intent:"CONTINUE"}})).code,"ALREADY_CONNECTED");assert.equal(h.calls.create,1);
});
test("timeout before provider creation still replays frozen intent without key rotation",async t=>{
  const h=await harness(t);if(!h)return;
  const original=h.client.v2.core.accounts.create;h.client.v2.core.accounts.create=async()=>{throw new Error("SIMULATED_PRE_DISPATCH_TIMEOUT");};
  const base={pool:h.pool,provider:h.provider,config:h.config,authenticatedActor:{id:1},command:{intent:"CONNECT",country:"us"},idempotencyKey:randomUUID(),now:h.now};
  assert.equal((await onboard(base)).status,503);assert.equal(h.calls.physicalCreations,0);
  const before=(await h.pool.query("SELECT * FROM business_provider_connection_operations")).rows[0];
  h.client.v2.core.accounts.create=original;assert.equal((await onboard({...base,idempotencyKey:randomUUID(),now:new Date(h.now.getTime()+61000)})).ok,true);
  const after=(await h.pool.query("SELECT * FROM business_provider_connection_operations")).rows[0];
  assert.equal(after.stripe_idempotency_key,before.stripe_idempotency_key);assert.equal(h.calls.physicalCreations,1);
});
test("Owner revoked after reservation cannot dispatch; Bookkeeper and Field remain denied",async t=>{
  const h=await harness(t);if(!h)return;
  const base={pool:h.pool,provider:h.provider,config:h.config,command:{intent:"CONNECT",country:"us"},idempotencyKey:randomUUID(),now:h.now};
  assert.equal((await onboard({...base,authenticatedActor:{id:4}})).status,403);
  await h.pool.query("UPDATE business_team_memberships SET role='BOOKKEEPER_FINANCE' WHERE user_id=4");
  assert.equal((await onboard({...base,authenticatedActor:{id:4}})).status,403);
  let authorityReads=0;const pool={connect:()=>h.pool.connect(),async query(sql,args){
    if(sql.includes("FROM business_team_memberships")&&++authorityReads===2)await h.pool.query("UPDATE business_team_memberships SET status='DEACTIVATED' WHERE user_id=1");
    return h.pool.query(sql,args);
  }};
  assert.equal((await onboard({...base,pool,authenticatedActor:{id:1}})).status,403);assert.equal(h.calls.create,0);
});
test("pending onboarding link is transient and Continue reuses exactly one account",async t=>{
  const h=await harness(t);if(!h)return;
  h.hooks.create=(_params,_options,result)=>{result.configuration.merchant.capabilities.card_payments.status="pending";
    result.requirements.entries=[{minimum_deadline:{status:"currently_due"},errors:[]}];h.hooks.account=result;};
  const base={pool:h.pool,provider:h.provider,config:h.config,authenticatedActor:{id:1},idempotencyKey:randomUUID(),now:h.now};
  const first=await onboard({...base,command:{intent:"CONNECT",country:"us"}});assert.equal(first.code,"ONBOARDING_READY");assert.equal(first.state,"NEEDS_ATTENTION");
  const second=await onboard({...base,command:{intent:"CONTINUE"}});assert.equal(second.code,"ONBOARDING_READY");assert.equal(h.calls.create,1);assert.equal(h.calls.link,2);
  const rows=(await h.pool.query("SELECT creation_intent FROM business_provider_connection_operations")).rows;
  assert.equal(JSON.stringify(rows).includes("example.invalid"),false);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM business_provider_connection_operations")).rows[0].n,1);
});
test("expired lease and foreign Business cannot complete or fail another creation",async t=>{
  const h=await harness(t);if(!h)return;
  const r=await ops.reserve(h.pool,h.scope,{country:"us",currency:"usd",actorUserId:1});
  const lease=await ops.claim(h.pool,h.scope,r.operation.id,new Date(h.now.getTime()-180000));
  const a=await h.provider.createAccount(lease.creation_intent,lease.stripe_idempotency_key);
  await assert.rejects(ops.complete(h.pool,h.scope,lease,a,h.now),/LEASE_CONFLICT/);
  assert.equal(await ops.uncertain(h.pool,{...h.scope,businessId:20},lease,false,h.now),null);
  const current=await ops.claim(h.pool,h.scope,r.operation.id,h.now);
  await assert.rejects(ops.complete(h.pool,{...h.scope,businessId:20},current,a,h.now),/OPERATION_CONFLICT/);
  await ops.complete(h.pool,h.scope,current,a,h.now);
});
test("definitive rejection remains a tombstone rather than generating another account",async t=>{
  const h=await harness(t);if(!h)return;
  h.client.v2.core.accounts.create=async()=>{throw Object.assign(new Error("SIMULATED_VALIDATION"),{definitiveNoAccount:true});};
  const base={pool:h.pool,provider:h.provider,config:h.config,authenticatedActor:{id:1},command:{intent:"CONNECT",country:"us"},idempotencyKey:randomUUID(),now:h.now};
  assert.equal((await onboard(base)).status,503);
  const before=(await h.pool.query("SELECT * FROM business_provider_connection_operations")).rows[0];assert.equal(before.operation_status,"REJECTED_NO_ACCOUNT");
  assert.equal((await onboard({...base,now:new Date(h.now.getTime()+61000)})).status,409);assert.equal(h.calls.physicalCreations,0);
  assert.equal((await h.pool.query("SELECT stripe_idempotency_key FROM business_provider_connection_operations")).rows[0].stripe_idempotency_key,before.stripe_idempotency_key);
});
test("verification pending does not emit an unnecessary onboarding link",async t=>{
  const h=await harness(t);if(!h)return;
  h.hooks.create=(_params,_options,result)=>{result.configuration.merchant.capabilities.card_payments.status="pending";h.hooks.account=result;};
  const result=await onboard({pool:h.pool,provider:h.provider,config:h.config,authenticatedActor:{id:1},command:{intent:"CONNECT",country:"us"},idempotencyKey:randomUUID(),now:h.now});
  assert.equal(result.code,"VERIFICATION_PENDING");assert.equal(result.onboardingUrl,undefined);assert.equal(h.calls.link,0);
});
