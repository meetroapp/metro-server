"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  createVisitWorkstream,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  completeWorkstream,
  createWorkActivity,
  progressWorkActivity,
} = require("../server/workflow/workstreamService");
const {
  completeJob,
  getCustomerJobHistory,
  getJobCompletionReview,
  getProfessionalJobHistory,
  listProfessionalJobHistory,
} = require("../server/workflow/jobCompletionService");
const { getProfessionalWorkPlanSummary } = require("../server/workflow/workPlanService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.JOB_COMPLETION_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV }),
  };
}

function command(service, pool, actorId, values, idempotencyKey) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey,
    logger: quiet,
    ...values,
  });
}

async function createApprovedWork(pool, identities, fixture, workstream, suffix) {
  const created = await command(createDraftQuote, pool, identities.professionalId, {
    jobId: fixture.jobId,
    currency: "USD",
  }, `completion-quote-create-${suffix}`);
  const scoped = await command(addDraftScopeItem, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: created.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: "Complete the governed synthetic repair",
      quantity: 1,
      unitAmountMinor: 92000,
      source: {
        type: "WORKSTREAM",
        workstreamId: workstream.id,
        version: workstream.currentVersion,
      },
    },
  }, `completion-quote-scope-${suffix}`);
  const issued = await command(issueQuote, pool, identities.professionalId, {
    quoteId: scoped.quote.id,
    expectedVersion: scoped.quote.currentVersion,
  }, `completion-quote-issue-${suffix}`);
  await command(approveIssuedQuote, pool, identities.homeownerId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `completion-quote-approve-${suffix}`);
  return issued;
}

test(
  "disposable PostgreSQL certifies exact versioned Job completion and canonical history",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 45);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true);
      assert.equal(migrated.applied.length, 45);
      const replay = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replay.success, true);
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 45);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, suffix);
      const workstream = await createVisitWorkstream(pool, identities, fixture, suffix, 1);
      const quote = await createApprovedWork(pool, identities, fixture, workstream, suffix);
      const activity = await command(createWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: workstream.id,
        activityType: "REPAIR",
        statement: "Complete the synthetic repair.",
        customerVisible: true,
      }, `completion-activity-${suffix}`);

      let review = await getJobCompletionReview({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      assert.equal(review.completionReview.eligible, false);
      assert.ok(review.completionReview.reasons.includes("INCOMPLETE_WORKSTREAM"));
      assert.ok(review.completionReview.reasons.includes("INCOMPLETE_WORK_ITEM"));

      const blocked = await command(completeJob, pool, identities.professionalId, {
        jobId: fixture.jobId,
        expectedVersion: 0,
      }, `completion-blocked-${suffix}`);
      assert.equal(blocked.code, "JOB_COMPLETION_INELIGIBLE");

      const started = await command(progressWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: workstream.id,
        activityId: activity.activity.id,
        expectedVersion: activity.activity.currentVersion,
        targetStatus: "IN_PROGRESS",
      }, `completion-start-${suffix}`);
      const done = await command(progressWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: workstream.id,
        activityId: activity.activity.id,
        expectedVersion: started.activity.currentVersion,
        targetStatus: "DONE",
      }, `completion-done-${suffix}`);
      assert.equal(done.activity.status, "DONE");
      const completedArea = await command(completeWorkstream, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: workstream.id,
        expectedVersion: workstream.currentVersion,
      }, `completion-area-${suffix}`);
      assert.equal(completedArea.workstream.state, "COMPLETED");

      review = await getJobCompletionReview({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      assert.equal(review.completionReview.eligible, true);
      assert.equal(review.completionReview.currentVersion, 0);

      const outsider = await command(completeJob, pool, identities.outsiderId, {
        jobId: fixture.jobId,
        expectedVersion: 0,
      }, `completion-outsider-${suffix}`);
      assert.equal(outsider.code, "JOB_COMPLETION_UNAVAILABLE");

      const stale = await command(completeJob, pool, identities.professionalId, {
        jobId: fixture.jobId,
        expectedVersion: 1,
      }, `completion-stale-${suffix}`);
      assert.equal(stale.code, "STALE_JOB_VERSION");

      const before = await pool.query(
        `SELECT quotes.status, versions.version, decisions.decision,
          (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visit_count
         FROM canonical_quotes quotes
         INNER JOIN canonical_quote_versions versions
           ON versions.quote_id = quotes.id AND versions.version = $3
         INNER JOIN canonical_quote_customer_decisions decisions
           ON decisions.quote_id = quotes.id
         WHERE quotes.id = $2`,
        [fixture.jobId, quote.quote.id, quote.quote.currentVersion]
      );
      const completionKey = `completion-job-${suffix}`;
      const completed = await command(completeJob, pool, identities.professionalId, {
        jobId: fixture.jobId,
        expectedVersion: 0,
      }, completionKey);
      assert.equal(completed.code, "JOB_COMPLETED");
      assert.equal(completed.completion.currentVersion, 1);
      assert.equal(completed.completion.nextAction.code, "READY_TO_INVOICE");
      const replayed = await command(completeJob, pool, identities.professionalId, {
        jobId: fixture.jobId,
        expectedVersion: 0,
      }, completionKey);
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.completion.id, completed.completion.id);

      const after = await pool.query(
        `SELECT quotes.status, versions.version, decisions.decision,
          (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visit_count
         FROM canonical_quotes quotes
         INNER JOIN canonical_quote_versions versions
           ON versions.quote_id = quotes.id AND versions.version = $3
         INNER JOIN canonical_quote_customer_decisions decisions
           ON decisions.quote_id = quotes.id
         WHERE quotes.id = $2`,
        [fixture.jobId, quote.quote.id, quote.quote.currentVersion]
      );
      assert.deepEqual(after.rows, before.rows);

      const professionalHistory = await listProfessionalJobHistory({
        pool,
        authenticatedActor: { id: identities.professionalId },
        limit: 20,
      });
      assert.equal(professionalHistory.jobHistory.totalCount, 1);
      assert.equal(professionalHistory.jobHistory.jobs[0].jobId, fixture.jobId);
      assert.equal(professionalHistory.jobHistory.jobs[0].approvedQuote.totalMinor, 92000);

      const detail = await getProfessionalJobHistory({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      assert.equal(detail.jobHistory.audience, "professional");
      const customer = await getCustomerJobHistory({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.equal(customer.jobHistory.audience, "customer");
      assert.doesNotMatch(JSON.stringify(customer), /cost|margin|hash|grant|idempotency/i);

      const workPlanSummary = await getProfessionalWorkPlanSummary({
        pool,
        authenticatedActor: { id: identities.professionalId },
      });
      assert.equal(workPlanSummary.workPlanSummary.jobs.some((job) => job.jobId === fixture.jobId), false);

      await assert.rejects(
        pool.query(
          `UPDATE canonical_job_completion_records SET completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [completed.completion.id]
        ),
        (error) => error?.code === "55000"
      );
    } finally {
      await pool.end();
    }
  }
);
