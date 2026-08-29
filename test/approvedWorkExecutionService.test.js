"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  CAPABILITIES,
  COMMANDS,
  EXECUTION_STATES,
  approvedWorkExecutionServiceInternals,
} = require("../server/workflow/approvedWorkExecutionService");

const source = readFileSync(
  join(__dirname, "..", "server", "workflow", "approvedWorkExecutionService.js"),
  "utf8"
);

test("runtime uses only Migration 61 capabilities, commands, and states", () => {
  assert.deepEqual(Object.values(CAPABILITIES).sort(), [
    "approved_work.execute",
    "approved_work.execution.manage",
  ]);
  assert.deepEqual(new Set(Object.values(COMMANDS)), new Set([
    "approved_work.execution.materialize",
    "approved_work.execution.bind_workstream",
    "approved_work.execution.classify_activity",
    "approved_work.execution.supersede",
    "approved_work.execution.close",
    "approved_work.execution.reconcile_legacy",
    "approved_work.execution.start.record",
  ]));
  assert.deepEqual(EXECUTION_STATES, new Set(["ACTIVE", "SUPERSEDED", "CLOSED"]));
});

test("materialization resolves exact approved decision and immutable issuance integrity", () => {
  assert.match(source, /decisions\.id = \$2/);
  assert.match(source, /decisions\.decision = 'APPROVED'/);
  assert.match(source, /quotes\.status = 'ISSUED'/);
  assert.match(source, /versions\.version = decisions\.issued_quote_version/);
  assert.match(source, /issuances\.source_snapshot_integrity_hash = decisions\.issued_integrity_hash/);
  assert.match(source, /source\.issued_integrity_hash !== source\.quote_version_integrity_hash/);
  assert.match(source, /source\.issued_integrity_hash !== source\.issuance_integrity_hash/);
  assert.match(source, /roles\.role = 'PRIMARY_PROFESSIONAL'/);
});

test("explicit materialization bootstraps decision-scoped execution capabilities from Quote read", () => {
  assert.match(source, /capability: QUOTE_READ_CAPABILITY/);
  assert.match(source, /scope_type = 'approved_work'/);
  assert.match(source, /scope_approved_quote_decision_id = \$4/);
  assert.match(source, /canonical_approved_work_execution/);
  assert.doesNotMatch(source, /approved_work\.execution\.[a-z_]+[^\n]*lifecycle_capabilities/i);
});

test("classification shape is explicit and TOTAL_ONLY-safe", () => {
  const decisionWide = approvedWorkExecutionServiceInternals.normalizeClassificationInput({
    classification: "execution",
    scopeBasis: "decision_wide",
  });
  assert.deepEqual(decisionWide, {
    classification: "EXECUTION",
    scopeBasis: "DECISION_WIDE",
    sourceScopeItemId: null,
  });
  assert.deepEqual(
    approvedWorkExecutionServiceInternals.normalizeClassificationInput({
      classification: "NON_EXECUTION",
    }),
    { classification: "NON_EXECUTION", scopeBasis: null, sourceScopeItemId: null }
  );
  assert.equal(
    approvedWorkExecutionServiceInternals.normalizeClassificationInput({
      classification: "NON_EXECUTION",
      scopeBasis: "DECISION_WIDE",
    }),
    null
  );
  assert.equal(
    approvedWorkExecutionServiceInternals.normalizeClassificationInput({
      classification: "EXECUTION",
      scopeBasis: "QUOTE_SCOPE_ITEM",
    }),
    null
  );
});

test("runtime records D4 start evidence without mutating base Workstream, Activity, Visit, Quote, or Invoice truth", () => {
  assert.doesNotMatch(source, /UPDATE\s+canonical_workstreams/i);
  assert.doesNotMatch(source, /UPDATE\s+canonical_workstream_versions/i);
  assert.doesNotMatch(source, /UPDATE\s+canonical_work_activities/i);
  assert.doesNotMatch(source, /UPDATE\s+canonical_work_activity_versions/i);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE)\s+canonical_visits/i);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE)\s+canonical_visit_versions/i);
  assert.match(source, /INSERT INTO\s+canonical_approved_work_execution_start_events/i);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE)\s+canonical_quote_(?:versions|customer_decisions)/i);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE)\s+canonical_invoices/i);
});

test("writes use SERIALIZABLE transactions, locks, expected versions, and append-only INSERTs", () => {
  assert.match(source, /runTransaction\(input\.pool, "SERIALIZABLE"/);
  assert.match(source, /FOR UPDATE OF jobs, relationships/);
  assert.match(source, /STALE_APPROVED_WORK_EXECUTION_VERSION/);
  assert.match(source, /STALE_WORK_ACTIVITY_VERSION/);
  assert.match(source, /INSERT INTO canonical_approved_work_execution_versions/);
  assert.doesNotMatch(source, /UPDATE\s+canonical_approved_work_execution_versions/i);
});

test("legacy reconciliation records explicit reason and never manufactures start evidence", () => {
  assert.match(source, /bindWorkstream !== true/);
  assert.match(source, /reason,/);
  assert.match(source, /startEventsCreated: 0/);
  assert.doesNotMatch(source, /activity_type\s*===\s*["'](?:REPAIR|INSTALLATION|RESTORATION|INSPECTION)/i);
  assert.doesNotMatch(source, /status\s*===\s*["'](?:IN_PROGRESS|DONE)["'][\s\S]*insert.*start/i);
});

test("Complete Work is one SERIALIZABLE, expected-versioned execution command", () => {
  assert.match(source, /async function completeApprovedWork/);
  assert.match(source, /commandScope: `execution:\$\{executionId\}:complete-work`/);
  assert.match(source, /commandName: COMMANDS\.CLOSE/);
  assert.match(source, /expectedExecutionVersion/);
  assert.match(source, /expectedWorkstreams/);
  assert.match(source, /expectedActivities/);
  assert.match(source, /STALE_APPROVED_WORK_COMPLETION_SNAPSHOT/);
  assert.match(source, /APPROVED_WORK_EXECUTION_IDEMPOTENCY_CONFLICT/);
  assert.match(source, /"COMPLETE_WORK"/);
  assert.doesNotMatch(source, /actions\.push\("SUPERSEDE", "CLOSE"\)/);
});

test("Complete Work requires start evidence, exact lineage, and execution authority", () => {
  assert.match(source, /CAPABILITIES\.EXECUTE/);
  assert.match(source, /APPROVED_WORK_EXECUTION_LINEAGE_INVALID/);
  assert.match(source, /canonical_approved_work_execution_start_events/);
  assert.match(source, /APPROVED_WORK_NOT_STARTED/);
  assert.match(source, /APPROVED_WORK_EXECUTION_NOT_ACTIVE/);
});

test("Complete Work reconciles only EXECUTION Activities and bound Workstreams", () => {
  assert.match(source, /classifications\.classification = 'EXECUTION'/);
  assert.match(source, /canonical_approved_work_execution_workstreams bindings/);
  assert.match(source, /activity\.status === "DONE"/);
  assert.match(source, /'DONE'/);
  assert.match(source, /workstream\.state === "COMPLETED"/);
  assert.match(source, /'COMPLETED'/);
  assert.match(source, /after_activity_reconciliation/);
  assert.match(source, /after_workstream_reconciliation/);
  assert.match(source, /after_execution_completion/);
});

test("Complete Work uses existing durable execution evidence and has no financial side effects", () => {
  const start = source.indexOf("async function completeApprovedWork");
  const end = source.indexOf("function childIdempotencyKey", start);
  const completeSource = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(completeSource, /INSERT INTO canonical_approved_work_execution_versions/);
  assert.match(completeSource, /code: "APPROVED_WORK_COMPLETED"/);
  assert.match(completeSource, /state: "WORK_COMPLETED"/);
  assert.match(completeSource, /code: "READY_TO_INVOICE"/);
  assert.doesNotMatch(completeSource, /canonical_job_completion_records/);
  assert.doesNotMatch(completeSource, /canonical_invoices/);
  assert.doesNotMatch(completeSource, /canonical_invoice_payments/);
  assert.doesNotMatch(completeSource, /canonical_pre_work_payment_receipts/);
});

test("completion version lists are canonicalized and reject duplicates", () => {
  assert.deepEqual(
    approvedWorkExecutionServiceInternals.normalizeExpectedVersions([
      { workstreamId: "00000000-0000-4000-8000-000000000002", expectedVersion: 3 },
      { workstreamId: "00000000-0000-4000-8000-000000000001", expectedVersion: 2 },
    ], "workstreamId"),
    [
      { id: "00000000-0000-4000-8000-000000000001", expectedVersion: 2 },
      { id: "00000000-0000-4000-8000-000000000002", expectedVersion: 3 },
    ]
  );
  assert.equal(
    approvedWorkExecutionServiceInternals.normalizeExpectedVersions([
      { activityId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1 },
      { activityId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1 },
    ], "activityId"),
    null
  );
});

test("completion blocker reasons preserve canonical operational blockers", () => {
  assert.deepEqual(
    approvedWorkExecutionServiceInternals.completionBlockerReasons(
      [{ state: "BLOCKED" }],
      { openFindings: 1, partialFindings: 1, openObligations: 1 }
    ),
    [
      "BLOCKED_WORKSTREAM",
      "INELIGIBLE_WORKSTREAM_STATE",
      "OPEN_FINDING",
      "PARTIAL_FINDING",
      "OPEN_OBLIGATION",
    ]
  );
});
