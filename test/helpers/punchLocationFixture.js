"use strict";
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const emergencyFixture=require('./emergencyLifecycleFixture');
const {createVisitLifecycleFixture}=require('./visitLifecycleFixture');
const native=require('../../server/relationships/businessCustomerJobService');
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


module.exports={business,member,nativeJob,rejectsSql,command,rawAssignment,success,emergencyFixture};
