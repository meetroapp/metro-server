"use strict";
const assert=require('node:assert/strict');const test=require('node:test');const {randomUUID}=require('node:crypto');const {Client}=require('pg');
const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');
const fns=require('./helpers/punchLocationFixture');const assignment=require('../server/team/jobAssignmentService');const location=require('../server/team/punchLocationService');
const nativeHistory=require('../server/workflow/nativeCustomerHistoryService');
const management=require('../server/team/businessPunchLocationService');const {createBusinessPunchLocationHandlers}=require('../server/team/businessPunchLocations');
const url=process.env.PUNCH_LOCATION_DATABASE_URL,success=fns.success;
const address={line1:'456 Business Warehouse',city:'Cape Coral',region:'FL',postalCode:'33990',countryCode:'US'};
test('PostgreSQL certifies business Punch-location management using the frozen A schema',{skip:!url},async t=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const client=new Client({connectionString:url});await client.connect();
 try{
  await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');const base=fns.emergencyFixture.transactionalFacade(client);
  const pool={...base,async query(sql,values){const r=await base.query(sql,values);if(/^BEGIN\b/.test(sql))await client.query('SET CONSTRAINTS ALL DEFERRED');return r;},async connect(){return pool;}};
  const a=await fns.business(client,pool),b=await fns.business(client,pool);
  const input=(f=a,actor=f.owner)=>({pool,authenticatedActor:actor,businessId:f.profile,idempotencyKey:randomUUID()});
  const policies={radiusMeters:135,maxAccuracyMeters:35,maxSampleAgeSeconds:120,maxFutureSkewSeconds:10};
  const p=success(await location.writePolicy({...input(),expectedVersion:0,state:'ACTIVE',policy:policies})).policy;
  await client.query("UPDATE posts SET location_intake_mode='exact_on_file',service_address_line1='123 Authorized Ordinary Site',modification_version=modification_version+1 WHERE id=(SELECT job_request_id FROM jobs WHERE id=$1)",[a.ordinary]);
  const assigned=new Map(),created=new Map();
  for(const job of a.jobs)assigned.set(job,success(await assignment.setJobAssignments(fns.command(pool,a,job))).assignments[0]);
  const binding=(job=a.native,actor=a.owner)=>({...input(a,actor),assignmentId:assigned.get(job).id,employeeMembershipId:a.employee.membership,expectedAssignmentVersion:1,assignmentActivationVersion:1,expectedVersion:0});
  const read=(job=a.native,actor=a.owner)=>management.readManagement(binding(job,actor));
  const capture=()=>({latitude:26.64,longitude:-81.98,accuracyMeters:8,sampledAt:new Date().toISOString()});
  const manual=(changes={})=>({expectedVersion:0,kind:'MANUAL_BUSINESS',label:'Warehouse',address,policyId:p.id,policyVersion:1,capture:capture(),...changes});
  for(const [i,job]of a.jobs.entries())await t.test(`${['ordinary','native','Emergency'][i]} exact employee/source-bound customer location managed by Owner`,async()=>{
   const context=success(await read(job));assert.equal(context.assignment.membershipId,a.employee.membership);assert.equal(context.canManage,true);assert.equal(context.canManagePolicy,true);
   const request={...binding(job),site:{expectedVersion:0,kind:'CUSTOMER_JOB',label:'Customer worksite',policyId:p.id,policyVersion:1,capture:capture(),customerSourceRevision:context.customerLocation.source.revision}};
   const result=success(await management.saveAssignmentSite(request));created.set(job,result);
   assert.equal(result.site.source.type,['ordinary_request_selection','business_customer','emergency_request'][i]);assert.equal(result.site.jobId,job);
   assert.equal(result.site.geometryCapture.source,'FOREGROUND_DEVICE');assert.equal(result.site.geometryCapture.accuracyMeters,8);assert.equal(result.site.geometryCapture.sampledAt,request.site.capture.sampledAt);
   const reread=success(await read(job)),site=reread.sites.find(s=>s.id===result.site.id);assert.equal(site.currentAuthorization,true);assert.deepEqual(site.geometryCapture,result.site.geometryCapture);
   assert.equal(site.source.revision,context.customerLocation.source.revision);assert.equal(site.geometry.latitude,request.site.capture.latitude);assert.equal(reread.proximityEnforced,true);
   assert.doesNotMatch(JSON.stringify(reread),/PRIVATE_|private-contact|email|phone|access_notes|distanceMeters|verificationResult/);
   assert.ok(!reread.sites.some(s=>s.kind==='CUSTOMER_JOB'&&s.jobId!==job));
   const replay=success(await management.saveAssignmentSite(request));assert.equal(replay.replayed,true);assert.equal(replay.site.id,result.site.id);
   assert.equal((await management.saveAssignmentSite({...request,site:{...request.site,label:'Different'}})).code,'PUNCH_IDEMPOTENCY_CONFLICT');
  });
  let manualResult;
  await t.test('Manager uses existing assignment authority, adds reusable structured manual site and multiple simultaneous locations',async()=>{
   const ctx=success(await read(a.native,a.manager));assert.equal(ctx.canManage,true);assert.equal(ctx.canManagePolicy,false);
   manualResult=success(await management.saveAssignmentSite({...binding(a.native,a.manager),site:manual()}));assert.deepEqual(manualResult.site.address,address);
   const ctx2=success(await read());assert.equal(ctx2.sites.filter(s=>s.currentAuthorization).length,2);
   assert.equal((await location.writePolicy({...input(a,a.manager),expectedVersion:0,state:'ACTIVE',policy:policies})).status,403);
   success(await management.changeAuthorization({...binding(a.ordinary,a.manager),siteId:manualResult.site.id,siteVersion:1,state:'ACTIVE'}));
   assert.equal(success(await read(a.ordinary)).sites.filter(s=>s.currentAuthorization).length,2);
  });
  await t.test('Field Employee, finance, inactive membership and customer management denied',async()=>{
   for(const actor of [a.employee,a.otherEmployee,a.finance,a.inactive,{id:a.homeowner}]){
    assert.equal((await read(a.native,actor)).status,403);
    assert.equal((await management.saveAssignmentSite({...binding(a.native,actor),site:manual()})).status,403);
    assert.equal((await management.changeAuthorization({...binding(a.native,actor),siteId:manualResult.site.id,siteVersion:1,state:'REVOKED'})).status,403);
   }
  });
  await t.test('cross-business and mixed employee/assignment contexts are denied without location disclosure',async()=>{
   assert.equal((await management.readManagement({...binding(),authenticatedActor:b.owner})).status,403);
   assert.equal((await management.readManagement({...binding(),authenticatedActor:b.owner,businessId:b.profile})).status,404);
   assert.equal((await management.readManagement({...binding(),employeeMembershipId:a.otherEmployee.membership})).status,404);
   assert.equal((await management.saveAssignmentSite({...binding(),employeeMembershipId:a.otherEmployee.membership,site:manual()})).status,404);
   assert.equal((await management.changeAuthorization({...binding(),employeeMembershipId:a.otherEmployee.membership,siteId:manualResult.site.id,siteVersion:1,state:'ACTIVE'})).status,404);
   assert.equal((await management.changeAuthorization({...binding(a.ordinary),siteId:created.get(a.native).site.id,siteVersion:1,state:'ACTIVE'})).status,409);
   const bp=success(await location.writePolicy({...input(b),expectedVersion:0,state:'ACTIVE',policy:policies})).policy;
   const bs=success(await location.writeSite({...input(b),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'PRIVATE_BUSINESS_B',address,latitude:28,longitude:-80,policyId:bp.id,policyVersion:1})).site;
   assert.equal((await management.changeAuthorization({...binding(),siteId:bs.id,siteVersion:1,state:'ACTIVE'})).status,409);
   assert.doesNotMatch(JSON.stringify(success(await read())),/PRIVATE_BUSINESS_B/);
  });
  await t.test('assignment-site revocation and activation append immutable history',async()=>{
   const id=manualResult.site.id;
   const revokeRequest={...binding(a.native,a.manager),expectedVersion:1,siteId:id,siteVersion:1,state:'REVOKED'};
   const revoked=success(await management.changeAuthorization(revokeRequest));assert.equal(revoked.association.version,2);
   const replay=success(await management.changeAuthorization(revokeRequest));assert.equal(replay.replayed,true);assert.equal(replay.association.version,2);
   let ctx=success(await read()),s=ctx.sites.find(s=>s.id===id);assert.equal(s.currentAuthorization,false);assert.equal(s.association.state,'REVOKED');
   success(await management.changeAuthorization({...binding(),expectedVersion:2,siteId:id,siteVersion:1,state:'ACTIVE'}));
   ctx=success(await read());s=ctx.sites.find(s=>s.id===id);assert.equal(s.currentAuthorization,true);assert.deepEqual(s.history.map(h=>h.state),['ACTIVE','REVOKED','ACTIVE']);
   await fns.rejectsSql(client,()=>client.query('UPDATE business_punch_assignment_site_versions SET state=\'REVOKED\' WHERE site_id=$1',[id]),/immutable/);
  });
  await t.test('new site version never silently moves another assignment; stale site and association writes reject',async()=>{
   const id=manualResult.site.id,request={...binding(),expectedVersion:3,site:manual({id,expectedVersion:1,label:'Warehouse reviewed'})};
   const updated=success(await management.saveAssignmentSite(request));assert.equal(updated.site.version,2);assert.equal(updated.association.version,4);
   const ordinary=success(await read(a.ordinary)).sites.find(s=>s.id===id);assert.equal(ordinary.currentAuthorization,false);assert.equal(ordinary.association.siteVersion,1);assert.equal(ordinary.version,2);
   assert.equal((await management.saveAssignmentSite({...request,idempotencyKey:randomUUID()})).code,'PUNCH_SITE_STALE');
   assert.equal((await management.changeAuthorization({...binding(),siteId:id,siteVersion:2,state:'ACTIVE'})).code,'PUNCH_ASSOCIATION_STALE');
   success(await management.changeAuthorization({...binding(a.ordinary),expectedVersion:1,siteId:id,siteVersion:2,state:'ACTIVE'}));
   assert.equal(success(await read(a.ordinary)).sites.find(s=>s.id===id).currentAuthorization,true);
  });
  await t.test('atomic creation rolls back site and capture command when association version is stale',async()=>{
   const before=(await client.query('SELECT count(*)::int AS n FROM business_punch_site_versions')).rows[0].n;
   const commands=(await client.query('SELECT count(*)::int AS n FROM business_punch_location_commands')).rows[0].n;
   const result=await management.saveAssignmentSite({...binding(),expectedVersion:9,site:manual({label:'Must roll back'})});assert.equal(result.code,'PUNCH_ASSOCIATION_STALE');
   assert.equal((await client.query('SELECT count(*)::int AS n FROM business_punch_site_versions')).rows[0].n,before);
   assert.equal((await client.query('SELECT count(*)::int AS n FROM business_punch_location_commands')).rows[0].n,commands);
  });
  await t.test('strict capture, null coercion, provenance and server-owned policy checks',async()=>{
   for(const changes of [{latitude:null},{longitude:''},{latitude:false},{latitude:'0'},{latitude:91},{accuracyMeters:0},{sampledAt:'2026-02-30T13:00:00.000Z'},{source:'GEOCODED'},{verificationResult:'VERIFIED'}]){
    const site=manual();site.capture={...site.capture,...changes};assert.equal((await management.saveAssignmentSite({...binding(),site})).status,400);
   }
   for(const changes of [{accuracyMeters:36},{sampledAt:new Date(Date.now()-300000).toISOString()},{sampledAt:new Date(Date.now()+300000).toISOString()}]){
    const site=manual();site.capture={...site.capture,...changes};assert.equal((await management.saveAssignmentSite({...binding(),site})).code,'PUNCH_SITE_CAPTURE_REVIEW');
   }
   const site=manual();site.capture.latitude=0;site.capture.longitude=0;const zero=success(await management.saveAssignmentSite({...binding(),site}));assert.equal(zero.site.geometry.latitude,0);
   const row=(await client.query('SELECT command_id FROM business_punch_site_versions WHERE id=$1',[zero.site.id])).rows[0];
   await fns.rejectsSql(client,()=>client.query('UPDATE business_punch_location_commands SET result_reference=\'{}\' WHERE id=$1',[row.command_id]),/immutable/);
   assert.equal((await client.query('SELECT count(*)::int AS n FROM business_punch_location_snapshots')).rows[0].n,0);
   assert.equal((await client.query('SELECT count(*)::int AS n FROM business_time_sessions')).rows[0].n,0);
  });
  await t.test('configured business sites and capture evidence remain absent from canonical customer History/commercial projections',async()=>{
   const result=success(await nativeHistory.listNativeCustomerHistory({pool,authenticatedActor:{id:a.professional},contractorProfileId:a.profile,homeownerUserId:a.homeowner,limit:50}));
   assert.equal(result.nativeCustomerHistory.jobs.length,2);
   assert.doesNotMatch(JSON.stringify(result),/geometryCapture|latitude|longitude|accuracyMeters|radiusMeters|policyId|policyVersion|assignmentActivationVersion|Warehouse reviewed|Business Warehouse/);
   for(const value of [true,false,[a.profile],{id:a.profile},'1e0',' 1'])assert.equal((await management.readManagement({...binding(),businessId:value})).status,400);
   for(const version of [null,'1',true,2147483647])assert.equal((await management.changeAuthorization({...binding(),expectedVersion:version,siteId:manualResult.site.id,siteVersion:2,state:'ACTIVE'})).status,400);
  });
  await t.test('stale customer source reference is rejected instead of rebinding captured geometry',async()=>{
   const ctx=success(await read(a.ordinary));
   await client.query("UPDATE posts SET service_address_line1='Changed Customer Site',modification_version=modification_version+1 WHERE id=(SELECT job_request_id FROM jobs WHERE id=$1)",[a.ordinary]);
   const result=await management.saveAssignmentSite({...binding(a.ordinary),site:{...manual(),kind:'CUSTOMER_JOB',address:undefined,customerSourceRevision:ctx.customerLocation.source.revision}});
   assert.equal(result.code,'PUNCH_CUSTOMER_LOCATION_STALE');
   const site=success(await read(a.ordinary)).sites.find(s=>s.id===created.get(a.ordinary).site.id);assert.equal(site.currentAuthorization,false);assert.equal(site.address,null);
  });
  await t.test('stale assignment epoch/version rejected; explicit review reactivates after re-assignment',async()=>{
   success(await assignment.setJobAssignments(fns.command(pool,a,a.native,a.owner,[])));
   assert.equal((await management.saveAssignmentSite({...binding(),site:manual()})).code,'PUNCH_ASSIGNMENT_STALE');
   success(await assignment.setJobAssignments(fns.command(pool,a,a.native)));
   const ctx=success(await read());assert.ok(ctx.assignment.version>1);assert.ok(ctx.assignment.activationVersion>1);assert.ok(ctx.sites.every(s=>!s.currentAuthorization));
   assert.equal((await management.changeAuthorization({...binding(),siteId:manualResult.site.id,siteVersion:2,state:'ACTIVE',expectedVersion:4})).code,'PUNCH_ASSIGNMENT_STALE');
   const current={...binding(),expectedAssignmentVersion:ctx.assignment.version,assignmentActivationVersion:ctx.assignment.activationVersion,expectedVersion:4,siteId:manualResult.site.id,siteVersion:2};
   success(await management.changeAuthorization({...current,state:'REVOKED'}));
   success(await management.changeAuthorization({...current,expectedVersion:5,state:'ACTIVE',idempotencyKey:randomUUID()}));
   assert.equal(success(await read()).sites.find(s=>s.id===manualResult.site.id).currentAuthorization,true);
  });
  await t.test('real management route boundary enforces actor and exact assignment, rejects authority injection',async()=>{
   const h=createBusinessPunchLocationHandlers({getPool:()=>pool,sendPublicDatabaseError:()=>assert.fail('Unexpected route error')});
   const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}});
   const res=response();await h.read({user:a.manager,params:{assignmentId:assigned.get(a.emergency).id},query:{businessId:String(a.profile),employeeMembershipId:a.employee.membership}},res);assert.equal(res.body.success,true);assert.equal(res.headers['Cache-Control'],'private, no-store');
   for(const injected of ['authenticatedActor','membershipId','sourceId','verificationResult','targetLatitude','_transactionClient']){
    const denied=response();await h.save({user:a.owner,params:{assignmentId:assigned.get(a.emergency).id},body:{businessId:a.profile,[injected]:true}},denied);assert.equal(denied.statusCode,400);
   }
   const denied=response();await h.read({user:a.finance,params:{assignmentId:assigned.get(a.emergency).id},query:{businessId:a.profile,employeeMembershipId:a.employee.membership}},denied);assert.equal(denied.statusCode,403);assert.doesNotMatch(JSON.stringify(denied.body),/latitude|address|Warehouse/);
  });
 }finally{await client.query('ROLLBACK');await client.end();}
});
