"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createApprovedWorkExecutionHandlers,
  registerApprovedWorkExecutionRoutes,
  sendApprovedWorkExecutionResult,
} = require("../server/workflow/approvedWorkExecutions");

function response() {
  return {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test("routes register the bounded Job-scoped Approved Work execution family", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
  };
  const auth = () => {};
  registerApprovedWorkExecutionRoutes({
    app,
    authMiddleware: auth,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /jobs/:jobId/approved-work-executions",
    "GET /jobs/:jobId/approved-work-executions/:executionId",
    "POST /jobs/:jobId/approved-work-executions/materialize",
    "POST /jobs/:jobId/approved-work-executions/:executionId/workstreams/:workstreamId",
    "POST /jobs/:jobId/approved-work-executions/:executionId/activities/:activityId/classification",
    "POST /jobs/:jobId/approved-work-executions/:executionId/legacy-reconciliation",
    "POST /jobs/:jobId/approved-work-executions/:executionId/supersede",
    "POST /jobs/:jobId/approved-work-executions/:executionId/close",
  ]);
  assert.ok(routes.every((route) => route.handlers[0] === auth));
});

test("handlers map only bounded client fields and Idempotency-Key", async () => {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, operation) {
      return async (input) => {
        calls.push({ operation, input });
        return { ok: true, status: 200, code: "OK" };
      };
    },
  });
  const handlers = createApprovedWorkExecutionHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError: () => {},
    service,
  });
  const req = {
    user: { id: 7 },
    params: {
      jobId: "00000000-0000-4000-8000-000000000001",
      executionId: "00000000-0000-4000-8000-000000000002",
      activityId: "00000000-0000-4000-8000-000000000003",
    },
    headers: { "idempotency-key": "classification-1" },
    body: {
      workstreamId: "00000000-0000-4000-8000-000000000004",
      expectedExecutionVersion: 1,
      expectedActivityVersion: 2,
      classification: "EXECUTION",
      scopeBasis: "DECISION_WIDE",
      executionState: "ACTIVE",
      startedAt: "2026-01-01T00:00:00Z",
    },
  };
  await handlers.classifyActivity(req, response());
  const input = calls[0].input;
  assert.equal(calls[0].operation, "classifyWorkActivity");
  assert.equal(input.idempotencyKey, "classification-1");
  assert.equal("executionState" in input, false);
  assert.equal("startedAt" in input, false);
});

test("GET responses are private/no-store and create no write input", async () => {
  const calls = [];
  const handlers = createApprovedWorkExecutionHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError: () => {},
    service: {
      listApprovedWorkExecutions: async (input) => {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          code: "APPROVED_WORK_EXECUTIONS_FOUND",
          executions: [],
        };
      },
    },
  });
  const res = response();
  await handlers.list({ user: { id: 1 }, params: { jobId: "job" } }, res);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal("idempotencyKey" in calls[0], false);
  assert.deepEqual(res.payload.executions, []);
});

test("public sender preserves bounded failures and strips undefined fields", () => {
  const res = response();
  sendApprovedWorkExecutionResult(res, {
    ok: false,
    status: 409,
    code: "APPROVED_WORK_EXECUTION_NOT_ACTIVE",
    message: "Only an active execution can accept Workstreams.",
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, {
    success: false,
    code: "APPROVED_WORK_EXECUTION_NOT_ACTIVE",
    message: "Only an active execution can accept Workstreams.",
  });
});

