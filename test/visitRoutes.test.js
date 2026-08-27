"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createVisitHandlers,
  registerVisitRoutes,
} = require("../server/workflow/visits");

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

test("Visit routes expose exactly nine authenticated bounded endpoints", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
  };
  const authMiddleware = () => {};
  registerVisitRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.equal(routes.length, 9);
  assert.equal(routes.every((route) => route.handlers[0] === authMiddleware), true);
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /jobs/:jobId/visits",
    "GET /jobs/:jobId/visits/:visitId",
    "POST /jobs/:jobId/visits",
    "POST /jobs/:jobId/visits/:visitId/confirm",
    "POST /jobs/:jobId/visits/:visitId/change-request",
    "POST /jobs/:jobId/visits/:visitId/reschedule",
    "POST /jobs/:jobId/visits/:visitId/cancel",
    "POST /jobs/:jobId/visits/:visitId/start",
    "POST /jobs/:jobId/visits/:visitId/complete",
  ]);
});
test("handlers forward only governed Visit fields from authenticated boundaries", async () => {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, operation) {
      return async (input) => {
        calls.push({ operation, input });
        return { ok: true, status: 200, code: "TEST_OK", visit: { id: "visit" } };
      };
    },
  });
  const handlers = createVisitHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service,
  });
  const base = {
    user: { id: 9 },
    params: { jobId: "job", visitId: "visit" },
    headers: { "idempotency-key": "visit-key" },
    body: {
      purpose: "EVALUATION",
      expectedVersion: 2,
      scheduledStartAt: "2026-08-20T13:00:00.000Z",
      scheduledEndAt: "2026-08-20T14:00:00.000Z",
      timeZone: "America/New_York",
      locationMode: "REMOTE",
      reason: "A governed reason",
      state: "COMPLETED",
      actorParticipantId: "browser-owned",
    },
  };
  await handlers.proposeVisit(base, response());
  await handlers.rescheduleVisit(base, response());
  await handlers.requestVisitChange(base, response());
  await handlers.startVisit(base, response());
  await handlers.completeVisit(base, response());
  assert.deepEqual(calls, [
    {
      operation: "proposeVisit",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        purpose: "EVALUATION",
        scheduledStartAt: "2026-08-20T13:00:00.000Z",
        scheduledEndAt: "2026-08-20T14:00:00.000Z",
        timeZone: "America/New_York",
        locationMode: "REMOTE",
        evaluationId: undefined,
        workstreamIds: undefined,
        approvedQuoteDecisionId: undefined,
        reason: "A governed reason",
        idempotencyKey: "visit-key",
      },
    },
    {
      operation: "rescheduleVisit",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        visitId: "visit",
        expectedVersion: 2,
        idempotencyKey: "visit-key",
        scheduledStartAt: "2026-08-20T13:00:00.000Z",
        scheduledEndAt: "2026-08-20T14:00:00.000Z",
        timeZone: "America/New_York",
        locationMode: "REMOTE",
        reason: "A governed reason",
      },
    },
    {
      operation: "requestVisitChange",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        visitId: "visit",
        expectedVersion: 2,
        idempotencyKey: "visit-key",
        reason: "A governed reason",
        scheduledStartAt: "2026-08-20T13:00:00.000Z",
        scheduledEndAt: "2026-08-20T14:00:00.000Z",
        timeZone: "America/New_York",
        locationMode: "REMOTE",
      },
    },
    {
      operation: "startVisit",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        visitId: "visit",
        expectedVersion: 2,
        idempotencyKey: "visit-key",
        acknowledgeScheduleVariance: undefined,
      },
    },
    {
      operation: "completeVisit",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        visitId: "visit",
        expectedVersion: 2,
        idempotencyKey: "visit-key",
      },
    },
  ]);
});

test("Visit reads are private no-store and errors retain bounded public contracts", async () => {
  const handlers = createVisitHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => { throw new Error("unexpected"); },
    service: {
      listVisits: async () => ({
        ok: false,
        status: 403,
        code: "VISIT_AUTHORITY_REQUIRED",
        message: "Visit authority is required.",
      }),
    },
  });
  const res = response();
  await handlers.listVisits({
    user: { id: 7 },
    params: { jobId: "job" },
  }, res);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(res.body, {
    success: false,
    code: "VISIT_AUTHORITY_REQUIRED",
    message: "Visit authority is required.",
  });
});
