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
