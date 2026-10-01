"use strict";
const {randomUUID}=require('node:crypto');
const {normalizeSnapshot}=require('./punchLocationService');
const fail=(status,code,message)=>({ok:false,status,code,message});
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)?x.toLowerCase():null;
function normalizePunch(input){
 const location=normalizeSnapshot(input.location);
 if(location.ok===false)return location;
 if(location.status!=='CAPTURED')return fail(403,'PUNCH_LOCATION_REQUIRED','Location permission and a current position are needed to punch.');
 const assignmentId=uuid(input.assignmentId),jobId=uuid(input.jobId),activation=input.assignmentActivationVersion;
 if(!assignmentId||!jobId||!Number.isSafeInteger(activation)||activation<=0)return fail(400,'PUNCH_ASSIGNMENT_REQUIRED','Select your current assigned Job to punch.');
 let site=null;
 if([input.siteId,input.siteVersion,input.associationVersion].some(x=>x!=null)){
  if(!uuid(input.siteId)||!Number.isSafeInteger(input.siteVersion)||input.siteVersion<=0||!Number.isSafeInteger(input.associationVersion)||input.associationVersion<=0)return fail(400,'PUNCH_SITE_INVALID','The selected punch location is unavailable.');
  site={id:uuid(input.siteId),version:input.siteVersion,associationVersion:input.associationVersion};
 }
 return {assignmentId,jobId,assignmentActivationVersion:activation,location,site};
}
async function verifyPunch(client,{businessId,actor,assignment,punch,boundary,timeCommandId,requestFingerprint}){
 const candidates=(await client.query(`SELECT s.*,a.version AS association_version,p.radius_meters,
   p.max_accuracy_meters,p.max_sample_age_seconds,p.max_future_skew_seconds,clock_timestamp() AS received_at,
   business_punch_distance_meters($4,$5,s.latitude,s.longitude) AS calculated_distance
   FROM business_punch_assignment_site_versions a
   JOIN business_punch_site_versions s ON s.id=a.site_id AND s.version=a.site_version AND s.contractor_profile_id=a.contractor_profile_id
   JOIN business_punch_policy_versions p ON p.id=s.policy_id AND p.version=s.policy_version AND p.contractor_profile_id=s.contractor_profile_id
   WHERE a.contractor_profile_id=$1 AND a.assignment_id=$2 AND a.membership_id=$3 AND a.state='ACTIVE'
   AND a.assignment_activation_version=$6
   AND a.version=(SELECT max(v.version) FROM business_punch_assignment_site_versions v WHERE v.assignment_id=a.assignment_id AND v.site_id=a.site_id)
   AND business_punch_assignment_is_current($1,a.assignment_id,a.job_id,a.membership_id,a.assignment_activation_version)
   AND business_punch_site_is_current($1,s.id,s.version,a.job_id)
   ORDER BY s.id`,[businessId,assignment.id,actor.id,punch.location.latitude,punch.location.longitude,punch.assignmentActivationVersion])).rows;
 if(punch.site&&!candidates.some(s=>s.id===punch.site.id&&s.version===punch.site.version&&s.association_version===punch.site.associationVersion))return fail(409,'PUNCH_SITE_STALE','This punch location is no longer active.');
 if(!candidates.length)return fail(409,'PUNCH_NO_ACTIVE_SITE','No active punch location is authorized for this assignment.');
 const sampled=new Date(punch.location.sampledAt).getTime();
 const usable=candidates.filter(s=>{const age=(new Date(s.received_at).getTime()-sampled)/1000;return punch.location.accuracyMeters<=s.max_accuracy_meters&&age<=s.max_sample_age_seconds&&age>=-s.max_future_skew_seconds;});
 if(!usable.length)return fail(422,'PUNCH_SAMPLE_UNUSABLE','Your location could not be verified. Obtain a fresh, accurate position and retry.');
 const site=usable.find(s=>Number.isFinite(s.calculated_distance)&&s.calculated_distance<=s.radius_meters);
 if(!site)return fail(403,'PUNCH_OUTSIDE_SITE','You are outside the authorized punch location.');
 const captureId=randomUUID();
 await client.query(`INSERT INTO business_punch_location_commands(id,contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint)
   VALUES($1,$2,$3,'SNAPSHOT',$4,$5)`,[captureId,businessId,actor.id,`time:${timeCommandId}`,requestFingerprint]);
 const row=(await client.query(`INSERT INTO business_punch_location_snapshots
   (id,contractor_profile_id,membership_id,user_id,job_id,assignment_id,assignment_activation_version,site_id,site_version,association_version,
    boundary,capture_status,device_latitude,device_longitude,accuracy_meters,sampled_at,command_id,time_command_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CAPTURED',$12,$13,$14,$15,$16,$17) RETURNING id`,
 [randomUUID(),businessId,actor.id,actor.user_id,assignment.job_id,assignment.id,punch.assignmentActivationVersion,site.id,site.version,site.association_version,boundary,punch.location.latitude,punch.location.longitude,punch.location.accuracyMeters,punch.location.sampledAt,captureId,timeCommandId])).rows[0];
 await client.query('UPDATE business_punch_location_commands SET result_reference=$2,completed_at=CURRENT_TIMESTAMP WHERE id=$1',[captureId,JSON.stringify({snapshotId:row.id})]);
 // The immutable snapshot holds private GPS. Ordinary time projections get only safe status/label.
 return {ok:true,status:'VERIFIED_INSIDE',siteLabel:site.label};
}
module.exports={normalizePunch,verifyPunch};
