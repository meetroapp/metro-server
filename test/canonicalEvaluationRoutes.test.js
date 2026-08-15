"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-canonical-evaluations";

const { app } = require("../index");
const {
  createEvaluationHandlers,
  registerEvaluationRoutes,
} = require("../server/authorization/evaluations");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function route(method, path) {
  return app.router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
}

test("only the thirteen bounded authenticated Evaluation and Finding routes are registered", () => {
  const expected = [
    ["post", "/jobs/:jobId/evaluations"],
    ["get", "/jobs/:jobId/evaluations"],
    ["post", "/evaluations/:evaluationId/findings"],
    ["get", "/evaluations/:evaluationId/findings"],
    ["get", "/findings/:findingId"],
    ["post", "/findings/:findingId/concern-links"],
    ["post", "/findings/:findingId/evidence-references"],
    ["post", "/findings/:findingId/confirm"],
    ["post", "/evaluations"],
    ["get", "/evaluations/:evaluationId"],
    ["patch", "/evaluations/:evaluationId"],
    ["post", "/evaluations/:evaluationId/complete"],
    ["get", "/emergency-requests/:emergencyRequestId/evaluations"],
  ];
  for (const [method, path] of expected) {
    const layer = route(method, path);
    assert.ok(layer, `${method.toUpperCase()} ${path}`);
    assert.equal(layer.route.stack.length, 2);
  }
  assert.equal(route("post", "/commercial-authority"), undefined);
  assert.equal(route("post", "/evaluations/:evaluationId/evidence"), undefined);
});

test("route handlers derive actor and idempotency from authenticated request boundaries", async () => {
  let received = null;
  const evaluation = {
    authoritySource: "canonical-commercial-authority",
    confirmed: true,
    aggregate: { id: "00000000-0000-4000-8000-000000000001" },
    evaluation: { id: "00000000-0000-4000-8000-000000000001" },
  };
  const handlers = createEvaluationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {
      async createEvaluation(input) {
        received = input;
        return { ok: true, success: true, status: 201, code: "EVALUATION_CREATED", ...evaluation };
      },
    },
  });
  const res = response();
  await handlers.createEvaluation({
    user: { id: 22 },
    body: {
      actorUserId: 999,
      ownerUserId: 999,
      sourceContext: { type: "emergency_request", emergencyRequestId: 9, relationshipId: 8 },
      content: { observations: "Observed" },
      expectedVersion: 0,
    },
    headers: { "idempotency-key": "route-create-key" },
  }, res);
  assert.deepEqual(received.authenticatedActor, { id: 22 });
  assert.equal(received.idempotencyKey, "route-create-key");
  assert.equal(Object.hasOwn(received, "actorUserId"), false);
  assert.equal(Object.hasOwn(received, "ownerUserId"), false);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.confirmed, true);
});

test("route errors are stable, nondisclosing, and database failures use public normalization", async () => {
  const handlers = createEvaluationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError({ res }) {
      return res.status(500).json({ success: false, code: "EVALUATION_FAILED", message: "The Evaluation could not be completed." });
    },
    service: {
      async getEvaluation() {
        return { ok: false, status: 404, code: "EVALUATION_UNAVAILABLE", message: "The Evaluation is unavailable." };
      },
      async updateEvaluationDraft() { throw new Error("private SQL and notes"); },
    },
  });
  const missing = response();
  await handlers.getEvaluation({ user: { id: 22 }, params: { evaluationId: "missing" } }, missing);
  assert.deepEqual(missing.body, { success: false, code: "EVALUATION_UNAVAILABLE", message: "The Evaluation is unavailable." });

  const failed = response();
  await handlers.updateEvaluationDraft({ user: { id: 22 }, params: { evaluationId: "id" }, body: {}, headers: {} }, failed);
  assert.doesNotMatch(JSON.stringify(failed.body), /SQL|notes|private/i);
});

test("registration requires authentication middleware and does not create public routes", () => {
  const routes = [];
  const fakeApp = {
    get(path, ...handlers) { routes.push({ method: "get", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "post", path, handlers }); },
    patch(path, ...handlers) { routes.push({ method: "patch", path, handlers }); },
  };
  const auth = (_req, _res, next) => next();
  registerEvaluationRoutes({
    app: fakeApp,
    authMiddleware: auth,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
    service: {},
  });
  assert.equal(routes.length, 14);
  assert.ok(routes.every((item) => item.handlers[0] === auth));
});
