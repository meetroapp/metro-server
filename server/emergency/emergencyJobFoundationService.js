"use strict";

const { CUSTOMER_BOOTSTRAP_CAPABILITIES } = require("../workflow/jobFoundationService");

const {
  randomUUID,
} = require("node:crypto");

const ALLOWED_SOURCE_STATUSES =
  new Set([
    "assigned",
    "professional_en_route",
    "professional_arrived",
    "work_in_progress",
    "completed",
  ]);

const HOMEOWNER_JOB_CAPABILITIES =
  Object.freeze([
    "participant.read",
    ...CUSTOMER_BOOTSTRAP_CAPABILITIES,
  ]);

const PROFESSIONAL_JOB_CAPABILITIES =
  Object.freeze([
    "participant.read",
    "evaluation.perform",
    "quote.create",
    "quote.read",
    "quote.scope.manage",
    "quote.issue",
    "quote.revise",
  ]);

function positiveInteger(value) {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : null;
}

function validateSelectionAuthority({
  emergencyRequest,
  relationship,
}) {
  const emergencyRequestId =
    positiveInteger(
      emergencyRequest?.id
    );

  const homeownerUserId =
    positiveInteger(
      emergencyRequest?.homeowner_id
    );

  const relationshipId =
    positiveInteger(
      relationship?.id
    );

  const relationshipRequestId =
    positiveInteger(
      relationship?.emergency_request_id
    );

  const relationshipHomeownerId =
    positiveInteger(
      relationship?.homeowner_id
    );

  const contractorProfileId =
    positiveInteger(
      relationship?.contractor_id
    );

  const professionalUserId =
    positiveInteger(
      relationship?.professional_user_id
    );

  const emergencyStatus =
    String(
      emergencyRequest?.status || ""
    ).trim();

  const relationshipStatus =
    String(
      relationship?.status || ""
    ).trim();

  if (
    !emergencyRequestId ||
    !homeownerUserId ||
    !relationshipId ||
    !relationshipRequestId ||
    !relationshipHomeownerId ||
    !contractorProfileId ||
    !professionalUserId ||
    relationshipRequestId !==
      emergencyRequestId ||
    relationshipHomeownerId !==
      homeownerUserId ||
    relationship?.post_id != null ||
    relationshipStatus !== "active" ||
    !ALLOWED_SOURCE_STATUSES.has(
      emergencyStatus
    )
  ) {
    throw new Error(
      "Emergency Job foundation requires an exact selected Emergency relationship."
    );
  }

  return {
    emergencyRequestId,
    homeownerUserId,
    relationshipId,
    contractorProfileId,
    professionalUserId,
  };
}

async function ensureEmergencySelectionJob({
  client,
  emergencyRequest,
  relationship,
  logger = console,
} = {}) {
  if (
    !client ||
    typeof client.query !==
      "function"
  ) {
    throw new TypeError(
      "A database client with query() is required."
    );
  }

  const authority =
    validateSelectionAuthority({
      emergencyRequest,
      relationship,
    });

  const {
    emergencyRequestId,
    homeownerUserId,
    relationshipId,
    professionalUserId,
  } = authority;

  const existingResult =
    await client.query(
      `
      /* emergency_job_foundation:existing */
      SELECT
        jobs.*,

        homeowner_participant.id
          AS homeowner_participant_id,

        professional_participant.id
          AS professional_participant_id

      FROM jobs

      LEFT JOIN relationship_participants
        homeowner_participant
        ON homeowner_participant.job_id =
             jobs.id

       AND homeowner_participant
             .request_relationship_id =
             jobs.source_request_relationship_id

       AND homeowner_participant.user_id =
             $2

       AND homeowner_participant
             .source_evidence_type =
             'emergency_selection'

      LEFT JOIN relationship_participants
        professional_participant
        ON professional_participant.job_id =
             jobs.id

       AND professional_participant
             .request_relationship_id =
             jobs.source_request_relationship_id

       AND professional_participant.user_id =
             $3

       AND professional_participant
             .source_evidence_type =
             'emergency_selection'

      WHERE jobs.source_type =
            'emergency_request'

        AND jobs.source_emergency_request_id =
            $1

      LIMIT 1
      FOR UPDATE OF jobs
      `,
      [
        emergencyRequestId,
        homeownerUserId,
        professionalUserId,
      ]
    );

  if (existingResult.rows[0]) {
    const existing =
      existingResult.rows[0];

    if (
      Number(
        existing.created_by_user_id
      ) !== homeownerUserId ||
      Number(
        existing
          .source_request_relationship_id
      ) !== relationshipId ||
      !existing
        .homeowner_participant_id ||
      !existing
        .professional_participant_id
    ) {
      throw new Error(
        "Existing Emergency Job authority is incomplete or conflicts with the selected relationship."
      );
    }

    return {
      created: false,
      job: existing,
    };
  }

  const jobId = randomUUID();

  const homeownerParticipantId =
    randomUUID();

  const professionalParticipantId =
    randomUUID();

  const evidenceReference =
    `emergency:${emergencyRequestId}:selection:${relationshipId}`;

  const jobResult =
    await client.query(
      `
      /* emergency_job_foundation:insert_job */
      INSERT INTO jobs
      (
        id,
        job_request_id,
        source_request_selection_id,
        source_request_relationship_id,
        created_by_user_id,
        lifecycle_contract_version,
        source_type,
        contractor_profile_id,
        business_contact_id,
        business_customer_relationship_id,
        originating_business_document_id,
        source_business_customer_job_id,
        source_emergency_request_id
      )
      VALUES (
        $1,
        NULL,
        NULL,
        $2,
        $3,
        2,
        'emergency_request',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        $4
      )
      RETURNING *
      `,
      [
        jobId,
        relationshipId,
        homeownerUserId,
        emergencyRequestId,
      ]
    );

  if (!jobResult.rows[0]) {
    throw new Error(
      "Emergency Job could not be created."
    );
  }

  const participantResult =
    await client.query(
      `
      /* emergency_job_foundation:insert_participants */
      INSERT INTO relationship_participants
      (
        id,
        job_id,
        request_relationship_id,
        user_id,
        source_evidence_type,
        source_evidence_reference
      )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'emergency_selection',
          $7
        ),
        (
          $5,
          $2,
          $3,
          $6,
          'emergency_selection',
          $7
        )
      RETURNING *
      `,
      [
        homeownerParticipantId,
        jobId,
        relationshipId,
        homeownerUserId,
        professionalParticipantId,
        professionalUserId,
        evidenceReference,
      ]
    );

  if (
    participantResult.rows.length !==
    2
  ) {
    throw new Error(
      "Emergency Job participants could not be established."
    );
  }

  await client.query(
    `
    /* emergency_job_foundation:insert_roles */
    INSERT INTO participant_role_assignments
    (
      id,
      participant_id,
      job_id,
      role,
      assigned_by_participant_id,
      source_evidence_type,
      source_evidence_reference,
      idempotency_key
    )
    VALUES
      (
        $1,
        $2,
        $3,
        'CUSTOMER_REPRESENTATIVE',
        $2,
        'emergency_selection',
        $4,
        $5
      ),
      (
        $6,
        $7,
        $3,
        'PRIMARY_PROFESSIONAL',
        $2,
        'emergency_selection',
        $4,
        $8
      )
    `,
    [
      randomUUID(),
      homeownerParticipantId,
      jobId,
      evidenceReference,
      `emergency:${emergencyRequestId}:role:customer`,
      randomUUID(),
      professionalParticipantId,
      `emergency:${emergencyRequestId}:role:professional`,
    ]
  );

  const requiredCapabilities =
    [
      ...new Set([
        ...HOMEOWNER_JOB_CAPABILITIES,
        ...PROFESSIONAL_JOB_CAPABILITIES,
      ]),
    ];

  const capabilityResult =
    await client.query(
      `
      /* emergency_job_foundation:capability */
      SELECT capability
      FROM lifecycle_capabilities
      WHERE capability = ANY($1::text[])
      ORDER BY capability ASC
      `,
      [
        requiredCapabilities,
      ]
    );

  const availableCapabilities =
    new Set(
      capabilityResult.rows.map(
        (row) => row.capability
      )
    );

  const missingCapabilities =
    requiredCapabilities.filter(
      (capability) =>
        !availableCapabilities.has(
          capability
        )
    );

  if (
    missingCapabilities.length > 0
  ) {
    throw new Error(
      "Emergency Job lifecycle authority is unavailable."
    );
  }

  for (const [
    participantId,
    capabilities,
  ] of [
    [
      homeownerParticipantId,
      HOMEOWNER_JOB_CAPABILITIES,
    ],
    [
      professionalParticipantId,
      PROFESSIONAL_JOB_CAPABILITIES,
    ],
  ]) {
    for (
      const capability
      of capabilities
    ) {
      await client.query(
        `
        /* emergency_job_foundation:insert_grant */
        INSERT INTO lifecycle_authority_grants
        (
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
          $1,
          $2,
          $3,
          $4,
          $5,
          'job',
          $4,
          'emergency_selection',
          $6,
          $7
        )
        `,
        [
          randomUUID(),
          participantId,
          homeownerParticipantId,
          jobId,
          capability,
          evidenceReference,
          `emergency:${emergencyRequestId}:grant:${participantId}:${capability}`,
        ]
      );
    }
  }

  logger.info?.(
    "Emergency canonical Job foundation created",
    {
      code:
        "EMERGENCY_JOB_FOUNDATION_CREATED",
      jobId,
      emergencyRequestId,
      relationshipId,
      participantCount: 2,
      homeownerCapabilityCount:
        HOMEOWNER_JOB_CAPABILITIES.length,
      professionalCapabilityCount:
        PROFESSIONAL_JOB_CAPABILITIES.length,
    }
  );

  return {
    created: true,
    job: jobResult.rows[0],
    participants:
      participantResult.rows,
  };
}

module.exports = {
  ensureEmergencySelectionJob,

  emergencyJobFoundationInternals:
    Object.freeze({
      validateSelectionAuthority,
    }),
};
