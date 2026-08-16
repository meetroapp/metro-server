"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createInvoicePaymentHandlers,
  registerInvoicePaymentRoutes,
} = require("../server/finance/invoicePayments");

function response() {
  return {
    headers: {}, statusCode: 0, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("Invoice and Payment routes are authenticated and exact-identity scoped", () => {
  const routes = [];
  const app = {
    get(path, auth, handler) { routes.push(["GET", path, auth, handler]); },
    post(path, auth, handler) { routes.push(["POST", path, auth, handler]); },
  };
  const auth = () => {};
  registerInvoicePaymentRoutes({ app, authMiddleware: auth, getPool() {}, sendPublicDatabaseError() {} });
  assert.deepEqual(routes.map(([method, path]) => `${method} ${path}`), [
    "GET /professional/invoices/workspace",
    "POST /professional/jobs/:jobId/invoices",
    "GET /professional/jobs/:jobId/invoice",
    "GET /professional/invoices/:invoiceId",
    "POST /professional/invoices/:invoiceId/issue",
    "POST /professional/invoices/:invoiceId/payments",
    "GET /customer/invoices/:invoiceId",
    "GET /customer/jobs/:jobId/invoice",
  ]);
  assert.equal(routes.every((route) => route[2] === auth), true);
});

test("Payment handler forwards only governed command fields", async () => {
  let input;
  const handlers = createInvoicePaymentHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    invoicePaymentService: {
      async recordPayment(value) {
        input = value;
        return { ok: true, status: 201, code: "PAYMENT_RECORDED", invoice: {}, payment: {} };
      },
    },
  });
  const res = response();
  await handlers.recordPayment({
    user: { id: 65 },
    params: { invoiceId: "invoice-path" },
    headers: { "idempotency-key": "payment-1" },
    body: {
      expectedVersion: 2,
      amountMinor: 46000,
      method: "CHECK",
      receivedDate: "2026-08-15",
      customerReference: "Check 1042",
      status: "PAID",
      jobId: "forbidden",
    },
  }, res);
  assert.deepEqual(input, {
    pool: "pool",
    authenticatedActor: { id: 65 },
    invoiceId: "invoice-path",
    expectedVersion: 2,
    amountMinor: 46000,
    method: "CHECK",
    receivedDate: "2026-08-15",
    customerReference: "Check 1042",
    idempotencyKey: "payment-1",
  });
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.body.code, "PAYMENT_RECORDED");
});
