"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  cancelVisit,
  completeVisit,
  confirmVisit,
  proposeVisit,
  startVisit,
} = require("../server/workflow/visitService");
const {
  completeEvaluation,
  createOrdinaryJobEvaluation,
} = require("../server/authorization/evaluationService");

const databaseUrl = process.env.VISIT_START_RUNTIME_DATABASE_URL;

async function scheduledVisit(pool, identities, fixture, suffix) {
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
    idempotencyKey: `propose-${suffix}`,
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
    idempotencyKey: `confirm-${suffix}`,
    clock: () => new Date("2026-08-26T12:05:00.000Z"),
    logger: quiet,
  });
  assert.equal(confirmed.ok, true, confirmed.code);
  return confirmed.visit;
}

async function newJob(pool, identities, suffix) {
  return createVisitLifecycleFixture(pool, identities, suffix);
}

test(
  "Visit Start runtime persists exact start evidence, replay, completion, cancellation, and authority",
  { skip: !databaseUrl },
  async () => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const identities = await createVisitTestIdentities(pool, suffix);
      const normalJob = await newJob(pool, identities, `${suffix}-normal`);
      const scheduled = await scheduledVisit(pool, identities, normalJob, `${suffix}-normal`);

      const proposedStart = await startVisit({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: normalJob.jobId,
        visitId: scheduled.id,
        expectedVersion: scheduled.currentVersion,
        idempotencyKey: `customer-start-${suffix}`,
        clock: () => new Date("2026-08-27T12:30:00.000Z"),
        logger: quiet,
      });
      assert.equal(proposedStart.code, "VISIT_AUTHORITY_REQUIRED");

      const startKey = `start-${suffix}`;
      const started = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: normalJob.jobId,
        visitId: scheduled.id,
        expectedVersion: scheduled.currentVersion,
        idempotencyKey: startKey,
        clock: () => new Date("2026-08-27T12:30:00.000Z"),
        logger: quiet,
      });
      assert.equal(started.ok, true, started.code);
      assert.equal(started.visit.state, "STARTED");
      assert.equal(started.visit.currentVersion, scheduled.currentVersion + 1);
      assert.equal(started.visit.startedAt, "2026-08-27T12:30:00.000Z");
      assert.equal(started.visit.scheduledStartAt, scheduled.scheduledStartAt);
      assert.equal(started.visit.actions.canStart, false);
      assert.equal(started.visit.actions.canComplete, true);

      const evaluation = await createOrdinaryJobEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: normalJob.jobId,
        visitId: started.visit.id,
        content: {
          serviceType: "handyman",
          evaluationContext: "ordinary_job",
          observations: "Onsite condition documented while the Visit is active.",
          measurements: [],
          findings: [],
          diagnosisSummary: "Repair is recommended.",
          limitations: "",
          scopeRecommendations: [],
          relevantConditions: [],
          supportingMediaReferences: [],
          internalNotes: "",
        },
        idempotencyKey: `evaluation-${suffix}`,
        logger: quiet,
      });
      assert.equal(evaluation.ok, true, evaluation.code);
      assert.equal(evaluation.evaluation.status, "draft");
      const prematureFinalization = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: evaluation.evaluation.id,
        expectedVersion: evaluation.aggregate.version,
        idempotencyKey: `premature-evaluation-complete-${suffix}`,
        logger: quiet,
      });
      assert.equal(
        prematureFinalization.code,
        "COMPLETED_EVALUATION_VISIT_REQUIRED"
      );

      const replay = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: normalJob.jobId,
        visitId: scheduled.id,
        expectedVersion: scheduled.currentVersion,
        idempotencyKey: startKey,
        clock: () => new Date("2026-08-27T12:40:00.000Z"),
        logger: quiet,
      });
      assert.equal(replay.ok, true, replay.code);
      assert.equal(replay.visit.startedAt, started.visit.startedAt);

      const changedReplay = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: normalJob.jobId,
        visitId: scheduled.id,
        expectedVersion: scheduled.currentVersion,
        acknowledgeScheduleVariance: true,
        idempotencyKey: startKey,
        clock: () => new Date("2026-08-27T12:40:00.000Z"),
        logger: quiet,
      });
      assert.equal(changedReplay.code, "VISIT_IDEMPOTENCY_KEY_CONFLICT");

      const secondStart = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: normalJob.jobId,
        visitId: scheduled.id,
        expectedVersion: started.visit.currentVersion,
        idempotencyKey: `second-start-${suffix}`,
        clock: () => new Date("2026-08-27T12:40:00.000Z"),
        logger: quiet,
      });
      assert.equal(secondStart.code, "INVALID_VISIT_TRANSITION");

      const completed = await completeVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: normalJob.jobId,
        visitId: started.visit.id,
        expectedVersion: started.visit.currentVersion,
        idempotencyKey: `complete-${suffix}`,
        clock: () => new Date("2026-08-27T14:00:00.000Z"),
        logger: quiet,
      });
      assert.equal(completed.ok, true, completed.code);
      assert.equal(completed.visit.state, "COMPLETED");
      assert.equal(completed.visit.startedAt, started.visit.startedAt);
      const linked = await pool.query(
        `SELECT evaluation_id FROM canonical_visit_evaluation_links
         WHERE visit_id = $1 AND job_id = $2`,
        [completed.visit.id, normalJob.jobId]
      );
      assert.equal(linked.rows[0]?.evaluation_id, evaluation.evaluation.id);

      const earlyJob = await newJob(pool, identities, `${suffix}-early`);
      const earlyScheduled = await scheduledVisit(pool, identities, earlyJob, `${suffix}-early`);
      const earlyBlocked = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: earlyJob.jobId,
        visitId: earlyScheduled.id,
        expectedVersion: earlyScheduled.currentVersion,
        idempotencyKey: `early-blocked-${suffix}`,
        clock: () => new Date("2026-08-27T12:29:59.000Z"),
        logger: quiet,
      });
      assert.equal(earlyBlocked.code, "VISIT_START_ACKNOWLEDGMENT_REQUIRED");
      const earlyStarted = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: earlyJob.jobId,
        visitId: earlyScheduled.id,
        expectedVersion: earlyScheduled.currentVersion,
        acknowledgeScheduleVariance: true,
        idempotencyKey: `early-start-${suffix}`,
        clock: () => new Date("2026-08-27T12:29:59.000Z"),
        logger: quiet,
      });
      assert.equal(earlyStarted.ok, true, earlyStarted.code);

      const cancelWithoutReason = await cancelVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: earlyJob.jobId,
        visitId: earlyStarted.visit.id,
        expectedVersion: earlyStarted.visit.currentVersion,
        idempotencyKey: `cancel-empty-${suffix}`,
        clock: () => new Date("2026-08-27T12:35:00.000Z"),
        logger: quiet,
      });
      assert.equal(cancelWithoutReason.code, "VISIT_CANCELLATION_REASON_REQUIRED");
      const cancelled = await cancelVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: earlyJob.jobId,
        visitId: earlyStarted.visit.id,
        expectedVersion: earlyStarted.visit.currentVersion,
        reason: "The in-progress Visit was stopped safely.",
        idempotencyKey: `cancel-${suffix}`,
        clock: () => new Date("2026-08-27T12:35:00.000Z"),
        logger: quiet,
      });
      assert.equal(cancelled.ok, true, cancelled.code);
      assert.equal(cancelled.visit.state, "CANCELLED");
      assert.equal(cancelled.visit.startedAt, earlyStarted.visit.startedAt);

      const differentDateJob = await newJob(pool, identities, `${suffix}-different-date`);
      const differentDateScheduled = await scheduledVisit(
        pool,
        identities,
        differentDateJob,
        `${suffix}-different-date`
      );
      const differentDateBlocked = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: differentDateJob.jobId,
        visitId: differentDateScheduled.id,
        expectedVersion: differentDateScheduled.currentVersion,
        idempotencyKey: `different-date-blocked-${suffix}`,
        clock: () => new Date("2026-08-28T13:00:00.000Z"),
        logger: quiet,
      });
      assert.equal(
        differentDateBlocked.code,
        "VISIT_START_ACKNOWLEDGMENT_REQUIRED"
      );
      const differentDateStarted = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: differentDateJob.jobId,
        visitId: differentDateScheduled.id,
        expectedVersion: differentDateScheduled.currentVersion,
        acknowledgeScheduleVariance: true,
        idempotencyKey: `different-date-start-${suffix}`,
        clock: () => new Date("2026-08-28T13:00:00.000Z"),
        logger: quiet,
      });
      assert.equal(differentDateStarted.ok, true, differentDateStarted.code);

      const evidence = await pool.query(
        `SELECT event_type, start_timing_classification,
           schedule_variance_acknowledged
         FROM canonical_visit_events
         WHERE visit_id = ANY($1::uuid[])
         ORDER BY created_at, visit_version`,
        [[started.visit.id, earlyStarted.visit.id, differentDateStarted.visit.id]]
      );
      assert.equal(evidence.rows.filter((row) => row.event_type === "VISIT_STARTED").length, 3);
      assert.equal(evidence.rows.some((row) => row.event_type === "VISIT_RESCHEDULED"), false);
      assert.deepEqual(
        evidence.rows
          .filter((row) => row.event_type === "VISIT_STARTED")
          .map((row) => [row.start_timing_classification, row.schedule_variance_acknowledged]),
        [
          ["WITHIN_EARLY_WINDOW", false],
          ["EARLY_OUTSIDE_WINDOW", true],
          ["DIFFERENT_LOCAL_DATE", true],
        ]
      );
    } finally {
      await pool.end();
    }
  }
);
