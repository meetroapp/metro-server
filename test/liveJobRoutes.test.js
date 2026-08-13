"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLiveJobHandlers,
  registerLiveJobRoutes,
} = require("../server/workflow/liveJobs");

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("route registration exposes one authenticated read-only endpoint", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post() { throw new Error("Live Job must not register a mutation route"); },
  };
  const authMiddleware = () => {};
  registerLiveJobRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /jobs/:jobId/live-state",
  ]);
  assert.equal(routes[0].handlers[0], authMiddleware);
});

test("handler derives actor and Job identity only from authenticated request locations", async () => {
  const calls = [];
  const handlers = createLiveJobHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service: {
      async getCanonicalLiveJob(input) {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          code: "LIVE_JOB_STATE_LOADED",
          liveJob: { jobId: input.jobId },
        };
      },
    },
  });
  const res = response();
  await handlers.getLiveJob({
    user: { id: 7 },
    params: { jobId: "job-from-route" },
    body: { jobId: "forged-job", stage: "CLOSED" },
  }, res);

  assert.deepEqual(calls, [{
    pool: "pool",
    authenticatedActor: { id: 7 },
    jobId: "job-from-route",
  }]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.body.success, true);
});

test("authorization failures preserve a bounded public contract", async () => {
  const handlers = createLiveJobHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
    service: {
      async getCanonicalLiveJob() {
        return {
          ok: false,
          status: 403,
          code: "LIVE_JOB_READ_AUTHORITY_REQUIRED",
          message: "Current Job read authority is required.",
        };
      },
    },
  });
  const res = response();
  await handlers.getLiveJob({ user: { id: 8 }, params: { jobId: "job" } }, res);
  assert.deepEqual(res.body, {
    success: false,
    code: "LIVE_JOB_READ_AUTHORITY_REQUIRED",
    message: "Current Job read authority is required.",
  });
});
