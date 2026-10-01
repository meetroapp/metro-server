"use strict";
const assert=require('node:assert/strict'),test=require('node:test'),{randomUUID}=require('node:crypto'),{Client,Pool}=require('pg');
const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');const fns=require('./helpers/punchLocationFixture');
const assignment=require('../server/team/jobAssignmentService'),location=require('../server/team/punchLocationService'),management=require('../server/team/businessPunchLocationService');
const url=process.env.PUNCH_LOCATION_DATABASE_URL;
test('concurrent Owner/Manager authorization writes retain one winning immutable version',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const setup=new Client({connectionString:url}),live=new Pool({connectionString:url,max:3});await setup.connect();
 try{
  await setup.query('BEGIN');await setup.query('SET CONSTRAINTS ALL DEFERRED');const base=fns.emergencyFixture.transactionalFacade(setup);
  const pool={...base,async query(sql,v){const result=await base.query(sql,v);if(/^BEGIN\b/.test(sql))await setup.query('SET CONSTRAINTS ALL DEFERRED');return result;},async connect(){return pool;}};
  const f=await fns.business(setup,pool),a=fns.success(await assignment.setJobAssignments(fns.command(pool,f,f.native))).assignments[0];
  const input={pool,authenticatedActor:f.owner,businessId:f.profile,idempotencyKey:randomUUID()};
  const p=fns.success(await location.writePolicy({...input,expectedVersion:0,state:'ACTIVE',policy:{radiusMeters:100,maxAccuracyMeters:30,maxSampleAgeSeconds:120,maxFutureSkewSeconds:10}})).policy;
  const s=fns.success(await management.saveAssignmentSite({...input,assignmentId:a.id,employeeMembershipId:f.employee.membership,expectedAssignmentVersion:1,assignmentActivationVersion:1,expectedVersion:0,site:{expectedVersion:0,kind:'MANUAL_BUSINESS',label:'Concurrent business worksite',address:{line1:'123 Shop',city:'Miami',region:'FL',postalCode:'33101',countryCode:'US'},policyId:p.id,policyVersion:1,capture:{latitude:26,longitude:-81,accuracyMeters:8,sampledAt:new Date().toISOString()}}})).site;
  await setup.query('SET CONSTRAINTS ALL IMMEDIATE');await setup.query('COMMIT');
  const command=actor=>({pool:live,authenticatedActor:actor,businessId:f.profile,assignmentId:a.id,employeeMembershipId:f.employee.membership,expectedAssignmentVersion:1,assignmentActivationVersion:1,expectedVersion:1,siteId:s.id,siteVersion:1,state:'REVOKED',idempotencyKey:randomUUID()});
  const requests=[command(f.owner),command(f.manager)];
  const results=await Promise.all(requests.map(management.changeAuthorization));assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
  const winner=results.findIndex(r=>r.ok),replay=fns.success(await management.changeAuthorization(requests[winner]));assert.equal(replay.replayed,true);assert.equal(replay.association.version,2);
  const rows=(await live.query('SELECT version,state FROM business_punch_assignment_site_versions WHERE assignment_id=$1 AND site_id=$2 ORDER BY version',[a.id,s.id])).rows;assert.deepEqual(rows,[{version:1,state:'ACTIVE'},{version:2,state:'REVOKED'}]);
  const commands=(await live.query("SELECT count(*)::int AS n FROM business_punch_location_commands WHERE contractor_profile_id=$1 AND action='ASSOCIATION_WRITE'",[f.profile])).rows[0];assert.equal(commands.n,2);
 }finally{await setup.query('ROLLBACK');await setup.end();await live.end();}
});
