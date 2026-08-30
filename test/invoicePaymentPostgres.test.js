"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
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
  createDerivedDraftQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  completeEvaluation,
} = require("../server/authorization/evaluationService");
const {
  sendQuoteInMeetro,
} = require("../server/authorization/quoteDeliveryService");
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

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function prepareCompletedJob(pool, suffix, unitAmountMinor = 68000) {
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
      unitAmountMinor,
      source: {
        type: "WORKSTREAM",
        workstreamId: workstream.id,
        version: workstream.currentVersion,
      },
    },
  }, `invoice-quote-scope-${suffix}`);
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completedEvaluation = await command(
    completeEvaluation,
    pool,
    identities.professionalId,
    {
      evaluationId: evaluation.id,
      expectedVersion: 1,
      completionMode: "REMOTE",
      assessmentMethod: "PHONE",
      assessmentBasis: "Reviewed the disposable Invoice authority fixture with the customer by phone.",
    },
    `invoice-evaluation-complete-${suffix}`
  );
  assert.equal(completedEvaluation.ok, true, completedEvaluation.code);
  const issued = await command(issueQuote, pool, identities.professionalId, {
    quoteId: scoped.quote.id,
    expectedVersion: scoped.quote.currentVersion,
  }, `invoice-quote-issue-${suffix}`);
  assert.equal(issued.ok, true, issued.code);
  const delivered = await command(sendQuoteInMeetro, pool, identities.professionalId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `invoice-quote-deliver-${suffix}`);
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await command(approveIssuedQuote, pool, identities.homeownerId, {
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
  }, `invoice-quote-approve-${suffix}`);
  assert.equal(approved.ok, true, approved.code);

  const revised = await command(createDerivedDraftQuote, pool, identities.professionalId, {
    parentQuoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    lineageType: "REVISED_QUOTE",
    reasonCategory: "SCOPE_CHANGE",
  }, `invoice-quote-revise-${suffix}`);
  assert.equal(revised.ok, true, revised.code);
  const revisedScoped = await command(addDraftScopeItem, pool, identities.professionalId, {
    quoteId: revised.quote.id,
    expectedVersion: revised.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: "Complete the governed synthetic repair",
      quantity: 1,
      unitAmountMinor,
      source: {
        type: "WORKSTREAM",
        workstreamId: workstream.id,
        version: workstream.currentVersion,
      },
    },
  }, `invoice-quote-revised-scope-${suffix}`);
  assert.equal(revisedScoped.ok, true, revisedScoped.code);
  const revisedIssued = await command(issueQuote, pool, identities.professionalId, {
    quoteId: revisedScoped.quote.id,
    expectedVersion: revisedScoped.quote.currentVersion,
  }, `invoice-quote-revised-issue-${suffix}`);
  assert.equal(revisedIssued.ok, true, revisedIssued.code);
  const revisedDelivered = await command(sendQuoteInMeetro, pool, identities.professionalId, {
    quoteId: revisedIssued.quote.id,
    expectedIssuedVersion: revisedIssued.quote.currentVersion,
  }, `invoice-quote-revised-deliver-${suffix}`);
  assert.equal(revisedDelivered.ok, true, revisedDelivered.code);
  const revisedApproved = await command(approveIssuedQuote, pool, identities.homeownerId, {
    quoteId: revisedIssued.quote.id,
    expectedIssuedVersion: revisedIssued.quote.currentVersion,
  }, `invoice-quote-revised-approve-${suffix}`);
  assert.equal(revisedApproved.ok, true, revisedApproved.code);

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
  return {
    identities,
    fixture,
    quote: revisedIssued.quote,
    originalQuote: issued.quote,
    completion,
  };
}

async function insertSatisfiedPreworkDeposit(pool, fixture, quoteId, amountMinor) {
  const sourceResult = await pool.query(
    `SELECT decisions.id AS customer_decision_id,
       decisions.quote_id, decisions.issued_quote_version,
       decisions.job_id, decisions.relationship_id,
       decisions.decision, decisions.customer_participant_id,
       decisions.issued_integrity_hash, decisions.decided_at,
       versions.currency, versions.total_minor, jobs.job_request_id
     FROM canonical_quote_customer_decisions decisions
     INNER JOIN canonical_quote_versions versions
       ON versions.quote_id = decisions.quote_id
       AND versions.version = decisions.issued_quote_version
       AND versions.job_id = decisions.job_id
     INNER JOIN jobs ON jobs.id = decisions.job_id
     WHERE decisions.quote_id = $1`,
    [quoteId]
  );
  const source = sourceResult.rows[0];
  const commandId = randomUUID();
  const obligationId = randomUUID();
  const commandKey = randomUUID();
  await pool.query(
    `INSERT INTO canonical_pre_work_payment_command_idempotency (
       id, job_id, actor_type, actor_participant_id,
       command_name, command_scope, idempotency_key, request_fingerprint
     ) VALUES ($1, $2, 'PARTICIPANT', $3,
       'deposit.materialize', $4, $5, $6)`,
    [commandId, source.job_id, fixture.homeownerParticipantId,
      `decision:${source.customer_decision_id}`, commandKey, hash(commandKey)]
  );
  await pool.query(
    `INSERT INTO canonical_pre_work_deposit_obligations (
       id, job_id, job_request_id, relationship_id,
       quote_id, issued_quote_version, customer_decision_id,
       customer_decision, customer_participant_id, currency,
       quote_total_minor, deposit_rule_type,
       deposit_percent_basis_points, deposit_fixed_minor,
       required_minor, source_integrity_hash, effective_at,
       created_by_participant_id, created_command_idempotency_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, 'PERCENT', 7500, NULL, $12, $13, $14, $15, $16)`,
    [obligationId, source.job_id, Number(source.job_request_id),
      Number(source.relationship_id), source.quote_id,
      Number(source.issued_quote_version), source.customer_decision_id,
      source.decision, source.customer_participant_id, source.currency,
      Number(source.total_minor), amountMinor, source.issued_integrity_hash,
      source.decided_at, source.customer_participant_id, commandId]
  );
  await pool.query(
    `INSERT INTO canonical_pre_work_deposit_versions (
       obligation_id, version, job_id, relationship_id, currency,
       state, required_minor, applied_minor, remaining_minor,
       recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES ($1, 1, $2, $3, $4, 'SATISFIED', $5, $5, 0, $6, $7, $8)`,
    [obligationId, source.job_id, Number(source.relationship_id), source.currency,
      amountMinor, fixture.homeownerParticipantId, commandId,
      hash(`deposit-version:${obligationId}:1:SATISFIED`)]
  );
  return { obligationId, commandId };
}

test(
  "disposable PostgreSQL certifies canonical Invoice issue and append-only Payment truth",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 64);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.applied.length, 64);
      const replay = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 64);

      const { identities, fixture, quote, originalQuote, completion } =
        await prepareCompletedJob(pool, suffix);
      await insertSatisfiedPreworkDeposit(pool, fixture, quote.id, 51000);
      const readyWorkspace = await getProfessionalInvoiceWorkspace({
        pool,
        authenticatedActor: { id: identities.professionalId },
      });
      const readyJob = readyWorkspace.workspace.readyJobs.find(
        (candidate) => candidate.jobId === fixture.jobId
      );
      assert.deepEqual(readyJob.approvedAmount, { currency: "USD", totalMinor: 68000 });
      assert.equal(readyJob.paymentsReceivedMinor, 51000);
      assert.equal(readyJob.amountStillDueMinor, 17000);
      assert.equal(readyJob.approvedWork.length, 1);
      const approvedQuoteTruth = await pool.query(
        `SELECT quotes.id, decisions.decision, versions.total_minor
         FROM canonical_quotes quotes
         INNER JOIN canonical_quote_customer_decisions decisions
           ON decisions.quote_id = quotes.id
         INNER JOIN canonical_quote_versions versions
           ON versions.quote_id = decisions.quote_id
           AND versions.version = decisions.issued_quote_version
         WHERE quotes.id = ANY($1::uuid[])
         ORDER BY quotes.created_at`,
        [[originalQuote.id, quote.id]]
      );
      assert.deepEqual(approvedQuoteTruth.rows.map((row) => ({
        id: row.id,
        decision: row.decision,
        totalMinor: Number(row.total_minor),
      })), [
        { id: originalQuote.id, decision: "APPROVED", totalMinor: 68000 },
        { id: quote.id, decision: "APPROVED", totalMinor: 68000 },
      ]);
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
        extraWork: [{
          description: "Additional reviewed cabinet alignment",
          quantity: 1,
          unitAmountMinor: 7500,
        }],
      }, createKey);
      assert.equal(created.code, "INVOICE_CREATED");
      assert.equal(created.invoice.status, "DRAFT");
      assert.equal(created.invoice.totalMinor, 75500);
      assert.equal(created.invoice.paidMinor, 51000);
      assert.equal(created.invoice.balanceMinor, 24500);
      assert.deepEqual(created.invoice.lineItems.map((item) => item.type), [
        "approvedWork",
        "extraWork",
      ]);
      assert.equal(created.invoice.lineItems[0].lineageLabel, "REVISED");
      assert.equal(created.invoice.lineItems[1].description, "Additional reviewed cabinet alignment");
      assert.equal("sourceQuoteId" in created.invoice.lineItems[1], false);

      const lineSources = await pool.query(
        `SELECT source_type, source_quote_id, source_quote_version,
           source_scope_item_id, lineage_label
         FROM canonical_invoice_line_item_snapshots
         WHERE invoice_id = $1
         ORDER BY sequence`,
        [created.invoice.invoiceId]
      );
      assert.deepEqual(lineSources.rows.map((row) => row.source_type), [
        "APPROVED_QUOTE_SCOPE",
        "EXTRA_WORK",
      ]);
      assert.ok(lineSources.rows[0].source_quote_id);
      assert.equal(lineSources.rows[1].source_quote_id, null);
      assert.equal(lineSources.rows[1].source_quote_version, null);
      assert.equal(lineSources.rows[1].source_scope_item_id, null);
      assert.equal(lineSources.rows[1].lineage_label, null);
      const preIssuePaymentCount = await pool.query(
        `SELECT count(*)::integer AS count
         FROM canonical_invoice_payments
         WHERE invoice_id = $1`,
        [created.invoice.invoiceId]
      );
      assert.equal(preIssuePaymentCount.rows[0].count, 0);
      await assert.rejects(
        pool.query(
          `INSERT INTO canonical_invoice_line_item_snapshots (
             id, invoice_id, invoice_version, job_id, sequence, source_type,
             source_quote_id, source_quote_version, source_scope_item_id,
             lineage_label, description, quantity, unit_amount_minor,
             line_total_minor, created_by_participant_id
           ) SELECT $1, invoice_id, invoice_version, job_id, 99, 'EXTRA_WORK',
             source_quote_id, source_quote_version, source_scope_item_id,
             lineage_label, 'Invalid mixed source', 1, 1, 1,
             created_by_participant_id
           FROM canonical_invoice_line_item_snapshots
           WHERE invoice_id = $2 AND sequence = 1`,
          [randomUUID(), created.invoice.invoiceId]
        ),
        (error) => error?.code === "23514"
      );

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
      assert.equal(issued.invoice.status, "PARTIALLY_PAID");
      assert.equal(issued.invoice.paidMinor, 51000);
      assert.equal(issued.invoice.balanceMinor, 24500);
      assert.equal(issued.delivery.messageType, "INVOICE_SHARED");
      const issueReplay = await command(issueInvoice, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: created.invoice.currentVersion,
      }, issueKey);
      assert.equal(issueReplay.replayed, true);
      assert.equal(issueReplay.delivery.messageId, issued.delivery.messageId);
      const deliveredAlert = await pool.query(
        `SELECT recipient_user_id, source_event_type, lifecycle_state,
          canonical_event_key, destination_type, destination_payload
         FROM alerts
         WHERE source_event_type = 'invoice.delivered'
           AND source_entity_id = $1`,
        [created.invoice.invoiceId]
      );
      assert.equal(deliveredAlert.rowCount, 1);
      assert.equal(Number(deliveredAlert.rows[0].recipient_user_id), identities.homeownerId);
      assert.equal(deliveredAlert.rows[0].lifecycle_state, "active");
      assert.match(deliveredAlert.rows[0].canonical_event_key, /^[0-9a-f]{64}$/);
      assert.equal(deliveredAlert.rows[0].destination_type, "invoice");
      assert.deepEqual(deliveredAlert.rows[0].destination_payload, {
        jobId: fixture.jobId,
        invoiceId: created.invoice.invoiceId,
      });

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
        amountMinor: 12000,
        method: "CHECK",
        receivedDate: new Date().toISOString().slice(0, 10),
        customerReference: "Synthetic check 1042",
      }, partialKey);
      assert.equal(partial.invoice.status, "PARTIALLY_PAID");
      assert.equal(partial.invoice.paidMinor, 63000);
      assert.equal(partial.invoice.balanceMinor, 12500);
      const partialAlerts = await pool.query(
        `SELECT source_event_type, lifecycle_state
         FROM alerts
         WHERE source_entity_type = 'invoice' AND source_entity_id = $1
         ORDER BY id`,
        [created.invoice.invoiceId]
      );
      assert.deepEqual(partialAlerts.rows, [
        { source_event_type: "invoice.delivered", lifecycle_state: "active" },
        { source_event_type: "invoice.payment_recorded", lifecycle_state: "active" },
      ]);
      const partialReplay = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: issued.invoice.currentVersion,
        amountMinor: 12000,
        method: "CHECK",
        receivedDate: new Date().toISOString().slice(0, 10),
        customerReference: "Synthetic check 1042",
      }, partialKey);
      assert.equal(partialReplay.replayed, true);
      assert.equal(partialReplay.payment.paymentId, partial.payment.paymentId);

      const overpayment = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: partial.invoice.currentVersion,
        amountMinor: 12501,
        method: "CASH",
        receivedDate: new Date().toISOString().slice(0, 10),
      }, `invoice-overpayment-${suffix}`);
      assert.equal(overpayment.code, "PAYMENT_EXCEEDS_BALANCE");

      const paid = await command(recordPayment, pool, identities.professionalId, {
        invoiceId: created.invoice.invoiceId,
        expectedVersion: partial.invoice.currentVersion,
        amountMinor: 12500,
        method: "BANK_TRANSFER",
        receivedDate: new Date().toISOString().slice(0, 10),
      }, `invoice-payment-final-${suffix}`);
      assert.equal(paid.invoice.status, "PAID");
      assert.equal(paid.invoice.balanceMinor, 0);
      assert.equal(paid.invoice.payments.length, 2);
      const paidAlerts = await pool.query(
        `SELECT recipient_user_id, source_event_type, lifecycle_state,
          canonical_event_key, destination_type, destination_payload
         FROM alerts
         WHERE source_entity_type = 'invoice' AND source_entity_id = $1
         ORDER BY id`,
        [created.invoice.invoiceId]
      );
      assert.deepEqual(paidAlerts.rows.map((row) => ({
        recipient: Number(row.recipient_user_id),
        event: row.source_event_type,
        state: row.lifecycle_state,
        destination: row.destination_type,
      })), [
        { recipient: identities.homeownerId, event: "invoice.delivered", state: "resolved", destination: "invoice" },
        { recipient: identities.homeownerId, event: "invoice.payment_recorded", state: "active", destination: "invoice" },
        { recipient: identities.homeownerId, event: "invoice.paid", state: "active", destination: "invoice" },
      ]);
      assert.equal(
        paidAlerts.rows.every((row) => /^[0-9a-f]{64}$/.test(row.canonical_event_key)),
        true
      );
      assert.equal(
        paidAlerts.rows.every((row) =>
          row.destination_payload.jobId === fixture.jobId &&
          row.destination_payload.invoiceId === created.invoice.invoiceId
        ),
        true
      );

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
      const approvedQuoteTruthAfter = await pool.query(
        `SELECT quotes.id, decisions.decision, versions.total_minor
         FROM canonical_quotes quotes
         INNER JOIN canonical_quote_customer_decisions decisions
           ON decisions.quote_id = quotes.id
         INNER JOIN canonical_quote_versions versions
           ON versions.quote_id = decisions.quote_id
           AND versions.version = decisions.issued_quote_version
         WHERE quotes.id = ANY($1::uuid[])
         ORDER BY quotes.created_at`,
        [[originalQuote.id, quote.id]]
      );
      assert.deepEqual(approvedQuoteTruthAfter.rows, approvedQuoteTruth.rows);
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
