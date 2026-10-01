"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Client } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const emergencyFixture = require("./helpers/emergencyLifecycleFixture");
const { createVisitLifecycleFixture } = require("./helpers/visitLifecycleFixture");
const native = require("../server/relationships/businessCustomerJobService");
const assignment = require("../server/team/jobAssignmentService");
const time = require("../server/team/timeEvidenceService");
const operations = require("../server/team/fieldOperationsService");
const customerCommunication = require("../server/team/fieldCustomerCommunicationService");
const timeOperations = require("../server/team/timeOperationsService");
const { proposeVisit } = require("../server/workflow/visitService");
const { createExternalLifecycleFixture } = require("./helpers/externalLifecycleFixture");
const url = process.env.EMPLOYEE_ASSIGNMENT_DATABASE_URL;
const quiet = { info() {}, warn() {} };
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
async function member(client, f, role, active = true) {
  const user = (await client.query(`INSERT INTO users(username,email,password_hash,role,account_type)
    VALUES($1,$2,'test-only','homeowner','homeowner') RETURNING id`, [role,`${randomUUID()}@example.test`])).rows[0];
  const membership = (await client.query(`INSERT INTO business_team_memberships
    (contractor_profile_id,user_id,role,status,created_by_user_id,deactivated_at)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
  [f.profile,user.id,role,active?'ACTIVE':'DEACTIVATED',f.professional,active?null:new Date()])).rows[0];
  return { id: user.id, membership: membership.id };
}
async function nativeJob(client, pool, f, location = {mode:'STRUCTURED',addressLine1:'456 Assigned Site',city:'Cape Coral',region:'FL',postalCode:'33990',countryCode:'US'}) {
  const contact = (await client.query(`INSERT INTO business_contacts
    (contractor_profile_id,created_by_user_id,party_type,display_name,email,phone,address_text,private_note)
    VALUES($1,$2,'PERSON','Assigned Customer','private-contact@example.test','PRIVATE_PHONE','PRIVATE_CONTACT_ADDRESS','PRIVATE_CONTACT_NOTE') RETURNING id`,[f.profile,f.professional])).rows[0];
  await client.query(`INSERT INTO business_contact_roles(business_contact_id,contractor_profile_id,role,assigned_by_user_id)
    VALUES($1,$2,'CUSTOMER',$3)`,[contact.id,f.profile,f.professional]);
  const relationship = (await client.query(`INSERT INTO business_customer_relationships(contractor_profile_id,business_contact_id,established_by_user_id)
    VALUES($1,$2,$3) RETURNING id`,[f.profile,contact.id,f.professional])).rows[0];
  const result = success(await native.createBusinessCustomerJob({pool,authenticatedActor:{id:f.professional},relationshipId:relationship.id,
    payload:{projectTitle:'Native assigned work',projectDescription:'Operational instruction only',serviceLocation:location},idempotencyKey:randomUUID(),logger:quiet}));
  return result.job.id;
}
async function business(client, pool) {
  const f = await emergencyFixture.fixture(client,pool,{dispatchToArrival:false});
  f.owner = { id:f.professional, membership:(await client.query(`INSERT INTO business_team_memberships
    (contractor_profile_id,user_id,role,created_by_user_id) VALUES($1,$2,'OWNER',$2) RETURNING id`,[f.profile,f.professional])).rows[0].id };
  f.manager = await member(client,f,'MANAGER'); f.employee = await member(client,f,'FIELD_EMPLOYEE');
  f.otherEmployee = await member(client,f,'FIELD_EMPLOYEE'); f.finance = await member(client,f,'BOOKKEEPER_FINANCE');
  f.inactive = await member(client,f,'FIELD_EMPLOYEE',false);
  const ordinary = await createVisitLifecycleFixture(pool,{homeownerId:f.homeowner,professionalId:f.professional},randomUUID());
  f.ordinary = ordinary.jobId; f.native = await nativeJob(client,pool,f); f.emergency = f.job;
  f.jobs = [f.ordinary,f.native,f.emergency];
  await client.query(`UPDATE contractor_profiles SET time_zone='UTC',week_start_day='MONDAY',
    time_settings_updated_at=CURRENT_TIMESTAMP,time_settings_updated_by_membership_id=$2 WHERE id=$1`,[f.profile,f.owner.membership]);
  return f;
}
async function rejectsSql(client, action, pattern) {
  await client.query('SAVEPOINT expected_denial');
  try { await assert.rejects(action,pattern); }
  finally { await client.query('ROLLBACK TO SAVEPOINT expected_denial'); await client.query('RELEASE SAVEPOINT expected_denial'); }
}
function command(pool,f,job,actor=f.owner,targets=[f.employee.membership]) {
  return {pool,authenticatedActor:actor,businessId:f.profile,jobId:job,membershipIds:targets,idempotencyKey:randomUUID()};
}
async function rawAssignment(client,f,job,target=f.employee.membership) {
  const c = (await client.query(`INSERT INTO business_job_assignment_commands
    (contractor_profile_id,job_id,actor_membership_id,idempotency_key,request_fingerprint)
    VALUES($1,$2,$3,$4,$5) RETURNING id`,[f.profile,job,f.owner.membership,randomUUID(),'a'.repeat(64)])).rows[0];
  return client.query(`INSERT INTO business_job_assignments
    (contractor_profile_id,job_id,membership_id,assigned_by_membership_id,initial_command_id)
    VALUES($1,$2,$3,$4,$5)`,[f.profile,job,target,f.owner.membership,c.id]);
}

test('PostgreSQL certifies ordinary/native/Emergency employee assignment source authority', {skip:!url}, async t => {
  assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
  const client = new Client({connectionString:url}); await client.connect();
  try {
    await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL DEFERRED');
    const basePool = emergencyFixture.transactionalFacade(client);
    const pool = { ...basePool, async query(sql, values) {
      const result = await basePool.query(sql, values);
      // Existing canonical fixture services switch deferred constraints to IMMEDIATE.
      // Restore their normal transaction-entry deferral when mapping BEGIN to savepoints.
      if (/^BEGIN\b/.test(sql)) await client.query('SET CONSTRAINTS ALL DEFERRED');
      return result;
    }, async connect() { return pool; } };
    const a = await business(client,pool); const b = await business(client,pool);
    const assignments = new Map();
    for (const [i,job] of a.jobs.entries()) {
      await t.test(`Owner and Manager assign ${['ordinary','native','Emergency'][i]} source`,async()=>{
        const created=success(await assignment.setJobAssignments(command(pool,a,job)));
        assert.equal(created.assignments[0].membershipId,a.employee.membership);
        const managed=success(await assignment.setJobAssignments(command(pool,a,job,a.manager,[a.employee.membership,a.manager.membership])));
        assignments.set(job,managed.assignments.find(x=>x.membershipId===a.employee.membership));
        assert.equal((await client.query('SELECT count(*)::int AS n FROM business_job_assignment_events WHERE assignment_id=$1',[assignments.get(job).id])).rows[0].n,2);
      });
      await t.test(`cross-business ${['ordinary','native','Emergency'][i]} denied by service and DB`,async()=>{
        assert.equal((await assignment.setJobAssignments(command(pool,b,job))).status,404);
        await rejectsSql(client,()=>rawAssignment(client,b,job),/Job source does not belong/);
      });
    }
    await t.test('employee/finance cannot manage; wrong-business, inactive and finance targets denied',async()=>{
      for(const actor of [a.employee,a.finance]) assert.equal((await assignment.setJobAssignments(command(pool,a,a.native,actor))).status,403);
      for(const target of [b.employee.membership,a.inactive.membership,a.finance.membership]) {
        assert.equal((await assignment.setJobAssignments(command(pool,a,a.native,a.owner,[target]))).code,'JOB_ASSIGNMENT_TARGET_INVALID');
        await rejectsSql(client,()=>rawAssignment(client,a,a.native,target),/assignment|active field-authorized|exact business/i);
      }
    });
    await t.test('employee-safe source projections and no unrelated customer/contact data',async()=>{
      const unassigned = await nativeJob(client,pool,a);
      const own=success(await assignment.listEmployeeJobs({pool,authenticatedActor:a.employee,businessId:a.profile}));
      assert.deepEqual(new Set(own.jobs.map(x=>x.id)),new Set(a.jobs));
      assert.deepEqual(new Set(own.jobs.map(x=>x.sourceType)),new Set(['ordinary_request_selection','business_customer','emergency_request']));
      for(const job of own.jobs) assert.ok(job.assignments.every(x=>x.membershipId===a.employee.membership));
      assert.equal(own.jobs.find(x=>x.id===a.ordinary).location.address,null);
      assert.equal(own.jobs.find(x=>x.id===a.native).location.address.line1,'456 Assigned Site');
      assert.equal(own.jobs.find(x=>x.id===a.native).source.version,1);
      assert.equal(own.jobs.find(x=>x.id===a.emergency).location.serviceArea,'Test location');
      assert.doesNotMatch(JSON.stringify(own),/PRIVATE_|private-contact@example.test/);
      assert.deepEqual(success(await assignment.listEmployeeJobs({pool,authenticatedActor:a.otherEmployee,businessId:a.profile})).jobs,[]);
      assert.equal((await assignment.listEmployeeJobs({pool,authenticatedActor:b.employee,businessId:a.profile})).status,403);
      const denied=await operations.listFieldOperations({pool,authenticatedActor:a.employee,businessId:a.profile,jobId:unassigned,assignmentId:randomUUID()});
      assert.equal(denied.ok,false);
    });
    await t.test('ordinary normalized exact address and canonical native source version remain reference-derived',async()=>{
      await client.query('SAVEPOINT location_reference');
      try {
        await client.query("UPDATE posts SET location_intake_mode='exact_on_file',service_address_line1='123 Assigned Ordinary Site' WHERE id=(SELECT job_request_id FROM jobs WHERE id=$1)",[a.ordinary]);
        await client.query("UPDATE business_customer_job_sources SET project_title='Updated canonical source',version=version+1 WHERE id=(SELECT source_business_customer_job_id FROM jobs WHERE id=$1)",[a.native]);
        const own=success(await assignment.listEmployeeJobs({pool,authenticatedActor:a.employee,businessId:a.profile})).jobs;
        assert.equal(own.find(x=>x.id===a.ordinary).location.address.line1,'123 Assigned Ordinary Site');
        assert.equal(own.find(x=>x.id===a.native).source.version,2);
        assert.equal(own.find(x=>x.id===a.native).title,'Updated canonical source');
        for(const job of own) assert.deepEqual(Object.keys(job.customer),['displayName']);
      } finally { await client.query('ROLLBACK TO SAVEPOINT location_reference'); await client.query('RELEASE SAVEPOINT location_reference'); }
    });
    await t.test('database rejects another employee assignment at the time boundary',async()=>{
      await rejectsSql(client,async()=>{
        const c=(await client.query(`INSERT INTO business_time_commands(contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint)
          VALUES($1,$2,'CLOCK_IN',$3,$4) RETURNING id`,[a.profile,a.otherEmployee.membership,randomUUID(),'c'.repeat(64)])).rows[0];
        await client.query(`INSERT INTO business_time_sessions(contractor_profile_id,membership_id,user_id,category,job_id,assignment_id,assignment_activation_version,clock_in_command_id)
          VALUES($1,$2,$3,'JOB_WORK',$4,$5,1,$6)`,[a.profile,a.otherEmployee.membership,a.otherEmployee.id,a.native,assignments.get(a.native).id,c.id]);
      },/exact active assignment|foreign key/);
    });
    const punchLocations=require('../server/team/punchLocationService');
    const managed={pool,authenticatedActor:a.owner,businessId:a.profile};
    const policy=success(await punchLocations.writePolicy({...managed,expectedVersion:0,state:'ACTIVE',policy:{radiusMeters:135,maxAccuracyMeters:35,maxSampleAgeSeconds:120,maxFutureSkewSeconds:10},idempotencyKey:randomUUID()})).policy;
    const site=success(await punchLocations.writeSite({...managed,expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'Assigned worksite',address:{line1:'123 Worksite',city:'Cape Coral',region:'FL',postalCode:'33990',countryCode:'US'},latitude:26.64,longitude:-81.98,policyId:policy.id,policyVersion:1,idempotencyKey:randomUUID()})).site;
    for(const job of a.jobs)success(await punchLocations.authorizeAssignmentSite({...managed,assignmentId:assignments.get(job).id,siteId:site.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE',idempotencyKey:randomUUID()}));
    const gps=()=>({status:'CAPTURED',latitude:26.64,longitude:-81.98,accuracyMeters:8,sampledAt:new Date().toISOString()});
    for(const job of a.jobs) await t.test(`exact JOB_WORK, timers, field operations and no new customer messaging: ${job}`,async()=>{
      const assigned=assignments.get(job);
      const input={pool,authenticatedActor:a.employee,businessId:a.profile,category:'JOB_WORK',jobId:job,assignmentId:assigned.id,assignmentActivationVersion:1,location:gps(),idempotencyKey:randomUUID()};
      const wrong=await time.clockIn({...input,authenticatedActor:a.otherEmployee}); assert.equal(wrong.code,'TIME_JOB_ASSIGNMENT_REQUIRED');
      assert.equal((await time.clockIn({...input,businessId:b.profile})).status,403);
      const started=success(await time.clockIn(input));
      assert.equal(started.session.assignmentActivationVersion,1); assert.equal(started.session.clockInLocation.status,'CAPTURED');
      assert.equal(success(await time.clockIn(input)).replayed,true);
      assert.equal((await time.clockIn({...input,idempotencyKey:randomUUID()})).code,'TIME_TIMER_ALREADY_ACTIVE');
      const fieldInput={pool,authenticatedActor:a.employee,businessId:a.profile,jobId:job,assignmentId:assigned.id};
      assert.equal(success(await operations.listFieldOperations(fieldInput)).operations.assignmentId,assigned.id);
      assert.equal((await operations.listFieldOperations({...fieldInput,authenticatedActor:a.otherEmployee})).status,403);
      const moved=success(await operations.transitionFieldStatus({...fieldInput,toStatus:'ON_MY_WAY',idempotencyKey:randomUUID()}));
      assert.equal(moved.operations.currentStatus,'ON_MY_WAY');
      success(await operations.sendFieldMessage({...fieldInput,message:'Private team message',idempotencyKey:randomUUID()}));
      if(job!==a.ordinary) assert.equal((await customerCommunication.getFieldCustomerConversation(fieldInput)).ok,false);
      const closed=success(await time.clockOut({...input,location:gps(),sessionId:started.session.id,idempotencyKey:randomUUID()}));
      assert.ok(closed.session.clockedOutAt); assert.ok(new Date(closed.session.clockedOutAt)>=new Date(started.session.clockedInAt));
    });
    await t.test('history titles and Timesheets support all sources without source reclassification',async()=>{
      const mine=success(await time.listOwnTime({pool,authenticatedActor:a.employee,businessId:a.profile}));
      assert.ok(mine.sessions.every(x=>x.jobTitle));
      const sheet=success(await timeOperations.getTimesheets({pool,authenticatedActor:a.owner,businessId:a.profile,range:'TODAY'}));
      assert.equal(sheet.sessions.length,3); assert.ok(sheet.sessions.every(x=>x.jobTitle));
      success(await timeOperations.getTeamToday({pool,authenticatedActor:a.owner,businessId:a.profile}));
    });
    await t.test('no canonical Visit means no fabricated schedule',async()=>{
      assert.deepEqual(success(await assignment.listEmployeeSchedule({pool,authenticatedActor:a.employee,businessId:a.profile})).schedule,[]);
    });
    await t.test('eligible canonical evaluation visits populate only exact assigned Schedule',async()=>{
      for(const jobId of [a.ordinary,a.native]) {
        const visit=success(await proposeVisit({pool,authenticatedActor:{id:a.professional},jobId,purpose:'EVALUATION',
          scheduledStartAt:'2026-12-10T13:00:00.000Z',scheduledEndAt:'2026-12-10T14:00:00.000Z',
          timeZone:'UTC',locationMode:jobId===a.native?'REMOTE':'JOB_SERVICE_LOCATION',idempotencyKey:randomUUID(),logger:quiet})).visit;
        assert.equal(visit.jobId,jobId);
      }
      const own=success(await assignment.listEmployeeSchedule({pool,authenticatedActor:a.employee,businessId:a.profile})).schedule;
      assert.deepEqual(new Set(own.map(x=>x.jobId)),new Set([a.ordinary,a.native]));
      assert.ok(own.every(x=>x.state==='PROPOSED' && x.sourceType));
      assert.equal(own.find(x=>x.jobId===a.native).location.address,null);
      assert.equal(own.find(x=>x.jobId===a.native).location.serviceArea,null);
      assert.equal(own.find(x=>x.jobId===a.native).location.remote,true);
      assert.deepEqual(success(await assignment.listEmployeeSchedule({pool,authenticatedActor:a.otherEmployee,businessId:a.profile})).schedule,[]);
      assert.equal((await assignment.listEmployeeSchedule({pool,authenticatedActor:b.employee,businessId:a.profile})).status,403);
    });
    await t.test('native text/unspecified location remains assignment eligible without coordinates',async()=>{
      for(const location of [{mode:'TEXT',text:'Assigned operational text'},{mode:'UNSPECIFIED'}]) {
        const job=await nativeJob(client,pool,a,location);
        success(await assignment.setJobAssignments(command(pool,a,job)));
        const projected=success(await assignment.listEmployeeJobs({pool,authenticatedActor:a.employee,businessId:a.profile})).jobs.find(x=>x.id===job);
        assert.equal(projected.location.address,null);
        assert.equal(projected.location.serviceArea,location.text||null);
      }
    });
    await t.test('closed source authority fails current lookup and commands while historical time remains readable',async()=>{
      for(const job of [a.ordinary,a.native,a.emergency]) {
        await client.query('SAVEPOINT revoked_source');
        try {
          if(job===a.native) await client.query("UPDATE business_contacts SET status='ARCHIVED',version=version+1 WHERE id=(SELECT business_contact_id FROM jobs WHERE id=$1)",[job]);
          else await client.query("UPDATE request_relationships SET status='closed',closure_reason=CASE WHEN post_id IS NOT NULL THEN 'request_cancelled' ELSE NULL END WHERE id=(SELECT source_request_relationship_id FROM jobs WHERE id=$1)",[job]);
          assert.equal((await assignment.setJobAssignments(command(pool,a,job))).status,404);
          const fieldInput={pool,authenticatedActor:a.employee,businessId:a.profile,jobId:job,assignmentId:assignments.get(job).id};
          assert.equal((await operations.listFieldOperations(fieldInput)).ok,false);
          assert.equal((await time.clockIn({...fieldInput,category:'JOB_WORK',assignmentActivationVersion:1,location:gps(),idempotencyKey:randomUUID()})).code,'TIME_JOB_ASSIGNMENT_REQUIRED');
          assert.ok(!success(await assignment.listEmployeeJobs({pool,authenticatedActor:a.employee,businessId:a.profile})).jobs.some(x=>x.id===job));
          assert.ok(success(await time.listOwnTime({pool,authenticatedActor:a.employee,businessId:a.profile})).sessions.some(x=>x.jobId===job));
          await rejectsSql(client,()=>rawAssignment(client,a,job,a.otherEmployee.membership),/Job source does not belong/);
        } finally { await client.query('ROLLBACK TO SAVEPOINT revoked_source'); await client.query('RELEASE SAVEPOINT revoked_source'); }
      }
    });
    await t.test('unassignment/reactivation preserves identity/history and rejects old activation',async()=>{
      const old=assignments.get(a.native);
      success(await assignment.setJobAssignments(command(pool,a,a.native,a.owner,[])));
      assert.equal((await time.clockIn({pool,authenticatedActor:a.employee,businessId:a.profile,category:'JOB_WORK',jobId:a.native,assignmentId:old.id,assignmentActivationVersion:1,location:gps(),idempotencyKey:randomUUID()})).code,'TIME_JOB_ASSIGNMENT_REQUIRED');
      const next=success(await assignment.setJobAssignments(command(pool,a,a.native))).assignments.find(x=>x.membershipId===a.employee.membership);
      assert.equal(next.id,old.id); assert.equal(next.version,4);
      assert.deepEqual((await client.query('SELECT event_type FROM business_job_assignment_events WHERE assignment_id=$1 ORDER BY assignment_version',[old.id])).rows.map(x=>x.event_type),['ASSIGNED','CHANGED','UNASSIGNED','REASSIGNED']);
      await rejectsSql(client,async()=>{
        const c=(await client.query(`INSERT INTO business_time_commands(contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint)
          VALUES($1,$2,'CLOCK_IN',$3,$4) RETURNING id`,[a.profile,a.employee.membership,randomUUID(),'b'.repeat(64)])).rows[0];
        await client.query(`INSERT INTO business_time_sessions(contractor_profile_id,membership_id,user_id,category,job_id,assignment_id,assignment_activation_version,clock_in_command_id)
          VALUES($1,$2,$3,'JOB_WORK',$4,$5,1,$6)`,[a.profile,a.employee.membership,a.employee.id,a.native,old.id,c.id]);
      },/activation identity is stale/);
    });
    await t.test('unknown and ambiguous canonical source identities fail at database invariants',async()=>{
      await rejectsSql(client,()=>client.query(`INSERT INTO jobs(id,created_by_user_id,source_type,lifecycle_contract_version) VALUES($1,$2,'unknown',2)`,[randomUUID(),a.professional]),/source|constraint|Job/i);
      await rejectsSql(client,()=>client.query(`UPDATE jobs SET source_emergency_request_id=$2 WHERE id=$1`,[a.native,a.request]),/source|immutable|mutated|constraint|Job/i);
      assert.equal((await client.query('SELECT * FROM business_employee_job_sources($1,$2)',[b.profile,a.native])).rowCount,0);
    });
    await t.test('schema-recognized business-document source is not silently granted employee assignment authority',async()=>{
      const doc=await createExternalLifecycleFixture(pool,'DOCUMENT_ONLY');
      const f={profile:doc.contractorProfileId,professional:doc.userId};
      f.owner={id:doc.userId,membership:(await client.query(`INSERT INTO business_team_memberships
        (contractor_profile_id,user_id,role,created_by_user_id) VALUES($1,$2,'OWNER',$2) RETURNING id`,[f.profile,f.professional])).rows[0].id};
      f.employee=await member(client,f,'FIELD_EMPLOYEE');
      assert.equal((await assignment.setJobAssignments(command(pool,f,doc.jobId))).status,404);
      await rejectsSql(client,()=>rawAssignment(client,f,doc.jobId),/Job source does not belong/);
    });
    await t.test('non-JOB categories, governed GPS, immutable session/events and replay remain intact',async()=>{
      for(const category of ['DRIVING','OFFICE','SUPPLIES','BREAK','GENERAL']) {
        const start=success(await time.clockIn({pool,authenticatedActor:a.employee,businessId:a.profile,category,jobId:a.ordinary,assignmentId:assignments.get(a.ordinary).id,assignmentActivationVersion:1,location:gps(),idempotencyKey:randomUUID()}));
        assert.equal(start.session.jobId,null); assert.equal(start.session.clockInLocation.status,'CAPTURED');
        const out={pool,authenticatedActor:a.employee,businessId:a.profile,sessionId:start.session.id,jobId:a.ordinary,assignmentId:assignments.get(a.ordinary).id,assignmentActivationVersion:1,location:gps(),idempotencyKey:randomUUID()};
        success(await time.clockOut(out)); assert.equal(success(await time.clockOut(out)).replayed,true);
        await rejectsSql(client,()=>client.query('UPDATE business_time_sessions SET category=\'GENERAL\' WHERE id=$1',[start.session.id]),/immutable/);
        await rejectsSql(client,()=>client.query('DELETE FROM business_time_events WHERE session_id=$1',[start.session.id]),/durable/);
      }
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally { await client.query('ROLLBACK'); await client.end(); }
});
