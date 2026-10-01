"use strict";
const { createHash } = require('node:crypto');
const location = require('./punchLocationService');
const { permissionForRole } = require('./teamService');
const fail = (status, code, message) => ({ok:false,status,code,message});
const uuid = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const positive = value => typeof value==='number' && Number.isSafeInteger(value) && value>0 && value<=2147483647;
const object = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>keys.includes(key));
const keyValid = key => typeof key==='string' && key.length>0 && key.length<=200 && !/[\u0000-\u001f\u007f]/.test(key);
function identityNumber(value){return typeof value==='number'?value:typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value)?Number(value):NaN;}
function identity(input) {
  const businessId=identityNumber(input.businessId),userId=identityNumber(input.authenticatedActor?.id);
  if(!positive(userId))return fail(401,'AUTHENTICATION_REQUIRED','Authentication required.');
  if(!input.pool||!positive(businessId)||!uuid(input.assignmentId)||!uuid(input.employeeMembershipId))return fail(400,'PUNCH_MANAGEMENT_IDENTITY_INVALID','An exact business, employee and assignment are required.');
  return {businessId,userId};
}
async function transaction(pool,readOnly,run) {
  const client=typeof pool.connect==='function'?await pool.connect():pool;
  try {
    await client.query(readOnly?'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    const result=await run(client);
    await client.query(result?.ok===false?'ROLLBACK':'COMMIT');return result;
  } catch(error) {
    await client.query('ROLLBACK');
    if(['P0001','23503','23505','23514','40001'].includes(error.code))return fail(409,'PUNCH_AUTHORITY_CONFLICT','The assignment or location authority changed. Refresh and review the current versions.');
    throw error;
  } finally {if(client!==pool&&typeof client.release==='function')client.release();}
}
async function context(client,input,ids,{lock=false,mutation=false}={}) {
  const member=(await client.query(`SELECT * FROM business_team_memberships WHERE contractor_profile_id=$1 AND user_id=$2 AND status='ACTIVE' ${lock?'FOR UPDATE':''}`,[ids.businessId,ids.userId])).rows[0];
  if(!member||!permissionForRole(member.role,mutation?'JOB_ASSIGNMENT_MANAGE':'JOB_ASSIGNMENT_VIEW'))return fail(403,'PUNCH_PERMISSION_REQUIRED','Active Team assignment management permission is required.');
  const assignment=(await client.query(`SELECT a.*,m.role AS member_role,m.status AS member_status,u.username AS member_name,
      activation.version AS activation_version,
      business_punch_assignment_is_current($2,a.id,a.job_id,a.membership_id,activation.version) AS current_authority
    FROM business_job_assignments a JOIN business_team_memberships m ON m.id=a.membership_id AND m.contractor_profile_id=a.contractor_profile_id
    JOIN users u ON u.id=m.user_id
    JOIN LATERAL (SELECT max(assignment_version) AS version FROM business_job_assignment_events WHERE assignment_id=a.id AND event_type IN ('ASSIGNED','REASSIGNED')) activation ON TRUE
    WHERE a.id=$1 AND a.contractor_profile_id=$2 AND a.membership_id=$3 ${lock?'FOR UPDATE OF a':''}`,
    [input.assignmentId,ids.businessId,input.employeeMembershipId])).rows[0];
  if(!assignment)return fail(404,'PUNCH_ASSIGNMENT_NOT_FOUND','The exact employee assignment is unavailable.');
  const source=(await client.query('SELECT job_title,job_source_type FROM business_employee_job_sources($1,$2)',[ids.businessId,assignment.job_id])).rows[0];
  if(!source)return fail(404,'PUNCH_ASSIGNMENT_NOT_FOUND','The exact employee assignment is unavailable.');
  if(mutation && (!assignment.current_authority || assignment.version!==input.expectedAssignmentVersion || assignment.activation_version!==input.assignmentActivationVersion))return fail(409,'PUNCH_ASSIGNMENT_STALE','The assignment changed. Refresh and review before authorizing locations.');
  return {member,assignment,source};
}
function policy(row) {return {id:row.id,version:row.version,state:row.state,radiusMeters:row.radius_meters,maxAccuracyMeters:row.max_accuracy_meters,maxSampleAgeSeconds:row.max_sample_age_seconds,maxFutureSkewSeconds:row.max_future_skew_seconds};}
function site(row,reference) {
  return {id:row.id,version:row.version,state:row.state,kind:row.kind,label:row.label,jobId:row.job_id,
    source:row.source_type?{type:row.source_type,id:row.source_id,version:row.source_version,revision:row.source_revision}:null,
    address:row.kind==='MANUAL_BUSINESS'?location.normalizeAddress(row.manual_address):(reference?.source_revision===row.source_revision?reference.address:null),
    geometry:{latitude:row.latitude,longitude:row.longitude,resolutionMethod:row.resolution_method},
    geometryCapture:row.result_reference?.site?.geometryCapture||null,policyId:row.policy_id,policyVersion:row.policy_version};
}
async function readManagement(input) {
  const ids=identity(input);if(ids.ok===false)return ids;
  return transaction(input.pool,true,async client=>{
    const ctx=await context(client,input,ids);if(ctx.ok===false)return ctx;
    const a=ctx.assignment;
    const reference=(await client.query('SELECT * FROM business_punch_customer_location($1,$2)',[ids.businessId,a.job_id])).rows[0];
    // Customer sites are exact-Job scoped. Manual business sites are deliberately reusable within this business.
    const rows=(await client.query(`SELECT s.*,c.result_reference,
      business_punch_site_is_current($1,s.id,s.version,$2) AS current_authority
      FROM (SELECT DISTINCT ON(id) * FROM business_punch_site_versions WHERE contractor_profile_id=$1 AND (kind='MANUAL_BUSINESS' OR job_id=$2) ORDER BY id,version DESC) s
      JOIN business_punch_location_commands c ON c.id=s.command_id ORDER BY s.label,s.id`,[ids.businessId,a.job_id])).rows;
    const links=(await client.query(`SELECT v.*,s.label FROM business_punch_assignment_site_versions v
      JOIN business_punch_site_versions s ON s.id=v.site_id AND s.version=v.site_version AND s.contractor_profile_id=v.contractor_profile_id
      WHERE v.contractor_profile_id=$1 AND v.assignment_id=$2 AND v.membership_id=$3 ORDER BY v.site_id,v.version DESC`,[ids.businessId,a.id,a.membership_id])).rows;
    const histories=new Map();
    for(const link of links){
      if(!histories.has(link.site_id))histories.set(link.site_id,[]);
      histories.get(link.site_id).push({version:link.version,state:link.state,siteVersion:link.site_version,assignmentActivationVersion:link.assignment_activation_version,label:link.label,createdAt:link.created_at});
    }
    const sites=rows.map(row=>{
      const link=links.find(value=>value.site_id===row.id),history=histories.get(row.id)||[];
      const currentAuthorization=Boolean(a.current_authority&&row.current_authority&&link?.state==='ACTIVE'&&link.site_version===row.version&&link.assignment_activation_version===a.activation_version);
      return {...site(row,reference),currentAuthority:row.current_authority,currentAuthorization,
        association:link?{version:link.version,state:link.state,siteVersion:link.site_version,assignmentActivationVersion:link.assignment_activation_version}:null,history};
    });
    const policies=(await client.query('SELECT DISTINCT ON(id) * FROM business_punch_policy_versions WHERE contractor_profile_id=$1 ORDER BY id,version DESC',[ids.businessId])).rows.map(policy);
    return {ok:true,status:200,assignment:{id:a.id,membershipId:a.membership_id,memberName:a.member_name,jobId:a.job_id,jobTitle:ctx.source.job_title,sourceType:ctx.source.job_source_type,state:a.state,version:a.version,activationVersion:a.activation_version,currentAuthority:a.current_authority},
      canManage:permissionForRole(ctx.member.role,'JOB_ASSIGNMENT_MANAGE'),canManagePolicy:permissionForRole(ctx.member.role,'TIME_SETTINGS_MANAGE'),
      customerLocation:reference?{address:reference.address,source:{type:reference.source_type,id:reference.source_id,version:reference.source_version,revision:reference.source_revision}}:null,
      sites,policies,proximityEnforced:false};
  });
}
function writeIdentity(input) {
  const ids=identity(input);if(ids.ok===false)return ids;
  if(!positive(input.expectedAssignmentVersion)||!positive(input.assignmentActivationVersion)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||input.expectedVersion>2147483646||!keyValid(input.idempotencyKey))return fail(400,'PUNCH_MANAGEMENT_VERSION_INVALID','Expected assignment, activation and authorization versions and a command key are required.');
  return ids;
}
function managementRequest(input,values) {
  return {assignmentId:input.assignmentId,employeeMembershipId:input.employeeMembershipId,expectedAssignmentVersion:input.expectedAssignmentVersion,assignmentActivationVersion:input.assignmentActivationVersion,expectedVersion:input.expectedVersion,...values};
}
function commandKey(parent,part){return createHash('sha256').update(JSON.stringify([parent,part])).digest('hex');}
async function saveAssignmentSite(input) {
  const ids=writeIdentity(input);if(ids.ok===false)return ids;
  if(!object(input.site,['id','expectedVersion','kind','label','address','policyId','policyVersion','capture','customerSourceRevision'])||
    !object(input.site.capture,['latitude','longitude','accuracyMeters','sampledAt']) ||
    !['CUSTOMER_JOB','MANUAL_BUSINESS'].includes(input.site.kind)||
    (input.site.id!=null&&!uuid(input.site.id))||!Number.isSafeInteger(input.site.expectedVersion)||input.site.expectedVersion<0||input.site.expectedVersion>2147483646||
    !uuid(input.site.policyId)||!positive(input.site.policyVersion)||
    (input.site.kind==='CUSTOMER_JOB'&&(input.site.address!=null||typeof input.site.customerSourceRevision!=='string'||!/^[a-f0-9]{64}$/.test(input.site.customerSourceRevision)))||
    (input.site.kind==='MANUAL_BUSINESS'&&input.site.customerSourceRevision!=null))return fail(400,'PUNCH_MANAGEMENT_SITE_INVALID','A source-bound site and a foreground capture are required.');
  const capture=location.normalizeSnapshot({status:'CAPTURED',...input.site.capture});if(capture.ok===false)return capture;
  const s={id:input.site.id||null,expectedVersion:input.site.expectedVersion,kind:input.site.kind,label:input.site.label,
    address:input.site.kind==='MANUAL_BUSINESS'?location.normalizeAddress(input.site.address):null,
    policyId:input.site.policyId,policyVersion:input.site.policyVersion,capture,customerSourceRevision:input.site.customerSourceRevision||null};
  const request=managementRequest(input,{site:s});
  return transaction(input.pool,false,async client=>{
    const ctx=await context(client,input,ids,{lock:true,mutation:true});if(ctx.ok===false)return ctx;
    // A customer's site identity cannot be redirected, and manual sites remain business-owned.
    const result=await location.writeSite({pool:input.pool,_transactionClient:client,_managementRequest:request,
      authenticatedActor:input.authenticatedActor,businessId:ids.businessId,idempotencyKey:commandKey(input.idempotencyKey,'site'),_expectedCustomerRevision:s.customerSourceRevision,
      id:s.id,expectedVersion:s.expectedVersion,state:'ACTIVE',kind:s.kind,label:s.label,
      ...(s.kind==='CUSTOMER_JOB'?{jobId:ctx.assignment.job_id}:{address:s.address}),
      latitude:capture.latitude,longitude:capture.longitude,policyId:s.policyId,policyVersion:s.policyVersion,
      geometryCapture:{source:'FOREGROUND_DEVICE',snapshot:capture}});
    if(result.ok===false)return result;
    const linked=await location.authorizeAssignmentSite({pool:input.pool,_transactionClient:client,_managementRequest:request,
      authenticatedActor:input.authenticatedActor,businessId:ids.businessId,idempotencyKey:commandKey(input.idempotencyKey,'authorization'),
      assignmentId:ctx.assignment.id,siteId:result.site.id,siteVersion:result.site.version,expectedVersion:input.expectedVersion,
      assignmentActivationVersion:input.assignmentActivationVersion,state:'ACTIVE'});
    if(linked.ok===false)return linked;
    return {ok:true,status:200,site:result.site,association:linked.association,replayed:Boolean(result.replayed&&linked.replayed),proximityEnforced:false};
  });
}
async function changeAuthorization(input) {
  const ids=writeIdentity(input);if(ids.ok===false)return ids;
  if(!uuid(input.siteId)||!positive(input.siteVersion)||!['ACTIVE','REVOKED'].includes(input.state))return fail(400,'PUNCH_MANAGEMENT_AUTHORIZATION_INVALID','An exact site version and explicit authorization state are required.');
  const request=managementRequest(input,{siteId:input.siteId,siteVersion:input.siteVersion,state:input.state});
  return transaction(input.pool,false,async client=>{
    const ctx=await context(client,input,ids,{lock:true,mutation:true});if(ctx.ok===false)return ctx;
    // Reuse A's immutable association command and source/site/policy checks.
    let activation=input.assignmentActivationVersion;
    if(input.state==='REVOKED'){
      const prior=(await client.query('SELECT * FROM business_punch_assignment_site_versions WHERE assignment_id=$1 AND site_id=$2 AND version=$3',[ctx.assignment.id,input.siteId,input.expectedVersion])).rows[0];
      if(!prior||prior.site_version!==input.siteVersion)return fail(409,'PUNCH_ASSOCIATION_STALE','The authorization changed. Refresh and review.');
      activation=prior.assignment_activation_version;
    }
    return location.authorizeAssignmentSite({...input,businessId:ids.businessId,assignmentActivationVersion:activation,_transactionClient:client,_managementRequest:request});
  });
}
module.exports={readManagement,saveAssignmentSite,changeAuthorization};
