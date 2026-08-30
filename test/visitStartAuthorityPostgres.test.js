"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");
const {
  completeVisit,
  confirmVisit,
  proposeVisit,
} = require("../server/workflow/visitService");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const databaseUrl = process.env.VISIT_START_AUTHORITY_DATABASE_URL;
const migration58Name =
  "202608270001_add_canonical_visit_start_authority.sql";

function targetMetadata() {
  return {
    target: "local-test",
    database: {
      host: "127.0.0.1",
      database: "meetro_test_visit_start_authority",
    },
  };
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function expectCheckViolation(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      action(client),
      (error) => error?.code === "23514"
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function createScheduledVisit(pool, identities, fixture, suffix) {
  const proposed = await proposeVisit({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    purpose: "EVALUATION",
    scheduledStartAt: "2026-08-27T13:00:00.000Z",
    scheduledEndAt: "2026-08-27T14:00:00.000Z",
    timeZone: "America/New_York",
    locationMode: "JOB_SERVICE_LOCATION",
    workstreamIds: [],
    idempotencyKey: `visit-start-propose-${suffix}`,
    clock: () => new Date("2026-08-26T12:00:00.000Z"),
    logger: quiet,
  });
  assert.equal(proposed.ok, true, proposed.code);
  const confirmed = await confirmVisit({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    jobId: fixture.jobId,
    visitId: proposed.visit.id,
    expectedVersion: proposed.visit.currentVersion,
    idempotencyKey: `visit-start-confirm-${suffix}`,
    clock: () => new Date("2026-08-26T12:05:00.000Z"),
    logger: quiet,
  });
  assert.equal(confirmed.ok, true, confirmed.code);
  assert.equal(confirmed.visit.state, "SCHEDULED");
  return confirmed.visit;
}

async function loadVersion(pool, visitId, version) {
  const result = await pool.query(
    `SELECT visit_id, version, job_id, state, scheduled_start_at,
       scheduled_end_at, time_zone, location_mode, cancellation_reason,
       started_at, cancelled_at, completed_at, recorded_by_participant_id
     FROM canonical_visit_versions
     WHERE visit_id = $1 AND version = $2`,
    [visitId, version]
  );
  return result.rows[0];
}

async function insertCommand(client, fixture, commandName, suffix) {
  const commandId = randomUUID();
  await client.query(
    `INSERT INTO canonical_visit_command_idempotency (
       id, actor_participant_id, job_id, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      commandId,
      fixture.professionalParticipantId,
      fixture.jobId,
      commandName,
      `visit:${suffix}`,
      `visit-start-${suffix}`,
      fingerprint(`${commandName}:${suffix}`),
    ]
  );
  return commandId;
}

async function insertVersion(client, {
  source,
  fixture,
  commandId,
  version,
  state,
  startedAt = null,
  cancelledAt = null,
  completedAt = null,
  cancellationReason = null,
}) {
  await client.query(
    `INSERT INTO canonical_visit_versions (
       visit_id, version, job_id, state, scheduled_start_at,
       scheduled_end_at, time_zone, location_mode, cancellation_reason,
       started_at, cancelled_at, completed_at, recorded_by_participant_id,
       command_idempotency_id, integrity_hash
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15
     )`,
    [
      source.visit_id,
      version,
      fixture.jobId,
      state,
      source.scheduled_start_at,
      source.scheduled_end_at,
      source.time_zone,
      source.location_mode,
      cancellationReason,
      startedAt,
      cancelledAt,
      completedAt,
      fixture.professionalParticipantId,
      commandId,
      fingerprint(`visit-version:${source.visit_id}:${version}:${state}`),
    ]
  );
}

async function insertEvent(client, {
  source,
  fixture,
  commandId,
  visitVersion,
  previousVisitVersion,
  eventType,
  visitState,
  classification = null,
  acknowledged = null,
  reason = null,
}) {
  await client.query(
    `INSERT INTO canonical_visit_events (
       id, visit_id, visit_version, previous_visit_version, job_id,
       event_type, visit_state, reason, start_timing_classification,
       schedule_variance_acknowledged, recorded_by_participant_id,
       command_idempotency_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      randomUUID(),
      source.visit_id,
      visitVersion,
      previousVisitVersion,
      fixture.jobId,
      eventType,
      visitState,
      reason,
      classification,
      acknowledged,
      fixture.professionalParticipantId,
      commandId,
    ]
  );
}

async function insertStartedTransition(client, {
  source,
  fixture,
  suffix,
  startedAt = "2026-08-27T12:52:00.000Z",
  classification = "WITHIN_EARLY_WINDOW",
  acknowledged = false,
  previousVisitVersion = source.version,
}) {
  const commandId = await insertCommand(client, fixture, "visit.start", suffix);
  const version = Number(source.version) + 1;
  await insertVersion(client, {
    source,
    fixture,
    commandId,
    version,
    state: "STARTED",
    startedAt,
  });
  await insertEvent(client, {
    source,
    fixture,
    commandId,
    visitVersion: version,
    previousVisitVersion,
    eventType: "VISIT_STARTED",
    visitState: "STARTED",
    classification,
    acknowledged,
  });
  return { commandId, version, startedAt };
}

async function businessCounts(pool) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM canonical_visits)::integer AS visits,
       (SELECT count(*) FROM canonical_visit_versions)::integer AS visit_versions,
       (SELECT count(*) FROM canonical_visit_events)::integer AS visit_events,
       (SELECT count(*) FROM canonical_visit_command_idempotency)::integer AS visit_commands,
       (SELECT count(*) FROM lifecycle_authority_grants)::integer AS authority_grants,
       (SELECT count(*) FROM canonical_evaluation_visit_authority_activations)::integer AS evaluation_activations,
       (SELECT count(*) FROM canonical_approved_work_visit_authority_activations)::integer AS approved_work_activations`
  );
  return result.rows[0];
}

test(
  "migration 58 adds immutable Visit Start evidence without backfill",
  { skip: !databaseUrl },
  async () => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300003_add_professional_subscription_plan.sql");
      const migrationIndex = migrations.findIndex(
        ({ filename }) => filename === migration58Name
      );
      assert.equal(migrationIndex, 57);
      const baseline = await runMigrationCollection(
        pool,
        migrations.slice(0, migrationIndex),
        targetMetadata()
      );
      assert.equal(baseline.success, true, baseline.errorCode);
      assert.equal(baseline.applied.length, 57);

      const ledger57 = await pool.query(
        "SELECT count(*)::integer AS count FROM schema_migrations"
      );
      assert.equal(ledger57.rows[0].count, 57);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-job`
      );
      const historical = await createScheduledVisit(
        pool,
        identities,
        fixture,
        `${suffix}-historical`
      );
      const historicalCompleted = await completeVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        visitId: historical.id,
        expectedVersion: historical.currentVersion,
        idempotencyKey: `visit-start-complete-${suffix}-historical`,
        clock: () => new Date("2026-08-28T13:00:00.000Z"),
        logger: quiet,
      });
      assert.equal(historicalCompleted.ok, true, historicalCompleted.code);
      assert.equal(historicalCompleted.visit.state, "COMPLETED");

      const countsBefore = await businessCounts(pool);
      const historicalBefore = await pool.query(
        `SELECT visit_id, version, job_id, state, scheduled_start_at,
           scheduled_end_at, time_zone, location_mode, cancellation_reason,
           cancelled_at, completed_at, recorded_by_participant_id,
           command_idempotency_id, integrity_hash, created_at
         FROM canonical_visit_versions
         WHERE visit_id = $1
         ORDER BY version`,
        [historical.id]
      );

      const migration58 = migrations[migrationIndex];
      const upgraded = await runMigrationCollection(
        pool,
        [migration58],
        targetMetadata()
      );
      assert.equal(upgraded.success, true, upgraded.errorCode);
      assert.deepEqual(upgraded.applied, [migration58Name]);

      const ledger58 = await pool.query(
        `SELECT count(*)::integer AS count,
           max(checksum) FILTER (WHERE filename = $1) AS checksum
         FROM schema_migrations`,
        [migration58Name]
      );
      assert.deepEqual(ledger58.rows[0], {
        count: 58,
        checksum: migration58.checksum,
      });
      assert.deepEqual(await businessCounts(pool), countsBefore);
      const historicalAfter = await pool.query(
        `SELECT visit_id, version, job_id, state, scheduled_start_at,
           scheduled_end_at, time_zone, location_mode, cancellation_reason,
           cancelled_at, completed_at, recorded_by_participant_id,
           command_idempotency_id, integrity_hash, created_at
         FROM canonical_visit_versions
         WHERE visit_id = $1
         ORDER BY version`,
        [historical.id]
      );
      assert.deepEqual(historicalAfter.rows, historicalBefore.rows);
      const fabricatedStarts = await pool.query(
        `SELECT count(*)::integer AS count
         FROM canonical_visit_versions
         WHERE started_at IS NOT NULL`
      );
      assert.equal(fabricatedStarts.rows[0].count, 0);
      const legacyCompleted = await pool.query(
        `SELECT state, started_at, completed_at
         FROM canonical_visit_versions
         WHERE visit_id = $1
         ORDER BY version DESC LIMIT 1`,
        [historical.id]
      );
      assert.equal(legacyCompleted.rows[0].state, "COMPLETED");
      assert.equal(legacyCompleted.rows[0].started_at, null);
      assert.ok(legacyCompleted.rows[0].completed_at);

      console.log("VISIT_START_NO_BACKFILL", JSON.stringify({
        ledgerBefore: 57,
        ledgerAfter: ledger58.rows[0].count,
        before: countsBefore,
        after: await businessCounts(pool),
        fabricatedStartedAt: fabricatedStarts.rows[0].count,
        historicalScheduledToCompletedPreserved: true,
      }));

      const commandVocabulary = await insertCommand(
        pool,
        fixture,
        "visit.start",
        `${suffix}-command-vocabulary`
      );
      assert.ok(commandVocabulary);
      await expectCheckViolation(pool, (client) =>
        insertCommand(client, fixture, "visit.unknown", `${suffix}-unknown-command`)
      );

      const classifications = [
        ["WITHIN_EARLY_WINDOW", false],
        ["SAME_DATE_ON_OR_AFTER_SCHEDULE", false],
        ["EARLY_OUTSIDE_WINDOW", true],
        ["DIFFERENT_LOCAL_DATE", true],
      ];
      const startedFixtures = [];
      for (const [classification, acknowledged] of classifications) {
        const scheduled = await createScheduledVisit(
          pool,
          identities,
          fixture,
          `${suffix}-${classification}`
        );
        const source = await loadVersion(
          pool,
          scheduled.id,
          scheduled.currentVersion
        );
        const started = await insertStartedTransition(pool, {
          source,
          fixture,
          suffix: `${suffix}-${classification}-start`,
          classification,
          acknowledged,
        });
        const persisted = await loadVersion(pool, source.visit_id, started.version);
        assert.equal(persisted.state, "STARTED");
        assert.equal(
          new Date(persisted.started_at).toISOString(),
          started.startedAt
        );
        assert.equal(
          new Date(persisted.scheduled_start_at).toISOString(),
          new Date(source.scheduled_start_at).toISOString()
        );
        startedFixtures.push({ source, started });
      }

      for (const [classification, acknowledged] of [
        ["EARLY_OUTSIDE_WINDOW", false],
        ["DIFFERENT_LOCAL_DATE", false],
        ["WITHIN_EARLY_WINDOW", true],
        ["SAME_DATE_ON_OR_AFTER_SCHEDULE", true],
        [null, false],
        ["WITHIN_EARLY_WINDOW", null],
      ]) {
        const scheduled = await createScheduledVisit(
          pool,
          identities,
          fixture,
          `${suffix}-invalid-${classification}-${acknowledged}`
        );
        const source = await loadVersion(pool, scheduled.id, scheduled.currentVersion);
        await expectCheckViolation(pool, (client) =>
          insertStartedTransition(client, {
            source,
            fixture,
            suffix: `${suffix}-invalid-${classification}-${acknowledged}-start`,
            classification,
            acknowledged,
          })
        );
      }

      const invalidStateVisit = await createScheduledVisit(
        pool,
        identities,
        fixture,
        `${suffix}-invalid-state`
      );
      const invalidStateSource = await loadVersion(
        pool,
        invalidStateVisit.id,
        invalidStateVisit.currentVersion
      );
      await expectCheckViolation(pool, async (client) => {
        const commandId = await insertCommand(
          client,
          fixture,
          "visit.start",
          `${suffix}-invalid-state-command`
        );
        await insertVersion(client, {
          source: invalidStateSource,
          fixture,
          commandId,
          version: 3,
          state: "IN_PROGRESS",
          startedAt: "2026-08-27T13:00:00.000Z",
        });
      });

      for (const [state, startedAt] of [
        ["STARTED", null],
        ["PROPOSED", "2026-08-27T12:55:00.000Z"],
        ["SCHEDULED", "2026-08-27T12:55:00.000Z"],
      ]) {
        const scheduled = await createScheduledVisit(
          pool,
          identities,
          fixture,
          `${suffix}-invalid-started-at-${state}`
        );
        const source = await loadVersion(pool, scheduled.id, scheduled.currentVersion);
        await expectCheckViolation(pool, async (client) => {
          const commandId = await insertCommand(
            client,
            fixture,
            "visit.start",
            `${suffix}-invalid-started-at-${state}-command`
          );
          await insertVersion(client, {
            source,
            fixture,
            commandId,
            version: 3,
            state,
            startedAt,
          });
        });
      }

      const completedFixture = startedFixtures[0];
      const completedSource = await loadVersion(
        pool,
        completedFixture.source.visit_id,
        completedFixture.started.version
      );
      const completeCommandId = await insertCommand(
        pool,
        fixture,
        "visit.complete",
        `${suffix}-post-start-complete`
      );
      await insertVersion(pool, {
        source: completedSource,
        fixture,
        commandId: completeCommandId,
        version: 4,
        state: "COMPLETED",
        startedAt: completedSource.started_at,
        completedAt: "2026-08-27T14:00:00.000Z",
      });
      await insertEvent(pool, {
        source: completedSource,
        fixture,
        commandId: completeCommandId,
        visitVersion: 4,
        previousVisitVersion: 3,
        eventType: "VISIT_COMPLETED",
        visitState: "COMPLETED",
      });

      const invalidCompletedFixture = startedFixtures[1];
      const invalidCompletedSource = await loadVersion(
        pool,
        invalidCompletedFixture.source.visit_id,
        invalidCompletedFixture.started.version
      );
      await expectCheckViolation(pool, async (client) => {
        const commandId = await insertCommand(
          client,
          fixture,
          "visit.complete",
          `${suffix}-invalid-completed-time`
        );
        await insertVersion(client, {
          source: invalidCompletedSource,
          fixture,
          commandId,
          version: 4,
          state: "COMPLETED",
          startedAt: "2026-08-27T14:05:00.000Z",
          completedAt: "2026-08-27T14:00:00.000Z",
        });
      });

      const cancelledFixture = startedFixtures[2];
      const cancelledSource = await loadVersion(
        pool,
        cancelledFixture.source.visit_id,
        cancelledFixture.started.version
      );
      const cancelCommandId = await insertCommand(
        pool,
        fixture,
        "visit.cancel",
        `${suffix}-post-start-cancel`
      );
      await insertVersion(pool, {
        source: cancelledSource,
        fixture,
        commandId: cancelCommandId,
        version: 4,
        state: "CANCELLED",
        startedAt: cancelledSource.started_at,
        cancelledAt: "2026-08-27T13:30:00.000Z",
        cancellationReason: "The in-progress Visit was stopped.",
      });

      const invalidCancelledFixture = startedFixtures[3];
      const invalidCancelledSource = await loadVersion(
        pool,
        invalidCancelledFixture.source.visit_id,
        invalidCancelledFixture.started.version
      );
      await expectCheckViolation(pool, async (client) => {
        const commandId = await insertCommand(
          client,
          fixture,
          "visit.cancel",
          `${suffix}-invalid-cancelled-time`
        );
        await insertVersion(client, {
          source: invalidCancelledSource,
          fixture,
          commandId,
          version: 4,
          state: "CANCELLED",
          startedAt: "2026-08-27T14:05:00.000Z",
          cancelledAt: "2026-08-27T14:00:00.000Z",
          cancellationReason: "Invalid ordering fixture.",
        });
      });

      const invalidLineageVisit = await createScheduledVisit(
        pool,
        identities,
        fixture,
        `${suffix}-invalid-lineage`
      );
      const invalidLineageSource = await loadVersion(
        pool,
        invalidLineageVisit.id,
        invalidLineageVisit.currentVersion
      );
      await expectCheckViolation(pool, (client) =>
        insertStartedTransition(client, {
          source: invalidLineageSource,
          fixture,
          suffix: `${suffix}-invalid-lineage-start`,
          previousVisitVersion: 1,
        })
      );

      const nonStartVisit = await createScheduledVisit(
        pool,
        identities,
        fixture,
        `${suffix}-non-start-evidence`
      );
      const nonStartSource = await loadVersion(
        pool,
        nonStartVisit.id,
        nonStartVisit.currentVersion
      );
      for (const [classification, acknowledged] of [
        ["WITHIN_EARLY_WINDOW", null],
        [null, false],
      ]) {
        await expectCheckViolation(pool, async (client) => {
          const commandId = await insertCommand(
            client,
            fixture,
            "visit.change_request",
            `${suffix}-non-start-${classification}-${acknowledged}`
          );
          await insertEvent(client, {
            source: nonStartSource,
            fixture,
            commandId,
            visitVersion: 2,
            previousVisitVersion: 2,
            eventType: "VISIT_CHANGE_REQUESTED",
            visitState: "SCHEDULED",
            classification,
            acknowledged,
            reason: "Customer coordination evidence.",
          });
        });
      }

      await expectCheckViolation(pool, async (client) => {
        const commandId = await insertCommand(
          client,
          fixture,
          "visit.start",
          `${suffix}-unknown-event-command`
        );
        await insertEvent(client, {
          source: completedSource,
          fixture,
          commandId,
          visitVersion: 3,
          previousVisitVersion: 2,
          eventType: "VISIT_UNKNOWN",
          visitState: "STARTED",
          classification: "WITHIN_EARLY_WINDOW",
          acknowledged: false,
        });
      });

      const replay = await runMigrationCollection(
        pool,
        [migration58],
        targetMetadata()
      );
      assert.equal(replay.success, true, replay.errorCode);
      assert.deepEqual(replay.applied, []);
      assert.deepEqual(replay.skipped, [migration58Name]);

      const drift = await runMigrationCollection(
        pool,
        [{ ...migration58, checksum: "0".repeat(64) }],
        targetMetadata()
      );
      assert.equal(drift.success, false);
      assert.equal(drift.errorCode, "MIGRATION_CHECKSUM_MISMATCH");
      assert.deepEqual(drift.failed, [migration58Name]);

      const finalLedger = await pool.query(
        "SELECT count(*)::integer AS count FROM schema_migrations"
      );
      assert.equal(finalLedger.rows[0].count, 58);
      console.log("VISIT_START_REPLAY", JSON.stringify({
        applied: replay.applied,
        skipped: replay.skipped,
        ledger: finalLedger.rows[0].count,
        checksumDrift: drift.errorCode,
      }));
    } finally {
      await pool.end();
    }
  }
);
