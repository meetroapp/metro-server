"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProfessionalQuotesHandlers,
  registerProfessionalQuotesRoutes,
} = require("../server/authorization/professionalQuotes");

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

test("professional Quotes registers one authenticated private read route", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post() { throw new Error("Professional Quotes projection must not register commands"); },
  };
  const authMiddleware = () => {};
  registerProfessionalQuotesRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /professional/quotes",
  ]);
  assert.equal(routes[0].handlers[0], authMiddleware);
});

test("handler derives identity only from authentication and forwards bounded read controls", async () => {
  const calls = [];
  const handlers = createProfessionalQuotesHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service: {
      async getProfessionalQuotes(input) {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          code: "PROFESSIONAL_QUOTES_LOADED",
          classification: input.classification,
          summary: { drafts: 0, waitingOnCustomer: 0, approved: 0, declined: 0 },
          quotes: [],
          pagination: { limit: 25, hasMore: false, nextCursor: null },
        };
      },
    },
  });
  const res = response();
  await handlers.getProfessionalQuotes({
    user: { id: 41 },
    query: { classification: "approved", limit: "25", cursor: "opaque" },
    body: { professionalUserId: 999, businessId: 888 },
  }, res);
  assert.deepEqual(calls, [{
    pool: "pool",
    authenticatedActor: { id: 41 },
    classification: "approved",
    limit: "25",
    cursor: "opaque",
  }]);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, "PROFESSIONAL_QUOTES_LOADED");
});

test("handler preserves bounded public failures", async () => {
  const handlers = createProfessionalQuotesHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
    service: {
      async getProfessionalQuotes() {
        return {
          ok: false,
          status: 400,
          code: "INVALID_QUOTES_CLASSIFICATION",
          message: "Invalid.",
        };
      },
    },
  });
  const res = response();
  await handlers.getProfessionalQuotes({ user: { id: 1 }, query: {} }, res);
  assert.deepEqual(res.body, {
    success: false,
    code: "INVALID_QUOTES_CLASSIFICATION",
    message: "Invalid.",
  });
});
