"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCustomerEfrHandlers,
  registerCustomerEfrRoutes,
} = require("../server/authorization/customerEfr");

function response() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test("customer EFR registers one authenticated read route", () => {
  const routes = [];
  const authMiddleware = () => {};
  registerCustomerEfrRoutes({
    app: { get(path, auth, handler) { routes.push({ path, auth, handler }); } },
    authMiddleware,
    getPool() {},
    sendPublicDatabaseError() {},
    service: { getCustomerEfr() {} },
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/customer/jobs/:jobId/project-assessment");
  assert.equal(routes[0].auth, authMiddleware);
});

test("customer EFR derives actor and Job from authenticated route context", async () => {
  let received;
  const handlers = createCustomerEfrHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    service: {
      async getCustomerEfr(input) {
        received = input;
        return {
          ok: true,
          status: 200,
          code: "CUSTOMER_EFR_FOUND",
          projectAssessment: { jobId: input.jobId, findings: [], recommendations: [] },
        };
      },
    },
  });
  const res = response();
  await handlers.getCustomerEfr({
    user: { id: 64 },
    params: { jobId: "job-from-path" },
    query: { actorId: 999 },
  }, res);
  assert.deepEqual(received, {
    pool: "pool",
    authenticatedActor: { id: 64 },
    jobId: "job-from-path",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
});
