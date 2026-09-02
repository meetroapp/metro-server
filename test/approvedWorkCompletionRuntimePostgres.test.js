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
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const { sendQuoteInMeetro } = require("../server/authorization/quoteDeliveryService");
const {
  confirmDepositReceived,
  materializePreWorkDepositObligation,
} = require("../server/finance/preWorkDepositService");
const {
  getProfessionalInvoiceWorkspace,
} = require("../server/finance/invoicePaymentService");
const {
  bindWorkstreamToExecution,
  classifyWorkActivity,
  completeApprovedWork,
  getApprovedWorkExecution,
  materializeApprovedWorkExecution,
} = require("../server/workflow/approvedWorkExecutionService");
const { getCanonicalLiveJob } = require("../server/workflow/liveJobProjectionService");
const {
  materializeWorkPreparation,
  reviseWorkPreparation,
} = require("../server/workflow/workPreparationService");
const {
  createWorkActivity,
  createWorkObligation,
  progressWorkActivity,
  transitionWorkObligation,
} = require("../server/workflow/workstreamService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.APPROVED_WORK_COMPLETION_DATABASE_URL;

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

function customerTermsSnapshot() {
  return {
    schemaVersion: 1,
    paymentTerms: "75% deposit; balance due on completion.",
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

async function createApprovedQuote(pool, identities, fixture, suffix) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completed = await command(completeEvaluation, pool, identities.professionalId, {
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis: "Reviewed the atomic Complete Work fixture by phone.",
  }, `complete-work-evaluation-${suffix}`);
  assert.equal(completed.ok, true, completed.code);
  const created = await command(createDraftQuote, pool, identities.professionalId, {
    jobId: fixture.jobId,
    currency: "USD",
    customerTermsSnapshot: customerTermsSnapshot(),
  }, `complete-work-quote-${suffix}`);
  assert.equal(created.ok, true, created.code);
  const scoped = await command(addDraftScopeItem, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: created.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: `Atomic Complete Work scope ${suffix}`,
      quantity: 1,
      unitAmountMinor: 68000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
  }, `complete-work-scope-${suffix}`);
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await command(issueQuote, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
  }, `complete-work-issue-${suffix}`);
  assert.equal(issued.ok, true, issued.code);
  const delivered = await command(sendQuoteInMeetro, pool, identities.professionalId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `complete-work-deliver-${suffix}`);
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await command(approveIssuedQuote, pool, identities.homeownerId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `complete-work-approve-${suffix}`);
  assert.equal(approved.ok, true, approved.code);
  return {
    quoteId: issued.quote.id,
    issuedVersion: issued.quote.currentVersion,
    decisionId: approved.customerDecision.id,
  };
}

async function createActivity(pool, identities, fixture, workstream, suffix) {
  const created = await command(createWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    activityType: "APPROVED_WORK_EXECUTION",
    statement: `Complete exact approved work ${suffix}.`,
    customerVisible: true,
  }, `complete-work-activity-${suffix}`);
  assert.equal(created.ok, true, created.code);
  return created.activity;
}

async function progress(pool, identities, fixture, workstream, activity, targetStatus, suffix) {
  const result = await command(progressWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    activityId: activity.id,
    expectedVersion: activity.currentVersion,
    targetStatus,
  }, `complete-work-progress-${suffix}`);
  assert.equal(result.ok, true, result.code);
  return result.activity;
}

async function classify(pool, identities, fixture, execution, workstream, activity, suffix,
  classification = "EXECUTION") {
  const result = await command(classifyWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    executionId: execution.id,
    workstreamId: workstream.id,
    activityId: activity.id,
    expectedExecutionVersion: execution.currentVersion,
    expectedActivityVersion: activity.currentVersion,
    classification,
    ...(classification === "EXECUTION" ? { scopeBasis: "DECISION_WIDE" } : {}),
  }, `complete-work-classify-${suffix}`);
  assert.equal(result.ok, true, result.code);
  return result.classification;
}

async function latestTruth(pool, fixture, execution, activityIds, workstreamIds) {
  const [executionRow, activityRows, workstreamRows, financial] = await Promise.all([
    pool.query(
      `SELECT version, state FROM canonical_approved_work_execution_versions
       WHERE execution_id = $1 ORDER BY version DESC LIMIT 1`,
      [execution.id]
    ),
    pool.query(
      `SELECT activities.id, current.version, current.status
       FROM canonical_work_activities activities
       INNER JOIN LATERAL (
         SELECT version, status FROM canonical_work_activity_versions versions
         WHERE versions.activity_id = activities.id
         ORDER BY version DESC LIMIT 1
       ) current ON TRUE
       WHERE activities.id = ANY($1::uuid[]) ORDER BY activities.id`,
      [activityIds]
    ),
    pool.query(
      `SELECT workstreams.id, current.version, current.state
       FROM canonical_workstreams workstreams
       INNER JOIN LATERAL (
         SELECT version, state FROM canonical_workstream_versions versions
         WHERE versions.workstream_id = workstreams.id
         ORDER BY version DESC LIMIT 1
       ) current ON TRUE
       WHERE workstreams.id = ANY($1::uuid[]) ORDER BY workstreams.id`,
      [workstreamIds]
    ),
    pool.query(
      `SELECT
         (SELECT count(*)::integer FROM canonical_invoices WHERE job_id = $1) AS invoices,
         (SELECT count(*)::integer FROM canonical_invoice_payments WHERE job_id = $1) AS invoice_payments,
         (SELECT count(*)::integer FROM canonical_job_completion_records WHERE job_id = $1) AS job_completions`,
      [fixture.jobId]
    ),
  ]);
  return {
    execution: executionRow.rows[0],
    activities: activityRows.rows,
    workstreams: workstreamRows.rows,
    financial: financial.rows[0],
  };
}

test(
  "disposable PostgreSQL certifies atomic professional Complete Work authority",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations[74].filename, "202608310001_create_business_job_customer_message_authority.sql");
      assert.equal(migrations[80].filename, "202609020006_generalize_work_preparation_execution_approval.sql");
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length + migrated.skipped.length, migrations.length);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, suffix);
      const quote = await createApprovedQuote(pool, identities, fixture, suffix);
      const materialized = await command(
        materializeApprovedWorkExecution,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId, approvedCustomerDecisionId: quote.decisionId },
        `complete-work-execution-${suffix}`
      );
      assert.equal(materialized.ok, true, materialized.code);
      const execution = materialized.execution;

      const workstreamA = await createVisitWorkstream(pool, identities, fixture, `${suffix}-a`, 1);
      const workstreamB = await createVisitWorkstream(pool, identities, fixture, `${suffix}-b`, 2);
      const unrelatedWorkstream = await createVisitWorkstream(
        pool, identities, fixture, `${suffix}-unrelated`, 3
      );
      for (const [workstream, name] of [[workstreamA, "a"], [workstreamB, "b"]]) {
        const bound = await command(bindWorkstreamToExecution, pool, identities.professionalId, {
          jobId: fixture.jobId,
          executionId: execution.id,
          workstreamId: workstream.id,
          expectedExecutionVersion: execution.currentVersion,
        }, `complete-work-bind-${name}-${suffix}`);
        assert.equal(bound.ok, true, bound.code);
      }

      let doneActivity = await createActivity(
        pool, identities, fixture, workstreamA, `${suffix}-done`
      );
      doneActivity = await progress(
        pool, identities, fixture, workstreamA, doneActivity, "IN_PROGRESS", `${suffix}-done-start`
      );
      doneActivity = await progress(
        pool, identities, fixture, workstreamA, doneActivity, "DONE", `${suffix}-done-finish`
      );
      await classify(
        pool, identities, fixture, execution, workstreamA, doneActivity, `${suffix}-done`
      );

      let activeActivity = await createActivity(
        pool, identities, fixture, workstreamA, `${suffix}-active`
      );
      await classify(
        pool, identities, fixture, execution, workstreamA, activeActivity, `${suffix}-active`
      );
      const plannedActivity = await createActivity(
        pool, identities, fixture, workstreamB, `${suffix}-planned`
      );
      await classify(
        pool, identities, fixture, execution, workstreamB, plannedActivity, `${suffix}-planned`
      );
      const nonExecutionActivity = await createActivity(
        pool, identities, fixture, workstreamB, `${suffix}-administrative`
      );
      await classify(
        pool, identities, fixture, execution, workstreamB, nonExecutionActivity,
        `${suffix}-administrative`, "NON_EXECUTION"
      );
      const unrelatedActivity = await createActivity(
        pool, identities, fixture, unrelatedWorkstream, `${suffix}-unrelated`
      );

      const deposit = await command(
        materializePreWorkDepositObligation,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId },
        `complete-work-deposit-${suffix}`
      );
      assert.equal(deposit.deposit.requiredMinor, 51000);
      const satisfied = await command(confirmDepositReceived, pool, identities.professionalId, {
        jobId: fixture.jobId,
        amountMinor: 51000,
        currency: "USD",
        normalizedMethod: "BUSINESS_TRANSFER_APP",
        displayMethod: "Business transfer app",
        receivedAt: new Date(Date.now() - 60000).toISOString(),
        expectedVersion: 1,
        externalReference: `complete-work-deposit-${suffix}`,
      }, `complete-work-deposit-received-${suffix}`);
      assert.equal(satisfied.deposit.state, "SATISFIED");

      const plan = await command(materializeWorkPreparation, pool, identities.professionalId, {
        jobId: fixture.jobId,
        approvedCustomerDecisionId: quote.decisionId,
      }, `complete-work-plan-${suffix}`);
      assert.equal(plan.ok, true, plan.code);
      const readyPlan = await command(reviseWorkPreparation, pool, identities.professionalId, {
        jobId: fixture.jobId,
        planId: plan.workPreparation.id,
        expectedVersion: 1,
        planningState: "PLANNED",
        workStartPolicy: "NONE",
        internalNotes: null,
        items: [],
      }, `complete-work-plan-ready-${suffix}`);
      assert.equal(readyPlan.ok, true, readyPlan.code);

      const expectedWorkstreams = [workstreamA, workstreamB].map((workstream) => ({
        workstreamId: workstream.id,
        expectedVersion: 1,
      }));
      const neverStarted = await command(completeApprovedWork, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        expectedExecutionVersion: 1,
        expectedWorkstreams,
        expectedActivities: [
          { activityId: doneActivity.id, expectedVersion: 3 },
          { activityId: activeActivity.id, expectedVersion: 1 },
          { activityId: plannedActivity.id, expectedVersion: 1 },
        ],
      }, `complete-work-never-started-${suffix}`);
      assert.equal(neverStarted.code, "APPROVED_WORK_NOT_STARTED");

      const started = await command(progressWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: workstreamA.id,
        activityId: activeActivity.id,
        expectedVersion: 1,
        targetStatus: "IN_PROGRESS",
        approvedWorkExecutionId: execution.id,
        expectedExecutionVersion: 1,
      }, `complete-work-start-${suffix}`);
      assert.equal(started.ok, true, started.code);
      assert.equal(started.approvedWorkStartEvent.sourceType, "EXECUTION_ACTIVITY");
      activeActivity = started.activity;

      activeActivity = await progress(
        pool, identities, fixture, workstreamA, activeActivity, "DONE", `${suffix}-active-finish`
      );
      const expectedActivities = [
        { activityId: doneActivity.id, expectedVersion: 3 },
        { activityId: activeActivity.id, expectedVersion: 3 },
        { activityId: plannedActivity.id, expectedVersion: 1 },
      ];

      const activeProjection = await getCanonicalLiveJob({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        logger: quiet,
      });
      assert.equal(activeProjection.ok, true, activeProjection.code);
      assert.equal(activeProjection.liveJob.stage.code, "WORK_IN_PROGRESS");
      assert.deepEqual(activeProjection.liveJob.reasonCodes, [
        "APPROVED_WORK_EXECUTION_STARTED",
      ]);
      const activeExecution = await getApprovedWorkExecution({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        executionId: execution.id,
        logger: quiet,
      });
      assert.equal(activeExecution.ok, true, activeExecution.code);
      assert.equal(activeExecution.execution.state, "ACTIVE");
      assert.equal(activeExecution.execution.startEvents.count, 1);
      assert.equal(activeExecution.execution.safeNextActions.includes("COMPLETE_WORK"), true);
      assert.equal(activeExecution.execution.safeNextActions.includes("START_WORK"), false);
      const preCompletionFinancial = await latestTruth(
        pool,
        fixture,
        execution,
        [doneActivity.id, activeActivity.id, plannedActivity.id],
        [workstreamA.id, workstreamB.id]
      );
      assert.deepEqual(preCompletionFinancial.workstreams.map((row) => row.state), ["OPEN", "OPEN"]);
      assert.deepEqual(
        preCompletionFinancial.activities.map((row) => row.status).sort(),
        ["DONE", "DONE", "PLANNED"]
      );
      assert.deepEqual(preCompletionFinancial.financial, {
        invoices: 0,
        invoice_payments: 0,
        job_completions: 0,
      });

      const wrongProfessional = await command(
        completeApprovedWork,
        pool,
        identities.outsiderId,
        {
          jobId: fixture.jobId,
          executionId: execution.id,
          expectedExecutionVersion: 1,
          expectedWorkstreams,
          expectedActivities,
        },
        `complete-work-wrong-professional-${suffix}`
      );
      assert.equal(wrongProfessional.code, "APPROVED_WORK_EXECUTION_UNAVAILABLE");

      const obligation = await command(createWorkObligation, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: workstreamA.id,
        sequence: 1,
        statement: "Resolve the exact completion blocker.",
      }, `complete-work-obligation-${suffix}`);
      assert.equal(obligation.ok, true, obligation.code);
      const beforeBlocked = await latestTruth(
        pool,
        fixture,
        execution,
        [doneActivity.id, activeActivity.id, plannedActivity.id],
        [workstreamA.id, workstreamB.id]
      );
      const blocked = await command(completeApprovedWork, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        expectedExecutionVersion: 1,
        expectedWorkstreams,
        expectedActivities,
      }, `complete-work-blocked-${suffix}`);
      assert.equal(blocked.code, "APPROVED_WORK_COMPLETION_BLOCKED");
      assert.deepEqual(blocked.reasons, ["OPEN_OBLIGATION"]);
      assert.deepEqual(await latestTruth(
        pool,
        fixture,
        execution,
        [doneActivity.id, activeActivity.id, plannedActivity.id],
        [workstreamA.id, workstreamB.id]
      ), beforeBlocked);
      const resolved = await command(transitionWorkObligation, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: workstreamA.id,
        obligationId: obligation.obligation.id,
        expectedVersion: 1,
        targetStatus: "SATISFIED",
      }, `complete-work-obligation-resolved-${suffix}`);
      assert.equal(resolved.ok, true, resolved.code);

      const stale = await command(completeApprovedWork, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        expectedExecutionVersion: 1,
        expectedWorkstreams,
        expectedActivities: expectedActivities.map((entry, index) => index === 2
          ? { ...entry, expectedVersion: 99 }
          : entry),
      }, `complete-work-stale-${suffix}`);
      assert.equal(stale.code, "STALE_APPROVED_WORK_COMPLETION_SNAPSHOT");

      const beforeRollback = await latestTruth(
        pool,
        fixture,
        execution,
        [doneActivity.id, activeActivity.id, plannedActivity.id],
        [workstreamA.id, workstreamB.id]
      );
      await assert.rejects(
        command(completeApprovedWork, pool, identities.professionalId, {
          jobId: fixture.jobId,
          executionId: execution.id,
          expectedExecutionVersion: 1,
          expectedWorkstreams,
          expectedActivities,
          failureInjector(stage) {
            if (stage === "after_workstream_reconciliation") {
              throw new Error("synthetic completion failure");
            }
          },
        }, `complete-work-rollback-${suffix}`),
        /synthetic completion failure/
      );
      assert.deepEqual(await latestTruth(
        pool,
        fixture,
        execution,
        [doneActivity.id, activeActivity.id, plannedActivity.id],
        [workstreamA.id, workstreamB.id]
      ), beforeRollback);

      const completionKey = `complete-work-success-${suffix}`;
      const completed = await command(completeApprovedWork, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        expectedExecutionVersion: 1,
        expectedWorkstreams,
        expectedActivities,
      }, completionKey);
      assert.equal(completed.ok, true, completed.code);
      assert.equal(completed.code, "APPROVED_WORK_COMPLETED");
      assert.equal(completed.completion.state, "WORK_COMPLETED");
      assert.equal(completed.completion.executionVersion, 2);
      assert.equal(completed.completion.nextAction.code, "READY_TO_INVOICE");
      assert.equal(completed.completion.startEvidence.count, 1);
      const reconciliationByActivity = new Map(
        completed.completion.activities.map((activity) => [activity.activityId, activity])
      );
      assert.deepEqual(
        [doneActivity.id, activeActivity.id, plannedActivity.id].map((id) => ({
          fromVersion: reconciliationByActivity.get(id).fromVersion,
          toVersion: reconciliationByActivity.get(id).toVersion,
          changed: reconciliationByActivity.get(id).changed,
        })),
        [
          { fromVersion: 3, toVersion: 3, changed: false },
          { fromVersion: 3, toVersion: 3, changed: false },
          { fromVersion: 1, toVersion: 2, changed: true },
        ]
      );

      const replayed = await command(completeApprovedWork, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        expectedExecutionVersion: 1,
        expectedWorkstreams,
        expectedActivities,
      }, completionKey);
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.completion.evidence.commandId, completed.completion.evidence.commandId);
      const conflict = await command(completeApprovedWork, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        expectedExecutionVersion: 1,
        expectedWorkstreams: expectedWorkstreams.map((entry, index) => index === 0
          ? { ...entry, expectedVersion: 2 }
          : entry),
        expectedActivities,
      }, completionKey);
      assert.equal(conflict.code, "APPROVED_WORK_EXECUTION_IDEMPOTENCY_CONFLICT");
      const terminal = await command(completeApprovedWork, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: execution.id,
        expectedExecutionVersion: 2,
        expectedWorkstreams: expectedWorkstreams.map((entry) => ({
          ...entry,
          expectedVersion: 2,
        })),
        expectedActivities: expectedActivities.map((entry) => ({
          ...entry,
          expectedVersion: entry.expectedVersion === 3 ? 3 : entry.expectedVersion + 1,
        })),
      }, `complete-work-terminal-${suffix}`);
      assert.equal(terminal.code, "APPROVED_WORK_EXECUTION_NOT_ACTIVE");

      const finalTruth = await latestTruth(
        pool,
        fixture,
        execution,
        [
          doneActivity.id,
          activeActivity.id,
          plannedActivity.id,
          nonExecutionActivity.id,
          unrelatedActivity.id,
        ],
        [workstreamA.id, workstreamB.id, unrelatedWorkstream.id]
      );
      assert.deepEqual(finalTruth.execution, { version: 2, state: "CLOSED" });
      const activitiesById = new Map(finalTruth.activities.map((row) => [row.id, row]));
      assert.deepEqual(
        [doneActivity.id, activeActivity.id, plannedActivity.id].map((id) => ({
          version: Number(activitiesById.get(id).version),
          status: activitiesById.get(id).status,
        })),
        [
          { version: 3, status: "DONE" },
          { version: 3, status: "DONE" },
          { version: 2, status: "DONE" },
        ]
      );
      assert.deepEqual({
        version: Number(activitiesById.get(nonExecutionActivity.id).version),
        status: activitiesById.get(nonExecutionActivity.id).status,
      }, { version: 1, status: "PLANNED" });
      assert.deepEqual({
        version: Number(activitiesById.get(unrelatedActivity.id).version),
        status: activitiesById.get(unrelatedActivity.id).status,
      }, { version: 1, status: "PLANNED" });
      const workstreamsById = new Map(finalTruth.workstreams.map((row) => [row.id, row]));
      for (const id of [workstreamA.id, workstreamB.id]) {
        assert.deepEqual({
          version: Number(workstreamsById.get(id).version),
          state: workstreamsById.get(id).state,
        }, { version: 2, state: "COMPLETED" });
      }
      assert.deepEqual({
        version: Number(workstreamsById.get(unrelatedWorkstream.id).version),
        state: workstreamsById.get(unrelatedWorkstream.id).state,
      }, { version: 1, state: "OPEN" });
      assert.deepEqual(finalTruth.financial, {
        invoices: 0,
        invoice_payments: 0,
        job_completions: 0,
      });

      const live = await getCanonicalLiveJob({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        logger: quiet,
      });
      assert.equal(live.ok, true, live.code);
      assert.equal(live.liveJob.stage.code, "WORK_COMPLETED");
      assert.equal(live.liveJob.nextAction.code, "READY_TO_INVOICE");
      assert.equal(
        live.liveJob.availableActions.some((action) => action.code === "VIEW_JOB_HISTORY"),
        false
      );
      const invoiceWorkspace = await getProfessionalInvoiceWorkspace({
        pool,
        authenticatedActor: { id: identities.professionalId },
        logger: quiet,
      });
      assert.equal(invoiceWorkspace.ok, true, invoiceWorkspace.code);
      const readyJob = invoiceWorkspace.workspace.readyJobs.find(
        (job) => job.jobId === fixture.jobId
      );
      assert.equal(readyJob.completionVersion, 2);
      assert.deepEqual(readyJob.approvedAmount, { currency: "USD", totalMinor: 68000 });
      assert.equal(invoiceWorkspace.workspace.invoices.length, 0);
    } finally {
      await pool.end();
    }
  }
);
