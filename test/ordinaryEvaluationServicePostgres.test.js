"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { createJobRequest } = require("../server/requests/jobRequestCreateService");
const { submitProfessionalResponse } = require("../server/relationships/professionalResponseService");
const { selectProfessionalResponse } = require("../server/relationships/requestSelectionService");
const { bootstrapLifecycleJob } = require("../server/workflow/jobFoundationService");
const { hasActiveLifecycleGrant } = require("../server/authorization/lifecycleAuthorityService");
const {
  completeEvaluation,
  createEvaluation,
  createOrdinaryJobEvaluation,
  getEvaluation,
  listEvaluationsForJob,
  updateEvaluationDraft,
} = require("../server/authorization/evaluationService");
const {
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");
const {
  visitServiceInternals,
} = require("../server/workflow/visitService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.ORDINARY_EVALUATION_RUNTIME_DATABASE_URL;

function targetMetadata() {
  const database = assertSafeTestDatabaseUrl(databaseUrl, {
    nodeEnv: process.env.NODE_ENV,
  });
  return { target: "local-test", database };
}

function requestPayload(description) {
  return {
    title: "Appliance inspection",
    description,
    category: "appliance_repair",
    request_category: "appliance_repair",
    service_domain: "home_services",
    service_specialty: "appliance_repair",
    location: "Cape Coral, FL 33904",
    location_intake_mode: "address_after_selection",
    service_address_line1: null,
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    unit_number: "",
    access_notes: "",
    request_photos: [],
  };
}

function evaluationContent(observations) {
  return {
    serviceType: "appliance_repair",
    evaluationContext: "ordinary_job",
    observations,
    measurements: [],
    findings: [],
    diagnosisSummary: "",
    limitations: "",
    scopeRecommendations: [],
    relevantConditions: [],
    supportingMediaReferences: [],
    internalNotes: "",
  };
}

async function createIdentities(client, suffix) {
  const homeowner = await client.query(
    `
    INSERT INTO users (username, email, password_hash, role, account_type)
    VALUES ('Runtime Homeowner', $1, 'test-only-hash', 'homeowner', 'homeowner')
    RETURNING id
    `,
    [`ordinary-runtime-homeowner-${suffix}@example.test`]
  );
  const professional = await client.query(
    `
    INSERT INTO users (username, email, password_hash, role, account_type)
    VALUES ('Runtime Professional', $1, 'test-only-hash',
      'appliance_repair', 'professional')
    RETURNING id
    `,
    [`ordinary-runtime-professional-${suffix}@example.test`]
  );
  const otherProfessional = await client.query(
    `
    INSERT INTO users (username, email, password_hash, role, account_type)
    VALUES ('Other Professional', $1, 'test-only-hash',
      'appliance_repair', 'professional')
    RETURNING id
    `,
    [`ordinary-runtime-other-${suffix}@example.test`]
  );
  const profiles = [];
  for (const [userId, name] of [
    [professional.rows[0].id, "Runtime Appliance Service"],
    [otherProfessional.rows[0].id, "Other Appliance Service"],
  ]) {
    const profile = await client.query(
      `
      INSERT INTO contractor_profiles
        (user_id, business_name, category, location, profile_details)
      VALUES ($1, $2, 'appliance_repair', 'Cape Coral', $3::jsonb)
      RETURNING id
      `,
      [
        userId,
        name,
        JSON.stringify({
          service_area: "Cape Coral",
          service_specialties: ["appliance_repair"],
        }),
      ]
    );
    profiles.push(Number(profile.rows[0].id));
  }
  return {
    homeownerId: Number(homeowner.rows[0].id),
    professionalId: Number(professional.rows[0].id),
    otherProfessionalId: Number(otherProfessional.rows[0].id),
    contractorId: profiles[0],
  };
}

async function createLifecycleFixture(pool, identities, label) {
  const created = await createJobRequest({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    payload: requestPayload(`original concern ${label}`),
    idempotencyKey: randomUUID(),
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
    logger: { info() {}, warn() {} },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const response = await submitProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "I can inspect this appliance." },
    idempotencyKey: `ordinary-response-${label}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true);
  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: `ordinary-selection-${label}`,
    lifecycleJobBootstrap: (input) => bootstrapLifecycleJob({
      ...input,
      logger: { info() {}, warn() {} },
    }),
  });
  assert.equal(selection.ok, true);
  const context = await pool.query(
    `
    SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationship_participants.id AS professional_participant_id
    FROM jobs
    INNER JOIN relationship_participants
      ON relationship_participants.job_id = jobs.id
      AND relationship_participants.user_id = $2
    WHERE jobs.id = $1
    `,
    [selection.lifecycleJob.id, identities.professionalId]
  );
  return {
    jobId: context.rows[0].job_id,
    requestId: Number(context.rows[0].job_request_id),
    relationshipId: Number(context.rows[0].relationship_id),
    professionalParticipantId: context.rows[0].professional_participant_id,
    concernId: created.reportedConcern.id,
    originalConcern: created.reportedConcern.originalText,
  };
}

async function revokeEvaluationGrant(client, fixture, label) {
  const grant = await client.query(
    `
    SELECT id, grantee_participant_id, grantor_participant_id
    FROM lifecycle_authority_grants
    WHERE job_id = $1 AND capability = 'evaluation.perform'
    `,
    [fixture.jobId]
  );
  assert.equal(grant.rows.length, 1);
  await client.query(
    `
    INSERT INTO lifecycle_authority_grant_revocations (
      id, authority_grant_id, job_id, revoked_by_participant_id,
      revocation_reason, source_evidence_type, source_evidence_reference,
      idempotency_key
    )
    VALUES ($1, $2, $3, $4, 'Test revocation', 'local_certification', $5, $6)
    `,
    [
      randomUUID(),
      grant.rows[0].id,
      fixture.jobId,
      grant.rows[0].grantor_participant_id,
      label,
      `revoke-${label}`,
    ]
  );
  return grant.rows[0];
}

async function createEmergencyContext(client, identities) {
  const emergency = await client.query(
    `
    INSERT INTO emergency_requests (
      homeowner_id, category, service_domain, service_specialty,
      title, description, location_text, status, requested_at, arrived_at
    )
    VALUES ($1, 'appliance_repair', 'home_services', 'appliance_repair',
      'Emergency inspection', 'Emergency runtime regression', 'Cape Coral',
      'professional_arrived', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id
    `,
    [identities.homeownerId]
  );
  const relationship = await client.query(
    `
    INSERT INTO request_relationships (
      post_id, emergency_request_id, homeowner_id, contractor_id,
      professional_user_id, status, introduction_text
    )
    VALUES (NULL, $1, $2, $3, $4, 'active', 'Emergency runtime regression')
    RETURNING id
    `,
    [
      emergency.rows[0].id,
      identities.homeownerId,
      identities.contractorId,
      identities.professionalId,
    ]
  );
  return {
    type: "emergency_request",
    emergencyRequestId: Number(emergency.rows[0].id),
    relationshipId: Number(relationship.rows[0].id),
  };
}

test(
  "disposable PostgreSQL certifies ordinary Evaluation authority without downstream expansion",
  { skip: !databaseUrl },
  async () => {
    targetMetadata();
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const suffix = randomUUID();
    const events = [];
    const logger = {
      info(message, metadata) { events.push({ level: "info", message, metadata }); },
      warn(message, metadata) { events.push({ level: "warn", message, metadata }); },
    };

    try {
      const migrated = await runMigrationCollection(
        pool,
        getMigrationFiles(),
        targetMetadata()
      );
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, 64);

      const identities = await createIdentities(pool, suffix);
      const legacy = await pool.query(
        `
        INSERT INTO posts (user_id, title, description, category, location)
        VALUES ($1, 'Legacy request', 'Legacy concern', 'handyman', 'Cape Coral')
        RETURNING id, lifecycle_contract_version
        `,
        [identities.homeownerId]
      );
      assert.equal(Number(legacy.rows[0].lifecycle_contract_version), 1);

      const fixture = await createLifecycleFixture(pool, identities, `${suffix}-primary`);
      const bootstrap = await pool.query(
        `
        SELECT
          (SELECT count(*) FROM relationship_participants WHERE job_id = $1)::integer AS participants,
          (SELECT count(*) FROM participant_role_assignments WHERE job_id = $1)::integer AS roles,
          (SELECT count(*) FROM lifecycle_authority_grants WHERE job_id = $1)::integer AS grants,
          (SELECT count(*) FROM lifecycle_authority_grants AS grants
            INNER JOIN relationship_participants AS participants
              ON participants.id = grants.grantee_participant_id
            WHERE grants.job_id = $1
              AND grants.capability = 'evaluation.perform'
              AND participants.user_id = $2)::integer AS professional_evaluation_grants,
          (SELECT count(*) FROM lifecycle_authority_grants AS grants
            INNER JOIN relationship_participants AS participants
              ON participants.id = grants.grantee_participant_id
            WHERE grants.job_id = $1
              AND grants.capability = 'evaluation.perform'
              AND participants.user_id = $3)::integer AS homeowner_evaluation_grants
        `,
        [fixture.jobId, identities.professionalId, identities.homeownerId]
      );
      assert.deepEqual(bootstrap.rows[0], {
        participants: 2,
        roles: 2,
        grants: 41,
        professional_evaluation_grants: 1,
        homeowner_evaluation_grants: 0,
      });

      const createInput = {
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        content: evaluationContent("Inspected disposal and drain connection."),
        expectedVersion: 0,
        idempotencyKey: `ordinary-evaluation-create-${suffix}`,
        logger,
      };
      const created = await createOrdinaryJobEvaluation(createInput);
      assert.equal(created.ok, true);
      assert.equal(created.status, 201);
      assert.equal(created.aggregate.sourceContext.type, "ordinary_job");
      assert.equal(created.aggregate.sourceContext.jobId, fixture.jobId);
      assert.deepEqual(created.evaluation.content.findings, []);
      assert.deepEqual(created.evaluation.content.scopeRecommendations, []);

      const replay = await createOrdinaryJobEvaluation(createInput);
      assert.equal(replay.replayed, true);
      assert.equal(replay.evaluation.id, created.evaluation.id);

      const updated = await updateEvaluationDraft({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        expectedVersion: 1,
        content: evaluationContent("Documented drainage behavior after inspection."),
        idempotencyKey: `ordinary-evaluation-update-${suffix}`,
        logger,
      });
      assert.equal(updated.ok, true);
      assert.equal(updated.aggregate.version, 2);

      const read = await getEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        logger,
      });
      assert.equal(read.ok, true);
      assert.equal(read.evaluation.reportedConcerns.length, 1);
      assert.equal(read.evaluation.reportedConcerns[0].id, fixture.concernId);
      assert.equal(
        read.evaluation.reportedConcerns[0].originalText,
        fixture.originalConcern
      );

      const listed = await listEvaluationsForJob({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        logger,
      });
      assert.equal(listed.ok, true);
      assert.equal(listed.evaluations.length, 1);

      const omittedMode = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        expectedVersion: 2,
        idempotencyKey: `ordinary-evaluation-complete-without-mode-${suffix}`,
        logger,
      });
      assert.equal(omittedMode.code, "COMPLETED_EVALUATION_VISIT_REQUIRED");

      const completed = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        expectedVersion: 2,
        completionMode: "REMOTE",
        assessmentMethod: "PHONE",
        assessmentBasis:
          "Reviewed the appliance symptoms and operating history with the customer by phone.",
        idempotencyKey: `ordinary-evaluation-complete-${suffix}`,
        logger,
      });
      assert.equal(completed.ok, true);
      assert.equal(completed.evaluation.status, "completed");
      assert.equal(completed.evaluation.completionMode, "REMOTE");
      assert.equal(completed.evaluation.assessmentMethod, "PHONE");
      assert.equal(
        completed.evaluation.assessmentBasis,
        "Reviewed the appliance symptoms and operating history with the customer by phone."
      );
      assert.equal(completed.aggregate.version, 3);
      assert.equal(completed.evaluation.capabilities.quoteReady, false);
      const completedReplay = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        expectedVersion: 2,
        completionMode: "REMOTE",
        assessmentMethod: "PHONE",
        assessmentBasis:
          "Reviewed the appliance symptoms and operating history with the customer by phone.",
        idempotencyKey: `ordinary-evaluation-complete-${suffix}`,
        logger,
      });
      assert.equal(completedReplay.replayed, true);

      const provenance = await pool.query(
        `SELECT remote.evaluation_id, remote.evaluation_version,
          remote.job_id, remote.professional_participant_id,
          remote.assessment_method, remote.assessment_basis,
          remote.completion_command_idempotency_id,
          commands.command_name, commands.command_scope,
          commands.aggregate_id, commands.completed_at,
          (SELECT count(*) FROM canonical_visits WHERE job_id = $2)::integer
            AS visit_count
         FROM canonical_evaluation_remote_provenance remote
         INNER JOIN commercial_command_idempotency commands
           ON commands.id = remote.completion_command_idempotency_id
         WHERE remote.evaluation_id = $1`,
        [created.evaluation.id, fixture.jobId]
      );
      assert.deepEqual(provenance.rows[0], {
        evaluation_id: created.evaluation.id,
        evaluation_version: 3,
        job_id: fixture.jobId,
        professional_participant_id: fixture.professionalParticipantId,
        assessment_method: "PHONE",
        assessment_basis:
          "Reviewed the appliance symptoms and operating history with the customer by phone.",
        completion_command_idempotency_id:
          provenance.rows[0].completion_command_idempotency_id,
        command_name: "evaluation.complete",
        command_scope: `evaluation:${created.evaluation.id}`,
        aggregate_id: created.evaluation.id,
        completed_at: provenance.rows[0].completed_at,
        visit_count: 0,
      });

      const professionalRead = await getEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        logger,
      });
      assert.equal(professionalRead.evaluation.completionMode, "REMOTE");
      assert.equal(professionalRead.evaluation.assessmentMethod, "PHONE");
      assert.match(professionalRead.evaluation.assessmentBasis, /operating history/);

      const quoteGate = await quoteDraftServiceInternals.requireSavedEvaluation({
        client: pool,
        context: {
          job_id: fixture.jobId,
          job_request_id: fixture.requestId,
          relationship_id: fixture.relationshipId,
          actor_user_id: identities.professionalId,
          actor_participant_id: fixture.professionalParticipantId,
        },
        logger,
      });
      assert.equal(quoteGate, null);

      const physicalLinkAfterRemote =
        await visitServiceInternals.linkDraftEvaluationOnVisitCompletion({
          client: pool,
          context: {
            canonical_evaluation_id: created.evaluation.id,
            canonical_evaluation_status: "completed",
          },
          visitId: randomUUID(),
          jobId: fixture.jobId,
          participantId: fixture.professionalParticipantId,
          idempotencyKey: `remote-physical-link-conflict-${suffix}`,
        });
      assert.equal(
        physicalLinkAfterRemote.error.code,
        "EVALUATION_REMOTE_PROVENANCE_CONFLICT"
      );

      for (const changed of [
        { completionMode: "PHYSICAL" },
        {
          completionMode: "REMOTE",
          assessmentMethod: "VIDEO",
          assessmentBasis:
            "Reviewed the appliance symptoms and operating history with the customer by phone.",
        },
        {
          completionMode: "REMOTE",
          assessmentMethod: "PHONE",
          assessmentBasis: "A changed professional basis.",
        },
      ]) {
        const conflict = await completeEvaluation({
          pool,
          authenticatedActor: { id: identities.professionalId },
          evaluationId: created.evaluation.id,
          expectedVersion: 2,
          idempotencyKey: `ordinary-evaluation-complete-${suffix}`,
          logger,
          ...changed,
        });
        assert.equal(conflict.code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
      }

      const secondCompletion = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        expectedVersion: 3,
        completionMode: "REMOTE",
        assessmentMethod: "PHONE",
        assessmentBasis: "A second completion attempt.",
        idempotencyKey: `ordinary-evaluation-complete-second-${suffix}`,
        logger,
      });
      assert.equal(secondCompletion.code, "EVALUATION_COMPLETED");

      for (const assessmentMethod of [
        "VIDEO",
        "CUSTOMER_PHOTOS",
        "DOCUMENT_REVIEW",
        "OTHER_REMOTE",
      ]) {
        const methodFixture = await createLifecycleFixture(
          pool,
          identities,
          `${suffix}-${assessmentMethod.toLowerCase()}`
        );
        const methodDraft = await createOrdinaryJobEvaluation({
          ...createInput,
          jobId: methodFixture.jobId,
          content: evaluationContent(`Prepared ${assessmentMethod} assessment.`),
          idempotencyKey: `ordinary-evaluation-create-${assessmentMethod}-${suffix}`,
        });
        const methodCompletion = await completeEvaluation({
          pool,
          authenticatedActor: { id: identities.professionalId },
          evaluationId: methodDraft.evaluation.id,
          expectedVersion: 1,
          completionMode: "REMOTE",
          assessmentMethod,
          assessmentBasis: `Professional completed the ${assessmentMethod} assessment.`,
          idempotencyKey: `ordinary-evaluation-complete-${assessmentMethod}-${suffix}`,
          logger,
        });
        assert.equal(methodCompletion.ok, true);
        assert.equal(methodCompletion.evaluation.assessmentMethod, assessmentMethod);
      }

      const staleFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-stale-completion`
      );
      const staleDraft = await createOrdinaryJobEvaluation({
        ...createInput,
        jobId: staleFixture.jobId,
        idempotencyKey: `ordinary-evaluation-create-stale-${suffix}`,
      });
      const staleCompletion = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: staleDraft.evaluation.id,
        expectedVersion: 2,
        completionMode: "REMOTE",
        assessmentMethod: "PHONE",
        assessmentBasis: "Stale completion attempt.",
        idempotencyKey: `ordinary-evaluation-complete-stale-${suffix}`,
        logger,
      });
      assert.equal(staleCompletion.code, "STALE_EVALUATION_VERSION");

      const atomicFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-atomic-rollback`
      );
      const atomicDraft = await createOrdinaryJobEvaluation({
        ...createInput,
        jobId: atomicFixture.jobId,
        idempotencyKey: `ordinary-evaluation-create-atomic-${suffix}`,
      });
      await pool.query(
        `INSERT INTO canonical_evaluation_provenance_claims (
           evaluation_id, provenance_kind
         ) VALUES ($1, 'PHYSICAL')`,
        [atomicDraft.evaluation.id]
      );
      const atomicKey = `ordinary-evaluation-complete-atomic-${suffix}`;
      const atomicFailure = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: atomicDraft.evaluation.id,
        expectedVersion: 1,
        completionMode: "REMOTE",
        assessmentMethod: "VIDEO",
        assessmentBasis: "Forced provenance conflict for transaction rollback.",
        idempotencyKey: atomicKey,
        logger,
      });
      assert.equal(
        atomicFailure.code,
        "REMOTE_EVALUATION_PHYSICAL_PROVENANCE_CONFLICT"
      );
      const atomicState = await pool.query(
        `SELECT evaluations.status, aggregates.current_version,
          (SELECT count(*) FROM canonical_evaluation_versions versions
           WHERE versions.evaluation_id = evaluations.id)::integer AS versions,
          (SELECT count(*) FROM canonical_evaluation_remote_provenance remote
           WHERE remote.evaluation_id = evaluations.id)::integer AS remote_rows,
          (SELECT count(*) FROM commercial_command_idempotency commands
           WHERE commands.command_name = 'evaluation.complete'
             AND commands.idempotency_key = $2)::integer AS completion_commands
         FROM canonical_evaluations evaluations
         INNER JOIN commercial_authority_aggregates aggregates
           ON aggregates.id = evaluations.id
         WHERE evaluations.id = $1`,
        [atomicDraft.evaluation.id, atomicKey]
      );
      assert.deepEqual(atomicState.rows[0], {
        status: "draft",
        current_version: 1,
        versions: 1,
        remote_rows: 0,
        completion_commands: 0,
      });

      const completedEdit = await updateEvaluationDraft({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: created.evaluation.id,
        expectedVersion: 3,
        content: evaluationContent("Attempted overwrite."),
        idempotencyKey: `ordinary-evaluation-completed-edit-${suffix}`,
        logger,
      });
      assert.equal(completedEdit.code, "EVALUATION_COMPLETED");

      for (const actorId of [
        identities.homeownerId,
        identities.otherProfessionalId,
      ]) {
        const denied = await createOrdinaryJobEvaluation({
          ...createInput,
          authenticatedActor: { id: actorId },
          idempotencyKey: `ordinary-evaluation-denied-${actorId}-${suffix}`,
        });
        assert.equal(denied.code, "EVALUATION_UNAVAILABLE");
      }
      const homeownerRead = await getEvaluation({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        evaluationId: created.evaluation.id,
        logger,
      });
      assert.equal(homeownerRead.code, "EVALUATION_UNAVAILABLE");
      assert.doesNotMatch(
        JSON.stringify(homeownerRead),
        /operating history|assessmentBasis|assessment_basis/i
      );

      const browserDeclaredV2 = await createEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        sourceContext: {
          type: "ordinary_request",
          requestId: fixture.requestId,
          relationshipId: fixture.relationshipId,
        },
        content: evaluationContent("Browser-declared lifecycle authority."),
        expectedVersion: 0,
        idempotencyKey: `browser-declared-v2-${suffix}`,
      });
      assert.equal(
        browserDeclaredV2.code,
        "ORDINARY_EVALUATION_AUTHORITY_UNAVAILABLE"
      );

      const revokedFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-revoked`
      );
      await revokeEvaluationGrant(pool, revokedFixture, `${suffix}-revoked`);
      const revoked = await createOrdinaryJobEvaluation({
        ...createInput,
        jobId: revokedFixture.jobId,
        idempotencyKey: `ordinary-revoked-${suffix}`,
      });
      assert.equal(revoked.code, "EVALUATION_AUTHORITY_REQUIRED");

      const expiredFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-expired`
      );
      const expiredBase = await revokeEvaluationGrant(
        pool,
        expiredFixture,
        `${suffix}-expired-base`
      );
      await pool.query(
        `
        INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id, valid_from, valid_until,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, $4, 'evaluation.perform', 'job', $4,
          CURRENT_TIMESTAMP - INTERVAL '2 days',
          CURRENT_TIMESTAMP - INTERVAL '1 day',
          'local_certification', $5, $6)
        `,
        [
          randomUUID(),
          expiredBase.grantee_participant_id,
          expiredBase.grantor_participant_id,
          expiredFixture.jobId,
          `${suffix}-expired`,
          `expired-${suffix}`,
        ]
      );
      assert.equal(await hasActiveLifecycleGrant({
        client: pool,
        participantId: expiredFixture.professionalParticipantId,
        capability: "evaluation.perform",
        jobId: expiredFixture.jobId,
      }), false);
      const expired = await createOrdinaryJobEvaluation({
        ...createInput,
        jobId: expiredFixture.jobId,
        idempotencyKey: `ordinary-expired-${suffix}`,
      });
      assert.equal(expired.code, "EVALUATION_AUTHORITY_REQUIRED");

      const rollbackFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-rollback`
      );
      const failingPool = {
        query(sql, values) { return pool.query(sql, values); },
        async connect() {
          const client = await pool.connect();
          return {
            async query(sql, values) {
              if (/INSERT INTO canonical_evaluation_job_subjects/i.test(sql)) {
                throw new Error("forced subject persistence failure");
              }
              return client.query(sql, values);
            },
            release() { client.release(); },
          };
        },
      };
      await assert.rejects(
        createOrdinaryJobEvaluation({
          ...createInput,
          pool: failingPool,
          jobId: rollbackFixture.jobId,
          idempotencyKey: `ordinary-rollback-${suffix}`,
        }),
        /forced subject persistence failure/
      );
      const rolledBack = await pool.query(
        `
        SELECT count(*)::integer AS evaluations
        FROM canonical_evaluations
        WHERE relationship_id = $1
        `,
        [rollbackFixture.relationshipId]
      );
      assert.equal(rolledBack.rows[0].evaluations, 0);

      const emergencyContext = await createEmergencyContext(pool, identities);
      const emergency = await createEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        sourceContext: emergencyContext,
        content: {
          ...evaluationContent("Emergency observation."),
          findings: [{
            summary: "Emergency JSON finding",
            severity: "moderate",
            customerShareable: true,
          }],
          scopeRecommendations: ["Emergency recommendation"],
        },
        expectedVersion: 0,
        idempotencyKey: `emergency-regression-${suffix}`,
      });
      assert.equal(emergency.ok, true);
      assert.equal(emergency.aggregate.sourceContext.type, "emergency_request");
      const emergencyRead = await getEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: emergency.evaluation.id,
      });
      assert.equal(emergencyRead.ok, true);

      const preservation = await pool.query(
        `
        SELECT
          (SELECT count(*) FROM schema_migrations)::integer AS ledger,
          (SELECT count(*) FROM canonical_evaluation_versions
            WHERE evaluation_id = $1)::integer AS ordinary_versions,
          (SELECT count(*) FROM canonical_evaluation_findings)::integer AS findings,
          (SELECT count(*) FROM canonical_finding_concern_links)::integer AS concern_links,
          (SELECT count(*) FROM commercial_authority_aggregates
            WHERE aggregate_type = 'quote')::integer AS quotes,
          to_regclass('public.workstreams') IS NULL AS no_workstreams,
          to_regclass('public.recommendations') IS NULL AS no_recommendations
        `,
        [created.evaluation.id]
      );
      assert.deepEqual(preservation.rows[0], {
        ledger: 64,
        ordinary_versions: 3,
        findings: 0,
        concern_links: 0,
        quotes: 0,
        no_workstreams: true,
        no_recommendations: true,
      });

      const logText = JSON.stringify(events);
      assert.match(logText, /ORDINARY_EVALUATION_CREATED/);
      assert.match(logText, /ORDINARY_EVALUATION_VERSION_CREATED/);
      assert.match(logText, /ORDINARY_EVALUATION_CONFIRMED/);
      assert.match(logText, /ORDINARY_EVALUATION_AUTHORITY_DENIED/);
      assert.doesNotMatch(logText, /original concern|Cape Coral|33904/i);
    } finally {
      await pool.end();
    }
  }
);
