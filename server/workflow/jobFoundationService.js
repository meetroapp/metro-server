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
const CUSTOMER_BOOTSTRAP_CAPABILITIES = Object.freeze([
  "quote.read_customer",
  "quote.approve",
  "quote.decline",
]);
const PROFESSIONAL_BOOTSTRAP_CAPABILITIES = Object.freeze([
  "evaluation.perform",
  "finding.submit",
  "finding.confirm",
  "workstream.create",
  "workstream.read",
  "finding.assign_workstream",
  "work_activity.create",
  "work_activity.progress",
  "work_activity.read",
  "work_obligation.create",
  "work_obligation.read",
  "finding.resolve",
  "work_obligation.transition",
  "workstream.complete",
  "recommendation.create",
  "recommendation.read",
  "recommendation.transition",
  "customer_constraint.record",
  "quote.create",
  "quote.read",
  "quote.scope.manage",
  "quote.issue",
  "quote.revise",
]);
const CUSTOMER_EVALUATION_VISIT_CAPABILITIES = Object.freeze([
  "visit.read",
  "visit.confirm",
  "visit.change_request",
]);
const PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES = Object.freeze([
  "visit.read",
  "visit.propose",
  "visit.confirm",
  "visit.reschedule",
  "visit.cancel",
  "visit.start",
  "visit.complete",
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

  const customerCapabilityResult = await client.query(
    `
    /* job_foundation:customer_capabilities */
    SELECT capability
    FROM lifecycle_capabilities
    WHERE capability = ANY($1::text[])
    ORDER BY capability ASC
    `,
    [[...CUSTOMER_BOOTSTRAP_CAPABILITIES]]
  );
  const professionalCapabilityResult = await client.query(
    `
    /* job_foundation:professional_capabilities */
    SELECT capability
    FROM lifecycle_capabilities
    WHERE capability = ANY($1::text[])
    ORDER BY capability ASC
    `,
    [[...PROFESSIONAL_BOOTSTRAP_CAPABILITIES]]
  );
  const registeredProfessionalCapabilities =
    professionalCapabilityResult.rows.map((row) => row.capability);
  const registeredCustomerCapabilities =
    customerCapabilityResult.rows.map((row) => row.capability);
  const evaluationVisitCapabilityResult = await client.query(
    `
    /* job_foundation:evaluation_visit_capabilities */
    SELECT capability
    FROM lifecycle_capabilities
    WHERE capability = ANY($1::text[])
      AND EXISTS (
        SELECT 1
        FROM pg_constraint constraints
        INNER JOIN pg_class relations ON relations.oid = constraints.conrelid
        INNER JOIN pg_namespace namespaces ON namespaces.oid = relations.relnamespace
        WHERE namespaces.nspname = current_schema()
          AND relations.relname = 'lifecycle_authority_grants'
          AND constraints.contype = 'c'
          AND pg_get_constraintdef(constraints.oid) LIKE '%evaluation_visit%'
      )
    ORDER BY capability ASC
    `,
    [[
      ...new Set([
        ...CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
        ...PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
      ]),
    ]]
  );
  const registeredEvaluationVisitCapabilities = new Set(
    evaluationVisitCapabilityResult.rows.map((row) => row.capability)
  );

  for (const [participantId, capabilities] of [
    [homeownerParticipantId, [
      ...BOOTSTRAP_CAPABILITIES,
      ...registeredCustomerCapabilities,
    ]],
    [professionalParticipantId, [
      ...BOOTSTRAP_CAPABILITIES,
      ...registeredProfessionalCapabilities,
    ]],
  ]) {
    for (const capability of capabilities) {
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

  for (const [participantId, role, capabilities] of [
    [
      homeownerParticipantId,
      "customer",
      CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
    ],
    [
      professionalParticipantId,
      "professional",
      PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
    ],
  ]) {
    for (const capability of capabilities) {
      if (!registeredEvaluationVisitCapabilities.has(capability)) continue;
      await client.query(
        `
        /* job_foundation:insert_evaluation_visit_grant */
        INSERT INTO lifecycle_authority_grants
        (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES (
          $1, $2, $3, $4, $5, 'evaluation_visit', $4,
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
          `selection:${selectionReference}:evaluation_visit:${role}:${capability}`,
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
    customerCapabilityCount: registeredCustomerCapabilities.length,
    professionalCapabilityCount: registeredProfessionalCapabilities.length,
    evaluationVisitCapabilityCount:
      registeredEvaluationVisitCapabilities.size,
  });

  return {
    created: true,
    job: jobResult.rows[0],
    participants: participantResult.rows,
  };
}


const BUSINESS_DOCUMENT_PROFESSIONAL_CAPABILITIES = Object.freeze([
  "participant.read",
  "quote.create",
  "quote.read",
  "quote.scope.manage",
  "quote.issue",
  "quote.revise",
  "quote.external_approval.record",
]);

async function materializeBusinessDocumentJob({
  client,
  document,
  actorUserId,
  logger = console,
} = {}) {
  const documentId = String(document?.id || "").trim();
  const contractorProfileId = Number(document?.contractor_profile_id);
  const businessContactId = document?.business_contact_id || null;
  const customerRelationshipId =
    document?.business_customer_relationship_id || null;
  const normalizedActorUserId = Number(actorUserId);

  if (
    !documentId ||
    !Number.isSafeInteger(contractorProfileId) ||
    contractorProfileId <= 0 ||
    !Number.isSafeInteger(normalizedActorUserId) ||
    normalizedActorUserId <= 0 ||
    Boolean(businessContactId) !== Boolean(customerRelationshipId)
  ) {
    throw new Error("Business-origin Job source identity is invalid.");
  }

  const owner = await client.query(
    `SELECT id
     FROM contractor_profiles
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [contractorProfileId, normalizedActorUserId]
  );
  if (!owner.rows[0]) {
    throw new Error("Business-origin Job owner is unavailable.");
  }

  const existing = await client.query(
    `SELECT jobs.*, participants.id AS professional_participant_id
     FROM jobs
     LEFT JOIN relationship_participants participants
       ON participants.job_id = jobs.id
       AND participants.user_id = $3
       AND participants.request_relationship_id IS NULL
     WHERE jobs.source_type = 'business_document'
       AND jobs.originating_business_document_id = $1
       AND jobs.contractor_profile_id = $2
     LIMIT 1
     FOR UPDATE OF jobs`,
    [documentId, contractorProfileId, normalizedActorUserId]
  );

  if (existing.rows[0]) {
    if (!existing.rows[0].professional_participant_id) {
      throw new Error(
        "Business-origin Job professional participant is unavailable."
      );
    }
    return {
      created: false,
      job: existing.rows[0],
      professionalParticipantId:
        existing.rows[0].professional_participant_id,
    };
  }

  const jobId = randomUUID();
  const professionalParticipantId = randomUUID();

  const jobResult = await client.query(
    `INSERT INTO jobs (
       id,
       created_by_user_id,
       lifecycle_contract_version,
       source_type,
       contractor_profile_id,
       business_contact_id,
       business_customer_relationship_id,
       originating_business_document_id
     )
     VALUES ($1, $2, 2, 'business_document', $3, $4, $5, $6)
     RETURNING *`,
    [
      jobId,
      normalizedActorUserId,
      contractorProfileId,
      businessContactId,
      customerRelationshipId,
      documentId,
    ]
  );

  await client.query(
    `INSERT INTO relationship_participants (
       id,
       job_id,
       request_relationship_id,
       user_id,
       identity_type,
       source_evidence_type,
       source_evidence_reference
     )
     VALUES (
       $1, $2, NULL, $3, 'authenticated_user',
       'business_document', $4
     )`,
    [
      professionalParticipantId,
      jobId,
      normalizedActorUserId,
      documentId,
    ]
  );

  await client.query(
    `INSERT INTO participant_role_assignments (
       id,
       participant_id,
       job_id,
       role,
       assigned_by_participant_id,
       source_evidence_type,
       source_evidence_reference,
       idempotency_key
     )
     VALUES (
       $1, $2, $3, 'PRIMARY_PROFESSIONAL', $2,
       'business_document', $4, $5
     )`,
    [
      randomUUID(),
      professionalParticipantId,
      jobId,
      documentId,
      `business-document:${documentId}:role:primary-professional`,
    ]
  );

  const capabilityResult = await client.query(
    `SELECT capability
     FROM lifecycle_capabilities
     WHERE capability = ANY($1::text[])
     ORDER BY capability ASC`,
    [[...BUSINESS_DOCUMENT_PROFESSIONAL_CAPABILITIES]]
  );

  const registeredCapabilities =
    capabilityResult.rows.map((row) => row.capability);

  for (const capability of registeredCapabilities) {
    await client.query(
      `INSERT INTO lifecycle_authority_grants (
         id,
         grantee_participant_id,
         grantor_participant_id,
         job_id,
         capability,
         scope_type,
         scope_job_id,
         source_evidence_type,
         source_evidence_reference,
         idempotency_key
       )
       VALUES (
         $1, $2, $2, $3, $4, 'job', $3,
         'business_document', $5, $6
       )`,
      [
        randomUUID(),
        professionalParticipantId,
        jobId,
        capability,
        documentId,
        `business-document:${documentId}:grant:${capability}`,
      ]
    );
  }

  if (businessContactId && customerRelationshipId) {
    await client.query(
      `INSERT INTO job_customer_parties (
         job_id,
         contractor_profile_id,
         business_contact_id,
         business_customer_relationship_id,
         linked_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        jobId,
        contractorProfileId,
        businessContactId,
        customerRelationshipId,
        normalizedActorUserId,
      ]
    );
  }

  logger.info("Business-origin lifecycle Job created", {
    code: "BUSINESS_DOCUMENT_JOB_CREATED",
    jobId,
    businessDocumentId: documentId,
    contractorProfileId,
    hasDurableCustomerParty:
      Boolean(businessContactId && customerRelationshipId),
    participantCount: 1,
    professionalCapabilityCount: registeredCapabilities.length,
  });

  return {
    created: true,
    job: jobResult.rows[0],
    professionalParticipantId,
  };
}

module.exports = {
  BOOTSTRAP_CAPABILITIES,
  CUSTOMER_BOOTSTRAP_CAPABILITIES,
  CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
  PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
  PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
  BUSINESS_DOCUMENT_PROFESSIONAL_CAPABILITIES,
  bootstrapLifecycleJob,
  materializeBusinessDocumentJob,
};
