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
  declineIssuedQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const { sendQuoteInMeetro } = require("../server/authorization/quoteDeliveryService");
const { completeEvaluation } = require("../server/authorization/evaluationService");
const {
  confirmDepositReceived,
  getProfessionalDepositStatus,
  materializePreWorkDepositObligation,
  reverseDepositAllocation,
} = require("../server/finance/preWorkDepositService");
const {
  activateApprovedWorkVisitAuthority,
} = require("../server/workflow/approvedWorkVisitService");
const {
  confirmVisit,
  proposeVisit,
} = require("../server/workflow/visitService");
const {
  getCanonicalLiveJob,
} = require("../server/workflow/liveJobProjectionService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.PRE_WORK_DEPOSIT_RUNTIME_DATABASE_URL;
const clock = () => new Date("2026-08-28T12:00:00.000Z");

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

const depositTerms = Object.freeze({
  schemaVersion: 1,
  paymentTerms: "75% deposit; balance due on completion.",
  estimatedDuration: "1 day",
  customerNotes: "",
  agreement: Object.freeze({
    exclusions: [],
    additionalWorkTerms: "Written customer approval is required.",
    hiddenConditionsTerms: "Hidden conditions require a revised Quote.",
    diagnosticTerms: "Diagnostic work is limited to the stated scope.",
    customerResponsibilities: "Provide safe site access.",
    warrantyTerms: "One-year workmanship warranty.",
    cancellationTerms: "Cancellation terms apply as stated.",
    acceptanceTerms: "Approval accepts this exact issued Quote.",
    preauthorizedAdditionalWorkLimit: "$0",
  }),
});

async function createIssuedDepositQuote(pool, identities, fixture, suffix) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completed = await completeEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis: "Reviewed the synthetic deposit fixture with the customer by phone.",
    idempotencyKey: `deposit-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(completed.ok, true, completed.code);
  const created = await createDraftQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    customerTermsSnapshot: depositTerms,
    idempotencyKey: `deposit-quote-create-${suffix}`,
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
      description: "Synthetic approved work",
      quantity: 1,
      unitAmountMinor: 68000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `deposit-quote-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `deposit-quote-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  return {
    issuedVersion: issued.quote.currentVersion,
    quoteId: issued.quote.id,
  };
}

async function createDeliveredDepositQuote(pool, identities, fixture, suffix) {
  const issued = await createIssuedDepositQuote(pool, identities, fixture, suffix);
  const delivered = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: issued.quoteId,
    expectedIssuedVersion: issued.issuedVersion,
    idempotencyKey: `deposit-quote-deliver-${suffix}`,
    logger: quiet,
  });
  assert.equal(delivered.ok, true, delivered.code);
  return issued;
}

async function createApprovedDepositQuote(pool, identities, fixture, suffix) {
  const delivered = await createDeliveredDepositQuote(pool, identities, fixture, suffix);
  const approved = await approveIssuedQuote({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    quoteId: delivered.quoteId,
    expectedIssuedVersion: delivered.issuedVersion,
    idempotencyKey: `deposit-quote-approve-${suffix}`,
    logger: quiet,
  });
  assert.equal(approved.ok, true, approved.code);
  return {
    decisionId: approved.customerDecision.id,
    issuedVersion: delivered.issuedVersion,
    quoteId: delivered.quoteId,
  };
}

async function insertLegacyApprovedDecision(pool, identities, fixture, quote) {
  const source = await pool.query(
    `SELECT canonical_quotes.relationship_id,
       issuances.source_snapshot_integrity_hash,
       customer.id AS customer_participant_id,
       grants.id AS authority_grant_id
     FROM canonical_quotes
     INNER JOIN canonical_quote_issuances issuances
       ON issuances.quote_id = canonical_quotes.id
       AND issuances.job_id = canonical_quotes.job_id
       AND issuances.quote_version = $2
     INNER JOIN request_relationships relationships
       ON relationships.id = canonical_quotes.relationship_id
     INNER JOIN relationship_participants customer
       ON customer.job_id = canonical_quotes.job_id
       AND customer.request_relationship_id = canonical_quotes.relationship_id
       AND customer.user_id = relationships.homeowner_id
     INNER JOIN lifecycle_authority_grants grants
       ON grants.grantee_participant_id = customer.id
       AND grants.job_id = canonical_quotes.job_id
       AND grants.capability = 'quote.approve'
       AND grants.valid_from <= CURRENT_TIMESTAMP
       AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
     LEFT JOIN lifecycle_authority_grant_revocations revocations
       ON revocations.authority_grant_id = grants.id
     WHERE canonical_quotes.id = $1
       AND canonical_quotes.job_id = $3
       AND revocations.id IS NULL
     LIMIT 1`,
    [quote.quoteId, quote.issuedVersion, fixture.jobId]
  );
  assert.ok(source.rows[0]);
  const commandId = randomUUID();
  const decisionId = randomUUID();
  await pool.query(
    `INSERT INTO commercial_command_idempotency (
       id, actor_user_id, command_name, command_scope,
       idempotency_key, request_fingerprint, aggregate_id,
       result_reference, completed_at
     ) VALUES ($1, $2, 'quote.customer.approve', $3, $4, $5, $6,
       $7::jsonb, CURRENT_TIMESTAMP)`,
    [
      commandId,
      identities.homeownerId,
      `quote:${quote.quoteId}:customer-decision`,
      `legacy-decision-${decisionId}`,
      "b".repeat(64),
      quote.quoteId,
      JSON.stringify({ code: "LEGACY_APPROVED_DECISION_FIXTURE", quoteId: quote.quoteId }),
    ]
  );
  await pool.query(
    `INSERT INTO canonical_quote_customer_decisions (
       id, quote_id, issued_quote_version, job_id, relationship_id,
       customer_participant_id, authority_grant_id, decision,
       idempotency_id, issued_integrity_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED', $8, $9)`,
    [
      decisionId,
      quote.quoteId,
      quote.issuedVersion,
      fixture.jobId,
      Number(source.rows[0].relationship_id),
      source.rows[0].customer_participant_id,
      source.rows[0].authority_grant_id,
      commandId,
      source.rows[0].source_snapshot_integrity_hash,
    ]
  );
  return decisionId;
}

function payment(pool, actorId, jobId, values) {
  return confirmDepositReceived({
    pool,
    authenticatedActor: { id: actorId },
    jobId,
    currency: "USD",
    normalizedMethod: "BUSINESS_TRANSFER_APP",
    displayMethod: "Business transfer app",
    receivedAt: "2026-08-28T11:00:00.000Z",
    logger: quiet,
    ...values,
  });
}

function approvedWorkProposal(jobId, decisionId) {
  return {
    jobId,
    purpose: "APPROVED_WORK",
    approvedQuoteDecisionId: decisionId,
    workstreamIds: [],
    scheduledStartAt: "2026-09-02T13:00:00.000Z",
    scheduledEndAt: "2026-09-02T14:00:00.000Z",
    timeZone: "America/New_York",
    locationMode: "JOB_SERVICE_LOCATION",
  };
}

test(
  "disposable PostgreSQL certifies manual deposit runtime and Approved Work gating",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 59);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, 59);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-deposit`);

      const issuedFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-issued-only`
      );
      await createIssuedDepositQuote(
        pool,
        identities,
        issuedFixture,
        `${suffix}-issued-only`
      );
      const issuedOnly = await getProfessionalDepositStatus({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: issuedFixture.jobId,
        logger: quiet,
      });
      assert.equal(issuedOnly.code, "PRE_WORK_DEPOSIT_APPROVED_AGREEMENT_REQUIRED");

      const declinedFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-declined`
      );
      const declinedQuote = await createDeliveredDepositQuote(
        pool,
        identities,
        declinedFixture,
        `${suffix}-declined`
      );
      const declined = await declineIssuedQuote({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        quoteId: declinedQuote.quoteId,
        expectedIssuedVersion: declinedQuote.issuedVersion,
        idempotencyKey: `deposit-quote-decline-${suffix}`,
        logger: quiet,
      });
      assert.equal(declined.customerDecision.decision, "DECLINED");
      const declinedStatus = await getProfessionalDepositStatus({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: declinedFixture.jobId,
        logger: quiet,
      });
      assert.equal(
        declinedStatus.code,
        "PRE_WORK_DEPOSIT_APPROVED_AGREEMENT_REQUIRED"
      );

      const legacyFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-legacy-approved`
      );
      const legacyQuote = await createDeliveredDepositQuote(
        pool,
        identities,
        legacyFixture,
        `${suffix}-legacy-approved`
      );
      const deliveredOnly = await getProfessionalDepositStatus({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: legacyFixture.jobId,
        logger: quiet,
      });
      assert.equal(
        deliveredOnly.code,
        "PRE_WORK_DEPOSIT_APPROVED_AGREEMENT_REQUIRED"
      );
      await insertLegacyApprovedDecision(pool, identities, legacyFixture, legacyQuote);
      const legacyBefore = await pool.query(
        `SELECT count(*)::integer AS obligations
         FROM canonical_pre_work_deposit_obligations WHERE job_id = $1`,
        [legacyFixture.jobId]
      );
      assert.equal(legacyBefore.rows[0].obligations, 0);
      const legacyRead = await getProfessionalDepositStatus({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: legacyFixture.jobId,
        logger: quiet,
      });
      assert.equal(legacyRead.code, "PRE_WORK_DEPOSIT_RECONCILIATION_REQUIRED");
      assert.equal(legacyRead.deposit.materialized, false);
      const legacyAfterRead = await pool.query(
        `SELECT count(*)::integer AS obligations
         FROM canonical_pre_work_deposit_obligations WHERE job_id = $1`,
        [legacyFixture.jobId]
      );
      assert.equal(legacyAfterRead.rows[0].obligations, 0);
      const legacyMaterialized = await materializePreWorkDepositObligation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: legacyFixture.jobId,
        idempotencyKey: `legacy-explicit-materialize-${suffix}`,
        logger: quiet,
      });
      assert.equal(legacyMaterialized.code, "PRE_WORK_DEPOSIT_MATERIALIZED");
      assert.equal(legacyMaterialized.deposit.state, "DUE");

      const quote = await createApprovedDepositQuote(
        pool,
        identities,
        fixture,
        `${suffix}-deposit`
      );

      const approvalEvidence = await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM canonical_pre_work_deposit_obligations
             WHERE customer_decision_id = $1) AS obligations,
           (SELECT count(*)::integer FROM canonical_pre_work_deposit_versions
             WHERE obligation_id IN (
               SELECT id FROM canonical_pre_work_deposit_obligations
               WHERE customer_decision_id = $1
             )) AS versions,
           (SELECT count(*)::integer FROM canonical_pre_work_deposit_events
             WHERE obligation_id IN (
               SELECT id FROM canonical_pre_work_deposit_obligations
               WHERE customer_decision_id = $1
             )) AS events`,
        [quote.decisionId]
      );
      assert.deepEqual(approvalEvidence.rows[0], {
        obligations: 1,
        versions: 1,
        events: 1,
      });

      const due = await getProfessionalDepositStatus({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        logger: quiet,
      });
      assert.equal(due.code, "PRE_WORK_DEPOSIT_FOUND");
      assert.deepEqual(
        {
          state: due.deposit.state,
          total: due.deposit.quoteTotalMinor,
          required: due.deposit.requiredMinor,
          applied: due.deposit.appliedMinor,
          remaining: due.deposit.remainingMinor,
          rule: due.deposit.depositRule,
        },
        {
          state: "DUE",
          total: 68000,
          required: 51000,
          applied: 0,
          remaining: 51000,
          rule: { type: "PERCENT", percentBasisPoints: 7500, fixedMinor: null },
        }
      );
      const outsiderRead = await getProfessionalDepositStatus({
        pool,
        authenticatedActor: { id: identities.outsiderId },
        jobId: fixture.jobId,
        logger: quiet,
      });
      assert.equal(outsiderRead.code, "PRE_WORK_DEPOSIT_UNAVAILABLE");

      const reconcileKey = `deposit-reconcile-${suffix}`;
      const reconciled = await materializePreWorkDepositObligation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        idempotencyKey: reconcileKey,
        logger: quiet,
      });
      assert.equal(reconciled.code, "PRE_WORK_DEPOSIT_ALREADY_MATERIALIZED");
      const reconcileReplay = await materializePreWorkDepositObligation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        idempotencyKey: reconcileKey,
        logger: quiet,
      });
      assert.equal(reconcileReplay.replayed, true);

      const blockedActivation = await activateApprovedWorkVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        quoteId: quote.quoteId,
        idempotencyKey: `deposit-activation-due-${suffix}`,
        logger: quiet,
      });
      assert.equal(blockedActivation.code, "DEPOSIT_REQUIRED_BEFORE_SCHEDULING");

      const firstInput = {
        amountMinor: 20000,
        expectedVersion: 1,
        externalReference: "verified-external-payment-one",
        idempotencyKey: `deposit-payment-one-${suffix}`,
      };
      const first = await payment(
        pool,
        identities.professionalId,
        fixture.jobId,
        firstInput
      );
      assert.equal(first.code, "PRE_WORK_DEPOSIT_PAYMENT_CONFIRMED");
      assert.equal(first.deposit.state, "PARTIALLY_SATISFIED");
      assert.equal(first.deposit.appliedMinor, 20000);
      assert.equal(first.deposit.remainingMinor, 31000);
      assert.equal(first.payment.unappliedMinor, 0);
      const firstReplay = await payment(
        pool,
        identities.professionalId,
        fixture.jobId,
        firstInput
      );
      assert.equal(firstReplay.replayed, true);
      assert.equal(firstReplay.payment.receiptId, first.payment.receiptId);
      const conflict = await payment(pool, identities.professionalId, fixture.jobId, {
        ...firstInput,
        amountMinor: 21000,
      });
      assert.equal(conflict.code, "PRE_WORK_DEPOSIT_IDEMPOTENCY_CONFLICT");

      const partialActivation = await activateApprovedWorkVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        quoteId: quote.quoteId,
        idempotencyKey: `deposit-activation-partial-${suffix}`,
        logger: quiet,
      });
      assert.equal(partialActivation.code, "DEPOSIT_REQUIRED_BEFORE_SCHEDULING");

      const second = await payment(pool, identities.professionalId, fixture.jobId, {
        amountMinor: 31000,
        expectedVersion: 2,
        externalReference: "verified-external-payment-two",
        idempotencyKey: `deposit-payment-two-${suffix}`,
      });
      assert.equal(second.deposit.state, "SATISFIED");
      assert.equal(second.deposit.remainingMinor, 0);

      const activated = await activateApprovedWorkVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        quoteId: quote.quoteId,
        idempotencyKey: `deposit-activation-satisfied-${suffix}`,
        logger: quiet,
      });
      assert.equal(activated.ok, true, activated.code);
      assert.equal(activated.authority.deposit.state, "SATISFIED");
      assert.equal(activated.authority.actions.canProposeApprovedWorkVisit, true);
      const proposed = await proposeVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        ...approvedWorkProposal(fixture.jobId, quote.decisionId),
        idempotencyKey: `deposit-visit-satisfied-${suffix}`,
        logger: quiet,
        clock,
      });
      assert.equal(proposed.ok, true, proposed.code);

      const reversed = await reverseDepositAllocation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        allocationId: second.payment.allocationId,
        amountMinor: 1000,
        reasonCategory: "REFUND",
        reason: "Verified external refund before work began.",
        expectedVersion: 3,
        idempotencyKey: `deposit-reversal-${suffix}`,
        logger: quiet,
      });
      assert.equal(reversed.deposit.state, "PARTIALLY_SATISFIED");
      assert.equal(reversed.deposit.remainingMinor, 1000);
      const reversalReplay = await reverseDepositAllocation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        allocationId: second.payment.allocationId,
        amountMinor: 1000,
        reasonCategory: "REFUND",
        reason: "Verified external refund before work began.",
        expectedVersion: 3,
        idempotencyKey: `deposit-reversal-${suffix}`,
        logger: quiet,
      });
      assert.equal(reversalReplay.replayed, true);
      assert.equal(reversalReplay.reversal.reversalId, reversed.reversal.reversalId);

      const blockedConfirmation = await confirmVisit({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
        visitId: proposed.visit.id,
        expectedVersion: 1,
        idempotencyKey: `deposit-visit-confirm-blocked-${suffix}`,
        logger: quiet,
        clock,
      });
      assert.equal(blockedConfirmation.code, "DEPOSIT_REQUIRED_BEFORE_SCHEDULING");

      const overpayment = await payment(pool, identities.professionalId, fixture.jobId, {
        amountMinor: 2000,
        expectedVersion: 4,
        externalReference: "verified-external-overpayment",
        idempotencyKey: `deposit-payment-over-${suffix}`,
      });
      assert.equal(overpayment.deposit.state, "SATISFIED");
      assert.equal(overpayment.payment.allocatedMinor, 1000);
      assert.equal(overpayment.payment.unappliedMinor, 1000);

      const live = await getCanonicalLiveJob({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        logger: quiet,
      });
      assert.equal(live.ok, true, live.code);
      assert.equal(live.liveJob.deposit.state, "SATISFIED");
      assert.equal(live.liveJob.deposit.remainingMinor, 0);
      assert.notEqual(live.liveJob.stage.code, "QUOTE_APPROVED_DEPOSIT_DUE");

      const evaluationFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-evaluation-unaffected`
      );
      const evaluationVisit = await proposeVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: evaluationFixture.jobId,
        purpose: "EVALUATION",
        workstreamIds: [],
        scheduledStartAt: "2026-09-03T13:00:00.000Z",
        scheduledEndAt: "2026-09-03T14:00:00.000Z",
        timeZone: "America/New_York",
        locationMode: "JOB_SERVICE_LOCATION",
        idempotencyKey: `evaluation-visit-unaffected-${suffix}`,
        logger: quiet,
        clock,
      });
      assert.equal(evaluationVisit.ok, true, evaluationVisit.code);

      const evidence = await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM canonical_pre_work_deposit_obligations
             WHERE job_id = $1) AS obligations,
           (SELECT count(*)::integer FROM canonical_pre_work_payment_receipts
             WHERE job_id = $1) AS receipts,
           (SELECT count(*)::integer FROM canonical_pre_work_payment_allocations
             WHERE job_id = $1) AS allocations,
           (SELECT count(*)::integer FROM canonical_pre_work_payment_allocation_reversals
             WHERE job_id = $1) AS reversals,
           (SELECT count(*)::integer FROM canonical_pre_work_deposit_versions
             WHERE job_id = $1) AS versions,
           (SELECT count(*)::integer FROM canonical_pre_work_deposit_events
             WHERE job_id = $1) AS events,
           (SELECT count(*)::integer FROM canonical_invoice_payments
             WHERE job_id = $1) AS invoice_payments`,
        [fixture.jobId]
      );
      assert.deepEqual(evidence.rows[0], {
        obligations: 1,
        receipts: 3,
        allocations: 3,
        reversals: 1,
        versions: 5,
        events: 5,
        invoice_payments: 0,
      });

      await assert.rejects(
        pool.query(
          `UPDATE canonical_pre_work_payment_receipts
           SET display_method = 'Rewritten' WHERE id = $1`,
          [first.payment.receiptId]
        ),
        (error) => error?.code === "55000"
      );
      const replayMigrations = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replayMigrations.success, true, JSON.stringify(replayMigrations));
      assert.equal(replayMigrations.skipped.length, 59);
    } finally {
      await pool.end();
    }
  }
);
