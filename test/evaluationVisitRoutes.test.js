"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createEvaluationVisitHandlers,
  registerEvaluationVisitRoutes,
} = require("../server/workflow/evaluationVisits");

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("Evaluation Visit routes expose four exact authenticated subject endpoints", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
  };
  const authMiddleware = () => {};
  registerEvaluationVisitRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.equal(routes.length, 4);
  assert.equal(routes.every((route) => route.handlers[0] === authMiddleware), true);
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /jobs/:jobId/evaluations/:evaluationId/visit-authority",
    "POST /jobs/:jobId/evaluations/:evaluationId/visit-authority",
    "GET /jobs/:jobId/evaluations/:evaluationId/visits",
    "GET /jobs/:jobId/evaluations/:evaluationId/visits/:visitId",
  ]);
});

test("handlers derive identity from authenticated route boundaries only", async () => {
  const calls = [];
  const authorityService = {
    getEvaluationVisitAuthority: async (input) => {
      calls.push({ operation: "getAuthority", input });
      return { ok: true, status: 200, code: "TEST", authority: {} };
    },
    activateEvaluationVisitAuthority: async (input) => {
      calls.push({ operation: "activateAuthority", input });
      return { ok: true, status: 201, code: "TEST", authority: {} };
    },
  };
  const canonicalVisitService = {
    listEvaluationVisits: async (input) => {
      calls.push({ operation: "listVisits", input });
      return { ok: true, status: 200, code: "TEST", visits: [] };
    },
    getEvaluationVisit: async (input) => {
      calls.push({ operation: "getVisit", input });
      return { ok: true, status: 200, code: "TEST", visit: {} };
    },
  };
  const handlers = createEvaluationVisitHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    authorityService,
    canonicalVisitService,
  });
  const req = {
    user: { id: 9 },
    params: { jobId: "job", evaluationId: "evaluation", visitId: "visit" },
    headers: { "idempotency-key": "activate-key" },
    body: { capability: "browser-owned", state: "browser-owned" },
  };
  await handlers.getAuthority(req, response());
  await handlers.activateAuthority(req, response());
  await handlers.listVisits(req, response());
  await handlers.getVisit(req, response());
  assert.deepEqual(calls, [
    {
      operation: "getAuthority",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        evaluationId: "evaluation",
      },
    },
    {
      operation: "activateAuthority",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        evaluationId: "evaluation",
        idempotencyKey: "activate-key",
      },
    },
    {
      operation: "listVisits",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        evaluationId: "evaluation",
      },
    },
    {
      operation: "getVisit",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        evaluationId: "evaluation",
        visitId: "visit",
      },
    },
  ]);
});

test("Evaluation Visit reads are private no-store", async () => {
  const handlers = createEvaluationVisitHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => { throw new Error("unexpected"); },
    authorityService: {
      getEvaluationVisitAuthority: async () => ({
        ok: false,
        status: 403,
        code: "EVALUATION_AUTHORITY_REQUIRED",
        message: "Evaluation authority is required.",
      }),
    },
    canonicalVisitService: {
      listEvaluationVisits: async () => ({
        ok: true,
        status: 200,
        code: "EVALUATION_VISITS_FOUND",
        visits: [],
      }),
    },
  });
  for (const handler of [handlers.getAuthority, handlers.listVisits]) {
    const res = response();
    await handler({ user: { id: 7 }, params: {} }, res);
    assert.equal(res.headers["Cache-Control"], "private, no-store");
  }
});
