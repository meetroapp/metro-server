"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerEmergencyRequestRoutes,
} = require("../server/emergency/emergencyRequests");

const RESPONSE_INBOX_PATH =
  "/emergency-requests/:emergencyRequestId/responses";

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
        async createProfessionalEmergencyResponse() {},
        async listHomeownerEmergencyResponses() {
          return {
            ok: true,
            status: 200,
            code: "EMERGENCY_RESPONSES_FOUND",
            emergencyRequest: {
              id: 41,
              status: "ready_for_distribution",
            },
            responses: [],
          };
        },
      },
  });

  return {
    authMiddleware,
    route: routes.find(
      (item) =>
        item.method === "GET" &&
        item.path === RESPONSE_INBOX_PATH
    ),
    routes,
  };
}

test("homeowner Emergency response route is registered with authentication first", () => {
  const { route, authMiddleware } = register();
  assert.ok(route);
  assert.equal(route.handlers.length, 2);
  assert.equal(route.handlers[0], authMiddleware);
  assert.equal(typeof route.handlers[1], "function");
});

test("unauthenticated retrieval cannot access the database or service", () => {
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
      async createProfessionalEmergencyResponse() {},
      async listHomeownerEmergencyResponses() {
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

test("handler derives homeowner authority only from authentication and passes the path ID exactly", async () => {
  const pool = { marker: "pool" };
  let received;
  const { route } = register({
    relationshipService: {
      async createProfessionalEmergencyResponse() {},
      async listHomeownerEmergencyResponses(args) {
        received = args;
        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_RESPONSES_FOUND",
          emergencyRequest: {
            id: 41,
            status: "ready_for_distribution",
          },
          responses: [],
        };
      },
    },
  });
  const res = response();

  await route.handlers[1](
    {
      pool,
      user: { id: 7 },
      params: {
        emergencyRequestId: "41",
        homeownerUserId: "999",
      },
      query: { homeownerUserId: 888 },
      body: { homeownerUserId: 777 },
      headers: { "x-homeowner-id": "666" },
    },
    res
  );

  assert.deepEqual(received, {
    pool,
    homeownerUserId: 7,
    emergencyRequestId: "41",
  });
  assert.equal(res.statusCode, 200);
});

test("invalid, missing, and cross-owner failures preserve the service contract", async () => {
  for (const failure of [
    {
      status: 400,
      code: "INVALID_EMERGENCY_REQUEST_ID",
      message: "A valid Emergency request ID is required.",
    },
    {
      status: 404,
      code: "EMERGENCY_REQUEST_NOT_FOUND",
      message: "The Emergency request was not found.",
    },
    {
      status: 404,
      code: "EMERGENCY_REQUEST_NOT_FOUND",
      message: "The Emergency request was not found.",
    },
  ]) {
    const { route } = register({
      relationshipService: {
        async createProfessionalEmergencyResponse() {},
        async listHomeownerEmergencyResponses() {
          return { ok: false, ...failure };
        },
      },
    });
    const res = response();

    await route.handlers[1](
      {
        pool: {},
        user: { id: 7 },
        params: { emergencyRequestId: "41" },
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

test("populated retrieval returns the exact privacy-safe contract", async () => {
  const { route } = register({
    relationshipService: {
      async createProfessionalEmergencyResponse() {},
      async listHomeownerEmergencyResponses() {
        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_RESPONSES_FOUND",
          emergencyRequest: {
            id: 41,
            status: "ready_for_distribution",
            homeowner_id: 7,
            location_text: "Private",
          },
          responses: [
            {
              id: 151,
              emergency_request_id: 41,
              homeowner_id: 7,
              contractor_id: 80,
              professional_user_id: 9,
              post_id: null,
              status: "active",
              introduction_text: "Private response data",
              responded_at: "responded",
              created_at: "created",
              accepted_at: "accepted",
              declined_at: null,
              withdrawn_at: null,
              closed_at: null,
              canonical_conversation_exists: true,
              conversation_id: 91,
              business_name: "Example Electric",
              professional_category: "electrical",
              service_specialties: ["emergency_wiring"],
              business_image_url:
                "https://example.test/business-logo.jpg",
              email: "private@example.test",
              phone: "555-0100",
              profile_details: { private: true },
            },
          ],
        };
      },
    },
  });
  const res = response();

  await route.handlers[1](
    {
      pool: {},
      user: { id: 7 },
      params: { emergencyRequestId: "41" },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    success: true,
    code: "EMERGENCY_RESPONSES_FOUND",
    emergencyRequest: {
      id: 41,
      status: "ready_for_distribution",
    },
    responses: [
      {
        id: 151,
        emergencyRequestId: 41,
        status: "active",
        respondedAt: "responded",
        createdAt: "created",
        acceptedAt: "accepted",
        declinedAt: null,
        withdrawnAt: null,
        closedAt: null,
        conversationAvailable: true,
        professional: {
          businessName: "Example Electric",
          category: "electrical",
          serviceSpecialties: ["emergency_wiring"],
          profileImageUrl: null,
          businessLogoUrl:
            "https://example.test/business-logo.jpg",
        },
      },
    ],
  });
  assert.deepEqual(Object.keys(res.payload.responses[0]), [
    "id",
    "emergencyRequestId",
    "status",
    "respondedAt",
    "createdAt",
    "acceptedAt",
    "declinedAt",
    "withdrawnAt",
    "closedAt",
    "conversationAvailable",
    "professional",
  ]);
  assert.doesNotMatch(
    JSON.stringify(res.payload),
    /homeowner_id|contractor_id|professional_user_id|post_id|introduction_text|conversation_id|private@example|555-0100|location_text|profile_details/
  );
});

test("empty retrieval remains HTTP 200 with the stable response code", async () => {
  const { route } = register();
  const res = response();

  await route.handlers[1](
    {
      pool: {},
      user: { id: 7 },
      params: { emergencyRequestId: "41" },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    success: true,
    code: "EMERGENCY_RESPONSES_FOUND",
    emergencyRequest: {
      id: 41,
      status: "ready_for_distribution",
    },
    responses: [],
  });
});

test("database failures use the normalized safe contract", async () => {
  const privateError = new Error(
    "postgres://private-host/emergency-responses"
  );
  let normalized;
  const { route } = register({
    relationshipService: {
      async createProfessionalEmergencyResponse() {},
      async listHomeownerEmergencyResponses() {
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
      user: { id: 7 },
      params: { emergencyRequestId: "41" },
    },
    res
  );

  assert.equal(normalized.operation, "fetch_emergency_responses");
  assert.equal(normalized.error, privateError);
  assert.deepEqual(res.payload, {
    error: "EMERGENCY_RESPONSES_FETCH_FAILED",
    message: "Emergency responses could not be loaded.",
  });
  assert.doesNotMatch(
    JSON.stringify(res.payload),
    /private-host|emergency-responses/
  );
});

test("existing professional Emergency routes remain registered unchanged", () => {
  const { routes } = register();
  const routeKeys = routes.map(
    ({ method, path }) => `${method} ${path}`
  );

  assert.ok(
    routeKeys.includes(
      "GET /professional-emergency-opportunities"
    )
  );
  assert.ok(
    routeKeys.includes(
      "POST /professional-emergency-opportunities/:emergencyRequestId/respond"
    )
  );
  assert.ok(
    routeKeys.includes(
      `GET ${RESPONSE_INBOX_PATH}`
    )
  );
});
