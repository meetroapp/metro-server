"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
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

function requestServiceStub() {
  return {
    async cancelEmergencyRequest() {},
    async createEmergencyDraft() {},
    async getOwnedEmergencyRequest() {},
    async prepareEmergencyRequest() {},
    async saveEmergencySafetyAssessment() {},
    async updateEmergencyDraft() {},
  };
}

function registerRoutes({
  authMiddleware = (_req, _res, next) => next(),
  opportunityService,
  getPool = (req) => req.pool,
  sendPublicDatabaseError = ({ res, code, message }) =>
    res.status(500).json({ error: code, message }),
} = {}) {
  const calls = [];
  const app = {
    get(path, ...handlers) {
      calls.push({ method: "GET", path, handlers });
    },
    patch(path, ...handlers) {
      calls.push({ method: "PATCH", path, handlers });
    },
    post(path, ...handlers) {
      calls.push({ method: "POST", path, handlers });
    },
  };

  registerEmergencyRequestRoutes({
    app,
    authMiddleware,
    getPool,
    sendPublicDatabaseError,
    service: requestServiceStub(),
    opportunityService:
      opportunityService || {
        async listProfessionalEmergencyOpportunities() {
          return {
            ok: true,
            status: 200,
            code: "EMERGENCY_OPPORTUNITIES_FOUND",
            opportunities: [],
          };
        },
      },
  });

  return { calls, authMiddleware };
}

function opportunityRoute(calls) {
  return calls.find(
    (route) =>
      route.method === "GET" &&
      route.path === "/professional-emergency-opportunities"
  );
}

test("professional Emergency opportunity GET is registered with authentication first", () => {
  const { calls, authMiddleware } = registerRoutes();
  const route = opportunityRoute(calls);

  assert.ok(route);
  assert.equal(route.handlers.length, 2);
  assert.equal(route.handlers[0], authMiddleware);
  assert.equal(typeof route.handlers[1], "function");
});

test("unauthenticated retrieval returns 401 without database or service access", () => {
  let databaseAccessed = false;
  let serviceAccessed = false;
  const authMiddleware = (_req, res) =>
    res.status(401).json({
      success: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication required.",
    });
  const { calls } = registerRoutes({
    authMiddleware,
    getPool() {
      databaseAccessed = true;
      throw new Error("Database must not be reached.");
    },
    opportunityService: {
      async listProfessionalEmergencyOpportunities() {
        serviceAccessed = true;
        throw new Error("Service must not be reached.");
      },
    },
  });
  const route = opportunityRoute(calls);
  const res = createResponse();
  let handlerCalled = false;

  route.handlers[0]({}, res, () => {
    handlerCalled = true;
    return route.handlers[1]({}, res);
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, "AUTHENTICATION_REQUIRED");
  assert.equal(handlerCalled, false);
  assert.equal(databaseAccessed, false);
  assert.equal(serviceAccessed, false);
});

test("authenticated identity is the only professional authority passed to the service", async () => {
  const pool = { marker: "pool" };
  let received;
  const { calls } = registerRoutes({
    opportunityService: {
      async listProfessionalEmergencyOpportunities(args) {
        received = args;
        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_OPPORTUNITIES_FOUND",
          opportunities: [],
        };
      },
    },
  });
  const route = opportunityRoute(calls);
  const req = {
    pool,
    user: { id: 7 },
    query: { professionalUserId: 999, contractorId: 888 },
    body: { professionalUserId: 777, contractorId: 666 },
  };
  const res = createResponse();

  await route.handlers[1](req, res);

  assert.equal(received.pool, pool);
  assert.equal(received.professionalUserId, 7);
  assert.deepEqual(Object.keys(received).sort(), [
    "pool",
    "professionalUserId",
  ]);
  assert.equal(res.statusCode, 200);
});

test("success and empty retrieval return the stable public contract", async () => {
  for (const opportunities of [
    [],
    [
      {
        id: 41,
        sourceType: "emergency",
        category: "home_repair",
        serviceDomain: "home_services",
        serviceSpecialty: "emergency_electrical_service",
        title: "Partial power outage",
        description: "Several rooms have lost power.",
        status: "ready_for_distribution",
        requestedAt: "requested",
        createdAt: "created",
        updatedAt: "updated",
        participation: null,
        relationship: null,
        conversation: null,
      },
    ],
  ]) {
    const { calls } = registerRoutes({
      opportunityService: {
        async listProfessionalEmergencyOpportunities() {
          return {
            ok: true,
            status: 200,
            code: "EMERGENCY_OPPORTUNITIES_FOUND",
            opportunities,
          };
        },
      },
    });
    const route = opportunityRoute(calls);
    const res = createResponse();

    await route.handlers[1]({ pool: {}, user: { id: 7 } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
      success: true,
      code: "EMERGENCY_OPPORTUNITIES_FOUND",
      opportunities,
    });
  }
});

test("route preserves only bounded professional participation truth", async () => {
  for (const participation of [{ state: "pending" }, null]) {
    const opportunity = {
      id: 41,
      sourceType: "emergency",
      category: "home_repair",
      serviceDomain: "home_services",
      serviceSpecialty: "emergency_electrical_service",
      title: "Partial power outage",
      description: "Several rooms have lost power.",
      status: "ready_for_distribution",
      requestedAt: "requested",
      createdAt: "created",
      updatedAt: "updated",
      participation,
      relationship: null,
      conversation: null,
    };
    const { calls } = registerRoutes({
      opportunityService: {
        async listProfessionalEmergencyOpportunities() {
          return {
            ok: true,
            status: 200,
            code: "EMERGENCY_OPPORTUNITIES_FOUND",
            opportunities: [opportunity],
          };
        },
      },
    });
    const res = createResponse();

    await opportunityRoute(calls).handlers[1](
      { pool: {}, user: { id: participation ? 7 : 8 } },
      res
    );

    assert.deepEqual(res.payload.opportunities, [opportunity]);
    assert.equal(
      Object.hasOwn(res.payload.opportunities[0], "relationshipId"),
      false
    );
    assert.equal(
      Object.hasOwn(res.payload.opportunities[0], "professionalUserId"),
      false
    );
  }
});

test("missing professional profile preserves service status, code, and message", async () => {
  const { calls } = registerRoutes({
    opportunityService: {
      async listProfessionalEmergencyOpportunities() {
        return {
          ok: false,
          status: 403,
          code: "PROFESSIONAL_PROFILE_REQUIRED",
          message: "A business profile is required to view Emergency opportunities.",
        };
      },
    },
  });
  const res = createResponse();

  await opportunityRoute(calls).handlers[1](
    { pool: {}, user: { id: 7 } },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, {
    success: false,
    code: "PROFESSIONAL_PROFILE_REQUIRED",
    message: "A business profile is required to view Emergency opportunities.",
  });
});

test("database failures use only the approved safe fallback contract", async () => {
  const privateError = new Error("postgres://private-host/private-db");
  let normalized;
  const { calls } = registerRoutes({
    opportunityService: {
      async listProfessionalEmergencyOpportunities() {
        throw privateError;
      },
    },
    sendPublicDatabaseError(args) {
      normalized = args;
      return args.res.status(500).json({
        error: args.code,
        message: args.message,
      });
    },
  });
  const res = createResponse();

  await opportunityRoute(calls).handlers[1](
    { pool: {}, user: { id: 7 } },
    res
  );

  assert.equal(
    normalized.operation,
    "list_professional_emergency_opportunities"
  );
  assert.equal(normalized.error, privateError);
  assert.deepEqual(res.payload, {
    error: "EMERGENCY_OPPORTUNITIES_FETCH_FAILED",
    message: "Emergency opportunities could not be loaded.",
  });
  assert.doesNotMatch(
    JSON.stringify(res.payload),
    /private-host|private-db|postgres/i
  );
});

test("existing authenticated Emergency homeowner routes remain registered", () => {
  const { calls, authMiddleware } = registerRoutes();
  const homeownerRoutes = calls.filter((route) =>
    route.path.startsWith("/emergency-requests/")
  );

  assert.equal(homeownerRoutes.length, 12);
  assert.ok(
    homeownerRoutes.some(
      (route) =>
        route.method === "GET" &&
        route.path ===
          "/emergency-requests/:emergencyRequestId/responses"
    )
  );
  assert.ok(
    homeownerRoutes.some(
      (route) =>
        route.method === "POST" &&
        route.path ===
          "/emergency-requests/:emergencyRequestId/responses/:relationshipId/select"
    )
  );
  for (const path of [
    "/emergency-requests/:emergencyRequestId/en-route",
    "/emergency-requests/:emergencyRequestId/arrived",
    "/emergency-requests/:emergencyRequestId/start",
    "/emergency-requests/:emergencyRequestId/complete",
  ]) {
    assert.equal(
      homeownerRoutes.filter(
        (route) =>
          route.method === "POST" &&
          route.path === path
      ).length,
      1
    );
  }
  for (const route of homeownerRoutes) {
    assert.equal(route.handlers[0], authMiddleware);
  }
});

test("Emergency retrieval remains separate from standard read-only opportunities", () => {
  const indexSource = readFileSync(
    require.resolve("../index.js"),
    "utf8"
  );
  const emergencySource = readFileSync(
    require.resolve("../server/emergency/emergencyOpportunityService.js"),
    "utf8"
  );
  const standardSource = readFileSync(
    require.resolve("../server/requests/professionalOpportunityService.js"),
    "utf8"
  );

  assert.match(
    indexSource,
    /app\.get\("\/professional-request-opportunities", authMiddleware/
  );
  assert.match(
    standardSource,
    /async function listProfessionalOpportunities/
  );
  assert.doesNotMatch(
    standardSource,
    /\b(INSERT|UPDATE|DELETE)\b/
  );
  assert.doesNotMatch(
    emergencySource,
    /listProfessionalOpportunities|professionalOpportunityService/
  );
});
