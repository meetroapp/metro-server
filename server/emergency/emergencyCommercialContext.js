"use strict";

const { randomUUID } = require("node:crypto");
const { CUSTOMER_BOOTSTRAP_CAPABILITIES } = require("../workflow/jobFoundationService");

// A separate source branch preserves ordinary/repeat/external joins unchanged.
// All Emergency commercial consumers share the same selected Job identity.
const EMERGENCY_JOINS = `
  FROM jobs
  JOIN emergency_requests emergency ON emergency.id = jobs.source_emergency_request_id
  JOIN request_relationships relationships
    ON relationships.id = jobs.source_request_relationship_id
   AND relationships.emergency_request_id = emergency.id
   AND relationships.post_id IS NULL
   AND relationships.status = 'active'
   AND relationships.homeowner_id = emergency.homeowner_id
  JOIN contractor_profiles profiles
    ON profiles.id = relationships.contractor_id
   AND profiles.user_id = relationships.professional_user_id
  JOIN relationship_participants professional
    ON professional.job_id = jobs.id
   AND professional.request_relationship_id = relationships.id
   AND professional.user_id = relationships.professional_user_id
   AND professional.source_evidence_type = 'emergency_selection'
  JOIN relationship_participants customer
    ON customer.job_id = jobs.id
   AND customer.request_relationship_id = relationships.id
   AND customer.user_id = relationships.homeowner_id
   AND customer.source_evidence_type = 'emergency_selection'
  JOIN conversations
    ON conversations.relationship_id = relationships.id
   AND conversations.homeowner_id = relationships.homeowner_id
   AND conversations.professional_user_id = relationships.professional_user_id
   AND conversations.contractor_id = relationships.contractor_id
   AND conversations.status = 'active'`;
const EMERGENCY_SHAPE = `
  jobs.source_type = 'emergency_request'
  AND jobs.lifecycle_contract_version = 2
  AND jobs.created_by_user_id = emergency.homeowner_id
  AND jobs.job_request_id IS NULL
  AND jobs.source_request_selection_id IS NULL
  AND jobs.contractor_profile_id IS NULL
  AND jobs.business_contact_id IS NULL
  AND jobs.business_customer_relationship_id IS NULL
  AND jobs.originating_business_document_id IS NULL
  AND jobs.source_business_customer_job_id IS NULL`;
const QUOTE_JOINS = `
  JOIN canonical_quotes quotes
    ON quotes.job_id = jobs.id
   AND quotes.source_context_type = 'emergency_request'
   AND quotes.job_source_type = 'emergency_request'
   AND quotes.job_request_id IS NULL
   AND quotes.relationship_id = relationships.id
   AND quotes.emergency_request_id = emergency.id
   AND quotes.business_customer_job_source_id IS NULL
  JOIN commercial_authority_aggregates aggregates
    ON aggregates.id = quotes.id
   AND aggregates.aggregate_type = 'quote'
   AND aggregates.owning_engine = 'authorization_engine'
   AND aggregates.source_context_type = 'emergency_request'
   AND aggregates.ordinary_request_id IS NULL
   AND aggregates.emergency_request_id = emergency.id
   AND aggregates.relationship_id = relationships.id
   AND aggregates.business_customer_job_source_id IS NULL`;
function activeRole(participant, role) {
  return `EXISTS (
    SELECT 1 FROM participant_role_assignments roles
    LEFT JOIN participant_role_revocations revocations ON revocations.role_assignment_id = roles.id
    WHERE roles.participant_id = ${participant}.id AND roles.job_id = jobs.id
      AND roles.role = '${role}' AND roles.valid_from <= CURRENT_TIMESTAMP
      AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
      AND revocations.id IS NULL
  )`;
}

async function loadEmergencyProfessionalContext(client, { jobId = null, emergencyRequestId = null, actorId, lock = false }) {
  const result = await client.query(`/* emergency_commercial:professional */
    SELECT jobs.id AS job_id, jobs.job_request_id, jobs.source_type,
      jobs.source_type AS job_source_type, 'emergency_request' AS source_context_type,
      emergency.id AS emergency_request_id, emergency.id AS job_emergency_request_id,
      emergency.status AS emergency_status, emergency.arrived_at,
      emergency.work_started_at, emergency.completed_at AS emergency_completed_at,
      emergency.title AS job_title, emergency.category AS job_service,
      relationships.id AS relationship_id, relationships.status AS relationship_status,
      relationships.homeowner_id, relationships.homeowner_id AS homeowner_user_id,
      relationships.professional_user_id,
      relationships.professional_user_id AS selected_professional_user_id,
      professional.id AS professional_participant_id, professional.id AS actor_participant_id,
      professional.user_id AS actor_user_id, customer.id AS customer_participant_id,
      conversations.id AS conversation_id, conversations.relationship_id AS conversation_relationship_id,
      conversations.status AS conversation_status, profiles.business_name,
      true AS primary_professional_active
    ${EMERGENCY_JOINS}
    WHERE ${EMERGENCY_SHAPE}
      AND ($1::uuid IS NULL OR jobs.id = $1)
      AND ($2::integer IS NULL OR emergency.id = $2)
      AND relationships.professional_user_id = $3
      AND ${activeRole('professional', 'PRIMARY_PROFESSIONAL')}
    LIMIT 1 ${lock ? 'FOR UPDATE OF jobs' : ''}`,
  [jobId, emergencyRequestId, actorId]);
  return result.rows[0] || null;
}

async function loadEmergencyCustomerQuoteContext(client, quoteId, actorId, { lock = false } = {}) {
  const result = await client.query(`/* emergency_commercial:customer_quote */
    SELECT quotes.*, aggregates.current_version, jobs.lifecycle_contract_version,
      relationships.status AS relationship_status,
      relationships.homeowner_id AS customer_user_id, relationships.professional_user_id,
      COALESCE(NULLIF(TRIM(customer_users.username), ''), 'Customer') AS customer_display_name,
      emergency.title AS job_title, customer.id AS actor_participant_id,
      customer.user_id AS actor_user_id, true AS actor_is_customer_representative,
      decisions.id AS decision_id, decisions.decision,
      decisions.issued_quote_version AS decision_quote_version, decisions.decided_at
    ${EMERGENCY_JOINS}
    ${QUOTE_JOINS}
    JOIN canonical_quote_issuances issuances
      ON issuances.quote_id = quotes.id AND issuances.job_id = jobs.id
     AND issuances.quote_version = aggregates.current_version
     AND issuances.issuer_participant_id = professional.id
    JOIN canonical_quote_versions versions
      ON versions.quote_id = quotes.id AND versions.job_id = jobs.id
     AND versions.version = issuances.quote_version AND versions.status = 'ISSUED'
     AND versions.integrity_hash = issuances.source_snapshot_integrity_hash
    JOIN users customer_users ON customer_users.id = customer.user_id
    LEFT JOIN canonical_quote_customer_decisions decisions ON decisions.quote_id = quotes.id
    WHERE ${EMERGENCY_SHAPE} AND quotes.id = $1
      AND customer.user_id = $2 AND relationships.homeowner_id = $2
      AND ${activeRole('customer', 'CUSTOMER_REPRESENTATIVE')}
    LIMIT 1 ${lock ? 'FOR UPDATE OF quotes, aggregates' : ''}`, [quoteId, actorId]);
  return result.rows[0] || null;
}

async function loadEmergencyQuoteApprovalSource(client, { jobId, approvalId = null, customerDecisionId = null, lock = false, latestIssuedQuote = false }) {
  const result = await client.query(`/* emergency_commercial:approved_quote */
    SELECT jobs.id AS job_id, jobs.job_request_id, jobs.source_type AS job_source_type,
      relationships.id AS relationship_id, relationships.status AS relationship_status,
      professional.id AS professional_participant_id, professional.user_id AS professional_user_id,
      customer.id AS customer_participant_id, customer.user_id AS customer_user_id,
      approvals.id AS quote_approval_id, approvals.approval_source, approvals.decision,
      approvals.customer_decision_id, approvals.external_approval_evidence_id,
      approvals.issued_quote_version, approvals.issued_integrity_hash,
      approvals.approved_at, approvals.approved_at AS decided_at,
      quotes.id AS quote_id, versions.currency, versions.total_minor, versions.customer_terms_snapshot
    ${EMERGENCY_JOINS}
    ${QUOTE_JOINS}
    JOIN canonical_quote_approvals approvals
      ON approvals.job_id = jobs.id AND approvals.quote_id = quotes.id
     AND approvals.approval_source = 'MEETRO_CUSTOMER' AND approvals.decision = 'APPROVED'
     AND approvals.external_approval_evidence_id IS NULL
    JOIN canonical_quote_customer_decisions decisions
      ON decisions.id = approvals.customer_decision_id
     AND decisions.quote_id = quotes.id AND decisions.job_id = jobs.id
     AND decisions.relationship_id = relationships.id
     AND decisions.customer_participant_id = customer.id AND decisions.decision = 'APPROVED'
     AND decisions.issued_quote_version = approvals.issued_quote_version
     AND decisions.issued_integrity_hash = approvals.issued_integrity_hash
    JOIN canonical_quote_versions versions
      ON versions.quote_id = quotes.id AND versions.job_id = jobs.id
     AND versions.version = approvals.issued_quote_version AND versions.status = 'ISSUED'
     AND versions.integrity_hash = approvals.issued_integrity_hash
    JOIN canonical_quote_issuances issuances
      ON issuances.quote_id = quotes.id AND issuances.job_id = jobs.id
     AND issuances.quote_version = approvals.issued_quote_version
     AND issuances.issuer_participant_id = professional.id
     AND issuances.source_snapshot_integrity_hash = approvals.issued_integrity_hash
    WHERE ${EMERGENCY_SHAPE} AND jobs.id = $1
      AND quotes.status = 'ISSUED' AND aggregates.current_version = approvals.issued_quote_version
      ${latestIssuedQuote ? `AND NOT EXISTS (
        SELECT 1 FROM canonical_quotes newer
        WHERE newer.job_id = jobs.id AND newer.status = 'ISSUED'
          AND (newer.issued_at, newer.id) > (quotes.issued_at, quotes.id)
      )` : ''}
      AND ($2::uuid IS NULL OR approvals.id = $2)
      AND ($3::uuid IS NULL OR decisions.id = $3)
      AND ${activeRole('customer', 'CUSTOMER_REPRESENTATIVE')}
    ORDER BY approvals.approved_at DESC, approvals.id DESC
    LIMIT 1 ${lock ? 'FOR UPDATE OF jobs, quotes, approvals' : ''}`, [jobId, approvalId, customerDecisionId]);
  return result.rows[0] || null;
}

const EMERGENCY_LIFECYCLE_CONTEXT_SQL = `
  SELECT jobs.id AS job_id, jobs.source_type, jobs.job_request_id,
    jobs.lifecycle_contract_version, jobs.created_at AS job_created_at,
    jobs.source_type AS job_source_type, 'emergency_request' AS source_context_type,
    emergency.id AS emergency_request_id, emergency.id AS job_emergency_request_id,
    emergency.status AS emergency_status, emergency.assigned_at, emergency.en_route_at,
    emergency.arrived_at, emergency.work_started_at,
    emergency.service_domain, emergency.service_specialty,
    emergency.completed_at AS emergency_completed_at,
    relationships.id AS relationship_id, relationships.status AS relationship_status,
    relationships.homeowner_id, relationships.professional_user_id,
    professional.id AS professional_participant_id, professional.id AS actor_participant_id,
    professional.user_id AS actor_user_id, customer.id AS customer_participant_id,
    conversations.id AS conversation_id, conversations.status AS conversation_status,
    emergency.title AS job_title, emergency.category AS job_service,
    homeowner.username AS customer_name,
    COALESCE(NULLIF(profiles.business_name, ''), owner.username) AS business_name,
    completions.id AS completion_id, completions.version AS completion_version,
    completions.version AS job_version, completions.completed_at,
    ${activeRole('professional', 'PRIMARY_PROFESSIONAL')} AS primary_role_active,
    ${activeRole('customer', 'CUSTOMER_REPRESENTATIVE')} AS customer_role_active
  ${EMERGENCY_JOINS}
  JOIN users homeowner ON homeowner.id = customer.user_id
  JOIN users owner ON owner.id = professional.user_id
  LEFT JOIN canonical_job_completion_records completions ON completions.job_id = jobs.id
  WHERE ${EMERGENCY_SHAPE}`;

async function loadEmergencyLifecycleContext(client, jobId, actorId, { lock = false, audience = "professional" } = {}) {
  const actor = audience === "customer" ? "customer" : "professional";
  const result = await client.query(`${EMERGENCY_LIFECYCLE_CONTEXT_SQL}
    AND jobs.id = $1 AND ${actor}.user_id = $2
    AND ${activeRole(actor, audience === "customer" ? 'CUSTOMER_REPRESENTATIVE' : 'PRIMARY_PROFESSIONAL')}
    LIMIT 1 ${lock ? 'FOR UPDATE OF jobs, relationships' : ''}`, [jobId, actorId]);
  return result.rows[0] || null;
}

// Keep the existing effective approved scope rule (approved revisions replace
// their parents). Every remaining issued agreement must have exact approval.
async function loadEmergencyEffectiveApprovedQuotes(client, jobId, { lock = false } = {}) {
  const candidates = await client.query(`/* emergency_commercial:effective_quotes */
    SELECT quotes.id AS quote_id, approvals.id AS approval_id
    ${EMERGENCY_JOINS} ${QUOTE_JOINS}
    LEFT JOIN canonical_quote_approvals approvals ON approvals.quote_id = quotes.id AND approvals.job_id = jobs.id
    WHERE ${EMERGENCY_SHAPE} AND jobs.id = $1 AND quotes.status = 'ISSUED'
      AND NOT EXISTS (
        SELECT 1 FROM canonical_quotes revision
        JOIN canonical_quote_approvals approved_revision
          ON approved_revision.quote_id = revision.id AND approved_revision.job_id = jobs.id
         AND approved_revision.approval_source = 'MEETRO_CUSTOMER' AND approved_revision.decision = 'APPROVED'
        WHERE revision.parent_quote_id = quotes.id AND revision.lineage_type = 'REVISED_QUOTE'
      )
    ORDER BY quotes.issued_at, quotes.id`, [jobId]);
  const sources = [];
  for (const row of candidates.rows) {
    if (!row.approval_id) return [];
    const source = await loadEmergencyQuoteApprovalSource(client, { jobId, approvalId: row.approval_id, lock });
    if (!source) return [];
    sources.push(source);
  }
  return sources;
}

// Bootstrap timing matches ordinary Jobs. Delivery repairs pre-Task-4 Jobs using
// the same selection evidence and idempotency key; revoked grants stay revoked.
async function ensureEmergencyCustomerQuoteGrants(client, context) {
  for (const capability of CUSTOMER_BOOTSTRAP_CAPABILITIES) {
    await client.query(`/* emergency_commercial:customer_grant */
      INSERT INTO lifecycle_authority_grants (
        id, grantee_participant_id, grantor_participant_id, job_id, capability,
        scope_type, scope_job_id, source_evidence_type, source_evidence_reference, idempotency_key
      ) SELECT $1, customer.id, customer.id, jobs.id, $3, 'job', jobs.id,
        'emergency_selection', customer.source_evidence_reference, $4
      ${EMERGENCY_JOINS}
      WHERE ${EMERGENCY_SHAPE} AND jobs.id = $2
        AND ${activeRole('customer', 'CUSTOMER_REPRESENTATIVE')}
        AND NOT EXISTS (
          SELECT 1 FROM lifecycle_authority_grants existing
          WHERE existing.job_id = jobs.id AND existing.grantee_participant_id = customer.id
            AND existing.capability = $3
        )
      ON CONFLICT DO NOTHING`, [randomUUID(), context.job_id, capability,
      `emergency:${context.emergency_request_id}:grant:${context.customer_participant_id}:${capability}`]);
  }
}

module.exports = {
  EMERGENCY_LIFECYCLE_CONTEXT_SQL,
  loadEmergencyLifecycleContext,
  loadEmergencyEffectiveApprovedQuotes,
  loadEmergencyProfessionalContext,
  loadEmergencyCustomerQuoteContext,
  loadEmergencyQuoteApprovalSource,
  ensureEmergencyCustomerQuoteGrants,
};
