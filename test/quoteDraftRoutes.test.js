"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createQuoteDraftHandlers,
  registerQuoteDraftRoutes,
} = require("../server/authorization/quoteDrafts");

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

test("Quote routes register bounded Draft, issue, customer decision, and lineage authority", () => {
  const routes = [];
  const app = {
    get(path) { routes.push(["GET", path]); },
    post(path) { routes.push(["POST", path]); },
  };
  registerQuoteDraftRoutes({
    app,
    authMiddleware() {},
    getPool() {},
    sendPublicDatabaseError() {},
    service: {},
  });
  assert.deepEqual(routes, [
    ["POST", "/jobs/:jobId/quotes"],
    ["GET", "/jobs/:jobId/quotes"],
    ["GET", "/quotes/:quoteId"],
    ["POST", "/quotes/:quoteId/scope-items"],
    ["POST", "/quotes/:quoteId/scope-items/:scopeItemId/remove"],
    ["POST", "/quotes/:quoteId/issue"],
    ["GET", "/quotes/:quoteId/customer"],
    ["POST", "/quotes/:quoteId/approve"],
    ["POST", "/quotes/:quoteId/decline"],
    ["POST", "/quotes/:quoteId/derived-quotes"],
  ]);
  assert.equal(routes.some(([, path]) => /procurement|payment|invoice/.test(path)), false);
});

test("handlers forward only governed Draft inputs and idempotency", async () => {
  const calls = [];
  const result = { ok: true, status: 200, code: "OK", quote: { id: "quote" } };
  const service = {
    async createDraftQuote(input) { calls.push(["create", input]); return { ...result, status: 201 }; },
    async listDraftQuotesByJob(input) { calls.push(["list", input]); return { ...result, quotes: [] }; },
    async getDraftQuote(input) { calls.push(["get", input]); return result; },
    async addDraftScopeItem(input) { calls.push(["add", input]); return { ...result, status: 201 }; },
    async removeDraftScopeItem(input) { calls.push(["remove", input]); return result; },
    async issueQuote(input) { calls.push(["issue", input]); return result; },
    async getCustomerIssuedQuote(input) { calls.push(["customer-get", input]); return result; },
    async approveIssuedQuote(input) { calls.push(["approve", input]); return result; },
    async declineIssuedQuote(input) { calls.push(["decline", input]); return result; },
    async createDerivedDraftQuote(input) { calls.push(["derive", input]); return { ...result, status: 201 }; },
  };
  const handlers = createQuoteDraftHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    service,
  });
  const req = {
    user: { id: 7 },
    params: { jobId: "job", quoteId: "quote", scopeItemId: "scope" },
    headers: { "idempotency-key": "key" },
    body: {
      currency: "USD",
      customerTermsSnapshot: {
        schemaVersion: 1,
        agreement: {},
      },
      expectedVersion: 1,
      expectedIssuedVersion: 2,
      lineageType: "SUPPLEMENTAL_QUOTE",
      reasonCategory: "SUPPLEMENTAL_WORK",
      item: { description: "line" },
      totalMinor: 99,
    },
  };
  for (const name of [
    "createDraftQuote",
    "listDraftQuotes",
    "getDraftQuote",
    "addScopeItem",
    "removeScopeItem",
    "issueQuote",
    "getCustomerIssuedQuote",
    "approveIssuedQuote",
    "declineIssuedQuote",
    "createDerivedDraftQuote",
  ]) {
    const res = response();
    await handlers[name](req, res);
    assert.equal(res.payload.success, true);
  }
  assert.equal(calls[0][1].totalMinor, undefined);
  assert.deepEqual(calls[0][1].customerTermsSnapshot, req.body.customerTermsSnapshot);
  assert.equal(calls[3][1].expectedVersion, 1);
  assert.equal(calls[4][1].scopeItemId, "scope");
  assert.equal(calls[4][1].idempotencyKey, "key");
  assert.equal(calls[5][1].expectedVersion, 1);
  assert.equal(calls[5][1].totalMinor, undefined);
  assert.equal(calls[6][1].idempotencyKey, undefined);
  assert.equal(calls[7][1].expectedIssuedVersion, 2);
  assert.equal(calls[8][1].expectedIssuedVersion, 2);
  assert.equal(calls[9][1].lineageType, "SUPPLEMENTAL_QUOTE");
  assert.equal(calls[9][1].reasonCategory, "SUPPLEMENTAL_WORK");
  assert.equal(calls[9][1].totalMinor, undefined);
});

test("customer Quote detail is private and no-store", async () => {
  const handlers = createQuoteDraftHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    service: {
      async getCustomerIssuedQuote() {
        return {
          ok: true,
          status: 200,
          code: "CUSTOMER_QUOTE_FOUND",
          quote: { quoteId: "quote" },
        };
      },
    },
  });
  const res = response();
  await handlers.getCustomerIssuedQuote({
    user: { id: 7 },
    params: { quoteId: "quote" },
  }, res);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.code, "CUSTOMER_QUOTE_FOUND");
});
