"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCustomerJobQuotesHandlers,
  registerCustomerJobQuotesRoutes,
} = require("../server/authorization/customerJobQuotes");

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

test("customer Job Quotes registers one authenticated read-only route", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post() { throw new Error("Customer Quote discovery must not register commands."); },
  };
  const authMiddleware = () => {};
  registerCustomerJobQuotesRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /customer/jobs/:jobId/quotes",
  ]);
  assert.equal(routes[0].handlers[0], authMiddleware);
});

test("handler derives customer identity only from authentication and marks the response private", async () => {
  const calls = [];
  const handlers = createCustomerJobQuotesHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service: {
      async getCustomerJobQuotes(input) {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          code: "CUSTOMER_JOB_QUOTES_LOADED",
          job: { id: input.jobId, requestId: 16, title: "Synthetic Job", service: "Handyman" },
          quotes: [],
          pagination: { limit: 10, hasMore: false, nextCursor: null },
        };
      },
    },
  });
  const res = response();
  await handlers.getCustomerJobQuotes({
    user: { id: 41 },
    params: { jobId: "60000000-0000-4000-8000-000000000006" },
    query: { limit: "10", cursor: "opaque" },
    body: { customerUserId: 999, email: "not-authority@example.test" },
  }, res);
  assert.deepEqual(calls, [{
    pool: "pool",
    authenticatedActor: { id: 41 },
    jobId: "60000000-0000-4000-8000-000000000006",
    limit: "10",
    cursor: "opaque",
  }]);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, "CUSTOMER_JOB_QUOTES_LOADED");
});

test("handler returns bounded authority failures without leaking service internals", async () => {
  const handlers = createCustomerJobQuotesHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
    service: {
      async getCustomerJobQuotes() {
        return {
          ok: false,
          status: 404,
          code: "CUSTOMER_JOB_QUOTES_UNAVAILABLE",
          message: "The customer Quotes are unavailable.",
          sentinel: "must-not-leak",
        };
      },
    },
  });
  const res = response();
  await handlers.getCustomerJobQuotes({ user: { id: 1 }, params: {}, query: {} }, res);
  assert.deepEqual(res.body, {
    success: false,
    code: "CUSTOMER_JOB_QUOTES_UNAVAILABLE",
    message: "The customer Quotes are unavailable.",
  });
});
