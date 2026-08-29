"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  createVisitHandlers,
  sendVisitResult,
} = require("../server/workflow/visits");
const {
  createWorkstreamHandlers,
  sendWorkflowResult,
} = require("../server/workflow/workstreams");

const source = (file) => readFileSync(
  join(__dirname, "..", "server", "workflow", file),
  "utf8"
);

function response() {
  return {
    statusCode: null,
    body: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("D4 uses one exact-decision readiness gate for Activity and Approved Work Visit start", () => {
  const execution = source("approvedWorkExecutionService.js");
  const preparation = source("workPreparationService.js");
  const workstream = source("workstreamService.js");
  const visit = source("visitService.js");

  assert.match(execution, /async function evaluateApprovedWorkStartReadinessWithClient/);
  assert.match(workstream, /evaluateApprovedWorkStartReadinessWithClient\(/);
  assert.match(visit, /evaluateApprovedWorkStartReadinessWithClient\(/);
  assert.match(preparation, /loadPlanByDecision\(client, jobId, decisionId/);
  assert.doesNotMatch(
    preparation.slice(
      preparation.indexOf("async function evaluateWorkPreparationStartWithClient"),
      preparation.indexOf("function workStartFailure")
    ),
    /loadPlan\(client, jobId, null/
  );
  assert.match(execution, /approved_work\.execution\.start\.record/);
});

test("Activity start preserves ordinary progress while classified execution cannot bypass D4", () => {
  const workstream = source("workstreamService.js");
  assert.match(workstream, /classification === "EXECUTION" && !approvedWorkExecutionId/);
  assert.match(workstream, /sourceType: "EXECUTION_ACTIVITY"/);
  assert.match(workstream, /expectedActivityVersion: expectedVersion/);
  assert.match(workstream, /targetStatus === "IN_PROGRESS" \? "SERIALIZABLE"/);
  assert.match(workstream, /recordApprovedWorkStartWithClient\(/);
  assert.match(workstream, /approvedWorkStartEvent/);
});

test("Approved Work Visit start is gated while Evaluation Visit timing behavior stays separate", () => {
  const visit = source("visitService.js");
  assert.match(visit, /current\.purpose === "APPROVED_WORK"/);
  assert.match(visit, /approvedCustomerDecisionId: current\.approved_quote_decision_id/);
  assert.match(visit, /sourceType: "APPROVED_WORK_VISIT"/);
  assert.match(visit, /current\.purpose !== "APPROVED_WORK"/);
  assert.match(visit, /EARLY_START_WINDOW_MS = 30 \* 60 \* 1000/);
  assert.match(visit, /commandName === VISIT_COMMANDS\.START \? "SERIALIZABLE"/);
});

test("D4 routes forward only bounded execution identity and expected version", async () => {
  const calls = [];
  const workstreamHandlers = createWorkstreamHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service: {
      progressWorkActivity: async (input) => {
        calls.push(["activity", input]);
        return { ok: true, status: 200, code: "WORK_ACTIVITY_PROGRESSED" };
      },
    },
  });
  const visitHandlers = createVisitHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service: {
      startVisit: async (input) => {
        calls.push(["visit", input]);
        return { ok: true, status: 200, code: "VISIT_STARTED" };
      },
    },
  });
  const base = {
    user: { id: 7 },
    params: { jobId: "job", workstreamId: "workstream", activityId: "activity" },
    body: {
      expectedVersion: 1,
      targetStatus: "IN_PROGRESS",
      approvedWorkExecutionId: "execution",
      expectedExecutionVersion: 2,
      ignoredAuthority: "never-forwarded",
    },
    headers: { "idempotency-key": "start-key" },
  };
  await workstreamHandlers.progressActivity(base, response());
  await visitHandlers.startVisit({
    ...base,
    params: { jobId: "job", visitId: "visit" },
    body: {
      expectedVersion: 3,
      acknowledgeScheduleVariance: true,
      approvedWorkExecutionId: "execution",
      expectedExecutionVersion: 2,
      ignoredAuthority: "never-forwarded",
    },
  }, response());

  assert.deepEqual(calls[0], ["activity", {
    pool: "pool",
    authenticatedActor: { id: 7 },
    jobId: "job",
    workstreamId: "workstream",
    activityId: "activity",
    expectedVersion: 1,
    targetStatus: "IN_PROGRESS",
    approvedWorkExecutionId: "execution",
    expectedExecutionVersion: 2,
    idempotencyKey: "start-key",
  }]);
  assert.deepEqual(calls[1], ["visit", {
    pool: "pool",
    authenticatedActor: { id: 7 },
    jobId: "job",
    visitId: "visit",
    expectedVersion: 3,
    idempotencyKey: "start-key",
    acknowledgeScheduleVariance: true,
    approvedWorkExecutionId: "execution",
    expectedExecutionVersion: 2,
  }]);
});

test("D4 public senders expose bounded readiness and start-event projections", () => {
  const readiness = { ready: true, blockers: [] };
  const event = { id: "event", sourceType: "EXECUTION_ACTIVITY" };
  const workflow = response();
  sendWorkflowResult(workflow, {
    ok: true,
    status: 200,
    code: "WORK_ACTIVITY_PROGRESSED",
    approvedWorkStart: readiness,
    approvedWorkStartEvent: event,
    internal: "hidden",
  });
  assert.deepEqual(workflow.body, {
    success: true,
    code: "WORK_ACTIVITY_PROGRESSED",
    approvedWorkStart: readiness,
    approvedWorkStartEvent: event,
  });
  const visit = response();
  sendVisitResult(visit, {
    ok: true,
    status: 200,
    code: "VISIT_STARTED",
    approvedWorkStart: readiness,
    approvedWorkStartEvent: event,
    internal: "hidden",
  });
  assert.deepEqual(visit.body, {
    success: true,
    code: "VISIT_STARTED",
    approvedWorkStart: readiness,
    approvedWorkStartEvent: event,
  });
});
