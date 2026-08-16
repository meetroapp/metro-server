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
const {
  completeEvaluation,
  createEvaluation,
  createOrdinaryJobEvaluation,
  getEvaluation,
  updateEvaluationDraft,
} = require("../server/authorization/evaluationService");
const {
  addFindingEvidenceReference,
  confirmFinding,
  getFinding,
  linkFindingConcern,
  listEvaluationFindings,
  submitFinding,
  updateFinding,
} = require("../server/authorization/findingService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.FINDING_AUTHORITY_DATABASE_URL;

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

function evaluationContent(observations = "Inspected appliance and drainage behavior.") {
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
  const users = {};
  for (const [key, accountType] of [
    ["homeowner", "homeowner"],
    ["professional", "professional"],
    ["otherProfessional", "professional"],
  ]) {
    const result = await client.query(
      `
      INSERT INTO users (username, email, password_hash, role, account_type)
      VALUES ($1, $2, 'test-only-hash', $3, $4)
      RETURNING id
      `,
      [
        `Finding ${key}`,
        `finding-${key}-${suffix}@example.test`,
        accountType === "homeowner" ? "homeowner" : "appliance_repair",
        accountType,
      ]
    );
    users[`${key}Id`] = Number(result.rows[0].id);
  }
  const profiles = [];
  for (const userId of [users.professionalId, users.otherProfessionalId]) {
    const profile = await client.query(
      `
      INSERT INTO contractor_profiles
        (user_id, business_name, category, location, profile_details)
      VALUES ($1, $2, 'appliance_repair', 'Cape Coral', $3::jsonb)
      RETURNING id
      `,
      [
        userId,
        `Finding Appliance Service ${userId}`,
        JSON.stringify({
          service_area: "Cape Coral",
          service_specialties: ["appliance_repair"],
        }),
      ]
    );
    profiles.push(Number(profile.rows[0].id));
  }
  return { ...users, contractorId: profiles[0] };
}

async function createLifecycleFixture(pool, identities, label, description) {
  const created = await createJobRequest({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    payload: requestPayload(description),
    idempotencyKey: randomUUID(),
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const response = await submitProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "I can inspect this appliance." },
    idempotencyKey: `finding-response-${label}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true);
  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: `finding-selection-${label}`,
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

async function createOrdinaryEvaluation(pool, identities, fixture, label) {
  const result = await createOrdinaryJobEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    content: evaluationContent(),
    expectedVersion: 0,
    idempotencyKey: `finding-evaluation-${label}`,
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

async function revokeCapability(client, fixture, capability, label) {
  const grant = await client.query(
    `
    SELECT id, grantee_participant_id, grantor_participant_id
    FROM lifecycle_authority_grants
    WHERE job_id = $1 AND capability = $2
    `,
    [fixture.jobId, capability]
  );
  assert.equal(grant.rows.length, 1);
  await client.query(
    `
    INSERT INTO lifecycle_authority_grant_revocations (
      id, authority_grant_id, job_id, revoked_by_participant_id,
      revocation_reason, source_evidence_type, source_evidence_reference,
      idempotency_key
    )
    VALUES ($1, $2, $3, $4, 'Local certification',
      'local_certification', $5, $6)
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
      'Emergency inspection', 'Emergency Finding regression', 'Cape Coral',
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
    VALUES (NULL, $1, $2, $3, $4, 'active', 'Emergency regression')
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
  "disposable PostgreSQL certifies first-class Finding authority and concern linkage",
  { skip: !databaseUrl },
  async () => {
    targetMetadata();
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    const events = [];
    const logger = {
      info(message, metadata) { events.push({ level: "info", message, metadata }); },
      warn(message, metadata) { events.push({ level: "warn", message, metadata }); },
    };

    try {
      const migrations = await runMigrationCollection(
        pool,
        getMigrationFiles(),
        targetMetadata()
      );
      assert.equal(migrations.success, true, JSON.stringify(migrations));
      assert.equal(migrations.applied.length, 44);
      const migrationReplay = await runMigrationCollection(
        pool,
        getMigrationFiles(),
        targetMetadata()
      );
      assert.equal(migrationReplay.success, true, JSON.stringify(migrationReplay));
      assert.equal(migrationReplay.applied.length, 0);
      assert.equal(migrationReplay.skipped.length, 44);
      const identities = await createIdentities(pool, suffix);
      const fixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-acceptance`,
        "dishwasher issue"
      );
      const evaluation = await createOrdinaryEvaluation(
        pool,
        identities,
        fixture,
        `${suffix}-acceptance`
      );
      const completed = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: evaluation.evaluation.id,
        expectedVersion: 1,
        idempotencyKey: `finding-evaluation-complete-${suffix}`,
        logger,
      });
      assert.equal(completed.ok, true);
      assert.equal(completed.evaluation.status, "completed");
      const evaluationBefore = await pool.query(
        `
        SELECT count(*)::integer AS versions,
          max(observations) AS observations,
          (SELECT count(*) FROM lifecycle_authority_grants
            WHERE job_id = $2
              AND (capability LIKE 'quote.%'
                OR capability LIKE 'approval.%'))::integer AS downstream_grants
        FROM canonical_evaluation_versions
        WHERE evaluation_id = $1
        `,
        [evaluation.evaluation.id, fixture.jobId]
      );

      const submitInput = {
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: evaluation.evaluation.id,
        statement: "garbage disposal and drainage fault",
        customerVisible: true,
        idempotencyKey: `finding-submit-${suffix}`,
        logger,
      };
      const proposed = await submitFinding(submitInput);
      assert.equal(proposed.ok, true);
      assert.equal(proposed.finding.confirmationState, "PROPOSED");
      assert.equal(proposed.finding.resolutionState, "OPEN");
      assert.equal(proposed.finding.currentVersion, 1);
      const submitReplay = await submitFinding(submitInput);
      assert.equal(submitReplay.replayed, true);
      assert.equal(submitReplay.finding.id, proposed.finding.id);
      const submitConflict = await submitFinding({
        ...submitInput,
        statement: "different semantic statement",
      });
      assert.equal(submitConflict.code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");

      const updateInput = {
        pool,
        authenticatedActor: { id: identities.professionalId },
        findingId: proposed.finding.id,
        expectedVersion: 1,
        statement: "possible garbage disposal and drainage fault",
        customerVisible: true,
        idempotencyKey: `finding-update-${suffix}`,
        logger,
      };
      const updated = await updateFinding(updateInput);
      assert.equal(updated.ok, true);
      assert.equal(updated.finding.currentVersion, 2);
      assert.equal(updated.finding.confirmationState, "PROPOSED");
      assert.equal(updated.finding.resolutionState, "OPEN");
      assert.equal(updated.finding.customerVisible, true);
      assert.equal((await updateFinding(updateInput)).replayed, true);
      assert.equal((await updateFinding({
        ...updateInput,
        expectedVersion: 1,
        idempotencyKey: `finding-update-stale-${suffix}`,
      })).code, "STALE_FINDING_VERSION");

      const linkInput = {
        pool,
        authenticatedActor: { id: identities.professionalId },
        findingId: proposed.finding.id,
        concernId: fixture.concernId,
        relationshipType: "EXPLAINS",
        idempotencyKey: `finding-link-${suffix}`,
        logger,
      };
      const linked = await linkFindingConcern(linkInput);
      assert.equal(linked.ok, true);
      assert.equal(linked.finding.concernLinks.length, 1);
      assert.equal(linked.finding.concernLinks[0].relationshipType, "EXPLAINS");
      assert.equal((await linkFindingConcern(linkInput)).replayed, true);
      const duplicateLink = await linkFindingConcern({
        ...linkInput,
        idempotencyKey: `finding-link-duplicate-${suffix}`,
      });
      assert.equal(duplicateLink.code, "FINDING_CONCERN_LINK_FOUND");
      assert.equal(duplicateLink.finding.concernLinks.length, 1);
      const linkConflict = await linkFindingConcern({
        ...linkInput,
        relationshipType: "RELATED",
      });
      assert.equal(linkConflict.code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");

      const otherFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-cross-request`,
        "unrelated request concern"
      );
      const crossRequest = await linkFindingConcern({
        ...linkInput,
        concernId: otherFixture.concernId,
        idempotencyKey: `finding-cross-request-${suffix}`,
      });
      assert.equal(crossRequest.code, "FINDING_CONCERN_SCOPE_MISMATCH");

      const evidenceInput = {
        pool,
        authenticatedActor: { id: identities.professionalId },
        findingId: proposed.finding.id,
        evidenceType: "PROFESSIONAL_OBSERVATION",
        referenceNamespace: "evaluation.observation",
        referenceId: "observation-1",
        idempotencyKey: `finding-evidence-${suffix}`,
        logger,
      };
      const evidence = await addFindingEvidenceReference(evidenceInput);
      assert.equal(evidence.ok, true);
      assert.equal(evidence.finding.evidenceReferences.length, 1);
      assert.equal((await addFindingEvidenceReference(evidenceInput)).replayed, true);
      const duplicateEvidence = await addFindingEvidenceReference({
        ...evidenceInput,
        idempotencyKey: `finding-evidence-duplicate-${suffix}`,
      });
      assert.equal(duplicateEvidence.code, "FINDING_EVIDENCE_FOUND");
      const evidenceConflict = await addFindingEvidenceReference({
        ...evidenceInput,
        referenceId: "observation-2",
      });
      assert.equal(evidenceConflict.code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");

      const readProposed = await getFinding({
        pool,
        authenticatedActor: { id: identities.professionalId },
        findingId: proposed.finding.id,
        logger,
      });
      assert.equal(readProposed.ok, true);
      const listed = await listEvaluationFindings({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: evaluation.evaluation.id,
        logger,
      });
      assert.equal(listed.findings.length, 1);

      const confirmInput = {
        pool,
        authenticatedActor: { id: identities.professionalId },
        findingId: proposed.finding.id,
        expectedVersion: 2,
        idempotencyKey: `finding-confirm-${suffix}`,
        logger,
      };
      const confirmed = await confirmFinding(confirmInput);
      assert.equal(confirmed.ok, true);
      assert.equal(confirmed.finding.confirmationState, "CONFIRMED");
      assert.equal(confirmed.finding.resolutionState, "OPEN");
      assert.equal(confirmed.finding.currentVersion, 3);
      assert.equal(confirmed.finding.versions[0].confirmationState, "PROPOSED");
      assert.equal(confirmed.finding.versions[0].statement, submitInput.statement);
      assert.equal(confirmed.finding.versions[1].statement, updateInput.statement);
      assert.equal((await confirmFinding(confirmInput)).replayed, true);
      const confirmConflict = await confirmFinding({
        ...confirmInput,
        expectedVersion: 3,
      });
      assert.equal(confirmConflict.code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");

      const immutableLink = await linkFindingConcern({
        ...linkInput,
        relationshipType: "RELATED",
        idempotencyKey: `finding-link-after-confirm-${suffix}`,
      });
      assert.equal(immutableLink.code, "FINDING_IMMUTABLE");
      const immutableEvidence = await addFindingEvidenceReference({
        ...evidenceInput,
        referenceId: "observation-after-confirm",
        idempotencyKey: `finding-evidence-after-confirm-${suffix}`,
      });
      assert.equal(immutableEvidence.code, "FINDING_IMMUTABLE");

      for (const actorId of [
        identities.homeownerId,
        identities.otherProfessionalId,
      ]) {
        const denied = await submitFinding({
          ...submitInput,
          authenticatedActor: { id: actorId },
          idempotencyKey: `finding-denied-${actorId}-${suffix}`,
        });
        assert.equal(denied.code, "FINDING_UNAVAILABLE");
      }
      const browserScope = await submitFinding({
        ...submitInput,
        jobId: otherFixture.jobId,
        idempotencyKey: `finding-browser-scope-${suffix}`,
      });
      assert.equal(browserScope.code, "FINDING_AUTHORITY_FIELD_REJECTED");

      const noConfirmFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-no-confirm`,
        "no confirm authority concern"
      );
      const noConfirmEvaluation = await createOrdinaryEvaluation(
        pool,
        identities,
        noConfirmFixture,
        `${suffix}-no-confirm`
      );
      await revokeCapability(
        pool,
        noConfirmFixture,
        "finding.confirm",
        `${suffix}-no-confirm`
      );
      const submitOnly = await submitFinding({
        ...submitInput,
        evaluationId: noConfirmEvaluation.evaluation.id,
        statement: "submit authority does not imply confirmation",
        idempotencyKey: `finding-submit-only-${suffix}`,
      });
      assert.equal(submitOnly.ok, true);
      const confirmDenied = await confirmFinding({
        ...confirmInput,
        findingId: submitOnly.finding.id,
        idempotencyKey: `finding-confirm-denied-${suffix}`,
      });
      assert.equal(confirmDenied.code, "FINDING_AUTHORITY_REQUIRED");

      const revokedFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-revoked`,
        "revoked grant concern"
      );
      const revokedEvaluation = await createOrdinaryEvaluation(
        pool,
        identities,
        revokedFixture,
        `${suffix}-revoked`
      );
      await revokeCapability(
        pool,
        revokedFixture,
        "finding.submit",
        `${suffix}-revoked`
      );
      const revoked = await submitFinding({
        ...submitInput,
        evaluationId: revokedEvaluation.evaluation.id,
        idempotencyKey: `finding-revoked-${suffix}`,
      });
      assert.equal(revoked.code, "FINDING_AUTHORITY_REQUIRED");

      const expiredFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-expired`,
        "expired grant concern"
      );
      const expiredEvaluation = await createOrdinaryEvaluation(
        pool,
        identities,
        expiredFixture,
        `${suffix}-expired`
      );
      const expiredBase = await revokeCapability(
        pool,
        expiredFixture,
        "finding.submit",
        `${suffix}-expired-base`
      );
      await pool.query(
        `
        INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id, valid_from, valid_until,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, $4, 'finding.submit', 'job', $4,
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
          `expired-finding-${suffix}`,
        ]
      );
      const expired = await submitFinding({
        ...submitInput,
        evaluationId: expiredEvaluation.evaluation.id,
        idempotencyKey: `finding-expired-${suffix}`,
      });
      assert.equal(expired.code, "FINDING_AUTHORITY_REQUIRED");

      const rollbackFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-rollback`,
        "rollback concern"
      );
      const rollbackEvaluation = await createOrdinaryEvaluation(
        pool,
        identities,
        rollbackFixture,
        `${suffix}-rollback`
      );
      const failingPool = {
        query(sql, values) { return pool.query(sql, values); },
        async connect() {
          const client = await pool.connect();
          return {
            async query(sql, values) {
              if (/INSERT INTO canonical_evaluation_finding_versions/i.test(sql)) {
                throw new Error("forced Finding version failure");
              }
              return client.query(sql, values);
            },
            release() { client.release(); },
          };
        },
      };
      await assert.rejects(
        submitFinding({
          ...submitInput,
          pool: failingPool,
          evaluationId: rollbackEvaluation.evaluation.id,
          idempotencyKey: `finding-rollback-${suffix}`,
        }),
        /forced Finding version failure/
      );
      const rollbackCount = await pool.query(
        `
        SELECT count(*)::integer AS findings
        FROM canonical_evaluation_findings
        WHERE evaluation_id = $1
        `,
        [rollbackEvaluation.evaluation.id]
      );
      assert.equal(rollbackCount.rows[0].findings, 0);

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
        idempotencyKey: `finding-emergency-${suffix}`,
      });
      assert.equal(emergency.ok, true);
      const emergencyRead = await getEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: emergency.evaluation.id,
      });
      assert.equal(emergencyRead.ok, true);
      const emergencyFinding = await submitFinding({
        ...submitInput,
        evaluationId: emergency.evaluation.id,
        idempotencyKey: `finding-emergency-denied-${suffix}`,
      });
      assert.equal(emergencyFinding.code, "FINDING_UNAVAILABLE");

      const completedEdit = await updateEvaluationDraft({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: evaluation.evaluation.id,
        expectedVersion: 2,
        content: evaluationContent("Attempted completed Evaluation rewrite."),
        idempotencyKey: `finding-evaluation-immutable-${suffix}`,
        logger,
      });
      assert.equal(completedEdit.code, "EVALUATION_COMPLETED");

      const acceptance = await pool.query(
        `
        SELECT
          reported_concerns.original_text,
          current_finding.statement,
          current_finding.confirmation_state,
          current_finding.resolution_state,
          canonical_finding_concern_links.relationship_type,
          (SELECT count(*) FROM canonical_evaluation_versions
            WHERE evaluation_id = $1)::integer AS evaluation_versions,
          (SELECT max(observations) FROM canonical_evaluation_versions
            WHERE evaluation_id = $1) AS evaluation_observations,
          (SELECT count(*) FROM commercial_authority_aggregates
            WHERE aggregate_type = 'quote')::integer AS quotes,
          (SELECT count(*) FROM lifecycle_authority_grants
            WHERE job_id = $3
              AND (capability LIKE 'quote.%'
                OR capability LIKE 'approval.%'))::integer AS downstream_grants,
          (SELECT count(*) FROM canonical_workstream_versions
            WHERE job_id = $3)::integer AS workstream_versions,
          (SELECT count(*) FROM canonical_recommendation_versions
            WHERE job_id = $3)::integer AS recommendation_versions
        FROM canonical_evaluation_finding_versions AS current_finding
        INNER JOIN canonical_finding_concern_links
          ON canonical_finding_concern_links.finding_id = current_finding.finding_id
        INNER JOIN reported_concerns
          ON reported_concerns.id = canonical_finding_concern_links.concern_id
        WHERE current_finding.finding_id = $2
          AND current_finding.version = 3
        `,
        [evaluation.evaluation.id, proposed.finding.id, fixture.jobId]
      );
      assert.deepEqual(acceptance.rows[0], {
        original_text: "dishwasher issue",
        statement: "possible garbage disposal and drainage fault",
        confirmation_state: "CONFIRMED",
        resolution_state: "OPEN",
        relationship_type: "EXPLAINS",
        evaluation_versions: evaluationBefore.rows[0].versions,
        evaluation_observations: evaluationBefore.rows[0].observations,
        quotes: 0,
        downstream_grants: evaluationBefore.rows[0].downstream_grants,
        workstream_versions: 0,
        recommendation_versions: 0,
      });
      const ledger = await pool.query(
        "SELECT count(*)::integer AS count FROM schema_migrations"
      );
      assert.equal(ledger.rows[0].count, 44);

      const logText = JSON.stringify(events);
      assert.match(logText, /FINDING_SUBMITTED/);
      assert.match(logText, /FINDING_CONFIRMED/);
      assert.match(logText, /FINDING_CONCERN_LINKED/);
      assert.match(logText, /FINDING_AUTHORITY_DENIED/);
      assert.match(logText, /FINDING_CONCERN_SCOPE_MISMATCH/);
      assert.doesNotMatch(
        logText,
        /dishwasher issue|garbage disposal and drainage fault|Cape Coral|33904/i
      );
    } finally {
      await pool.end();
    }
  }
);
