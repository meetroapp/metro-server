"use strict";

const { randomUUID } = require("node:crypto");

const {
  CURRENT_LIFECYCLE_CONTRACT_VERSION,
} = require("../requests/lifecycleContract");

const BOOTSTRAP_CAPABILITIES = Object.freeze([
  "reported_concern.read",
  "reported_concern.clarify",
  "participant.read",
]);

async function bootstrapLifecycleJob({
  client,
  request,
  selection,
  relationship,
  professionalUserId,
  logger = console,
} = {}) {
  if (
    Number(request?.lifecycle_contract_version) !==
    CURRENT_LIFECYCLE_CONTRACT_VERSION
  ) {
    return { created: false, job: null, participants: [] };
  }

  const concernResult = await client.query(
    `
    /* job_foundation:concern_precondition */
    SELECT id
    FROM reported_concerns
    WHERE job_request_id = $1
    ORDER BY sequence ASC
    LIMIT 1
    FOR SHARE
    `,
    [request.id]
  );
  if (!concernResult.rows[0]) {
    throw new Error("Lifecycle-v2 Job creation requires preserved Reported Concern truth.");
  }

  const jobId = randomUUID();
  const homeownerParticipantId = randomUUID();
  const professionalParticipantId = randomUUID();
  const selectionReference = String(selection.id);

  const jobResult = await client.query(
    `
    /* job_foundation:insert_job */
    INSERT INTO jobs
    (
      id, job_request_id, source_request_selection_id,
      source_request_relationship_id, created_by_user_id,
      lifecycle_contract_version
    )
    VALUES ($1, $2, $3, $4, $5, 2)
    RETURNING *
    `,
    [
      jobId,
      request.id,
      selection.id,
      relationship.id,
      request.user_id,
    ]
  );

  const participantResult = await client.query(
    `
    /* job_foundation:insert_participants */
    INSERT INTO relationship_participants
    (
      id, job_id, request_relationship_id, user_id,
      source_evidence_type, source_evidence_reference
    )
    VALUES
      ($1, $2, $3, $4, 'request_selection', $6),
      ($5, $2, $3, $7, 'request_selection', $6)
    RETURNING *
    `,
    [
      homeownerParticipantId,
      jobId,
      relationship.id,
      request.user_id,
      professionalParticipantId,
      selectionReference,
      professionalUserId,
    ]
  );

  await client.query(
    `
    /* job_foundation:insert_roles */
    INSERT INTO participant_role_assignments
    (
      id, participant_id, job_id, role, assigned_by_participant_id,
      source_evidence_type, source_evidence_reference, idempotency_key
    )
    VALUES
      ($1, $2, $3, 'CUSTOMER_REPRESENTATIVE', $2,
       'request_selection', $4, $5),
      ($6, $7, $3, 'PRIMARY_PROFESSIONAL', $2,
       'request_selection', $4, $8)
    `,
    [
      randomUUID(),
      homeownerParticipantId,
      jobId,
      selectionReference,
      `selection:${selectionReference}:role:customer_representative`,
      randomUUID(),
      professionalParticipantId,
      `selection:${selectionReference}:role:primary_professional`,
    ]
  );

  for (const participantId of [
    homeownerParticipantId,
    professionalParticipantId,
  ]) {
    for (const capability of BOOTSTRAP_CAPABILITIES) {
      await client.query(
        `
        /* job_foundation:insert_grant */
        INSERT INTO lifecycle_authority_grants
        (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES (
          $1, $2, $3, $4, $5, 'job', $4,
          'request_selection', $6, $7
        )
        `,
        [
          randomUUID(),
          participantId,
          homeownerParticipantId,
          jobId,
          capability,
          selectionReference,
          `selection:${selectionReference}:grant:${participantId}:${capability}`,
        ]
      );
    }
  }

  logger.info("Lifecycle Job foundation created", {
    code: "LIFECYCLE_JOB_CREATED",
    jobId,
    requestId: Number(request.id),
    relationshipId: Number(relationship.id),
    selectionId: String(selection.id),
    participantCount: 2,
  });

  return {
    created: true,
    job: jobResult.rows[0],
    participants: participantResult.rows,
  };
}

module.exports = {
  BOOTSTRAP_CAPABILITIES,
  bootstrapLifecycleJob,
};
