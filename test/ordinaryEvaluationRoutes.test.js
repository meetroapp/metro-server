"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

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

test("ordinary create derives actor, Job, and idempotency from authenticated boundaries", async () => {
  let received;
  const handlers = createEvaluationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {
      async createOrdinaryJobEvaluation(input) {
        received = input;
        return {
          ok: true,
          status: 201,
          code: "EVALUATION_CREATED",
          authoritySource: "canonical-commercial-authority",
          confirmed: true,
          aggregate: { id: "evaluation-1" },
          evaluation: { id: "evaluation-1" },
        };
      },
    },
  });
  const res = response();
  await handlers.createOrdinaryJobEvaluation({
    user: { id: 41 },
    params: { jobId: "job-from-path" },
    headers: { "idempotency-key": "ordinary-route-key" },
    body: {
      jobId: "browser-job",
      visitId: "visit-from-body",
      actorUserId: 999,
      relationshipId: 999,
      lifecycleContractVersion: 2,
      expectedVersion: 0,
      content: { observations: "Observed" },
    },
  }, res);

  assert.equal(received.authenticatedActor.id, 41);
  assert.equal(received.jobId, "job-from-path");
  assert.equal(received.visitId, "visit-from-body");
  assert.equal(received.idempotencyKey, "ordinary-route-key");
  assert.equal(Object.hasOwn(received, "relationshipId"), false);
  assert.equal(Object.hasOwn(received, "lifecycleContractVersion"), false);
  assert.equal(res.statusCode, 201);
});

test("completion route passes one explicit bounded completion contract", async () => {
  let received;
  const handlers = createEvaluationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {
      async completeEvaluation(input) {
        received = input;
        return { ok: true, status: 200, code: "EVALUATION_COMPLETED" };
      },
    },
  });
  const res = response();
  await handlers.completeEvaluation({
    user: { id: 41 },
    params: { evaluationId: "evaluation-from-path" },
    headers: { "idempotency-key": "completion-key" },
    body: {
      expectedVersion: 3,
      completionMode: "REMOTE",
      assessmentMethod: "VIDEO",
      assessmentBasis: "Reviewed live video with the customer.",
      actorUserId: 999,
    },
  }, res);

  assert.deepEqual(received, {
    pool: { query: received.pool.query },
    authenticatedActor: { id: 41 },
    evaluationId: "evaluation-from-path",
    expectedVersion: 3,
    completionMode: "REMOTE",
    assessmentMethod: "VIDEO",
    assessmentBasis: "Reviewed live video with the customer.",
    idempotencyKey: "completion-key",
  });
  assert.equal(res.statusCode, 200);
});

test("ordinary Job and Finding route families are bounded and authenticated", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "get", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "post", path, handlers }); },
    patch(path, ...handlers) { routes.push({ method: "patch", path, handlers }); },
  };
  const auth = (_req, _res, next) => next();
  registerEvaluationRoutes({
    app,
    authMiddleware: auth,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
    service: {},
  });
  assert.ok(routes.some((route) =>
    route.method === "post" && route.path === "/jobs/:jobId/evaluations"
  ));
  assert.ok(routes.some((route) =>
    route.method === "get" && route.path === "/jobs/:jobId/evaluations"
  ));
  assert.equal(routes.filter((route) => /finding/i.test(route.path)).length, 7);
  assert.equal(routes.some((route) =>
    route.method === "patch" && route.path === "/findings/:findingId"
  ), true);
  assert.equal(routes.some((route) => /resolve|recommendation|workstream/i.test(route.path)), false);
  assert.ok(routes.every((route) => route.handlers[0] === auth));
});
