"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  buildCustomerProjection,
  buildProfessionalProjection,
  getProfessionalWorkPlanSummary,
} = require("../server/workflow/workPlanService");

const IDS = Object.freeze({
  job: "00000000-0000-4000-8000-000000000001",
  workstream: "00000000-0000-4000-8000-000000000002",
  activity: "00000000-0000-4000-8000-000000000003",
  obligation: "00000000-0000-4000-8000-000000000004",
  quote: "00000000-0000-4000-8000-000000000005",
});

function fixture() {
  const context = {
    job_id: IDS.job,
    job_request_id: 14,
    relationship_id: 340,
    active_capabilities: [
      "workstream.read",
      "work_activity.create",
      "work_activity.progress",
      "workstream.complete",
    ],
  };
  const approvedWork = {
    quotes: [{ id: IDS.quote, lineage_type: null }],
    workstreamLinks: [{ workstream_id: IDS.workstream, quote_id: IDS.quote }],
  };
  const rows = {
    workstreams: [{
      id: IDS.workstream, sequence: 1, version: 2, title: "Replace failed disposal",
      state: "ACTIVE", updated_at: "2026-08-15T10:00:00.000Z",
    }],
    activities: [{
      id: IDS.activity, workstream_id: IDS.workstream, version: 2,
      activity_type: "REPAIR", statement: "Replacement is underway.",
      status: "IN_PROGRESS", customer_visible: true, performed_at: null,
      created_at: "2026-08-15T09:00:00.000Z",
      updated_at: "2026-08-15T10:00:00.000Z",
      internal_cost: 50000,
    }],
    obligations: [{
      id: IDS.obligation, workstream_id: IDS.workstream, sequence: 1,
      version: 1, statement: "Internal access blocker", status: "OPEN",
      updated_at: "2026-08-15T10:00:00.000Z",
    }],
    findingStates: [],
    updates: [{
      activity_id: IDS.activity, workstream_id: IDS.workstream, version: 2,
      statement: "Replacement is underway.", status: "IN_PROGRESS",
      customer_visible: true, created_at: "2026-08-15T10:00:00.000Z",
      margin: 0.5,
    }],
  };
  return { context, approvedWork, rows };
}

test("professional Work Plan derives actions, blockers, counts, and approved Quote lineage", () => {
  const projection = buildProfessionalProjection(fixture());
  assert.equal(projection.contractVersion, 1);
  assert.deepEqual(projection.approvedQuotes, [{ id: IDS.quote, lineageType: "ORIGINAL_QUOTE" }]);
  assert.equal(projection.summary.workItemCount, 1);
  assert.equal(projection.summary.remainingCount, 1);
  assert.equal(projection.summary.needsAttentionCount, 1);
  assert.equal(projection.summary.readyForCompletionReview, false);
  assert.equal(projection.workstreams[0].status, "NEEDS_ATTENTION");
  assert.equal(projection.workstreams[0].canAddWorkItem, true);
  assert.equal(projection.workstreams[0].canMarkComplete, false);
  assert.equal(projection.workstreams[0].activities[0].canComplete, true);
  assert.equal(projection.workstreams[0].activities[0].updates.length, 1);
});

test("finished items remain In Progress until the Work Area is canonically completed", () => {
  const input = fixture();
  input.rows.activities[0].status = "DONE";
  input.rows.activities[0].performed_at = "2026-08-15T11:00:00.000Z";
  input.rows.obligations[0].status = "SATISFIED";

  const professional = buildProfessionalProjection(input);
  const customer = buildCustomerProjection({ context: input.context, rows: input.rows });
  assert.equal(professional.workstreams[0].status, "IN_PROGRESS");
  assert.equal(professional.workstreams[0].canMarkComplete, true);
  assert.equal(professional.summary.readyForCompletionReview, false);
  assert.equal(customer.workstreams[0].status, "IN_PROGRESS");
  assert.equal(customer.summary.readyForCompletionReview, false);

  input.rows.workstreams[0].state = "COMPLETED";
  assert.equal(buildProfessionalProjection(input).workstreams[0].status, "COMPLETED");
  assert.equal(
    buildCustomerProjection({ context: input.context, rows: input.rows }).workstreams[0].status,
    "COMPLETED"
  );
});

test("customer Work Plan allowlists explicit progress and excludes operational internals", () => {
  const { context, rows } = fixture();
  const projection = buildCustomerProjection({ context, rows });
  assert.equal(projection.workstreams[0].activities[0].statement, "Replacement is underway.");
  assert.equal(projection.workstreams[0].updates[0].statement, "Replacement is underway.");
  assert.equal(projection.workstreams[0].status, "IN_PROGRESS");
  assert.deepEqual(Object.keys(projection.workstreams[0].activities[0]).sort(), [
    "id",
    "performedAt",
    "statement",
    "status",
    "updatedAt",
  ]);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(
    serialized,
    /internal access blocker|internal_cost|margin|customerVisible|currentVersion|approvedQuote|grant|hash|idempotency/i
  );
});

test("customer Work Plan suppresses professional-only Activity text", () => {
  const { context, rows } = fixture();
  rows.activities[0].customer_visible = false;
  rows.updates[0].customer_visible = false;
  const projection = buildCustomerProjection({ context, rows });
  assert.deepEqual(projection.workstreams[0].activities, []);
  assert.deepEqual(projection.workstreams[0].updates, []);
});

test("professional-wide summary is one bounded query and never performs per-Job discovery", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
      return { rows: [{
        job_id: IDS.job, job_request_id: 14, relationship_id: 340,
        title: "Kitchen repair", customer_name: "Liam",
        workstream_count: 1, work_item_count: 3, completed_count: 2,
        remaining_count: 1, needs_attention_count: 0,
        ready_for_completion_review: false,
      }] };
    },
  };
  const result = await getProfessionalWorkPlanSummary({
    pool,
    authenticatedActor: { id: 12 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.workPlanSummary.jobCount, 1);
  assert.equal(result.workPlanSummary.workItemCount, 3);
  assert.equal(statements.filter((sql) => /WITH professional_jobs/.test(sql)).length, 1);
  assert.equal(statements.length, 3);
});

test("Work Plan source filters executable work through exact approved Quote snapshots", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "workflow", "workPlanService.js"),
    "utf8"
  );
  assert.match(source, /decisions\.decision = 'APPROVED'/);
  assert.match(source, /decisions\.issued_quote_version = snapshots\.quote_version/);
  assert.match(source, /snapshots\.source_workstream_id IS NOT NULL/);
  assert.match(source, /canonical_quote_scope_item_snapshots snapshots/);
  assert.match(source, /snapshots\.included_in_total = TRUE/);
  assert.doesNotMatch(
    source,
    /localStorage|activeJobs|workflow_quote_sent|job\.complete\b|invoice|payment/i
  );
});
