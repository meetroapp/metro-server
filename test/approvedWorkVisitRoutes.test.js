"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createApprovedWorkVisitHandlers,
  registerApprovedWorkVisitRoutes,
} = require("../server/workflow/approvedWorkVisits");

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

test("Approved Work Visit exposes only exact authenticated authority endpoints", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
  };
  const authMiddleware = () => {};
  registerApprovedWorkVisitRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /jobs/:jobId/quotes/:quoteId/approved-work-visit-authority",
    "POST /jobs/:jobId/quotes/:quoteId/approved-work-visit-authority",
  ]);
  assert.equal(routes.every((route) => route.handlers[0] === authMiddleware), true);
});

test("handlers derive subject identity only from auth, route, and idempotency header", async () => {
  const calls = [];
  const handlers = createApprovedWorkVisitHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service: {
      async getApprovedWorkVisitAuthority(input) {
        calls.push({ operation: "get", input });
        return { ok: true, status: 200, code: "TEST", authority: {} };
      },
      async activateApprovedWorkVisitAuthority(input) {
        calls.push({ operation: "activate", input });
        return { ok: true, status: 201, code: "TEST", authority: {} };
      },
    },
  });
  const request = {
    user: { id: 9 },
    params: { jobId: "job", quoteId: "quote" },
    headers: { "idempotency-key": "activate-key" },
    body: { decisionId: "forged", capabilities: ["visit.complete"] },
  };
  await handlers.getAuthority(request, response());
  await handlers.activateAuthority(request, response());
  assert.deepEqual(calls, [
    {
      operation: "get",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        quoteId: "quote",
      },
    },
    {
      operation: "activate",
      input: {
        pool: "pool",
        authenticatedActor: { id: 9 },
        jobId: "job",
        quoteId: "quote",
        idempotencyKey: "activate-key",
      },
    },
  ]);
});

test("Approved Work authority read is private no-store", async () => {
  const handlers = createApprovedWorkVisitHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => { throw new Error("unexpected"); },
    service: {
      getApprovedWorkVisitAuthority: async () => ({
        ok: false,
        status: 403,
        code: "QUOTE_AUTHORITY_REQUIRED",
        message: "Quote authority is required.",
      }),
    },
  });
  const res = response();
  await handlers.getAuthority({ user: { id: 7 }, params: {} }, res);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.statusCode, 403);
});
