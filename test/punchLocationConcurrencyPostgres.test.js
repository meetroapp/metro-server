"use strict";
const test=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {Client}=require('pg');
const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');const fns=require('./helpers/punchLocationFixture');
const assignment=require('../server/team/jobAssignmentService');const location=require('../server/team/punchLocationService');
const url=process.env.PUNCH_LOCATION_DATABASE_URL;
test('a snapshot waiting behind concurrent site revocation rejects the old authority',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const setup=new Client({connectionString:url}),revoker=new Client({connectionString:url}),capture=new Client({connectionString:url});
 await setup.connect();await revoker.connect();await capture.connect();
 let pending;
 try{
  await setup.query('BEGIN');await setup.query('SET CONSTRAINTS ALL DEFERRED');const base=fns.emergencyFixture.transactionalFacade(setup);
  const pool={...base,async query(sql,v){const r=await base.query(sql,v);if(/^BEGIN\b/.test(sql))await setup.query('SET CONSTRAINTS ALL DEFERRED');return r;},async connect(){return pool;}};
  const f=await fns.business(setup,pool);const input={pool,authenticatedActor:f.owner,businessId:f.profile,idempotencyKey:randomUUID()};
  const a=fns.success(await assignment.setJobAssignments(fns.command(pool,f,f.native))).assignments[0];
  const p=fns.success(await location.writePolicy({...input,expectedVersion:0,state:'ACTIVE',policy:{radiusMeters:100,maxAccuracyMeters:30,maxSampleAgeSeconds:120,maxFutureSkewSeconds:10}})).policy;
  const s=fns.success(await location.writeSite({...input,idempotencyKey:randomUUID(),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'Race worksite',address:{line1:'123 Shop',city:'Miami',region:'FL',postalCode:'33101',countryCode:'US'},latitude:26,longitude:-81,policyId:p.id,policyVersion:1})).site;
  fns.success(await location.authorizeAssignmentSite({...input,idempotencyKey:randomUUID(),assignmentId:a.id,siteId:s.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'}));
  await setup.query('SET CONSTRAINTS ALL IMMEDIATE');await setup.query('COMMIT');
  await revoker.query('BEGIN');
  const commandId=randomUUID();await revoker.query(`INSERT INTO business_punch_location_commands(id,contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint)
    VALUES($1,$2,$3,'SITE_WRITE',$4,$5)`,[commandId,f.profile,f.owner.membership,randomUUID(),'e'.repeat(64)]);
  const prior=(await revoker.query('SELECT * FROM business_punch_site_versions WHERE id=$1 AND version=1',[s.id])).rows[0];
  const row={...prior,version:2,state:'REVOKED',command_id:commandId};const keys=Object.keys(row);
  await revoker.query(`INSERT INTO business_punch_site_versions(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,keys.map(k=>row[k]));
  const capturePid=(await capture.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await capture.query("SET lock_timeout='5s'");
  pending=location.recordSnapshot({pool:{query:capture.query.bind(capture)},authenticatedActor:f.employee,businessId:f.profile,idempotencyKey:randomUUID(),assignmentId:a.id,siteId:s.id,siteVersion:1,associationVersion:1,assignmentActivationVersion:1,boundary:'CLOCK_IN',snapshot:{status:'CAPTURED',latitude:26,longitude:-81,accuracyMeters:8,sampledAt:new Date().toISOString()}});
  // Observe the actual PostgreSQL wait, rather than infer ordering from a delay.
  let blocked=false;
  for(let i=0;i<100;i++){
   const activity=(await setup.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[capturePid])).rows[0];
   if(activity?.wait_event==='advisory'){blocked=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(blocked,true,'Snapshot must wait for site revocation authority lock');
  await revoker.query('COMMIT');
  const denied=await pending;assert.equal(denied.status,409);assert.equal(denied.code,'PUNCH_AUTHORITY_CONFLICT');
  assert.equal((await setup.query('SELECT count(*)::int AS n FROM business_punch_location_snapshots WHERE site_id=$1',[s.id])).rows[0].n,0);
 }finally{
  await revoker.query('ROLLBACK');
  if(pending)await pending.catch(()=>{});
  await setup.query('ROLLBACK');await capture.query('ROLLBACK');
  await capture.end();await revoker.end();await setup.end();
 }
});
