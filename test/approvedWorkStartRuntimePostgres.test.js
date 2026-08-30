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
const { completeEvaluation } = require("../server/authorization/evaluationService");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  createDerivedDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const { sendQuoteInMeetro } = require("../server/authorization/quoteDeliveryService");
const {
  confirmDepositReceived,
  materializePreWorkDepositObligation,
  reverseDepositAllocation,
} = require("../server/finance/preWorkDepositService");
const {
  bindWorkstreamToExecution,
  classifyWorkActivity,
  closeApprovedWorkExecution,
  materializeApprovedWorkExecution,
  supersedeApprovedWorkExecution,
} = require("../server/workflow/approvedWorkExecutionService");
const {
  materializeWorkPreparation,
  recordPreparationEvent,
  reviseWorkPreparation,
} = require("../server/workflow/workPreparationService");
const {
  createWorkActivity,
  progressWorkActivity,
} = require("../server/workflow/workstreamService");
const {
  activateApprovedWorkVisitAuthority,
} = require("../server/workflow/approvedWorkVisitService");
const {
  confirmVisit,
  proposeVisit,
  startVisit,
} = require("../server/workflow/visitService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.APPROVED_WORK_START_RUNTIME_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV }),
  };
}

function command(service, pool, actorId, values, key = randomUUID()) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey: key,
    logger: quiet,
    ...values,
  });
}

function terms(paymentTerms) {
  return {
    schemaVersion: 1,
    paymentTerms,
    estimatedDuration: "1 day",
    customerNotes: "",
    agreement: {
      exclusions: [],
      additionalWorkTerms: "Written customer approval is required.",
      hiddenConditionsTerms: "Hidden conditions require a revised Quote.",
      diagnosticTerms: "Diagnostic work is limited to the stated scope.",
      customerResponsibilities: "Provide safe site access.",
      warrantyTerms: "One-year workmanship warranty.",
      cancellationTerms: "Cancellation terms apply as stated.",
      acceptanceTerms: "Approval accepts this exact issued Quote.",
      preauthorizedAdditionalWorkLimit: "$0",
    },
  };
}

async function completeFixtureEvaluation(pool, identities, fixture, suffix) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completed = await command(completeEvaluation, pool, identities.professionalId, {
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis: "Reviewed the synthetic atomic Work-start fixture by phone.",
  }, `approved-start-evaluation-${suffix}`);
  assert.equal(completed.ok, true, completed.code);
}

async function createApprovedQuote(pool, identities, fixture, suffix, {
  parent = null,
  paymentTerms = "Payment due on completion.",
} = {}) {
  const created = parent
    ? await command(createDerivedDraftQuote, pool, identities.professionalId, {
      parentQuoteId: parent.quoteId,
      expectedIssuedVersion: parent.issuedVersion,
      lineageType: "SUPPLEMENTAL_QUOTE",
      reasonCategory: "SUPPLEMENTAL_WORK",
    }, `approved-start-derived-${suffix}`)
    : await command(createDraftQuote, pool, identities.professionalId, {
      jobId: fixture.jobId,
      currency: "USD",
      customerTermsSnapshot: terms(paymentTerms),
    }, `approved-start-quote-${suffix}`);
  assert.equal(created.ok, true, created.code);
  const scoped = await command(addDraftScopeItem, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: created.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: `Atomic Approved Work start scope ${suffix}`,
      quantity: 1,
      unitAmountMinor: parent ? 5000 : 68000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
  }, `approved-start-scope-${suffix}`);
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await command(issueQuote, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
  }, `approved-start-issue-${suffix}`);
  assert.equal(issued.ok, true, issued.code);
  const delivered = await command(sendQuoteInMeetro, pool, identities.professionalId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `approved-start-deliver-${suffix}`);
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await command(approveIssuedQuote, pool, identities.homeownerId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `approved-start-approve-${suffix}`);
  assert.equal(approved.ok, true, approved.code);
  return {
    quoteId: issued.quote.id,
    issuedVersion: issued.quote.currentVersion,
    decisionId: approved.customerDecision.id,
  };
}

async function createExecution(pool, identities, fixture, quote, suffix) {
  const materialized = await command(
    materializeApprovedWorkExecution,
    pool,
    identities.professionalId,
    {
      jobId: fixture.jobId,
      approvedCustomerDecisionId: quote.decisionId,
    },
    `approved-start-execution-${suffix}`
  );
  assert.equal(materialized.ok, true, materialized.code);
  return materialized.execution;
}

async function createPlan(pool, identities, fixture, quote, suffix, items) {
  const materialized = await command(
    materializeWorkPreparation,
    pool,
    identities.professionalId,
    {
      jobId: fixture.jobId,
      approvedCustomerDecisionId: quote.decisionId,
    },
    `approved-start-plan-${suffix}`
  );
  assert.equal(materialized.ok, true, materialized.code);
  const revised = await command(reviseWorkPreparation, pool, identities.professionalId, {
    jobId: fixture.jobId,
    planId: materialized.workPreparation.id,
    expectedVersion: 1,
    planningState: "PLANNED",
    workStartPolicy: "REQUIRED_ITEMS_READY",
    internalNotes: "Synthetic exact-decision Work-start readiness.",
    items,
  }, `approved-start-plan-revise-${suffix}`);
  assert.equal(revised.ok, true, revised.code);
  return revised.workPreparation;
}

async function createActivity(pool, identities, fixture, workstream, suffix) {
  const created = await command(createWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    activityType: "APPROVED_WORK_EXECUTION",
    statement: `Perform exact approved work ${suffix}.`,
    customerVisible: true,
  }, `approved-start-activity-${suffix}`);
  assert.equal(created.ok, true, created.code);
  return created.activity;
}

async function classify(
  pool,
  identities,
  fixture,
  execution,
  workstream,
  activity,
  suffix,
  classification = "EXECUTION"
) {
  const result = await command(classifyWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    executionId: execution.id,
    workstreamId: workstream.id,
    activityId: activity.id,
    expectedExecutionVersion: execution.currentVersion,
    expectedActivityVersion: activity.currentVersion,
    classification,
    ...(classification === "EXECUTION" ? { scopeBasis: "DECISION_WIDE" } : {}),
  }, `approved-start-classify-${suffix}`);
  assert.equal(result.ok, true, result.code);
  return result.classification;
}

function startActivity(pool, identities, fixture, execution, workstream, activity, key, overrides = {}) {
  return command(progressWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    activityId: activity.id,
    expectedVersion: activity.currentVersion,
    targetStatus: "IN_PROGRESS",
    approvedWorkExecutionId: execution.id,
    expectedExecutionVersion: execution.currentVersion,
    ...overrides,
  }, key);
}

async function counts(pool, fixture, execution) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM canonical_approved_work_execution_start_events
        WHERE execution_id = $1)::integer AS starts,
       (SELECT count(*) FROM canonical_pre_work_payment_receipts
        WHERE job_id = $2)::integer AS receipts,
       (SELECT count(*) FROM canonical_pre_work_payment_allocations
        WHERE job_id = $2)::integer AS allocations,
       (SELECT count(*) FROM canonical_work_preparation_events
        WHERE job_id = $2)::integer AS preparation_events,
       (SELECT count(*) FROM canonical_material_purchase_records
        WHERE job_id = $2)::integer AS purchases,
       (SELECT count(*) FROM canonical_invoices
        WHERE job_id = $2)::integer AS invoices`,
    [execution.id, fixture.jobId]
  );
  return result.rows[0];
}

test(
  "disposable PostgreSQL certifies atomic exact-decision Activity and Approved Work Visit start",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300005_create_business_team_membership_authority.sql");
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, migrations.length);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, suffix);
      await completeFixtureEvaluation(pool, identities, fixture, suffix);
      const primary = await createApprovedQuote(pool, identities, fixture, `${suffix}-primary`, {
        paymentTerms: "75% deposit; balance due on completion.",
      });
      const execution = await createExecution(pool, identities, fixture, primary, `${suffix}-primary`);
      const workstream = await createVisitWorkstream(pool, identities, fixture, suffix, 1);
      const bound = await command(bindWorkstreamToExecution, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        workstreamId: workstream.id,
        expectedExecutionVersion: execution.currentVersion,
      }, `approved-start-bind-${suffix}`);
      assert.equal(bound.ok, true, bound.code);

      const activity = await createActivity(pool, identities, fixture, workstream, `${suffix}-primary`);
      await classify(pool, identities, fixture, execution, workstream, activity, `${suffix}-primary`);
      const nonExecutionActivity = await createActivity(
        pool, identities, fixture, workstream, `${suffix}-non-execution`
      );
      await classify(
        pool,
        identities,
        fixture,
        execution,
        workstream,
        nonExecutionActivity,
        `${suffix}-non-execution`,
        "NON_EXECUTION"
      );
      const unclassifiedActivity = await createActivity(
        pool, identities, fixture, workstream, `${suffix}-unclassified`
      );

      const missingDeposit = await startActivity(
        pool, identities, fixture, execution, workstream, activity,
        `approved-start-missing-deposit-${suffix}`
      );
      assert.equal(missingDeposit.code, "PRE_WORK_DEPOSIT_NOT_SATISFIED");

      const deposit = await command(
        materializePreWorkDepositObligation,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId },
        `approved-start-deposit-${suffix}`
      );
      assert.equal(deposit.deposit.state, "DUE");
      const partial = await command(confirmDepositReceived, pool, identities.professionalId, {
        jobId: fixture.jobId,
        amountMinor: 10000,
        currency: "USD",
        normalizedMethod: "BUSINESS_TRANSFER_APP",
        displayMethod: "Business transfer app",
        receivedAt: new Date(Date.now() - 120000).toISOString(),
        expectedVersion: 1,
        externalReference: `approved-start-partial-${suffix}`,
      }, `approved-start-partial-${suffix}`);
      assert.equal(partial.deposit.state, "PARTIALLY_SATISFIED");
      assert.equal((await startActivity(
        pool, identities, fixture, execution, workstream, activity,
        `approved-start-partial-block-${suffix}`
      )).code, "PRE_WORK_DEPOSIT_NOT_SATISFIED");
      const satisfied = await command(confirmDepositReceived, pool, identities.professionalId, {
        jobId: fixture.jobId,
        amountMinor: 41000,
        currency: "USD",
        normalizedMethod: "BUSINESS_TRANSFER_APP",
        displayMethod: "Business transfer app",
        receivedAt: new Date(Date.now() - 60000).toISOString(),
        expectedVersion: 2,
        externalReference: `approved-start-satisfied-${suffix}`,
      }, `approved-start-satisfied-${suffix}`);
      assert.equal(satisfied.deposit.state, "SATISFIED");

      const plan = await createPlan(pool, identities, fixture, primary, `${suffix}-primary`, [{
        sequence: 1,
        kind: "MATERIAL",
        description: "Exact-decision staged material",
        quantity: 1,
        unit: "lot",
        providerResponsibility: "BUSINESS",
        commercialTreatment: "NOT_CUSTOMER_BILLABLE",
        visibility: "BUSINESS_ONLY",
        requiredForWorkStart: true,
        sourceLineage: "ACCEPTED_SCOPE_ELABORATION",
      }]);
      assert.equal((await startActivity(
        pool, identities, fixture, execution, workstream, activity,
        `approved-start-materials-block-${suffix}`
      )).code, "WORK_PREPARATION_NOT_READY");

      const supplemental = await createApprovedQuote(
        pool,
        identities,
        fixture,
        `${suffix}-supplemental`,
        { parent: primary }
      );
      const supplementalExecution = await createExecution(
        pool, identities, fixture, supplemental, `${suffix}-supplemental`
      );
      await createPlan(
        pool,
        identities,
        fixture,
        supplemental,
        `${suffix}-supplemental`,
        []
      );
      assert.equal((await startActivity(
        pool, identities, fixture, execution, workstream, activity,
        `approved-start-unrelated-plan-${suffix}`
      )).code, "WORK_PREPARATION_NOT_READY");

      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        supplementalExecution,
        workstream,
        activity,
        `approved-start-wrong-execution-${suffix}`
      )).code, "APPROVED_WORK_EXECUTION_REQUIRED");
      const supersededSupplemental = await command(
        supersedeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: supplementalExecution.id,
          expectedVersion: supplementalExecution.currentVersion,
          successorExecutionId: execution.id,
        },
        `approved-start-supersede-${suffix}`
      );
      assert.equal(supersededSupplemental.ok, true, supersededSupplemental.code);
      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        supersededSupplemental.execution,
        workstream,
        activity,
        `approved-start-superseded-execution-${suffix}`
      )).code, "APPROVED_WORK_EXECUTION_NOT_ACTIVE");
      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        { ...execution, id: randomUUID() },
        workstream,
        activity,
        `approved-start-missing-execution-${suffix}`
      )).code, "APPROVED_WORK_EXECUTION_REQUIRED");
      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        execution,
        workstream,
        nonExecutionActivity,
        `approved-start-non-execution-${suffix}`
      )).code, "EXECUTION_ACTIVITY_CLASSIFICATION_REQUIRED");
      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        execution,
        workstream,
        unclassifiedActivity,
        `approved-start-unclassified-${suffix}`
      )).code, "EXECUTION_ACTIVITY_CLASSIFICATION_REQUIRED");
      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        execution,
        workstream,
        activity,
        `approved-start-stale-execution-${suffix}`,
        { expectedExecutionVersion: 2 }
      )).code, "APPROVED_WORK_EXECUTION_VERSION_CONFLICT");
      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        execution,
        workstream,
        activity,
        `approved-start-stale-activity-${suffix}`,
        { expectedVersion: 2 }
      )).code, "STALE_WORK_ACTIVITY_VERSION");

      const staged = await command(recordPreparationEvent, pool, identities.professionalId, {
        jobId: fixture.jobId,
        planId: plan.id,
        itemId: plan.items[0].id,
        expectedVersion: plan.currentVersion,
        eventType: "MATERIAL_STAGED",
        visibility: "BUSINESS_ONLY",
        internalNote: "Exact decision material is staged.",
      }, `approved-start-stage-${suffix}`);
      assert.equal(staged.ok, true, staged.code);

      const beforeSuccessfulStarts = await counts(pool, fixture, execution);
      const activityKey = `approved-start-activity-success-${suffix}`;
      const startedActivity = await startActivity(
        pool, identities, fixture, execution, workstream, activity, activityKey
      );
      assert.equal(startedActivity.ok, true, startedActivity.code);
      assert.equal(startedActivity.activity.status, "IN_PROGRESS");
      assert.equal(startedActivity.approvedWorkStart.ready, true);
      assert.equal(startedActivity.approvedWorkStartEvent.sourceType, "EXECUTION_ACTIVITY");
      const activityReplay = await startActivity(
        pool, identities, fixture, execution, workstream, activity, activityKey
      );
      assert.equal(activityReplay.replayed, true);
      assert.equal(activityReplay.approvedWorkStartEvent.id, startedActivity.approvedWorkStartEvent.id);
      const changedReplay = await startActivity(
        pool,
        identities,
        fixture,
        execution,
        workstream,
        activity,
        activityKey,
        { expectedExecutionVersion: 2 }
      );
      assert.equal(changedReplay.code, "WORKFLOW_IDEMPOTENCY_KEY_CONFLICT");

      const raceActivity = await createActivity(
        pool, identities, fixture, workstream, `${suffix}-race`
      );
      await classify(pool, identities, fixture, execution, workstream, raceActivity, `${suffix}-race`);
      const raceResults = await Promise.allSettled([
        startActivity(
          pool, identities, fixture, execution, workstream, raceActivity,
          `approved-start-race-a-${suffix}`
        ),
        startActivity(
          pool, identities, fixture, execution, workstream, raceActivity,
          `approved-start-race-b-${suffix}`
        ),
      ]);
      assert.equal(raceResults.filter(
        (entry) => entry.status === "fulfilled" && entry.value?.ok === true
      ).length, 1);
      const raceTruth = await pool.query(
        `SELECT
           (SELECT count(*) FROM canonical_work_activity_versions
            WHERE activity_id = $1 AND status = 'IN_PROGRESS')::integer AS versions,
           (SELECT count(*) FROM canonical_approved_work_execution_start_events
            WHERE source_activity_id = $1)::integer AS starts`,
        [raceActivity.id]
      );
      assert.deepEqual(raceTruth.rows[0], { versions: 1, starts: 1 });

      const activated = await command(
        activateApprovedWorkVisitAuthority,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId, quoteId: primary.quoteId },
        `approved-start-visit-authority-${suffix}`
      );
      assert.equal(activated.ok, true, activated.code);
      const proposed = await command(proposeVisit, pool, identities.professionalId, {
        jobId: fixture.jobId,
        purpose: "APPROVED_WORK",
        approvedQuoteDecisionId: primary.decisionId,
        workstreamIds: [workstream.id],
        scheduledStartAt: "2026-09-02T13:00:00.000Z",
        scheduledEndAt: "2026-09-02T14:00:00.000Z",
        timeZone: "America/New_York",
        locationMode: "JOB_SERVICE_LOCATION",
        clock: () => new Date("2026-09-01T12:00:00.000Z"),
      }, `approved-start-visit-propose-${suffix}`);
      assert.equal(proposed.ok, true, proposed.code);
      const confirmed = await command(confirmVisit, pool, identities.homeownerId, {
        jobId: fixture.jobId,
        visitId: proposed.visit.id,
        expectedVersion: proposed.visit.currentVersion,
        clock: () => new Date("2026-09-01T12:05:00.000Z"),
      }, `approved-start-visit-confirm-${suffix}`);
      assert.equal(confirmed.ok, true, confirmed.code);

      const blockedPreparation = await command(
        recordPreparationEvent,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          planId: plan.id,
          itemId: plan.items[0].id,
          expectedVersion: plan.currentVersion,
          eventType: "PREPARATION_BLOCKED",
          visibility: "BUSINESS_ONLY",
          internalNote: "Synthetic blocker before Visit start.",
        },
        `approved-start-visit-material-block-${suffix}`
      );
      assert.equal(blockedPreparation.ok, true, blockedPreparation.code);
      const visitMaterialsBlocked = await command(startVisit, pool, identities.professionalId, {
        jobId: fixture.jobId,
        visitId: confirmed.visit.id,
        expectedVersion: confirmed.visit.currentVersion,
        approvedWorkExecutionId: execution.id,
        expectedExecutionVersion: execution.currentVersion,
        acknowledgeScheduleVariance: false,
        clock: () => new Date("2026-09-02T13:00:00.000Z"),
      }, `approved-start-visit-materials-blocked-${suffix}`);
      assert.equal(visitMaterialsBlocked.code, "WORK_PREPARATION_NOT_READY");
      assert.equal((await pool.query(
        `SELECT state FROM canonical_visit_versions
         WHERE visit_id = $1 ORDER BY version DESC LIMIT 1`,
        [confirmed.visit.id]
      )).rows[0].state, "SCHEDULED");

      const readyPreparation = await command(
        recordPreparationEvent,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          planId: plan.id,
          itemId: plan.items[0].id,
          expectedVersion: plan.currentVersion,
          eventType: "PREPARATION_READY",
          visibility: "BUSINESS_ONLY",
          internalNote: "Synthetic blocker resolved before Visit start.",
        },
        `approved-start-visit-material-ready-${suffix}`
      );
      assert.equal(readyPreparation.ok, true, readyPreparation.code);
      const reversed = await command(reverseDepositAllocation, pool, identities.professionalId, {
        jobId: fixture.jobId,
        allocationId: satisfied.payment.allocationId,
        amountMinor: 1000,
        reasonCategory: "REFUND",
        reason: "Synthetic pre-start deposit reversal.",
        expectedVersion: 3,
      }, `approved-start-visit-deposit-reverse-${suffix}`);
      assert.equal(reversed.deposit.state, "PARTIALLY_SATISFIED");
      const visitDepositBlocked = await command(startVisit, pool, identities.professionalId, {
        jobId: fixture.jobId,
        visitId: confirmed.visit.id,
        expectedVersion: confirmed.visit.currentVersion,
        approvedWorkExecutionId: execution.id,
        expectedExecutionVersion: execution.currentVersion,
        acknowledgeScheduleVariance: false,
        clock: () => new Date("2026-09-02T13:00:00.000Z"),
      }, `approved-start-visit-deposit-blocked-${suffix}`);
      assert.equal(visitDepositBlocked.code, "PRE_WORK_DEPOSIT_NOT_SATISFIED");
      assert.equal((await pool.query(
        `SELECT state FROM canonical_visit_versions
         WHERE visit_id = $1 ORDER BY version DESC LIMIT 1`,
        [confirmed.visit.id]
      )).rows[0].state, "SCHEDULED");

      const visitFixture = await createVisitLifecycleFixture(
        pool, identities, `${suffix}-visit-success`
      );
      await completeFixtureEvaluation(
        pool, identities, visitFixture, `${suffix}-visit-success`
      );
      const visitQuote = await createApprovedQuote(
        pool,
        identities,
        visitFixture,
        `${suffix}-visit-success`,
        { paymentTerms: "Payment due on completion." }
      );
      const visitExecution = await createExecution(
        pool, identities, visitFixture, visitQuote, `${suffix}-visit-success`
      );
      const visitWorkstream = await createVisitWorkstream(
        pool, identities, visitFixture, `${suffix}-visit-success`, 1
      );
      const visitActivated = await command(
        activateApprovedWorkVisitAuthority,
        pool,
        identities.professionalId,
        { jobId: visitFixture.jobId, quoteId: visitQuote.quoteId },
        `approved-start-visit-success-authority-${suffix}`
      );
      assert.equal(visitActivated.ok, true, visitActivated.code);
      const visitProposed = await command(proposeVisit, pool, identities.professionalId, {
        jobId: visitFixture.jobId,
        purpose: "APPROVED_WORK",
        approvedQuoteDecisionId: visitQuote.decisionId,
        workstreamIds: [visitWorkstream.id],
        scheduledStartAt: "2026-09-03T13:00:00.000Z",
        scheduledEndAt: "2026-09-03T14:00:00.000Z",
        timeZone: "America/New_York",
        locationMode: "JOB_SERVICE_LOCATION",
        clock: () => new Date("2026-09-02T12:00:00.000Z"),
      }, `approved-start-visit-success-propose-${suffix}`);
      assert.equal(visitProposed.ok, true, visitProposed.code);
      const visitConfirmed = await command(confirmVisit, pool, identities.homeownerId, {
        jobId: visitFixture.jobId,
        visitId: visitProposed.visit.id,
        expectedVersion: visitProposed.visit.currentVersion,
        clock: () => new Date("2026-09-02T12:05:00.000Z"),
      }, `approved-start-visit-success-confirm-${suffix}`);
      assert.equal(visitConfirmed.ok, true, visitConfirmed.code);
      const visitKey = `approved-start-visit-success-${suffix}`;
      const startedVisit = await command(startVisit, pool, identities.professionalId, {
        jobId: visitFixture.jobId,
        visitId: visitConfirmed.visit.id,
        expectedVersion: visitConfirmed.visit.currentVersion,
        approvedWorkExecutionId: visitExecution.id,
        expectedExecutionVersion: visitExecution.currentVersion,
        acknowledgeScheduleVariance: false,
        clock: () => new Date("2026-09-03T13:00:00.000Z"),
      }, visitKey);
      assert.equal(startedVisit.ok, true, startedVisit.code);
      assert.equal(startedVisit.visit.state, "STARTED");
      assert.equal(startedVisit.approvedWorkStartEvent.sourceType, "APPROVED_WORK_VISIT");
      const visitReplay = await command(startVisit, pool, identities.professionalId, {
        jobId: visitFixture.jobId,
        visitId: visitConfirmed.visit.id,
        expectedVersion: visitConfirmed.visit.currentVersion,
        approvedWorkExecutionId: visitExecution.id,
        expectedExecutionVersion: visitExecution.currentVersion,
        acknowledgeScheduleVariance: false,
        clock: () => new Date("2026-09-03T13:00:00.000Z"),
      }, visitKey);
      assert.equal(visitReplay.replayed, true);
      assert.equal(visitReplay.approvedWorkStartEvent.id, startedVisit.approvedWorkStartEvent.id);

      const afterSuccessfulStarts = await counts(pool, fixture, execution);
      assert.equal(afterSuccessfulStarts.starts, beforeSuccessfulStarts.starts + 2);
      assert.equal(afterSuccessfulStarts.receipts, beforeSuccessfulStarts.receipts);
      assert.equal(afterSuccessfulStarts.allocations, beforeSuccessfulStarts.allocations);
      assert.equal(afterSuccessfulStarts.preparation_events,
        beforeSuccessfulStarts.preparation_events + 2);
      assert.equal(afterSuccessfulStarts.purchases, beforeSuccessfulStarts.purchases);
      assert.equal(afterSuccessfulStarts.invoices, beforeSuccessfulStarts.invoices);
      assert.equal(Number((await pool.query(
        `SELECT count(*) FROM canonical_approved_work_execution_start_events
         WHERE execution_id = $1 AND source_type = 'APPROVED_WORK_VISIT'`,
        [visitExecution.id]
      )).rows[0].count), 1);

      const closedActivity = await createActivity(
        pool, identities, fixture, workstream, `${suffix}-closed`
      );
      await classify(
        pool, identities, fixture, execution, workstream, closedActivity, `${suffix}-closed`
      );
      const closedExecution = await command(
        closeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: execution.id,
          expectedVersion: execution.currentVersion,
        },
        `approved-start-close-${suffix}`
      );
      assert.equal(closedExecution.ok, true, closedExecution.code);
      assert.equal((await startActivity(
        pool,
        identities,
        fixture,
        closedExecution.execution,
        workstream,
        closedActivity,
        `approved-start-closed-execution-${suffix}`
      )).code, "APPROVED_WORK_EXECUTION_NOT_ACTIVE");

      const replayedMigrations = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replayedMigrations.success, true, JSON.stringify(replayedMigrations));
      assert.equal(replayedMigrations.applied.length, 0);
      assert.equal(replayedMigrations.skipped.length, migrations.length);
    } finally {
      await pool.end();
    }
  }
);
