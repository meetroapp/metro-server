"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createWorkPreparationHandlers,
  registerWorkPreparationRoutes,
  sendWorkPreparationResult,
} = require("../server/workflow/workPreparation");

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

test("routes register the bounded Job-scoped Work Preparation family", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
  };
  const auth = () => {};
  registerWorkPreparationRoutes({
    app,
    authMiddleware: auth,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /jobs/:jobId/work-preparation",
    "POST /jobs/:jobId/work-preparation/materialize",
    "POST /jobs/:jobId/work-preparation/:planId/revisions",
    "POST /jobs/:jobId/work-preparation/:planId/items/:itemId/purchases",
    "POST /jobs/:jobId/work-preparation/:planId/purchases/:purchaseId/corrections",
    "POST /jobs/:jobId/work-preparation/:planId/events",
    "POST /jobs/:jobId/work-preparation/:planId/evidence-references",
  ]);
  assert.ok(routes.every((route) => route.handlers[0] === auth));
});

test("handlers map only bounded client fields and use Idempotency-Key", async () => {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, operation) {
      return async (input) => {
        calls.push({ operation, input });
        return { ok: true, status: 200, code: "OK" };
      };
    },
  });
  const handlers = createWorkPreparationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError: () => {},
    service,
  });
  const req = {
    user: { id: 7 },
    params: {
      jobId: "00000000-0000-4000-8000-000000000001",
      planId: "00000000-0000-4000-8000-000000000002",
      itemId: "00000000-0000-4000-8000-000000000003",
    },
    headers: { "idempotency-key": "purchase-1" },
    body: {
      expectedVersion: 2,
      quantity: 1,
      unit: "each",
      internalCostMinor: 20000,
      internalCostCurrency: "USD",
      depositSatisfied: true,
      purchased: true,
    },
  };
  await handlers.recordPurchase(req, response());
  assert.equal(calls[0].operation, "recordMaterialPurchase");
  assert.equal(calls[0].input.idempotencyKey, "purchase-1");
  assert.equal("depositSatisfied" in calls[0].input, false);
  assert.equal("purchased" in calls[0].input, false);
});

test("GET is private/no-store and response excludes undefined fields", async () => {
  const handlers = createWorkPreparationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError: () => {},
    service: {
      getWorkPreparation: async () => ({
        ok: true,
        status: 200,
        code: "WORK_PREPARATION_NOT_MATERIALIZED",
        workPreparation: { exists: false },
      }),
    },
  });
  const res = response();
  await handlers.getPlan({ user: { id: 1 }, params: { jobId: "job" } }, res);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(res.payload, {
    success: true,
    code: "WORK_PREPARATION_NOT_MATERIALIZED",
    workPreparation: { exists: false },
  });
});

test("public sender preserves bounded failures", () => {
  const res = response();
  sendWorkPreparationResult(res, {
    ok: false,
    status: 409,
    code: "DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT",
    message: "Deposit required.",
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, {
    success: false,
    code: "DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT",
    message: "Deposit required.",
  });
});
