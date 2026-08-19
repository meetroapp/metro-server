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
const { completeJob } = require("../server/workflow/jobCompletionService");
const {
  createInvoice,
  getCustomerInvoice,
  getCustomerJobInvoice,
  getProfessionalInvoice,
  getProfessionalJobInvoice,
  getProfessionalInvoiceWorkspace,
  issueInvoice,
  recordPayment,
} = require("../server/finance/invoicePaymentService");
const { getCanonicalLiveJob } = require("../server/workflow/liveJobProjectionService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.INVOICE_PAYMENT_DATABASE_URL;

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

async function prepareCompletedJob(pool, suffix) {
  const identities = await createVisitTestIdentities(pool, suffix);
  const fixture = await createVisitLifecycleFixture(pool, identities, suffix);
  const workstream = await createVisitWorkstream(pool, identities, fixture, suffix, 1);
  const created = await command(createDraftQuote, pool, identities.professionalId, {
    jobId: fixture.jobId,
    currency: "USD",
  }, `invoice-quote-create-${suffix}`);
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
  }, `invoice-quote-scope-${suffix}`);
  const issued = await command(issueQuote, pool, identities.professionalId, {
    quoteId: scoped.quote.id,
    expectedVersion: scoped.quote.currentVersion,
  }, `invoice-quote-issue-${suffix}`);
  await command(approveIssuedQuote, pool, identities.homeownerId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `invoice-quote-approve-${suffix}`);

  const activity = await command(createWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    activityType: "REPAIR",
    statement: "Complete the synthetic repair.",
    customerVisible: true,
  }, `invoice-activity-${suffix}`);
  const started = await command(progressWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    activityId: activity.activity.id,
    expectedVersion: activity.activity.currentVersion,
    targetStatus: "IN_PROGRESS",
  }, `invoice-start-${suffix}`);
  await command(progressWorkActivity, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    activityId: activity.activity.id,
    expectedVersion: started.activity.currentVersion,
    targetStatus: "DONE",
  }, `invoice-done-${suffix}`);
  await command(completeWorkstream, pool, identities.professionalId, {
    jobId: fixture.jobId,
    workstreamId: workstream.id,
    expectedVersion: workstream.currentVersion,
  }, `invoice-workstream-complete-${suffix}`);
  const completion = await command(completeJob, pool, identities.professionalId, {
    jobId: fixture.jobId,
    expectedVersion: 0,
  }, `invoice-job-complete-${suffix}`);
  assert.equal(completion.code, "JOB_COMPLETED");
  return { identities, fixture, quote: issued.quote, completion };
}

test(
  "disposable PostgreSQL certifies canonical Invoice issue and append-only Payment truth",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 47);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.applied.length, 45);
      const replay = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 45);

      const { identities, fixture, quote, completion } = await prepareCompletedJob(pool, suffix);
      const before = await pool.query(
        `SELECT jobs.id, jobs.lifecycle_contract_version, quotes.status AS quote_status,
          decisions.decision, (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visit_count
         FROM jobs
         INNER JOIN canonical_quotes quotes ON quotes.id = $2 AND quotes.job_id = jobs.id
         INNER JOIN canonical_quote_customer_decisions decisions ON decisions.quote_id = quotes.id
         WHERE jobs.id = $1`,
        [fixture.jobId, quote.id]
      );

      const unauthorizedCreate = await command(createInvoice, pool, identities.outsiderId, {
        jobId: fixture.jobId,
        expectedCompletionVersion: completion.completion.currentVersion,
        due: { mode: "DUE_ON_RECEIPT", date: null },
      }, `invoice-create-outsider-${suffix}`);
      assert.equal(unauthorizedCreate.code, "INVOICE_AUTHORITY_DENIED");

      const createKey = `invoice-create-${suffix}`;
      const created = await command(createInvoice, pool, identities.professionalId, {
        jobId: fixture.jobId,
        expectedCompletionVersion: completion.completion.currentVersion,
        due: { mode: "DUE_ON_RECEIPT", date: null },
        customerNotes: "Thank you for your business.",
        terms: "Payment is due on receipt.",
      }, createKey);
      assert.equal(created.code, "INVOICE_CREATED");
      assert.equal(created.invoice.status, "DRAFT");
      assert.equal(created.invoice.totalMinor, 92000);
      assert.equal(created.invoice.balanceMinor, 92000);
      assert.equal(created.invoice.lineItems[0].lineageLabel, "ORIGINAL");

      const customerDraft = await getCustomerInvoice({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        invoiceId: created.invoice.invoiceId,
      });
      assert.equal(customerDraft.code, "INVOICE_UNAVAILABLE");

      const issueKey = `invoice-issue-${suffix}`;
      const issued = await command(issueInvoice, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: created.invoice.currentVersion,
      }, issueKey);
      assert.equal(issued.code, "INVOICE_SENT_IN_MEETRO");
      assert.equal(issued.invoice.status, "SENT");
      assert.equal(issued.delivery.messageType, "INVOICE_SHARED");
      const issueReplay = await command(issueInvoice, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: created.invoice.currentVersion,
      }, issueKey);
      assert.equal(issueReplay.replayed, true);
      assert.equal(issueReplay.delivery.messageId, issued.delivery.messageId);

      const messageCount = await pool.query(
        `SELECT count(*)::integer AS count FROM messages
         WHERE invoice_id = $1 AND message_type = 'invoice_shared'`,
        [created.invoice.invoiceId]
      );
      assert.equal(messageCount.rows[0].count, 1);

      const customer = await getCustomerJobInvoice({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.equal(customer.code, "CUSTOMER_INVOICE_LOADED");
      assert.equal(customer.invoice.invoiceId, created.invoice.invoiceId);
      assert.equal(customer.invoice.actions.canPayOnline, false);
      assert.doesNotMatch(
        JSON.stringify(customer.invoice),
        /currentVersion|lineItemId|sourceQuoteId|integrity|idempotency|costMinor|marginMinor|markupMinor/i
      );
      const outsider = await getCustomerInvoice({
        pool,
        authenticatedActor: { id: identities.outsiderId },
        invoiceId: created.invoice.invoiceId,
      });
      assert.equal(outsider.code, "INVOICE_UNAVAILABLE");

      const unauthorizedProfessional = await getProfessionalJobInvoice({
        pool,
        authenticatedActor: { id: identities.outsiderId },
        jobId: fixture.jobId,
      });
      assert.equal(unauthorizedProfessional.code, "INVOICE_UNAVAILABLE");

      const stalePayment = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: created.invoice.currentVersion,
        amountMinor: 100,
        method: "CASH",
        receivedDate: new Date().toISOString().slice(0, 10),
      }, `invoice-payment-stale-${suffix}`);
      assert.equal(stalePayment.code, "STALE_INVOICE_VERSION");

      const partialKey = `invoice-payment-partial-${suffix}`;
      const partial = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: issued.invoice.currentVersion,
        amountMinor: 46000,
        method: "CHECK",
        receivedDate: new Date().toISOString().slice(0, 10),
        customerReference: "Synthetic check 1042",
      }, partialKey);
      assert.equal(partial.invoice.status, "PARTIALLY_PAID");
      assert.equal(partial.invoice.paidMinor, 46000);
      assert.equal(partial.invoice.balanceMinor, 46000);
      const partialReplay = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: issued.invoice.currentVersion,
        amountMinor: 46000,
        method: "CHECK",
        receivedDate: new Date().toISOString().slice(0, 10),
        customerReference: "Synthetic check 1042",
      }, partialKey);
      assert.equal(partialReplay.replayed, true);
      assert.equal(partialReplay.payment.paymentId, partial.payment.paymentId);

      const overpayment = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: partial.invoice.currentVersion,
        amountMinor: 46001,
        method: "CASH",
        receivedDate: new Date().toISOString().slice(0, 10),
      }, `invoice-overpayment-${suffix}`);
      assert.equal(overpayment.code, "PAYMENT_EXCEEDS_BALANCE");

      const paid = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: partial.invoice.currentVersion,
        amountMinor: 46000,
        method: "BANK_TRANSFER",
        receivedDate: new Date().toISOString().slice(0, 10),
      }, `invoice-payment-final-${suffix}`);
      assert.equal(paid.invoice.status, "PAID");
      assert.equal(paid.invoice.balanceMinor, 0);
      assert.equal(paid.invoice.payments.length, 2);

      const professional = await getProfessionalInvoice({
        pool,
        authenticatedActor: { id: identities.professionalId },
        invoiceId: created.invoice.invoiceId,
      });
      assert.equal(professional.invoice.status, "PAID");
      const professionalHistoryInvoice = await getProfessionalJobInvoice({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      assert.equal(professionalHistoryInvoice.invoice.invoiceId, created.invoice.invoiceId);
      assert.equal(professionalHistoryInvoice.invoice.status, "PAID");
      const workspace = await getProfessionalInvoiceWorkspace({
        pool,
        authenticatedActor: { id: identities.professionalId },
      });
      assert.equal(workspace.workspace.summary.paid, 1);
      assert.equal(workspace.workspace.summary.readyToInvoice, 0);

      const liveJob = await getCanonicalLiveJob({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
      });
      assert.equal(liveJob.liveJob.stage.code, "JOB_COMPLETED");
      assert.equal(liveJob.liveJob.nextAction.code, "REVIEW_PAID_INVOICE");

      const after = await pool.query(
        `SELECT jobs.id, jobs.lifecycle_contract_version, quotes.status AS quote_status,
          decisions.decision, (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visit_count
         FROM jobs
         INNER JOIN canonical_quotes quotes ON quotes.id = $2 AND quotes.job_id = jobs.id
         INNER JOIN canonical_quote_customer_decisions decisions ON decisions.quote_id = quotes.id
         WHERE jobs.id = $1`,
        [fixture.jobId, quote.id]
      );
      assert.deepEqual(after.rows, before.rows);
      await assert.rejects(
        pool.query(
          `UPDATE canonical_invoice_payments SET customer_reference = 'rewritten' WHERE id = $1`,
          [paid.payment.paymentId]
        ),
        (error) => error?.code === "55000"
      );
    } finally {
      await pool.end();
    }
  }
);
