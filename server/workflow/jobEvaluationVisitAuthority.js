"use strict";

const {
  CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
  PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
} = require("./jobFoundationService");

// SQL references below are fixed server expressions, never request input.
function jobEvaluationVisitAuthoritySql(jobId = "$1", participantId = "$2") {
  return `/* visit:job_evaluation_authority */
     SELECT
       EXISTS (SELECT 1 FROM canonical_job_completion_records completed
         WHERE completed.job_id = foundation_jobs.id) AS job_closed,
       EXISTS (
         SELECT 1
         FROM request_relationships relationship
         INNER JOIN posts request ON request.id = relationship.post_id
           AND request.id = foundation_jobs.job_request_id
           AND request.lifecycle_contract_version = 2 AND request.cancelled_at IS NULL
         INNER JOIN contractor_profiles business ON business.id = relationship.contractor_id
           AND business.user_id = relationship.professional_user_id
         INNER JOIN relationship_participants professional ON professional.job_id = foundation_jobs.id
           AND professional.request_relationship_id = relationship.id
           AND professional.user_id = relationship.professional_user_id
         INNER JOIN relationship_participants customer ON customer.job_id = foundation_jobs.id
           AND customer.request_relationship_id = relationship.id
           AND customer.user_id = relationship.homeowner_id
         INNER JOIN lifecycle_authority_grants evaluation ON evaluation.job_id = foundation_jobs.id
           AND evaluation.scope_job_id = foundation_jobs.id AND evaluation.scope_type = 'job'
           AND evaluation.grantee_participant_id = professional.id
           AND evaluation.capability = 'evaluation.perform'
           AND evaluation.valid_from <= CURRENT_TIMESTAMP
           AND (evaluation.valid_until IS NULL OR evaluation.valid_until > CURRENT_TIMESTAMP)
         WHERE relationship.id = foundation_jobs.source_request_relationship_id
           AND foundation_jobs.source_type = 'ordinary_request_selection'
           AND relationship.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM lifecycle_authority_grant_revocations revoked
             WHERE revoked.authority_grant_id = evaluation.id)
           AND EXISTS (SELECT 1 FROM participant_role_assignments role
             WHERE role.job_id = foundation_jobs.id AND role.participant_id = professional.id
               AND role.role = 'PRIMARY_PROFESSIONAL' AND role.valid_from <= CURRENT_TIMESTAMP
               AND (role.valid_until IS NULL OR role.valid_until > CURRENT_TIMESTAMP)
               AND NOT EXISTS (SELECT 1 FROM participant_role_revocations revoked
                 WHERE revoked.role_assignment_id = role.id))
           AND EXISTS (SELECT 1 FROM participant_role_assignments role
             WHERE role.job_id = foundation_jobs.id AND role.participant_id = customer.id
               AND role.role = 'CUSTOMER_REPRESENTATIVE' AND role.valid_from <= CURRENT_TIMESTAMP
               AND (role.valid_until IS NULL OR role.valid_until > CURRENT_TIMESTAMP)
               AND NOT EXISTS (SELECT 1 FROM participant_role_revocations revoked
                 WHERE revoked.role_assignment_id = role.id))
           AND ${participantId}::uuid IN (professional.id, customer.id)
           AND NOT EXISTS (SELECT 1 FROM lifecycle_authority_grants explicit_visit
             WHERE explicit_visit.job_id = foundation_jobs.id
               AND explicit_visit.grantee_participant_id = ${participantId}
               AND explicit_visit.capability LIKE 'visit.%'
               AND explicit_visit.scope_type IN ('job', 'evaluation', 'evaluation_visit'))
       ) AS evaluation_job_authorized
     FROM jobs foundation_jobs WHERE foundation_jobs.id = ${jobId} AND foundation_jobs.lifecycle_contract_version = 2`;
}

// Older selected Jobs can have evaluation.perform without the later
// evaluation_visit bootstrap. Resolve that existing Job authority at the Visit
// boundary; never persist grants during a read or replace a revoked Visit grant.
async function resolveJobEvaluationVisitAuthority(client, context) {
  const result = await client.query(
    jobEvaluationVisitAuthoritySql(),
    [context.job_id, context.actor_participant_id]
  );
  const row = result.rows[0];
  return {
    // A missing Job must never enable a new proposal.
    closed: !row || row.job_closed === true,
    capabilities: row?.evaluation_job_authorized === true
      ? context.actor_is_primary_professional === true
        ? PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES
        : context.actor_is_customer_representative === true
          ? CUSTOMER_EVALUATION_VISIT_CAPABILITIES
          : []
      : [],
  };
}
module.exports = { resolveJobEvaluationVisitAuthority, jobEvaluationVisitAuthoritySql };
