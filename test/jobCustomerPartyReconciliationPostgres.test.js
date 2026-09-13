"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { reconcileJobCustomerParty, loadEvidence } = require("../server/relationships/jobCustomerPartyReconciliationService");
const { getBusinessCustomerRelationshipActivity } = require("../server/relationships/businessCustomerRelationshipService");

// Optional local runtime certification. These are session-local test tables,
// not migrations. The connection is rejected unless it names a local test DB.
const databaseUrl = process.env.CUSTOMER_HISTORY_RECONCILIATION_DATABASE_URL;
const J = "072c8736-5d97-4253-ba3e-dd1bce281a20";
const J2 = "172c8736-5d97-4253-ba3e-dd1bce281a20";
const C = "0c3c3c09-2ba8-4bd6-a001-0524984e467a";
const R = "e9bb9da5-7cc9-4c3a-b4d3-814a7a020a43";
const R2 = "a9bb9da5-7cc9-4c3a-b4d3-814a7a020a43";
const D = "ccda1240-b24e-4f10-b06f-3908c6641773";
const Q = "f08a4f3b-8a21-4da8-a6b0-4258f5a8df9b";
const Q2 = "a08a4f3b-8a21-4da8-a6b0-4258f5a8df9b";
const I = "93792224-2cfd-44d0-ada7-8efd5e48a5da";
const I2 = "a3792224-2cfd-44d0-ada7-8efd5e48a5da";
const schema = {
  contractor_profiles: "id int primary key, user_id int",
  business_contacts: "id uuid primary key, contractor_profile_id int, party_type text, display_name text, company_name text, email text, phone text, address_text text, service_area_text text, status text, version int",
  business_customer_relationships: "id uuid primary key, contractor_profile_id int, business_contact_id uuid, version int, created_at timestamptz default now(), updated_at timestamptz default now()",
  jobs: "id uuid primary key, contractor_profile_id int, business_contact_id uuid, business_customer_relationship_id uuid, source_type text, source_request_relationship_id int, job_request_id int, originating_business_document_id uuid, created_at timestamptz default now()",
  request_relationships: "id int, contractor_id int, professional_user_id int, status text",
  relationship_participants: "id uuid, job_id uuid, user_id int, request_relationship_id int",
  participant_role_assignments: "id uuid, participant_id uuid, job_id uuid, role text, valid_from timestamptz default now(), valid_until timestamptz",
  participant_role_revocations: "id uuid, role_assignment_id uuid",
  job_customer_parties: "job_id uuid primary key, contractor_profile_id int, business_contact_id uuid, business_customer_relationship_id uuid, linked_by_user_id int, created_at timestamptz default now()",
  canonical_quote_customer_parties: "quote_id uuid primary key, job_id uuid, contractor_profile_id int, business_contact_id uuid, business_customer_relationship_id uuid, created_at timestamptz default now()",
  canonical_invoice_customer_parties: "invoice_id uuid primary key, job_id uuid, contractor_profile_id int, business_contact_id uuid, business_customer_relationship_id uuid, created_at timestamptz default now()",
  canonical_quote_customer_snapshots: "quote_id uuid, job_id uuid, contractor_profile_id int, business_contact_id uuid, business_customer_relationship_id uuid",
  canonical_quotes: "id uuid primary key, job_id uuid, status text, created_at timestamptz default now(), updated_at timestamptz default now(), issued_at timestamptz default now()",
  canonical_invoices: "id uuid primary key, job_id uuid, invoice_number text, created_at timestamptz default now()",
  canonical_quote_business_document_sources: "quote_id uuid, job_id uuid, contractor_profile_id int, source_document_id uuid, document_number text",
  business_document_draft_commands: "document_draft_id uuid, actor_user_id int, operation text, response_json jsonb, completed_at timestamptz",
  business_document_working_drafts: "id uuid, job_id uuid, contractor_profile_id int, business_contact_id uuid, business_customer_relationship_id uuid, content jsonb",
  posts: "id int, title text, category text, request_photos jsonb",
  canonical_job_completion_records: "job_id uuid, status text, completed_at timestamptz",
  commercial_authority_aggregates: "id uuid, aggregate_type text, owning_engine text, current_version int",
  canonical_quote_versions: "quote_id uuid, job_id uuid, version int, currency text, total_minor bigint",
  canonical_quote_customer_decisions: "id uuid, quote_id uuid, issued_quote_version int, decision text, decided_at timestamptz",
  canonical_quote_approvals: "id uuid, quote_id uuid, job_id uuid, issued_quote_version int, decision text, approved_at timestamptz, approval_source text",
  canonical_invoice_versions: "invoice_id uuid, job_id uuid, version int, status text, currency text, total_minor bigint, paid_minor bigint, balance_minor bigint, invoice_date date, created_at timestamptz default now()",
  canonical_invoice_issuances: "invoice_id uuid, job_id uuid, issued_at timestamptz",
  canonical_pre_work_deposit_obligations: "id uuid, job_id uuid, quote_id uuid, currency text, required_minor bigint",
  canonical_pre_work_deposit_versions: "obligation_id uuid, version int, applied_minor bigint, state text, created_at timestamptz default now()",
  canonical_pre_work_payment_receipts: "id uuid, job_id uuid, gross_amount_minor bigint, currency text, received_at timestamptz default now()",
  canonical_invoice_payments: "id uuid, job_id uuid, amount_minor bigint, currency text, received_date date default current_date",
  canonical_visits: "id uuid, job_id uuid, purpose text, created_at timestamptz default now()",
  canonical_visit_versions: "visit_id uuid, job_id uuid, version int, state text, scheduled_start_at timestamptz, scheduled_end_at timestamptz, time_zone text, location_mode text, completed_at timestamptz",
  canonical_work_activities: "id uuid, job_id uuid, workstream_id uuid, created_at timestamptz default now()",
  canonical_work_activity_versions: "activity_id uuid, job_id uuid, workstream_id uuid, version int, statement text, status text, performed_at timestamptz",
  canonical_workstream_versions: "workstream_id uuid, job_id uuid, version int, title text",
};

test("local PostgreSQL customer linkage and exact history projections", { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.pathname, "/meetro_r55a_test");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const calls = [];
  const pool = { query(sql, values) { calls.push(sql); return client.query(sql, values); } };
  const insert = async (table, row) => {
    const keys = Object.keys(row);
    await client.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
  };
  const tuple = { contractor_profile_id: 7, business_contact_id: C, business_customer_relationship_id: R };
  const receipt = { id: D, jobId: J, version: 2, customerParty: { jobId: J, contractorProfileId: 7, businessContactId: C, customerRelationshipId: R } };
  const reconcile = (jobId = J) => reconcileJobCustomerParty({ pool, authenticatedActor: { id: 15 }, jobId });
  const history = (relationshipId = R) => getBusinessCustomerRelationshipActivity({ pool, authenticatedActor: { id: 15 }, relationshipId });
  async function seed() {
    await client.query(`TRUNCATE ${Object.keys(schema).join(",")}`);
    await insert("contractor_profiles", { id: 7, user_id: 15 });
    await insert("business_contacts", { id: C, contractor_profile_id: 7, display_name: "Same name", email: "same@example.test", phone: "5550100", version: 1 });
    await insert("business_customer_relationships", { id: R, contractor_profile_id: 7, business_contact_id: C, version: 1 });
    await insert("business_customer_relationships", { id: R2, contractor_profile_id: 7, business_contact_id: C, version: 1 });
    await insert("request_relationships", { id: 345, contractor_id: 7, professional_user_id: 15, status: "active" });
    for (const [jobId, quoteId, invoiceId, requestId] of [[J, Q, I, 23], [J2, Q2, I2, 24]]) {
      await insert("jobs", { id: jobId, source_type: "ordinary_request_selection", source_request_relationship_id: 345, job_request_id: requestId });
      await insert("relationship_participants", { id: jobId, job_id: jobId, user_id: 15, request_relationship_id: 345 });
      await insert("participant_role_assignments", { id: jobId, participant_id: jobId, job_id: jobId, role: "PRIMARY_PROFESSIONAL" });
      await insert("posts", { id: requestId, title: "Same customer and title", request_photos: [] });
      await insert("canonical_job_completion_records", { job_id: jobId, status: "COMPLETED", completed_at: "2026-09-13T00:00:00Z" });
      await insert("canonical_quotes", { id: quoteId, job_id: jobId, status: "ISSUED" });
      await insert("commercial_authority_aggregates", { id: quoteId, aggregate_type: "quote", owning_engine: "authorization_engine", current_version: 1 });
      await insert("canonical_quote_versions", { quote_id: quoteId, job_id: jobId, version: 1, currency: "USD", total_minor: 68000 });
      await insert("canonical_invoices", { id: invoiceId, job_id: jobId, invoice_number: jobId === J ? "INV-937922242CFD" : "OTHER" });
      await insert("canonical_invoice_versions", { invoice_id: invoiceId, job_id: jobId, version: 1, status: "PAID", currency: "USD", total_minor: 68000, paid_minor: 68000, balance_minor: 0 });
      await insert("canonical_pre_work_deposit_obligations", { id: jobId, job_id: jobId, quote_id: quoteId, currency: "USD", required_minor: 51000 });
      await insert("canonical_pre_work_deposit_versions", { obligation_id: jobId, version: 1, applied_minor: 51000, state: "SATISFIED" });
      await insert("canonical_pre_work_payment_receipts", { id: quoteId, job_id: jobId, gross_amount_minor: 51000, currency: "USD" });
      await insert("canonical_invoice_payments", { id: invoiceId, job_id: jobId, amount_minor: 17000, currency: "USD" });
      await insert("canonical_visits", { id: jobId, job_id: jobId, purpose: "APPROVED_WORK" });
      await insert("canonical_visit_versions", { visit_id: jobId, job_id: jobId, version: 1, state: "COMPLETED" });
      await insert("canonical_work_activities", { id: jobId, job_id: jobId, workstream_id: jobId });
      await insert("canonical_work_activity_versions", { activity_id: jobId, job_id: jobId, workstream_id: jobId, version: 1, statement: "Completed work", status: "DONE" });
      await insert("canonical_workstream_versions", { workstream_id: jobId, job_id: jobId, version: 1, title: "Repair" });
    }
    await insert("business_document_working_drafts", { id: D, job_id: J, ...tuple });
    await insert("canonical_quote_business_document_sources", { quote_id: Q, job_id: J, contractor_profile_id: 7, source_document_id: D });
    await insert("business_document_draft_commands", { document_draft_id: D, actor_user_id: 15, operation: "UPDATE", response_json: receipt, completed_at: "2026-08-29T19:45:51Z" });
    calls.length = 0;
  }
  try {
    for (const [table, columns] of Object.entries(schema)) await client.query(`CREATE TEMP TABLE ${table} (${columns})`);
    await t.test("completed receipt restores exact Job once and only Job linkage mutates", async () => {
      await seed();
      const before = {};
      for (const table of Object.keys(schema).filter((table) => table !== "job_customer_parties")) before[table] = (await client.query(`SELECT * FROM ${table}`)).rows;
      assert.equal((await reconcile()).status, 201);
      assert.equal((await reconcile()).status, 200);
      assert.equal((await client.query("SELECT * FROM job_customer_parties")).rows.length, 1);
      for (const [table, rows] of Object.entries(before)) assert.deepEqual((await client.query(`SELECT * FROM ${table}`)).rows, rows, `${table} unchanged`);
    });
    await t.test("completed Job, Quotes, Invoice, payments, deposits, Visits and work project only exact Job", async () => {
      await seed();
      assert.equal((await history()).activity.work.length, 0);
      await reconcile();
      const { activity } = await history();
      for (const field of ["work", "quotes", "invoices", "deposits", "visits", "workPerformed"]) {
        assert.equal(activity[field].length, 1, field);
        assert.equal(activity[field][0].jobId, J, field);
      }
      assert.equal(activity.work[0].status, "COMPLETED");
      assert.equal(activity.invoices[0].invoiceNumber, "INV-937922242CFD");
      assert.equal(activity.invoices[0].totalMinor, 68000);
      assert.equal(activity.invoices[0].paidMinor, 68000);
      assert.equal(activity.invoices[0].balanceMinor, 0);
      assert.equal(activity.deposits[0].appliedMinor, 51000);
      assert.deepEqual(activity.payments.map((p) => p.amountMinor).sort((a,b) => a-b), [17000, 51000]);
      assert.ok(activity.payments.every((p) => p.jobId === J));
      assert.equal(activity.documents.length, 2);
      assert.ok(activity.documents.every((d) => d.parentId === J));
    });
    await t.test("explicit document party wins and prevents duplicate or competing fallback", async () => {
      await seed(); await reconcile();
      await insert("canonical_quote_customer_parties", { quote_id: Q, job_id: J, ...tuple });
      await insert("canonical_invoice_customer_parties", { invoice_id: I, job_id: J, ...tuple });
      assert.equal((await history()).activity.quotes.length, 1);
      assert.equal((await history()).activity.invoices.length, 1);
      await client.query("UPDATE canonical_quote_customer_parties SET business_customer_relationship_id=$1", [R2]);
      await client.query("UPDATE canonical_invoice_customer_parties SET business_customer_relationship_id=$1", [R2]);
      assert.equal((await history()).activity.quotes.length, 0);
      assert.equal((await history()).activity.invoices.length, 0);
      assert.equal((await history(R2)).activity.quotes.length, 1);
      assert.equal((await history(R2)).activity.invoices.length, 1);
      assert.equal((await reconcile()).code, "CUSTOMER_PARTY_EVIDENCE_CONFLICT");
    });
    for (const [name, sql] of [
      ["incomplete command", "UPDATE business_document_draft_commands SET completed_at=NULL"],
      ["unrelated document receipt", "UPDATE business_document_draft_commands SET document_draft_id='172c8736-5d97-4253-ba3e-dd1bce281a20'"],
      ["wrong Job receipt", `UPDATE business_document_draft_commands SET response_json=jsonb_set(response_json,'{jobId}','"${J2}"')`],
      ["no canonical import source", "DELETE FROM canonical_quote_business_document_sources"],
    ]) await t.test(`${name} does not prove a link from mutable draft or text`, async () => {
      await seed(); await client.query(sql);
      assert.equal((await reconcile()).code, "CUSTOMER_PARTY_DURABLE_EVIDENCE_REQUIRED");
      assert.equal((await client.query("SELECT * FROM job_customer_parties")).rows.length, 0);
    });
    for (const [name, sql] of [
      ["wrong receipt actor", "UPDATE business_document_draft_commands SET actor_user_id=99"],
      ["cross-business receipt", "UPDATE business_document_draft_commands SET response_json=jsonb_set(response_json,'{customerParty,contractorProfileId}','8')"],
      ["cross-business Contact", "UPDATE business_contacts SET contractor_profile_id=8"],
      ["competing durable Relationship", `UPDATE business_document_draft_commands SET response_json=jsonb_set(response_json,'{customerParty,customerRelationshipId}','"${R2}"')`],
      ["mismatched Quote Job", `UPDATE canonical_quotes SET job_id='${J2}' WHERE id='${Q}'`],
    ]) await t.test(`${name} blocks reconciliation`, async () => {
      await seed(); await client.query(sql);
      assert.equal((await reconcile()).code, "CUSTOMER_PARTY_EVIDENCE_CONFLICT");
      assert.equal((await client.query("SELECT * FROM job_customer_parties")).rows.length, 0);
    });
    await t.test("external and repeat Jobs derive the saved tuple from canonical Job columns", async () => {
      await seed();
      await client.query("DELETE FROM business_document_draft_commands");
      await client.query("UPDATE jobs SET source_type='business_document',contractor_profile_id=7,business_contact_id=$1,business_customer_relationship_id=$2", [C, R]);
      await client.query("UPDATE relationship_participants SET request_relationship_id=NULL");
      assert.equal((await reconcile()).status, 201);
      assert.equal((await reconcile(J2)).status, 201);
      assert.deepEqual((await history()).activity.work.map((w) => w.jobId).sort(), [J, J2].sort());
      assert.equal((await history()).activity.invoices.length, 2);
    });
    await t.test("marketplace identity and matching customer text are not reconciliation evidence", async () => {
      await seed();
      await client.query("DELETE FROM business_document_draft_commands");
      await client.query("DELETE FROM business_document_working_drafts");
      assert.deepEqual(await loadEvidence(pool, J), []);
      assert.equal((await reconcile()).code, "CUSTOMER_PARTY_DURABLE_EVIDENCE_REQUIRED");
    });
  } finally { await client.end(); }
});
