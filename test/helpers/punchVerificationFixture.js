"use strict";
const {randomUUID}=require('node:crypto');
const fns=require('./punchLocationFixture');
const assignment=require('../../server/team/jobAssignmentService');
const location=require('../../server/team/punchLocationService');
async function setup(client){
 const base=fns.emergencyFixture.transactionalFacade(client);
 const pool={...base,async query(sql,values){const r=await base.query(sql,values);if(/^BEGIN\b/.test(sql))await client.query('SET CONSTRAINTS ALL DEFERRED');return r;},async connect(){return pool;}};
 const f=await fns.business(client,pool);const input=actor=>({pool,authenticatedActor:actor||f.owner,businessId:f.profile,idempotencyKey:randomUUID()});
 const policy=fns.success(await location.writePolicy({...input(),expectedVersion:0,state:'ACTIVE',policy:{radiusMeters:135,maxAccuracyMeters:35,maxSampleAgeSeconds:120,maxFutureSkewSeconds:10}})).policy;
 const site=fns.success(await location.writeSite({...input(),expectedVersion:0,state:'ACTIVE',kind:'MANUAL_BUSINESS',label:'Warehouse',address:{line1:'456 Warehouse',city:'Cape Coral',region:'FL',postalCode:'33990',countryCode:'US'},latitude:26.64,longitude:-81.98,policyId:policy.id,policyVersion:1})).site;
 const assigned=new Map();
 for(const job of f.jobs){const a=fns.success(await assignment.setJobAssignments(fns.command(pool,f,job))).assignments[0];assigned.set(job,a);fns.success(await location.authorizeAssignmentSite({...input(),assignmentId:a.id,siteId:site.id,siteVersion:1,assignmentActivationVersion:1,expectedVersion:0,state:'ACTIVE'}));}
 return {client,pool,f,input,policy,site,assigned};
}
async function timeCommand(x,actor=x.f.employee,action='CLOCK_IN'){
 return (await x.client.query(`INSERT INTO business_time_commands(contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5) RETURNING id`,[x.f.profile,actor.membership,action,randomUUID(),'c'.repeat(64)])).rows[0].id;
}
async function snapshot(x,timeCommandId,changes={}){
 const c=randomUUID();await x.client.query(`INSERT INTO business_punch_location_commands(id,contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint) VALUES($1,$2,$3,'SNAPSHOT',$4,$5)`,[c,x.f.profile,x.f.employee.membership,randomUUID(),'d'.repeat(64)]);
 const row={id:randomUUID(),contractor_profile_id:x.f.profile,membership_id:x.f.employee.membership,user_id:x.f.employee.id,job_id:x.f.native,assignment_id:x.assigned.get(x.f.native).id,assignment_activation_version:1,site_id:x.site.id,site_version:1,association_version:1,boundary:'CLOCK_IN',capture_status:'CAPTURED',device_latitude:26.64,device_longitude:-81.98,accuracy_meters:8,sampled_at:new Date(),command_id:c,time_command_id:timeCommandId,verification_result:'VERIFIED_INSIDE',distance_meters:999999,verification_algorithm:'CLIENT_FORGED',...changes};
 const keys=Object.keys(row);
 return (await x.client.query(`INSERT INTO business_punch_location_snapshots(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,keys.map(k=>row[k]))).rows[0];
}
async function consume(x,commandId,job=x.f.native){
 const session=(await x.client.query(`INSERT INTO business_time_sessions(contractor_profile_id,membership_id,user_id,category,job_id,assignment_id,assignment_activation_version,clock_in_command_id,clock_in_location_status,clock_in_latitude,clock_in_longitude) VALUES($1,$2,$3,'JOB_WORK',$4,$5,1,$6,'CAPTURED',26.64,-81.98) RETURNING *`,[x.f.profile,x.f.employee.membership,x.f.employee.id,job,x.assigned.get(job).id,commandId])).rows[0];
 await x.client.query(`INSERT INTO business_time_events(session_id,contractor_profile_id,membership_id,actor_user_id,event_type,command_id) VALUES($1,$2,$3,$4,'CLOCKED_IN',$5)`,[session.id,x.f.profile,x.f.employee.membership,x.f.employee.id,commandId]);
 await x.client.query('UPDATE business_time_commands SET result_reference=$2,completed_at=CURRENT_TIMESTAMP WHERE id=$1',[commandId,JSON.stringify({session:{id:session.id}})]);
 return session;
}
async function flush(client){await client.query('SET CONSTRAINTS business_punch_consumed_boundary_guard IMMEDIATE');await client.query('SET CONSTRAINTS business_punch_consumed_boundary_guard DEFERRED');}
module.exports={...fns,setup,timeCommand,snapshot,consume,flush};
