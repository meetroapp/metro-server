"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { permissionForRole } = require("./teamService");
async function withTransaction(pool, action, {readOnly=false}={}) {
  const client=typeof pool.connect==='function'?await pool.connect():pool;
  try {
    await client.query(readOnly?'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    const result=await action(client);
    await client.query(result?.ok===false?'ROLLBACK':'COMMIT');
    return result;
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {if(client!==pool&&typeof client.release==='function')client.release();}
}
const fail = (status, code, message) => ({ ok: false, status, code, message });
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x) ? x.toLowerCase() : null;
const positive = x => typeof x === 'number' && Number.isSafeInteger(x) && x > 0 && x <= 2147483647;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const coord = (x, limit) => finite(x) && Math.abs(x) <= limit;
const text = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(x) ? x.trim() : null;
const exactKeys = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).every(k => keys.includes(k));
function normalizeAddress(x) {
  if (!exactKeys(x, ['line1','city','region','postalCode','countryCode'])) return null;
  const value = { line1:text(x.line1,500),city:text(x.city,120),region:text(x.region,120),postalCode:text(x.postalCode,32),countryCode:text(x.countryCode,2) };
  return Object.values(value).every(Boolean) && /^[A-Z]{2}$/.test(value.countryCode) ? value : null;
}
function normalizeSnapshot(x) {
  if (!exactKeys(x,['status','latitude','longitude','accuracyMeters','sampledAt'])) return fail(400,'PUNCH_POSITION_MALFORMED','Only a device snapshot may be submitted.');
  if (!['CAPTURED','MISSING','DENIED','UNAVAILABLE'].includes(x.status)) return fail(400,'PUNCH_POSITION_STATUS_INVALID','An explicit capture status is required.');
  if (x.status !== 'CAPTURED') {
    if (['latitude','longitude','accuracyMeters','sampledAt'].some(k => x[k] != null)) return fail(400,'PUNCH_POSITION_MALFORMED','A non-captured snapshot cannot contain position data.');
    return { status:x.status,latitude:null,longitude:null,accuracyMeters:null,sampledAt:null };
  }
  if (x.latitude == null || x.longitude == null) return fail(400,'PUNCH_COORDINATES_MISSING','Both coordinates are required.');
  if (!finite(x.latitude) || !finite(x.longitude)) return fail(400,'PUNCH_COORDINATES_MALFORMED','Coordinates must be finite JSON numbers.');
  if (!coord(x.latitude,90) || !coord(x.longitude,180)) return fail(400,'PUNCH_COORDINATES_OUT_OF_RANGE','Coordinates are out of range.');
  if (!finite(x.accuracyMeters) || x.accuracyMeters <= 0) return fail(400,'PUNCH_ACCURACY_INVALID','Positive finite accuracy is required.');
  if (typeof x.sampledAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(x.sampledAt)) return fail(400,'PUNCH_SAMPLE_TIME_INVALID','A UTC sample timestamp is required.');
  const date = new Date(x.sampledAt);
  const canonical = x.sampledAt.replace(/(\.\d+)?Z$/, (_, fraction) => (fraction || '.000').padEnd(4,'0')+'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) return fail(400,'PUNCH_SAMPLE_TIME_INVALID','The sample timestamp is malformed.');
  return { status:x.status,latitude:x.latitude,longitude:x.longitude,accuracyMeters:x.accuracyMeters,sampledAt:date.toISOString() };
}
async function actor(client,userId,businessId,lock=false) {
  return (await client.query(`SELECT * FROM business_team_memberships WHERE user_id=$1 AND contractor_profile_id=$2 AND status='ACTIVE' ${lock?'FOR UPDATE':''}`, [userId,businessId])).rows[0];
}
function identity(input) {
  const userId=Number(input.authenticatedActor?.id), businessId=Number(input.businessId);
  if (!input.pool || !Number.isSafeInteger(userId) || userId<=0) return fail(401,'AUTHENTICATION_REQUIRED','Authentication required.');
  if (!Number.isSafeInteger(businessId) || businessId<=0) return fail(400,'PUNCH_BUSINESS_INVALID','Exact business identity is required.');
  return {userId,businessId};
}
async function command(input, permission, action, payload, apply) {
  const ids=identity(input); if(ids.ok===false)return ids;
  const key=text(input.idempotencyKey,200); if(!key)return fail(400,'PUNCH_IDEMPOTENCY_REQUIRED','An exact idempotency key is required.');
  const fingerprint=createHash('sha256').update(JSON.stringify({businessId:ids.businessId,action,payload})).digest('hex');
  try {
    // A management workflow may compose the existing commands in one server-owned transaction.
    const transact=input._transactionClient?async action=>action(input._transactionClient):async action=>withTransaction(input.pool,action);
    return await transact(async client=>{
      const member=await actor(client,ids.userId,ids.businessId,true);
      if(!member || !permissionForRole(member.role,permission))return fail(403,'PUNCH_PERMISSION_REQUIRED','Active membership with the required permission is needed.');
      const prior=(await client.query('SELECT * FROM business_punch_location_commands WHERE actor_membership_id=$1 AND idempotency_key=$2 FOR UPDATE',[member.id,key])).rows[0];
      if(prior){
        if(prior.request_fingerprint!==fingerprint)return fail(409,'PUNCH_IDEMPOTENCY_CONFLICT','The key is bound to a different request.');
        if(!prior.completed_at)return fail(409,'PUNCH_COMMAND_IN_PROGRESS','The command is still in progress.');
        return {ok:true,status:200,...prior.result_reference,replayed:true};
      }
      const commandId=randomUUID();
      await client.query(`INSERT INTO business_punch_location_commands(id,contractor_profile_id,actor_membership_id,action,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6)`,[commandId,ids.businessId,member.id,action,key,fingerprint]);
      const result=await apply(client,ids,member,commandId); if(result.ok===false)return result;
      await client.query('UPDATE business_punch_location_commands SET result_reference=$2,completed_at=CURRENT_TIMESTAMP WHERE id=$1',[commandId,JSON.stringify(result)]);
      return {ok:true,status:200,...result};
    });
  } catch(error) {
    if(['P0001','23503','23505','23514'].includes(error.code))return fail(409,'PUNCH_AUTHORITY_CONFLICT','Current site, source, policy and assignment versions are required.');
    throw error;
  }
}
function versionRequest(input) {
  return (input.id == null || uuid(input.id)) && Number.isSafeInteger(input.expectedVersion) && input.expectedVersion>=0 && ['ACTIVE','REVOKED'].includes(input.state);
}
async function writePolicy(input) {
  const p=input.policy;
  if(!versionRequest(input) || !exactKeys(p,['radiusMeters','maxAccuracyMeters','maxSampleAgeSeconds','maxFutureSkewSeconds']) ||
    !finite(p.radiusMeters)||p.radiusMeters<=0||!finite(p.maxAccuracyMeters)||p.maxAccuracyMeters<=0||!positive(p.maxSampleAgeSeconds)||
    !Number.isSafeInteger(p.maxFutureSkewSeconds)||p.maxFutureSkewSeconds<0||p.maxFutureSkewSeconds>2147483647)return fail(400,'PUNCH_POLICY_INVALID','Explicit radius, accuracy and sample-time policy values are required.');
  const payload={id:input.id?uuid(input.id):null,expectedVersion:input.expectedVersion,state:input.state,policy:{radiusMeters:p.radiusMeters,maxAccuracyMeters:p.maxAccuracyMeters,maxSampleAgeSeconds:p.maxSampleAgeSeconds,maxFutureSkewSeconds:p.maxFutureSkewSeconds}};
  return command(input,'TIME_SETTINGS_MANAGE','POLICY_WRITE',payload,async(client,ids,member,c)=>{
    const id=payload.id||randomUUID();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
    const prior=(await client.query('SELECT * FROM business_punch_policy_versions WHERE id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
    if((prior?.version||0)!==payload.expectedVersion || (prior && prior.contractor_profile_id!==ids.businessId))return fail(409,'PUNCH_POLICY_STALE','The policy version is stale.');
    const row=(await client.query(`INSERT INTO business_punch_policy_versions(id,version,contractor_profile_id,state,radius_meters,max_accuracy_meters,max_sample_age_seconds,max_future_skew_seconds,actor_membership_id,command_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[id,payload.expectedVersion+1,ids.businessId,payload.state,p.radiusMeters,p.maxAccuracyMeters,p.maxSampleAgeSeconds,p.maxFutureSkewSeconds,member.id,c])).rows[0];
    return {policy:projectPolicy(row)};
  });
}
function projectPolicy(p) {return {id:p.id,version:p.version,state:p.state,radiusMeters:p.radius_meters,maxAccuracyMeters:p.max_accuracy_meters,maxSampleAgeSeconds:p.max_sample_age_seconds,maxFutureSkewSeconds:p.max_future_skew_seconds};}
function projectSite(row,reference=null){return {id:row.id,version:row.version,state:row.state,kind:row.kind,label:row.label,jobId:row.job_id,
  source:row.source_type?{type:row.source_type,id:row.source_id,version:row.source_version,revision:row.source_revision}:null,
  address:row.kind==='MANUAL_BUSINESS'?normalizeAddress(row.manual_address):(reference?.source_revision===row.source_revision?reference.address:null)||null,
  geometry:{latitude:row.latitude,longitude:row.longitude,resolutionMethod:row.resolution_method},policyId:row.policy_id,policyVersion:row.policy_version};}
async function writeSite(input){
  const revoking=input.state==='REVOKED';
  let geometryCapture=null;
  if(input.geometryCapture!=null){
    if(!exactKeys(input.geometryCapture,['source','snapshot']) || input.geometryCapture.source!=='FOREGROUND_DEVICE')return fail(400,'PUNCH_SITE_CAPTURE_INVALID','A foreground position capture is required.');
    const snapshot=normalizeSnapshot(input.geometryCapture.snapshot);
    if(snapshot.ok===false)return snapshot;
    if(snapshot.status!=='CAPTURED'||snapshot.latitude!==input.latitude||snapshot.longitude!==input.longitude||revoking)return fail(400,'PUNCH_SITE_CAPTURE_INVALID','Site geometry must match its captured position.');
    geometryCapture={source:'FOREGROUND_DEVICE',...snapshot};
  }
  if(!versionRequest(input) || (revoking && (!input.id || input.expectedVersion===0 || ['kind','label','jobId','address','latitude','longitude','policyId','policyVersion'].some(k=>input[k]!=null))) ||
    (!revoking && (!['CUSTOMER_JOB','MANUAL_BUSINESS'].includes(input.kind)||!text(input.label,200)||!coord(input.latitude,90)||!coord(input.longitude,180)||!uuid(input.policyId)||!positive(input.policyVersion)||
      (input.kind==='CUSTOMER_JOB' && (!uuid(input.jobId)||input.address!=null)) ||
      (input.kind==='MANUAL_BUSINESS' && (input.jobId!=null||!normalizeAddress(input.address))))) ||
    ['sourceId','sourceVersion','sourceRevision','resolutionMethod','radiusMeters'].some(k=>input[k]!=null))return fail(400,'PUNCH_SITE_INVALID','A canonical reference or structured business site and finite geometry are required.');
  const payload={id:input.id?uuid(input.id):null,expectedVersion:input.expectedVersion,state:input.state,...(!revoking?{kind:input.kind,label:text(input.label,200),jobId:input.jobId?uuid(input.jobId):null,
    latitude:input.latitude,longitude:input.longitude,policyId:uuid(input.policyId),policyVersion:input.policyVersion,address:input.kind==='MANUAL_BUSINESS'?normalizeAddress(input.address):null}:{}),
    ...(geometryCapture?{geometryCapture}:{}),...(input._managementRequest?{managementRequest:input._managementRequest}:{})};
  return command(input,'JOB_ASSIGNMENT_MANAGE','SITE_WRITE',payload,async(client,ids,member,c)=>{
    const id=payload.id||randomUUID();await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
    const prior=(await client.query('SELECT * FROM business_punch_site_versions WHERE id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
    if((prior?.version||0)!==payload.expectedVersion || (prior && prior.contractor_profile_id!==ids.businessId))return fail(409,'PUNCH_SITE_STALE','The site version is stale.');
    if(geometryCapture){
      const p=(await client.query('SELECT *,clock_timestamp() AS received_at FROM business_punch_policy_versions WHERE id=$1 AND version=$2 AND contractor_profile_id=$3',[payload.policyId,payload.policyVersion,ids.businessId])).rows[0];
      if(!p)return fail(409,'PUNCH_POLICY_STALE','The location policy is unavailable.');
      const age=(new Date(p.received_at).getTime()-new Date(geometryCapture.sampledAt).getTime())/1000;
      if(geometryCapture.accuracyMeters>p.max_accuracy_meters || age>p.max_sample_age_seconds || age< -p.max_future_skew_seconds)return fail(409,'PUNCH_SITE_CAPTURE_REVIEW','Capture a fresh position within the selected policy accuracy and time limits.');
    }
    let reference=null;
    const values=revoking?{kind:prior.kind,label:prior.label,jobId:prior.job_id,latitude:prior.latitude,longitude:prior.longitude,policyId:prior.policy_id,policyVersion:prior.policy_version,address:prior.manual_address}:payload;
    if(values.kind==='CUSTOMER_JOB'){
      reference=revoking?{source_type:prior.source_type,source_id:prior.source_id,source_version:prior.source_version,source_revision:prior.source_revision}:
        (await client.query('SELECT * FROM business_punch_customer_location($1,$2)',[ids.businessId,values.jobId])).rows[0];
      if(!reference)return fail(409,'PUNCH_CUSTOMER_LOCATION_UNAVAILABLE','An authorized canonical customer location is required.');
      if(input._expectedCustomerRevision!=null && reference.source_revision!==input._expectedCustomerRevision)return fail(409,'PUNCH_CUSTOMER_LOCATION_STALE','The customer location changed. Review its current reference and capture again.');
    }
    const row=(await client.query(`INSERT INTO business_punch_site_versions(id,version,contractor_profile_id,state,kind,label,job_id,source_type,source_id,source_version,source_revision,manual_address,latitude,longitude,policy_id,policy_version,actor_membership_id,command_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,[id,payload.expectedVersion+1,ids.businessId,payload.state,values.kind,values.label,values.jobId,
      reference?.source_type||null,reference?.source_id||null,reference?.source_version??null,reference?.source_revision||null,values.address?JSON.stringify(values.address):null,
      values.latitude,values.longitude,values.policyId,values.policyVersion,member.id,c])).rows[0];
    return {site:{...projectSite(row,reference),...(geometryCapture?{geometryCapture}: {})}};
  });
}
async function loadAssignment(client,ids,assignmentId){
  return (await client.query(`SELECT a.*,activation.version AS activation_version FROM business_job_assignments a
    JOIN LATERAL (SELECT max(assignment_version) AS version FROM business_job_assignment_events WHERE assignment_id=a.id AND event_type IN ('ASSIGNED','REASSIGNED')) activation ON TRUE
    WHERE a.id=$1 AND a.contractor_profile_id=$2 FOR UPDATE OF a`,[assignmentId,ids.businessId])).rows[0];
}
async function authorizeAssignmentSite(input){
  if(!uuid(input.assignmentId)||!uuid(input.siteId)||!positive(input.siteVersion)||!positive(input.assignmentActivationVersion)||
    !Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!['ACTIVE','REVOKED'].includes(input.state))return fail(400,'PUNCH_ASSOCIATION_INVALID','Exact assignment, site and association versions are required.');
  const payload={assignmentId:uuid(input.assignmentId),siteId:uuid(input.siteId),siteVersion:input.siteVersion,assignmentActivationVersion:input.assignmentActivationVersion,expectedVersion:input.expectedVersion,state:input.state,
    ...(input._managementRequest?{managementRequest:input._managementRequest}:{})};
  return command(input,'JOB_ASSIGNMENT_MANAGE','ASSOCIATION_WRITE',payload,async(client,ids,member,c)=>{
    const a=await loadAssignment(client,ids,payload.assignmentId);if(!a)return fail(404,'PUNCH_ASSIGNMENT_NOT_FOUND','Assignment unavailable.');
    const prior=(await client.query('SELECT version FROM business_punch_assignment_site_versions WHERE assignment_id=$1 AND site_id=$2 ORDER BY version DESC LIMIT 1',[a.id,payload.siteId])).rows[0];
    if((prior?.version||0)!==payload.expectedVersion)return fail(409,'PUNCH_ASSOCIATION_STALE','The association version is stale.');
    const row=(await client.query(`INSERT INTO business_punch_assignment_site_versions(assignment_id,site_id,version,contractor_profile_id,job_id,membership_id,assignment_activation_version,site_version,state,actor_membership_id,command_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[a.id,payload.siteId,payload.expectedVersion+1,ids.businessId,a.job_id,a.membership_id,payload.assignmentActivationVersion,payload.siteVersion,payload.state,member.id,c])).rows[0];
    return {association:{assignmentId:row.assignment_id,siteId:row.site_id,version:row.version,state:row.state,siteVersion:row.site_version,assignmentActivationVersion:row.assignment_activation_version}};
  });
}
async function listSites(input){
  const ids=identity(input);if(ids.ok===false)return ids;
  if(input.assignmentId!=null&&!uuid(input.assignmentId))return fail(400,'PUNCH_ASSIGNMENT_INVALID','Exact assignment identity is required.');
  return withTransaction(input.pool,async client=>{
    const m=await actor(client,ids.userId,ids.businessId);
    const managed=input.assignmentId==null;
    if(!m || !permissionForRole(m.role,managed?'JOB_ASSIGNMENT_VIEW':'ASSIGNED_WORK'))return fail(403,'PUNCH_PERMISSION_REQUIRED','Site access requires the exact authorized membership.');
    const rows=(await client.query(managed?`SELECT DISTINCT ON(id) * FROM business_punch_site_versions WHERE contractor_profile_id=$1 ORDER BY id,version DESC`:
      `SELECT s.*,a.version AS association_version,a.assignment_activation_version FROM business_punch_site_versions s
       JOIN (SELECT DISTINCT ON(assignment_id,site_id) * FROM business_punch_assignment_site_versions WHERE assignment_id=$2 ORDER BY assignment_id,site_id,version DESC) a
         ON a.site_id=s.id AND a.site_version=s.version AND a.contractor_profile_id=s.contractor_profile_id
       WHERE s.contractor_profile_id=$1 AND a.membership_id=$3 AND a.state='ACTIVE'
       AND business_punch_assignment_is_current($1,a.assignment_id,a.job_id,a.membership_id,a.assignment_activation_version)
       AND business_punch_site_is_current($1,s.id,s.version,a.job_id) ORDER BY s.id`,managed?[ids.businessId]:[ids.businessId,uuid(input.assignmentId),m.id])).rows;
    const sites=[];
    for(const row of rows){
      const reference=row.kind==='CUSTOMER_JOB'?(await client.query('SELECT * FROM business_punch_customer_location($1,$2)',[ids.businessId,row.job_id])).rows[0]:null;
      const current=(await client.query('SELECT business_punch_site_is_current($1,$2,$3) AS current',[ids.businessId,row.id,row.version])).rows[0].current;
      sites.push({...projectSite(row,reference),currentAuthority:current,...(!managed?{associationVersion:row.association_version,assignmentActivationVersion:row.assignment_activation_version}:{})});
    }
    const policies=managed?(await client.query('SELECT DISTINCT ON(id) * FROM business_punch_policy_versions WHERE contractor_profile_id=$1 ORDER BY id,version DESC',[ids.businessId])).rows.map(projectPolicy):undefined;
    return {ok:true,status:200,sites,...(managed?{policies}:{}),proximityEnforced:true};
  },{readOnly:true});
}
async function recordSnapshot(input){
  if(['isInsideGeofence','verificationResult','distanceMeters','targetLatitude','targetLongitude','radiusMeters','receivedAt','userId','membershipId'].some(k=>input[k]!=null))return fail(400,'PUNCH_POSITION_MALFORMED','Verification and employee identity are server-owned.');
  const snapshot=normalizeSnapshot(input.snapshot);if(snapshot?.ok===false)return snapshot;
  if(!uuid(input.assignmentId)||!uuid(input.siteId)||!positive(input.siteVersion)||!positive(input.associationVersion)||!positive(input.assignmentActivationVersion)||!['CLOCK_IN','CLOCK_OUT'].includes(input.boundary))return fail(400,'PUNCH_SNAPSHOT_IDENTITY_INVALID','Exact assignment/site versions and Punch boundary are required.');
  const payload={assignmentId:uuid(input.assignmentId),siteId:uuid(input.siteId),siteVersion:input.siteVersion,associationVersion:input.associationVersion,assignmentActivationVersion:input.assignmentActivationVersion,boundary:input.boundary,snapshot};
  return command(input,'ASSIGNED_WORK','SNAPSHOT',payload,async(client,ids,m,c)=>{
    const a=await loadAssignment(client,ids,payload.assignmentId);
    if(!a||a.membership_id!==m.id)return fail(403,'PUNCH_EXACT_ASSIGNMENT_REQUIRED','Only your exact work assignment may be used.');
    const row=(await client.query(`INSERT INTO business_punch_location_snapshots(id,contractor_profile_id,membership_id,user_id,job_id,assignment_id,assignment_activation_version,site_id,site_version,association_version,boundary,capture_status,device_latitude,device_longitude,accuracy_meters,sampled_at,command_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,[randomUUID(),ids.businessId,m.id,ids.userId,a.job_id,a.id,payload.assignmentActivationVersion,payload.siteId,payload.siteVersion,payload.associationVersion,payload.boundary,snapshot.status,snapshot.latitude,snapshot.longitude,snapshot.accuracyMeters,snapshot.sampledAt,c])).rows[0];
    return {snapshot:projectSnapshot(row),punchAccepted:false};
  });
}
function projectSnapshot(row){return {id:row.id,businessId:row.contractor_profile_id,membershipId:row.membership_id,jobId:row.job_id,assignmentId:row.assignment_id,assignmentActivationVersion:row.assignment_activation_version,
  siteId:row.site_id,siteVersion:row.site_version,associationVersion:row.association_version,boundary:row.boundary,
  device:{status:row.capture_status,latitude:row.device_latitude,longitude:row.device_longitude,accuracyMeters:row.accuracy_meters,sampledAt:row.sampled_at},receivedAt:row.received_at,
  target:{latitude:row.target_latitude,longitude:row.target_longitude,policyId:row.policy_id,policyVersion:row.policy_version,radiusMeters:row.radius_meters},
  sampleState:row.sample_state,verificationResult:row.verification_result,distanceMeters:row.distance_meters};}
async function listOwnSnapshots(input){
  const ids=identity(input);if(ids.ok===false)return ids;
  return withTransaction(input.pool,async client=>{
    const m=await actor(client,ids.userId,ids.businessId);
    if(!m||!permissionForRole(m.role,'ASSIGNED_WORK'))return fail(403,'PUNCH_PERMISSION_REQUIRED','Employee location evidence is private to its exact member.');
    const rows=(await client.query('SELECT * FROM business_punch_location_snapshots WHERE contractor_profile_id=$1 AND membership_id=$2 AND user_id=$3 ORDER BY received_at DESC,id LIMIT 100',[ids.businessId,m.id,ids.userId])).rows;
    return {ok:true,status:200,snapshots:rows.map(projectSnapshot)};
  },{readOnly:true});
}
module.exports={writePolicy,writeSite,authorizeAssignmentSite,listSites,recordSnapshot,listOwnSnapshots,normalizeSnapshot,normalizeAddress};
