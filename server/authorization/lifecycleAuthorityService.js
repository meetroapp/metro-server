"use strict";

const { randomUUID } = require("node:crypto");

const MANAGEMENT_CAPABILITIES = Object.freeze({
  ASSIGN_ROLE: "participant.role.assign",
  REVOKE_ROLE: "participant.role.revoke",
  CREATE_GRANT: "authority.grant.create",
  REVOKE_GRANT: "authority.grant.revoke",
});

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

async function hasActiveLifecycleGrant({
  client,
  participantId,
  capability,
  jobId,
  concernId = null,
  evaluationId = null,
  approvedQuoteDecisionId = null,
  quoteApprovalId = null,
  allowJobScope = true,
  allowEvaluationVisitScope = false,
  at = null,
  logger = null,
} = {}) {
  const normalizedParticipantId = uuid(participantId);
  const normalizedJobId = uuid(jobId);
  const normalizedConcernId = concernId == null ? null : uuid(concernId);
  const normalizedEvaluationId = evaluationId == null ? null : uuid(evaluationId);
  const normalizedApprovedQuoteDecisionId = approvedQuoteDecisionId == null
    ? null
    : uuid(approvedQuoteDecisionId);
  const normalizedQuoteApprovalId = quoteApprovalId == null ? null : uuid(quoteApprovalId);
  const normalizedCapability = String(capability || "").trim();
  if (
    !normalizedParticipantId ||
    !normalizedJobId ||
    !normalizedCapability ||
    (evaluationId != null && !normalizedEvaluationId) ||
    (approvedQuoteDecisionId != null && !normalizedApprovedQuoteDecisionId) ||
    (quoteApprovalId != null && !normalizedQuoteApprovalId)
  ) {
    return false;
  }

  const result = await client.query(
    `
    /* lifecycle_authority:active_grant */
    SELECT lifecycle_authority_grants.id
    FROM lifecycle_authority_grants
    LEFT JOIN lifecycle_authority_grant_revocations
      ON lifecycle_authority_grant_revocations.authority_grant_id =
        lifecycle_authority_grants.id
    WHERE lifecycle_authority_grants.grantee_participant_id = $1
      AND lifecycle_authority_grants.capability = $2
      AND lifecycle_authority_grants.job_id = $3
      AND lifecycle_authority_grants.scope_job_id = $3
      AND (
        ($7::boolean = TRUE AND lifecycle_authority_grants.scope_type = 'job')
        OR (
          $4::uuid IS NOT NULL
          AND lifecycle_authority_grants.scope_type = 'reported_concern'
          AND lifecycle_authority_grants.scope_concern_id = $4
        )
        OR (
          $5::uuid IS NOT NULL
          AND lifecycle_authority_grants.scope_type = 'evaluation'
          AND lifecycle_authority_grants.scope_concern_id IS NULL
          AND lifecycle_authority_grants.scope_evaluation_id = $5
        )
        OR (
          lifecycle_authority_grants.scope_type = 'approved_work'
          AND lifecycle_authority_grants.scope_concern_id IS NULL
          AND lifecycle_authority_grants.scope_evaluation_id IS NULL
          AND EXISTS (
            SELECT 1 FROM canonical_quote_approvals approvals
            WHERE approvals.job_id = $3
              AND ($10::uuid IS NULL OR approvals.id = $10)
              AND ($6::uuid IS NULL OR approvals.customer_decision_id = $6)
              AND ($10::uuid IS NOT NULL OR $6::uuid IS NOT NULL)
              AND (
                (lifecycle_authority_grants.scope_quote_approval_id = approvals.id
                 AND lifecycle_authority_grants.scope_quote_approval_source = approvals.approval_source)
                OR
                (lifecycle_authority_grants.scope_quote_approval_id IS NULL
                 AND approvals.approval_source = 'MEETRO_CUSTOMER'
                 AND lifecycle_authority_grants.scope_approved_quote_decision_id = approvals.customer_decision_id
                 AND lifecycle_authority_grants.scope_approved_quote_decision = 'APPROVED')
              )
          )
        )
        OR (
          $9::boolean = TRUE
          AND lifecycle_authority_grants.scope_type = 'evaluation_visit'
          AND lifecycle_authority_grants.scope_concern_id IS NULL
          AND lifecycle_authority_grants.scope_evaluation_id IS NULL
          AND lifecycle_authority_grants.scope_approved_quote_decision_id IS NULL
          AND lifecycle_authority_grants.scope_approved_quote_decision IS NULL
        )
      )
      AND lifecycle_authority_grants.valid_from <= COALESCE($8::timestamptz, CURRENT_TIMESTAMP)
      AND (
        lifecycle_authority_grants.valid_until IS NULL
        OR lifecycle_authority_grants.valid_until > COALESCE($8::timestamptz, CURRENT_TIMESTAMP)
      )
      AND lifecycle_authority_grant_revocations.id IS NULL
    LIMIT 1
    `,
    [
      normalizedParticipantId,
      normalizedCapability,
      normalizedJobId,
      normalizedConcernId,
      normalizedEvaluationId,
      normalizedApprovedQuoteDecisionId,
      allowJobScope === true,
      at,
      allowEvaluationVisitScope === true,
      normalizedQuoteApprovalId,
    ]
  );

  const granted = Boolean(result.rows[0]);
  if (!granted && logger && typeof logger.warn === "function") {
    logger.warn("Lifecycle authority scope or validity mismatch", {
      code: "LIFECYCLE_AUTHORITY_SCOPE_OR_VALIDITY_MISMATCH",
      participantId: normalizedParticipantId,
      capability: normalizedCapability,
      jobId: normalizedJobId,
      concernId: normalizedConcernId,
      evaluationId: normalizedEvaluationId,
      approvedQuoteDecisionId: normalizedApprovedQuoteDecisionId,
      allowJobScope: allowJobScope === true,
      allowEvaluationVisitScope: allowEvaluationVisitScope === true,
    });
  }
  return granted;
}

async function loadActorParticipant(client, actorUserId, jobId) {
  const result = await client.query(
    `
    /* lifecycle_authority:actor_participant */
    SELECT id, job_id, request_relationship_id, user_id
    FROM relationship_participants
    WHERE user_id = $1
      AND job_id = $2
    LIMIT 1
    `,
    [actorUserId, jobId]
  );
  return result.rows[0] || null;
}

async function requireManagementAuthority({
  client,
  authenticatedActor,
  jobId,
  capability,
  logger = console,
  denialCode = "LIFECYCLE_AUTHORITY_DENIED",
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const normalizedJobId = uuid(jobId);
  if (!actorUserId) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  if (!normalizedJobId) {
    return failure(400, "INVALID_JOB_ID", "A valid Job ID is required.");
  }

  const participant = await loadActorParticipant(
    client,
    actorUserId,
    normalizedJobId
  );
  if (!participant) {
    logger.warn("Lifecycle authority command denied", {
      code: denialCode,
      actorUserId,
      jobId: normalizedJobId,
      capability,
    });
    return failure(403, "LIFECYCLE_AUTHORITY_REQUIRED", "Lifecycle authority is required.");
  }

  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: participant.id,
    capability,
    jobId: normalizedJobId,
    logger,
  });
  if (!granted) {
    logger.warn("Lifecycle authority command denied", {
      code: denialCode,
      actorUserId,
      jobId: normalizedJobId,
      capability,
    });
    return failure(403, "LIFECYCLE_AUTHORITY_REQUIRED", "Lifecycle authority is required.");
  }

  return { ok: true, participant, actorUserId, jobId: normalizedJobId };
}

async function assignParticipantRole({
  client,
  authenticatedActor,
  jobId,
  participantId,
  role,
  validUntil = null,
  sourceEvidenceType,
  sourceEvidenceReference,
  idempotencyKey,
  logger = console,
} = {}) {
  const authority = await requireManagementAuthority({
    client,
    authenticatedActor,
    jobId,
    capability: MANAGEMENT_CAPABILITIES.ASSIGN_ROLE,
    logger,
    denialCode: "PARTICIPANT_ROLE_ASSIGNMENT_DENIED",
  });
  if (!authority.ok) return authority;

  const normalizedParticipantId = uuid(participantId);
  const normalizedRole = String(role || "").trim().toUpperCase();
  if (!normalizedParticipantId) {
    return failure(400, "INVALID_PARTICIPANT_ID", "A valid participant is required.");
  }

  const result = await client.query(
    `
    /* lifecycle_authority:assign_role */
    INSERT INTO participant_role_assignments
    (
      id, participant_id, job_id, role, assigned_by_participant_id,
      valid_until, source_evidence_type, source_evidence_reference,
      idempotency_key
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [
      randomUUID(),
      normalizedParticipantId,
      authority.jobId,
      normalizedRole,
      authority.participant.id,
      validUntil,
      String(sourceEvidenceType || "").trim(),
      String(sourceEvidenceReference || "").trim(),
      String(idempotencyKey || "").trim(),
    ]
  );
  return { ok: true, status: 201, roleAssignment: result.rows[0] };
}

async function revokeParticipantRole({
  client,
  authenticatedActor,
  jobId,
  roleAssignmentId,
  revocationReason,
  sourceEvidenceType,
  sourceEvidenceReference,
  idempotencyKey,
  logger = console,
} = {}) {
  const authority = await requireManagementAuthority({
    client,
    authenticatedActor,
    jobId,
    capability: MANAGEMENT_CAPABILITIES.REVOKE_ROLE,
    logger,
    denialCode: "PARTICIPANT_ROLE_REVOCATION_DENIED",
  });
  if (!authority.ok) return authority;

  const result = await client.query(
    `
    /* lifecycle_authority:revoke_role */
    INSERT INTO participant_role_revocations
    (
      id, role_assignment_id, job_id, revoked_by_participant_id,
      revocation_reason, source_evidence_type, source_evidence_reference,
      idempotency_key
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [
      randomUUID(),
      uuid(roleAssignmentId),
      authority.jobId,
      authority.participant.id,
      String(revocationReason || "").trim(),
      String(sourceEvidenceType || "").trim(),
      String(sourceEvidenceReference || "").trim(),
      String(idempotencyKey || "").trim(),
    ]
  );
  return { ok: true, status: 201, revocation: result.rows[0] };
}

async function createLifecycleAuthorityGrant({
  client,
  authenticatedActor,
  jobId,
  granteeParticipantId,
  capability,
  scopeType = "job",
  scopeConcernId = null,
  scopeEvaluationId = null,
  validUntil = null,
  sourceEvidenceType,
  sourceEvidenceReference,
  idempotencyKey,
  logger = console,
} = {}) {
  const authority = await requireManagementAuthority({
    client,
    authenticatedActor,
    jobId,
    capability: MANAGEMENT_CAPABILITIES.CREATE_GRANT,
    logger,
    denialCode: "LIFECYCLE_GRANT_CREATION_DENIED",
  });
  if (!authority.ok) return authority;

  const result = await client.query(
    `
    /* lifecycle_authority:create_grant */
    INSERT INTO lifecycle_authority_grants
    (
      id, grantee_participant_id, grantor_participant_id, job_id,
      capability, scope_type, scope_job_id, scope_concern_id,
      scope_evaluation_id, valid_until,
      source_evidence_type, source_evidence_reference, idempotency_key
    )
    VALUES ($1, $2, $3, $4, $5, $6, $4, $7, $8, $9, $10, $11, $12)
    RETURNING *
    `,
    [
      randomUUID(),
      uuid(granteeParticipantId),
      authority.participant.id,
      authority.jobId,
      String(capability || "").trim(),
      String(scopeType || "").trim(),
      scopeConcernId == null ? null : uuid(scopeConcernId),
      scopeEvaluationId == null ? null : uuid(scopeEvaluationId),
      validUntil,
      String(sourceEvidenceType || "").trim(),
      String(sourceEvidenceReference || "").trim(),
      String(idempotencyKey || "").trim(),
    ]
  );
  return { ok: true, status: 201, authorityGrant: result.rows[0] };
}

async function revokeLifecycleAuthorityGrant({
  client,
  authenticatedActor,
  jobId,
  authorityGrantId,
  revocationReason,
  sourceEvidenceType,
  sourceEvidenceReference,
  idempotencyKey,
  logger = console,
} = {}) {
  const authority = await requireManagementAuthority({
    client,
    authenticatedActor,
    jobId,
    capability: MANAGEMENT_CAPABILITIES.REVOKE_GRANT,
    logger,
    denialCode: "LIFECYCLE_GRANT_REVOCATION_DENIED",
  });
  if (!authority.ok) return authority;

  const result = await client.query(
    `
    /* lifecycle_authority:revoke_grant */
    INSERT INTO lifecycle_authority_grant_revocations
    (
      id, authority_grant_id, job_id, revoked_by_participant_id,
      revocation_reason, source_evidence_type, source_evidence_reference,
      idempotency_key
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [
      randomUUID(),
      uuid(authorityGrantId),
      authority.jobId,
      authority.participant.id,
      String(revocationReason || "").trim(),
      String(sourceEvidenceType || "").trim(),
      String(sourceEvidenceReference || "").trim(),
      String(idempotencyKey || "").trim(),
    ]
  );
  return { ok: true, status: 201, revocation: result.rows[0] };
}

module.exports = {
  MANAGEMENT_CAPABILITIES,
  assignParticipantRole,
  createLifecycleAuthorityGrant,
  hasActiveLifecycleGrant,
  revokeParticipantRole,
  revokeLifecycleAuthorityGrant,
};
