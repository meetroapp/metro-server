"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  ACTIVITY_TRANSITIONS,
  FINDING_RESOLUTION_TRANSITIONS,
  OBLIGATION_TRANSITIONS,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_COMMANDS,
  completeWorkstream,
  createWorkActivity,
  createWorkObligation,
  createWorkstream,
  progressWorkActivity,
  resolveFinding,
  transitionWorkObligation,
  updateWorkActivity,
} = require("../server/workflow/workstreamService");
const {
  PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
} = require("../server/workflow/jobFoundationService");

const source = readFileSync(
  join(__dirname, "..", "server", "workflow", "workstreamService.js"),
  "utf8"
);

test("Slice 003 exposes exactly eleven bounded operational capabilities", () => {
  assert.deepEqual(Object.values(WORKFLOW_CAPABILITIES).sort(), [
    "finding.assign_workstream",
    "finding.resolve",
    "work_activity.create",
    "work_activity.progress",
    "work_activity.read",
    "work_obligation.create",
    "work_obligation.read",
    "work_obligation.transition",
    "workstream.complete",
    "workstream.create",
    "workstream.read",
  ]);
  assert.deepEqual(Object.values(WORKFLOW_COMMANDS).sort(), [
    "finding.assign_workstream",
    "finding.resolve",
    "work_activity.create",
    "work_activity.progress",
    "work_activity.update",
    "work_obligation.create",
    "work_obligation.transition",
    "workstream.complete",
    "workstream.create",
  ]);
  for (const capability of Object.values(WORKFLOW_CAPABILITIES)) {
    assert.equal(PROFESSIONAL_BOOTSTRAP_CAPABILITIES.includes(capability), true);
  }
  assert.equal(
    PROFESSIONAL_BOOTSTRAP_CAPABILITIES.some((capability) =>
      /job\.complete|quote\.(?:approve|decline)|scheduling|procurement/.test(capability)
    ),
    false
  );
  assert.deepEqual(
    PROFESSIONAL_BOOTSTRAP_CAPABILITIES.filter((capability) =>
      capability.startsWith("quote.")
    ).sort(),
    ["quote.create", "quote.issue", "quote.read", "quote.revise", "quote.scope.manage"]
  );
  assert.deepEqual(
    PROFESSIONAL_BOOTSTRAP_CAPABILITIES.filter((capability) =>
      capability.startsWith("recommendation.") ||
      capability === "customer_constraint.record"
    ).sort(),
    [
      "customer_constraint.record",
      "recommendation.create",
      "recommendation.read",
      "recommendation.transition",
    ]
  );
});

test("Finding and obligation transitions are explicit and terminal", () => {
  assert.deepEqual([...FINDING_RESOLUTION_TRANSITIONS.OPEN], [
    "PARTIALLY_RESOLVED",
    "RESOLVED",
    "DEFERRED",
  ]);
  assert.deepEqual([...FINDING_RESOLUTION_TRANSITIONS.PARTIALLY_RESOLVED], [
    "RESOLVED",
    "DEFERRED",
  ]);
  assert.deepEqual([...FINDING_RESOLUTION_TRANSITIONS.RESOLVED], []);
  assert.deepEqual([...FINDING_RESOLUTION_TRANSITIONS.DEFERRED], []);
  assert.deepEqual([...OBLIGATION_TRANSITIONS.OPEN], [
    "SATISFIED",
    "DEFERRED",
    "EXCLUDED",
  ]);
  assert.deepEqual([...OBLIGATION_TRANSITIONS.SATISFIED], []);
  assert.deepEqual([...OBLIGATION_TRANSITIONS.DEFERRED], []);
  assert.deepEqual([...OBLIGATION_TRANSITIONS.EXCLUDED], []);
});

test("Activity progression is forward-only and terminal states have no exits", () => {
  assert.deepEqual([...ACTIVITY_TRANSITIONS.PLANNED], ["IN_PROGRESS", "CANCELLED"]);
  assert.deepEqual([...ACTIVITY_TRANSITIONS.IN_PROGRESS], ["DONE", "CANCELLED"]);
  assert.deepEqual([...ACTIVITY_TRANSITIONS.DONE], []);
  assert.deepEqual([...ACTIVITY_TRANSITIONS.CANCELLED], []);
});

test("invalid and server-owned workflow inputs fail before database access", async () => {
  const pool = { query() { throw new Error("database must not be reached"); } };
  const actor = { id: 7 };
  assert.equal((await createWorkstream({
    pool,
    authenticatedActor: actor,
    jobId: "not-a-job",
    title: "Disposal",
    sequence: 1,
    idempotencyKey: "workstream-key",
  })).code, "INVALID_WORKSTREAM");
  assert.equal((await createWorkActivity({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    workstreamId: "00000000-0000-4000-8000-000000000002",
    activityType: "RESTORATION",
    statement: "Temporary restoration",
    temporaryIntervention: true,
    temporaryDetails: "",
    idempotencyKey: "activity-key",
  })).code, "INVALID_WORK_ACTIVITY");
  assert.equal((await progressWorkActivity({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    workstreamId: "00000000-0000-4000-8000-000000000002",
    activityId: "00000000-0000-4000-8000-000000000003",
    expectedVersion: 1,
    targetStatus: "RESOLVED",
    idempotencyKey: "progress-key",
  })).code, "INVALID_ACTIVITY_PROGRESSION");
  assert.equal((await updateWorkActivity({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    workstreamId: "00000000-0000-4000-8000-000000000002",
    activityId: "00000000-0000-4000-8000-000000000003",
    expectedVersion: 1,
    statement: "Progress",
    customerVisible: "yes",
    idempotencyKey: "update-key",
  })).code, "INVALID_WORK_ACTIVITY_UPDATE");
  assert.equal((await createWorkObligation({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    workstreamId: "00000000-0000-4000-8000-000000000002",
    sequence: 1,
    statement: "Replace disposal",
    status: "SATISFIED",
    idempotencyKey: "obligation-key",
  })).code, "WORKFLOW_AUTHORITY_FIELD_REJECTED");
  assert.equal((await resolveFinding({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    findingId: "00000000-0000-4000-8000-000000000003",
    expectedVersion: 2,
    expectedResolutionState: "RESOLVED",
    targetResolutionState: "OPEN",
    resolutionStatement: "Reopen it",
    idempotencyKey: "resolution-key",
  })).code, "INVALID_FINDING_RESOLUTION");
  assert.equal((await transitionWorkObligation({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    workstreamId: "00000000-0000-4000-8000-000000000002",
    obligationId: "00000000-0000-4000-8000-000000000003",
    expectedVersion: 1,
    targetStatus: "OPEN",
    idempotencyKey: "obligation-transition-key",
  })).code, "INVALID_WORK_OBLIGATION_TRANSITION");
  assert.equal((await completeWorkstream({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    workstreamId: "00000000-0000-4000-8000-000000000002",
    expectedVersion: 1,
    eligible: true,
    idempotencyKey: "completion-key",
  })).code, "WORKFLOW_AUTHORITY_FIELD_REJECTED");
});

test("runtime source contains no Job completion, Quote, Recommendation, or delete authority", () => {
  assert.doesNotMatch(
    source,
    /job\.complete|quote\.|recommendation\.|DELETE FROM|UPDATE\s+jobs\b/i
  );
  assert.doesNotMatch(
    source,
    /logger\.(?:info|warn)\([\s\S]{0,350}\b(?:statement|temporaryDetails)\b/i
  );
});
