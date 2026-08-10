"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  createWorkstreamHandlers,
  registerWorkstreamRoutes,
} = require("../server/workflow/workstreams");

function response() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("route registration exposes only fifteen authenticated bounded endpoints", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
  };
  const authMiddleware = () => {};
  registerWorkstreamRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.equal(routes.length, 15);
  assert.equal(routes.every((route) => route.handlers[0] === authMiddleware), true);
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "POST /jobs/:jobId/workstreams",
    "GET /jobs/:jobId/workstreams",
    "GET /jobs/:jobId/workstreams/:workstreamId",
    "POST /jobs/:jobId/workstreams/:workstreamId/findings/:findingId/assignment",
    "POST /jobs/:jobId/workstreams/:workstreamId/activities",
    "GET /jobs/:jobId/workstreams/:workstreamId/activities",
    "GET /jobs/:jobId/workstreams/:workstreamId/activities/:activityId",
    "POST /jobs/:jobId/workstreams/:workstreamId/activities/:activityId/progress",
    "POST /jobs/:jobId/workstreams/:workstreamId/obligations",
    "GET /jobs/:jobId/workstreams/:workstreamId/obligations",
    "GET /jobs/:jobId/workstreams/:workstreamId/obligations/:obligationId",
    "POST /jobs/:jobId/findings/:findingId/resolve",
    "POST /jobs/:jobId/workstreams/:workstreamId/obligations/:obligationId/transition",
    "GET /jobs/:jobId/workstreams/:workstreamId/completion-eligibility",
    "POST /jobs/:jobId/workstreams/:workstreamId/complete",
  ]);
});

test("handlers derive actor, scope, version, and idempotency from governed request locations", async () => {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, operation) {
      return async (input) => {
        calls.push({ operation, input });
        return { ok: true, status: 200, code: "TEST_OK", activity: { id: "a" } };
      };
    },
  });
  const handlers = createWorkstreamHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service,
  });
  const req = {
    user: { id: 9 },
    params: { jobId: "job", workstreamId: "workstream", activityId: "activity" },
    body: { expectedVersion: 2, targetStatus: "DONE" },
    headers: { "idempotency-key": "progress-key" },
  };
  const res = response();
  await handlers.progressActivity(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], {
    operation: "progressWorkActivity",
    input: {
      pool: "pool",
      authenticatedActor: { id: 9 },
      jobId: "job",
      workstreamId: "workstream",
      activityId: "activity",
      expectedVersion: 2,
      targetStatus: "DONE",
      idempotencyKey: "progress-key",
    },
  });
});

test("resolution and completion handlers forward only governed command fields", async () => {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, operation) {
      return async (input) => {
        calls.push({ operation, input });
        return { ok: true, status: 200, code: "TEST_OK", eligibility: {} };
      };
    },
  });
  const handlers = createWorkstreamHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service,
  });
  const base = {
    user: { id: 9 },
    params: {
      jobId: "job",
      workstreamId: "workstream",
      findingId: "finding",
    },
    headers: { "idempotency-key": "command-key" },
  };
  await handlers.resolveFinding({
    ...base,
    body: {
      expectedVersion: 2,
      expectedResolutionState: "OPEN",
      targetResolutionState: "RESOLVED",
      resolutionStatement: "Corrected and verified",
    },
  }, response());
  await handlers.completeWorkstream({
    ...base,
    body: { expectedVersion: 1, eligible: true, reasons: [] },
  }, response());
  assert.deepEqual(calls, [
    {
      operation: "resolveFinding",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        findingId: "finding",
        expectedVersion: 2,
        expectedResolutionState: "OPEN",
        targetResolutionState: "RESOLVED",
        resolutionStatement: "Corrected and verified",
        idempotencyKey: "command-key",
      },
    },
    {
      operation: "completeWorkstream",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        workstreamId: "workstream",
        expectedVersion: 1,
        idempotencyKey: "command-key",
      },
    },
  ]);
});

test("route failures retain stable public workflow contracts", async () => {
  const handlers = createWorkstreamHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => { throw new Error("unexpected"); },
    service: {
      createWorkstream: async () => ({
        ok: false,
        status: 403,
        code: "WORKFLOW_AUTHORITY_REQUIRED",
        message: "Workflow authority is required.",
      }),
    },
  });
  const res = response();
  await handlers.createWorkstream({
    user: { id: 7 },
    params: { jobId: "job" },
    body: {},
    headers: {},
  }, res);
  assert.deepEqual(res.body, {
    success: false,
    code: "WORKFLOW_AUTHORITY_REQUIRED",
    message: "Workflow authority is required.",
  });
});

test("route source exposes no Job completion, generic patch, delete, Quote, or Recommendation path", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "workflow", "workstreams.js"),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /app\.(?:patch|delete)|["']\/jobs\/:jobId\/(?:complete|quote|recommendation)|quote\.|recommendation\./i
  );
});
