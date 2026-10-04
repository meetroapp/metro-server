"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
} = require("./helpers/visitLifecycleFixture");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.EVALUATION_VISIT_R2_DATABASE_URL;
const migrationName =
  "202608250001_correct_evaluation_visit_authority_and_negotiation.sql";
const hash = "a".repeat(64);

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

async function expectDatabaseRejection(pool, statement, values, code) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      client.query(statement, values),
      (error) => error && error.code === code
    );
    await client.query("ROLLBACK");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original assertion remains authoritative.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function insertCommand(
  pool,
  fixture,
  actorParticipantId,
  commandName,
  scope
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO canonical_visit_command_idempotency (
       id, actor_participant_id, job_id, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      actorParticipantId,
      fixture.jobId,
      commandName,
      scope,
      randomUUID(),
      hash,
    ]
  );
  return id;
}

async function createLegacyEvaluationVisit(pool, fixture) {
  const commandId = await insertCommand(
    pool,
    fixture,
    fixture.professionalParticipantId,
    "visit.propose",
    "evaluation-visit-r2:legacy-proposal"
  );
  const visitId = randomUUID();
  await pool.query(
    `INSERT INTO canonical_visits (
       id, job_id, purpose, created_by_participant_id,
       created_command_idempotency_id
     ) VALUES ($1, $2, 'EVALUATION', $3, $4)`,
    [
      visitId,
      fixture.jobId,
      fixture.professionalParticipantId,
      commandId,
    ]
  );
  await pool.query(
    `INSERT INTO canonical_visit_versions (
       visit_id, version, job_id, state, scheduled_start_at,
       scheduled_end_at, time_zone, location_mode,
       recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES (
       $1, 1, $2, 'PROPOSED', '2026-09-01T14:00:00.000Z',
       '2026-09-01T15:00:00.000Z', 'America/New_York',
       'JOB_SERVICE_LOCATION', $3, $4, $5
     )`,
    [
      visitId,
      fixture.jobId,
      fixture.professionalParticipantId,
      commandId,
      hash,
    ]
  );
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO canonical_visit_events (
       id, visit_id, visit_version, previous_visit_version, job_id,
       event_type, visit_state, recorded_by_participant_id,
       command_idempotency_id
     ) VALUES (
       $1, $2, 1, NULL, $3, 'VISIT_PROPOSED', 'PROPOSED', $4, $5
     )`,
    [
      eventId,
      visitId,
      fixture.jobId,
      fixture.professionalParticipantId,
      commandId,
    ]
  );
  return { visitId, eventId };
}

test(
  "migration 56 upgrades ledger 55 without backfill and preserves canonical Visit protections",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const migrationIndex = migrations.findIndex(
        ({ filename }) => filename === migrationName
      );
      const priorMigrations = migrations.slice(0, migrationIndex);
      const migration = migrations[migrationIndex];
      assert.equal(priorMigrations.length, 55);
      assert.equal(migration.filename, migrationName);

      const baseline = await runMigrationCollection(
        pool,
        priorMigrations,
        targetMetadata()
      );
      assert.equal(baseline.success, true, baseline.errorCode);
      assert.equal(baseline.applied.length, 55);

      const emptyBusinessState = await pool.query(
        `SELECT
           (SELECT count(*) FROM canonical_visits)::integer AS visits,
           (SELECT count(*) FROM canonical_visit_versions)::integer AS versions,
           (SELECT count(*) FROM canonical_visit_events)::integer AS events,
           (SELECT count(*) FROM canonical_visit_evaluation_links)::integer AS evaluation_links,
           (SELECT count(*) FROM lifecycle_authority_grants)::integer AS grants`
      );
      assert.deepEqual(emptyBusinessState.rows[0], {
        visits: 0,
        versions: 0,
        events: 0,
        evaluation_links: 0,
        grants: 0,
      });

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-r2`
      );
      const legacyVisit = await createLegacyEvaluationVisit(pool, fixture);
      const before = await pool.query(
        `SELECT
           (SELECT count(*) FROM users)::integer AS users,
           (SELECT count(*) FROM jobs)::integer AS jobs,
           (SELECT count(*) FROM lifecycle_authority_grants)::integer AS grants,
           (SELECT count(*) FROM canonical_visits)::integer AS visits,
           (SELECT count(*) FROM canonical_visit_versions)::integer AS versions,
           (SELECT count(*) FROM canonical_visit_events)::integer AS events,
           (SELECT count(*) FROM canonical_visit_evaluation_links)::integer AS evaluation_links`
      );

      const upgraded = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata()
      );
      assert.equal(upgraded.success, true, upgraded.errorCode);
      assert.deepEqual(upgraded.applied, [migrationName]);

      const after = await pool.query(
        `SELECT
           (SELECT count(*) FROM users)::integer AS users,
           (SELECT count(*) FROM jobs)::integer AS jobs,
           (SELECT count(*) FROM lifecycle_authority_grants)::integer AS grants,
           (SELECT count(*) FROM canonical_visits)::integer AS visits,
           (SELECT count(*) FROM canonical_visit_versions)::integer AS versions,
           (SELECT count(*) FROM canonical_visit_events)::integer AS events,
           (SELECT count(*) FROM canonical_visit_evaluation_links)::integer AS evaluation_links`
      );
      assert.deepEqual(after.rows[0], before.rows[0]);
      assert.equal(after.rows[0].evaluation_links, 0);

      const preserved = await pool.query(
        `SELECT events.id, events.event_type, events.visit_version,
           events.previous_visit_version, versions.state,
           visits.purpose
         FROM canonical_visit_events events
         INNER JOIN canonical_visit_versions versions
           ON versions.visit_id = events.visit_id
          AND versions.version = events.visit_version
         INNER JOIN canonical_visits visits ON visits.id = events.visit_id
         WHERE events.id = $1`,
        [legacyVisit.eventId]
      );
      assert.deepEqual(preserved.rows[0], {
        id: legacyVisit.eventId,
        event_type: "VISIT_PROPOSED",
        visit_version: 1,
        previous_visit_version: null,
        state: "PROPOSED",
        purpose: "EVALUATION",
      });

      await pool.query(
        `INSERT INTO lifecycle_authority_grants (
           id, grantee_participant_id, grantor_participant_id, job_id,
           capability, scope_type, scope_job_id, source_evidence_type,
           source_evidence_reference, idempotency_key
         ) VALUES ($1, $2, $3, $4, 'visit.propose', 'evaluation_visit', $4,
           'local_migration_test', 'evaluation-visit-r2:authority', $5)`,
        [
          randomUUID(),
          fixture.professionalParticipantId,
          fixture.homeownerParticipantId,
          fixture.jobId,
          randomUUID(),
        ]
      );

      await pool.query(
        `INSERT INTO lifecycle_authority_grants (
           id, grantee_participant_id, grantor_participant_id, job_id,
           capability, scope_type, scope_job_id, source_evidence_type,
           source_evidence_reference, idempotency_key
         ) VALUES ($1, $2, $3, $4, 'visit.read', 'job', $4,
           'local_migration_test', 'evaluation-visit-r2:legacy-job-scope', $5)`,
        [
          randomUUID(),
          fixture.homeownerParticipantId,
          fixture.professionalParticipantId,
          fixture.jobId,
          randomUUID(),
        ]
      );

      await expectDatabaseRejection(
        pool,
        `INSERT INTO lifecycle_authority_grants (
           id, grantee_participant_id, grantor_participant_id, job_id,
           capability, scope_type, scope_job_id,
           scope_approved_quote_decision, source_evidence_type,
           source_evidence_reference, idempotency_key
         ) VALUES ($1, $2, $3, $4, 'visit.propose', 'evaluation_visit', $4,
           'APPROVED', 'local_migration_test',
           'evaluation-visit-r2:malformed-authority', $5)`,
        [
          randomUUID(),
          fixture.professionalParticipantId,
          fixture.homeownerParticipantId,
          fixture.jobId,
          randomUUID(),
        ],
        "23514"
      );

      const alternateCommandId = await insertCommand(
        pool,
        fixture,
        fixture.homeownerParticipantId,
        "visit.change_request",
        "evaluation-visit-r2:alternate-v2"
      );
      await pool.query(
        `INSERT INTO canonical_visit_versions (
           visit_id, version, job_id, state, scheduled_start_at,
           scheduled_end_at, time_zone, location_mode,
           recorded_by_participant_id, command_idempotency_id, integrity_hash
         ) VALUES (
           $1, 2, $2, 'PROPOSED', '2026-09-02T15:00:00.000Z',
           '2026-09-02T16:00:00.000Z', 'America/New_York',
           'JOB_SERVICE_LOCATION', $3, $4, $5
         )`,
        [
          legacyVisit.visitId,
          fixture.jobId,
          fixture.homeownerParticipantId,
          alternateCommandId,
          hash,
        ]
      );
      await pool.query(
        `INSERT INTO canonical_visit_events (
           id, visit_id, visit_version, previous_visit_version, job_id,
           event_type, visit_state, recorded_by_participant_id,
           command_idempotency_id
         ) VALUES (
           $1, $2, 2, 1, $3, 'VISIT_SCHEDULE_PROPOSED', 'PROPOSED', $4, $5
         )`,
        [
          randomUUID(),
          legacyVisit.visitId,
          fixture.jobId,
          fixture.homeownerParticipantId,
          alternateCommandId,
        ]
      );

      const invalidCommandId = await insertCommand(
        pool,
        fixture,
        fixture.professionalParticipantId,
        "visit.reschedule",
        "evaluation-visit-r2:invalid-v3"
      );
      await pool.query(
        `INSERT INTO canonical_visit_versions (
           visit_id, version, job_id, state, scheduled_start_at,
           scheduled_end_at, time_zone, location_mode,
           recorded_by_participant_id, command_idempotency_id, integrity_hash
         ) VALUES (
           $1, 3, $2, 'PROPOSED', '2026-09-03T16:00:00.000Z',
           '2026-09-03T17:00:00.000Z', 'America/New_York',
           'JOB_SERVICE_LOCATION', $3, $4, $5
         )`,
        [
          legacyVisit.visitId,
          fixture.jobId,
          fixture.professionalParticipantId,
          invalidCommandId,
          hash,
        ]
      );
      await expectDatabaseRejection(
        pool,
        `INSERT INTO canonical_visit_events (
           id, visit_id, visit_version, previous_visit_version, job_id,
           event_type, visit_state, recorded_by_participant_id,
           command_idempotency_id
         ) VALUES (
           $1, $2, 3, 1, $3, 'VISIT_SCHEDULE_PROPOSED', 'PROPOSED', $4, $5
         )`,
        [
          randomUUID(),
          legacyVisit.visitId,
          fixture.jobId,
          fixture.professionalParticipantId,
          invalidCommandId,
        ],
        "23514"
      );

      const legacyChangeCommandId = await insertCommand(
        pool,
        fixture,
        fixture.professionalParticipantId,
        "visit.change_request",
        "evaluation-visit-r2:legacy-change-evidence"
      );
      await pool.query(
        `INSERT INTO canonical_visit_events (
           id, visit_id, visit_version, previous_visit_version, job_id,
           event_type, visit_state, reason, recorded_by_participant_id,
           command_idempotency_id
         ) VALUES (
           $1, $2, 2, 2, $3, 'VISIT_CHANGE_REQUESTED', 'PROPOSED',
           'Please consider a morning time.', $4, $5
         )`,
        [
          randomUUID(),
          legacyVisit.visitId,
          fixture.jobId,
          fixture.professionalParticipantId,
          legacyChangeCommandId,
        ]
      );

      const linkCommandId = await insertCommand(
        pool,
        fixture,
        fixture.professionalParticipantId,
        "visit.link_evaluation",
        "evaluation-visit-r2:link-command"
      );
      assert.ok(linkCommandId);
      const linkCount = await pool.query(
        `SELECT count(*)::integer AS count
         FROM canonical_visit_evaluation_links
         WHERE visit_id = $1`,
        [legacyVisit.visitId]
      );
      assert.equal(linkCount.rows[0].count, 0);

      await expectDatabaseRejection(
        pool,
        `INSERT INTO canonical_visit_command_idempotency (
           id, actor_participant_id, job_id, command_name, command_scope,
           idempotency_key, request_fingerprint
         ) VALUES ($1, $2, $3, 'visit.unknown', 'unknown', $4, $5)`,
        [
          randomUUID(),
          fixture.professionalParticipantId,
          fixture.jobId,
          randomUUID(),
          hash,
        ],
        "23514"
      );

      const constraints = await pool.query(
        `SELECT conname, convalidated
         FROM pg_constraint
         WHERE conname = ANY($1::text[])
         ORDER BY conname`,
        [[
          "canonical_visit_event_previous_version_fk",
          "canonical_visit_event_version_fk",
          "canonical_visit_evaluation_link_evaluation_fk",
          "canonical_visit_evaluation_link_visit_fk",
          "canonical_visit_version_identity_fk",
        ]]
      );
      assert.equal(constraints.rows.length, 5);
      assert.ok(constraints.rows.every(({ convalidated }) => convalidated));

      await expectDatabaseRejection(
        pool,
        `UPDATE canonical_visit_versions
         SET time_zone = 'UTC'
         WHERE visit_id = $1 AND version = 1`,
        [legacyVisit.visitId],
        "55000"
      );

      const approvedWorkShape = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'lifecycle_authority_grants'::regclass
           AND conname = 'lifecycle_authority_grants_scope_shape_check'`
      );
      assert.match(approvedWorkShape.rows[0].definition, /scope_type = 'approved_work'/i);
      assert.match(approvedWorkShape.rows[0].definition, /scope_approved_quote_decision = 'APPROVED'/i);

      const index = await pool.query(
        `SELECT indexdef
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'lifecycle_authority_grants_evaluation_visit_scope_idx'`
      );
      assert.equal(index.rows.length, 1);
      assert.match(index.rows[0].indexdef, /scope_type = 'evaluation_visit'/i);
      assert.match(index.rows[0].indexdef, /valid_until IS NULL/i);

      const ledger = await pool.query(
        `SELECT count(*)::integer AS count FROM schema_migrations`
      );
      assert.equal(ledger.rows[0].count, 56);
      const replay = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata()
      );
      assert.equal(replay.success, true);
      assert.deepEqual(replay.applied, []);
      assert.deepEqual(replay.skipped, [migrationName]);
    } finally {
      await pool.end();
    }
  }
);
