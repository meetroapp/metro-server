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
  ensureVisitEvaluation,
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
  createWorkObligation,
  progressWorkActivity,
  transitionWorkObligation,
  updateWorkActivity,
} = require("../server/workflow/workstreamService");
const {
  getCustomerJobWorkPlan,
  getProfessionalJobWorkPlan,
  getProfessionalWorkPlanSummary,
} = require("../server/workflow/workPlanService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.WORK_PLAN_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
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

async function createQuote(pool, identities, fixture, workstream, suffix, approve) {
  const created = await command(
    createDraftQuote,
    pool,
    identities.professionalId,
    { jobId: fixture.jobId, currency: "USD" },
    `work-plan-quote-create-${suffix}`
  );
  assert.equal(created.ok, true, created.code);
  const scoped = await command(
    addDraftScopeItem,
    pool,
    identities.professionalId,
    {
      quoteId: created.quote.id,
      expectedVersion: created.quote.currentVersion,
      item: {
        classification: "LABOR_SERVICE",
        scopeSemantic: "FUTURE_WORK",
        materialResponsibility: "NOT_APPLICABLE",
        description: "Install the approved replacement assembly",
        quantity: 1,
        unitAmountMinor: 12500,
        source: {
          type: "WORKSTREAM",
          workstreamId: workstream.id,
          version: workstream.currentVersion,
        },
      },
    },
    `work-plan-quote-scope-${suffix}`
  );
  assert.equal(scoped.ok, true, scoped.code);
  if (!approve) return scoped.quote;
  await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const issued = await command(
    issueQuote,
    pool,
    identities.professionalId,
    {
      quoteId: scoped.quote.id,
      expectedVersion: scoped.quote.currentVersion,
    },
    `work-plan-quote-issue-${suffix}`
  );
  assert.equal(issued.ok, true, issued.code);
  const approved = await command(
    approveIssuedQuote,
    pool,
    identities.homeownerId,
    {
      quoteId: issued.quote.id,
      expectedIssuedVersion: issued.quote.currentVersion,
    },
    `work-plan-quote-approve-${suffix}`
  );
  assert.equal(approved.ok, true, approved.code);
  return issued.quote;
}

test(
  "disposable PostgreSQL certifies approved Work Plan execution and customer-safe progress",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 47);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true);
      assert.equal(migrated.applied.length, 45);
      const replay = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replay.success, true);
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 45);

      const identities = await createVisitTestIdentities(pool, suffix);
      const draftFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-draft`
      );
      const draftWorkstream = await createVisitWorkstream(
        pool,
        identities,
        draftFixture,
        `${suffix}-draft`,
        1
      );
      const draft = await createQuote(
        pool,
        identities,
        draftFixture,
        draftWorkstream,
        `${suffix}-draft`,
        false
      );
      let professional = await getProfessionalJobWorkPlan({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: draftFixture.jobId,
      });
      assert.equal(professional.ok, true);
      assert.deepEqual(professional.workPlan.approvedQuotes, []);
      assert.deepEqual(professional.workPlan.workstreams, []);

      const fixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-approved`
      );
      const workstream = await createVisitWorkstream(
        pool,
        identities,
        fixture,
        suffix,
        1
      );
      const issued = await createQuote(
        pool,
        identities,
        fixture,
        workstream,
        `${suffix}-approved`,
        true
      );
      professional = await getProfessionalJobWorkPlan({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      assert.equal(professional.ok, true);
      assert.deepEqual(
        professional.workPlan.approvedQuotes.map((quote) => quote.id),
        [issued.id]
      );
      assert.equal(professional.workPlan.workstreams[0].id, workstream.id);

      const createKey = `work-plan-activity-create-${suffix}`;
      const created = await command(
        createWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityType: "INSTALLATION",
          statement: "Install the replacement assembly.",
          customerVisible: false,
        },
        createKey
      );
      assert.equal(created.ok, true, created.code);
      const createReplay = await command(
        createWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityType: "INSTALLATION",
          statement: "Install the replacement assembly.",
          customerVisible: false,
        },
        createKey
      );
      assert.equal(createReplay.activity.id, created.activity.id);

      const unauthorized = await command(
        createWorkActivity,
        pool,
        identities.outsiderId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityType: "INSTALLATION",
          statement: "Unauthorized work.",
        },
        `work-plan-unauthorized-${suffix}`
      );
      assert.equal(unauthorized.ok, false);

      const startKey = `work-plan-activity-start-${suffix}`;
      const started = await command(
        progressWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityId: created.activity.id,
          expectedVersion: created.activity.currentVersion,
          targetStatus: "IN_PROGRESS",
        },
        startKey
      );
      assert.equal(started.activity.status, "IN_PROGRESS");
      const startReplay = await command(
        progressWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityId: created.activity.id,
          expectedVersion: created.activity.currentVersion,
          targetStatus: "IN_PROGRESS",
        },
        startKey
      );
      assert.equal(startReplay.activity.currentVersion, started.activity.currentVersion);

      const staleUpdate = await command(
        updateWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityId: created.activity.id,
          expectedVersion: created.activity.currentVersion,
          statement: "This stale update must fail.",
          customerVisible: true,
        },
        `work-plan-stale-update-${suffix}`
      );
      assert.equal(staleUpdate.code, "STALE_WORK_ACTIVITY_VERSION");

      const updateKey = `work-plan-activity-update-${suffix}`;
      const updated = await command(
        updateWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityId: created.activity.id,
          expectedVersion: started.activity.currentVersion,
          statement: "Replacement assembly installed and tested.",
          customerVisible: true,
        },
        updateKey
      );
      assert.equal(updated.activity.customerVisible, true);
      const updateReplay = await command(
        updateWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityId: created.activity.id,
          expectedVersion: started.activity.currentVersion,
          statement: "Replacement assembly installed and tested.",
          customerVisible: true,
        },
        updateKey
      );
      assert.equal(updateReplay.activity.currentVersion, updated.activity.currentVersion);

      let customer = await getCustomerJobWorkPlan({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.equal(customer.ok, true, customer.code);
      assert.equal(
        customer.workPlan.workstreams[0].activities[0].statement,
        "Replacement assembly installed and tested."
      );

      const completedActivity = await command(
        progressWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          activityId: created.activity.id,
          expectedVersion: updated.activity.currentVersion,
          targetStatus: "DONE",
        },
        `work-plan-activity-complete-${suffix}`
      );
      assert.equal(completedActivity.activity.status, "DONE");

      const obligation = await command(
        createWorkObligation,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          sequence: 1,
          statement: "Internal tool return confirmation is required.",
        },
        `work-plan-obligation-${suffix}`
      );
      assert.equal(obligation.ok, true, obligation.code);

      professional = await getProfessionalJobWorkPlan({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      assert.equal(professional.workPlan.workstreams[0].status, "NEEDS_ATTENTION");
      assert.equal(professional.workPlan.workstreams[0].canMarkComplete, false);
      assert.equal(professional.workPlan.workstreams[0].blockers.length, 1);

      customer = await getCustomerJobWorkPlan({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.doesNotMatch(
        JSON.stringify(customer.workPlan),
        /tool return|obligation|internal/i
      );

      const blockedCompletion = await command(
        completeWorkstream,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          expectedVersion: workstream.currentVersion,
        },
        `work-plan-blocked-completion-${suffix}`
      );
      assert.equal(blockedCompletion.code, "WORKSTREAM_COMPLETION_INELIGIBLE");
      assert.deepEqual(blockedCompletion.reasons, ["OPEN_OBLIGATION"]);

      const satisfied = await command(
        transitionWorkObligation,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          obligationId: obligation.obligation.id,
          expectedVersion: obligation.obligation.currentVersion,
          targetStatus: "SATISFIED",
        },
        `work-plan-obligation-satisfied-${suffix}`
      );
      assert.equal(satisfied.obligation.status, "SATISFIED");

      const completionKey = `work-plan-workstream-complete-${suffix}`;
      const completed = await command(
        completeWorkstream,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          expectedVersion: workstream.currentVersion,
        },
        completionKey
      );
      assert.equal(completed.workstream.state, "COMPLETED");
      const completionReplay = await command(
        completeWorkstream,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          workstreamId: workstream.id,
          expectedVersion: workstream.currentVersion,
        },
        completionKey
      );
      assert.equal(completionReplay.workstream.id, completed.workstream.id);

      professional = await getProfessionalJobWorkPlan({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      customer = await getCustomerJobWorkPlan({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.equal(professional.workPlan.summary.readyForCompletionReview, true);
      assert.equal(customer.workPlan.summary.readyForCompletionReview, true);
      assert.equal(customer.workPlan.workstreams[0].status, "COMPLETED");

      const summary = await getProfessionalWorkPlanSummary({
        pool,
        authenticatedActor: { id: identities.professionalId },
      });
      assert.equal(summary.ok, true);
      assert.equal(summary.workPlanSummary.jobs.length, 1);
      assert.equal(summary.workPlanSummary.jobs[0].readyForCompletionReview, true);

      const preserved = await pool.query(
        `SELECT
          (SELECT count(*)::integer FROM schema_migrations) AS ledger,
          (SELECT status FROM canonical_quotes WHERE id = $1) AS quote_status,
          (SELECT decision FROM canonical_quote_customer_decisions
            WHERE quote_id = $1) AS quote_decision,
          (SELECT status FROM canonical_quotes WHERE id = $2) AS draft_status`,
        [issued.id, draft.id]
      );
      assert.deepEqual(preserved.rows[0], {
        ledger: 44,
        quote_status: "ISSUED",
        quote_decision: "APPROVED",
        draft_status: "DRAFT",
      });
    } finally {
      await pool.end();
    }
  }
);
