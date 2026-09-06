"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProfessionalQuoteCustomerOptionsHandlers,
  registerProfessionalQuoteCustomerOptionsRoutes,
} = require("../server/workflow/professionalQuoteCustomerOptions");

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("GET /professional/quote-customer-options is authenticated", () => {
  const registrations = [];
  const authMiddleware = () => {};
  registerProfessionalQuoteCustomerOptionsRoutes({
    app: { get: (...args) => registrations.push(args) },
    authMiddleware,
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(registrations.map(([route]) => route), [
    "/professional/quote-customer-options",
  ]);
  assert.equal(registrations[0][1], authMiddleware);
});

test("handler forwards only authenticated actor and returns a private bounded contract", async () => {
  const calls = [];
  const handlers = createProfessionalQuoteCustomerOptionsHandlers({
    getPool: () => ({ id: "pool" }),
    sendPublicDatabaseError: () => {},
    customerOptionsService: {
      async listProfessionalQuoteCustomerOptions(input) {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          code: "PROFESSIONAL_QUOTE_CUSTOMER_OPTIONS_LOADED",
          contractVersion: 1,
          customers: [],
        };
      },
    },
  });
  const res = responseRecorder();
  await handlers.list({ user: { id: 77 } }, res);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(calls, [{ pool: { id: "pool" }, authenticatedActor: { id: 77 } }]);
  assert.deepEqual(res.body, {
    success: true,
    code: "PROFESSIONAL_QUOTE_CUSTOMER_OPTIONS_LOADED",
    contractVersion: 1,
    customers: [],
  });
});
