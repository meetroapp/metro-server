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

test("professional Quotes registers bounded authenticated read and delivery routes", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
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
    "GET /professional/quotes/:quoteId/delivery",
    "POST /professional/quotes/:quoteId/send-in-meetro",
  ]);
  for (const route of routes) assert.equal(route.handlers[0], authMiddleware);
});

test("delivery handlers derive actor and Quote identity from authenticated routing", async () => {
  const calls = [];
  const handlers = createProfessionalQuotesHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    deliveryService: {
      async getProfessionalQuoteDelivery(input) {
        calls.push(["get", input]);
        return { ok: true, status: 200, code: "PROFESSIONAL_QUOTE_DELIVERY_LOADED", delivery: {} };
      },
      async sendQuoteInMeetro(input) {
        calls.push(["send", input]);
        return { ok: true, status: 201, code: "QUOTE_SENT_IN_MEETRO", delivery: { messageId: 7 } };
      },
    },
  });
  const req = {
    user: { id: 41 },
    params: { quoteId: "11111111-1111-4111-8111-111111111111" },
    body: { expectedIssuedVersion: 3, customerId: 999, conversationId: 888 },
    headers: { "idempotency-key": "send-key" },
  };
  const readRes = response();
  await handlers.getProfessionalQuoteDelivery(req, readRes);
  const sendRes = response();
  await handlers.sendQuoteInMeetro(req, sendRes);
  assert.deepEqual(calls, [
    ["get", {
      pool: "pool",
      authenticatedActor: { id: 41 },
      quoteId: req.params.quoteId,
    }],
    ["send", {
      pool: "pool",
      authenticatedActor: { id: 41 },
      quoteId: req.params.quoteId,
      expectedIssuedVersion: 3,
      idempotencyKey: "send-key",
    }],
  ]);
  assert.equal(readRes.headers["Cache-Control"], "private, no-store");
  assert.equal(sendRes.statusCode, 201);
  assert.deepEqual(sendRes.body.delivery, { messageId: 7 });
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
