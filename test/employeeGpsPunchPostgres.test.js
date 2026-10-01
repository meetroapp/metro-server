"use strict";
const assert=require('node:assert/strict');const test=require('node:test');const {randomUUID}=require('node:crypto');const {Client}=require('pg');
const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');const fns=require('./helpers/punchVerificationFixture');
const time=require('../server/team/timeEvidenceService');const location=require('../server/team/punchLocationService');const assignment=require('../server/team/jobAssignmentService');
const url=process.env.PUNCH_VERIFICATION_DATABASE_URL;
test('Employee foreground GPS uses the existing governed time authority for all sources',{skip:!url},async t=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const client=new Client({connectionString:url});await client.connect();
 try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');const x=await fns.setup(client);const {f,pool}=x;
 const input=(job=f.native)=>({pool,authenticatedActor:f.employee,businessId:f.profile,category:'JOB_WORK',jobId:job,assignmentId:x.assigned.get(job).id,assignmentActivationVersion:1,location:{status:'CAPTURED',latitude:26.64,longitude:-81.98,accuracyMeters:8,sampledAt:new Date().toISOString()},idempotencyKey:randomUUID()});
 const counts=async()=> (await client.query(`SELECT (SELECT count(*)::int FROM business_time_events) events,(SELECT count(*)::int FROM business_time_sessions) sessions,(SELECT count(*)::int FROM business_punch_location_snapshots WHERE time_command_id IS NOT NULL) verified`)).rows[0];
 const denied=async(r)=>{const before=await counts();const result=await time.clockIn(r);assert.equal(result.ok,false,JSON.stringify(result));assert.deepEqual(await counts(),before);return result;};
 for(const [i,job] of f.jobs.entries())await t.test(['Ordinary','Native','Emergency'][i]+' Punch In/Out executes with exact immutable verified evidence',async()=>{
  const r=input(job);const started=fns.success(await time.clockIn(r));assert.equal(started.verification.status,'VERIFIED_INSIDE');assert.equal(started.session.assignmentId,r.assignmentId);
  await fns.flush(client);const retry=fns.success(await time.clockIn(r));assert.equal(retry.replayed,true);assert.equal(retry.session.id,started.session.id);
  assert.equal((await denied({...r,location:{...r.location,latitude:26.64001}})).code,'TIME_IDEMPOTENCY_CONFLICT');
  assert.equal((await denied({...input(job)})).code,'TIME_TIMER_ALREADY_ACTIVE');
  const out={...input(job),sessionId:started.session.id};delete out.category;const stopped=fns.success(await time.clockOut(out));assert.ok(stopped.session.clockedOutAt);await fns.flush(client);
  assert.equal(fns.success(await time.clockOut(out)).replayed,true);
  const rows=(await client.query(`SELECT s.*,e.event_type FROM business_punch_location_snapshots s JOIN business_time_events e ON e.command_id=s.time_command_id WHERE s.assignment_id=$1`,[r.assignmentId])).rows;
  assert.equal(rows.length,2);assert.deepEqual(rows.map(s=>s.boundary).sort(),['CLOCK_IN','CLOCK_OUT']);assert.ok(rows.every(s=>s.verification_result==='VERIFIED_INSIDE'&&s.verification_algorithm==='HAVERSINE_V1'&&s.distance_meters===0&&s.accuracy_meters===8));
 });
 for(const [name,change] of [['outside',{latitude:27}],['null latitude',{latitude:null}],['null longitude',{longitude:null}],['NaN',{latitude:NaN}],['infinite',{longitude:Infinity}],['range',{latitude:91}],['string',{latitude:'26.64'}],['boolean',{latitude:false}],['zero accuracy',{accuracyMeters:0}],['negative accuracy',{accuracyMeters:-1}],['inaccurate',{accuracyMeters:100}],['stale',{sampledAt:new Date(Date.now()-300000).toISOString()}],['future',{sampledAt:new Date(Date.now()+300000).toISOString()}],['invalid timestamp',{sampledAt:'2026-02-30T12:00:00.000Z'}],['client distance',{distanceMeters:0}]])await t.test(name+' rejected without successful event',async()=>{const r=input();r.location={...r.location,...change};await denied(r);});
 for(const status of ['MISSING','DENIED','UNAVAILABLE'])await t.test(status+' fails closed',()=>denied({...input(),location:{status}}));
 await t.test('missing location fails closed',()=>denied({...input(),location:null}));
 await t.test('wrong employee cannot use assignment',async()=>assert.equal((await denied({...input(),authenticatedActor:f.otherEmployee})).status,403));
 await t.test('unauthenticated and finance action denied',async()=>{await denied({...input(),authenticatedActor:null});assert.equal((await denied({...input(),authenticatedActor:f.finance})).status,403);});
 await t.test('wrong tenant cannot consume assignment',async()=>{const y=await fns.setup(client);assert.equal((await denied({...input(),authenticatedActor:y.f.employee,businessId:y.f.profile})).status,403);});
 await t.test('forged assignment, activation, and selected site denied',async()=>{for(const change of [{assignmentId:randomUUID()},{assignmentActivationVersion:2},{siteId:randomUUID(),siteVersion:1,associationVersion:1},{siteId:x.site.id,siteVersion:2,associationVersion:1}])await denied({...input(),...change});});
 await t.test('multiple sites selects actual qualifying site and denies stale selection',async()=>{
  await client.query('SAVEPOINT multiple');try{
   const far=fns.success(await location.writeSite({...x.input(),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'Distant supply house',address:x.site.address,latitude:27,longitude:-81.98,policyId:x.policy.id,policyVersion:1})).site;
   fns.success(await location.authorizeAssignmentSite({...x.input(),assignmentId:x.assigned.get(f.native).id,siteId:far.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'}));
   const r=fns.success(await time.clockIn(input()));await fns.flush(client);assert.equal((await client.query('SELECT site_id FROM business_punch_location_snapshots WHERE time_command_id=(SELECT clock_in_command_id FROM business_time_sessions WHERE id=$1)',[r.session.id])).rows[0].site_id,x.site.id);
  }finally{await client.query('ROLLBACK TO SAVEPOINT multiple');}
 });
 await t.test('revoked site is excluded even if another active site exists',async()=>{
  await client.query('SAVEPOINT revoke');try{fns.success(await location.writeSite({...x.input(),id:x.site.id,expectedVersion:1,state:'REVOKED'}));await denied(input());await denied({...input(),siteId:x.site.id,siteVersion:1,associationVersion:1});}finally{await client.query('ROLLBACK TO SAVEPOINT revoke');}
 });
 await t.test('revoked association and inactive assignment fail closed',async()=>{
  await client.query('SAVEPOINT revoked_assignment');try{fns.success(await location.authorizeAssignmentSite({...x.input(),assignmentId:x.assigned.get(f.native).id,siteId:x.site.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:1,state:'REVOKED'}));await denied(input());fns.success(await assignment.setJobAssignments(fns.command(pool,f,f.native,f.owner,[])));await denied(input());}finally{await client.query('ROLLBACK TO SAVEPOINT revoked_assignment');}
 });
 await t.test('Punch Out outside / wrong session actor / revoked assignment leaves timer active',async()=>{
  await client.query('SAVEPOINT out_denial');try{const r=fns.success(await time.clockIn(input()));await fns.flush(client);const before=await counts();
   for(const change of [{location:{status:'DENIED'}},{location:{...input().location,latitude:27}},{authenticatedActor:f.otherEmployee},{assignmentId:x.assigned.get(f.ordinary).id,jobId:f.ordinary}])assert.equal((await time.clockOut({...input(),sessionId:r.session.id,...change})).ok,false);
   fns.success(await assignment.setJobAssignments(fns.command(pool,f,f.native,f.owner,[])));assert.equal((await time.clockOut({...input(),sessionId:r.session.id})).ok,false);assert.deepEqual(await counts(),before);assert.equal((await client.query('SELECT clocked_out_at FROM business_time_sessions WHERE id=$1',[r.session.id])).rows[0].clocked_out_at,null);
  }finally{await client.query('ROLLBACK TO SAVEPOINT out_denial');}
 });
 await t.test('non JOB_WORK categories preserve session identity rules while requiring assignment GPS',async()=>{
  for(const category of ['OFFICE','DRIVING','SUPPLIES','BREAK','GENERAL']){const r=fns.success(await time.clockIn({...input(),category}));assert.equal(r.session.jobId,null);assert.equal(r.session.assignmentId,null);assert.equal(r.session.punchAssignmentId,x.assigned.get(f.native).id);assert.equal(r.session.jobTitle,'Native assigned work');await fns.flush(client);assert.equal(fns.success(await time.listOwnTime({pool,authenticatedActor:f.employee,businessId:f.profile})).activeSession.jobTitle,'Native assigned work');fns.success(await time.clockOut({...input(),sessionId:r.session.id}));await fns.flush(client);}
 });
 await t.test('employee/private time and finance projections omit precise GPS and verification internals',async()=>{
  for(const r of [fns.success(await time.listOwnTime({pool,authenticatedActor:f.employee,businessId:f.profile})),fns.success(await time.listTeamTime({pool,authenticatedActor:f.finance,businessId:f.profile}))])assert.doesNotMatch(JSON.stringify(r),/latitude|longitude|accuracyMeters|distanceMeters|verification_algorithm|time_command_id|radiusMeters/);
  assert.equal((await location.listSites({...x.input(f.employee)})).status,403);
  const sites=fns.success(await location.listSites({...x.input(f.employee),assignmentId:x.assigned.get(f.native).id}));assert.equal(sites.sites.length,1);
  assert.equal((await location.listOwnSnapshots(x.input(f.otherEmployee))).snapshots.length,0);
  const customer=require('../server/workflow/nativeCustomerHistoryService');const history=fns.success(await customer.listNativeCustomerHistory({pool,authenticatedActor:f.owner,contractorProfileId:f.profile,homeownerUserId:f.homeowner}));
  assert.doesNotMatch(JSON.stringify(history),/accuracyMeters|distanceMeters|verification_algorithm|device_latitude|time_command_id|Warehouse/);
 });
 }finally{await client.query('ROLLBACK');await client.end();}
});
