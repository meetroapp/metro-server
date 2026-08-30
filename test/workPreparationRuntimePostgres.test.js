"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  ensureVisitEvaluation,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const { sendQuoteInMeetro } = require("../server/authorization/quoteDeliveryService");
const { completeEvaluation } = require("../server/authorization/evaluationService");
const {
  confirmDepositReceived,
  materializePreWorkDepositObligation,
  reverseDepositAllocation,
} = require("../server/finance/preWorkDepositService");
const {
  correctMaterialPurchase,
  evaluateWorkPreparationStartWithClient,
  getWorkPreparation,
  materializeWorkPreparation,
  recordMaterialPurchase,
  recordPreparationEvent,
  reviseWorkPreparation,
} = require("../server/workflow/workPreparationService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.WORK_PREPARATION_RUNTIME_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV }),
  };
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

async function createApprovedQuote(pool, identities, fixture, suffix, paymentTerms) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completed = await completeEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis: "Reviewed the synthetic Work Preparation runtime fixture by phone.",
    idempotencyKey: `work-prep-runtime-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(completed.ok, true, completed.code);
  const created = await createDraftQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    customerTermsSnapshot: terms(paymentTerms),
    idempotencyKey: `work-prep-runtime-quote-${suffix}`,
    logger: quiet,
  });
  assert.equal(created.ok, true, created.code);
  const scoped = await addDraftScopeItem({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: created.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: "Synthetic total-only accepted work",
      quantity: 1,
      unitAmountMinor: 68000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `work-prep-runtime-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `work-prep-runtime-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  const delivered = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `work-prep-runtime-deliver-${suffix}`,
    logger: quiet,
  });
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await approveIssuedQuote({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `work-prep-runtime-approve-${suffix}`,
    logger: quiet,
  });
  assert.equal(approved.ok, true, approved.code);
  return {
    decisionId: approved.customerDecision.id,
    quoteId: issued.quote.id,
    issuedVersion: issued.quote.currentVersion,
  };
}

function materialItem(description, overrides = {}) {
  return {
    sequence: 1,
    kind: "MATERIAL",
    description,
    quantity: 2,
    unit: "each",
    providerResponsibility: "BUSINESS",
    commercialTreatment: "NOT_CUSTOMER_BILLABLE",
    visibility: "BUSINESS_ONLY",
    requiredForWorkStart: true,
    internalEstimatedCostMinor: 20000,
    internalCostCurrency: "USD",
    sourceLineage: "ACCEPTED_SCOPE_ELABORATION",
    ...overrides,
  };
}

async function createPlan(pool, identities, fixture, quote, suffix, items, policy = "REQUIRED_ITEMS_READY") {
  const created = await materializeWorkPreparation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    approvedCustomerDecisionId: quote.decisionId,
    idempotencyKey: `work-prep-materialize-${suffix}`,
    logger: quiet,
  });
  assert.equal(created.ok, true, created.code);
  const replay = await materializeWorkPreparation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    approvedCustomerDecisionId: quote.decisionId,
    idempotencyKey: `work-prep-materialize-${suffix}`,
    logger: quiet,
  });
  assert.equal(replay.replayed, true);
  const revised = await reviseWorkPreparation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    planId: created.workPreparation.id,
    expectedVersion: 1,
    planningState: "PLANNED",
    workStartPolicy: policy,
    internalNotes: "Business-only preparation notes.",
    items,
    idempotencyKey: `work-prep-revise-${suffix}`,
    logger: quiet,
  });
  assert.equal(revised.ok, true, revised.code);
  return revised.workPreparation;
}

function purchase(pool, identities, fixture, plan, itemId, suffix) {
  return recordMaterialPurchase({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    planId: plan.id,
    itemId,
    expectedVersion: plan.currentVersion,
    quantity: 2,
    unit: "each",
    internalCostMinor: 20000,
    internalCostCurrency: "USD",
    vendor: "Runtime Fixture Vendor",
    purchasedAt: "2026-08-28T12:00:00.000Z",
    externalReference: `runtime-${suffix}`,
    visibility: "BUSINESS_ONLY",
    idempotencyKey: `work-prep-purchase-${suffix}`,
    logger: quiet,
  });
}

function event(pool, identities, fixture, plan, suffix, eventType, itemId = null) {
  return recordPreparationEvent({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    planId: plan.id,
    itemId,
    expectedVersion: plan.currentVersion,
    eventType,
    visibility: "BUSINESS_ONLY",
    internalNote: `Synthetic ${eventType} evidence.`,
    idempotencyKey: `work-prep-event-${suffix}-${eventType}-${itemId || "plan"}`,
    logger: quiet,
  });
}

function payment(pool, identities, fixture, values) {
  return confirmDepositReceived({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    normalizedMethod: "BUSINESS_TRANSFER_APP",
    displayMethod: "Business transfer app",
    receivedAt: new Date(Date.now() - 120000).toISOString(),
    logger: quiet,
    ...values,
  });
}

test(
  "disposable PostgreSQL certifies Work Preparation runtime, deposit commitment, replay, privacy, and readiness",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300003_add_professional_subscription_plan.sql");
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, migrations.length);

      const identities = await createVisitTestIdentities(pool, suffix);

      const noPlanFixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-no-plan`);
      const noPlanGate = await evaluateWorkPreparationStartWithClient({
        client: pool,
        jobId: noPlanFixture.jobId,
        approvedCustomerDecisionId: randomUUID(),
        lock: false,
      });
      assert.equal(noPlanGate.allowed, true);

      const dueFixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-due`);
      const dueQuote = await createApprovedQuote(
        pool,
        identities,
        dueFixture,
        `${suffix}-due`,
        "75% deposit; balance due on completion."
      );
      const beforeRead = await getWorkPreparation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: dueFixture.jobId,
      });
      assert.equal(beforeRead.workPreparation.exists, false);
      const beforeCount = await pool.query(
        `SELECT count(*)::integer AS count FROM canonical_work_preparation_plans WHERE job_id = $1`,
        [dueFixture.jobId]
      );
      assert.equal(beforeCount.rows[0].count, 0);

      const wrongActor = await materializeWorkPreparation({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: dueFixture.jobId,
        approvedCustomerDecisionId: dueQuote.decisionId,
        idempotencyKey: `work-prep-wrong-actor-${suffix}`,
      });
      assert.equal(wrongActor.code, "WORK_PREPARATION_UNAVAILABLE");

      const duePlan = await createPlan(
        pool,
        identities,
        dueFixture,
        dueQuote,
        `${suffix}-due`,
        [materialItem("Deposit-gated material")]
      );
      assert.equal(duePlan.deposit.state, "DUE");
      assert.equal(duePlan.currentVersion, 2);
      const stale = await reviseWorkPreparation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: dueFixture.jobId,
        planId: duePlan.id,
        expectedVersion: 1,
        planningState: "PLANNED",
        workStartPolicy: "NONE",
        internalNotes: null,
        items: [],
        idempotencyKey: `work-prep-stale-${suffix}`,
      });
      assert.equal(stale.code, "STALE_WORK_PREPARATION_VERSION");
      const dueItem = duePlan.items[0];
      const blockedPurchase = await purchase(
        pool,
        identities,
        dueFixture,
        duePlan,
        dueItem.id,
        `${suffix}-due`
      );
      assert.equal(blockedPurchase.code, "DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT");
      const blockedStage = await event(
        pool,
        identities,
        dueFixture,
        duePlan,
        `${suffix}-due`,
        "MATERIAL_STAGED",
        dueItem.id
      );
      assert.equal(blockedStage.code, "DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT");
      const noCommitment = await pool.query(
        `SELECT
          (SELECT count(*) FROM canonical_material_purchase_records WHERE job_id = $1)::integer AS purchases,
          (SELECT count(*) FROM canonical_work_preparation_events WHERE job_id = $1)::integer AS events`,
        [dueFixture.jobId]
      );
      assert.deepEqual(noCommitment.rows[0], { purchases: 0, events: 0 });

      const deposit = await materializePreWorkDepositObligation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: dueFixture.jobId,
        idempotencyKey: `work-prep-deposit-${suffix}`,
        logger: quiet,
      });
      assert.equal(deposit.deposit.state, "DUE");
      const partial = await payment(pool, identities, dueFixture, {
        amountMinor: 10000,
        expectedVersion: 1,
        externalReference: `work-prep-partial-${suffix}`,
        idempotencyKey: `work-prep-partial-${suffix}`,
      });
      assert.equal(partial.deposit.state, "PARTIALLY_SATISFIED");
      const partialBlocked = await purchase(
        pool,
        identities,
        dueFixture,
        duePlan,
        dueItem.id,
        `${suffix}-partial`
      );
      assert.equal(partialBlocked.code, "DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT");
      const satisfied = await payment(pool, identities, dueFixture, {
        amountMinor: 41000,
        expectedVersion: 2,
        externalReference: `work-prep-satisfied-${suffix}`,
        idempotencyKey: `work-prep-satisfied-${suffix}`,
      });
      assert.equal(satisfied.deposit.state, "SATISFIED");
      const purchased = await purchase(
        pool,
        identities,
        dueFixture,
        duePlan,
        dueItem.id,
        `${suffix}-satisfied`
      );
      assert.equal(purchased.code, "MATERIAL_PURCHASE_RECORDED");
      const replay = await purchase(
        pool,
        identities,
        dueFixture,
        duePlan,
        dueItem.id,
        `${suffix}-satisfied`
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.purchase.id, purchased.purchase.id);
      const afterPurchase = await getWorkPreparation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: dueFixture.jobId,
      });
      assert.equal(afterPurchase.workPreparation.readiness.acquisitionState, "PURCHASED");
      assert.equal(afterPurchase.workPreparation.readiness.workStartBlocked, true);
      assert.equal(afterPurchase.workPreparation.purchaseSummary.internalCostMinor, 20000);

      const correction = await correctMaterialPurchase({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: dueFixture.jobId,
        planId: duePlan.id,
        purchaseId: purchased.purchase.id,
        expectedVersion: 2,
        reversedQuantity: 0.5,
        reversedInternalCostMinor: 5000,
        reasonCategory: "RETURN",
        reason: "Returned one partial fixture quantity.",
        correctedAt: new Date(Date.now() - 30000).toISOString(),
        idempotencyKey: `work-prep-correction-${suffix}`,
      });
      assert.equal(correction.code, "MATERIAL_PURCHASE_CORRECTED");
      const original = await pool.query(
        `SELECT quantity, internal_cost_minor FROM canonical_material_purchase_records WHERE id = $1`,
        [purchased.purchase.id]
      );
      assert.deepEqual(original.rows[0], { quantity: "2.000", internal_cost_minor: "20000" });
      const overCorrection = await correctMaterialPurchase({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: dueFixture.jobId,
        planId: duePlan.id,
        purchaseId: purchased.purchase.id,
        expectedVersion: 2,
        reversedQuantity: 2,
        reversedInternalCostMinor: 0,
        reasonCategory: "RETURN",
        reason: "Invalid excess correction.",
        correctedAt: new Date(Date.now() - 20000).toISOString(),
        idempotencyKey: `work-prep-over-correction-${suffix}`,
      });
      assert.equal(overCorrection.ok, false);

      const staged = await event(
        pool,
        identities,
        dueFixture,
        duePlan,
        `${suffix}-staged`,
        "MATERIAL_STAGED",
        dueItem.id
      );
      assert.equal(staged.ok, true, staged.code);
      const readyGate = await evaluateWorkPreparationStartWithClient({
        client: pool,
        jobId: dueFixture.jobId,
        approvedCustomerDecisionId: dueQuote.decisionId,
      });
      assert.equal(readyGate.allowed, true);

      const reversed = await reverseDepositAllocation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: dueFixture.jobId,
        allocationId: satisfied.payment.allocationId,
        amountMinor: 1000,
        reasonCategory: "REFUND",
        reason: "Synthetic reversal relocks new commitments.",
        expectedVersion: 3,
        idempotencyKey: `work-prep-reversal-${suffix}`,
        logger: quiet,
      });
      assert.equal(reversed.deposit.state, "PARTIALLY_SATISFIED");
      const relocked = await event(
        pool,
        identities,
        dueFixture,
        duePlan,
        `${suffix}-relocked`,
        "PREPARATION_READY"
      );
      assert.equal(relocked.code, "DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT");

      const noDepositFixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-none`);
      const noDepositQuote = await createApprovedQuote(
        pool,
        identities,
        noDepositFixture,
        `${suffix}-none`,
        "Payment due on completion."
      );
      const noDepositPlan = await createPlan(
        pool,
        identities,
        noDepositFixture,
        noDepositQuote,
        `${suffix}-none`,
        [
          materialItem("Inventory material"),
          materialItem("Customer hardware", {
            sequence: 2,
            providerResponsibility: "CUSTOMER",
            commercialTreatment: "CUSTOMER_SUPPLIED",
            internalEstimatedCostMinor: undefined,
            internalCostCurrency: undefined,
          }),
          {
            sequence: 3,
            kind: "TOOL",
            description: "Installation tool",
            quantity: 1,
            unit: "each",
            providerResponsibility: "BUSINESS",
            commercialTreatment: "NOT_CUSTOMER_BILLABLE",
            visibility: "BUSINESS_ONLY",
            requiredForWorkStart: true,
            sourceLineage: "ACCEPTED_SCOPE_ELABORATION",
          },
        ]
      );
      assert.equal(noDepositPlan.deposit.state, "NOT_REQUIRED");
      assert.equal(noDepositPlan.readiness.customerItemPending, true);
      const [business, customer, tool] = noDepositPlan.items;
      assert.equal((await event(pool, identities, noDepositFixture, noDepositPlan,
        `${suffix}-inventory`, "BUSINESS_INVENTORY_ALLOCATED", business.id)).ok, true);
      assert.equal((await event(pool, identities, noDepositFixture, noDepositPlan,
        `${suffix}-customer`, "CUSTOMER_ITEM_RECEIVED", customer.id)).ok, true);
      assert.equal((await event(pool, identities, noDepositFixture, noDepositPlan,
        `${suffix}-tool`, "TOOLS_READY", tool.id)).ok, true);
      const allReady = await getWorkPreparation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: noDepositFixture.jobId,
      });
      assert.equal(allReady.workPreparation.readiness.workStartBlocked, false);
      assert.equal(allReady.workPreparation.purchaseSummary.recordCount, 0);
      assert.equal(allReady.workPreparation.readiness.customerItemPending, false);

      const separation = await pool.query(
        `SELECT
          (SELECT total_minor FROM canonical_quote_versions
           WHERE quote_id = $1 ORDER BY version DESC LIMIT 1) AS quote_total,
          (SELECT count(*) FROM canonical_invoices WHERE job_id = $2)::integer AS invoices,
          (SELECT count(*) FROM canonical_invoice_payments)::integer AS invoice_payments`,
        [dueQuote.quoteId, dueFixture.jobId]
      );
      assert.deepEqual(separation.rows[0], {
        quote_total: "68000",
        invoices: 0,
        invoice_payments: 0,
      });
    } finally {
      await pool.end();
    }
  }
);
