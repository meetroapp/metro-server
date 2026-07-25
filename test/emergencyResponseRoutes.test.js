"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerEmergencyRequestRoutes,
} = require("../server/emergency/emergencyRequests");

const RESPONSE_PATH =
  "/professional-emergency-opportunities/:emergencyRequestId/respond";

function response() {
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

function register({
  authMiddleware = (_req, _res, next) => next(),
  relationshipService,
  getPool = (req) => req.pool,
  sendPublicDatabaseError = ({ res, code, message }) =>
    res.status(500).json({ error: code, message }),
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

  registerEmergencyRequestRoutes({
    app,
    authMiddleware,
    getPool,
    sendPublicDatabaseError,
    service: requestServiceStub(),
    opportunityService: {
      async listProfessionalEmergencyOpportunities() {
        return { ok: true, opportunities: [] };
      },
      professionalCanSeeEmergencyOpportunity() {
        return true;
      },
    },
    relationshipService:
      relationshipService || {
        async createProfessionalEmergencyResponse() {
          return {
            ok: true,
            status: 201,
            code: "EMERGENCY_RESPONSE_CREATED",
            created: true,
            relationship: {
              id: 151,
              emergency_request_id: 41,
              status: "pending",
              created_at: "created",
              responded_at: "responded",
            },
          };
        },
      },
  });

  return {
    authMiddleware,
    route: routes.find(
      (item) => item.method === "POST" && item.path === RESPONSE_PATH
    ),
    routes,
  };
}

test("Emergency response route is registered with authentication first", () => {
  const { route, authMiddleware } = register();
  assert.ok(route);
  assert.equal(route.handlers.length, 2);
  assert.equal(route.handlers[0], authMiddleware);
  assert.equal(typeof route.handlers[1], "function");
});

test("unauthenticated response cannot access the database or service", () => {
  let databaseAccessed = false;
  let serviceAccessed = false;
  const { route } = register({
    authMiddleware(_req, res) {
      return res.status(401).json({
        success: false,
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication required.",
      });
    },
    getPool() {
      databaseAccessed = true;
      throw new Error("Database must not be accessed.");
    },
    relationshipService: {
      async createProfessionalEmergencyResponse() {
        serviceAccessed = true;
        throw new Error("Service must not be accessed.");
      },
    },
  });
  const res = response();
  route.handlers[0]({}, res, () => route.handlers[1]({}, res));
  assert.equal(res.statusCode, 401);
  assert.equal(databaseAccessed, false);
  assert.equal(serviceAccessed, false);
});

test("handler derives authority from authentication and passes exact path and body", async () => {
  const pool = { marker: "pool" };
  let received;
  const { route } = register({
    relationshipService: {
      async createProfessionalEmergencyResponse(args) {
        received = args;
        return {
          ok: false,
          status: 400,
          code: "UNSUPPORTED_EMERGENCY_RESPONSE_FIELDS",
          message: "Emergency responses do not accept request fields.",
        };
      },
    },
  });
  const body = {
    professionalUserId: 999,
    contractorId: 888,
    status: "active",
  };
  const res = response();
  await route.handlers[1](
    {
      pool,
      user: { id: 9 },
      params: { emergencyRequestId: "41" },
      body,
    },
    res
  );

  assert.equal(received.pool, pool);
  assert.equal(received.professionalUserId, 9);
  assert.equal(received.emergencyRequestId, "41");
  assert.equal(received.payload, body);
  assert.equal(typeof received.professionalCanSeeEmergencyOpportunity, "function");
  assert.equal(res.statusCode, 400);
});

test("created and idempotent responses use the exact privacy-safe contract", async () => {
  for (const created of [true, false]) {
    const { route } = register({
      relationshipService: {
        async createProfessionalEmergencyResponse() {
          return {
            ok: true,
            status: created ? 201 : 200,
            code: created
              ? "EMERGENCY_RESPONSE_CREATED"
              : "EMERGENCY_RESPONSE_EXISTS",
            created,
            relationship: {
              id: 151,
              post_id: null,
              emergency_request_id: 41,
              homeowner_id: 7,
              contractor_id: 80,
              professional_user_id: 9,
              status: "pending",
              introduction_text: "",
              created_at: "created",
              responded_at: "responded",
              location_text: "Private",
              conversation_id: 91,
            },
          };
        },
      },
    });
    const res = response();
    await route.handlers[1](
      {
        pool: {},
        user: { id: 9 },
        params: { emergencyRequestId: "41" },
        body: {},
      },
      res
    );

    assert.equal(res.statusCode, created ? 201 : 200);
    assert.deepEqual(res.payload, {
      success: true,
      code: created
        ? "EMERGENCY_RESPONSE_CREATED"
        : "EMERGENCY_RESPONSE_EXISTS",
      created,
      relationship: {
        id: 151,
        emergencyRequestId: 41,
        status: "pending",
        conversationAvailable: false,
        createdAt: "created",
        respondedAt: "responded",
      },
    });
    assert.deepEqual(Object.keys(res.payload.relationship), [
      "id",
      "emergencyRequestId",
      "status",
      "conversationAvailable",
      "createdAt",
      "respondedAt",
    ]);
  }
});

test("service profile, availability, and terminal failures preserve status and contract", async () => {
  for (const failure of [
    {
      status: 403,
      code: "PROFESSIONAL_PROFILE_REQUIRED",
      message:
        "A business profile is required to respond to Emergency opportunities.",
    },
    {
      status: 404,
      code: "EMERGENCY_OPPORTUNITY_NOT_AVAILABLE",
      message: "The Emergency opportunity is not available for response.",
    },
    {
      status: 409,
      code: "EMERGENCY_RESPONSE_NOT_PENDING",
      message: "This Emergency response is no longer pending.",
    },
  ]) {
    const { route } = register({
      relationshipService: {
        async createProfessionalEmergencyResponse() {
          return { ok: false, ...failure };
        },
      },
    });
    const res = response();
    await route.handlers[1](
      {
        pool: {},
        user: { id: 9 },
        params: { emergencyRequestId: "41" },
        body: {},
      },
      res
    );
    assert.equal(res.statusCode, failure.status);
    assert.deepEqual(res.payload, {
      success: false,
      code: failure.code,
      message: failure.message,
    });
  }
});

test("database failures use the existing normalized public contract", async () => {
  const privateError = new Error("postgres://private-host/private-db");
  let normalized;
  const { route } = register({
    relationshipService: {
      async createProfessionalEmergencyResponse() {
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
  const res = response();
  await route.handlers[1](
    {
      pool: {},
      user: { id: 9 },
      params: { emergencyRequestId: "41" },
      body: {},
    },
    res
  );

  assert.equal(normalized.operation, "create_emergency_response");
  assert.equal(normalized.error, privateError);
  assert.deepEqual(res.payload, {
    error: "EMERGENCY_RESPONSE_CREATE_FAILED",
    message: "The Emergency response could not be created.",
  });
  assert.doesNotMatch(JSON.stringify(res.payload), /private-host|private-db/);
});
