"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createConnectedServicesHandlers,
  registerConnectedServicesRoutes,
} = require("../server/integrations/connectedServices");

function response() {
  return {
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("R2 exposes one authenticated read-only Connected Services route", () => {
  const calls = [];
  const app = {
    get(path, auth, handler) {
      calls.push(["GET", path, auth, handler]);
    },
    post(path, auth, handler) {
      calls.push(["POST", path, auth, handler]);
    },
  };
  const auth = () => {};

  registerConnectedServicesRoutes({
    app,
    authMiddleware: auth,
    getPool: () => ({}),
    sendPublicDatabaseError() {},
  });

  assert.deepEqual(
    calls.map(([method, path]) => `${method} ${path}`),
    ["GET /connected-services"]
  );
  assert.equal(calls[0][2], auth);
});

test("route derives actor and pool only from server request boundaries", async () => {
  const serviceCalls = [];
  const connectedServicesService = {
    async getConnectedServices(input) {
      serviceCalls.push(input);
      return {
        ok: true,
        status: 200,
        code: "CONNECTED_SERVICES_LOADED",
        contractVersion: 1,
        business: {
          businessId: 42,
          displayName: "Lantern Services",
          role: "OWNER",
        },
        providers: [],
      };
    },
  };

  const handlers = createConnectedServicesHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    connectedServicesService,
  });

  const req = {
    user: { id: 7 },
    body: {
      businessId: 999,
      provider: "STRIPE_PAYMENTS",
      status: "CONNECTED",
    },
    query: {
      businessId: 999,
    },
  };
  const res = response();

  await handlers.getConnectedServices(req, res);

  assert.deepEqual(serviceCalls, [
    {
      pool: "pool",
      authenticatedActor: { id: 7 },
    },
  ]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.body.success, true);
  assert.equal(res.body.code, "CONNECTED_SERVICES_LOADED");
});

test("service failures preserve bounded public errors", async () => {
  const handlers = createConnectedServicesHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    connectedServicesService: {
      async getConnectedServices() {
        return {
          ok: false,
          status: 403,
          code: "CONNECTED_SERVICES_BUSINESS_AUTHORITY_REQUIRED",
          message:
            "Owner or Manager authority in an active Business is required.",
        };
      },
    },
  });

  const res = response();
  await handlers.getConnectedServices(
    { user: { id: 20 } },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    success: false,
    code: "CONNECTED_SERVICES_BUSINESS_AUTHORITY_REQUIRED",
    message:
      "Owner or Manager authority in an active Business is required.",
  });
});

test("unexpected database failures use the shared public database error boundary", async () => {
  const errors = [];
  const handlers = createConnectedServicesHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError(input) {
      errors.push(input);
      return "bounded";
    },
    connectedServicesService: {
      async getConnectedServices() {
        throw new Error("private database detail");
      },
    },
  });

  const res = response();
  const result = await handlers.getConnectedServices(
    { user: { id: 7 } },
    res
  );

  assert.equal(result, "bounded");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].operation, "get_connected_services");
  assert.equal(errors[0].code, "CONNECTED_SERVICES_FAILED");
  assert.equal(errors[0].message, "Connected Services could not be loaded.");
});
