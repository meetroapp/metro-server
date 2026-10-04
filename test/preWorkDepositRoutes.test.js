"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPreWorkDepositHandlers,
  registerPreWorkDepositRoutes,
} = require("../server/finance/preWorkDeposits");

function response() {
  return {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("deposit routes expose only one read and three professional commands", () => {
  const calls = [];
  const app = {
    get(path, auth, handler) { calls.push(["GET", path, auth, handler]); },
    post(path, auth, handler) { calls.push(["POST", path, auth, handler]); },
  };
  const auth = () => {};
  registerPreWorkDepositRoutes({
    app,
    authMiddleware: auth,
    getPool: () => ({}),
    sendPublicDatabaseError() {},
  });
  assert.deepEqual(calls.map(([method, path]) => `${method} ${path}`), [
    "GET /jobs/:jobId/pre-work-deposit",
    "POST /jobs/:jobId/pre-work-deposit/materialize",
    "POST /jobs/:jobId/pre-work-deposit/payments",
    "POST /jobs/:jobId/pre-work-deposit/allocations/:allocationId/reversals",
  ]);
  assert.equal(calls.every(([, , middleware]) => middleware === auth), true);
});

test("handlers derive actor, Job, allocation, and idempotency from governed locations", async () => {
  const calls = [];
  const service = {
    async getProfessionalDepositStatus(input) { calls.push(["read", input]); return { ok: true, status: 200, code: "READ", deposit: {} }; },
    async materializePreWorkDepositObligation(input) { calls.push(["materialize", input]); return { ok: true, status: 201, code: "MATERIALIZED", deposit: {} }; },
    async confirmDepositReceived(input) { calls.push(["payment", input]); return { ok: true, status: 201, code: "PAID", deposit: {}, payment: {} }; },
    async reverseDepositAllocation(input) { calls.push(["reverse", input]); return { ok: true, status: 201, code: "REVERSED", deposit: {}, reversal: {} }; },
  };
  const handlers = createPreWorkDepositHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    service,
  });
  const req = {
    user: { id: 24 },
    params: { jobId: "job", allocationId: "allocation" },
    headers: { "idempotency-key": "command-key" },
    body: {
      amountMinor: 20000,
      currency: "USD",
      normalizedMethod: "BUSINESS_DEFINED_METHOD",
      displayMethod: "Preferred transfer app",
      externalReference: "bounded-reference",
      receivedAt: "2026-08-28T15:00:00.000Z",
      expectedVersion: 1,
      reasonCategory: "CORRECTION",
      reason: "Corrected allocation",
      depositSatisfied: true,
    },
  };
  await handlers.getStatus(req, response());
  await handlers.materialize(req, response());
  await handlers.confirmReceived(req, response());
  await handlers.reverseAllocation(req, response());
  assert.deepEqual(Object.keys(calls[0][1]).sort(), [
    "authenticatedActor", "jobId", "pool",
  ]);
  assert.deepEqual(Object.keys(calls[2][1]).sort(), [
    "amountMinor", "authenticatedActor", "currency", "displayMethod",
    "expectedVersion", "externalReference", "idempotencyKey", "jobId",
    "normalizedMethod", "pool", "receivedAt",
  ]);
  assert.equal(Object.hasOwn(calls[2][1], "depositSatisfied"), false);
  assert.equal(calls[3][1].allocationId, "allocation");
});
