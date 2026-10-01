"use strict";
const assert=require('node:assert/strict');const test=require('node:test');const {randomUUID}=require('node:crypto');const {Client}=require('pg');
const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');
const fns=require('./helpers/punchLocationFixture');const assignment=require('../server/team/jobAssignmentService');const location=require('../server/team/punchLocationService');
const url=process.env.PUNCH_LOCATION_DATABASE_URL;
const policyValues={radiusMeters:135,maxAccuracyMeters:35,maxSampleAgeSeconds:120,maxFutureSkewSeconds:10};
const address={line1:'456 Warehouse',city:'Cape Coral',region:'FL',postalCode:'33990',countryCode:'US'};
const success=fns.success;
async function rawCommand(client,f,action,actor=f.owner){return (await client.query(`INSERT INTO business_punch_location_commands(id,contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[randomUUID(),f.profile,actor.membership,action,randomUUID(),'c'.repeat(64)])).rows[0].id;}
async function rawSnapshot(client,f,row,changes={},actor=f.employee){
 const command=await rawCommand(client,f,'SNAPSHOT',actor);
 const r={...row,id:randomUUID(),command_id:command,...changes};
 const keys=['id','contractor_profile_id','membership_id','user_id','job_id','assignment_id','assignment_activation_version','site_id','site_version','association_version','boundary','capture_status','device_latitude','device_longitude','accuracy_meters','sampled_at','command_id'];
 return client.query(`INSERT INTO business_punch_location_snapshots(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,keys.map(k=>r[k]));
}
test('PostgreSQL certifies canonical Punch-location foundation without accepting Punches',{skip:!url},async t=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const client=new Client({connectionString:url});await client.connect();
 try{
  await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');const base=fns.emergencyFixture.transactionalFacade(client);
  const pool={...base,async query(sql,values){const r=await base.query(sql,values);if(/^BEGIN\b/.test(sql))await client.query('SET CONSTRAINTS ALL DEFERRED');return r;},async connect(){return pool;}};
  const a=await fns.business(client,pool),b=await fns.business(client,pool);
  const input=(f,actor=f.owner)=>({pool,authenticatedActor:actor,businessId:f.profile,idempotencyKey:randomUUID()});
  let policy,manual;const assigned=new Map(),sites=new Map(),links=new Map(),evidence=new Map();
  await t.test('Owner-only explicit policy; Manager/finance/field cannot acquire settings authority',async()=>{
   const p={expectedVersion:0,state:'ACTIVE',policy:policyValues};
   policy=success(await location.writePolicy({...input(a),...p})).policy;
   for(const actor of [a.manager,a.employee,a.finance])assert.equal((await location.writePolicy({...input(a,actor),...p})).status,403);
   const c=await rawCommand(client,a,'POLICY_WRITE',a.manager);
   await fns.rejectsSql(client,()=>client.query(`INSERT INTO business_punch_policy_versions(id,version,contractor_profile_id,state,radius_meters,max_accuracy_meters,max_sample_age_seconds,max_future_skew_seconds,actor_membership_id,command_id)
     VALUES($1,1,$2,'ACTIVE',135,35,120,10,$3,$4)`,[randomUUID(),a.profile,a.manager.membership,c]),/command lacks/);
   assert.equal((await location.writePolicy({...input(a),...p,policy:{...policyValues,radiusMeters:null}})).status,400);
  });
  await t.test('business-owned structured manual site; Manager can manage but cannot define policy',async()=>{
   manual=success(await location.writeSite({...input(a,a.manager),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'Warehouse',address,latitude:26.64,longitude:-81.98,policyId:policy.id,policyVersion:1})).site;
   assert.deepEqual(manual.address,address);assert.equal(manual.geometry.resolutionMethod,'BUSINESS_CONFIRMED');
   for(const actor of [a.employee,a.finance])assert.equal((await location.writeSite({...input(a,actor),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'No authority',address,latitude:26,longitude:-81,policyId:policy.id,policyVersion:1})).status,403);
   for(const value of ['Free text only',{...address,private_note:'PRIVATE'},null])assert.equal((await location.writeSite({...input(a),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'Invalid',address:value,latitude:26,longitude:-81,policyId:policy.id,policyVersion:1})).status,400);
  });
  await t.test('withheld ordinary address cannot become a customer reference site',async()=>{
   const r=await location.writeSite({...input(a),expectedVersion:0,state:'ACTIVE',kind:'CUSTOMER_JOB',label:'Customer',jobId:a.ordinary,latitude:26,longitude:-81,policyId:policy.id,policyVersion:1});
   assert.equal(r.code,'PUNCH_CUSTOMER_LOCATION_UNAVAILABLE');
   await client.query("UPDATE posts SET location_intake_mode='exact_on_file',service_address_line1='123 Authorized Ordinary Site',modification_version=modification_version+1 WHERE id=(SELECT job_request_id FROM jobs WHERE id=$1)",[a.ordinary]);
  });
  for(const [i,job] of a.jobs.entries())await t.test(`${['ordinary','native','Emergency'][i]} canonical customer reference and exact assignment association`,async()=>{
   const aresult=success(await assignment.setJobAssignments(fns.command(pool,a,job))).assignments[0];assigned.set(job,aresult);
   const request={...input(a),expectedVersion:0,state:'ACTIVE',kind:'CUSTOMER_JOB',label:'Assigned customer location',jobId:job,latitude:26.65+i*.01,longitude:-81.97,policyId:policy.id,policyVersion:1};
   const site=success(await location.writeSite(request)).site;sites.set(job,site);
   assert.equal(site.jobId,job);assert.equal(site.source.type,['ordinary_request_selection','business_customer','emergency_request'][i]);assert.match(site.source.revision,/^[a-f0-9]{64}$/);
   assert.equal(site.address.line1||site.address.text,['123 Authorized Ordinary Site','456 Assigned Site','Test location'][i]);
   const link=success(await location.authorizeAssignmentSite({...input(a),assignmentId:aresult.id,siteId:site.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'})).association;links.set(job,link);
   assert.equal(link.assignmentId,aresult.id);
   const capture={...input(a,a.employee),assignmentId:aresult.id,siteId:site.id,siteVersion:1,associationVersion:1,assignmentActivationVersion:1,boundary:'CLOCK_IN',snapshot:{status:'CAPTURED',latitude:26.65,longitude:-81.97,accuracyMeters:8,sampledAt:new Date().toISOString()}};
   const created=success(await location.recordSnapshot(capture));evidence.set(job,created.snapshot);
   assert.equal(created.punchAccepted,false);assert.equal(created.snapshot.verificationResult,'NOT_PERFORMED');assert.equal(created.snapshot.distanceMeters,null);assert.equal(created.snapshot.sampleState,'READY_FOR_VERIFICATION');
   assert.equal(created.snapshot.target.latitude,site.geometry.latitude);assert.equal(created.snapshot.target.radiusMeters,135);
   const replay=success(await location.recordSnapshot(capture));assert.equal(replay.replayed,true);assert.equal(replay.snapshot.id,created.snapshot.id);
   assert.equal((await location.recordSnapshot({...capture,snapshot:{...capture.snapshot,latitude:27}})).code,'PUNCH_IDEMPOTENCY_CONFLICT');
  });
  const nativeAssignment=assigned.get(a.native),nativeSite=sites.get(a.native);
  const capture=(job=a.native)=>({...input(a,a.employee),assignmentId:assigned.get(job).id,siteId:sites.get(job).id,siteVersion:1,associationVersion:1,assignmentActivationVersion:1,boundary:'CLOCK_OUT',snapshot:{status:'CAPTURED',latitude:26.65,longitude:-81.97,accuracyMeters:8,sampledAt:new Date().toISOString()}});
  await t.test('multiple explicit sites per assignment; reusable business site has exact member association',async()=>{
   const linked=success(await location.authorizeAssignmentSite({...input(a),assignmentId:nativeAssignment.id,siteId:manual.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'}));
   assert.equal(linked.association.siteId,manual.id);
   const own=success(await location.listSites({...input(a,a.employee),assignmentId:nativeAssignment.id}));assert.equal(own.sites.length,2);assert.ok(own.sites.every(s=>s.currentAuthority));
   const unrelated=success(await location.writeSite({...input(a),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'UNRELATED_PRIVATE_SITE',address:{...address,line1:'PRIVATE_OTHER_SITE'},latitude:29,longitude:-80,policyId:policy.id,policyVersion:1}));
   assert.doesNotMatch(JSON.stringify(own),/PRIVATE|UNRELATED|private-contact/);assert.ok(!own.sites.some(s=>s.id===unrelated.site.id));
  });
  await t.test('native TEXT reference has explicit confirmed geometry; UNSPECIFIED requires an explicit business site',async()=>{
   for(const serviceLocation of [{mode:'TEXT',text:'Canonical native operational site'},{mode:'UNSPECIFIED'}]){
    const job=await fns.nativeJob(client,pool,a,serviceLocation),assigned=success(await assignment.setJobAssignments(fns.command(pool,a,job))).assignments[0];
    const request={...input(a),expectedVersion:0,state:'ACTIVE',kind:'CUSTOMER_JOB',label:'Native reference',jobId:job,latitude:26,longitude:-81,policyId:policy.id,policyVersion:1};
    const result=await location.writeSite(request);
    if(serviceLocation.mode==='TEXT'){
      const site=success(result).site;assert.equal(site.address.text,serviceLocation.text);
      success(await location.authorizeAssignmentSite({...input(a),assignmentId:assigned.id,siteId:site.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'}));
    }else{
      assert.equal(result.code,'PUNCH_CUSTOMER_LOCATION_UNAVAILABLE');
      success(await location.authorizeAssignmentSite({...input(a),assignmentId:assigned.id,siteId:manual.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'}));
    }
    const own=success(await location.listSites({...input(a,a.employee),assignmentId:assigned.id}));assert.equal(own.sites.length,1);assert.doesNotMatch(JSON.stringify(own),/private-contact|PRIVATE_/);
   }
   await client.query("UPDATE emergency_requests SET unit_number='PRIVATE_UNIT',access_notes='PRIVATE_ACCESS' WHERE id=$1",[a.request]);
   const own=success(await location.listSites({...input(a,a.employee),assignmentId:assigned.get(a.emergency).id}));assert.doesNotMatch(JSON.stringify(own),/PRIVATE_/);
  });
  await t.test('tenant/source/employee isolation at service and database boundaries',async()=>{
   assert.equal((await location.listSites({...input(a,b.employee),assignmentId:nativeAssignment.id})).status,403);
   assert.deepEqual(success(await location.listSites({...input(a,a.otherEmployee),assignmentId:nativeAssignment.id})).sites,[]);
   assert.equal((await location.recordSnapshot({...capture(),authenticatedActor:a.otherEmployee})).code,'PUNCH_EXACT_ASSIGNMENT_REQUIRED');
   assert.equal((await location.recordSnapshot({...capture(),businessId:b.profile})).status,403);
   assert.equal((await location.listSites(input(a,a.employee))).status,403);
   assert.equal((await location.authorizeAssignmentSite({...input(b),assignmentId:nativeAssignment.id,siteId:manual.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'})).status,404);
   assert.equal((await location.authorizeAssignmentSite({...input(a),assignmentId:nativeAssignment.id,siteId:sites.get(a.ordinary).id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'})).status,409);
   assert.equal((await location.writeSite({...input(b),expectedVersion:0,state:'ACTIVE',kind:'CUSTOMER_JOB',label:'Other customer',jobId:a.native,latitude:26,longitude:-81,policyId:policy.id,policyVersion:1})).code,'PUNCH_CUSTOMER_LOCATION_UNAVAILABLE');
   const row=(await client.query('SELECT * FROM business_punch_location_snapshots WHERE id=$1',[evidence.get(a.native).id])).rows[0];
   await fns.rejectsSql(client,()=>rawSnapshot(client,a,row,{membership_id:a.otherEmployee.membership,user_id:a.otherEmployee.id},a.otherEmployee),/exact assignment\/site\/source|foreign key/);
   await fns.rejectsSql(client,()=>rawSnapshot(client,b,row,{contractor_profile_id:b.profile,membership_id:b.employee.membership,user_id:b.employee.id},b.employee),/exact assignment\/site\/source|foreign key/);
   const bpolicy=success(await location.writePolicy({...input(b),expectedVersion:0,state:'ACTIVE',policy:policyValues})).policy;
   const bsite=success(await location.writeSite({...input(b),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'Business B',address,latitude:25,longitude:-80,policyId:bpolicy.id,policyVersion:1})).site;
   assert.equal((await location.authorizeAssignmentSite({...input(a),assignmentId:nativeAssignment.id,siteId:bsite.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'})).status,409);
   await fns.rejectsSql(client,()=>rawSnapshot(client,a,row,{site_id:bsite.id}),/exact assignment\/site\/source|foreign key/);
  });
  await t.test('accuracy and sample-time classification is server-owned and never accepts a Punch',async()=>{
   const cases=[['INSUFFICIENT_ACCURACY',{accuracyMeters:36}],['STALE',{sampledAt:new Date(Date.now()-300000).toISOString()}],['FUTURE_SAMPLE',{sampledAt:new Date(Date.now()+300000).toISOString()}]];
   for(const [state,changes] of cases){const request=capture();request.snapshot={...request.snapshot,...changes};const result=success(await location.recordSnapshot(request));assert.equal(result.snapshot.sampleState,state);assert.equal(result.punchAccepted,false);assert.equal(result.snapshot.verificationResult,'NOT_PERFORMED');}
   for(const state of ['MISSING','DENIED','UNAVAILABLE']){const result=success(await location.recordSnapshot({...capture(),snapshot:{status:state}}));assert.equal(result.snapshot.sampleState,state);assert.equal(result.snapshot.device.latitude,null);}
   const zero=success(await location.recordSnapshot({...capture(),snapshot:{...capture().snapshot,latitude:0,longitude:0}}));assert.equal(zero.snapshot.device.latitude,0);
   assert.equal((await location.recordSnapshot({...capture(),isInsideGeofence:true})).status,400);
   assert.equal((await client.query('SELECT count(*)::int AS n FROM business_time_sessions')).rows[0].n,0);
  });
  await t.test('null/malformed/range coordinates and malformed accuracy/sample timestamps never enter evidence',async()=>{
   for(const value of [null,undefined,'',false,'0',NaN,Infinity,91]){const r=capture();r.snapshot.latitude=value;assert.equal((await location.recordSnapshot(r)).status,400);}
   for(const value of [null,'',0,-1,Infinity]){const r=capture();r.snapshot.accuracyMeters=value;assert.equal((await location.recordSnapshot(r)).status,400);}
   for(const value of [null,'yesterday','2026-02-30T12:00:00.000Z','2026-09-30']){const r=capture();r.snapshot.sampledAt=value;assert.equal((await location.recordSnapshot(r)).status,400);}
   const row=(await client.query('SELECT * FROM business_punch_location_snapshots WHERE id=$1',[evidence.get(a.native).id])).rows[0];
   for(const value of [null,91,'NaN','Infinity'])await fns.rejectsSql(client,()=>rawSnapshot(client,a,row,{device_latitude:value}),/check constraint/);
  });
  await t.test('direct DB cannot forge target/result/receipt or corrupt business/source/site geometry',async()=>{
   const snapshot=(await client.query('SELECT * FROM business_punch_location_snapshots WHERE id=$1',[evidence.get(a.native).id])).rows[0];
   const c=await rawCommand(client,a,'SNAPSHOT',a.employee);
   const forged=(await client.query(`INSERT INTO business_punch_location_snapshots(id,contractor_profile_id,membership_id,user_id,job_id,assignment_id,assignment_activation_version,site_id,site_version,association_version,boundary,capture_status,device_latitude,device_longitude,accuracy_meters,sampled_at,command_id,target_latitude,target_longitude,radius_meters,received_at,verification_result,distance_meters,sample_state)
     VALUES($1,$2,$3,$4,$5,$6,1,$7,1,1,'CLOCK_IN','CAPTURED',26,-81,8,clock_timestamp(),$8,0,0,999,'2000-01-01','VERIFIED_INSIDE',0,'STALE') RETURNING *`,
     [randomUUID(),a.profile,a.employee.membership,a.employee.id,a.native,nativeAssignment.id,nativeSite.id,c])).rows[0];
   assert.equal(forged.target_latitude,nativeSite.geometry.latitude);assert.equal(forged.radius_meters,135);assert.equal(forged.verification_result,'NOT_PERFORMED');assert.equal(forged.distance_meters,null);assert.ok(forged.received_at.getFullYear()>2000);
   const site=(await client.query('SELECT * FROM business_punch_site_versions WHERE id=$1 AND version=1',[manual.id])).rows[0];
   const siteKeys=Object.keys(site);
   for(const changes of [{latitude:null},{latitude:91},{latitude:'NaN'},{longitude:'Infinity'},{contractor_profile_id:b.profile},{manual_address:{...address,private_note:'forged'}}])await fns.rejectsSql(client,async()=>{
    const commandId=await rawCommand(client,a,'SITE_WRITE');const row={...site,id:randomUUID(),command_id:commandId,...changes};
    return client.query(`INSERT INTO business_punch_site_versions(${siteKeys.join(',')}) VALUES(${siteKeys.map((_,i)=>'$'+(i+1)).join(',')})`,siteKeys.map(k=>row[k]));
   },/null value|check constraint|exact active business|foreign key/);
   const customer=(await client.query('SELECT * FROM business_punch_site_versions WHERE id=$1 AND version=1',[nativeSite.id])).rows[0];
   await fns.rejectsSql(client,async()=>{const c=await rawCommand(client,a,'SITE_WRITE');const row={...customer,id:randomUUID(),source_revision:'f'.repeat(64),command_id:c};const keys=Object.keys(row);return client.query(`INSERT INTO business_punch_site_versions(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,keys.map(k=>row[k]));},/current canonical customer location/);
  });
  await t.test('closed/archived canonical sources deny new snapshots for all three sources',async()=>{
   for(const job of a.jobs){await client.query('SAVEPOINT closed_source');try{
    if(job===a.native)await client.query("UPDATE business_contacts SET status='ARCHIVED',version=version+1 WHERE id=(SELECT business_contact_id FROM jobs WHERE id=$1)",[job]);
    else await client.query("UPDATE request_relationships SET status='closed',closure_reason=CASE WHEN post_id IS NOT NULL THEN 'request_cancelled' ELSE NULL END WHERE id=(SELECT source_request_relationship_id FROM jobs WHERE id=$1)",[job]);
    assert.equal((await location.recordSnapshot(capture(job))).status,409);
    assert.ok(!success(await location.listSites({...input(a,a.employee),assignmentId:assigned.get(job).id})).sites.length);
    assert.ok(success(await location.listOwnSnapshots(input(a,a.employee))).snapshots.some(s=>s.id===evidence.get(job).id));
   }finally{await client.query('ROLLBACK TO SAVEPOINT closed_source');}}
  });
  await t.test('canonical source changes invalidate current authority while historic geometry/evidence stay intact',async()=>{
   for(const job of a.jobs){await client.query('SAVEPOINT source_change');try{
    if(job===a.ordinary)await client.query("UPDATE posts SET service_address_line1='Changed Ordinary Source' WHERE id=(SELECT job_request_id FROM jobs WHERE id=$1)",[job]);
    else if(job===a.native)await client.query("UPDATE business_customer_job_sources SET service_address_line1='Changed Native Source',version=version+1 WHERE id=(SELECT source_business_customer_job_id FROM jobs WHERE id=$1)",[job]);
    else await client.query("UPDATE emergency_requests SET location_text='Changed Emergency Canonical Location' WHERE id=$1",[a.request]);
    assert.equal((await location.recordSnapshot(capture(job))).status,409);
    const old=sites.get(job),current=(await client.query('SELECT * FROM business_punch_customer_location($1,$2)',[a.profile,job])).rows[0];assert.notEqual(current.source_revision,old.source.revision);
    assert.ok(!success(await location.listSites({...input(a,a.employee),assignmentId:assigned.get(job).id})).sites.some(s=>s.id===old.id));
    const replacement=success(await location.writeSite({...input(a),id:old.id,expectedVersion:1,state:'ACTIVE',kind:'CUSTOMER_JOB',label:'Updated confirmed source',jobId:job,latitude:27,longitude:-81,policyId:policy.id,policyVersion:1})).site;
    assert.equal(replacement.version,2);assert.equal(replacement.source.revision,current.source_revision);
    const historical=(await client.query('SELECT * FROM business_punch_location_snapshots WHERE id=$1',[evidence.get(job).id])).rows[0];assert.equal(historical.site_version,1);assert.equal(historical.target_latitude,old.geometry.latitude);
   }finally{await client.query('ROLLBACK TO SAVEPOINT source_change');}}
  });
  await t.test('site revocation/reactivation and explicit association replacement; no implicit reuse',async()=>{
   const revoked=success(await location.writeSite({...input(a),id:nativeSite.id,expectedVersion:1,state:'REVOKED'})).site;assert.equal(revoked.version,2);
   assert.equal((await location.recordSnapshot(capture())).status,409);
   const active=success(await location.writeSite({...input(a),id:nativeSite.id,expectedVersion:2,state:'ACTIVE',kind:'CUSTOMER_JOB',label:nativeSite.label,jobId:a.native,latitude:27,longitude:-81,policyId:policy.id,policyVersion:1})).site;assert.equal(active.version,3);
   assert.equal((await location.recordSnapshot(capture())).status,409);
   success(await location.authorizeAssignmentSite({...input(a),assignmentId:nativeAssignment.id,siteId:active.id,siteVersion:3,assignmentActivationVersion:1,expectedVersion:1,state:'ACTIVE'}));
   const live={...capture(),siteVersion:3,associationVersion:2};success(await location.recordSnapshot(live));
   success(await location.authorizeAssignmentSite({...input(a),assignmentId:nativeAssignment.id,siteId:active.id,siteVersion:3,assignmentActivationVersion:1,expectedVersion:2,state:'REVOKED'}));
   assert.equal((await location.recordSnapshot({...live,idempotencyKey:randomUUID()})).status,409);
   success(await location.authorizeAssignmentSite({...input(a),assignmentId:nativeAssignment.id,siteId:active.id,siteVersion:3,assignmentActivationVersion:1,expectedVersion:3,state:'ACTIVE'}));
   success(await location.recordSnapshot({...live,associationVersion:4,idempotencyKey:randomUUID()}));
  });
  await t.test('assignment reassignment cannot inherit old site activation; inactive employee denied',async()=>{
   await client.query('SAVEPOINT assignment_change');try{
    success(await assignment.setJobAssignments(fns.command(pool,a,a.ordinary,a.owner,[])));
    const reactivated=success(await assignment.setJobAssignments(fns.command(pool,a,a.ordinary))).assignments[0];assert.equal(reactivated.id,assigned.get(a.ordinary).id);assert.equal(reactivated.version,3);
    assert.equal((await location.recordSnapshot(capture(a.ordinary))).status,409);
    success(await location.authorizeAssignmentSite({...input(a),assignmentId:reactivated.id,siteId:sites.get(a.ordinary).id,siteVersion:1,assignmentActivationVersion:3,expectedVersion:1,state:'ACTIVE'}));
    success(await location.recordSnapshot({...capture(a.ordinary),assignmentActivationVersion:3,associationVersion:2}));
    await client.query("UPDATE business_team_memberships SET status='DEACTIVATED',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1",[a.employee.membership]);
    assert.equal((await location.recordSnapshot(capture())).status,403);
   }finally{await client.query('ROLLBACK TO SAVEPOINT assignment_change');}
  });
  await t.test('policy revocation disables new snapshots without moving historical policy/geometry',async()=>{
   success(await location.writePolicy({...input(a),id:policy.id,expectedVersion:1,state:'REVOKED',policy:policyValues}));
   const before=evidence.get(a.native);assert.equal(before.target.policyVersion,1);
   assert.deepEqual(success(await location.listSites({...input(a,a.employee),assignmentId:nativeAssignment.id})).sites,[]);
   assert.equal((await location.recordSnapshot({...capture(),siteVersion:3,associationVersion:4})).status,409);
   const historical=(await client.query('SELECT radius_meters,policy_version FROM business_punch_location_snapshots WHERE id=$1',[before.id])).rows[0];assert.equal(historical.policy_version,1);assert.equal(historical.radius_meters,135);
  });
  await t.test('GPS evidence is self-only; all authority versions, snapshots and command results immutable',async()=>{
   const own=success(await location.listOwnSnapshots(input(a,a.employee)));assert.ok(own.snapshots.length>=3);assert.ok(own.snapshots.every(s=>s.membershipId===a.employee.membership));
   assert.deepEqual(success(await location.listOwnSnapshots(input(a,a.otherEmployee))).snapshots,[]);
   assert.equal((await location.listOwnSnapshots(input(a,a.owner))).status,403);
   assert.equal((await location.listOwnSnapshots(input(a,a.finance))).status,403);
   assert.equal((await location.listOwnSnapshots(input(a,b.employee))).status,403);
   for(const table of ['business_punch_policy_versions','business_punch_site_versions','business_punch_assignment_site_versions','business_punch_location_snapshots','business_punch_location_commands'])await fns.rejectsSql(client,()=>client.query(`DELETE FROM ${table}`),/immutable/);
   await fns.rejectsSql(client,()=>client.query('UPDATE business_punch_location_snapshots SET device_latitude=0'),/immutable/);
   await fns.rejectsSql(client,()=>client.query('UPDATE business_punch_site_versions SET latitude=0'),/immutable/);
   await fns.rejectsSql(client,()=>client.query("UPDATE business_punch_location_commands SET result_reference='{}' WHERE completed_at IS NOT NULL"),/immutable/);
  });
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
 }finally{await client.query('ROLLBACK');await client.end();}
});
