"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { createJobRequest } = require("../server/requests/jobRequestCreateService");
const {
  submitProfessionalResponse,
} = require("../server/relationships/professionalResponseService");
const {
  selectProfessionalResponse,
} = require("../server/relationships/requestSelectionService");
const {
  createOrdinaryJobEvaluation,
} = require("../server/authorization/evaluationService");
const {
  confirmFinding,
  submitFinding,
} = require("../server/authorization/findingService");
const {
  createRecommendation,
  getRecommendation,
  listRecommendationsByFinding,
  recordCustomerConstraint,
  transitionRecommendation,
} = require("../server/authorization/recommendationService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const cleanDatabaseUrl = process.env.RECOMMENDATION_FOUNDATION_DATABASE_URL;
const upgradeDatabaseUrl = process.env.RECOMMENDATION_UPGRADE_DATABASE_URL;
const migrationName = "202608100002_create_recommendation_hierarchy_foundation.sql";
const quiet = { info() {}, warn() {} };

function targetMetadata(databaseUrl) {
  const database = assertSafeTestDatabaseUrl(databaseUrl, {
    nodeEnv: process.env.NODE_ENV,
  });
  return { target: "local-test", database };
}

function requestPayload(description) {
  return {
    title: `Recommendation fixture ${description}`,
    description,
    category: "home_repair",
    request_category: "home_repair",
    service_domain: "home_services",
    service_specialty: "handyman",
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
    serviceType: "handyman",
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

async function createIdentities(pool, suffix) {
  const homeowner = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Recommendation Homeowner', $1, 'test-only-hash', 'homeowner', 'homeowner')
     RETURNING id`,
    [`recommendation-homeowner-${suffix}@example.test`]
  );
  const professional = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Recommendation Professional', $1, 'test-only-hash', 'handyman', 'professional')
     RETURNING id`,
    [`recommendation-professional-${suffix}@example.test`]
  );
  const outsider = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Recommendation Outsider', $1, 'test-only-hash', 'handyman', 'professional')
     RETURNING id`,
    [`recommendation-outsider-${suffix}@example.test`]
  );
  for (const [userId, name] of [
    [professional.rows[0].id, "Selected Recommendation Service"],
    [outsider.rows[0].id, "Unselected Recommendation Service"],
  ]) {
    await pool.query(
      `INSERT INTO contractor_profiles
        (user_id, business_name, category, location, profile_details)
       VALUES ($1, $2, 'handyman', 'Cape Coral', $3::jsonb)`,
      [
        userId,
        name,
        JSON.stringify({
          service_area: "Cape Coral",
          service_specialties: ["handyman"],
        }),
      ]
    );
  }
  return {
    homeownerId: Number(homeowner.rows[0].id),
    professionalId: Number(professional.rows[0].id),
    outsiderId: Number(outsider.rows[0].id),
  };
}

async function createLifecycleFixture(pool, identities, suffix, description) {
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
  assert.equal(created.ok, true, created.code);
  const response = await submitProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "Synthetic Recommendation response." },
    idempotencyKey: `recommendation-response-${suffix}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true, response.code);
  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: `recommendation-selection-${suffix}`,
  });
  assert.equal(selection.ok, true, selection.code);
  const context = await pool.query(
    `
    SELECT jobs.id AS job_id, jobs.source_request_relationship_id AS relationship_id,
      professional.id AS professional_participant_id,
      homeowner.id AS homeowner_participant_id
    FROM jobs
    INNER JOIN relationship_participants professional
      ON professional.job_id = jobs.id AND professional.user_id = $2
    INNER JOIN relationship_participants homeowner
      ON homeowner.job_id = jobs.id AND homeowner.user_id = $3
    WHERE jobs.job_request_id = $1
    `,
    [created.post.id, identities.professionalId, identities.homeownerId]
  );
  return {
    requestId: created.post.id,
    jobId: context.rows[0].job_id,
    relationshipId: Number(context.rows[0].relationship_id),
    professionalParticipantId: context.rows[0].professional_participant_id,
    homeownerParticipantId: context.rows[0].homeowner_participant_id,
  };
}

async function createEvaluationAndFindings(pool, identities, fixture, suffix, statements) {
  const evaluation = await createOrdinaryJobEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    content: evaluationContent("Inspected Recommendation scenario conditions."),
    expectedVersion: 0,
    idempotencyKey: `recommendation-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(evaluation.ok, true, evaluation.code);
  const findings = {};
  for (const [key, statement] of Object.entries(statements)) {
    const proposed = await submitFinding({
      pool,
      authenticatedActor: { id: identities.professionalId },
      evaluationId: evaluation.evaluation.id,
      statement,
      idempotencyKey: `recommendation-finding-${key}-${suffix}`,
      logger: quiet,
    });
    assert.equal(proposed.ok, true, proposed.code);
    const confirmed = await confirmFinding({
      pool,
      authenticatedActor: { id: identities.professionalId },
      findingId: proposed.finding.id,
      expectedVersion: 1,
      idempotencyKey: `recommendation-confirm-${key}-${suffix}`,
      logger: quiet,
    });
    assert.equal(confirmed.ok, true, confirmed.code);
    findings[key] = confirmed.finding;
  }
  return { evaluation: evaluation.evaluation, findings };
}

function command(service, identities, input, key) {
  return service({
    pool: input.pool,
    logger: quiet,
    authenticatedActor: { id: identities.professionalId },
    idempotencyKey: key,
    ...input,
  });
}

test(
  "clean disposable PostgreSQL certifies Recommendation hierarchy and authority",
  { skip: !cleanDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: cleanDatabaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 32);
      const applied = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(applied.success, true);
      assert.equal(applied.applied.length, 32);
      const replay = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 32);

      const identities = await createIdentities(pool, suffix);
      const fixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-primary`,
        "aging R-22 A/C, disposal, and fan inspection"
      );
      const crossFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-cross`,
        "separate property system"
      );
      const primary = await createEvaluationAndFindings(
        pool,
        identities,
        fixture,
        suffix,
        {
          ac: "refrigerant leak in aging R-22 A/C system",
          disposal: "garbage disposal failure",
          fan: "failed ventilation fan",
        }
      );
      const cross = await createEvaluationAndFindings(
        pool,
        identities,
        crossFixture,
        `${suffix}-cross`,
        { other: "separate property Finding" }
      );

      const bootstrap = await pool.query(
        `SELECT count(DISTINCT capability)::integer AS count
         FROM lifecycle_authority_grants
         WHERE grantee_participant_id = $1
           AND job_id = $2
           AND capability = ANY($3::text[])`,
        [
          fixture.professionalParticipantId,
          fixture.jobId,
          [
            "recommendation.create",
            "recommendation.read",
            "recommendation.transition",
            "customer_constraint.record",
          ],
        ]
      );
      assert.equal(bootstrap.rows[0].count, 4);

      const before = await pool.query(
        `SELECT
          (SELECT resolution_state FROM canonical_evaluation_finding_versions
            WHERE finding_id = $1 ORDER BY version DESC LIMIT 1) AS resolution,
          (SELECT count(*) FROM canonical_workstream_versions WHERE job_id = $2)::integer AS workstream_versions,
          (SELECT count(*) FROM commercial_authority_aggregates
            WHERE aggregate_type = 'quote')::integer AS quotes`,
        [primary.findings.ac.id, fixture.jobId]
      );

      const primaryInput = {
        pool,
        findingId: primary.findings.ac.id,
        kind: "PRIMARY",
        statement: "replace A/C system",
      };
      const acPrimary = await command(
        createRecommendation,
        identities,
        primaryInput,
        `recommendation-primary-${suffix}`
      );
      assert.equal(acPrimary.code, "RECOMMENDATION_CREATED");
      assert.equal(acPrimary.recommendation.status, "ACTIVE");
      assert.equal((await command(
        createRecommendation,
        identities,
        primaryInput,
        `recommendation-primary-${suffix}`
      )).replayed, true);
      assert.equal((await command(
        createRecommendation,
        identities,
        { ...primaryInput, statement: "conflicting key reuse" },
        `recommendation-primary-${suffix}`
      )).code, "RECOMMENDATION_IDEMPOTENCY_KEY_CONFLICT");

      const alternativeInput = {
        pool,
        findingId: primary.findings.ac.id,
        kind: "ALTERNATIVE",
        statement: "R-22 recharge - $350",
        primaryRecommendationId: acPrimary.recommendation.id,
      };
      const alternative = await command(
        createRecommendation,
        identities,
        alternativeInput,
        `recommendation-alternative-${suffix}`
      );
      assert.equal(alternative.recommendation.kind, "ALTERNATIVE");
      assert.equal(alternative.recommendation.primaryRecommendationId, acPrimary.recommendation.id);
      assert.equal((await command(
        createRecommendation,
        identities,
        alternativeInput,
        `recommendation-alternative-${suffix}`
      )).replayed, true);

      const constraintInput = {
        pool,
        recommendationId: acPrimary.recommendation.id,
        constraintType: "BUDGET",
        statement: "replacement not financially feasible now",
      };
      const constraint = await command(
        recordCustomerConstraint,
        identities,
        constraintInput,
        `recommendation-constraint-${suffix}`
      );
      assert.equal(constraint.constraint.type, "BUDGET");
      assert.equal(constraint.recommendation.currentVersion, 1);
      assert.equal((await command(
        recordCustomerConstraint,
        identities,
        constraintInput,
        `recommendation-constraint-${suffix}`
      )).replayed, true);

      const transitionInput = {
        pool,
        recommendationId: acPrimary.recommendation.id,
        expectedVersion: 1,
        targetStatus: "DEFERRED",
        decisionEvidenceNote: "Professional recorded the customer's stated budget limitation.",
      };
      const deferred = await command(
        transitionRecommendation,
        identities,
        transitionInput,
        `recommendation-transition-${suffix}`
      );
      assert.equal(deferred.recommendation.status, "DEFERRED");
      assert.equal(deferred.recommendation.currentVersion, 2);
      assert.equal(
        deferred.dispositionEvent.authorityClassification,
        "PROFESSIONAL_RECORDED_CUSTOMER_DECISION"
      );
      assert.equal((await command(
        transitionRecommendation,
        identities,
        transitionInput,
        `recommendation-transition-${suffix}`
      )).replayed, true);
      assert.equal((await command(
        transitionRecommendation,
        identities,
        transitionInput,
        `recommendation-transition-stale-${suffix}`
      )).code, "STALE_RECOMMENDATION_VERSION");

      const disposal = await command(createRecommendation, identities, {
        pool,
        findingId: primary.findings.disposal.id,
        kind: "PRIMARY",
        statement: "replace disposal",
      }, `recommendation-disposal-${suffix}`);
      const fan = await command(createRecommendation, identities, {
        pool,
        findingId: primary.findings.fan.id,
        kind: "PRIMARY",
        statement: "replace fan",
      }, `recommendation-fan-${suffix}`);
      assert.equal(disposal.recommendation.status, "ACTIVE");
      const separateFan = await command(transitionRecommendation, identities, {
        pool,
        recommendationId: fan.recommendation.id,
        expectedVersion: 1,
        targetStatus: "SEPARATE_PROPOSAL_REQUIRED",
      }, `recommendation-fan-separate-${suffix}`);
      assert.equal(separateFan.recommendation.status, "SEPARATE_PROPOSAL_REQUIRED");

      assert.equal((await createRecommendation({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        findingId: primary.findings.ac.id,
        kind: "PRIMARY",
        statement: "homeowner fabricated recommendation",
        idempotencyKey: `recommendation-homeowner-${suffix}`,
        logger: quiet,
      })).code, "RECOMMENDATION_AUTHORITY_REQUIRED");
      assert.equal((await createRecommendation({
        pool,
        authenticatedActor: { id: identities.outsiderId },
        findingId: primary.findings.ac.id,
        kind: "PRIMARY",
        statement: "unselected fabricated recommendation",
        idempotencyKey: `recommendation-outsider-${suffix}`,
        logger: quiet,
      })).code, "RECOMMENDATION_AUTHORITY_REQUIRED");

      const roleParticipantId = randomUUID();
      await pool.query(
        `INSERT INTO relationship_participants (
          id, job_id, request_relationship_id, user_id,
          source_evidence_type, source_evidence_reference
        ) VALUES ($1, $2, $3, $4, 'request_selection', $5)`,
        [roleParticipantId, fixture.jobId, fixture.relationshipId, identities.outsiderId, suffix]
      );
      await pool.query(
        `INSERT INTO participant_role_assignments (
          id, participant_id, job_id, role, assigned_by_participant_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        ) VALUES ($1, $2, $3, 'PRIMARY_PROFESSIONAL', $4,
          'local_certification', $5, $6)`,
        [randomUUID(), roleParticipantId, fixture.jobId,
          fixture.homeownerParticipantId, suffix, randomUUID()]
      );
      assert.equal((await createRecommendation({
        pool,
        authenticatedActor: { id: identities.outsiderId },
        findingId: primary.findings.ac.id,
        kind: "PRIMARY",
        statement: "role-only recommendation",
        idempotencyKey: `recommendation-role-only-${suffix}`,
        logger: quiet,
      })).code, "RECOMMENDATION_AUTHORITY_REQUIRED");

      const crossPrimary = await command(createRecommendation, identities, {
        pool,
        findingId: cross.findings.other.id,
        kind: "PRIMARY",
        statement: "cross property primary",
      }, `recommendation-cross-primary-${suffix}`);
      assert.equal((await command(createRecommendation, identities, {
        pool,
        findingId: primary.findings.ac.id,
        kind: "ALTERNATIVE",
        statement: "cross property alternative",
        primaryRecommendationId: crossPrimary.recommendation.id,
      }, `recommendation-cross-alternative-${suffix}`)).code,
      "RECOMMENDATION_LINEAGE_SCOPE_MISMATCH");

      const listed = await listRecommendationsByFinding({
        pool,
        authenticatedActor: { id: identities.professionalId },
        findingId: primary.findings.ac.id,
        logger: quiet,
      });
      assert.equal(listed.recommendations.length, 2);
      const detail = await getRecommendation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        recommendationId: acPrimary.recommendation.id,
        logger: quiet,
      });
      assert.deepEqual(detail.recommendation.versions.map((row) => row.status), [
        "ACTIVE",
        "DEFERRED",
      ]);
      assert.equal(detail.recommendation.versions[0].statement, "replace A/C system");
      assert.equal(detail.recommendation.versions[1].statement, "replace A/C system");
      assert.equal(alternative.recommendation.status, "ACTIVE");

      const after = await pool.query(
        `SELECT
          (SELECT resolution_state FROM canonical_evaluation_finding_versions
            WHERE finding_id = $1 ORDER BY version DESC LIMIT 1) AS resolution,
          (SELECT count(*) FROM canonical_workstream_versions WHERE job_id = $2)::integer AS workstream_versions,
          (SELECT count(*) FROM commercial_authority_aggregates
            WHERE aggregate_type = 'quote')::integer AS quotes,
          (SELECT count(*) FROM lifecycle_authority_grants
            WHERE capability LIKE 'quote.%')::integer AS quote_grants,
          (SELECT count(*) FROM canonical_recommendations)::integer AS recommendations,
          (SELECT count(*) FROM canonical_recommendation_versions)::integer AS versions,
          (SELECT count(*) FROM canonical_customer_constraints)::integer AS constraints,
          (SELECT count(*) FROM canonical_recommendation_disposition_events)::integer AS dispositions`,
        [primary.findings.ac.id, fixture.jobId]
      );
      assert.equal(after.rows[0].resolution, before.rows[0].resolution);
      assert.equal(after.rows[0].workstream_versions, before.rows[0].workstream_versions);
      assert.equal(after.rows[0].quotes, 0);
      assert.equal(after.rows[0].quote_grants, 16);
      assert.equal(after.rows[0].recommendations, 5);
      assert.equal(after.rows[0].versions, 7);
      assert.equal(after.rows[0].constraints, 1);
      assert.equal(after.rows[0].dispositions, 2);
    } finally {
      await pool.end();
    }
  }
);

test(
  "disposable PostgreSQL upgrades 30 to 31 with rollback and no retroactive authority",
  { skip: !upgradeDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: upgradeDatabaseUrl, max: 6 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const prior = migrations.filter((migration) => migration.filename < migrationName);
      const migration = migrations.find((candidate) => candidate.filename === migrationName);
      assert.equal(prior.length, 30);
      assert.ok(migration);
      const priorResult = await runMigrationCollection(
        pool,
        prior,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(priorResult.success, true);
      assert.equal(priorResult.applied.length, 30);

      const identities = await createIdentities(pool, `${suffix}-upgrade`);
      const fixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-upgrade`,
        "legacy Slice 003 recommendation candidate"
      );
      const source = await createEvaluationAndFindings(
        pool,
        identities,
        fixture,
        `${suffix}-upgrade`,
        { ac: "legacy confirmed A/C Finding" }
      );
      const legacy = await pool.query(
        `INSERT INTO posts (user_id, title, description, category, location)
         VALUES ($1, 'Legacy Recommendation-free request', 'preserved legacy truth',
           'handyman', 'Legacy area')
         RETURNING id, description, lifecycle_contract_version`,
        [identities.homeownerId]
      );

      const forced = await runMigrationCollection(
        pool,
        [{ ...migration, sql: `${migration.sql}\nSELECT * FROM missing_slice_004_relation;` }],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(forced.success, false);
      const rolledBack = await pool.query(
        `SELECT
          (SELECT count(*) FROM schema_migrations)::integer AS ledger,
          to_regclass('public.canonical_recommendations') IS NULL AS no_recommendations,
          (SELECT count(*) FROM lifecycle_capabilities
            WHERE capability LIKE 'recommendation.%'
              OR capability = 'customer_constraint.record')::integer AS capabilities`
      );
      assert.deepEqual(rolledBack.rows[0], {
        ledger: 30,
        no_recommendations: true,
        capabilities: 0,
      });

      const upgraded = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(upgraded.success, true);
      assert.deepEqual(upgraded.applied, [migrationName]);
      const empty = await pool.query(
        `SELECT
          (SELECT count(*) FROM canonical_recommendations)::integer AS recommendations,
          (SELECT count(*) FROM canonical_customer_constraints)::integer AS constraints,
          (SELECT count(*) FROM canonical_recommendation_disposition_events)::integer AS dispositions,
          (SELECT count(*) FROM lifecycle_authority_grants
            WHERE job_id = $1 AND capability LIKE 'recommendation.%')::integer AS retroactive_grants,
          (SELECT description FROM posts WHERE id = $2) AS legacy_description,
          (SELECT lifecycle_contract_version FROM posts WHERE id = $2)::integer AS legacy_contract,
          (SELECT resolution_state FROM canonical_evaluation_finding_versions
            WHERE finding_id = $3 ORDER BY version DESC LIMIT 1) AS finding_resolution`,
        [fixture.jobId, legacy.rows[0].id, source.findings.ac.id]
      );
      assert.deepEqual(empty.rows[0], {
        recommendations: 0,
        constraints: 0,
        dispositions: 0,
        retroactive_grants: 0,
        legacy_description: "preserved legacy truth",
        legacy_contract: 1,
        finding_resolution: "OPEN",
      });

      const createGrantId = randomUUID();
      await pool.query(
        `INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        ) VALUES ($1, $2, $3, $4, 'recommendation.create', 'job', $4,
          'local_certification', $5, $6)`,
        [createGrantId, fixture.professionalParticipantId,
          fixture.homeownerParticipantId, fixture.jobId, suffix, randomUUID()]
      );
      const created = await command(createRecommendation, identities, {
        pool,
        findingId: source.findings.ac.id,
        kind: "PRIMARY",
        statement: "upgrade primary recommendation",
      }, `upgrade-recommendation-${suffix}`);
      assert.equal(created.code, "RECOMMENDATION_CREATED");
      assert.equal((await command(transitionRecommendation, identities, {
        pool,
        recommendationId: created.recommendation.id,
        expectedVersion: 1,
        targetStatus: "DEFERRED",
      }, `upgrade-transition-denied-${suffix}`)).code,
      "RECOMMENDATION_AUTHORITY_REQUIRED");

      await pool.query(
        `INSERT INTO lifecycle_authority_grant_revocations (
          id, authority_grant_id, job_id, revoked_by_participant_id,
          revocation_reason, source_evidence_type, source_evidence_reference,
          idempotency_key
        ) VALUES ($1, $2, $3, $4, 'Certification revocation',
          'local_certification', $5, $6)`,
        [randomUUID(), createGrantId, fixture.jobId,
          fixture.homeownerParticipantId, suffix, randomUUID()]
      );
      await pool.query(
        `INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id, valid_from, valid_until,
          source_evidence_type, source_evidence_reference, idempotency_key
        ) VALUES ($1, $2, $3, $4, 'recommendation.create', 'job', $4,
          CURRENT_TIMESTAMP - INTERVAL '2 hours',
          CURRENT_TIMESTAMP - INTERVAL '1 hour',
          'local_certification', $5, $6)`,
        [randomUUID(), fixture.professionalParticipantId,
          fixture.homeownerParticipantId, fixture.jobId, suffix, randomUUID()]
      );
      assert.equal((await command(createRecommendation, identities, {
        pool,
        findingId: source.findings.ac.id,
        kind: "PRIMARY",
        statement: "expired grant recommendation",
      }, `upgrade-expired-denied-${suffix}`)).code,
      "RECOMMENDATION_AUTHORITY_REQUIRED");

      const replay = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 1);
    } finally {
      await pool.end();
    }
  }
);
