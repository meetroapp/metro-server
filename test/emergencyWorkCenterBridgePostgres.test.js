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
const { createVisitTestIdentities, createVisitLifecycleFixture } = require("./helpers/visitLifecycleFixture");
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
    const counts = async () => {
      const values = {};
      for (const table of ["posts", "request_selections", "canonical_visits", "canonical_workstreams"]) {
        values[table] = (await client.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count;
      }
      return values;
    };
    const before = await counts();
    assert.deepEqual(before, { posts: 0, request_selections: 0, canonical_visits: 0, canonical_workstreams: 0 });
    const f = await fns.fixture(client, pool, { dispatchToArrival: false });
    const input = actor => ({ pool, authenticatedActor: { id: actor || f.professional }, jobId: f.job });
    const live = async expected => {
      const result = success(await getCanonicalLiveJob(input())).liveJob;
      assert.equal(result.stage.code, expected); assert.equal(result.sourceType, "emergency_request");
      assert.equal(result.jobId, f.job); assert.equal(result.sourceLabel, "Emergency");
      assert.equal(result.serviceTitle, "Emergency leak"); assert.equal(result.customerLabel, "homeowner");
      assert.equal(result.requestId, null); assert.equal(result.relationshipId, f.relationship);
      assert.equal(result.emergencyRequestId, f.request); assert.equal(result.conversationId, f.conversation);
      assert.doesNotMatch(JSON.stringify(result), /schedule|visit|workstream|work.?plan/i);
      return result;
    };
    await t.test("selected Emergency is visible only to the selected professional", async () => {
      const own = success(await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: f.professional } })).jobs;
      assert.deepEqual(own.find(job => job.jobId === f.job), {
        jobId: f.job, sourceType: "emergency_request", sourceLabel: "Emergency",
        relationshipId: f.relationship, emergencyRequestId: f.request,
        title: "Emergency leak", serviceDomain: "home_services", serviceSpecialty: "plumbing_repair",
        lifecycleStatus: "ACTIVE", customerLabel: "homeowner", city: null, serviceArea: null,
      });
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
    await t.test("malformed selected relationship fails closed", async () => {
      await client.query("SAVEPOINT malformed_relationship");
      try {
        await client.query("UPDATE request_relationships SET homeowner_id=$2 WHERE id=$1", [f.relationship, f.outsider]);
        assert.ok(!success(await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: f.professional } })).jobs.some(job => job.jobId === f.job));
        assert.equal((await getCanonicalLiveJob(input())).status, 404);
      } finally { await client.query("ROLLBACK TO SAVEPOINT malformed_relationship"); }
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
      const paidLive = await live("PAID");
      assert.deepEqual([paidLive.invoice.status, paidLive.invoice.totalMinor, paidLive.invoice.paidMinor, paidLive.invoice.balanceMinor], ["PAID", 10000, 10000, 0]);
      for (const [read, actor] of [[completion.getProfessionalJobHistory, f.professional], [completion.getCustomerJobHistory, f.homeowner]]) {
        const history = success(await read(input(actor))).jobHistory;
        assert.equal(history.sourceType, "emergency_request"); assert.equal(history.sourceLabel, "Emergency");
        assert.equal(history.jobId, f.job); assert.equal(history.requestId, null);
        assert.equal(history.relationshipId, f.relationship); assert.equal(history.conversationId, f.conversation);
        assert.equal(history.serviceTitle, "Emergency leak");
        assert.deepEqual(history.approvedQuote, { totalMinor: 10000, currency: "USD" });
        assert.deepEqual(history.preservedRecords, { evaluation: true, findings: true, recommendations: true, approvedQuotes: true, visits: false, workPlan: false });
      }
      const list = success(await completion.listProfessionalJobHistory({ pool, authenticatedActor: { id: f.professional } })).jobHistory.jobs;
      assert.equal(list.find(job => job.jobId === f.job).sourceType, "emergency_request");
      const paid = success(await invoices.getProfessionalInvoiceWorkspace({ pool, authenticatedActor: { id: f.professional } })).workspace.invoices.find(item => item.jobId === f.job);
      assert.equal(paid.sourceType, "emergency_request"); assert.equal(paid.balanceMinor, 0);
      assert.equal((await client.query("SELECT status FROM request_relationships WHERE id=$1", [f.relationship])).rows[0].status, "active");
      assert.deepEqual(await counts(), before);
    });
    await t.test("ordinary Job Request discovery and live state retain their existing contract", async () => {
      // Ordinary response commands make deferred constraints immediate before
      // COMMIT. Savepoints retain that mode, unlike a real new transaction.
      const ordinaryPool = { ...pool,
        async query(sql, values) {
          const result = await pool.query(sql, values);
          if (/^BEGIN\b/.test(sql)) await client.query("SET CONSTRAINTS ALL DEFERRED");
          return result;
        },
        async connect() { return ordinaryPool; },
      };
      const suffix = randomUUID();
      const identities = await createVisitTestIdentities(ordinaryPool, suffix);
      const ordinary = await createVisitLifecycleFixture(ordinaryPool, identities, suffix);
      const ordinaryInput = { pool: ordinaryPool, authenticatedActor: { id: identities.professionalId } };
      const source = (await client.query(`SELECT posts.*, users.username AS customer_name FROM posts
        JOIN users ON users.id=posts.user_id WHERE posts.id=$1`, [ordinary.requestId])).rows[0];
      const selected = success(await listAuthorizedProfessionalJobs(ordinaryInput)).jobs.find(job => job.jobId === ordinary.jobId);
      assert.deepEqual(selected, { jobId: ordinary.jobId, sourceType: "ordinary_request_selection",
        title: source.title, serviceDomain: source.service_domain, serviceSpecialty: source.service_specialty,
        lifecycleStatus: "ACTIVE", customerLabel: source.customer_name, city: source.service_city,
        serviceArea: source.discovery_area_label, sourceLabel: "Job Request" });
      const live = success(await getCanonicalLiveJob({ ...ordinaryInput, jobId: ordinary.jobId })).liveJob;
      assert.equal(live.sourceType, "ordinary_request_selection"); assert.equal(live.requestId, ordinary.requestId);
      assert.notEqual(live.sourceLabel, "Emergency");
      assert.ok(!success(await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: identities.outsiderId } })).jobs.some(job => job.jobId === ordinary.jobId));
    });
  } finally { await client.query("ROLLBACK"); await client.end(); }
});
