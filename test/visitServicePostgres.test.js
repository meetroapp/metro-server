"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitApprovedDecision,
  createVisitEvaluation,
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  createVisitWorkstream,
  grantVisitCapabilities,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  cancelVisit,
  completeVisit,
  confirmVisit,
  getVisit,
  listVisits,
  proposeVisit,
  requestVisitChange,
  rescheduleVisit,
} = require("../server/workflow/visitService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.VISIT_SERVICE_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

function command(service, pool, actorId, values, idempotencyKey, extra = {}) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey,
    logger: quiet,
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
    ...values,
    ...extra,
  });
}

function proposal(fixture, values = {}) {
  return {
    jobId: fixture.jobId,
    purpose: "FOLLOW_UP",
    scheduledStartAt: "2026-08-20T13:00:00.000Z",
    scheduledEndAt: "2026-08-20T14:00:00.000Z",
    timeZone: "America/New_York",
    locationMode: "JOB_SERVICE_LOCATION",
    ...values,
  };
}

async function counts(pool, fixture) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM canonical_visits WHERE job_id = $1)::integer AS visits,
       (SELECT count(*) FROM canonical_visit_versions WHERE job_id = $1)::integer AS versions,
       (SELECT count(*) FROM canonical_visit_events WHERE job_id = $1)::integer AS events,
       (SELECT count(*) FROM canonical_visit_command_idempotency
         WHERE job_id = $1)::integer AS commands`,
    [fixture.jobId]
  );
  return result.rows[0];
}

test(
  "disposable PostgreSQL certifies canonical Visit read and command authority",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 43);
      const migrated = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata()
      );
      assert.equal(migrated.success, true);
      assert.equal(migrated.applied.length, 43);

      const identities = await createVisitTestIdentities(pool, suffix);
      const firstJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-a`
      );
      const secondJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-b`
      );
      const firstEvaluation = await createVisitEvaluation(
        pool,
        identities,
        firstJob,
        `${suffix}-a`
      );
      const secondEvaluation = await createVisitEvaluation(
        pool,
        identities,
        secondJob,
        `${suffix}-b`
      );
      const firstWorkstream = await createVisitWorkstream(
        pool,
        identities,
        firstJob,
        `${suffix}-a`,
        1
      );
      const secondWorkstream = await createVisitWorkstream(
        pool,
        identities,
        firstJob,
        `${suffix}-a`,
        2
      );
      const crossWorkstream = await createVisitWorkstream(
        pool,
        identities,
        secondJob,
        `${suffix}-b`,
        1
      );
      const firstDecision = await createVisitApprovedDecision(
        pool,
        identities,
        firstJob,
        `${suffix}-a`
      );
      const secondDecision = await createVisitApprovedDecision(
        pool,
        identities,
        secondJob,
        `${suffix}-b`
      );

      const automaticGrants = await pool.query(
        `SELECT count(*)::integer AS count
         FROM lifecycle_authority_grants
         WHERE job_id = $1 AND capability LIKE 'visit.%'`,
        [firstJob.jobId]
      );
      assert.equal(automaticGrants.rows[0].count, 0);
      const deniedBeforeGrant = await listVisits({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: firstJob.jobId,
        logger: quiet,
      });
      assert.equal(deniedBeforeGrant.code, "VISIT_AUTHORITY_REQUIRED");

      await grantVisitCapabilities(pool, firstJob, {
        professional: [
          "visit.read",
          "visit.propose",
          "visit.reschedule",
          "visit.cancel",
          "visit.complete",
          "visit.confirm",
        ],
        customer: [
          "visit.read",
          "visit.confirm",
          "visit.change_request",
          "visit.cancel",
        ],
      });

      const adjacentBefore = await pool.query(
        `SELECT
          (SELECT status FROM canonical_evaluation_versions
            WHERE evaluation_id = $1 ORDER BY version DESC LIMIT 1)
            AS evaluation_state,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $2 ORDER BY version DESC LIMIT 1)
            AS workstream_state,
          (SELECT decision FROM canonical_quote_customer_decisions
            WHERE id = $3) AS quote_decision`,
        [firstEvaluation.id, firstWorkstream.id, firstDecision.id]
      );

      for (const crossSubject of [
        { purpose: "EVALUATION", evaluationId: secondEvaluation.id },
        { purpose: "FOLLOW_UP", workstreamIds: [crossWorkstream.id] },
      ]) {
        const rejected = await command(
          proposeVisit,
          pool,
          identities.professionalId,
          proposal(firstJob, crossSubject),
          randomUUID()
        );
        assert.equal(rejected.code, "VISIT_SUBJECT_SCOPE_MISMATCH");
      }
      const rejectedApprovedWork = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          purpose: "APPROVED_WORK",
          approvedQuoteDecisionId: secondDecision.id,
        }),
        randomUUID()
      );
      assert.equal(rejectedApprovedWork.code, "VISIT_AUTHORITY_REQUIRED");
      assert.deepEqual(await counts(pool, firstJob), {
        visits: 0,
        versions: 0,
        events: 0,
        commands: 0,
      });

      const proposalKey = randomUUID();
      const proposed = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          purpose: "EVALUATION",
          evaluationId: firstEvaluation.id,
          workstreamIds: [firstWorkstream.id, secondWorkstream.id],
        }),
        proposalKey
      );
      assert.equal(proposed.code, "VISIT_PROPOSED");
      assert.equal(proposed.visit.state, "PROPOSED");
      assert.equal(proposed.visit.currentVersion, 1);
      assert.deepEqual(proposed.visit.workstreamIds.sort(), [
        firstWorkstream.id,
        secondWorkstream.id,
      ].sort());
      assert.equal(proposed.visit.actions.canConfirm, false);
      assert.equal(proposed.visit.actions.canCancel, true);

      const replayedProposal = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          purpose: "EVALUATION",
          evaluationId: firstEvaluation.id,
          workstreamIds: [secondWorkstream.id, firstWorkstream.id],
        }),
        proposalKey
      );
      assert.equal(replayedProposal.replayed, true);
      assert.equal(replayedProposal.visit.id, proposed.visit.id);
      const conflictingProposal = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          purpose: "EVALUATION",
          evaluationId: firstEvaluation.id,
          workstreamIds: [firstWorkstream.id, secondWorkstream.id],
          scheduledEndAt: "2026-08-20T15:00:00.000Z",
        }),
        proposalKey
      );
      assert.equal(conflictingProposal.code, "VISIT_IDEMPOTENCY_KEY_CONFLICT");

      const customerList = await listVisits({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: firstJob.jobId,
        logger: quiet,
        clock: () => new Date("2026-08-13T12:00:00.000Z"),
      });
      assert.equal(customerList.code, "VISITS_FOUND");
      assert.equal(customerList.actions.canPropose, false);
      assert.equal(customerList.visits[0].actions.canConfirm, true);
      assert.equal(customerList.visits[0].actions.canRequestChange, true);

      const professionalCannotConfirm = await command(
        confirmVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 1,
        },
        randomUUID()
      );
      assert.equal(professionalCannotConfirm.code, "VISIT_AUTHORITY_REQUIRED");

      const confirmedKey = randomUUID();
      const confirmed = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 1,
        },
        confirmedKey
      );
      assert.equal(confirmed.visit.state, "SCHEDULED");
      assert.equal(confirmed.visit.currentVersion, 2);
      const replayedConfirmation = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 1,
        },
        confirmedKey
      );
      assert.equal(replayedConfirmation.replayed, true);
      assert.equal(replayedConfirmation.visit.currentVersion, 2);

      const changeRequested = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          reason: "Please move the confirmed Visit to the afternoon.",
        },
        randomUUID()
      );
      assert.equal(changeRequested.code, "VISIT_CHANGE_REQUESTED");
      assert.equal(changeRequested.visit.currentVersion, 2);
      assert.equal(changeRequested.visit.scheduledStartAt, confirmed.visit.scheduledStartAt);
      assert.equal(changeRequested.event.visitVersion, 2);
      assert.equal(changeRequested.event.previousVisitVersion, 2);

      const rescheduleKey = randomUUID();
      const rescheduled = await command(
        rescheduleVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          scheduledStartAt: "2026-08-21T17:00:00.000Z",
          scheduledEndAt: "2026-08-21T18:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "REMOTE",
          reason: "Accepted the requested afternoon window.",
        },
        rescheduleKey
      );
      assert.equal(rescheduled.visit.currentVersion, 3);
      assert.equal(rescheduled.visit.state, "SCHEDULED");
      assert.equal(rescheduled.visit.locationMode, "REMOTE");
      const replayedReschedule = await command(
        rescheduleVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          scheduledStartAt: "2026-08-21T17:00:00.000Z",
          scheduledEndAt: "2026-08-21T18:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "REMOTE",
          reason: "Accepted the requested afternoon window.",
        },
        rescheduleKey
      );
      assert.equal(replayedReschedule.replayed, true);
      assert.equal(replayedReschedule.visit.currentVersion, 3);
      const unchangedReschedule = await command(
        rescheduleVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 3,
          scheduledStartAt: "2026-08-21T17:00:00.000Z",
          scheduledEndAt: "2026-08-21T18:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "REMOTE",
        },
        randomUUID()
      );
      assert.equal(unchangedReschedule.code, "VISIT_SCHEDULE_UNCHANGED");
      const stale = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          reason: "This request is based on stale timing.",
        },
        randomUUID()
      );
      assert.equal(stale.code, "STALE_VISIT_VERSION");

      const completed = await command(
        completeVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 3,
        },
        randomUUID(),
        { clock: () => new Date("2026-08-22T12:00:00.000Z") }
      );
      assert.equal(completed.visit.state, "COMPLETED");
      assert.equal(completed.visit.currentVersion, 4);
      assert.equal(completed.visit.actions.canComplete, false);

      const detail = await getVisit({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: firstJob.jobId,
        visitId: proposed.visit.id,
        logger: quiet,
      });
      assert.equal(detail.visit.history.versions.length, 4);
      assert.deepEqual(
        detail.visit.history.events.map((event) => event.type),
        [
          "VISIT_PROPOSED",
          "VISIT_CONFIRMED",
          "VISIT_CHANGE_REQUESTED",
          "VISIT_RESCHEDULED",
          "VISIT_COMPLETED",
        ]
      );
      assert.equal(JSON.stringify(detail).includes("requestFingerprint"), false);
      assert.equal(JSON.stringify(detail).includes("integrityHash"), false);
      assert.equal(JSON.stringify(detail).includes("commandIdempotencyId"), false);

      const cancellable = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          scheduledStartAt: "2026-08-23T13:00:00.000Z",
          scheduledEndAt: "2026-08-23T14:00:00.000Z",
        }),
        randomUUID()
      );
      const customerCannotCancel = await command(
        cancelVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: cancellable.visit.id,
          expectedVersion: 1,
          reason: "Customer direct cancellation is not authorized.",
        },
        randomUUID()
      );
      assert.equal(customerCannotCancel.code, "VISIT_AUTHORITY_REQUIRED");
      const cancelled = await command(
        cancelVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: cancellable.visit.id,
          expectedVersion: 1,
          reason: "Professional cancelled the proposed Visit.",
        },
        randomUUID(),
        { clock: () => new Date("2026-08-13T12:00:00.000Z") }
      );
      assert.equal(cancelled.visit.state, "CANCELLED");
      assert.equal(cancelled.visit.currentVersion, 2);

      const future = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          scheduledStartAt: "2026-08-30T13:00:00.000Z",
          scheduledEndAt: "2026-08-30T14:00:00.000Z",
        }),
        randomUUID()
      );
      const futureConfirmed = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: future.visit.id,
          expectedVersion: 1,
        },
        randomUUID()
      );
      const prematureCompletion = await command(
        completeVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: future.visit.id,
          expectedVersion: futureConfirmed.visit.currentVersion,
        },
        randomUUID(),
        { clock: () => new Date("2026-08-13T12:00:00.000Z") }
      );
      assert.equal(prematureCompletion.code, "VISIT_HAS_NOT_STARTED");

      const concurrent = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          scheduledStartAt: "2026-08-24T13:00:00.000Z",
          scheduledEndAt: "2026-08-24T14:00:00.000Z",
        }),
        randomUUID()
      );
      const concurrentConfirmed = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: concurrent.visit.id,
          expectedVersion: 1,
        },
        randomUUID()
      );
      assert.equal(concurrentConfirmed.visit.currentVersion, 2);
      const concurrencyResults = await Promise.all([
        command(
          rescheduleVisit,
          pool,
          identities.professionalId,
          {
            jobId: firstJob.jobId,
            visitId: concurrent.visit.id,
            expectedVersion: 2,
            scheduledStartAt: "2026-08-25T13:00:00.000Z",
            scheduledEndAt: "2026-08-25T14:00:00.000Z",
            timeZone: "America/New_York",
            locationMode: "REMOTE",
          },
          randomUUID()
        ),
        command(
          rescheduleVisit,
          pool,
          identities.professionalId,
          {
            jobId: firstJob.jobId,
            visitId: concurrent.visit.id,
            expectedVersion: 2,
            scheduledStartAt: "2026-08-26T13:00:00.000Z",
            scheduledEndAt: "2026-08-26T14:00:00.000Z",
            timeZone: "America/New_York",
            locationMode: "REMOTE",
          },
          randomUUID()
        ),
      ]);
      assert.deepEqual(
        concurrencyResults.map((result) => result.code).sort(),
        ["STALE_VISIT_VERSION", "VISIT_RESCHEDULED"]
      );
      const concurrentDetail = await getVisit({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: firstJob.jobId,
        visitId: concurrent.visit.id,
        logger: quiet,
      });
      assert.equal(concurrentDetail.visit.currentVersion, 3);
      assert.equal(concurrentDetail.visit.history.versions.length, 3);

      const approvedWork = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(firstJob, {
          purpose: "APPROVED_WORK",
          approvedQuoteDecisionId: firstDecision.id,
        }),
        randomUUID()
      );
      assert.equal(approvedWork.code, "VISIT_AUTHORITY_REQUIRED");

      const beforeRollback = await counts(pool, firstJob);
      const rollbackKey = randomUUID();
      await assert.rejects(
        command(
          proposeVisit,
          pool,
          identities.professionalId,
          proposal(firstJob),
          rollbackKey,
          {
            failureInjector(stage) {
              if (stage === "after_write") throw new Error("injected rollback");
            },
          }
        ),
        /injected rollback/
      );
      assert.deepEqual(await counts(pool, firstJob), beforeRollback);
      const rolledBackCommand = await pool.query(
        `SELECT id FROM canonical_visit_command_idempotency
         WHERE job_id = $1 AND idempotency_key = $2`,
        [firstJob.jobId, rollbackKey]
      );
      assert.equal(rolledBackCommand.rows.length, 0);

      const outsiderRead = await listVisits({
        pool,
        authenticatedActor: { id: identities.outsiderId },
        jobId: firstJob.jobId,
        logger: quiet,
      });
      assert.equal(outsiderRead.code, "VISIT_UNAVAILABLE");
      const ungrantedOtherJob = await listVisits({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: secondJob.jobId,
        logger: quiet,
      });
      assert.equal(ungrantedOtherJob.code, "VISIT_AUTHORITY_REQUIRED");

      const adjacentAfter = await pool.query(
        `SELECT
          (SELECT status FROM canonical_evaluation_versions
            WHERE evaluation_id = $1 ORDER BY version DESC LIMIT 1)
            AS evaluation_state,
          (SELECT state FROM canonical_workstream_versions
            WHERE workstream_id = $2 ORDER BY version DESC LIMIT 1)
            AS workstream_state,
          (SELECT decision FROM canonical_quote_customer_decisions
            WHERE id = $3) AS quote_decision`,
        [firstEvaluation.id, firstWorkstream.id, firstDecision.id]
      );
      assert.deepEqual(adjacentAfter.rows[0], adjacentBefore.rows[0]);
    } finally {
      await pool.end();
    }
  }
);
