"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  businessCustomerRelationshipInternals,
} = require("../server/relationships/businessCustomerRelationshipService");

const JOB_A = "33333333-3333-4333-8333-333333333333";
const JOB_B = "44444444-4444-4444-8444-444444444444";
const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);

function job(overrides = {}) {
  return {
    job_id: JOB_A,
    service_title: "Kitchen faucet installation",
    service_category: "Plumbing",
    source_type: "ordinary_request_selection",
    job_created_at: "2026-09-01T10:00:00.000Z",
    completion_status: null,
    completed_at: null,
    linked_at: "2026-09-01T10:01:00.000Z",
    ...overrides,
  };
}

test("fixture 1: customer with no Jobs remains an empty canonical collection", () => {
  assert.deepEqual([].map(businessCustomerRelationshipInternals.workActivityProjection), []);
});

test("fixture 2: one active Job is projected as active", () => {
  const projected = businessCustomerRelationshipInternals.workActivityProjection(job());
  assert.equal(projected.completionState, "ACTIVE");
  assert.equal(projected.status, "ACTIVE");
});

test("fixture 3: one completed Job retains completion truth", () => {
  const projected = businessCustomerRelationshipInternals.workActivityProjection(job({ completion_status: "COMPLETED", completed_at: "2026-09-03T10:00:00.000Z" }));
  assert.equal(projected.completionState, "COMPLETED");
  assert.equal(projected.completedAt, "2026-09-03T10:00:00.000Z");
});

test("fixture 4: active and completed Jobs remain separate exact records", () => {
  const rows = [job(), job({ job_id: JOB_B, completion_status: "COMPLETED", completed_at: "2026-09-04T10:00:00.000Z" })];
  assert.deepEqual(rows.map(businessCustomerRelationshipInternals.workActivityProjection).map((item) => item.jobId), [JOB_A, JOB_B]);
});

test("fixture 5: repeat Jobs share one relationship scope without collapsing Job identity", () => {
  assert.match(source, /parties\.business_customer_relationship_id = \$3/);
  assert.match(source, /ORDER BY COALESCE\(completions\.completed_at, jobs\.created_at\) DESC,[\s\S]*jobs\.id ASC/);
});

test("fixture 6: external business-origin Job uses its governed document title", () => {
  const projected = businessCustomerRelationshipInternals.workActivityProjection(job({ source_type: "business_document", service_title: "Exterior trim repair" }));
  assert.equal(projected.sourceType, "business_document");
  assert.equal(projected.title, "Exterior trim repair");
  assert.match(source, /documents\.content->>'projectTitle'/);
});

test("fixture 7: marketplace-origin Job is readable only when an exact Job customer party exists", () => {
  assert.equal(businessCustomerRelationshipInternals.workActivityProjection(job()).sourceType, "ordinary_request_selection");
  assert.match(source, /FROM job_customer_parties parties[\s\S]*INNER JOIN jobs ON jobs\.id = parties\.job_id/);
});

test("fixture 8: same display name in two businesses cannot cross the business scope", () => {
  assert.match(source, /parties\.contractor_profile_id = \$1/);
  assert.doesNotMatch(source, /contacts\.display_name/);
});

test("fixture 9: similar customer names are never reconciliation input", () => {
  assert.doesNotMatch(source, /similarity|levenshtein|soundex|lower\([^)]*(?:name|email|phone)/i);
});

test("fixture 10: Quote history is exact Job and customer-party scoped", () => {
  assert.match(source, /FROM canonical_quote_customer_parties[\s\S]*quotes\.job_id = parties\.job_id/);
  assert.match(source, /INNER JOIN canonical_quotes q ON q\.job_id = p\.job_id/);
  assert.match(source, /WHERE explicit_party\.quote_id = q\.id/);
});

test("fixture 11: Deposit and payment history start from the exact linked Job", () => {
  assert.match(source, /activity_deposits[\s\S]*job_customer_parties parties JOIN canonical_pre_work_deposit_obligations/);
  assert.match(source, /activity_payments[\s\S]*job_customer_parties parties JOIN canonical_pre_work_payment_receipts/);
  assert.match(source, /canonical_invoice_payments receipt ON receipt\.job_id=parties\.job_id/);
});

test("fixture 12: Visit and Schedule history uses canonical Visit versions under the linked Job", () => {
  const projected = businessCustomerRelationshipInternals.visitActivityProjection({ visit_id: "55555555-5555-4555-8555-555555555555", job_id: JOB_A, purpose: "APPROVED_WORK", state: "SCHEDULED", scheduled_start_at: "2026-09-05T14:00:00.000Z", scheduled_end_at: "2026-09-05T16:00:00.000Z", time_zone: "America/New_York", location_mode: "JOB_SERVICE_LOCATION", completed_at: null, created_at: "2026-09-02T10:00:00.000Z" });
  assert.equal(projected.jobId, JOB_A);
  assert.equal(projected.state, "SCHEDULED");
  assert.match(source, /canonical_visit_versions/);
});

test("fixture 13: completed work keeps canonical activity and workstream identity", () => {
  const projected = businessCustomerRelationshipInternals.workPerformedActivityProjection({ activity_id: "66666666-6666-4666-8666-666666666666", job_id: JOB_A, workstream_id: "77777777-7777-4777-8777-777777777777", workstream_title: "Install fixture", statement: "Installed and tested the fixture.", status: "DONE", performed_at: "2026-09-05T16:00:00.000Z", created_at: "2026-09-04T10:00:00.000Z" });
  assert.equal(projected.status, "DONE");
  assert.equal(projected.statement, "Installed and tested the fixture.");
});

test("fixture 14: final Invoice remains exact Job and customer-party scoped", () => {
  assert.match(source, /FROM canonical_invoice_customer_parties[\s\S]*invoices\.job_id = parties\.job_id/);
  assert.match(source, /INNER JOIN canonical_invoices i ON i\.job_id = p\.job_id/);
  assert.match(source, /WHERE explicit_party\.invoice_id = i\.id/);
  assert.match(source, /current\.paid_minor/);
  assert.match(source, /current\.balance_minor/);
});

test("fixture 15: documents and request photos preserve the canonical Job parent", () => {
  const document = businessCustomerRelationshipInternals.documentActivityProjection({ quote_id: "88888888-8888-4888-8888-888888888888", job_id: JOB_A, job_title: "Kitchen faucet installation", document_number: "Q-0001", status: "ISSUED", created_at: "2026-09-02T10:00:00.000Z" }, "QUOTE");
  assert.equal(document.parentId, JOB_A);
  assert.match(source, /photo\.item->>'purpose' = 'request-photo'/);
});

test("fixture 16: an unlinked Job cannot be guessed into Customer History", () => {
  assert.match(source, /FROM job_customer_parties parties\s+INNER JOIN jobs/);
  assert.doesNotMatch(source, /contacts\.(?:display_name|email|phone)/);
  assert.doesNotMatch(source, /request_relationships/);
});
