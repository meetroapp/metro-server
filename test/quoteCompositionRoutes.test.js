"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  QUOTE_COMPOSITION_FEEDBACK_ROUTE,
  registerIntelligenceRoutes,
} = require("../server/intelligence/intelligenceRoutes");

function response() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
  };
}

async function runHandlers(handlers, req, res) {
  for (const handler of handlers) {
    if (handler.length < 3) await handler(req, res);
    else await new Promise((resolve, reject) => {
      const next = (error) => error ? reject(error) : resolve();
      Promise.resolve(handler(req, res, next)).catch(reject);
    });
  }
}

test("feedback route is authenticated, no-store, and forwards only review input", async () => {
  const registrations = [];
  const calls = [];
  const app = { post(path, ...handlers) { registrations.push({ path, handlers }); } };
  const authMiddleware = (req, _res, next) => {
    req.user = { id: 65, role: "drywall" };
    next();
  };
  registerIntelligenceRoutes({
    app,
    authMiddleware,
    getPool: () => ({ name: "review-pool" }),
    reviewService: {
      async recordQuoteCompositionFeedback(input) {
        calls.push(input);
        return {
          ok: true,
          status: 201,
          code: "QUOTE_COMPOSITION_FEEDBACK_RECORDED",
          feedback: { action: input.action },
          canonicalMutationPerformed: false,
        };
      },
    },
  });
  const route = registrations.find(({ path }) => path === QUOTE_COMPOSITION_FEEDBACK_ROUTE);
  const req = {
    headers: { "idempotency-key": randomUUID() },
    params: { proposalId: randomUUID() },
    body: { elementId: "repair_scope", action: "ACCEPTED", reasonCategory: "SCOPE_CONFIRMED" },
  };
  const res = response();
  await runHandlers(route.handlers, req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.code, "QUOTE_COMPOSITION_FEEDBACK_RECORDED");
  assert.equal(res.body.canonicalMutationPerformed, false);
  assert.equal(res.getHeader("cache-control"), "no-store");
  assert.equal(calls[0].authenticatedActor.id, 65);
  assert.equal(calls[0].elementId, "repair_scope");
  assert.equal(calls[0].editedValue, undefined);
});
