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
  createDerivedDraftQuote,
  declineIssuedQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  completeEvaluation,
} = require("../server/authorization/evaluationService");
const {
  sendQuoteInMeetro,
} = require("../server/authorization/quoteDeliveryService");
const {
  createWorkActivity,
  progressWorkActivity,
} = require("../server/workflow/workstreamService");
const {
  bindWorkstreamToExecution,
  classifyWorkActivity,
  closeApprovedWorkExecution,
  getApprovedWorkExecution,
  listApprovedWorkExecutions,
  materializeApprovedWorkExecution,
  reconcileLegacyExecution,
  supersedeApprovedWorkExecution,
} = require("../server/workflow/approvedWorkExecutionService");
const {
  materializeWorkPreparation,
  reviseWorkPreparation,
} = require("../server/workflow/workPreparationService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.APPROVED_WORK_EXECUTION_RUNTIME_DATABASE_URL;

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

async function createQuoteSource(pool, identities, fixture, suffix, {
  parent = null,
  decision = "APPROVED",
  deliver = true,
} = {}) {
  await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const created = parent
    ? await command(createDerivedDraftQuote, pool, identities.professionalId, {
      parentQuoteId: parent.quoteId,
      expectedIssuedVersion: parent.issuedVersion,
      lineageType: "SUPPLEMENTAL_QUOTE",
      reasonCategory: "SUPPLEMENTAL_WORK",
    }, `execution-runtime-derived-${suffix}`)
    : await command(createDraftQuote, pool, identities.professionalId, {
      jobId: fixture.jobId,
      currency: "USD",
    }, `execution-runtime-create-${suffix}`);
  assert.equal(created.ok, true, created.code);
  const included = await command(addDraftScopeItem, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: created.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: `Approved cabinet repair ${suffix}`,
      quantity: 1,
      unitAmountMinor: 68000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
  }, `execution-runtime-included-${suffix}`);
  assert.equal(included.ok, true, included.code);
  const excluded = await command(addDraftScopeItem, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: included.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "SEPARATE_PROPOSAL",
      materialResponsibility: "NOT_APPLICABLE",
      description: `Excluded future option ${suffix}`,
      quantity: 1,
      unitAmountMinor: 12000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
  }, `execution-runtime-excluded-${suffix}`);
  assert.equal(excluded.ok, true, excluded.code);
  const issued = await command(issueQuote, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: excluded.quote.currentVersion,
  }, `execution-runtime-issue-${suffix}`);
  assert.equal(issued.ok, true, issued.code);
  if (deliver) {
    const delivered = await command(sendQuoteInMeetro, pool, identities.professionalId, {
      quoteId: issued.quote.id,
      expectedIssuedVersion: issued.quote.currentVersion,
    }, `execution-runtime-deliver-${suffix}`);
    assert.equal(delivered.ok, true, delivered.code);
  }
  let decisionResult = null;
  if (decision === "APPROVED") {
    decisionResult = await command(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.quote.id,
      expectedIssuedVersion: issued.quote.currentVersion,
    }, `execution-runtime-approve-${suffix}`);
  } else if (decision === "DECLINED") {
    decisionResult = await command(declineIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.quote.id,
      expectedIssuedVersion: issued.quote.currentVersion,
    }, `execution-runtime-decline-${suffix}`);
  }
  if (decisionResult) assert.equal(decisionResult.ok, true, decisionResult.code);
  const source = await pool.query(
    `SELECT decisions.id AS decision_id, decisions.decision,
      snapshots.scope_item_id, snapshots.included_in_total
     FROM canonical_quotes quotes
     LEFT JOIN canonical_quote_customer_decisions decisions
       ON decisions.quote_id = quotes.id
     INNER JOIN canonical_quote_scope_item_snapshots snapshots
       ON snapshots.quote_id = quotes.id
       AND snapshots.quote_version = $2
     WHERE quotes.id = $1
     ORDER BY snapshots.included_in_total DESC, snapshots.sequence`,
    [issued.quote.id, issued.quote.currentVersion]
  );
  return {
    quoteId: issued.quote.id,
    issuedVersion: issued.quote.currentVersion,
    decisionId: source.rows[0]?.decision_id || null,
    decision: source.rows[0]?.decision || null,
    includedScopeItemId: source.rows.find((row) => row.included_in_total === true)?.scope_item_id,
    excludedScopeItemId: source.rows.find((row) => row.included_in_total === false)?.scope_item_id,
  };
}

async function createActivity(pool, identities, fixture, workstreamId, suffix) {
  const result = await command(createWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId,
    activityType: "REPAIR",
    statement: `Explicit execution Activity ${suffix}`,
    customerVisible: false,
  }, `execution-runtime-activity-${suffix}`);
  assert.equal(result.ok, true, result.code);
  return result.activity;
}

async function counts(pool) {
  const result = await pool.query(
    `SELECT
      (SELECT count(*)::integer FROM canonical_quote_scope_item_snapshots) AS quote_scope,
      (SELECT count(*)::integer FROM canonical_invoices) AS invoices,
      (SELECT count(*)::integer FROM canonical_pre_work_payment_receipts) AS payments,
      (SELECT count(*)::integer FROM canonical_visits) AS visits,
      (SELECT count(*)::integer FROM canonical_approved_work_execution_start_events) AS starts`
  );
  return result.rows[0];
}

test(
  "disposable PostgreSQL certifies Approved Work execution runtime authority",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID().slice(0, 8);
    try {
      const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300003_add_professional_subscription_plan.sql");
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, migrations.length);

      const identities = await createVisitTestIdentities(pool, `${suffix}-primary`);
      const fixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-primary`);
      const evaluation = await ensureVisitEvaluation(
        pool,
        identities,
        fixture,
        `${suffix}-primary`
      );
      const completedEvaluation = await command(
        completeEvaluation,
        pool,
        identities.professionalId,
        {
          evaluationId: evaluation.id,
          expectedVersion: 1,
          completionMode: "REMOTE",
          assessmentMethod: "PHONE",
          assessmentBasis: "Reviewed the Approved Work execution runtime fixture.",
        },
        `execution-runtime-evaluation-${suffix}`
      );
      assert.equal(completedEvaluation.ok, true, completedEvaluation.code);
      const primary = await createQuoteSource(pool, identities, fixture, `${suffix}-primary`);
      const successor = await createQuoteSource(pool, identities, fixture, `${suffix}-successor`, {
        parent: primary,
      });
      const declined = await createQuoteSource(pool, identities, fixture, `${suffix}-declined`, {
        parent: primary,
        decision: "DECLINED",
      });
      const issuedOnly = await createQuoteSource(pool, identities, fixture, `${suffix}-issued`, {
        parent: primary,
        decision: null,
        deliver: false,
      });
      const deliveredOnly = await createQuoteSource(pool, identities, fixture, `${suffix}-delivered`, {
        parent: primary,
        decision: null,
        deliver: true,
      });

      const crossIdentities = await createVisitTestIdentities(pool, `${suffix}-cross`);
      const crossFixture = await createVisitLifecycleFixture(
        pool,
        crossIdentities,
        `${suffix}-cross`
      );
      const crossEvaluation = await ensureVisitEvaluation(
        pool,
        crossIdentities,
        crossFixture,
        `${suffix}-cross`
      );
      const crossCompleted = await command(
        completeEvaluation,
        pool,
        crossIdentities.professionalId,
        {
          evaluationId: crossEvaluation.id,
          expectedVersion: 1,
          completionMode: "REMOTE",
          assessmentMethod: "PHONE",
          assessmentBasis: "Reviewed the cross-Job execution fixture.",
        },
        `execution-runtime-cross-evaluation-${suffix}`
      );
      assert.equal(crossCompleted.ok, true, crossCompleted.code);
      const cross = await createQuoteSource(
        pool,
        crossIdentities,
        crossFixture,
        `${suffix}-cross`
      );

      const beforeExecution = await counts(pool);
      const emptyRead = await listApprovedWorkExecutions({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        logger: quiet,
      });
      assert.equal(emptyRead.ok, true, emptyRead.code);
      assert.deepEqual(emptyRead.executions, []);
      assert.equal(Number((await pool.query(
        "SELECT count(*) FROM canonical_approved_work_executions"
      )).rows[0].count), 0);

      const materializeKey = `execution-runtime-materialize-${suffix}`;
      const materialized = await command(
        materializeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          approvedCustomerDecisionId: primary.decisionId,
        },
        materializeKey
      );
      assert.equal(materialized.ok, true, materialized.code);
      assert.equal(materialized.execution.state, "ACTIVE");
      assert.equal(materialized.execution.currentVersion, 1);
      assert.deepEqual(materialized.execution.safeNextActions, [
        "BIND_WORKSTREAM",
        "CLASSIFY_ACTIVITY",
        "RECONCILE_LEGACY",
        "COMPLETE_WORK",
        "SUPERSEDE",
      ]);
      const replayed = await command(
        materializeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          approvedCustomerDecisionId: primary.decisionId,
        },
        materializeKey
      );
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.execution.id, materialized.execution.id);
      const duplicate = await command(
        materializeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          approvedCustomerDecisionId: primary.decisionId,
        },
        `execution-runtime-materialize-duplicate-${suffix}`
      );
      assert.equal(duplicate.code, "APPROVED_WORK_EXECUTION_ALREADY_EXISTS");

      for (const invalid of [
        { jobId: fixture.jobId, approvedCustomerDecisionId: declined.decisionId },
        { jobId: fixture.jobId, approvedCustomerDecisionId: issuedOnly.quoteId },
        { jobId: fixture.jobId, approvedCustomerDecisionId: deliveredOnly.quoteId },
        { jobId: fixture.jobId, approvedCustomerDecisionId: cross.decisionId },
      ]) {
        const rejected = await command(
          materializeApprovedWorkExecution,
          pool,
          identities.professionalId,
          invalid,
          `execution-runtime-invalid-${randomUUID()}`
        );
        assert.equal(rejected.code, "APPROVED_WORK_EXECUTION_UNAVAILABLE");
      }
      const foreign = await command(
        materializeApprovedWorkExecution,
        pool,
        crossIdentities.professionalId,
        { jobId: fixture.jobId, approvedCustomerDecisionId: primary.decisionId },
        `execution-runtime-foreign-${suffix}`
      );
      assert.equal(foreign.code, "APPROVED_WORK_EXECUTION_UNAVAILABLE");
      const serverField = await materializeApprovedWorkExecution({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        approvedCustomerDecisionId: primary.decisionId,
        issuedQuoteVersion: 999,
        idempotencyKey: randomUUID(),
      });
      assert.equal(serverField.code, "APPROVED_WORK_EXECUTION_FIELD_REJECTED");

      const successorMaterialized = await command(
        materializeApprovedWorkExecution,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId, approvedCustomerDecisionId: successor.decisionId },
        `execution-runtime-successor-${suffix}`
      );
      assert.equal(successorMaterialized.ok, true, successorMaterialized.code);

      const workstream1 = await createVisitWorkstream(pool, identities, fixture, `${suffix}-one`, 1);
      const workstream2 = await createVisitWorkstream(pool, identities, fixture, `${suffix}-two`, 2);
      const workstream3 = await createVisitWorkstream(pool, identities, fixture, `${suffix}-three`, 3);
      const bindingKey = `execution-runtime-binding-${suffix}`;
      const binding1 = await command(bindWorkstreamToExecution, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream1.id,
        expectedExecutionVersion: 1,
      }, bindingKey);
      assert.equal(binding1.ok, true, binding1.code);
      assert.equal(binding1.binding.workstream.state, workstream1.state);
      assert.equal((await command(bindWorkstreamToExecution, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream1.id,
        expectedExecutionVersion: 1,
      }, bindingKey)).replayed, true);
      assert.equal((await command(bindWorkstreamToExecution, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream2.id,
        expectedExecutionVersion: 1,
      }, `execution-runtime-binding-two-${suffix}`)).ok, true);
      const otherBinding = await command(
        bindWorkstreamToExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: successorMaterialized.execution.id,
          workstreamId: workstream1.id,
          expectedExecutionVersion: 1,
        },
        `execution-runtime-binding-other-${suffix}`
      );
      assert.equal(otherBinding.code, "WORKSTREAM_BOUND_TO_OTHER_EXECUTION");

      const administrative = await createActivity(
        pool, identities, fixture, workstream1.id, `${suffix}-administrative`
      );
      const repair = await createActivity(pool, identities, fixture, workstream1.id, `${suffix}-repair`);
      const scoped = await createActivity(pool, identities, fixture, workstream2.id, `${suffix}-scoped`);
      const rejectedScope = await createActivity(
        pool, identities, fixture, workstream2.id, `${suffix}-excluded-scope`
      );
      const crossVersionScope = await createActivity(
        pool, identities, fixture, workstream2.id, `${suffix}-cross-version-scope`
      );
      const unbound = await createActivity(pool, identities, fixture, workstream3.id, `${suffix}-unbound`);

      const nonExecution = await command(classifyWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream1.id,
        activityId: administrative.id,
        expectedExecutionVersion: 1,
        expectedActivityVersion: administrative.currentVersion,
        classification: "NON_EXECUTION",
      }, `execution-runtime-non-execution-${suffix}`);
      assert.equal(nonExecution.ok, true, nonExecution.code);
      assert.equal(nonExecution.classification.executionId, null);
      assert.equal(nonExecution.classification.scopeBasis, null);
      assert.equal(nonExecution.classification.activity.status, administrative.status);

      const decisionWideKey = `execution-runtime-decision-wide-${suffix}`;
      const decisionWide = await command(classifyWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream1.id,
        activityId: repair.id,
        expectedExecutionVersion: 1,
        expectedActivityVersion: repair.currentVersion,
        classification: "EXECUTION",
        scopeBasis: "DECISION_WIDE",
      }, decisionWideKey);
      assert.equal(decisionWide.ok, true, decisionWide.code);
      assert.equal(decisionWide.classification.sourceScopeItemId, null);
      assert.equal((await command(classifyWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream1.id,
        activityId: repair.id,
        expectedExecutionVersion: 1,
        expectedActivityVersion: repair.currentVersion,
        classification: "EXECUTION",
        scopeBasis: "DECISION_WIDE",
      }, decisionWideKey)).replayed, true);
      const idempotencyConflict = await command(
        classifyWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: materialized.execution.id,
          workstreamId: workstream1.id,
          activityId: repair.id,
          expectedExecutionVersion: 1,
          expectedActivityVersion: repair.currentVersion,
          classification: "NON_EXECUTION",
        },
        decisionWideKey
      );
      assert.equal(
        idempotencyConflict.code,
        "APPROVED_WORK_EXECUTION_IDEMPOTENCY_CONFLICT"
      );
      const exactScope = await command(classifyWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream2.id,
        activityId: scoped.id,
        expectedExecutionVersion: 1,
        expectedActivityVersion: scoped.currentVersion,
        classification: "EXECUTION",
        scopeBasis: "QUOTE_SCOPE_ITEM",
        sourceScopeItemId: primary.includedScopeItemId,
      }, `execution-runtime-exact-scope-${suffix}`);
      assert.equal(exactScope.ok, true, exactScope.code);
      const excluded = await command(classifyWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream2.id,
        activityId: rejectedScope.id,
        expectedExecutionVersion: 1,
        expectedActivityVersion: rejectedScope.currentVersion,
        classification: "EXECUTION",
        scopeBasis: "QUOTE_SCOPE_ITEM",
        sourceScopeItemId: primary.excludedScopeItemId,
      }, `execution-runtime-excluded-scope-${suffix}`);
      assert.equal(excluded.code, "APPROVED_WORK_SCOPE_ITEM_UNAVAILABLE");
      const crossVersion = await command(classifyWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream2.id,
        activityId: crossVersionScope.id,
        expectedExecutionVersion: 1,
        expectedActivityVersion: crossVersionScope.currentVersion,
        classification: "EXECUTION",
        scopeBasis: "QUOTE_SCOPE_ITEM",
        sourceScopeItemId: successor.includedScopeItemId,
      }, `execution-runtime-cross-version-scope-${suffix}`);
      assert.equal(crossVersion.code, "APPROVED_WORK_SCOPE_ITEM_UNAVAILABLE");
      const unboundRejected = await command(classifyWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        workstreamId: workstream3.id,
        activityId: unbound.id,
        expectedExecutionVersion: 1,
        expectedActivityVersion: unbound.currentVersion,
        classification: "EXECUTION",
        scopeBasis: "DECISION_WIDE",
      }, `execution-runtime-unbound-${suffix}`);
      assert.equal(unboundRejected.code, "WORKSTREAM_EXECUTION_BINDING_REQUIRED");
      const duplicateClassification = await command(
        classifyWorkActivity,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: materialized.execution.id,
          workstreamId: workstream1.id,
          activityId: repair.id,
          expectedExecutionVersion: 1,
          expectedActivityVersion: repair.currentVersion,
          classification: "NON_EXECUTION",
        },
        `execution-runtime-duplicate-classification-${suffix}`
      );
      assert.equal(duplicateClassification.code, "WORK_ACTIVITY_ALREADY_CLASSIFIED");

      const legacyWorkstream = await createVisitWorkstream(
        pool, identities, fixture, `${suffix}-legacy`, 4
      );
      let legacyProgress = await createActivity(
        pool, identities, fixture, legacyWorkstream.id, `${suffix}-legacy-progress`
      );
      let legacyDone = await createActivity(
        pool, identities, fixture, legacyWorkstream.id, `${suffix}-legacy-done`
      );
      legacyProgress = (await command(progressWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: legacyWorkstream.id,
        activityId: legacyProgress.id,
        expectedVersion: legacyProgress.currentVersion,
        targetStatus: "IN_PROGRESS",
      }, `execution-runtime-progress-${suffix}`)).activity;
      legacyDone = (await command(progressWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: legacyWorkstream.id,
        activityId: legacyDone.id,
        expectedVersion: legacyDone.currentVersion,
        targetStatus: "IN_PROGRESS",
      }, `execution-runtime-done-start-${suffix}`)).activity;
      legacyDone = (await command(progressWorkActivity, pool, identities.professionalId, {
        jobId: fixture.jobId,
        workstreamId: legacyWorkstream.id,
        activityId: legacyDone.id,
        expectedVersion: legacyDone.currentVersion,
        targetStatus: "DONE",
      }, `execution-runtime-done-finish-${suffix}`)).activity;
      const reconciliationKey = `execution-runtime-reconcile-${suffix}`;
      const reconciliation = await command(
        reconcileLegacyExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: materialized.execution.id,
          workstreamId: legacyWorkstream.id,
          expectedExecutionVersion: 1,
          reason: "Professional explicitly confirmed historical cabinet execution lineage.",
          bindWorkstream: true,
          activities: [
            {
              activityId: legacyProgress.id,
              expectedActivityVersion: legacyProgress.currentVersion,
              classification: "EXECUTION",
              scopeBasis: "DECISION_WIDE",
            },
            {
              activityId: legacyDone.id,
              expectedActivityVersion: legacyDone.currentVersion,
              classification: "NON_EXECUTION",
            },
          ],
        },
        reconciliationKey
      );
      assert.equal(reconciliation.ok, true, reconciliation.code);
      assert.equal(reconciliation.reconciliation.startEventsCreated, 0);
      assert.deepEqual(
        reconciliation.reconciliation.classifications.map((row) => row.activity.status),
        ["IN_PROGRESS", "DONE"]
      );
      assert.equal((await command(
        reconcileLegacyExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: materialized.execution.id,
          workstreamId: legacyWorkstream.id,
          expectedExecutionVersion: 1,
          reason: "Professional explicitly confirmed historical cabinet execution lineage.",
          bindWorkstream: true,
          activities: [
            {
              activityId: legacyProgress.id,
              expectedActivityVersion: legacyProgress.currentVersion,
              classification: "EXECUTION",
              scopeBasis: "DECISION_WIDE",
            },
            {
              activityId: legacyDone.id,
              expectedActivityVersion: legacyDone.currentVersion,
              classification: "NON_EXECUTION",
            },
          ],
        },
        reconciliationKey
      )).replayed, true);
      assert.equal(Number((await pool.query(
        "SELECT count(*) FROM canonical_approved_work_execution_start_events"
      )).rows[0].count), 0);

      const selfSuccessor = await command(
        supersedeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: materialized.execution.id,
          expectedVersion: 1,
          successorExecutionId: materialized.execution.id,
        },
        `execution-runtime-self-successor-${suffix}`
      );
      assert.equal(selfSuccessor.code, "INVALID_APPROVED_WORK_EXECUTION_TRANSITION");

      const superseded = await command(
        supersedeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: materialized.execution.id,
          expectedVersion: 1,
          successorExecutionId: successorMaterialized.execution.id,
        },
        `execution-runtime-supersede-${suffix}`
      );
      assert.equal(superseded.ok, true, superseded.code);
      assert.equal(superseded.execution.state, "SUPERSEDED");
      assert.equal(superseded.execution.currentVersion, 2);
      assert.equal(superseded.execution.boundWorkstreams.length, 3);
      const rejectedAfterSupersede = await command(
        bindWorkstreamToExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: materialized.execution.id,
          workstreamId: workstream3.id,
          expectedExecutionVersion: 2,
        },
        `execution-runtime-bind-superseded-${suffix}`
      );
      assert.equal(rejectedAfterSupersede.code, "APPROVED_WORK_EXECUTION_NOT_ACTIVE");
      const staleClose = await command(
        closeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: successorMaterialized.execution.id,
          expectedVersion: 9,
        },
        `execution-runtime-close-stale-${suffix}`
      );
      assert.equal(staleClose.code, "STALE_APPROVED_WORK_EXECUTION_VERSION");
      const closed = await command(
        closeApprovedWorkExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: successorMaterialized.execution.id,
          expectedVersion: 1,
        },
        `execution-runtime-close-${suffix}`
      );
      assert.equal(closed.ok, true, closed.code);
      assert.equal(closed.execution.state, "CLOSED");
      assert.deepEqual(closed.execution.safeNextActions, []);
      const closedBinding = await command(
        bindWorkstreamToExecution,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          executionId: successorMaterialized.execution.id,
          workstreamId: workstream3.id,
          expectedExecutionVersion: 2,
        },
        `execution-runtime-bind-closed-${suffix}`
      );
      assert.equal(closedBinding.code, "APPROVED_WORK_EXECUTION_NOT_ACTIVE");

      const detail = await getApprovedWorkExecution({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        executionId: materialized.execution.id,
        logger: quiet,
      });
      assert.equal(detail.ok, true, detail.code);
      assert.equal(detail.execution.startEvents.count, 0);
      assert.equal("sourceIntegrityHash" in detail.execution.source, false);
      assert.equal("requestFingerprint" in detail.execution, false);

      const afterExecution = await counts(pool);
      assert.deepEqual(afterExecution, beforeExecution);

      const prepared = await command(
        materializeWorkPreparation,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId, approvedCustomerDecisionId: primary.decisionId },
        `execution-runtime-preparation-${suffix}`
      );
      assert.equal(prepared.ok, true, prepared.code);
      const planId = prepared.workPreparation.id;
      const contradictory = await command(
        reviseWorkPreparation,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          planId,
          expectedVersion: 1,
          planningState: "PLANNED",
          workStartPolicy: "NONE",
          internalNotes: null,
          items: [{
            sequence: 1,
            kind: "MATERIAL",
            description: "Required operational fastener",
            quantity: 1,
            unit: "lot",
            providerResponsibility: "BUSINESS",
            commercialTreatment: "NOT_CUSTOMER_BILLABLE",
            visibility: "BUSINESS_ONLY",
            requiredForWorkStart: true,
            sourceLineage: "ACCEPTED_SCOPE_ELABORATION",
          }],
        },
        `execution-runtime-policy-invalid-${suffix}`
      );
      assert.equal(contradictory.code, "WORK_PREPARATION_POLICY_CONTRADICTION");
      const noneValid = await command(
        reviseWorkPreparation,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          planId,
          expectedVersion: 1,
          planningState: "PLANNED",
          workStartPolicy: "NONE",
          internalNotes: null,
          items: [],
        },
        `execution-runtime-policy-none-${suffix}`
      );
      assert.equal(noneValid.ok, true, noneValid.code);
      const requiredEmpty = await command(
        reviseWorkPreparation,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          planId,
          expectedVersion: 2,
          planningState: "PLANNED",
          workStartPolicy: "REQUIRED_ITEMS_READY",
          internalNotes: null,
          items: [],
        },
        `execution-runtime-policy-required-empty-${suffix}`
      );
      assert.equal(requiredEmpty.ok, true, requiredEmpty.code);
      const requiredValid = await command(
        reviseWorkPreparation,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          planId,
          expectedVersion: 3,
          planningState: "PLANNED",
          workStartPolicy: "REQUIRED_ITEMS_READY",
          internalNotes: null,
          items: [{
            sequence: 1,
            kind: "MATERIAL",
            description: "Required operational fastener",
            quantity: 1,
            unit: "lot",
            providerResponsibility: "BUSINESS",
            commercialTreatment: "NOT_CUSTOMER_BILLABLE",
            visibility: "BUSINESS_ONLY",
            requiredForWorkStart: true,
            sourceLineage: "ACCEPTED_SCOPE_ELABORATION",
          }],
        },
        `execution-runtime-policy-required-${suffix}`
      );
      assert.equal(requiredValid.ok, true, requiredValid.code);

      const replayMigrations = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata()
      );
      assert.equal(replayMigrations.success, true, JSON.stringify(replayMigrations));
      assert.equal(replayMigrations.skipped.length, migrations.length);
    } finally {
      await pool.end();
    }
  }
);
