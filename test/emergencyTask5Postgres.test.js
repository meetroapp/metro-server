"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { Client } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getMigrationFiles } = require("../scripts/run-migrations");
const fns = require("./helpers/emergencyLifecycleFixture");
const { success } = fns;
const dispatch = require("../server/emergency/emergencyDispatchService");
const completion = require("../server/workflow/jobCompletionService");
const invoices = require("../server/finance/invoicePaymentService");
const quotes = require("../server/authorization/quoteDraftService");
const url = process.env.EMERGENCY_TASK5_DATABASE_URL;
const migrationName = "202609190004_generalize_emergency_completion_invoice_history.sql";
const migration = readFileSync(join(__dirname, "..", "migrations", migrationName), "utf8");
function denied(result) {
  assert.ok(result.ok === false || result.success === false, JSON.stringify(result));
  assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result));
}
function input(f, actor = f.professional) { return { pool: f.pool, authenticatedActor: { id: actor }, jobId: f.job }; }
function complete(f, actor = f.professional) {
  return dispatch.completeEmergencyWork({ pool: f.pool, authenticatedUserId: actor, emergencyRequestId: f.request });
}
function createInvoice(f, actor = f.professional) {
  return invoices.createInvoice({ ...input(f, actor), expectedCompletionVersion: 1,
    due: { mode: "DUE_ON_RECEIPT" }, idempotencyKey: randomUUID() });
}
async function working(f, terms = "50% deposit") {
  await fns.completedEvaluation(f);
  const quote = await fns.issuedQuote(f, terms);
  success(await fns.send(f, quote)); success(await fns.decide(f, quote));
  if (terms === "50% deposit") success(await fns.pay(f, 5000, 1));
  success(await fns.start(f));
  return quote;
}
function issue(f, invoice, external = false) {
  return (external ? invoices.issueInvoiceExternally : invoices.issueInvoice)({ pool: f.pool,
    authenticatedActor: { id: f.professional }, invoiceId: invoice.invoiceId,
    expectedVersion: invoice.currentVersion, idempotencyKey: randomUUID() });
}
function payment(f, invoice, amount, actor = f.professional) {
  return invoices.recordPayment({ pool: f.pool, authenticatedActor: { id: actor }, invoiceId: invoice.invoiceId,
    expectedVersion: invoice.currentVersion, amountMinor: amount, method: "CASH", receivedDate: "2026-09-18", idempotencyKey: randomUUID() });
}

test("Task 5 disposable PostgreSQL completion, Invoice, payment and history certification", { skip: !url }, async t => {
  assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    assert.equal((await client.query("SELECT to_regclass('jobs') AS existing")).rows[0].existing, null);
    for (const file of getMigrationFiles()) {
      try { await client.query(readFileSync(join(__dirname, "..", "migrations", file.filename), "utf8")); }
      catch (error) { throw new Error(`${file.filename}: ${error.message}`, { cause: error }); }
    }
    const pool = fns.transactionalFacade(client);
    async function rejectsSql(sql, values, pattern) {
      await client.query("SAVEPOINT expected_rejection");
      try { await assert.rejects(client.query(sql, values), pattern); }
      finally { await client.query("ROLLBACK TO SAVEPOINT expected_rejection"); }
    }
    async function lifecycleCounts() {
      const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const results = {};
      for (const { tablename } of tables) {
        // Sorted row JSON detects mutations as well as inserts/deletes.
        results[tablename] = (await client.query(`SELECT md5(COALESCE(string_agg(row::text, ',' ORDER BY row::text), '')) AS digest FROM (SELECT to_jsonb(t) row FROM "${tablename}" t) rows`)).rows[0].digest;
      }
      return results;
    }
    async function scenario(name, action) {
      await t.test(name, async () => {
        await client.query("SAVEPOINT scenario");
        try { await action(await fns.fixture(client, pool)); }
        finally { await client.query("ROLLBACK TO SAVEPOINT scenario"); }
      });
    }
    await scenario("$100 Quote / $50 deposit / completion / Final Invoice / PAID / both histories", async f => {
      const quote = await working(f);
      const before = await createInvoice(f);
      assert.equal(before.code, "JOB_NOT_READY_TO_INVOICE");
      const review = success(await completion.getJobCompletionReview(input(f))).completionReview;
      assert.equal(review.eligible, true);
      assert.deepEqual(review.work, { workstreamCount: 0, completedWorkstreamCount: 0, workItemCount: 0, completedWorkItemCount: 0 });
      assert.equal((await complete(f)).code, "EMERGENCY_COMPLETED");
      const record = (await client.query("SELECT * FROM canonical_job_completion_records WHERE job_id = $1", [f.job])).rows[0];
      const request = (await client.query("SELECT * FROM emergency_requests WHERE id = $1", [f.request])).rows[0];
      assert.equal(request.status, "completed");
      assert.equal(record.workstream_count, 0); assert.equal(record.work_item_count, 0);
      assert.equal(new Date(record.completed_at).toISOString(), new Date(request.completed_at).toISOString());
      assert.equal(record.evidence_snapshot.jobId, f.job);
      assert.equal(record.evidence_snapshot.emergencyRequestId, f.request);
      assert.equal(record.evidence_snapshot.relationshipId, f.relationship);
      assert.equal(record.evidence_snapshot.dispatchState, "work_in_progress");
      assert.equal(record.evidence_snapshot.workStartedAt, new Date(request.work_started_at).toISOString());
      assert.equal(record.evidence_snapshot.evaluation.status, "completed");
      assert.equal(record.evidence_snapshot.evaluation.version, 2);
      assert.equal(record.evidence_snapshot.quote.id, quote.id);
      assert.equal(record.evidence_snapshot.quote.version, quote.currentVersion);
      assert.equal(record.evidence_snapshot.quote.approvalSource, "MEETRO_CUSTOMER");
      assert.equal((await complete(f)).code, "EMERGENCY_ALREADY_COMPLETED");
      assert.equal((await client.query("SELECT count(*)::int AS count FROM canonical_job_completion_records WHERE job_id = $1", [f.job])).rows[0].count, 1);
      const workspace = success(await invoices.getProfessionalInvoiceWorkspace({ pool, authenticatedActor: { id: f.professional } })).workspace;
      const ready = workspace.readyJobs.find(row => row.jobId === f.job);
      assert.ok(ready); assert.equal(ready.serviceTitle, "Emergency leak");
      assert.equal(ready.paymentsReceivedMinor, 5000); assert.equal(ready.amountStillDueMinor, 5000);
      const draft = success(await createInvoice(f)).invoice;
      assert.equal(draft.totalMinor, 10000); assert.equal(draft.paidMinor, 5000); assert.equal(draft.balanceMinor, 5000);
      assert.equal((await invoices.getCustomerJobInvoice(input(f, f.homeowner))).ok, false);
      assert.equal((await issue(f, draft, true)).code, "INVOICE_AUTHORITY_DENIED");
      const issued = success(await issue(f, draft)).invoice;
      assert.equal(issued.status, "PARTIALLY_PAID");
      const customerInvoice = success(await invoices.getCustomerInvoice({ pool, authenticatedActor: { id: f.homeowner }, invoiceId: issued.invoiceId })).invoice;
      assert.equal(customerInvoice.invoiceId, issued.invoiceId);
      const issuance = (await client.query("SELECT * FROM canonical_invoice_issuances WHERE invoice_id = $1", [issued.invoiceId])).rows[0];
      assert.equal(issuance.delivery_channel, "MEETRO"); assert.equal(issuance.conversation_id, f.conversation);
      assert.equal((await payment(f, issued, 5000, f.outsider)).code, "PAYMENT_AUTHORITY_DENIED");
      const paid = success(await payment(f, issued, 5000)).invoice;
      assert.equal(paid.status, "PAID"); assert.equal(paid.paidMinor, 10000); assert.equal(paid.balanceMinor, 0);
      assert.equal(success(await invoices.getProfessionalJobInvoice(input(f))).invoice.status, "PAID");
      assert.equal(success(await invoices.getCustomerJobInvoice(input(f, f.homeowner))).invoice.status, "PAID");
      for (const [read, actor] of [[completion.getProfessionalJobHistory, f.professional], [completion.getCustomerJobHistory, f.homeowner]]) {
        const history = success(await read(input(f, actor))).jobHistory;
        assert.equal(history.jobId, f.job); assert.equal(history.requestId, null);
        assert.equal(history.relationshipId, f.relationship); assert.equal(history.conversationId, f.conversation);
        assert.equal(history.serviceTitle, "Emergency leak"); assert.equal(history.status, "COMPLETED");
        assert.deepEqual(history.approvedQuote, { totalMinor: 10000, currency: "USD" });
        assert.deepEqual(history.preservedRecords, { evaluation: true, findings: true, recommendations: true, approvedQuotes: true, visits: false, workPlan: false });
      }
      const historyList = success(await completion.listProfessionalJobHistory({ pool, authenticatedActor: { id: f.professional } })).jobHistory;
      assert.equal(historyList.jobs[0].jobId, f.job); assert.equal(historyList.jobs[0].approvedQuote.totalMinor, 10000);
      const finalWorkspace = success(await invoices.getProfessionalInvoiceWorkspace({ pool, authenticatedActor: { id: f.professional } })).workspace;
      assert.equal(finalWorkspace.readyJobs.length, 0); assert.equal(finalWorkspace.invoices[0].status, "PAID");
      assert.equal((await client.query("SELECT status FROM request_relationships WHERE id = $1", [f.relationship])).rows[0].status, "active");
      assert.equal((await client.query("SELECT sum(amount_minor)::int AS total FROM canonical_invoice_payments WHERE invoice_id = $1", [issued.invoiceId])).rows[0].total, 5000);
      for (const table of ["posts", "request_selections", "canonical_visits", "canonical_workstreams"]) {
        assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
      }
    });
    await scenario("outsiders and homeowner cannot exercise professional completion, Invoice or payment authority", async f => {
      await working(f);
      for (const actor of [f.outsider, f.homeowner]) {
        denied(await complete(f, actor)); denied(await createInvoice(f, actor));
        denied(await completion.getJobCompletionReview(input(f, actor)));
      }
      success(await complete(f));
      const draft = success(await createInvoice(f)).invoice;
      for (const actor of [f.outsider, f.homeowner]) {
        denied(await invoices.issueInvoice({ pool, authenticatedActor: { id: actor }, invoiceId: draft.invoiceId,
          expectedVersion: draft.currentVersion, idempotencyKey: randomUUID() }));
      }
      const issued = success(await issue(f, draft)).invoice;
      for (const actor of [f.outsider, f.homeowner]) denied(await payment(f, issued, 5000, actor));
      denied(await invoices.getCustomerInvoice({ pool, authenticatedActor: { id: f.outsider }, invoiceId: issued.invoiceId }));
      denied(await invoices.getProfessionalJobInvoice(input(f, f.outsider)));
      denied(await completion.getCustomerJobHistory(input(f, f.outsider)));
      denied(await completion.getProfessionalJobHistory(input(f, f.outsider)));
    });
    for (const [name, statement] of [
      ["wrong relationship", "UPDATE conversations SET relationship_id = relationship_id + 1000 WHERE id = $1"],
      ["wrong homeowner", "UPDATE conversations SET homeowner_id = $2 WHERE id = $1"],
      ["wrong professional", "UPDATE conversations SET professional_user_id = $2 WHERE id = $1"],
      ["inactive conversation", "UPDATE conversations SET status = 'closed' WHERE id = $1"],
    ]) {
      await scenario(`${name} prevents completion and Invoice access`, async f => {
        await working(f);
        // A shadow relation models malformed pre-existing identity without weakening live constraints.
        await client.query("CREATE TEMP TABLE conversations (LIKE public.conversations); INSERT INTO conversations SELECT * FROM public.conversations; SET LOCAL search_path=pg_temp,public");
        await client.query(statement, statement.includes("$2") ? [f.conversation, f.outsider] : [f.conversation]);
        denied(await complete(f));
        denied(await createInvoice(f));
        assert.equal((await client.query("SELECT status FROM emergency_requests WHERE id=$1", [f.request])).rows[0].status, "work_in_progress");
        assert.equal((await client.query("SELECT count(*)::int n FROM canonical_job_completion_records")).rows[0].n, 0);
      });
    }
    await scenario("missing work start rejects completion and historical reconciliation", async f => {
      await working(f);
      for (const state of ["work_in_progress", "completed"]) {
        await client.query("UPDATE emergency_requests SET status=$2, work_started_at=NULL, completed_at=CURRENT_TIMESTAMP WHERE id=$1", [f.request, state]);
        denied(await complete(f));
      }
    });
    for (const evaluated of [false, true]) {
      await scenario(`completion rejects missing ${evaluated ? "approved issued Quote" : "completed Evaluation"}`, async f => {
        if (evaluated) { await fns.completedEvaluation(f); await fns.issuedQuote(f); }
        for (const state of ["work_in_progress", "completed"]) {
          await client.query("UPDATE emergency_requests SET status=$2, work_started_at=CURRENT_TIMESTAMP, completed_at=CASE WHEN $2='completed' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=$1", [f.request, state]);
          const result = await complete(f); denied(result);
          assert.equal(result.code, "EMERGENCY_COMPLETION_INELIGIBLE");
          assert.ok(result.reasons.includes(evaluated ? "EMERGENCY_APPROVED_QUOTE_REQUIRED" : "EMERGENCY_COMPLETED_EVALUATION_REQUIRED"));
          if (state === "work_in_progress") {
            const review = success(await completion.getJobCompletionReview(input(f))).completionReview;
            assert.equal(review.eligible, false); assert.ok(!review.reasons.includes("NO_APPROVED_WORK"));
          }
        }
      });
    }
    await scenario("newer issued unapproved Quote blocks completion without falling back to old approval", async f => {
      const approved = await working(f);
      // Emergency revision creation is not part of Task 5. Exercise the actual
      // readiness query against a newer issued, unapproved source-shaped Quote.
      await client.query(`CREATE TEMP TABLE canonical_quotes (LIKE public.canonical_quotes);
        INSERT INTO canonical_quotes SELECT * FROM public.canonical_quotes;
        CREATE TEMP TABLE commercial_authority_aggregates (LIKE public.commercial_authority_aggregates);
        INSERT INTO commercial_authority_aggregates SELECT * FROM public.commercial_authority_aggregates;
        SET LOCAL search_path=pg_temp,public`);
      const newer = randomUUID();
      await client.query(`INSERT INTO canonical_quotes SELECT (jsonb_populate_record(NULL::canonical_quotes,
        to_jsonb(row) || jsonb_build_object('id', $1::uuid, 'parent_quote_id', $2::uuid,
        'lineage_type', 'REVISED_QUOTE', 'issued_at', CURRENT_TIMESTAMP + INTERVAL '1 second'))).*
        FROM public.canonical_quotes row WHERE id=$2`, [newer, approved.id]);
      await client.query(`INSERT INTO commercial_authority_aggregates SELECT (jsonb_populate_record(NULL::commercial_authority_aggregates,
        to_jsonb(row) || jsonb_build_object('id', $1::uuid))).*
        FROM public.commercial_authority_aggregates row WHERE id=$2`, [newer, approved.id]);
      const review = success(await completion.getJobCompletionReview(input(f))).completionReview;
      assert.equal(review.eligible, false);
      assert.ok(review.reasons.includes("EMERGENCY_APPROVED_QUOTE_REQUIRED"));
      denied(await complete(f));
    });
    await scenario("strong historical completed evidence reconciles once using the original completion timestamp", async f => {
      await working(f);
      const original = (await client.query("UPDATE emergency_requests SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING completed_at", [f.request])).rows[0].completed_at;
      assert.equal((await complete(f)).code, "EMERGENCY_ALREADY_COMPLETED");
      assert.equal((await complete(f)).code, "EMERGENCY_ALREADY_COMPLETED");
      const rows = (await client.query("SELECT * FROM canonical_job_completion_records WHERE job_id=$1", [f.job])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].completed_at.toISOString(), original.toISOString());
      assert.equal(rows[0].evidence_snapshot.dispatchState, "completed");
    });
    for (const failurePoint of [/INSERT INTO alerts\b/i, /UPDATE emergency_requests\s+SET/i, /UPDATE conversations\s+SET/i]) {
      await scenario(`completion rolls back at ${failurePoint}`, async f => {
        await working(f);
        const before = (await client.query("SELECT count(*)::int n FROM alerts")).rows[0].n;
        const broken = { ...pool, async query(sql, values) {
          if (failurePoint.test(sql)) throw new Error("Injected Task 5 atomicity failure");
          return pool.query(sql, values);
        }, async connect() { return broken; } };
        const result = await complete({ ...f, pool: broken });
        assert.equal(result.success, false);
        assert.equal((await client.query("SELECT status FROM emergency_requests WHERE id=$1", [f.request])).rows[0].status, "work_in_progress");
        for (const table of ["canonical_job_completion_records", "canonical_job_completion_command_idempotency"]) {
          assert.equal((await client.query(`SELECT count(*)::int n FROM ${table} WHERE job_id=$1`, [f.job])).rows[0].n, 0);
        }
        assert.equal((await client.query("SELECT count(*)::int n FROM alerts")).rows[0].n, before);
        success(await complete(f));
      });
    }
    await scenario("partial/final payments append evidence, replay completion without writes, and preserve exact grants", async f => {
      await working(f); success(await complete(f));
      const beforeReplay = await lifecycleCounts();
      const timestamps = (await client.query("SELECT * FROM emergency_requests WHERE id=$1", [f.request])).rows[0];
      assert.equal((await complete(f)).code, "EMERGENCY_ALREADY_COMPLETED");
      assert.deepEqual(await lifecycleCounts(), beforeReplay);
      assert.deepEqual((await client.query("SELECT * FROM emergency_requests WHERE id=$1", [f.request])).rows[0], timestamps);
      const issued = success(await issue(f, success(await createInvoice(f)).invoice)).invoice;
      const partial = success(await payment(f, issued, 2000)).invoice;
      assert.equal(partial.status, "PARTIALLY_PAID"); assert.equal(partial.paidMinor, 7000); assert.equal(partial.balanceMinor, 3000);
      const paid = success(await payment(f, partial, 3000)).invoice;
      assert.equal(paid.status, "PAID"); assert.equal(paid.balanceMinor, 0);
      assert.equal((await client.query("SELECT count(*)::int n FROM canonical_invoice_payments WHERE invoice_id=$1", [paid.invoiceId])).rows[0].n, 2);
      for (const event of ["work.completed", "invoice.paid"]) {
        const alerts = (await client.query("SELECT * FROM alerts WHERE source_event_type=$1", [event])).rows;
        assert.equal(alerts.length, 1); assert.equal(alerts[0].recipient_user_id, f.homeowner);
      }
      for (const [actor, expected] of [
        [f.professional, ["evaluation.perform", "participant.read", "quote.create", "quote.issue", "quote.read", "quote.revise", "quote.scope.manage"]],
        [f.homeowner, ["participant.read", "quote.approve", "quote.decline", "quote.read_customer"]],
      ]) {
        const grants = await client.query(`SELECT capability FROM lifecycle_authority_grants grants
          JOIN relationship_participants participants ON participants.id=grants.grantee_participant_id
          WHERE participants.user_id=$1 AND grants.job_id=$2 ORDER BY capability`, [actor, f.job]);
        assert.deepEqual(grants.rows.map(row => row.capability), expected);
      }
      const before = await lifecycleCounts();
      const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const external = (await client.query("SELECT pg_get_functiondef('assert_external_invoice_issuance_origin()'::regprocedure) AS definition")).rows;
      await client.query(migration);
      assert.deepEqual(await lifecycleCounts(), before, "104 must not create or rewrite lifecycle business rows");
      assert.deepEqual((await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows, tables);
      assert.deepEqual((await client.query("SELECT pg_get_functiondef('assert_external_invoice_issuance_origin()'::regprocedure) AS definition")).rows, external);
    });
    await scenario("migration origin triggers reject malformed Emergency completion, Invoice, and external issuance", async f => {
      await working(f); success(await complete(f)); success(await createInvoice(f));
      await client.query("CREATE TEMP TABLE jobs (LIKE public.jobs); INSERT INTO jobs SELECT * FROM public.jobs");
      await client.query("SET LOCAL search_path=pg_temp,public");
      await client.query(`CREATE TEMP TABLE completion_probe (LIKE public.canonical_job_completion_records INCLUDING CONSTRAINTS);
        CREATE TRIGGER completion_guard BEFORE INSERT ON completion_probe FOR EACH ROW EXECUTE FUNCTION assert_canonical_job_completion_origin();
        CREATE TEMP TABLE invoice_probe (LIKE public.canonical_invoices INCLUDING CONSTRAINTS);
        CREATE TRIGGER invoice_guard BEFORE INSERT ON invoice_probe FOR EACH ROW EXECUTE FUNCTION assert_canonical_invoice_job_origin();
        CREATE TEMP TABLE issuance_probe (delivery_channel text, job_id uuid);
        CREATE TRIGGER external_guard BEFORE INSERT ON issuance_probe FOR EACH ROW EXECUTE FUNCTION assert_external_invoice_issuance_origin()`);
      const addCompletion = "INSERT INTO completion_probe SELECT * FROM public.canonical_job_completion_records";
      const addInvoice = "INSERT INTO invoice_probe SELECT * FROM public.canonical_invoices";
      await client.query(addCompletion); await client.query(addInvoice);
      await rejectsSql("INSERT INTO issuance_probe VALUES ('EXTERNAL', $1)", [f.job], /External Invoice issuance/);
      for (const [field, value] of [
        ["source_request_relationship_id", null], ["source_emergency_request_id", null],
        ["job_request_id", 42], ["source_request_selection_id", 42], ["contractor_profile_id", f.profile],
        ["originating_business_document_id", randomUUID()], ["business_contact_id", randomUUID()],
        ["business_customer_relationship_id", randomUUID()], ["source_business_customer_job_id", randomUUID()],
        ["created_by_user_id", f.outsider], ["lifecycle_contract_version", 1],
      ]) {
        await client.query("SAVEPOINT malformed");
        await client.query(`UPDATE jobs SET ${field}=$1 WHERE id=$2`, [value, f.job]);
        await rejectsSql(addCompletion, [], /Emergency completion origin mismatch/);
        await rejectsSql(addInvoice, [], /Emergency Invoice origin mismatch/);
        await client.query("ROLLBACK TO SAVEPOINT malformed");
      }
      for (const [table, column, value] of [
        ["completion_probe", "completed_by_participant_id", randomUUID()],
        ["completion_probe", "workstream_count", 1],
        ["invoice_probe", "issuer_participant_id", randomUUID()],
        ["invoice_probe", "relationship_id", f.relationship + 1000],
        ["invoice_probe", "job_request_id", 42],
      ]) {
        const source = table === "completion_probe" ? "canonical_job_completion_records" : "canonical_invoices";
        await rejectsSql(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::public.${source},
          to_jsonb(row) || jsonb_build_object($1::text, $2::text))).* FROM public.${source} row`, [column, String(value)], /Emergency .* origin mismatch/);
      }
    });
    await scenario("104 preserves all four previous Invoice origins and positive Workstream completion requirement", async f => {
      await working(f); success(await complete(f)); success(await createInvoice(f));
      await client.query("CREATE TEMP TABLE jobs (LIKE public.jobs); INSERT INTO jobs SELECT * FROM public.jobs; SET LOCAL search_path=pg_temp,public");
      await client.query(`CREATE TEMP TABLE completion_probe (LIKE public.canonical_job_completion_records INCLUDING CONSTRAINTS);
        CREATE TRIGGER completion_guard BEFORE INSERT ON completion_probe FOR EACH ROW EXECUTE FUNCTION assert_canonical_job_completion_origin();
        CREATE TEMP TABLE invoice_probe (LIKE public.canonical_invoices INCLUDING CONSTRAINTS);
        CREATE TRIGGER invoice_guard BEFORE INSERT ON invoice_probe FOR EACH ROW EXECUTE FUNCTION assert_canonical_invoice_job_origin()`);
      for (const origin of ["ordinary_request_selection", "existing_customer_request", "business_document", "business_customer"]) {
        const external = origin.startsWith("business_");
        await client.query(`UPDATE jobs SET source_type=$1, job_request_id=$2, source_request_selection_id=NULL,
          source_request_relationship_id=$3, originating_business_document_id=$4, business_contact_id=$5,
          business_customer_relationship_id=$6, source_business_customer_job_id=$7, source_emergency_request_id=NULL`,
        [origin, external ? null : 42, external ? null : f.relationship, origin === "business_document" ? randomUUID() : null,
          external ? randomUUID() : null, external ? randomUUID() : null, origin === "business_customer" ? randomUUID() : null]);
        await rejectsSql("INSERT INTO completion_probe SELECT * FROM public.canonical_job_completion_records", [], /Non-Emergency completion requires approved Workstreams/);
        await client.query(`INSERT INTO completion_probe SELECT (jsonb_populate_record(NULL::public.canonical_job_completion_records,
          to_jsonb(row) || '{"workstream_count":1}'::jsonb)).* FROM public.canonical_job_completion_records row`);
        await client.query(`INSERT INTO invoice_probe SELECT (jsonb_populate_record(NULL::public.canonical_invoices,
          to_jsonb(row) || jsonb_build_object('job_request_id', $1::integer, 'relationship_id', $2::integer))).*
          FROM public.canonical_invoices row`, [external ? null : 42, external ? null : f.relationship]);
      }
    });
    await scenario("104 fails closed on malformed historical completion without backfilling rows", async f => {
      await working(f); success(await complete(f));
      await client.query("CREATE TEMP TABLE jobs (LIKE public.jobs); INSERT INTO jobs SELECT * FROM public.jobs; SET LOCAL search_path=pg_temp,public");
      const historical = migration.slice(migration.indexOf("DO $$"), migration.indexOf("CREATE OR REPLACE FUNCTION\nassert_canonical_invoice_job_origin"));
      await client.query(historical);
      await client.query("UPDATE jobs SET source_request_relationship_id=NULL");
      await rejectsSql(historical, [], /Historical canonical Job completion origin mismatch/);
      await client.query("UPDATE jobs SET source_type='ordinary_request_selection'");
      await rejectsSql(historical, [], /Historical canonical Job completion origin mismatch/);
    });
  } finally {
    await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT to_regclass('jobs') AS existing")).rows[0].existing, null);
    await client.end();
  }
});
