"use strict";

// This is a second, explicit authority shape. Marketplace queries keep their
// request/selection/participant checks. A linked account never changes Job origin.
const BUSINESS_JOB_CONTEXT_SQL = `
 SELECT jobs.id AS job_id, jobs.source_type, jobs.lifecycle_contract_version,
   jobs.job_request_id, jobs.source_request_relationship_id AS relationship_id,
   jobs.contractor_profile_id, jobs.business_contact_id,
   jobs.business_customer_relationship_id,
   profiles.user_id AS professional_user_id, profiles.user_id AS actor_user_id,
   professional.id AS professional_participant_id, professional.id AS actor_participant_id,
   'active'::text AS relationship_status, true AS primary_role_active,
   NULL::integer AS homeowner_id, NULL::uuid AS customer_participant_id,
   NULL::integer AS conversation_id, NULL::text AS conversation_status,
   contacts.display_name AS customer_name, contacts.email AS customer_email,
   COALESCE(NULLIF(profiles.business_name,''), owner.username) AS business_name,
   COALESCE(NULLIF(document.content->>'projectTitle',''),'Job') AS job_title,
   NULL::text AS job_service,
   completions.id AS completion_id, completions.version AS completion_version,
   completions.version AS job_version, completions.completed_at
 FROM jobs
 INNER JOIN contractor_profiles profiles ON profiles.id=jobs.contractor_profile_id
 INNER JOIN users owner ON owner.id=profiles.user_id
 INNER JOIN business_customer_relationships customers
   ON customers.id=jobs.business_customer_relationship_id
   AND customers.contractor_profile_id=profiles.id
   AND customers.business_contact_id=jobs.business_contact_id
 INNER JOIN business_contacts contacts ON contacts.id=customers.business_contact_id
   AND contacts.contractor_profile_id=profiles.id AND contacts.status='ACTIVE'
 INNER JOIN job_customer_parties parties ON parties.job_id=jobs.id
   AND parties.contractor_profile_id=profiles.id AND parties.business_contact_id=contacts.id
   AND parties.business_customer_relationship_id=customers.id
 INNER JOIN business_document_working_drafts document
   ON document.id=jobs.originating_business_document_id AND document.contractor_profile_id=profiles.id
 INNER JOIN relationship_participants professional ON professional.job_id=jobs.id
   AND professional.user_id=profiles.user_id AND professional.request_relationship_id IS NULL
 LEFT JOIN canonical_job_completion_records completions ON completions.job_id=jobs.id
 WHERE jobs.source_type='business_document' AND jobs.lifecycle_contract_version=2
   AND jobs.job_request_id IS NULL AND jobs.source_request_relationship_id IS NULL
   AND EXISTS (SELECT 1 FROM business_contact_roles roles
     WHERE roles.business_contact_id=contacts.id AND roles.contractor_profile_id=profiles.id
       AND roles.role='CUSTOMER' AND roles.ended_at IS NULL)
   AND EXISTS (SELECT 1 FROM participant_role_assignments roles
     LEFT JOIN participant_role_revocations revoked ON revoked.role_assignment_id=roles.id
     WHERE roles.participant_id=professional.id AND roles.job_id=jobs.id
       AND roles.role='PRIMARY_PROFESSIONAL' AND roles.valid_from<=CURRENT_TIMESTAMP
       AND (roles.valid_until IS NULL OR roles.valid_until>CURRENT_TIMESTAMP) AND revoked.id IS NULL)`;

async function loadBusinessJobContext(client, jobId, actorId, {lock=false}={}) {
  const result=await client.query(`${BUSINESS_JOB_CONTEXT_SQL}
    AND jobs.id=$1 AND profiles.user_id=$2 ${lock?'FOR UPDATE OF jobs, contacts, customers, professional':''}`,[jobId,actorId]);
  return result.rows[0] || null;
}
function authorityFields(row) {
  return row?.source_type==='business_document' ? {authority:{kind:'BUSINESS_CUSTOMER',
    contractorProfileId:Number(row.contractor_profile_id), businessContactId:row.business_contact_id,
    customerRelationshipId:row.business_customer_relationship_id}} : {};
}
module.exports={BUSINESS_JOB_CONTEXT_SQL,loadBusinessJobContext,authorityFields};
