"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerEmergencyRequestRoutes,
} = require("../server/emergency/emergencyRequests");

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

function serviceStub() {
  return {
    async cancelEmergencyRequest() {},
    async createEmergencyDraft() {},
    async getOwnedEmergencyRequest() {},
    async listOwnedEmergencyRequests() {},
    async prepareEmergencyRequest() {},
    async saveEmergencySafetyAssessment() {},
    async updateEmergencyDraft() {},
    validateEmergencyRequestListOptions() {
      return {
        valid: true,
        value: {},
      };
    },
  };
}

function register({
  authMiddleware = (_req, _res, next) => next(),
  listHomeownerAvailableEmergencyProfessionals =
    async () => ({
      ok: true,
      status: 200,
      code:
        "EMERGENCY_AVAILABLE_PROFESSIONALS_FOUND",
      emergencyRequest: {
        id: 41,
        status: "ready_for_distribution",
      },
      professionals: [],
    }),
  getPool = (req) => req.pool,
  sendPublicDatabaseError = ({
    res,
    code,
    message,
  }) =>
    res.status(500).json({
      success: false,
      code,
      message,
    }),
} = {}) {
  const calls = [];

  const app = {
    get(path, ...handlers) {
      calls.push({
        method: "GET",
        path,
        handlers,
      });
    },
    patch(path, ...handlers) {
      calls.push({
        method: "PATCH",
        path,
        handlers,
      });
    },
    post(path, ...handlers) {
      calls.push({
        method: "POST",
        path,
        handlers,
      });
    },
  };

  registerEmergencyRequestRoutes({
    app,
    authMiddleware,
    getPool,
    sendPublicDatabaseError,
    service: serviceStub(),
    opportunityService: {
      listHomeownerAvailableEmergencyProfessionals,
      async listProfessionalEmergencyOpportunities() {
        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_OPPORTUNITIES_FOUND",
          opportunities: [],
        };
      },
      professionalCanSeeEmergencyOpportunity() {
        return true;
      },
    },
  });

  return {
    calls,
    authMiddleware,
  };
}

function discoveryRoute(calls) {
  return calls.find(
    ({ method, path }) =>
      method === "GET" &&
      path ===
        "/emergency-requests/:emergencyRequestId/available-professionals"
  );
}

test("Available Now discovery route is authenticated", () => {
  const {
    calls,
    authMiddleware,
  } = register();

  const route = discoveryRoute(calls);

  assert.ok(route);
  assert.equal(route.handlers.length, 2);
  assert.equal(
    route.handlers[0],
    authMiddleware
  );
});

test("authenticated homeowner identity and route request ID are the only authority inputs", async () => {
  let received;

  const pool = {
    marker: "pool",
  };

  const { calls } = register({
    async listHomeownerAvailableEmergencyProfessionals(
      args
    ) {
      received = args;

      return {
        ok: true,
        status: 200,
        code:
          "EMERGENCY_AVAILABLE_PROFESSIONALS_FOUND",
        emergencyRequest: {
          id: 41,
          status: "ready_for_distribution",
        },
        professionals: [],
      };
    },
  });

  const req = {
    pool,
    user: {
      id: 9,
    },
    params: {
      emergencyRequestId: "41",
    },
    query: {
      homeownerUserId: 999,
    },
    body: {
      homeownerUserId: 888,
    },
  };

  const res = createResponse();

  await discoveryRoute(calls).handlers[1](
    req,
    res
  );

  assert.deepEqual(received, {
    pool,
    homeownerUserId: 9,
    emergencyRequestId: "41",
  });
});

test("route returns only bounded Emergency request and professional discovery projection", async () => {
  const professionals = [
    {
      contractorProfileId: 17,
      businessName: "Cape Electric",
      category: "electrical",
      serviceSpecialties: ["electrical"],
      profileImageUrl: "",
      serviceArea: "Cape Coral",
      availableNow: true,
      dispatchReady: true,
    },
  ];

  const { calls } = register({
    async listHomeownerAvailableEmergencyProfessionals() {
      return {
        ok: true,
        status: 200,
        code:
          "EMERGENCY_AVAILABLE_PROFESSIONALS_FOUND",
        emergencyRequest: {
          id: 41,
          homeowner_id: 9,
          status: "ready_for_distribution",
          location_text:
            "123 Private Address, Cape Coral",
          disposition: "continue",
        },
        professionals,
      };
    },
  });

  const res = createResponse();

  await discoveryRoute(calls).handlers[1](
    {
      pool: {},
      user: {
        id: 9,
      },
      params: {
        emergencyRequestId: "41",
      },
    },
    res
  );

  assert.deepEqual(res.payload, {
    success: true,
    code:
      "EMERGENCY_AVAILABLE_PROFESSIONALS_FOUND",
    emergencyRequest: {
      id: 41,
      status: "ready_for_distribution",
    },
    professionals,
  });

  assert.equal(
    JSON.stringify(res.payload).includes(
      "123 Private Address"
    ),
    false
  );
});

test("ineligible request preserves safe service error contract", async () => {
  const { calls } = register({
    async listHomeownerAvailableEmergencyProfessionals() {
      return {
        ok: false,
        status: 409,
        code:
          "EMERGENCY_REQUEST_NOT_DISCOVERABLE",
        message:
          "This Emergency request is not available for Available Now discovery.",
      };
    },
  });

  const res = createResponse();

  await discoveryRoute(calls).handlers[1](
    {
      pool: {},
      user: {
        id: 9,
      },
      params: {
        emergencyRequestId: "41",
      },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, {
    success: false,
    code:
      "EMERGENCY_REQUEST_NOT_DISCOVERABLE",
    message:
      "This Emergency request is not available for Available Now discovery.",
  });
});
