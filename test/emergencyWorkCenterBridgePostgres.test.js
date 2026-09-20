"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const fns = require("./helpers/emergencyLifecycleFixture");
const { success } = fns;
const dispatch = require("../server/emergency/emergencyDispatchService");
const { listAuthorizedProfessionalJobs } = require("../server/workflow/professionalJobPickerService");
const { getCanonicalLiveJob } = require("../server/workflow/liveJobProjectionService");
const completion = require("../server/workflow/jobCompletionService");
const invoices = require("../server/finance/invoicePaymentService");
const evaluation = require("../server/authorization/evaluationService");
const url = process.env.EMERGENCY_BRIDGE_DATABASE_URL;

// Requires an already migrated disposable LOCAL database. Deliberately never
// runs migrations or DDL; every fixture and command is rolled back.
test("Emergency Work Center bridge on the certified existing PostgreSQL schema", { skip: !url }, async t => {
  assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    assert.ok((await client.query("SELECT to_regclass('canonical_job_completion_records') AS existing")).rows[0].existing,
      "Provision the certified schema separately; this suite never applies migration 104.");
    const pool = fns.transactionalFacade(client);
    const f = await fns.fixture(client, pool, { dispatchToArrival: false });
    const input = actor => ({ pool, authenticatedActor: { id: actor || f.professional }, jobId: f.job });
    const live = async expected => {
      const result = success(await getCanonicalLiveJob(input())).liveJob;
      assert.equal(result.stage.code, expected); assert.equal(result.sourceType, "emergency_request");
      assert.equal(result.requestId, null); assert.equal(result.relationshipId, f.relationship);
      assert.equal(result.emergencyRequestId, f.request); assert.equal(result.conversationId, f.conversation);
      assert.doesNotMatch(JSON.stringify(result), /schedule|visit|workstream/i);
      return result;
    };
    const counts = async () => {
      const values = {};
      for (const table of ["posts", "request_selections", "canonical_visits", "canonical_workstreams"]) {
        values[table] = (await client.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count;
      }
      return values;
    };
    const before = await counts();
    await t.test("selected Emergency is visible only to the selected professional", async () => {
      const own = success(await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: f.professional } })).jobs;
      assert.equal(own.find(job => job.jobId === f.job).sourceType, "emergency_request");
      const other = success(await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: f.outsider } })).jobs;
      assert.ok(!other.some(job => job.jobId === f.job));
      assert.equal((await getCanonicalLiveJob(input(f.outsider))).status, 404);
      await live("ASSIGNED");
    });
    await t.test("inactive selected relationship fails closed", async () => {
      await client.query("SAVEPOINT inactive_relationship");
      await client.query("UPDATE request_relationships SET status='closed' WHERE id=$1", [f.relationship]);
      assert.ok(!success(await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: f.professional } })).jobs.some(job => job.jobId === f.job));
      assert.equal((await getCanonicalLiveJob(input())).status, 404);
      await client.query("ROLLBACK TO SAVEPOINT inactive_relationship");
    });
    await t.test("Assigned, On the Way, Arrived and Evaluation use canonical dispatch/Evaluation commands", async () => {
      success(await dispatch.markEmergencyEnRoute({ pool, authenticatedUserId: f.professional, emergencyRequestId: f.request }));
      await live("ON_THE_WAY");
      success(await dispatch.markEmergencyArrived({ pool, authenticatedUserId: f.professional, emergencyRequestId: f.request }));
      await live("EVALUATION_NEEDED");
      const created = success(await evaluation.createEvaluation({ pool, authenticatedActor: { id: f.professional },
        sourceContext: { type: "emergency_request", emergencyRequestId: f.request, relationshipId: f.relationship },
        content: { serviceType: "plumbing_repair", evaluationContext: "emergency_request", observations: "Leaking seal.",
          findings: [{ summary: "Failed seal", severity: "high", customerShareable: true }], scopeRecommendations: ["Replace seal."] },
        expectedVersion: 0, idempotencyKey: randomUUID() }));
      await live("EVALUATION_IN_PROGRESS");
      success(await evaluation.completeEvaluation({ pool, authenticatedActor: { id: f.professional }, evaluationId: created.aggregate.id,
        expectedVersion: created.aggregate.version, idempotencyKey: randomUUID() }));
      await live("QUOTE_NEEDED");
    });
    await t.test("approval and canonical deposit gate control readiness without scheduling", async () => {
      const quote = await fns.issuedQuote(f, "50% deposit");
      success(await fns.send(f, quote));
      await live("WAITING_FOR_CUSTOMER_DECISION");
      success(await fns.decide(f, quote));
      assert.equal((await live("QUOTE_APPROVED_DEPOSIT_DUE")).deposit.state, "DUE");
      success(await fns.pay(f, 2000, 1));
      assert.equal((await live("QUOTE_APPROVED_DEPOSIT_DUE")).deposit.state, "PARTIALLY_SATISFIED");
      success(await fns.pay(f, 3000, 2));
      assert.equal((await live("WORK_READY")).deposit.state, "SATISFIED");
      success(await fns.start(f));
      await live("WORK_IN_PROGRESS");
    });
    await t.test("completion, Invoice credit, final payment and both histories retain Emergency source", async () => {
      const review = success(await completion.getJobCompletionReview(input())).completionReview;
      assert.equal(review.canComplete, true); assert.equal(review.work.workstreamCount, 0); assert.equal(review.work.workItemCount, 0);
      success(await dispatch.completeEmergencyWork({ pool, authenticatedUserId: f.professional, emergencyRequestId: f.request }));
      await live("JOB_COMPLETED");
      const workspace = success(await invoices.getProfessionalInvoiceWorkspace({ pool, authenticatedActor: { id: f.professional } })).workspace;
      const ready = workspace.readyJobs.find(job => job.jobId === f.job);
      assert.equal(ready.sourceType, "emergency_request"); assert.equal(ready.sourceLabel, "Emergency");
      assert.equal(ready.approvedAmount.totalMinor, 10000); assert.equal(ready.paymentsReceivedMinor, 5000); assert.equal(ready.amountStillDueMinor, 5000);
      let invoice = success(await invoices.createInvoice({ ...input(), expectedCompletionVersion: 1, due: { mode: "DUE_ON_RECEIPT" }, idempotencyKey: randomUUID() })).invoice;
      await live("FINAL_INVOICE");
      invoice = success(await invoices.issueInvoice({ pool, authenticatedActor: { id: f.professional }, invoiceId: invoice.invoiceId,
        expectedVersion: invoice.currentVersion, idempotencyKey: randomUUID() })).invoice;
      const partial = await live("PARTIALLY_PAID");
      assert.deepEqual([partial.invoice.totalMinor, partial.invoice.paidMinor, partial.invoice.balanceMinor], [10000, 5000, 5000]);
      invoice = success(await invoices.recordPayment({ pool, authenticatedActor: { id: f.professional }, invoiceId: invoice.invoiceId,
        expectedVersion: invoice.currentVersion, amountMinor: 5000, method: "CASH", receivedDate: "2026-09-19", idempotencyKey: randomUUID() })).invoice;
      assert.equal((await live("PAID")).invoice.balanceMinor, 0);
      for (const [read, actor] of [[completion.getProfessionalJobHistory, f.professional], [completion.getCustomerJobHistory, f.homeowner]]) {
        const history = success(await read(input(actor))).jobHistory;
        assert.equal(history.sourceType, "emergency_request"); assert.equal(history.requestId, null);
        assert.equal(history.preservedRecords.visits, false); assert.equal(history.preservedRecords.workPlan, false);
      }
      const list = success(await completion.listProfessionalJobHistory({ pool, authenticatedActor: { id: f.professional } })).jobHistory.jobs;
      assert.equal(list.find(job => job.jobId === f.job).sourceType, "emergency_request");
      const paid = success(await invoices.getProfessionalInvoiceWorkspace({ pool, authenticatedActor: { id: f.professional } })).workspace.invoices.find(item => item.jobId === f.job);
      assert.equal(paid.sourceType, "emergency_request"); assert.equal(paid.balanceMinor, 0);
      assert.equal((await client.query("SELECT status FROM request_relationships WHERE id=$1", [f.relationship])).rows[0].status, "active");
      assert.deepEqual(await counts(), before);
    });
  } finally { await client.query("ROLLBACK"); await client.end(); }
});
