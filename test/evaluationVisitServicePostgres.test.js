"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  completeEvaluation,
} = require("../server/authorization/evaluationService");
const {
  createVisitEvaluation,
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  activateEvaluationVisitAuthority,
  getEvaluationVisitAuthority,
} = require("../server/workflow/evaluationVisitService");
const {
  cancelVisit,
  completeVisit,
  confirmVisit,
  getEvaluationVisit,
  listEvaluationVisits,
  listVisits,
  proposeVisit,
  requestVisitChange,
  rescheduleVisit,
} = require("../server/workflow/visitService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.EVALUATION_VISIT_DATABASE_URL;
const upgradeDatabaseUrl = process.env.EVALUATION_VISIT_UPGRADE_DATABASE_URL;

function targetMetadata(url = databaseUrl) {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(url, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

function authorityCommand(pool, actorId, fixture, evaluation, key = randomUUID()) {
  return activateEvaluationVisitAuthority({
    pool,
    authenticatedActor: { id: actorId },
    jobId: fixture.jobId,
    evaluationId: evaluation.id,
    idempotencyKey: key,
    logger: quiet,
  });
}

function visitCommand(service, pool, actorId, values, key = randomUUID(), extra = {}) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey: key,
    logger: quiet,
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
    ...values,
    ...extra,
  });
}

function evaluationProposal(fixture, evaluation, startHour = 13) {
  return {
    jobId: fixture.jobId,
    purpose: "EVALUATION",
    evaluationId: evaluation.id,
    scheduledStartAt: `2026-08-20T${String(startHour).padStart(2, "0")}:00:00.000Z`,
    scheduledEndAt: `2026-08-20T${String(startHour + 1).padStart(2, "0")}:00:00.000Z`,
    timeZone: "America/New_York",
    locationMode: "JOB_SERVICE_LOCATION",
  };
}

async function adjacentTruth(pool, fixture, evaluation) {
  const result = await pool.query(
    `SELECT
       (SELECT status FROM canonical_evaluations WHERE id = $1) AS evaluation_status,
       (SELECT count(*)::integer FROM canonical_evaluation_findings
         WHERE evaluation_id = $1) AS findings,
       (SELECT count(*)::integer FROM canonical_recommendations
         WHERE evaluation_id = $1) AS recommendations,
       (SELECT count(*)::integer FROM canonical_quotes WHERE job_id = $2) AS quotes,
       (SELECT count(*)::integer FROM canonical_workstreams WHERE job_id = $2) AS workstreams,
       (SELECT count(*)::integer FROM canonical_work_activities WHERE job_id = $2) AS activities,
       (SELECT cancelled_at FROM posts WHERE id = $3) AS request_cancelled_at,
       (SELECT status FROM request_relationships
         WHERE id = jobs.source_request_relationship_id) AS relationship_status,
       jobs.lifecycle_contract_version
     FROM jobs
     WHERE jobs.id = $2`,
    [evaluation.id, fixture.jobId, fixture.requestId]
  );
  return result.rows[0];
}

test(
  "disposable PostgreSQL certifies governed Evaluation Visit activation and separation",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 41);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true);
      assert.equal(migrated.applied.length, 41);

      const identities = await createVisitTestIdentities(pool, suffix);
      const firstJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-evaluation-a`
      );
      const secondJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-evaluation-b`
      );
      const firstEvaluation = await createVisitEvaluation(
        pool,
        identities,
        firstJob,
        `${suffix}-evaluation-a`
      );
      const secondEvaluation = await createVisitEvaluation(
        pool,
        identities,
        secondJob,
        `${suffix}-evaluation-b`
      );

      const zeroBefore = await pool.query(
        `SELECT
           (SELECT count(*)::integer
            FROM canonical_evaluation_visit_authority_activations) AS activations,
           (SELECT count(*)::integer
            FROM lifecycle_authority_grants
            WHERE capability LIKE 'visit.%') AS visit_grants,
           (SELECT count(*)::integer FROM canonical_visits) AS visits`
      );
      assert.deepEqual(zeroBefore.rows[0], {
        activations: 0,
        visit_grants: 0,
        visits: 0,
      });

      const available = await getEvaluationVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: firstJob.jobId,
        evaluationId: firstEvaluation.id,
        logger: quiet,
      });
      assert.equal(available.code, "EVALUATION_VISIT_AUTHORITY_AVAILABLE");
      assert.equal(available.authority.state, "AVAILABLE");
      assert.equal(available.authority.actions.canActivate, true);

      const customerDenied = await authorityCommand(
        pool,
        identities.homeownerId,
        firstJob,
        firstEvaluation
      );
      assert.equal(customerDenied.code, "EVALUATION_VISIT_AUTHORITY_UNAVAILABLE");
      const outsiderDenied = await authorityCommand(
        pool,
        identities.outsiderId,
        firstJob,
        firstEvaluation
      );
      assert.equal(outsiderDenied.code, "EVALUATION_VISIT_AUTHORITY_UNAVAILABLE");
      const crossJobDenied = await authorityCommand(
        pool,
        identities.professionalId,
        firstJob,
        secondEvaluation
      );
      assert.equal(crossJobDenied.code, "EVALUATION_VISIT_AUTHORITY_UNAVAILABLE");

      const activationKey = randomUUID();
      const activated = await authorityCommand(
        pool,
        identities.professionalId,
        firstJob,
        firstEvaluation,
        activationKey
      );
      assert.equal(activated.status, 201);
      assert.equal(activated.code, "EVALUATION_VISIT_AUTHORITY_ACTIVATED");
      assert.equal(activated.authority.state, "ACTIVE");
      assert.deepEqual(activated.authority.customerCapabilities, [
        "visit.read",
        "visit.confirm",
        "visit.change_request",
      ]);
      assert.deepEqual(activated.authority.professionalCapabilities, [
        "visit.read",
        "visit.propose",
        "visit.reschedule",
        "visit.cancel",
        "visit.complete",
      ]);
      const replayed = await authorityCommand(
        pool,
        identities.professionalId,
        firstJob,
        firstEvaluation,
        activationKey
      );
      assert.equal(replayed.replayed, true);
      const conflictingActivation = await authorityCommand(
        pool,
        identities.professionalId,
        firstJob,
        firstEvaluation
      );
      assert.equal(
        conflictingActivation.code,
        "EVALUATION_VISIT_AUTHORITY_ALREADY_ACTIVE"
      );

      const grantTruth = await pool.query(
        `SELECT
           grants.grantee_participant_id,
           array_agg(grants.capability ORDER BY grants.capability) AS capabilities,
           bool_and(grants.scope_type = 'evaluation') AS evaluation_scoped,
           bool_and(grants.scope_job_id = $1) AS exact_job,
           bool_and(grants.scope_evaluation_id = $2) AS exact_evaluation,
           count(*)::integer AS count
         FROM lifecycle_authority_grants grants
         WHERE grants.capability LIKE 'visit.%'
         GROUP BY grants.grantee_participant_id
         ORDER BY grants.grantee_participant_id`,
        [firstJob.jobId, firstEvaluation.id]
      );
      assert.deepEqual(grantTruth.rows.map((row) => row.count).sort(), [3, 5]);
      assert.equal(grantTruth.rows.every((row) => row.evaluation_scoped), true);
      assert.equal(grantTruth.rows.every((row) => row.exact_job), true);
      assert.equal(grantTruth.rows.every((row) => row.exact_evaluation), true);

      const professionalEmpty = await listEvaluationVisits({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: firstJob.jobId,
        evaluationId: firstEvaluation.id,
        logger: quiet,
      });
      assert.equal(professionalEmpty.code, "EVALUATION_VISITS_FOUND");
      assert.equal(professionalEmpty.visits.length, 0);
      assert.equal(professionalEmpty.actions.canProposeEvaluationVisit, true);
      const customerEmpty = await listEvaluationVisits({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: firstJob.jobId,
        evaluationId: firstEvaluation.id,
        logger: quiet,
      });
      assert.equal(customerEmpty.visits.length, 0);
      assert.equal(customerEmpty.actions.canProposeEvaluationVisit, false);
      const genericReadDenied = await listVisits({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: firstJob.jobId,
        logger: quiet,
      });
      assert.equal(genericReadDenied.code, "VISIT_AUTHORITY_REQUIRED");

      const customerCannotPropose = await visitCommand(
        proposeVisit,
        pool,
        identities.homeownerId,
        evaluationProposal(firstJob, firstEvaluation)
      );
      assert.equal(customerCannotPropose.code, "VISIT_AUTHORITY_REQUIRED");
      const noApprovedWorkAuthority = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        {
          ...evaluationProposal(firstJob, firstEvaluation),
          purpose: "APPROVED_WORK",
          evaluationId: null,
          approvedQuoteDecisionId: randomUUID(),
        }
      );
      assert.equal(noApprovedWorkAuthority.code, "VISIT_AUTHORITY_REQUIRED");
      const noFollowUpAuthority = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        {
          ...evaluationProposal(firstJob, firstEvaluation),
          purpose: "FOLLOW_UP",
          evaluationId: null,
        }
      );
      assert.equal(noFollowUpAuthority.code, "VISIT_AUTHORITY_REQUIRED");
      const crossEvaluationDenied = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        evaluationProposal(firstJob, secondEvaluation)
      );
      assert.equal(crossEvaluationDenied.code, "VISIT_AUTHORITY_REQUIRED");

      const proposed = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        evaluationProposal(firstJob, firstEvaluation)
      );
      assert.equal(proposed.code, "VISIT_PROPOSED");
      assert.equal(proposed.visit.purpose, "EVALUATION");
      assert.equal(proposed.visit.evaluationId, firstEvaluation.id);
      assert.equal(proposed.visit.state, "PROPOSED");

      const professionalCannotConfirm = await visitCommand(
        confirmVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 1,
        }
      );
      assert.equal(professionalCannotConfirm.code, "VISIT_AUTHORITY_REQUIRED");
      const confirmed = await visitCommand(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 1,
        }
      );
      assert.equal(confirmed.code, "VISIT_CONFIRMED");

      const changeRequested = await visitCommand(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          reason: "Please move the synthetic Evaluation Visit later.",
        }
      );
      assert.equal(changeRequested.code, "VISIT_CHANGE_REQUESTED");
      assert.equal(changeRequested.visit.currentVersion, 2);
      assert.equal(
        changeRequested.visit.scheduledStartAt,
        confirmed.visit.scheduledStartAt
      );

      const customerCannotReschedule = await visitCommand(
        rescheduleVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          scheduledStartAt: "2026-08-21T13:00:00.000Z",
          scheduledEndAt: "2026-08-21T14:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
        }
      );
      assert.equal(customerCannotReschedule.code, "VISIT_AUTHORITY_REQUIRED");
      const rescheduled = await visitCommand(
        rescheduleVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          scheduledStartAt: "2026-08-21T13:00:00.000Z",
          scheduledEndAt: "2026-08-21T14:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
          reason: "Synthetic reschedule",
        }
      );
      assert.equal(rescheduled.code, "VISIT_RESCHEDULED");
      assert.equal(rescheduled.visit.id, proposed.visit.id);
      assert.equal(rescheduled.visit.currentVersion, 3);

      const staleCompletion = await visitCommand(
        completeVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
        },
        randomUUID(),
        { clock: () => new Date("2026-08-22T12:00:00.000Z") }
      );
      assert.equal(staleCompletion.code, "STALE_VISIT_VERSION");

      const adjacentBefore = await adjacentTruth(pool, firstJob, firstEvaluation);
      const completed = await visitCommand(
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
      assert.equal(completed.code, "VISIT_COMPLETED");
      assert.equal(completed.visit.state, "COMPLETED");
      const adjacentAfter = await adjacentTruth(pool, firstJob, firstEvaluation);
      assert.deepEqual(adjacentAfter, adjacentBefore);
      assert.deepEqual(adjacentAfter, {
        evaluation_status: "draft",
        findings: 0,
        recommendations: 0,
        quotes: 0,
        workstreams: 0,
        activities: 0,
        request_cancelled_at: null,
        relationship_status: "active",
        lifecycle_contract_version: 2,
      });

      const secondProposed = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        evaluationProposal(firstJob, firstEvaluation, 16)
      );
      const customerCannotCancel = await visitCommand(
        cancelVisit,
        pool,
        identities.homeownerId,
        {
          jobId: firstJob.jobId,
          visitId: secondProposed.visit.id,
          expectedVersion: 1,
          reason: "Customer cannot cancel canonically.",
        }
      );
      assert.equal(customerCannotCancel.code, "VISIT_AUTHORITY_REQUIRED");
      const cancelled = await visitCommand(
        cancelVisit,
        pool,
        identities.professionalId,
        {
          jobId: firstJob.jobId,
          visitId: secondProposed.visit.id,
          expectedVersion: 1,
          reason: "Synthetic Evaluation Visit cancellation.",
        }
      );
      assert.equal(cancelled.code, "VISIT_CANCELLED");
      assert.equal(cancelled.visit.id, secondProposed.visit.id);
      assert.equal(cancelled.visit.state, "CANCELLED");
      assert.deepEqual(
        await adjacentTruth(pool, firstJob, firstEvaluation),
        adjacentBefore
      );

      const listed = await listEvaluationVisits({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: firstJob.jobId,
        evaluationId: firstEvaluation.id,
        logger: quiet,
      });
      assert.equal(listed.visits.length, 2);
      assert.equal(listed.visits.every((visit) => visit.purpose === "EVALUATION"), true);
      const detail = await getEvaluationVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: firstJob.jobId,
        evaluationId: firstEvaluation.id,
        visitId: completed.visit.id,
        logger: quiet,
      });
      assert.equal(detail.code, "EVALUATION_VISIT_FOUND");
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

      const finalTruth = await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM canonical_visits
             WHERE job_id = $1 AND purpose = 'EVALUATION') AS evaluation_visits,
           (SELECT count(*)::integer FROM canonical_visits
             WHERE job_id = $1 AND purpose = 'APPROVED_WORK') AS approved_work_visits,
           (SELECT count(*)::integer FROM canonical_visits
             WHERE job_id = $1 AND purpose = 'FOLLOW_UP') AS follow_up_visits,
           (SELECT count(*)::integer
            FROM canonical_evaluation_visit_authority_activations
            WHERE evaluation_id = $2 AND job_id = $1) AS activations,
           (SELECT count(*)::integer FROM lifecycle_authority_grants
            WHERE job_id = $1 AND capability LIKE 'visit.%') AS grants`,
        [firstJob.jobId, firstEvaluation.id]
      );
      assert.deepEqual(finalTruth.rows[0], {
        evaluation_visits: 2,
        approved_work_visits: 0,
        follow_up_visits: 0,
        activations: 1,
        grants: 8,
      });

      await assert.rejects(
        pool.query(
          `UPDATE canonical_evaluation_visit_authority_activations
           SET idempotency_key = 'mutated'
           WHERE evaluation_id = $1`,
          [firstEvaluation.id]
        ),
        /append-only/i
      );

      const evaluationCompleted = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: firstEvaluation.id,
        expectedVersion: 1,
        idempotencyKey: `evaluation-complete-${suffix}`,
        logger: quiet,
      });
      assert.equal(evaluationCompleted.code, "EVALUATION_COMPLETED");
      const proposalAfterEvaluationCompletion = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        evaluationProposal(firstJob, firstEvaluation, 18)
      );
      assert.equal(
        proposalAfterEvaluationCompletion.code,
        "VISIT_SUBJECT_SCOPE_MISMATCH"
      );
      const authorityAfterEvaluationCompletion = await getEvaluationVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: firstJob.jobId,
        evaluationId: firstEvaluation.id,
        logger: quiet,
      });
      assert.equal(authorityAfterEvaluationCompletion.authority.state, "ACTIVE");
      assert.equal(
        authorityAfterEvaluationCompletion.authority.actions.canProposeEvaluationVisit,
        false
      );
    } finally {
      await pool.end();
    }
  }
);

test(
  "staging-equivalent upgrade preserves existing lifecycle truth and activates nothing",
  { skip: !upgradeDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: upgradeDatabaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const activationIndex = migrations.findIndex(
        ({ filename }) =>
          filename === "202608130002_activate_evaluation_visit_authority.sql"
      );
      const before002c = migrations.slice(0, activationIndex);
      const activationMigration = migrations[activationIndex];
      assert.equal(before002c.length, 36);
      assert.equal(
        activationMigration.filename,
        "202608130002_activate_evaluation_visit_authority.sql"
      );
      const baseline = await runMigrationCollection(
        pool,
        before002c,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(baseline.success, true);
      assert.equal(baseline.applied.length, 36);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-upgrade`
      );
      const evaluation = { id: randomUUID() };
      const subject = await pool.query(
        `SELECT jobs.source_request_relationship_id AS relationship_id,
           relationships.homeowner_id
         FROM jobs
         INNER JOIN request_relationships relationships
           ON relationships.id = jobs.source_request_relationship_id
         WHERE jobs.id = $1`,
        [fixture.jobId]
      );
      await pool.query(
        `INSERT INTO commercial_authority_aggregates (
           id, aggregate_type, owning_engine, source_context_type,
           ordinary_request_id, emergency_request_id, relationship_id,
           source_owner_user_id, created_by_user_id, current_version
         ) VALUES (
           $1, 'evaluation', 'authorization_engine', 'ordinary_request',
           $2, NULL, $3, $4, $5, 1
         )`,
        [
          evaluation.id,
          fixture.requestId,
          subject.rows[0].relationship_id,
          subject.rows[0].homeowner_id,
          identities.professionalId,
        ]
      );
      await pool.query(
        `INSERT INTO canonical_evaluations (
           id, relationship_id, professional_user_id, status
         ) VALUES ($1, $2, $3, 'draft')`,
        [
          evaluation.id,
          subject.rows[0].relationship_id,
          identities.professionalId,
        ]
      );
      await pool.query(
        `INSERT INTO canonical_evaluation_job_subjects (
           evaluation_id, job_id, job_request_id, relationship_id
         ) VALUES ($1, $2, $3, $4)`,
        [
          evaluation.id,
          fixture.jobId,
          fixture.requestId,
          subject.rows[0].relationship_id,
        ]
      );
      const before = await adjacentTruth(pool, fixture, evaluation);

      const upgraded = await runMigrationCollection(
        pool,
        [activationMigration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(upgraded.success, true);
      assert.deepEqual(upgraded.applied, [activationMigration.filename]);
      const truth = await pool.query(
        `SELECT
           to_regclass('public.canonical_evaluation_visit_authority_activations')
             IS NOT NULL AS activation_table,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'lifecycle_authority_grants'
               AND column_name = 'scope_evaluation_id'
           ) AS evaluation_scope_column,
           (SELECT count(*)::integer
            FROM canonical_evaluation_visit_authority_activations) AS activations,
           (SELECT count(*)::integer FROM lifecycle_authority_grants
            WHERE capability LIKE 'visit.%') AS visit_grants,
           (SELECT count(*)::integer FROM canonical_visits) AS visits,
           (SELECT count(*)::integer FROM schema_migrations
            WHERE filename = $1) AS ledger`,
        [activationMigration.filename]
      );
      assert.deepEqual(truth.rows[0], {
        activation_table: true,
        evaluation_scope_column: true,
        activations: 0,
        visit_grants: 0,
        visits: 0,
        ledger: 1,
      });
      assert.deepEqual(await adjacentTruth(pool, fixture, evaluation), before);

      const replay = await runMigrationCollection(
        pool,
        [activationMigration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.deepEqual(replay.applied, []);
      assert.deepEqual(replay.skipped, [activationMigration.filename]);
    } finally {
      await pool.end();
    }
  }
);
