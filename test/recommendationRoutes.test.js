"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRecommendationHandlers,
  registerRecommendationRoutes,
} = require("../server/authorization/recommendations");

function response() {
  return {
    statusCode: null,
    payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test("Recommendation routes register only the bounded Slice 004 surface", () => {
  const routes = [];
  const app = {
    get(path) { routes.push(["GET", path]); },
    post(path) { routes.push(["POST", path]); },
    patch(path) { routes.push(["PATCH", path]); },
  };
  registerRecommendationRoutes({
    app,
    authMiddleware() {},
    getPool() {},
    sendPublicDatabaseError() {},
    service: {},
  });
  assert.deepEqual(routes, [
    ["POST", "/findings/:findingId/recommendations"],
    ["GET", "/findings/:findingId/recommendations"],
    ["GET", "/recommendations/:recommendationId"],
    ["PATCH", "/recommendations/:recommendationId"],
    ["POST", "/recommendations/:recommendationId/constraints"],
    ["POST", "/recommendations/:recommendationId/transition"],
  ]);
  assert.equal(routes.some(([, path]) => /quote|procurement|schedule|job.*complete/i.test(path)), false);
});

test("handlers pass bounded client fields and idempotency", async () => {
  const calls = [];
  const service = {
    async createRecommendation(input) {
      calls.push(["create", input]);
      return { ok: true, status: 201, code: "RECOMMENDATION_CREATED", recommendation: { id: "r" } };
    },
    async listRecommendationsByFinding(input) {
      calls.push(["list", input]);
      return { ok: true, status: 200, code: "RECOMMENDATIONS_FOUND", recommendations: [] };
    },
    async getRecommendation(input) {
      calls.push(["get", input]);
      return { ok: true, status: 200, code: "RECOMMENDATION_FOUND", recommendation: { id: "r" } };
    },
    async updateRecommendation(input) {
      calls.push(["update", input]);
      return { ok: true, status: 200, code: "RECOMMENDATION_UPDATED", recommendation: { id: "r" } };
    },
    async recordCustomerConstraint(input) {
      calls.push(["constraint", input]);
      return { ok: true, status: 201, code: "CUSTOMER_CONSTRAINT_RECORDED", constraint: { id: "c" } };
    },
    async transitionRecommendation(input) {
      calls.push(["transition", input]);
      return { ok: true, status: 200, code: "RECOMMENDATION_TRANSITIONED", dispositionEvent: { id: "e" } };
    },
  };
  const handlers = createRecommendationHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    service,
  });
  const req = {
    user: { id: 7 },
    params: { findingId: "finding", recommendationId: "recommendation" },
    headers: { "idempotency-key": "key" },
    body: {
      kind: "ALTERNATIVE",
      statement: "R-22 recharge - $350",
      customerVisible: true,
      primaryRecommendationId: "primary",
      constraintType: "BUDGET",
      expectedVersion: 1,
      targetStatus: "DEFERRED",
      decisionEvidenceNote: "Customer reported current budget limits.",
    },
  };
  for (const name of [
    "createRecommendation",
    "listRecommendations",
    "getRecommendation",
    "updateRecommendation",
    "recordConstraint",
    "transitionRecommendation",
  ]) {
    const res = response();
    await handlers[name](req, res);
    assert.ok([200, 201].includes(res.statusCode));
    assert.equal(res.payload.success, true);
  }
  assert.equal(calls.length, 6);
  assert.equal(calls[0][1].jobId, undefined);
  assert.equal(calls[3][1].customerVisible, true);
  assert.equal(calls[5][1].targetStatus, "DEFERRED");
  assert.equal(calls[5][1].idempotencyKey, "key");
});

test("handler failures remain public and bounded", async () => {
  const handlers = createRecommendationHandlers({
    getPool() {},
    sendPublicDatabaseError() {},
    service: {
      async createRecommendation() {
        return { ok: false, status: 403, code: "RECOMMENDATION_AUTHORITY_REQUIRED", message: "Denied." };
      },
    },
  });
  const res = response();
  await handlers.createRecommendation({
    user: { id: 1 }, params: {}, headers: {}, body: {},
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, {
    success: false,
    code: "RECOMMENDATION_AUTHORITY_REQUIRED",
    message: "Denied.",
  });
});
