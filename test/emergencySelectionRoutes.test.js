"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerEmergencyRequestRoutes,
} = require(
  "../server/emergency/emergencyRequests"
);

const selectionPath =
  "/emergency-requests/:emergencyRequestId/responses/:relationshipId/select";

function createResponse() {
  return {
    statusCode: 200,
    payload: null,

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

function requestService() {
  return {
    async cancelEmergencyRequest() {},
    async createEmergencyDraft() {},
    async getOwnedEmergencyRequest() {},
    async prepareEmergencyRequest() {},
    async saveEmergencySafetyAssessment() {},
    async updateEmergencyDraft() {},
  };
}

function opportunityService() {
  return {
    async listProfessionalEmergencyOpportunities() {
      return {
        ok: true,
        opportunities: [],
      };
    },

    professionalCanSeeEmergencyOpportunity() {
      return true;
    },
  };
}

function relationshipService() {
  return {
    async createProfessionalEmergencyResponse() {},

    async listHomeownerEmergencyResponses() {
      return {
        ok: true,
        emergencyRequest: {
          id: 41,
        },
        responses: [],
      };
    },
  };
}

function successResult(overrides = {}) {
  return {
    ok: true,
    status: 200,
    code: "EMERGENCY_RESPONSE_SELECTED",
    alreadySelected: false,
    declinedResponseCount: 2,

    emergencyRequest: {
      id: 41,
      homeowner_id: 7,
      status: "assigned",
      assigned_at: "assigned-at",
      updated_at: "updated-at",
      location_text: "private",
    },

    relationship: {
      id: 151,
      emergency_request_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
      accepted_at: "accepted-at",
      introduction_text: "private",
    },

    conversation: {
      id: 91,
      relationship_id: 151,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    },

    ...overrides,
  };
}

function register({
  selectionService,
  authMiddleware =
    (_req, _res, next) => next(),
  getPool = (req) => req.pool,
  sendPublicDatabaseError =
    ({ res, code, message }) =>
      res.status(500).json({
        success: false,
        code,
        message,
      }),
} = {}) {
  const routes = [];

  const app = {
    get(path, ...handlers) {
      routes.push({
        method: "GET",
        path,
        handlers,
      });
    },

    patch(path, ...handlers) {
      routes.push({
        method: "PATCH",
        path,
        handlers,
      });
    },

    post(path, ...handlers) {
      routes.push({
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
    service: requestService(),
    opportunityService:
      opportunityService(),
    relationshipService:
      relationshipService(),
    selectionService,
  });

  return routes.find(
    ({ method, path }) =>
      method === "POST" &&
      path === selectionPath
  );
}

test(
  "selection route uses authentication middleware first",
  () => {
    const authMiddleware =
      (_req, _res, next) => next();

    const route = register({
      authMiddleware,

      selectionService: {
        async selectHomeownerEmergencyResponse() {
          return successResult();
        },
      },
    });

    assert.ok(route);
    assert.equal(route.handlers.length, 2);
    assert.equal(
      route.handlers[0],
      authMiddleware
    );
  }
);

test(
  "selection uses authenticated homeowner identity",
  async () => {
    const pool = {
      marker: "pool",
    };

    let received;

    const route = register({
      selectionService: {
        async selectHomeownerEmergencyResponse(args) {
          received = args;
          return successResult();
        },
      },
    });

    const res = createResponse();

    await route.handlers[1](
      {
        pool,

        user: {
          id: 7,
        },

        params: {
          emergencyRequestId: "41",
          relationshipId: "151",
        },

        body: {
          homeownerUserId: 999,
          status: "active",
        },
      },
      res
    );

    assert.deepEqual(received, {
      pool,
      homeownerUserId: 7,
      emergencyRequestId: "41",
      relationshipId: "151",
    });
  }
);

test(
  "selection returns privacy-safe canonical response",
  async () => {
    const route = register({
      selectionService: {
        async selectHomeownerEmergencyResponse() {
          return successResult();
        },
      },
    });

    const res = createResponse();

    await route.handlers[1](
      {
        pool: {},
        user: {
          id: 7,
        },
        params: {
          emergencyRequestId: "41",
          relationshipId: "151",
        },
      },
      res
    );

    assert.equal(res.statusCode, 200);

    assert.deepEqual(res.payload, {
      success: true,
      code: "EMERGENCY_RESPONSE_SELECTED",
      alreadySelected: false,
      declinedResponseCount: 2,

      emergencyRequest: {
        id: 41,
        status: "assigned",
        assignedAt: "assigned-at",
        updatedAt: "updated-at",
      },

      relationship: {
        id: 151,
        emergencyRequestId: 41,
        status: "active",
        acceptedAt: "accepted-at",
        conversationAvailable: true,
      },

      conversation: {
        id: 91,
        relationshipId: 151,
        status: "active",
      },
    });

    assert.doesNotMatch(
      JSON.stringify(res.payload),
      /homeowner_id|contractor_id|professional_user_id|location_text|introduction_text/
    );
  }
);

test(
  "service failure preserves public failure contract",
  async () => {
    const route = register({
      selectionService: {
        async selectHomeownerEmergencyResponse() {
          return {
            ok: false,
            status: 409,
            code:
              "EMERGENCY_REQUEST_ALREADY_ASSIGNED",
            message:
              "A professional has already been selected for this Emergency request.",
          };
        },
      },
    });

    const res = createResponse();

    await route.handlers[1](
      {
        pool: {},
        user: {
          id: 7,
        },
        params: {
          emergencyRequestId: "41",
          relationshipId: "151",
        },
      },
      res
    );

    assert.equal(res.statusCode, 409);

    assert.deepEqual(res.payload, {
      success: false,
      code:
        "EMERGENCY_REQUEST_ALREADY_ASSIGNED",
      message:
        "A professional has already been selected for this Emergency request.",
    });
  }
);

test(
  "unexpected failures use normalized public error",
  async () => {
    const privateError = new Error(
      "private database connection"
    );

    let normalized;

    const route = register({
      selectionService: {
        async selectHomeownerEmergencyResponse() {
          throw privateError;
        },
      },

      sendPublicDatabaseError(args) {
        normalized = args;

        return args.res.status(500).json({
          success: false,
          code: args.code,
          message: args.message,
        });
      },
    });

    const res = createResponse();

    await route.handlers[1](
      {
        pool: {},
        user: {
          id: 7,
        },
        params: {
          emergencyRequestId: "41",
          relationshipId: "151",
        },
      },
      res
    );

    assert.equal(
      normalized.operation,
      "select_emergency_response"
    );

    assert.equal(
      normalized.error,
      privateError
    );

    assert.deepEqual(res.payload, {
      success: false,
      code:
        "EMERGENCY_RESPONSE_SELECT_FAILED",
      message:
        "The Emergency response could not be selected.",
    });

    assert.doesNotMatch(
      JSON.stringify(res.payload),
      /private database connection/
    );
  }
);
