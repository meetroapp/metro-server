"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");
const {
  createJobRequest,
} = require("../server/requests/jobRequestCreateService");
const {
  submitProfessionalResponse,
} = require("../server/relationships/professionalResponseService");
const {
  selectProfessionalResponse,
} = require("../server/relationships/requestSelectionService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const cleanDatabaseUrl = process.env.ORDINARY_EVALUATION_DATABASE_URL;
const upgradeDatabaseUrl =
  process.env.ORDINARY_EVALUATION_UPGRADE_DATABASE_URL;
const migrationName =
  "202608090003_create_ordinary_evaluation_finding_foundation.sql";

function targetMetadata(databaseUrl) {
  const target = assertSafeTestDatabaseUrl(databaseUrl, {
    nodeEnv: process.env.NODE_ENV,
  });
  return { target: "local-test", database: target };
}

function requestPayload() {
  return {
    title: "Dishwasher service",
    description: "dishwasher issue",
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

async function createUsersAndProfile(client, suffix) {
  const homeowner = await client.query(
    `
    INSERT INTO users (username, email, password_hash, role, account_type)
    VALUES ('Evaluation Homeowner', $1, 'test-only-hash', 'homeowner', 'homeowner')
    RETURNING id
    `,
    [`evaluation-homeowner-${suffix}@example.test`]
  );
  const professional = await client.query(
    `
    INSERT INTO users (username, email, password_hash, role, account_type)
    VALUES ('Evaluation Professional', $1, 'test-only-hash',
      'appliance_repair', 'professional')
    RETURNING id
    `,
    [`evaluation-professional-${suffix}@example.test`]
  );
  const profile = await client.query(
    `
    INSERT INTO contractor_profiles
      (user_id, business_name, category, location, profile_details)
    VALUES ($1, 'Evaluation Appliance Service', 'appliance_repair',
      'Cape Coral', $2::jsonb)
    RETURNING id
    `,
    [
      professional.rows[0].id,
      JSON.stringify({
        service_area: "Cape Coral",
        service_specialties: ["appliance_repair"],
      }),
    ]
  );
  return {
    homeownerId: Number(homeowner.rows[0].id),
    professionalId: Number(professional.rows[0].id),
    contractorId: Number(profile.rows[0].id),
  };
}

async function createSliceOneFixture(client, identities, suffix) {
  const legacy = await client.query(
    `
    INSERT INTO posts (user_id, title, description, category, location)
    VALUES ($1, 'Legacy request', 'Legacy request detail', 'handyman', 'Legacy area')
    RETURNING id, title, description, lifecycle_contract_version
    `,
    [identities.homeownerId]
  );

  const created = await createJobRequest({
    pool: client,
    authenticatedActor: { id: identities.homeownerId },
    payload: requestPayload(),
    idempotencyKey: randomUUID(),
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
  });
  assert.equal(created.ok, true);

  const response = await submitProfessionalResponse({
    pool: client,
    authenticatedActor: { id: identities.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "I can inspect this appliance issue." },
    idempotencyKey: `evaluation-response:${suffix}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true);

  const selection = await selectProfessionalResponse({
    pool: client,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: `evaluation-selection:${suffix}`,
    lifecycleJobBootstrap: async (input) => {
      const { bootstrapLifecycleJob } = require("../server/workflow/jobFoundationService");
      return bootstrapLifecycleJob({
        ...input,
        logger: { info() {}, warn() {} },
      });
    },
  });
  assert.equal(selection.ok, true);

  const job = await client.query(
    `
    SELECT id, job_request_id, source_request_relationship_id
    FROM jobs
    WHERE id = $1
    `,
    [selection.lifecycleJob.id]
  );
  const professionalParticipant = await client.query(
    `
    SELECT id
    FROM relationship_participants
    WHERE job_id = $1 AND user_id = $2
    `,
    [selection.lifecycleJob.id, identities.professionalId]
  );

  return {
    legacy: legacy.rows[0],
    requestId: Number(created.post.id),
    concernId: created.reportedConcern.id,
    jobId: job.rows[0].id,
    relationshipId: Number(job.rows[0].source_request_relationship_id),
    professionalParticipantId: professionalParticipant.rows[0].id,
  };
}

async function createEmergencyEvaluationFixture(client, identities) {
  const emergency = await client.query(
    `
    INSERT INTO emergency_requests (
      homeowner_id,
      category,
      service_domain,
      service_specialty,
      title,
      description,
      location_text,
      status,
      requested_at,
      arrived_at
    )
    VALUES (
      $1,
      'appliance_repair',
      'home_services',
      'appliance_repair',
      'Emergency appliance inspection',
      'Existing Emergency Evaluation fixture',
      'Cape Coral, FL',
      'professional_arrived',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    RETURNING id
    `,
    [identities.homeownerId]
  );
  const relationship = await client.query(
    `
    INSERT INTO request_relationships (
      post_id,
      emergency_request_id,
      homeowner_id,
      contractor_id,
      professional_user_id,
      status,
      introduction_text
    )
    VALUES (NULL, $1, $2, $3, $4, 'active', 'Emergency Evaluation fixture')
    RETURNING id
    `,
    [
      emergency.rows[0].id,
      identities.homeownerId,
      identities.contractorId,
      identities.professionalId,
    ]
  );
  const evaluationId = randomUUID();
  await client.query(
    `
    INSERT INTO commercial_authority_aggregates (
      id,
      aggregate_type,
      owning_engine,
      source_context_type,
      ordinary_request_id,
      emergency_request_id,
      relationship_id,
      source_owner_user_id,
      created_by_user_id,
      current_version
    )
    VALUES (
      $1,
      'evaluation',
      'authorization_engine',
      'emergency_request',
      NULL,
      $2,
      $3,
      $4,
      $5,
      1
    )
    `,
    [
      evaluationId,
      emergency.rows[0].id,
      relationship.rows[0].id,
      identities.homeownerId,
      identities.professionalId,
    ]
  );
  await client.query(
    `
    INSERT INTO canonical_evaluations
      (id, relationship_id, professional_user_id, status)
    VALUES ($1, $2, $3, 'draft')
    `,
    [evaluationId, relationship.rows[0].id, identities.professionalId]
  );
  await client.query(
    `
    INSERT INTO canonical_evaluation_versions (
      evaluation_id,
      version,
      status,
      observations,
      findings,
      scope_recommendations,
      created_by_user_id
    )
    VALUES ($1, 1, 'draft', 'Existing Emergency observation', $2::jsonb,
      '[]'::jsonb, $3)
    `,
    [
      evaluationId,
      JSON.stringify([
        {
          summary: "Existing Emergency JSON Finding",
          severity: "moderate",
          customerShareable: true,
        },
      ]),
      identities.professionalId,
    ]
  );
  return { emergencyRequestId: Number(emergency.rows[0].id), evaluationId };
}

async function createOrdinaryEvaluationFoundation(
  client,
  identities,
  lifecycle
) {
  const evaluationId = randomUUID();
  await client.query(
    `
    INSERT INTO commercial_authority_aggregates (
      id,
      aggregate_type,
      owning_engine,
      source_context_type,
      ordinary_request_id,
      emergency_request_id,
      relationship_id,
      source_owner_user_id,
      created_by_user_id,
      current_version
    )
    VALUES (
      $1,
      'evaluation',
      'authorization_engine',
      'ordinary_request',
      $2,
      NULL,
      $3,
      $4,
      $5,
      1
    )
    `,
    [
      evaluationId,
      lifecycle.requestId,
      lifecycle.relationshipId,
      identities.homeownerId,
      identities.professionalId,
    ]
  );
  await client.query(
    `
    INSERT INTO canonical_evaluations
      (id, relationship_id, professional_user_id, status)
    VALUES ($1, $2, $3, 'draft')
    `,
    [evaluationId, lifecycle.relationshipId, identities.professionalId]
  );
  await client.query(
    `
    INSERT INTO canonical_evaluation_versions (
      evaluation_id,
      version,
      status,
      observations,
      findings,
      scope_recommendations,
      created_by_user_id
    )
    VALUES ($1, 1, 'draft', 'Inspected disposal and drain', '[]'::jsonb,
      '[]'::jsonb, $2)
    `,
    [evaluationId, identities.professionalId]
  );
  await client.query(
    `
    INSERT INTO canonical_evaluation_job_subjects (
      evaluation_id,
      job_id,
      job_request_id,
      relationship_id
    )
    VALUES ($1, $2, $3, $4)
    `,
    [
      evaluationId,
      lifecycle.jobId,
      lifecycle.requestId,
      lifecycle.relationshipId,
    ]
  );
  return evaluationId;
}

async function insertFinding(
  client,
  { evaluationId, lifecycle, statement, confirmationState = "PROPOSED" }
) {
  const findingId = randomUUID();
  await client.query(
    `
    INSERT INTO canonical_evaluation_findings
      (id, evaluation_id, job_id, author_participant_id)
    VALUES ($1, $2, $3, $4)
    `,
    [
      findingId,
      evaluationId,
      lifecycle.jobId,
      lifecycle.professionalParticipantId,
    ]
  );
  await client.query(
    `
    INSERT INTO canonical_evaluation_finding_versions (
      finding_id,
      version,
      evaluation_id,
      evaluation_version,
      job_id,
      statement,
      confirmation_state,
      resolution_state,
      created_by_participant_id,
      integrity_hash
    )
    VALUES ($1, 1, $2, 1, $3, $4, $5, 'OPEN', $6, $7)
    `,
    [
      findingId,
      evaluationId,
      lifecycle.jobId,
      statement,
      confirmationState,
      lifecycle.professionalParticipantId,
      createHash("sha256").update(statement).digest("hex"),
    ]
  );
  return findingId;
}

test(
  "disposable PostgreSQL applies Slice 002 from zero and replays all migrations",
  { skip: !cleanDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: cleanDatabaseUrl, max: 2 });
    const client = await pool.connect();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 32);
      const applied = await runMigrationCollection(
        client,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(applied.success, true);
      assert.equal(applied.applied.length, 32);

      const schema = await client.query(
        `
        SELECT
          to_regclass('public.canonical_evaluation_job_subjects') IS NOT NULL AS subjects,
          to_regclass('public.canonical_evaluation_findings') IS NOT NULL AS findings,
          to_regclass('public.canonical_evaluation_finding_versions') IS NOT NULL AS versions,
          to_regclass('public.canonical_finding_concern_links') IS NOT NULL AS concern_links,
          to_regclass('public.canonical_finding_evidence_references') IS NOT NULL AS evidence,
          to_regclass('public.canonical_evaluation_job_subject_lookup_idx') IS NOT NULL AS subject_index,
          to_regclass('public.canonical_evaluation_finding_subject_idx') IS NOT NULL AS finding_index,
          to_regclass('public.canonical_evaluation_finding_version_subject_idx') IS NOT NULL AS version_index,
          to_regclass('public.canonical_finding_concern_lookup_idx') IS NOT NULL AS concern_index,
          to_regclass('public.canonical_finding_evidence_lookup_idx') IS NOT NULL AS evidence_index
        `
      );
      assert.deepEqual(schema.rows[0], {
        subjects: true,
        findings: true,
        versions: true,
        concern_links: true,
        evidence: true,
        subject_index: true,
        finding_index: true,
        version_index: true,
        concern_index: true,
        evidence_index: true,
      });

      const replay = await runMigrationCollection(
        client,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 32);
    } finally {
      client.release();
      await pool.end();
    }
  }
);

test(
  "disposable PostgreSQL upgrades 28 migrations and certifies ordinary Findings without fabricating history",
  { skip: !upgradeDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: upgradeDatabaseUrl, max: 4 });
    const client = await pool.connect();
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const priorMigrations = migrations.filter(
        (migration) => migration.filename < migrationName
      );
      const sliceMigration = migrations.find(
        (migration) => migration.filename === migrationName
      );
      assert.equal(priorMigrations.length, 28);
      assert.ok(sliceMigration);

      const prior = await runMigrationCollection(
        client,
        priorMigrations,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(prior.success, true);
      assert.equal(prior.applied.length, 28);

      const identities = await createUsersAndProfile(client, suffix);
      const lifecycle = await createSliceOneFixture(pool, identities, suffix);
      const emergency = await createEmergencyEvaluationFixture(client, identities);

      const before = await client.query(
        `
        SELECT
          (SELECT count(*) FROM posts WHERE id = $1)::integer AS legacy_requests,
          (SELECT count(*) FROM jobs WHERE id = $2)::integer AS jobs,
          (SELECT count(*) FROM reported_concerns WHERE id = $3)::integer AS concerns,
          (SELECT count(*) FROM canonical_evaluations WHERE id = $4)::integer AS emergency_evaluations,
          (SELECT findings FROM canonical_evaluation_versions
            WHERE evaluation_id = $4 AND version = 1) AS emergency_findings
        `,
        [lifecycle.legacy.id, lifecycle.jobId, lifecycle.concernId, emergency.evaluationId]
      );

      const brokenSql = `${sliceMigration.sql}\nSELECT slice_002_forced_failure;`;
      const broken = {
        ...sliceMigration,
        sql: brokenSql,
        checksum: createHash("sha256").update(brokenSql).digest("hex"),
      };
      const failed = await runMigrationCollection(
        client,
        [broken],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(failed.success, false);
      assert.equal(failed.errorCode, "MIGRATION_FAILED");
      const rolledBack = await client.query(
        `
        SELECT
          to_regclass('public.canonical_evaluation_job_subjects') IS NULL AS schema_absent,
          (SELECT count(*) FROM schema_migrations)::integer AS ledger_count
        `
      );
      assert.deepEqual(rolledBack.rows[0], {
        schema_absent: true,
        ledger_count: 28,
      });

      const applied = await runMigrationCollection(
        client,
        [sliceMigration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(applied.success, true);
      assert.deepEqual(applied.applied, [migrationName]);

      const preserved = await client.query(
        `
        SELECT
          (SELECT count(*) FROM schema_migrations)::integer AS ledger_count,
          (SELECT lifecycle_contract_version FROM posts WHERE id = $1)::integer AS legacy_version,
          (SELECT original_text FROM reported_concerns WHERE id = $2) AS original_concern,
          (SELECT count(*) FROM canonical_evaluation_job_subjects)::integer AS subjects,
          (SELECT count(*) FROM canonical_evaluation_findings)::integer AS findings,
          (SELECT count(*) FROM canonical_finding_concern_links)::integer AS concern_links,
          (SELECT findings FROM canonical_evaluation_versions
            WHERE evaluation_id = $3 AND version = 1) AS emergency_findings
        `,
        [lifecycle.legacy.id, lifecycle.concernId, emergency.evaluationId]
      );
      assert.equal(preserved.rows[0].ledger_count, 29);
      assert.equal(preserved.rows[0].legacy_version, 1);
      assert.equal(preserved.rows[0].original_concern, "dishwasher issue");
      assert.equal(preserved.rows[0].subjects, 0);
      assert.equal(preserved.rows[0].findings, 0);
      assert.equal(preserved.rows[0].concern_links, 0);
      assert.deepEqual(preserved.rows[0].emergency_findings, before.rows[0].emergency_findings);

      const evaluationId = await createOrdinaryEvaluationFoundation(
        client,
        identities,
        lifecycle
      );
      const linkedFindingId = await insertFinding(client, {
        evaluationId,
        lifecycle,
        statement: "garbage disposal and drainage fault",
        confirmationState: "CONFIRMED",
      });
      const unlinkedFindingId = await insertFinding(client, {
        evaluationId,
        lifecycle,
        statement: "dishwasher mounting condition requires observation",
      });

      await client.query(
        `
        INSERT INTO canonical_finding_concern_links (
          id,
          finding_id,
          job_id,
          job_request_id,
          concern_id,
          relationship_type,
          created_by_participant_id
        )
        VALUES ($1, $2, $3, $4, $5, 'EXPLAINS', $6)
        `,
        [
          randomUUID(),
          linkedFindingId,
          lifecycle.jobId,
          lifecycle.requestId,
          lifecycle.concernId,
          lifecycle.professionalParticipantId,
        ]
      );
      await client.query(
        `
        INSERT INTO canonical_finding_evidence_references (
          id,
          finding_id,
          finding_version,
          job_id,
          evidence_type,
          reference_namespace,
          reference_id,
          recorded_by_participant_id
        )
        VALUES ($1, $2, 1, $3, 'PROFESSIONAL_OBSERVATION',
          'evaluation.observation', 'observation-1', $4)
        `,
        [
          randomUUID(),
          linkedFindingId,
          lifecycle.jobId,
          lifecycle.professionalParticipantId,
        ]
      );

      const represented = await client.query(
        `
        SELECT
          fv.statement,
          fv.confirmation_state,
          fv.resolution_state,
          l.relationship_type,
          rc.original_text,
          (SELECT count(*) FROM canonical_finding_concern_links
            WHERE finding_id = $2)::integer AS unlinked_concern_count,
          (SELECT count(*) FROM canonical_finding_evidence_references
            WHERE finding_id = $1)::integer AS evidence_count
        FROM canonical_evaluation_finding_versions AS fv
        INNER JOIN canonical_finding_concern_links AS l
          ON l.finding_id = fv.finding_id
        INNER JOIN reported_concerns AS rc
          ON rc.id = l.concern_id
        WHERE fv.finding_id = $1 AND fv.version = 1
        `,
        [linkedFindingId, unlinkedFindingId]
      );
      assert.deepEqual(represented.rows[0], {
        statement: "garbage disposal and drainage fault",
        confirmation_state: "CONFIRMED",
        resolution_state: "OPEN",
        relationship_type: "EXPLAINS",
        original_text: "dishwasher issue",
        unlinked_concern_count: 0,
        evidence_count: 1,
      });

      await assert.rejects(
        client.query(
          `
          INSERT INTO canonical_evaluation_finding_versions (
            finding_id,
            version,
            evaluation_id,
            evaluation_version,
            job_id,
            statement,
            confirmation_state,
            resolution_state,
            created_by_participant_id,
            integrity_hash
          )
          VALUES ($1, 2, $2, 1, $3, 'Invalid state', 'INVALID', 'OPEN', $4, $5)
          `,
          [
            linkedFindingId,
            evaluationId,
            lifecycle.jobId,
            lifecycle.professionalParticipantId,
            "a".repeat(64),
          ]
        ),
        (error) => error.code === "23514"
      );

      await assert.rejects(
        client.query(
          `
          INSERT INTO canonical_finding_concern_links (
            id,
            finding_id,
            job_id,
            job_request_id,
            concern_id,
            relationship_type,
            created_by_participant_id
          )
          VALUES ($1, $2, $3, $4, $5, 'EXPLAINS', $6)
          `,
          [
            randomUUID(),
            linkedFindingId,
            lifecycle.jobId,
            lifecycle.requestId,
            lifecycle.concernId,
            lifecycle.professionalParticipantId,
          ]
        ),
        (error) => error.code === "23505"
      );

      await assert.rejects(
        client.query("DELETE FROM reported_concerns WHERE id = $1", [
          lifecycle.concernId,
        ]),
        (error) => error.code === "55000"
      );
      await assert.rejects(
        client.query(
          "UPDATE canonical_evaluation_finding_versions SET resolution_state = 'RESOLVED' WHERE finding_id = $1 AND version = 1",
          [linkedFindingId]
        ),
        (error) => error.code === "55000"
      );

      const replay = await runMigrationCollection(
        client,
        [sliceMigration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.deepEqual(replay.skipped, [migrationName]);
    } finally {
      client.release();
      await pool.end();
    }
  }
);
