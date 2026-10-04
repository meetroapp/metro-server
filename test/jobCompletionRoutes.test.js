"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createJobCompletionHandlers,
  registerJobCompletionRoutes,
} = require("../server/workflow/jobCompletions");

function response() {
  return {
    headers: {}, statusCode: 0, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("Job completion registers bounded authenticated completion and history routes", () => {
  const routes = [];
  const app = {
    get(path, auth, handler) { routes.push(["GET", path, auth, handler]); },
    post(path, auth, handler) { routes.push(["POST", path, auth, handler]); },
  };
  const auth = () => {};
  registerJobCompletionRoutes({ app, authMiddleware: auth, getPool() {}, sendPublicDatabaseError() {} });
  assert.deepEqual(routes.map(([method, path]) => `${method} ${path}`), [
    "GET /professional/businesses/:contractorProfileId/native-customers",
    "GET /professional/businesses/:contractorProfileId/native-customers/:subjectId/history",
    "GET /professional/businesses/:contractorProfileId/native-customers/:subjectId/jobs/:jobId/history",
    "GET /professional/jobs/history",
    "GET /professional/jobs/:jobId/completion-review",
    "POST /professional/jobs/:jobId/complete",
    "GET /professional/jobs/:jobId/history",
    "GET /customer/jobs/history",
    "GET /customer/jobs/:jobId/history",
  ]);
  assert.equal(routes.every((route) => route[2] === auth), true);
});
test("Customer Job History list handler forwards only authenticated paging fields", async () => {
  let input;
  const handlers = createJobCompletionHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    completionService: {
      async listCustomerJobHistory(value) {
        input = value;
        return {
          ok: true,
          status: 200,
          code: "CUSTOMER_JOB_HISTORY_FOUND",
          jobHistory: {
            contractVersion: 1,
            totalCount: 0,
            jobs: [],
            pagination: { limit: 20, nextCursor: null },
          },
        };
      },
    },
  });
  const res = response();
  await handlers.listCustomerHistory({
    user: { id: 9 },
    query: { limit: "20", cursor: "cursor-1", jobId: "ignored" },
    body: { paid: true },
  }, res);
  assert.deepEqual(input, {
    pool: "pool",
    authenticatedActor: { id: 9 },
    limit: "20",
    cursor: "cursor-1",
  });
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.body.code, "CUSTOMER_JOB_HISTORY_FOUND");
});

test("Complete Job handler forwards only authenticated route and command fields", async () => {
  let input;
  const handlers = createJobCompletionHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    completionService: {
      async completeJob(value) {
        input = value;
        return { ok: true, status: 200, code: "JOB_COMPLETED", completion: { id: "completion" } };
      },
    },
  });
  const res = response();
  await handlers.completeJob({
    user: { id: 9 },
    params: { jobId: "job-from-path" },
    headers: { "idempotency-key": "complete-1" },
    body: { expectedVersion: 0, customerId: 99, paid: true },
  }, res);
  assert.deepEqual(input, {
    pool: "pool",
    authenticatedActor: { id: 9 },
    jobId: "job-from-path",
    expectedVersion: 0,
    idempotencyKey: "complete-1",
  });
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.body.code, "JOB_COMPLETED");
});

test("native customer handlers forward exact business, subject, Job and paging without body authority", async () => {
  const calls = [];
  const nativeCustomerService = Object.fromEntries([
    "listNativeCustomers", "listNativeCustomerHistory", "getNativeCustomerJobHistory",
  ].map(name => [name, async input => {
    calls.push([name, input]);
    const field = name === "listNativeCustomers" ? "nativeCustomers"
      : name === "listNativeCustomerHistory" ? "nativeCustomerHistory" : "nativeCustomerJobHistory";
    return { ok: true, status: 200, code: "FOUND", [field]: {} };
  }]));
  const handlers = createJobCompletionHandlers({ getPool: () => "pool", nativeCustomerService, sendPublicDatabaseError() {} });
  const req = { user: { id: 9 }, params: { contractorProfileId: "7", subjectId: "11", jobId: "exact-job" },
    query: { limit: "20", cursor: "opaque", homeownerUserId: "forged" }, body: { contractorProfileId: "forged" } };
  await handlers.listNativeCustomers(req, response());
  await handlers.listNativeCustomerHistory(req, response());
  await handlers.getNativeCustomerJobHistory(req, response());
  assert.deepEqual(calls, [
    ["listNativeCustomers", { pool: "pool", authenticatedActor: { id: 9 }, contractorProfileId: "7", limit: "20", cursor: "opaque" }],
    ["listNativeCustomerHistory", { pool: "pool", authenticatedActor: { id: 9 }, contractorProfileId: "7", homeownerUserId: "11", limit: "20", cursor: "opaque" }],
    ["getNativeCustomerJobHistory", { pool: "pool", authenticatedActor: { id: 9 }, contractorProfileId: "7", homeownerUserId: "11", jobId: "exact-job" }],
  ]);
});
