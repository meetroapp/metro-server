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
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");
const {
  WORKFLOW_CAPABILITIES,
  assignFindingToWorkstream,
  completeWorkstream,
  createWorkActivity,
  createWorkObligation,
  createWorkstream,
  getWorkActivity,
  getWorkObligation,
  getWorkstream,
  getWorkstreamCompletionEligibility,
  listWorkActivities,
  listWorkObligations,
  listWorkstreams,
  progressWorkActivity,
  resolveFinding,
  transitionWorkObligation,
} = require("../server/workflow/workstreamService");

const cleanDatabaseUrl = process.env.WORKSTREAM_FOUNDATION_DATABASE_URL;
const upgradeDatabaseUrl =
  process.env.WORKSTREAM_FOUNDATION_UPGRADE_DATABASE_URL;
const runtimeDatabaseUrl = process.env.WORKSTREAM_RUNTIME_DATABASE_URL;
const completionDatabaseUrl =
  process.env.WORKSTREAM_COMPLETION_DATABASE_URL;
const migrationName =
  "202608100001_create_workstream_activity_foundation.sql";

function targetMetadata(databaseUrl) {
  const database = assertSafeTestDatabaseUrl(databaseUrl, {
    nodeEnv: process.env.NODE_ENV,
  });
  return { target: "local-test", database };
}

function integrity(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestPayload(description) {
  return {
    title: "Workstream foundation inspection",
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

async function createIdentities(client, suffix) {
  const homeowner = await client.query(
    `
    INSERT INTO users (username, email, password_hash, role, account_type)
    VALUES ('Workstream Homeowner', $1, 'test-only-hash', 'homeowner', 'homeowner')
    RETURNING id
    `,
    [`workstream-homeowner-${suffix}@example.test`]
  );
  const professional = await client.query(
    `
    INSERT INTO users (username, email, password_hash, role, account_type)
    VALUES ('Workstream Professional', $1, 'test-only-hash', 'handyman', 'professional')
    RETURNING id
    `,
    [`workstream-professional-${suffix}@example.test`]
  );
  await client.query(
    `
    INSERT INTO contractor_profiles
      (user_id, business_name, category, location, profile_details)
    VALUES ($1, 'Workstream Home Service', 'handyman', 'Cape Coral', $2::jsonb)
    `,
    [
      professional.rows[0].id,
      JSON.stringify({
        service_area: "Cape Coral",
        service_specialties: ["handyman"],
      }),
    ]
  );
  return {
    homeownerId: Number(homeowner.rows[0].id),
    professionalId: Number(professional.rows[0].id),
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
    payload: { introduction_text: "Synthetic Workstream schema response." },
    idempotencyKey: `workstream-response-${suffix}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true, response.code);
  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: randomUUID(),
  });
  assert.equal(selection.ok, true, selection.code);
  const context = await pool.query(
    `
    SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationship_participants.id AS professional_participant_id,
      request_relationships.status AS relationship_status
    FROM jobs
    INNER JOIN relationship_participants
      ON relationship_participants.job_id = jobs.id
      AND relationship_participants.user_id = $2
    INNER JOIN request_relationships
      ON request_relationships.id = jobs.source_request_relationship_id
    WHERE jobs.id = $1
    `,
    [selection.lifecycleJob.id, identities.professionalId]
  );
  return {
    requestId: Number(context.rows[0].job_request_id),
    concernId: created.reportedConcern.id,
    originalConcern: created.reportedConcern.originalText,
    jobId: context.rows[0].job_id,
    relationshipId: Number(context.rows[0].relationship_id),
    relationshipStatus: context.rows[0].relationship_status,
    professionalParticipantId: context.rows[0].professional_participant_id,
  };
}

async function createEvaluationAndFindings(
  pool,
  identities,
  fixture,
  suffix
) {
  const evaluation = await createOrdinaryJobEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    content: evaluationContent("Inspected independent property systems."),
    expectedVersion: 0,
    idempotencyKey: `workstream-evaluation-${suffix}`,
    logger: { info() {}, warn() {} },
  });
  assert.equal(evaluation.ok, true, evaluation.code);

  const findings = {};
  for (const [key, statement] of [
    ["disposal", "garbage disposal and drainage fault"],
    ["airConditioning", "refrigerant leak"],
    ["unassigned", "separate unassigned scope finding"],
  ]) {
    const proposed = await submitFinding({
      pool,
      authenticatedActor: { id: identities.professionalId },
      evaluationId: evaluation.evaluation.id,
      statement,
      idempotencyKey: `workstream-finding-${key}-${suffix}`,
      logger: { info() {}, warn() {} },
    });
    assert.equal(proposed.ok, true, proposed.code);
    const confirmed = await confirmFinding({
      pool,
      authenticatedActor: { id: identities.professionalId },
      findingId: proposed.finding.id,
      expectedVersion: 1,
      idempotencyKey: `workstream-confirm-${key}-${suffix}`,
      logger: { info() {}, warn() {} },
    });
    assert.equal(confirmed.ok, true, confirmed.code);
    findings[key] = confirmed.finding;
  }
  return { evaluation, findings };
}

async function insertWorkstream(
  client,
  { jobId, participantId, sequence, title, state }
) {
  const id = randomUUID();
  await client.query(
    `
    INSERT INTO canonical_workstreams (
      id, job_id, sequence, created_by_participant_id,
      source_evidence_type, source_evidence_reference, idempotency_key
    )
    VALUES ($1, $2, $3, $4, 'local_certification', $5, $6)
    `,
    [id, jobId, sequence, participantId, title, randomUUID()]
  );
  await client.query(
    `
    INSERT INTO canonical_workstream_versions (
      workstream_id, version, job_id, title, state,
      created_by_participant_id, integrity_hash
    )
    VALUES ($1, 1, $2, $3, $4, $5, $6)
    `,
    [id, jobId, title, state, participantId, integrity({ id, title, state })]
  );
  return id;
}

async function assignFinding(
  client,
  { findingId, workstreamId, jobId, participantId }
) {
  const id = randomUUID();
  await client.query(
    `
    INSERT INTO canonical_finding_workstream_assignments (
      id, finding_id, workstream_id, job_id, assigned_by_participant_id,
      source_evidence_type, source_evidence_reference, idempotency_key
    )
    VALUES ($1, $2, $3, $4, $5, 'local_certification', $6, $7)
    `,
    [id, findingId, workstreamId, jobId, participantId, id, randomUUID()]
  );
  return id;
}

async function insertActivity(
  client,
  {
    workstreamId,
    jobId,
    participantId,
    activityType,
    statement,
    temporaryIntervention = false,
    temporaryDetails = null,
  }
) {
  const id = randomUUID();
  await client.query(
    `
    INSERT INTO canonical_work_activities (
      id, workstream_id, job_id, actor_participant_id,
      source_evidence_type, source_evidence_reference, idempotency_key
    )
    VALUES ($1, $2, $3, $4, 'local_certification', $5, $6)
    `,
    [id, workstreamId, jobId, participantId, id, randomUUID()]
  );
  await client.query(
    `
    INSERT INTO canonical_work_activity_versions (
      activity_id, version, workstream_id, job_id, activity_type,
      statement, status, temporary_intervention, temporary_details,
      performed_at, created_by_participant_id, integrity_hash
    )
    VALUES ($1, 1, $2, $3, $4, $5, 'DONE', $6, $7,
      CURRENT_TIMESTAMP, $8, $9)
    `,
    [
      id,
      workstreamId,
      jobId,
      activityType,
      statement,
      temporaryIntervention,
      temporaryDetails,
      participantId,
      integrity({ id, statement, temporaryIntervention }),
    ]
  );
  return id;
}

async function insertOpenObligation(
  client,
  { workstreamId, jobId, participantId, sourceFindingId, statement }
) {
  const id = randomUUID();
  await client.query(
    `
    INSERT INTO canonical_workstream_obligations (
      id, workstream_id, job_id, sequence, source_finding_id,
      created_by_participant_id, source_evidence_type,
      source_evidence_reference, idempotency_key
    )
    VALUES ($1, $2, $3, 1, $4, $5, 'local_certification', $6, $7)
    `,
    [id, workstreamId, jobId, sourceFindingId, participantId, id, randomUUID()]
  );
  await client.query(
    `
    INSERT INTO canonical_workstream_obligation_versions (
      obligation_id, version, workstream_id, job_id, statement,
      status, created_by_participant_id, integrity_hash
    )
    VALUES ($1, 1, $2, $3, $4, 'OPEN', $5, $6)
    `,
    [id, workstreamId, jobId, statement, participantId, integrity({ id, statement })]
  );
  return id;
}

async function expectDatabaseError(action, code) {
  await assert.rejects(action, (error) => error?.code === code);
}

test(
  "disposable PostgreSQL applies all 30 migrations and replays cleanly",
  { skip: !cleanDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: cleanDatabaseUrl, max: 2 });
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 44);
      const applied = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(applied.success, true);
      assert.equal(applied.applied.length, 44);
      const replay = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 44);
    } finally {
      await pool.end();
    }
  }
);

test(
  "disposable PostgreSQL upgrades 29 to Workstream foundation without coupling lifecycle states",
  { skip: !upgradeDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: upgradeDatabaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const priorMigrations = migrations.filter(
        (migration) => migration.filename < migrationName
      );
      const migration = migrations.find(
        (candidate) => candidate.filename === migrationName
      );
      assert.equal(priorMigrations.length, 29);
      assert.ok(migration);
      const prior = await runMigrationCollection(
        pool,
        priorMigrations,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(prior.success, true);
      assert.equal(prior.applied.length, 29);

      const identities = await createIdentities(pool, suffix);
      const legacy = await pool.query(
        `
        INSERT INTO posts (user_id, title, description, category, location)
        VALUES ($1, 'Legacy request', 'Legacy request truth', 'handyman', 'Legacy area')
        RETURNING id, title, description, lifecycle_contract_version
        `,
        [identities.homeownerId]
      );
      const fixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-primary`,
        "dishwasher issue"
      );
      const crossFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-cross`,
        "separate property system issue"
      );
      const { evaluation, findings } = await createEvaluationAndFindings(
        pool,
        identities,
        fixture,
        suffix
      );
      const stateBefore = await pool.query(
        `
        SELECT
          posts.status AS request_status,
          request_relationships.status AS relationship_status,
          jobs.job_request_id,
          jobs.source_request_selection_id,
          jobs.source_request_relationship_id,
          jobs.lifecycle_contract_version,
          jobs.source_type,
          (SELECT original_text FROM reported_concerns
            WHERE id = $2) AS concern_text,
          (SELECT resolution_state FROM canonical_evaluation_finding_versions
            WHERE finding_id = $3 ORDER BY version DESC LIMIT 1)
            AS disposal_resolution,
          (SELECT resolution_state FROM canonical_evaluation_finding_versions
            WHERE finding_id = $4 ORDER BY version DESC LIMIT 1)
            AS ac_resolution
        FROM jobs
        INNER JOIN posts ON posts.id = jobs.job_request_id
        INNER JOIN request_relationships
          ON request_relationships.id = jobs.source_request_relationship_id
        WHERE jobs.id = $1
        `,
        [
          fixture.jobId,
          fixture.concernId,
          findings.disposal.id,
          findings.airConditioning.id,
        ]
      );
      assert.equal(stateBefore.rows[0].relationship_status, "active");
      assert.equal(stateBefore.rows[0].concern_text, "dishwasher issue");
      assert.equal(stateBefore.rows[0].disposal_resolution, "OPEN");
      assert.equal(stateBefore.rows[0].ac_resolution, "OPEN");

      const forcedFailure = await runMigrationCollection(
        pool,
        [{
          ...migration,
          sql: `${migration.sql}\nSELECT * FROM missing_slice_003_relation;`,
        }],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(forcedFailure.success, false);
      assert.equal(forcedFailure.failed.length, 1);
      const rolledBack = await pool.query(
        `
        SELECT
          (SELECT count(*) FROM schema_migrations)::integer AS ledger,
          to_regclass('public.canonical_workstreams') IS NULL AS no_workstreams,
          to_regclass('public.canonical_work_activities') IS NULL AS no_activities,
          to_regclass('public.canonical_finding_resolution_events') IS NULL
            AS no_resolution_events
        `
      );
      assert.deepEqual(rolledBack.rows[0], {
        ledger: 29,
        no_workstreams: true,
        no_activities: true,
        no_resolution_events: true,
      });

      const upgraded = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(upgraded.success, true);
      assert.deepEqual(upgraded.applied, [migrationName]);
      const emptyFoundation = await pool.query(
        `
        SELECT
          (SELECT count(*) FROM canonical_workstreams)::integer AS workstreams,
          (SELECT count(*) FROM canonical_work_activities)::integer AS activities,
          (SELECT count(*) FROM canonical_finding_workstream_assignments)::integer
            AS assignments,
          (SELECT count(*) FROM canonical_finding_resolution_events)::integer
            AS resolution_events,
          (SELECT count(*) FROM canonical_workstream_obligations)::integer
            AS obligations
        `
      );
      assert.deepEqual(emptyFoundation.rows[0], {
        workstreams: 0,
        activities: 0,
        assignments: 0,
        resolution_events: 0,
        obligations: 0,
      });

      const workstreams = {};
      for (const [index, [key, title, state]] of [
        ["fan", "Fan", "OPEN"],
        ["smokeDetectors", "Smoke Detectors", "OPEN"],
        ["lighting", "Lighting", "OPEN"],
        ["disposal", "Disposal", "ACTIVE"],
        ["microwave", "Microwave", "OPEN"],
        ["airConditioning", "A/C", "ACTIVE"],
      ].entries()) {
        workstreams[key] = await insertWorkstream(pool, {
          jobId: fixture.jobId,
          participantId: fixture.professionalParticipantId,
          sequence: index + 1,
          title,
          state,
        });
      }
      const crossWorkstream = await insertWorkstream(pool, {
        jobId: crossFixture.jobId,
        participantId: crossFixture.professionalParticipantId,
        sequence: 1,
        title: "Cross-scope Workstream",
        state: "OPEN",
      });

      await assignFinding(pool, {
        findingId: findings.disposal.id,
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
      });
      await assignFinding(pool, {
        findingId: findings.airConditioning.id,
        workstreamId: workstreams.airConditioning,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
      });

      const drainActivity = await insertActivity(pool, {
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        activityType: "CORRECTION",
        statement: "drain obstruction correction",
      });
      const temporaryDisposal = await insertActivity(pool, {
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        activityType: "RESTORATION",
        statement: "temporary disposal restoration",
        temporaryIntervention: true,
        temporaryDetails: "Temporary restoration; disposal defect remains open.",
      });
      await insertActivity(pool, {
        workstreamId: workstreams.airConditioning,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        activityType: "CORRECTIVE_SERVICE",
        statement: "temporary corrective service",
        temporaryIntervention: true,
        temporaryDetails: "Temporary service; refrigerant leak remains open.",
      });
      await insertOpenObligation(pool, {
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        sourceFindingId: findings.disposal.id,
        statement: "disposal replacement",
      });

      const acceptance = await pool.query(
        `
        WITH latest_workstreams AS (
          SELECT DISTINCT ON (workstream_id)
            workstream_id, title, state
          FROM canonical_workstream_versions
          WHERE job_id = $1
          ORDER BY workstream_id, version DESC
        ), latest_activities AS (
          SELECT DISTINCT ON (activity_id)
            activity_id, workstream_id, statement, status,
            temporary_intervention
          FROM canonical_work_activity_versions
          WHERE job_id = $1
          ORDER BY activity_id, version DESC
        )
        SELECT
          (SELECT count(*) FROM canonical_workstreams
            WHERE job_id = $1)::integer AS workstreams,
          (SELECT state FROM latest_workstreams
            WHERE title = 'Disposal') AS disposal_state,
          (SELECT state FROM latest_workstreams
            WHERE title = 'A/C') AS ac_state,
          (SELECT count(*) FROM latest_activities
            WHERE status = 'DONE')::integer AS done_activities,
          (SELECT count(*) FROM latest_activities
            WHERE status = 'DONE' AND temporary_intervention)::integer
            AS temporary_done_activities,
          (SELECT resolution_state
            FROM canonical_evaluation_finding_versions
            WHERE finding_id = $2 ORDER BY version DESC LIMIT 1)
            AS disposal_resolution,
          (SELECT resolution_state
            FROM canonical_evaluation_finding_versions
            WHERE finding_id = $3 ORDER BY version DESC LIMIT 1)
            AS ac_resolution,
          (SELECT status FROM canonical_workstream_obligation_versions
            WHERE workstream_id = $4 ORDER BY version DESC LIMIT 1)
            AS replacement_obligation,
          (SELECT count(*) FROM canonical_finding_resolution_events
            WHERE job_id = $1)::integer AS resolution_events,
          (SELECT status FROM request_relationships WHERE id = $5)
            AS relationship_status
        `,
        [
          fixture.jobId,
          findings.disposal.id,
          findings.airConditioning.id,
          workstreams.disposal,
          fixture.relationshipId,
        ]
      );
      assert.deepEqual(acceptance.rows[0], {
        workstreams: 6,
        disposal_state: "ACTIVE",
        ac_state: "ACTIVE",
        done_activities: 3,
        temporary_done_activities: 2,
        disposal_resolution: "OPEN",
        ac_resolution: "OPEN",
        replacement_obligation: "OPEN",
        resolution_events: 0,
        relationship_status: "active",
      });

      await expectDatabaseError(
        pool.query(
          `
          INSERT INTO canonical_finding_workstream_assignments (
            id, finding_id, workstream_id, job_id,
            assigned_by_participant_id, source_evidence_type,
            source_evidence_reference, idempotency_key
          )
          VALUES ($1, $2, $3, $4, $5, 'local_certification', $6, $7)
          `,
          [
            randomUUID(),
            findings.unassigned.id,
            crossWorkstream,
            crossFixture.jobId,
            crossFixture.professionalParticipantId,
            suffix,
            randomUUID(),
          ]
        ),
        "23503"
      );
      await expectDatabaseError(
        pool.query(
          `
          INSERT INTO canonical_work_activities (
            id, workstream_id, job_id, actor_participant_id,
            source_evidence_type, source_evidence_reference, idempotency_key
          )
          VALUES ($1, $2, $3, $4, 'local_certification', $5, $6)
          `,
          [
            randomUUID(),
            workstreams.disposal,
            crossFixture.jobId,
            crossFixture.professionalParticipantId,
            suffix,
            randomUUID(),
          ]
        ),
        "23503"
      );
      await expectDatabaseError(
        pool.query(
          `
          INSERT INTO canonical_workstream_versions (
            workstream_id, version, job_id, title, state,
            created_by_participant_id, integrity_hash
          )
          VALUES ($1, 2, $2, 'Invalid state', 'FINISHED', $3, $4)
          `,
          [
            workstreams.fan,
            fixture.jobId,
            fixture.professionalParticipantId,
            integrity("invalid-state"),
          ]
        ),
        "23514"
      );

      const invalidTemporaryId = randomUUID();
      await pool.query(
        `
        INSERT INTO canonical_work_activities (
          id, workstream_id, job_id, actor_participant_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, $4, 'local_certification', $5, $6)
        `,
        [
          invalidTemporaryId,
          workstreams.disposal,
          fixture.jobId,
          fixture.professionalParticipantId,
          invalidTemporaryId,
          randomUUID(),
        ]
      );
      await expectDatabaseError(
        pool.query(
          `
          INSERT INTO canonical_work_activity_versions (
            activity_id, version, workstream_id, job_id, activity_type,
            statement, status, temporary_intervention, temporary_details,
            performed_at, created_by_participant_id, integrity_hash
          )
          VALUES ($1, 1, $2, $3, 'RESTORATION', 'invalid temporary',
            'DONE', TRUE, NULL, CURRENT_TIMESTAMP, $4, $5)
          `,
          [
            invalidTemporaryId,
            workstreams.disposal,
            fixture.jobId,
            fixture.professionalParticipantId,
            integrity("invalid-temporary"),
          ]
        ),
        "23514"
      );
      await expectDatabaseError(
        pool.query(
          `
          INSERT INTO canonical_finding_workstream_assignments (
            id, finding_id, workstream_id, job_id,
            assigned_by_participant_id, source_evidence_type,
            source_evidence_reference, idempotency_key
          )
          VALUES ($1, $2, $3, $4, $5, 'local_certification', $6, $7)
          `,
          [
            randomUUID(),
            findings.disposal.id,
            workstreams.disposal,
            fixture.jobId,
            fixture.professionalParticipantId,
            suffix,
            randomUUID(),
          ]
        ),
        "23505"
      );
      await expectDatabaseError(
        pool.query(
          `
          INSERT INTO canonical_finding_resolution_events (
            id, finding_id, previous_finding_version, finding_version,
            job_id, previous_resolution_state, resolution_state,
            resolution_statement, recorded_by_participant_id,
            source_evidence_type, source_evidence_reference,
            idempotency_key, integrity_hash
          )
          VALUES ($1, $2, 1, 2, $3, 'OPEN', 'RESOLVED',
            'activity was done', $4,
            'local_certification', $5, $6, $7)
          `,
          [
            randomUUID(),
            findings.disposal.id,
            fixture.jobId,
            fixture.professionalParticipantId,
            suffix,
            randomUUID(),
            integrity("false-resolution"),
          ]
        ),
        "23503"
      );
      await expectDatabaseError(
        pool.query(
          "DELETE FROM canonical_work_activity_versions WHERE activity_id = $1",
          [drainActivity]
        ),
        "55000"
      );
      await expectDatabaseError(
        pool.query("DELETE FROM canonical_workstreams WHERE id = $1", [
          workstreams.disposal,
        ]),
        "55000"
      );

      const schema = await pool.query(
        `
        SELECT
          to_regclass('public.canonical_workstream_job_order_idx') IS NOT NULL
            AS workstream_order_index,
          to_regclass('public.canonical_workstream_job_state_idx') IS NOT NULL
            AS workstream_state_index,
          to_regclass('public.canonical_work_activity_state_time_idx') IS NOT NULL
            AS activity_index,
          to_regclass('public.canonical_finding_workstream_lookup_idx') IS NOT NULL
            AS finding_index,
          to_regclass('public.canonical_finding_resolution_history_idx') IS NOT NULL
            AS resolution_index,
          to_regclass('public.canonical_workstream_obligation_state_idx') IS NOT NULL
            AS obligation_index,
          (SELECT count(*) FROM pg_trigger
            WHERE tgname LIKE 'canonical_%_append_only'
              AND tgname IN (
                'canonical_workstreams_append_only',
                'canonical_workstream_versions_append_only',
                'canonical_finding_workstream_assignments_append_only',
                'canonical_work_activities_append_only',
                'canonical_work_activity_versions_append_only',
                'canonical_finding_resolution_events_append_only',
                'canonical_workstream_obligations_append_only',
                'canonical_workstream_obligation_versions_append_only'
              )
              AND NOT tgisinternal)::integer AS append_only_triggers,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'jobs'
              AND column_name IN ('state', 'status')
          ) AS job_state_column
        `
      );
      assert.deepEqual(schema.rows[0], {
        workstream_order_index: true,
        workstream_state_index: true,
        activity_index: true,
        finding_index: true,
        resolution_index: true,
        obligation_index: true,
        append_only_triggers: 8,
        job_state_column: false,
      });

      const preserved = await pool.query(
        `
        SELECT
          (SELECT row_to_json(legacy_row) FROM (
            SELECT id, title, description, lifecycle_contract_version
            FROM posts WHERE id = $1
          ) AS legacy_row) AS legacy,
          (SELECT row_to_json(job_state) FROM (
            SELECT posts.status AS request_status,
              request_relationships.status AS relationship_status,
              jobs.job_request_id, jobs.source_request_selection_id::text
                AS source_request_selection_id,
              jobs.source_request_relationship_id,
              jobs.lifecycle_contract_version, jobs.source_type,
              (SELECT original_text FROM reported_concerns WHERE id = $3)
                AS concern_text,
              (SELECT resolution_state
                FROM canonical_evaluation_finding_versions
                WHERE finding_id = $4 ORDER BY version DESC LIMIT 1)
                AS disposal_resolution,
              (SELECT resolution_state
                FROM canonical_evaluation_finding_versions
                WHERE finding_id = $5 ORDER BY version DESC LIMIT 1)
                AS ac_resolution
            FROM jobs
            INNER JOIN posts ON posts.id = jobs.job_request_id
            INNER JOIN request_relationships
              ON request_relationships.id = jobs.source_request_relationship_id
            WHERE jobs.id = $2
          ) AS job_state) AS job_state,
          (SELECT count(*) FROM schema_migrations)::integer AS ledger
        `,
        [
          legacy.rows[0].id,
          fixture.jobId,
          fixture.concernId,
          findings.disposal.id,
          findings.airConditioning.id,
        ]
      );
      assert.deepEqual(preserved.rows[0].legacy, {
        id: legacy.rows[0].id,
        title: "Legacy request",
        description: "Legacy request truth",
        lifecycle_contract_version: 1,
      });
      assert.deepEqual(preserved.rows[0].job_state, stateBefore.rows[0]);
      assert.equal(preserved.rows[0].ledger, 30);

      const replay = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.equal(replay.applied.length, 0);
      assert.deepEqual(replay.skipped, [migrationName]);
      assert.equal(evaluation.aggregate.sourceContext.jobId, fixture.jobId);
      assert.equal(temporaryDisposal.length, 36);
    } finally {
      await pool.end();
    }
  }
);

test(
  "disposable PostgreSQL certifies governed Workstream runtime without resolution or completion authority",
  { skip: !runtimeDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: runtimeDatabaseUrl, max: 12 });
    const suffix = randomUUID();
    const logger = { info() {}, warn() {} };
    const actor = (id) => ({ id });
    const command = (operation, input, key) => operation({
      pool,
      logger,
      idempotencyKey: key,
      ...input,
    });

    try {
      const migrations = await runMigrationCollection(
        pool,
        getMigrationFiles(),
        targetMetadata(runtimeDatabaseUrl)
      );
      assert.equal(migrations.success, true);
      assert.equal(migrations.applied.length, 44);

      const identities = await createIdentities(pool, suffix);
      const outsider = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ('Unselected Professional', $1, 'test-only-hash',
          'handyman', 'professional')
        RETURNING id
        `,
        [`workstream-outsider-${suffix}@example.test`]
      );
      const specialist = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ('Synthetic Specialist', $1, 'test-only-hash',
          'handyman', 'professional')
        RETURNING id
        `,
        [`workstream-specialist-${suffix}@example.test`]
      );
      const legacy = await pool.query(
        `
        INSERT INTO posts (user_id, title, description, category, location)
        VALUES ($1, 'Legacy runtime request', 'Legacy runtime truth',
          'handyman', 'Legacy area')
        RETURNING id, title, description, lifecycle_contract_version
        `,
        [identities.homeownerId]
      );
      const fixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-runtime-primary`,
        "dishwasher issue"
      );
      const crossFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-runtime-cross`,
        "separate property system issue"
      );
      const primary = await createEvaluationAndFindings(
        pool,
        identities,
        fixture,
        `${suffix}-runtime-primary`
      );
      const cross = await createEvaluationAndFindings(
        pool,
        identities,
        crossFixture,
        `${suffix}-runtime-cross`
      );

      const prestate = await pool.query(
        `
        SELECT posts.status AS request_status,
          request_relationships.status AS relationship_status,
          (SELECT resolution_state
            FROM canonical_evaluation_finding_versions
            WHERE finding_id = $2 ORDER BY version DESC LIMIT 1)
            AS finding_resolution,
          (SELECT confirmation_state
            FROM canonical_evaluation_finding_versions
            WHERE finding_id = $2 ORDER BY version DESC LIMIT 1)
            AS finding_confirmation
        FROM jobs
        INNER JOIN posts ON posts.id = jobs.job_request_id
        INNER JOIN request_relationships
          ON request_relationships.id = jobs.source_request_relationship_id
        WHERE jobs.id = $1
        `,
        [fixture.jobId, primary.findings.disposal.id]
      );
      assert.deepEqual(prestate.rows[0], {
        request_status: "open",
        relationship_status: "active",
        finding_resolution: "OPEN",
        finding_confirmation: "CONFIRMED",
      });

      const grants = await pool.query(
        `
        SELECT participants.user_id, grants.capability
        FROM lifecycle_authority_grants AS grants
        INNER JOIN relationship_participants AS participants
          ON participants.id = grants.grantee_participant_id
        WHERE grants.job_id = $1
        ORDER BY participants.user_id, grants.capability
        `,
        [fixture.jobId]
      );
      const professionalCapabilities = grants.rows
        .filter((row) => Number(row.user_id) === identities.professionalId)
        .map((row) => row.capability);
      for (const capability of Object.values(WORKFLOW_CAPABILITIES)) {
        assert.equal(professionalCapabilities.includes(capability), true);
      }
      assert.equal(
        grants.rows.some((row) =>
          Number(row.user_id) === identities.homeownerId &&
          Object.values(WORKFLOW_CAPABILITIES).includes(row.capability)
        ),
        false
      );

      const workstreams = {};
      for (const [index, [key, title]] of [
        ["fan", "Fan"],
        ["smokeDetectors", "Smoke Detectors"],
        ["lighting", "Lighting"],
        ["disposal", "Disposal"],
        ["microwave", "Microwave"],
        ["airConditioning", "A/C"],
      ].entries()) {
        const created = await command(createWorkstream, {
          authenticatedActor: actor(identities.professionalId),
          jobId: fixture.jobId,
          title,
          sequence: index + 1,
        }, `runtime-workstream-${key}`);
        assert.equal(created.ok, true, created.code);
        assert.equal(created.workstream.state, "OPEN");
        workstreams[key] = created.workstream.id;
      }

      const replayedWorkstream = await command(createWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        title: "Disposal",
        sequence: 4,
      }, "runtime-workstream-disposal");
      assert.equal(replayedWorkstream.replayed, true);
      assert.equal(replayedWorkstream.workstream.id, workstreams.disposal);
      const conflictingWorkstream = await command(createWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        title: "Changed Disposal",
        sequence: 4,
      }, "runtime-workstream-disposal");
      assert.equal(conflictingWorkstream.code, "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");

      const listed = await listWorkstreams({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
      });
      assert.deepEqual(
        listed.workstreams.map((row) => row.title),
        ["Fan", "Smoke Detectors", "Lighting", "Disposal", "Microwave", "A/C"]
      );
      assert.equal((await getWorkstream({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
      })).workstream.id, workstreams.disposal);

      const homeownerDenied = await command(createWorkstream, {
        authenticatedActor: actor(identities.homeownerId),
        jobId: fixture.jobId,
        title: "Unauthorized",
        sequence: 7,
      }, "homeowner-workstream-denied");
      assert.equal(homeownerDenied.code, "WORKFLOW_AUTHORITY_REQUIRED");
      const outsiderDenied = await command(createWorkstream, {
        authenticatedActor: actor(Number(outsider.rows[0].id)),
        jobId: fixture.jobId,
        title: "Unauthorized",
        sequence: 7,
      }, "outsider-workstream-denied");
      assert.equal(outsiderDenied.code, "WORKFLOW_UNAVAILABLE");

      const professionalParticipant = await pool.query(
        `
        SELECT id FROM relationship_participants
        WHERE job_id = $1 AND user_id = $2
        `,
        [fixture.jobId, identities.professionalId]
      );
      const specialistParticipantId = randomUUID();
      await pool.query(
        `
        INSERT INTO relationship_participants (
          id, job_id, request_relationship_id, user_id,
          source_evidence_type, source_evidence_reference
        )
        VALUES ($1, $2, $3, $4, 'request_selection', $5)
        `,
        [
          specialistParticipantId,
          fixture.jobId,
          fixture.relationshipId,
          Number(specialist.rows[0].id),
          `local-certification:${suffix}`,
        ]
      );
      await pool.query(
        `
        INSERT INTO participant_role_assignments (
          id, participant_id, job_id, role, assigned_by_participant_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, 'SPECIALIST', $4,
          'local_certification', $5, $6)
        `,
        [
          randomUUID(),
          specialistParticipantId,
          fixture.jobId,
          professionalParticipant.rows[0].id,
          suffix,
          randomUUID(),
        ]
      );
      const roleOnlyDenied = await command(createWorkstream, {
        authenticatedActor: actor(Number(specialist.rows[0].id)),
        jobId: fixture.jobId,
        title: "Role only",
        sequence: 7,
      }, "role-only-denied");
      assert.equal(roleOnlyDenied.code, "WORKFLOW_AUTHORITY_REQUIRED");

      const expiredGrantId = randomUUID();
      await pool.query(
        `
        INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id, valid_from, valid_until,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, $4, 'workstream.create', 'job', $4,
          CURRENT_TIMESTAMP - INTERVAL '2 hours',
          CURRENT_TIMESTAMP - INTERVAL '1 hour',
          'local_certification', $5, $6)
        `,
        [
          expiredGrantId,
          specialistParticipantId,
          professionalParticipant.rows[0].id,
          fixture.jobId,
          suffix,
          randomUUID(),
        ]
      );
      assert.equal((await command(createWorkstream, {
        authenticatedActor: actor(Number(specialist.rows[0].id)),
        jobId: fixture.jobId,
        title: "Expired",
        sequence: 7,
      }, "expired-grant-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");

      const revokedGrantId = randomUUID();
      await pool.query(
        `
        INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, $4, 'workstream.create', 'job', $4,
          'local_certification', $5, $6)
        `,
        [
          revokedGrantId,
          specialistParticipantId,
          professionalParticipant.rows[0].id,
          fixture.jobId,
          suffix,
          randomUUID(),
        ]
      );
      await pool.query(
        `
        INSERT INTO lifecycle_authority_grant_revocations (
          id, authority_grant_id, job_id, revoked_by_participant_id,
          revocation_reason, source_evidence_type,
          source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, $4, 'local certification',
          'local_certification', $5, $6)
        `,
        [
          randomUUID(),
          revokedGrantId,
          fixture.jobId,
          professionalParticipant.rows[0].id,
          suffix,
          randomUUID(),
        ]
      );
      assert.equal((await command(createWorkstream, {
        authenticatedActor: actor(Number(specialist.rows[0].id)),
        jobId: fixture.jobId,
        title: "Revoked",
        sequence: 7,
      }, "revoked-grant-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");

      const assignment = await command(assignFindingToWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        findingId: primary.findings.disposal.id,
      }, "runtime-finding-assignment");
      assert.equal(assignment.ok, true, assignment.code);
      assert.equal((await command(assignFindingToWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        findingId: primary.findings.disposal.id,
      }, "runtime-finding-assignment")).replayed, true);
      assert.equal((await command(assignFindingToWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.fan,
        findingId: primary.findings.disposal.id,
      }, "runtime-finding-assignment")).code, "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");
      assert.equal((await command(assignFindingToWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        findingId: cross.findings.disposal.id,
      }, "cross-job-finding-denied")).code, "FINDING_WORKSTREAM_SCOPE_MISMATCH");

      const createActivity = async (key, values) => command(createWorkActivity, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        ...values,
      }, key);
      const drain = await createActivity("runtime-drain-activity", {
        activityType: "CORRECTION",
        statement: "drain obstruction correction",
      });
      assert.equal(drain.activity.status, "PLANNED");
      assert.equal((await createActivity("runtime-drain-activity", {
        activityType: "CORRECTION",
        statement: "drain obstruction correction",
      })).replayed, true);
      assert.equal((await createActivity("runtime-drain-activity", {
        activityType: "CORRECTION",
        statement: "changed drain correction",
      })).code, "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");

      const progress = async (key, activityId, expectedVersion, targetStatus) =>
        command(progressWorkActivity, {
          authenticatedActor: actor(identities.professionalId),
          jobId: fixture.jobId,
          workstreamId: workstreams.disposal,
          activityId,
          expectedVersion,
          targetStatus,
        }, key);
      const drainStarted = await progress(
        "runtime-drain-start",
        drain.activity.id,
        1,
        "IN_PROGRESS"
      );
      assert.equal(drainStarted.activity.currentVersion, 2);
      assert.equal((await progress(
        "runtime-drain-start",
        drain.activity.id,
        1,
        "IN_PROGRESS"
      )).replayed, true);
      assert.equal((await progress(
        "runtime-drain-start",
        drain.activity.id,
        2,
        "DONE"
      )).code, "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");
      const drainDone = await progress(
        "runtime-drain-done",
        drain.activity.id,
        2,
        "DONE"
      );
      assert.equal(drainDone.activity.status, "DONE");
      assert.ok(drainDone.activity.performedAt);
      assert.equal((await progress(
        "runtime-drain-stale",
        drain.activity.id,
        1,
        "IN_PROGRESS"
      )).code, "STALE_WORK_ACTIVITY_VERSION");

      const temporary = await createActivity("runtime-temporary-activity", {
        activityType: "RESTORATION",
        statement: "temporary disposal restoration",
        temporaryIntervention: true,
        temporaryDetails: "Temporary restoration; disposal defect remains open.",
      });
      await progress(
        "runtime-temporary-start",
        temporary.activity.id,
        1,
        "IN_PROGRESS"
      );
      const temporaryDone = await progress(
        "runtime-temporary-done",
        temporary.activity.id,
        2,
        "DONE"
      );
      assert.equal(temporaryDone.activity.status, "DONE");
      assert.equal(temporaryDone.activity.temporaryIntervention, true);

      const createOnlyGrant = randomUUID();
      await pool.query(
        `
        INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, $4, 'work_activity.create', 'job', $4,
          'local_certification', $5, $6)
        `,
        [
          createOnlyGrant,
          specialistParticipantId,
          professionalParticipant.rows[0].id,
          fixture.jobId,
          suffix,
          randomUUID(),
        ]
      );
      const specialistActivity = await command(createWorkActivity, {
        authenticatedActor: actor(Number(specialist.rows[0].id)),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        activityType: "INSPECTION",
        statement: "bounded specialist inspection",
      }, "specialist-create-only");
      assert.equal(specialistActivity.ok, true, specialistActivity.code);
      assert.equal((await command(progressWorkActivity, {
        authenticatedActor: actor(Number(specialist.rows[0].id)),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        activityId: specialistActivity.activity.id,
        expectedVersion: 1,
        targetStatus: "IN_PROGRESS",
      }, "specialist-progress-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      assert.equal((await command(createWorkActivity, {
        authenticatedActor: actor(identities.professionalId),
        jobId: crossFixture.jobId,
        workstreamId: workstreams.disposal,
        activityType: "INSPECTION",
        statement: "wrong scope",
      }, "wrong-job-activity-denied")).code, "WORKSTREAM_ACTIVITY_CLOSED");

      const concurrent = await createActivity("runtime-concurrent-activity", {
        activityType: "CORRECTION",
        statement: "concurrent optimistic progression",
      });
      await progress(
        "runtime-concurrent-start",
        concurrent.activity.id,
        1,
        "IN_PROGRESS"
      );
      const competingProgressions = await Promise.all([
        progress(
          "runtime-concurrent-done-a",
          concurrent.activity.id,
          2,
          "DONE"
        ),
        progress(
          "runtime-concurrent-done-b",
          concurrent.activity.id,
          2,
          "DONE"
        ),
      ]);
      assert.equal(
        competingProgressions.filter((result) => result.ok).length,
        1
      );
      assert.equal(
        competingProgressions.filter(
          (result) => result.code === "STALE_WORK_ACTIVITY_VERSION"
        ).length,
        1
      );

      const malformedTemporary = await createWorkActivity({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        activityType: "RESTORATION",
        statement: "missing temporary detail",
        temporaryIntervention: true,
        temporaryDetails: "",
        idempotencyKey: "malformed-temporary",
      });
      assert.equal(malformedTemporary.code, "INVALID_WORK_ACTIVITY");

      const obligation = await command(createWorkObligation, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        sequence: 1,
        sourceFindingId: primary.findings.disposal.id,
        statement: "replace disposal",
      }, "runtime-obligation");
      assert.equal(obligation.obligation.status, "OPEN");
      assert.equal((await command(createWorkObligation, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        sequence: 1,
        sourceFindingId: primary.findings.disposal.id,
        statement: "replace disposal",
      }, "runtime-obligation")).replayed, true);
      assert.equal((await command(createWorkObligation, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        sequence: 2,
        sourceFindingId: primary.findings.disposal.id,
        statement: "changed replacement",
      }, "runtime-obligation")).code, "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");

      const activities = await listWorkActivities({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
      });
      assert.equal(activities.activities.length, 4);
      assert.equal((await getWorkActivity({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        activityId: drain.activity.id,
      })).activity.status, "DONE");
      assert.equal((await listWorkObligations({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
      })).obligations.length, 1);
      assert.equal((await getWorkObligation({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        obligationId: obligation.obligation.id,
      })).obligation.status, "OPEN");

      const beforeRollback = await pool.query(
        `SELECT count(*)::integer AS count FROM canonical_work_activities`
      );
      await assert.rejects(
        command(createWorkActivity, {
          authenticatedActor: actor(identities.professionalId),
          jobId: fixture.jobId,
          workstreamId: workstreams.disposal,
          activityType: "INSPECTION",
          statement: "must roll back",
          failureInjector: async (stage) => {
            if (stage === "after_write") throw new Error("forced runtime rollback");
          },
        }, "runtime-rollback"),
        /forced runtime rollback/
      );
      const afterRollback = await pool.query(
        `
        SELECT
          (SELECT count(*) FROM canonical_work_activities)::integer AS activities,
          (SELECT count(*) FROM canonical_workflow_command_idempotency
            WHERE idempotency_key = 'runtime-rollback')::integer AS commands
        `
      );
      assert.deepEqual(afterRollback.rows[0], {
        activities: beforeRollback.rows[0].count,
        commands: 0,
      });

      const preserved = await pool.query(
        `
        SELECT
          (SELECT row_to_json(row) FROM (
            SELECT id, title, description, lifecycle_contract_version
            FROM posts WHERE id = $1
          ) AS row) AS legacy,
          (SELECT resolution_state
            FROM canonical_evaluation_finding_versions
            WHERE finding_id = $2 ORDER BY version DESC LIMIT 1)
            AS finding_resolution,
          (SELECT confirmation_state
            FROM canonical_evaluation_finding_versions
            WHERE finding_id = $2 ORDER BY version DESC LIMIT 1)
            AS finding_confirmation,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $3 ORDER BY version DESC LIMIT 1)
            AS disposal_state,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $4 ORDER BY version DESC LIMIT 1)
            AS ac_state,
          (SELECT count(*) FROM canonical_finding_resolution_events
            WHERE job_id = $5)::integer AS resolution_events,
          (SELECT count(*) FROM canonical_workstream_versions
            WHERE job_id = $5 AND state = 'COMPLETED')::integer
            AS completed_workstreams,
          (SELECT count(*) FROM quote_requests)::integer AS quotes,
          (SELECT count(*) FROM canonical_recommendations)::integer
            AS recommendations,
          (SELECT posts.status FROM jobs
            INNER JOIN posts ON posts.id = jobs.job_request_id
            WHERE jobs.id = $5) AS request_status,
          (SELECT request_relationships.status FROM jobs
            INNER JOIN request_relationships
              ON request_relationships.id = jobs.source_request_relationship_id
            WHERE jobs.id = $5) AS relationship_status,
          (SELECT count(*) FROM schema_migrations)::integer AS ledger
        `,
        [
          legacy.rows[0].id,
          primary.findings.disposal.id,
          workstreams.disposal,
          workstreams.airConditioning,
          fixture.jobId,
        ]
      );
      assert.deepEqual(preserved.rows[0], {
        legacy: {
          id: legacy.rows[0].id,
          title: "Legacy runtime request",
          description: "Legacy runtime truth",
          lifecycle_contract_version: 1,
        },
        finding_resolution: "OPEN",
        finding_confirmation: "CONFIRMED",
        disposal_state: "OPEN",
        ac_state: "OPEN",
        resolution_events: 0,
        completed_workstreams: 0,
        quotes: 0,
        recommendations: 0,
        request_status: "open",
        relationship_status: "active",
        ledger: 44,
      });
    } finally {
      await pool.end();
    }
  }
);

test(
  "disposable PostgreSQL certifies governed Finding resolution and Workstream completion",
  { skip: !completionDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: completionDatabaseUrl, max: 12 });
    const suffix = randomUUID();
    const logEntries = [];
    const logger = {
      info(message, metadata) { logEntries.push({ level: "info", message, metadata }); },
      warn(message, metadata) { logEntries.push({ level: "warn", message, metadata }); },
    };
    const actor = (id) => ({ id });
    const command = (operation, input, key) => operation({
      pool,
      logger,
      idempotencyKey: key,
      ...input,
    });

    try {
      const migrations = await runMigrationCollection(
        pool,
        getMigrationFiles(),
        targetMetadata(completionDatabaseUrl)
      );
      assert.equal(migrations.success, true);
      assert.equal(migrations.applied.length, 44);

      const identities = await createIdentities(pool, suffix);
      const fixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-completion-primary`,
        "dishwasher issue"
      );
      const crossFixture = await createLifecycleFixture(
        pool,
        identities,
        `${suffix}-completion-cross`,
        "separate electrical issue"
      );
      const primary = await createEvaluationAndFindings(
        pool,
        identities,
        fixture,
        `${suffix}-completion-primary`
      );
      const cross = await createEvaluationAndFindings(
        pool,
        identities,
        crossFixture,
        `${suffix}-completion-cross`
      );
      const legacy = await pool.query(
        `
        INSERT INTO posts (user_id, title, description, category, location)
        VALUES ($1, 'Legacy completion request', 'Preserved legacy truth',
          'handyman', 'Legacy area')
        RETURNING id, description, lifecycle_contract_version
        `,
        [identities.homeownerId]
      );
      const outsider = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ('Completion Outsider', $1, 'test-only-hash',
          'handyman', 'professional')
        RETURNING id
        `,
        [`completion-outsider-${suffix}@example.test`]
      );
      const roleActor = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ('Completion Role Actor', $1, 'test-only-hash',
          'handyman', 'professional')
        RETURNING id
        `,
        [`completion-role-${suffix}@example.test`]
      );
      const roleActorId = Number(roleActor.rows[0].id);
      const roleParticipantId = randomUUID();
      await pool.query(
        `
        INSERT INTO relationship_participants (
          id, job_id, request_relationship_id, user_id,
          source_evidence_type, source_evidence_reference
        )
        VALUES ($1, $2, $3, $4, 'request_selection', $5)
        `,
        [
          roleParticipantId,
          fixture.jobId,
          fixture.relationshipId,
          roleActorId,
          suffix,
        ]
      );
      await pool.query(
        `
        INSERT INTO participant_role_assignments (
          id, participant_id, job_id, role, assigned_by_participant_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        )
        VALUES ($1, $2, $3, 'SPECIALIST', $4,
          'local_certification', $5, $6)
        `,
        [
          randomUUID(),
          roleParticipantId,
          fixture.jobId,
          fixture.professionalParticipantId,
          suffix,
          randomUUID(),
        ]
      );
      const grant = async (capability, options = {}) => {
        const id = randomUUID();
        await pool.query(
          `
          INSERT INTO lifecycle_authority_grants (
            id, grantee_participant_id, grantor_participant_id, job_id,
            capability, scope_type, scope_job_id, valid_from, valid_until,
            source_evidence_type, source_evidence_reference, idempotency_key
          )
          VALUES ($1, $2, $3, $4, $5, 'job', $4,
            COALESCE($6, CURRENT_TIMESTAMP), $7,
            'local_certification', $8, $9)
          `,
          [
            id,
            roleParticipantId,
            fixture.professionalParticipantId,
            fixture.jobId,
            capability,
            options.validFrom || null,
            options.validUntil || null,
            suffix,
            randomUUID(),
          ]
        );
        if (options.revoked) {
          await pool.query(
            `
            INSERT INTO lifecycle_authority_grant_revocations (
              id, authority_grant_id, job_id, revoked_by_participant_id,
              revocation_reason, source_evidence_type,
              source_evidence_reference, idempotency_key
            )
            VALUES ($1, $2, $3, $4, 'local certification',
              'local_certification', $5, $6)
            `,
            [
              randomUUID(),
              id,
              fixture.jobId,
              fixture.professionalParticipantId,
              suffix,
              randomUUID(),
            ]
          );
        }
        return id;
      };

      const workstreams = {};
      for (const [index, [key, title]] of [
        ["fan", "Fan"],
        ["smokeDetectors", "Smoke Detectors"],
        ["lighting", "Lighting"],
        ["disposal", "Disposal"],
        ["microwave", "Microwave"],
        ["airConditioning", "A/C"],
      ].entries()) {
        workstreams[key] = await insertWorkstream(pool, {
          jobId: fixture.jobId,
          participantId: fixture.professionalParticipantId,
          sequence: index + 1,
          title,
          state: "OPEN",
        });
      }
      await assignFinding(pool, {
        findingId: primary.findings.disposal.id,
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
      });
      await assignFinding(pool, {
        findingId: primary.findings.airConditioning.id,
        workstreamId: workstreams.airConditioning,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
      });
      await insertActivity(pool, {
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        activityType: "CORRECTION",
        statement: "drain obstruction correction",
      });
      const temporaryActivityId = await insertActivity(pool, {
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        activityType: "RESTORATION",
        statement: "temporary disposal restoration",
        temporaryIntervention: true,
        temporaryDetails: "Temporary operation only; replacement remains required.",
      });
      const disposalObligationId = await insertOpenObligation(pool, {
        workstreamId: workstreams.disposal,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        sourceFindingId: primary.findings.disposal.id,
        statement: "replace disposal",
      });

      const eligibilityInput = (workstreamId) => ({
        pool,
        logger,
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId,
      });
      const initialEligibility = await getWorkstreamCompletionEligibility(
        eligibilityInput(workstreams.disposal)
      );
      assert.equal(initialEligibility.eligibility.eligible, false);
      assert.deepEqual(initialEligibility.eligibility.reasons, [
        "OPEN_FINDING",
        "OPEN_OBLIGATION",
      ]);
      const initiallyRejected = await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        expectedVersion: 1,
      }, "completion-disposal-rejected");
      assert.equal(initiallyRejected.code, "WORKSTREAM_COMPLETION_INELIGIBLE");
      assert.deepEqual(initiallyRejected.reasons, [
        "OPEN_FINDING",
        "OPEN_OBLIGATION",
      ]);
      const temporaryInvariant = await pool.query(
        `
        SELECT
          (SELECT status FROM canonical_work_activity_versions
            WHERE activity_id = $1 ORDER BY version DESC LIMIT 1)
            AS temporary_status,
          (SELECT resolution_state FROM canonical_evaluation_finding_versions
            WHERE finding_id = $2 ORDER BY version DESC LIMIT 1)
            AS finding_resolution,
          (SELECT count(*) FROM canonical_finding_resolution_events
            WHERE finding_id = $2)::integer AS resolution_events,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $3 ORDER BY version DESC LIMIT 1)
            AS workstream_state
        `,
        [temporaryActivityId, primary.findings.disposal.id, workstreams.disposal]
      );
      assert.deepEqual(temporaryInvariant.rows[0], {
        temporary_status: "DONE",
        finding_resolution: "OPEN",
        resolution_events: 0,
        workstream_state: "OPEN",
      });

      const disposalResolution = {
        jobId: fixture.jobId,
        findingId: primary.findings.disposal.id,
        expectedVersion: 2,
        expectedResolutionState: "OPEN",
        targetResolutionState: "PARTIALLY_RESOLVED",
        resolutionStatement: "Drain path corrected; disposal replacement remains.",
      };
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(identities.homeownerId),
        ...disposalResolution,
      }, "resolution-homeowner-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(Number(outsider.rows[0].id)),
        ...disposalResolution,
      }, "resolution-outsider-denied")).code, "WORKFLOW_UNAVAILABLE");
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(roleActorId),
        ...disposalResolution,
      }, "resolution-role-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      await grant("finding.resolve", {
        validFrom: new Date(Date.now() - 7200000),
        validUntil: new Date(Date.now() - 3600000),
      });
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(roleActorId),
        ...disposalResolution,
      }, "resolution-expired-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      await grant("finding.resolve", { revoked: true });
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(roleActorId),
        ...disposalResolution,
      }, "resolution-revoked-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      await grant("work_activity.progress");
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(roleActorId),
        ...disposalResolution,
      }, "resolution-progress-only-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      await grant("finding.resolve");
      assert.equal((await command(completeWorkstream, {
        authenticatedActor: actor(roleActorId),
        jobId: fixture.jobId,
        workstreamId: workstreams.smokeDetectors,
        expectedVersion: 1,
      }, "completion-resolve-only-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      assert.equal((await command(transitionWorkObligation, {
        authenticatedActor: actor(roleActorId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        obligationId: disposalObligationId,
        expectedVersion: 1,
        targetStatus: "SATISFIED",
      }, "obligation-resolve-only-denied")).code, "WORKFLOW_AUTHORITY_REQUIRED");
      const boundedSpecialistResolution = await command(resolveFinding, {
        authenticatedActor: actor(roleActorId),
        jobId: fixture.jobId,
        findingId: primary.findings.unassigned.id,
        expectedVersion: 2,
        expectedResolutionState: "OPEN",
        targetResolutionState: "RESOLVED",
        resolutionStatement: "Separate bounded finding verified resolved.",
      }, "resolution-specialist-bounded");
      assert.equal(boundedSpecialistResolution.ok, true);
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(identities.professionalId),
        ...disposalResolution,
        jobId: crossFixture.jobId,
      }, "resolution-wrong-job-denied")).code, "FINDING_UNAVAILABLE");
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(identities.professionalId),
        ...disposalResolution,
        findingId: cross.findings.disposal.id,
      }, "resolution-cross-finding-denied")).code, "FINDING_UNAVAILABLE");
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(identities.professionalId),
        ...disposalResolution,
        expectedVersion: 1,
      }, "resolution-stale-version-denied")).code, "STALE_FINDING_RESOLUTION");
      await assert.rejects(
        command(resolveFinding, {
          authenticatedActor: actor(identities.professionalId),
          ...disposalResolution,
          failureInjector: async (stage) => {
            if (stage === "after_write") {
              throw new Error("forced resolution rollback");
            }
          },
        }, "resolution-rollback"),
        /forced resolution rollback/
      );
      const resolutionRollback = await pool.query(
        `
        SELECT
          (SELECT max(version) FROM canonical_evaluation_finding_versions
            WHERE finding_id = $1)::integer AS finding_version,
          (SELECT count(*) FROM canonical_finding_resolution_events
            WHERE finding_id = $1)::integer AS events,
          (SELECT count(*) FROM canonical_workflow_command_idempotency
            WHERE idempotency_key = 'resolution-rollback')::integer AS commands
        `,
        [primary.findings.disposal.id]
      );
      assert.deepEqual(resolutionRollback.rows[0], {
        finding_version: 2,
        events: 0,
        commands: 0,
      });

      const competingResolutionKeys = [
        "resolution-competing-a",
        "resolution-competing-b",
      ];
      const competingResolutions = await Promise.all(
        competingResolutionKeys.map((key) => command(resolveFinding, {
          authenticatedActor: actor(identities.professionalId),
          ...disposalResolution,
        }, key))
      );
      assert.equal(competingResolutions.filter((result) => result.ok).length, 1);
      assert.equal(competingResolutions.filter(
        (result) => result.code === "STALE_FINDING_RESOLUTION"
      ).length, 1);
      const winningResolutionIndex = competingResolutions.findIndex(
        (result) => result.ok
      );
      const resolutionReplay = await command(resolveFinding, {
        authenticatedActor: actor(identities.professionalId),
        ...disposalResolution,
      }, competingResolutionKeys[winningResolutionIndex]);
      assert.equal(resolutionReplay.replayed, true);
      assert.equal((await command(resolveFinding, {
        authenticatedActor: actor(identities.professionalId),
        ...disposalResolution,
        resolutionStatement: "Conflicting reuse must be rejected.",
      }, competingResolutionKeys[winningResolutionIndex])).code,
      "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");

      const partialEligibility = await getWorkstreamCompletionEligibility(
        eligibilityInput(workstreams.disposal)
      );
      assert.deepEqual(partialEligibility.eligibility.reasons, [
        "PARTIAL_FINDING",
        "OPEN_OBLIGATION",
      ]);
      assert.equal((await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        expectedVersion: 1,
      }, "completion-partial-rejected")).code,
      "WORKSTREAM_COMPLETION_INELIGIBLE");

      const resolvedDisposal = await command(resolveFinding, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        findingId: primary.findings.disposal.id,
        expectedVersion: 3,
        expectedResolutionState: "PARTIALLY_RESOLVED",
        targetResolutionState: "RESOLVED",
        resolutionStatement: "Replacement condition corrected and verified.",
      }, "resolution-disposal-final");
      assert.equal(resolvedDisposal.finding.currentVersion, 4);
      assert.equal(resolvedDisposal.finding.resolutionState, "RESOLVED");

      const obligationTransition = {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        obligationId: disposalObligationId,
        expectedVersion: 1,
        targetStatus: "SATISFIED",
      };
      await assert.rejects(
        command(transitionWorkObligation, {
          ...obligationTransition,
          failureInjector: async (stage) => {
            if (stage === "after_write") {
              throw new Error("forced obligation rollback");
            }
          },
        }, "obligation-rollback"),
        /forced obligation rollback/
      );
      const obligationRollback = await pool.query(
        `
        SELECT
          (SELECT max(version) FROM canonical_workstream_obligation_versions
            WHERE obligation_id = $1)::integer AS obligation_version,
          (SELECT count(*) FROM canonical_workflow_command_idempotency
            WHERE idempotency_key = 'obligation-rollback')::integer AS commands
        `,
        [disposalObligationId]
      );
      assert.deepEqual(obligationRollback.rows[0], {
        obligation_version: 1,
        commands: 0,
      });
      const satisfied = await command(
        transitionWorkObligation,
        obligationTransition,
        "obligation-disposal-satisfied"
      );
      assert.equal(satisfied.obligation.status, "SATISFIED");
      assert.equal((await command(
        transitionWorkObligation,
        obligationTransition,
        "obligation-disposal-satisfied"
      )).replayed, true);
      assert.equal((await command(transitionWorkObligation, {
        ...obligationTransition,
        targetStatus: "DEFERRED",
      }, "obligation-disposal-satisfied")).code,
      "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");
      assert.equal((await command(transitionWorkObligation, {
        ...obligationTransition,
        expectedVersion: 2,
        targetStatus: "DEFERRED",
      }, "obligation-terminal-denied")).code,
      "INVALID_WORK_OBLIGATION_TRANSITION");

      const disposalEligible = await getWorkstreamCompletionEligibility(
        eligibilityInput(workstreams.disposal)
      );
      assert.equal(disposalEligible.eligibility.eligible, true);
      assert.deepEqual(disposalEligible.eligibility.reasons, []);
      const completedDisposal = await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        expectedVersion: 1,
      }, "completion-disposal");
      assert.equal(completedDisposal.workstream.state, "COMPLETED");
      assert.equal(completedDisposal.workstream.currentVersion, 2);
      assert.equal((await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        expectedVersion: 1,
      }, "completion-disposal")).replayed, true);
      assert.equal((await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        expectedVersion: 2,
      }, "completion-disposal")).code, "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");
      const completedStateRejected = await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.disposal,
        expectedVersion: 2,
      }, "completion-disposal-again");
      assert.equal(completedStateRejected.code,
        "WORKSTREAM_COMPLETION_INELIGIBLE");
      assert.deepEqual(completedStateRejected.reasons,
        ["INELIGIBLE_WORKSTREAM_STATE"]);

      const fanActivity = await command(createWorkActivity, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.fan,
        activityType: "INSPECTION",
        statement: "fan inspection remains planned",
      }, "activity-fan-planned");
      assert.equal(fanActivity.activity.status, "PLANNED");
      const activeActivityEligibility = await getWorkstreamCompletionEligibility(
        eligibilityInput(workstreams.fan)
      );
      assert.deepEqual(activeActivityEligibility.eligibility.reasons,
        ["ACTIVE_ACTIVITY"]);
      assert.equal((await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.fan,
        expectedVersion: 1,
      }, "completion-fan-rejected")).code,
      "WORKSTREAM_COMPLETION_INELIGIBLE");

      const airConditioningObligationId = await insertOpenObligation(pool, {
        workstreamId: workstreams.airConditioning,
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        sourceFindingId: primary.findings.airConditioning.id,
        statement: "replacement scope deliberately excluded",
      });
      const deferredFinding = await command(resolveFinding, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        findingId: primary.findings.airConditioning.id,
        expectedVersion: 2,
        expectedResolutionState: "OPEN",
        targetResolutionState: "DEFERRED",
        resolutionStatement: "Condition remains unresolved and is explicitly deferred.",
      }, "resolution-ac-deferred");
      assert.equal(deferredFinding.finding.resolutionState, "DEFERRED");
      const excludedObligation = await command(transitionWorkObligation, {
        authenticatedActor: actor(identities.professionalId),
        jobId: fixture.jobId,
        workstreamId: workstreams.airConditioning,
        obligationId: airConditioningObligationId,
        expectedVersion: 1,
        targetStatus: "EXCLUDED",
      }, "obligation-ac-excluded");
      assert.equal(excludedObligation.obligation.status, "EXCLUDED");
      const deferredEligibility = await getWorkstreamCompletionEligibility(
        eligibilityInput(workstreams.airConditioning)
      );
      assert.equal(deferredEligibility.eligibility.eligible, true);
      assert.deepEqual(deferredEligibility.eligibility.deferredScope, {
        findings: 1,
        obligations: 1,
      });
      assert.equal((await getWorkstream({
        ...eligibilityInput(workstreams.airConditioning),
      })).workstream.state, "OPEN");

      const completionKeys = ["completion-smoke-a", "completion-smoke-b"];
      const competingCompletions = await Promise.all(
        completionKeys.map((key) => command(completeWorkstream, {
          authenticatedActor: actor(identities.professionalId),
          jobId: fixture.jobId,
          workstreamId: workstreams.smokeDetectors,
          expectedVersion: 1,
        }, key))
      );
      assert.equal(competingCompletions.filter((result) => result.ok).length, 1);
      assert.equal(competingCompletions.filter(
        (result) => result.code === "STALE_WORKSTREAM_VERSION"
      ).length, 1);
      const smokeHistory = await pool.query(
        `
        SELECT version, state
        FROM canonical_workstream_versions
        WHERE workstream_id = $1
        ORDER BY version
        `,
        [workstreams.smokeDetectors]
      );
      assert.deepEqual(smokeHistory.rows, [
        { version: 1, state: "OPEN" },
        { version: 2, state: "COMPLETED" },
      ]);

      assert.equal((await command(completeWorkstream, {
        authenticatedActor: actor(identities.professionalId),
        jobId: randomUUID(),
        workstreamId: workstreams.lighting,
        expectedVersion: 1,
      }, "completion-legacy-or-unknown-denied")).code, "WORKFLOW_UNAVAILABLE");

      const preserved = await pool.query(
        `
        SELECT
          (SELECT posts.status FROM jobs
            INNER JOIN posts ON posts.id = jobs.job_request_id
            WHERE jobs.id = $1) AS request_status,
          (SELECT request_relationships.status FROM jobs
            INNER JOIN request_relationships
              ON request_relationships.id = jobs.source_request_relationship_id
            WHERE jobs.id = $1) AS relationship_status,
          (SELECT original_text FROM reported_concerns
            WHERE id = $2) AS original_concern,
          (SELECT description FROM posts WHERE id = $3) AS legacy_description,
          (SELECT lifecycle_contract_version FROM posts WHERE id = $3)
            AS legacy_contract,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $4 ORDER BY version DESC LIMIT 1)
            AS disposal_state,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $5 ORDER BY version DESC LIMIT 1)
            AS ac_state,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $6 ORDER BY version DESC LIMIT 1)
            AS fan_state,
          (SELECT count(*) FROM canonical_workstream_versions
            WHERE job_id = $1 AND state = 'COMPLETED')::integer
            AS completed_workstream_versions,
          (SELECT count(*) FROM canonical_finding_resolution_events
            WHERE job_id = $1)::integer AS resolution_events,
          (SELECT count(*) FROM quote_requests)::integer AS quotes,
          (SELECT count(*) FROM canonical_recommendations)::integer
            AS recommendations,
          (SELECT count(*) FROM schema_migrations)::integer AS ledger
        `,
        [
          fixture.jobId,
          fixture.concernId,
          legacy.rows[0].id,
          workstreams.disposal,
          workstreams.airConditioning,
          workstreams.fan,
        ]
      );
      assert.deepEqual(preserved.rows[0], {
        request_status: "open",
        relationship_status: "active",
        original_concern: "dishwasher issue",
        legacy_description: "Preserved legacy truth",
        legacy_contract: 1,
        disposal_state: "COMPLETED",
        ac_state: "OPEN",
        fan_state: "OPEN",
        completed_workstream_versions: 2,
        resolution_events: 4,
        quotes: 0,
        recommendations: 0,
        ledger: 44,
      });
      const disposalHistory = await pool.query(
        `
        SELECT version, resolution_state, confirmation_state, statement
        FROM canonical_evaluation_finding_versions
        WHERE finding_id = $1
        ORDER BY version
        `,
        [primary.findings.disposal.id]
      );
      assert.deepEqual(disposalHistory.rows.map((row) => ({
        version: row.version,
        resolution_state: row.resolution_state,
        confirmation_state: row.confirmation_state,
      })), [
        { version: 1, resolution_state: "OPEN", confirmation_state: "PROPOSED" },
        { version: 2, resolution_state: "OPEN", confirmation_state: "CONFIRMED" },
        { version: 3, resolution_state: "PARTIALLY_RESOLVED", confirmation_state: "CONFIRMED" },
        { version: 4, resolution_state: "RESOLVED", confirmation_state: "CONFIRMED" },
      ]);
      assert.equal(new Set(disposalHistory.rows.map((row) => row.statement)).size, 1);
      const metadataLogs = JSON.stringify(logEntries);
      for (const privateText of [
        "dishwasher issue",
        "garbage disposal and drainage fault",
        "drain obstruction correction",
        "replace disposal",
      ]) {
        assert.equal(metadataLogs.includes(privateText), false);
      }
      for (const code of [
        "FINDING_RESOLUTION_ATTEMPTED",
        "FINDING_RESOLUTION_RECORDED",
        "WORKSTREAM_COMPLETION_INELIGIBLE",
        "WORKSTREAM_COMPLETED",
        "WORKFLOW_AUTHORITY_DENIED",
      ]) {
        assert.equal(metadataLogs.includes(code), true, code);
      }
    } finally {
      await pool.end();
    }
  }
);
