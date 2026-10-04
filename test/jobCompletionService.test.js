"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  decodeCursor,
  historySummary,
  readinessProjection,
} = require("../server/workflow/jobCompletionService");

const JOB_ID = "00000000-0000-4000-8000-000000000001";

function context(overrides = {}) {
  return {
    job_id: JOB_ID,
    job_request_id: 14,
    relationship_id: 340,
    completion_id: null,
    job_version: null,
    completed_at: null,
    ...overrides,
  };
}

function readiness(overrides = {}) {
  return {
    workstream_count: 2,
    completed_workstream_count: 2,
    work_item_count: 3,
    completed_work_item_count: 3,
    incomplete_work_item_count: 0,
    open_obligation_count: 0,
    unresolved_finding_count: 0,
    customer_update_count: 2,
    evidence_snapshot: {},
    ...overrides,
  };
}

test("completion readiness is server-derived and fails closed for every work gate", () => {
  const eligible = readinessProjection(context(), readiness());
  assert.equal(eligible.currentVersion, 0);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.canComplete, true);

  const blocked = readinessProjection(context(), readiness({
    completed_workstream_count: 1,
    incomplete_work_item_count: 1,
    open_obligation_count: 1,
    unresolved_finding_count: 1,
  }));
  assert.equal(blocked.eligible, false);
  assert.deepEqual(blocked.reasons, [
    "INCOMPLETE_WORKSTREAM",
    "INCOMPLETE_WORK_ITEM",
    "OPEN_OBLIGATION",
    "UNRESOLVED_FINDING",
  ]);
});

test("completed state is immutable terminal truth and no longer actionable", () => {
  const projection = readinessProjection(context({
    completion_id: "completion",
    job_version: 1,
    completed_at: "2026-08-15T12:00:00.000Z",
  }), readiness());
  assert.equal(projection.state, "COMPLETED");
  assert.equal(projection.currentVersion, 1);
  assert.equal(projection.canComplete, false);
  assert.deepEqual(projection.reasons, ["JOB_ALREADY_COMPLETED"]);
});

test("history summary is an explicit business-safe allowlist", () => {
  const summary = historySummary({
    job_id: JOB_ID,
    job_request_id: 14,
    relationship_id: 340,
    conversation_id: 55,
    customer_name: "Liam",
    professional_name: "Meetro QA",
    service_title: "Kitchen repair",
    completed_at: "2026-08-15T12:00:00.000Z",
    workstream_count: 2,
    work_item_count: 3,
    customer_update_count: 2,
    approved_total_minor: 92000,
    approved_currency: "USD",
    internal_cost: 70000,
    margin: 0.2,
    integrity_hash: "secret",
  });
  assert.equal(summary.approvedQuote.totalMinor, 92000);
  assert.equal(summary.nextAction.code, "READY_TO_INVOICE");
  assert.doesNotMatch(JSON.stringify(summary), /internal_cost|margin|hash|grant|idempotency/i);
});

test("history cursor rejects malformed or noncanonical identities", () => {
  assert.deepEqual(decodeCursor(), { completedAt: null, jobId: null });
  assert.equal(decodeCursor("not-a-cursor"), null);
  const invalid = Buffer.from(JSON.stringify({ completedAt: new Date().toISOString(), jobId: "bad" })).toString("base64url");
  assert.equal(decodeCursor(invalid), null);
});

test("completion service contains no Quote, Visit, Invoice, Payment, or Portfolio mutation", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "workflow", "jobCompletionService.js"),
    "utf8"
  );
  assert.match(source, /decisions\.decision = 'APPROVED'/);
  assert.match(source, /status IN \('PLANNED', 'IN_PROGRESS'\)/);
  assert.match(source, /status = 'OPEN'/);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:canonical_quotes|canonical_quote_customer_decisions|canonical_visits|invoices|payments|business_portfolio)/i);
});
