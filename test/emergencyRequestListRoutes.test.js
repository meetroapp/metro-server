"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerEmergencyRequestRoutes,
} = require("../server/emergency/emergencyRequests");
const {
  validateEmergencyRequestListOptions,
} = require("../server/emergency/emergencyRequestService");

function createResponse() {
  return {
    statusCode: 200,
    payload: undefined,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

function register({
  authMiddleware = (_req, _res, next) => next(),
  listOwnedEmergencyRequests = async () => ({
    ok: true,
    status: 200,
    code: "EMERGENCY_REQUESTS_RETRIEVED",
    emergencyRequests: [],
  }),
  sendPublicDatabaseError,
} = {}) {
  const routes = [];
  const app = {
    get(path, ...handlers) {
      routes.push({ method: "GET", path, handlers });
    },
    patch(path, ...handlers) {
      routes.push({ method: "PATCH", path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: "POST", path, handlers });
    },
  };
  const pool = { marker: "pool" };

  registerEmergencyRequestRoutes({
    app,
    authMiddleware,
    getPool(req) {
      assert.equal(req.pool, pool);
      return req.pool;
    },
    sendPublicDatabaseError:
      sendPublicDatabaseError ||
      (({ res, code, message }) =>
        res.status(500).json({
          success: false,
          code,
          message,
        })),
    service: {
      validateEmergencyRequestListOptions,
      listOwnedEmergencyRequests,
    },
  });

  const route = routes.find(
    ({ method, path }) =>
      method === "GET" &&
      path === "/emergency-requests"
  );

  return {
    authMiddleware,
    pool,
    route,
    routes,
  };
}

test("static owner collection route precedes the dynamic direct-read route", () => {
  const { authMiddleware, route, routes } = register();
  const collectionIndex = routes.findIndex(
    ({ path }) => path === "/emergency-requests"
  );
  const directReadIndex = routes.findIndex(
    ({ path }) =>
      path ===
      "/emergency-requests/:emergencyRequestId"
  );

  assert.ok(route);
  assert.ok(collectionIndex >= 0);
  assert.ok(directReadIndex > collectionIndex);
  assert.equal(route.handlers.length, 2);
  assert.equal(route.handlers[0], authMiddleware);
  assert.equal(typeof route.handlers[1], "function");
});

test("authentication middleware can block collection access before the handler", () => {
  let handlerCalled = false;
  const authMiddleware = (_req, res) =>
    res.status(401).json({
      success: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication required.",
    });
  const { route } = register({
    authMiddleware,
    listOwnedEmergencyRequests: async () => {
      handlerCalled = true;
      return {};
    },
  });
  const response = createResponse();

  route.handlers[0]({}, response, () => {
    handlerCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.equal(
    response.payload.code,
    "AUTHENTICATION_REQUIRED"
  );
  assert.equal(handlerCalled, false);
});

test("collection handler derives owner only from req.user and passes validated options", async () => {
  let received;
  const { pool, route } = register({
    listOwnedEmergencyRequests: async (args) => {
      received = args;
      return {
        ok: true,
        status: 200,
        code: "EMERGENCY_REQUESTS_RETRIEVED",
        emergencyRequests: [],
      };
    },
  });
  const response = createResponse();

  await route.handlers[1](
    {
      pool,
      user: { id: 7 },
      query: {
        view: "history",
        limit: "50",
      },
    },
    response
  );

  assert.deepEqual(received, {
    pool,
    homeownerUserId: 7,
    options: {
      view: "history",
      limit: 50,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    success: true,
    code: "EMERGENCY_REQUESTS_RETRIEVED",
    emergencyRequests: [],
  });
});

test("collection defaults to active view and limit 25", async () => {
  let received;
  const { pool, route } = register({
    listOwnedEmergencyRequests: async (args) => {
      received = args;
      return {
        ok: true,
        status: 200,
        code: "EMERGENCY_REQUESTS_RETRIEVED",
        emergencyRequests: [],
      };
    },
  });

  await route.handlers[1](
    {
      pool,
      user: { id: 7 },
      query: {},
    },
    createResponse()
  );

  assert.deepEqual(received.options, {
    view: "active",
    limit: 25,
  });
});

test("collection response preserves only the approved Emergency relationship preview", async () => {
  const summary = {
    emergencyRequestId: 41,
    title: "Active pipe leak",
    serviceSpecialty: "emergency_plumbing",
    status: "assigned",
    createdAt: "2026-07-29T14:00:00.000Z",
    requestedAt: "2026-07-29T14:02:00.000Z",
    assignedAt: "2026-07-29T14:10:00.000Z",
    enRouteAt: null,
    arrivedAt: null,
    workStartedAt: null,
    completedAt: null,
    cancelledAt: null,
    expiredAt: null,
    availableResponseCount: 0,
    hasSelectedProfessional: true,
    selectedProfessionalBusinessName:
      "Molina Home Services",
    conversationAvailable: true,
    conversationId: 201,
  };
  const { pool, route } = register({
    listOwnedEmergencyRequests: async () => ({
      ok: true,
      status: 200,
      code: "EMERGENCY_REQUESTS_RETRIEVED",
      emergencyRequests: [summary],
    }),
  });
  const response = createResponse();

  await route.handlers[1](
    {
      pool,
      user: { id: 7 },
      query: {},
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.payload.emergencyRequests,
    [summary]
  );
  assert.doesNotMatch(
    JSON.stringify(response.payload),
    /location|unitNumber|accessNotes|safety|email|phone|homeownerId|contractorId|relationshipId|message|unread/i
  );
});

test("hostile owner authority and GET bodies are rejected before pool or service access", async () => {
  for (const request of [
    {
      user: { id: 7 },
      query: { homeownerId: "999" },
    },
    {
      user: { id: 7 },
      query: {},
      body: { homeownerId: 999 },
    },
    {
      user: { id: 7 },
      query: { view: "active", limit: "51" },
    },
  ]) {
    let serviceCalled = false;
    const { route } = register({
      listOwnedEmergencyRequests: async () => {
        serviceCalled = true;
        return {};
      },
    });
    const response = createResponse();

    await route.handlers[1](request, response);

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.payload.code,
      "EMERGENCY_REQUEST_LIST_INVALID"
    );
    assert.equal(serviceCalled, false);
  }
});

test("database failures use the stable public Emergency error contract", async () => {
  const privateError = new Error(
    "postgres://private-host/emergency-requests"
  );
  const { pool, route } = register({
    listOwnedEmergencyRequests: async () => {
      throw privateError;
    },
    sendPublicDatabaseError({
      res,
      error,
      operation,
      code,
      message,
    }) {
      assert.equal(error, privateError);
      assert.equal(
        operation,
        "list_homeowner_emergency_requests"
      );
      return res.status(500).json({
        success: false,
        code,
        message,
      });
    },
  });
  const response = createResponse();

  await route.handlers[1](
    {
      pool,
      user: { id: 7 },
      query: {},
    },
    response
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.payload, {
    success: false,
    code: "EMERGENCY_REQUESTS_FETCH_FAILED",
    message: "Emergency requests could not be loaded.",
  });
  assert.doesNotMatch(
    JSON.stringify(response.payload),
    /private-host|postgres/i
  );
});
