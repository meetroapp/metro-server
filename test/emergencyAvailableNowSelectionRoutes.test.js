"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const {
  registerEmergencyRequestRoutes,
} = require(
  "../server/emergency/emergencyRequests"
);

const selectionPath =
  "/emergency-requests/:emergencyRequestId/available-professionals/:contractorProfileId/select";

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

function opportunityService() {
  return {
    async listHomeownerAvailableEmergencyProfessionals() {
      return {
        ok: true,
        emergencyRequest: {
          id: 41,
          status:
            "ready_for_distribution",
        },
        professionals: [],
      };
    },

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
          status:
            "ready_for_distribution",
        },
        responses: [],
      };
    },
  };
}

function successResult(
  overrides = {}
) {
  return {
    ok: true,
    status: 200,
    code:
      "EMERGENCY_AVAILABLE_PROFESSIONAL_SELECTED",
    alreadySelected: false,
    declinedResponseCount: 2,

    emergencyRequest: {
      id: 41,
      homeowner_id: 7,
      status: "assigned",
      assigned_at: "assigned",
      updated_at: "updated",
      location_text:
        "private-address",
    },

    relationship: {
      id: 151,
      emergency_request_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      emergency_authority_source:
        "available_now_direct_select",
      status: "active",
      responded_at: null,
      accepted_at: "accepted",
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
    (_req, _res, next) =>
      next(),
  getPool =
    (req) => req.pool,
  sendPublicDatabaseError =
    ({
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
    service:
      requestService(),
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
  "Available Now selection route is authenticated first",
  () => {
    const authMiddleware =
      (_req, _res, next) =>
        next();

    const route =
      register({
        authMiddleware,
        selectionService: {
          async selectHomeownerAvailableEmergencyProfessional() {
            return successResult();
          },

          async selectHomeownerEmergencyResponse() {},
        },
      });

    assert.ok(route);

    assert.equal(
      route.handlers[0],
      authMiddleware
    );
  }
);

test(
  "direct selection uses only authenticated homeowner and route identities",
  async () => {
    let received;

    const pool = {
      marker: "pool",
    };

    const route =
      register({
        selectionService: {
          async selectHomeownerAvailableEmergencyProfessional(
            args
          ) {
            received = args;
            return successResult();
          },

          async selectHomeownerEmergencyResponse() {},
        },
      });

    const res =
      createResponse();

    await route.handlers[1](
      {
        pool,
        user: {
          id: 7,
        },
        params: {
          emergencyRequestId: "41",
          contractorProfileId: "80",
        },
        body: {
          homeownerUserId: 999,
          professionalUserId: 888,
          status: "active",
        },
      },
      res
    );

    assert.deepEqual(
      received,
      {
        pool,
        homeownerUserId: 7,
        emergencyRequestId:
          "41",
        contractorProfileId:
          "80",
      }
    );
  }
);

test(
  "direct selection returns only bounded canonical assignment identity",
  async () => {
    const route =
      register({
        selectionService: {
          async selectHomeownerAvailableEmergencyProfessional() {
            return successResult();
          },

          async selectHomeownerEmergencyResponse() {},
        },
      });

    const res =
      createResponse();

    await route.handlers[1](
      {
        pool: {},
        user: {
          id: 7,
        },
        params: {
          emergencyRequestId: "41",
          contractorProfileId: "80",
        },
      },
      res
    );

    assert.deepEqual(
      res.payload,
      {
        success: true,
        code:
          "EMERGENCY_AVAILABLE_PROFESSIONAL_SELECTED",
        alreadySelected: false,
        declinedResponseCount: 2,

        emergencyRequest: {
          id: 41,
          status: "assigned",
          assignedAt:
            "assigned",
          updatedAt:
            "updated",
        },

        relationship: {
          id: 151,
          emergencyRequestId: 41,
          status: "active",
          acceptedAt:
            "accepted",
          conversationAvailable:
            true,
        },

        conversation: {
          id: 91,
          relationshipId: 151,
          status: "active",
        },
      }
    );

    assert.doesNotMatch(
      JSON.stringify(
        res.payload
      ),
      /homeowner_id|contractor_id|professional_user_id|location_text|responded_at|emergency_authority_source/
    );
  }
);

test(
  "no-longer-available conflict remains a safe public response",
  async () => {
    const route =
      register({
        selectionService: {
          async selectHomeownerAvailableEmergencyProfessional() {
            return {
              ok: false,
              status: 409,
              code:
                "EMERGENCY_PROFESSIONAL_NO_LONGER_AVAILABLE",
              message:
                "This professional is no longer available for direct Emergency selection.",
            };
          },

          async selectHomeownerEmergencyResponse() {},
        },
      });

    const res =
      createResponse();

    await route.handlers[1](
      {
        pool: {},
        user: {
          id: 7,
        },
        params: {
          emergencyRequestId: "41",
          contractorProfileId: "80",
        },
      },
      res
    );

    assert.equal(
      res.statusCode,
      409
    );

    assert.equal(
      res.payload.code,
      "EMERGENCY_PROFESSIONAL_NO_LONGER_AVAILABLE"
    );
  }
);

test(
  "unexpected direct-select failure uses normalized public error",
  async () => {
    const privateError =
      new Error(
        "private database details"
      );

    let normalized;

    const route =
      register({
        selectionService: {
          async selectHomeownerAvailableEmergencyProfessional() {
            throw privateError;
          },

          async selectHomeownerEmergencyResponse() {},
        },

        sendPublicDatabaseError(
          args
        ) {
          normalized = args;

          return args.res
            .status(500)
            .json({
              success: false,
              code:
                args.code,
              message:
                args.message,
            });
        },
      });

    const res =
      createResponse();

    await route.handlers[1](
      {
        pool: {},
        user: {
          id: 7,
        },
        params: {
          emergencyRequestId: "41",
          contractorProfileId: "80",
        },
      },
      res
    );

    assert.equal(
      normalized.operation,
      "select_available_emergency_professional"
    );

    assert.equal(
      normalized.error,
      privateError
    );

    assert.doesNotMatch(
      JSON.stringify(
        res.payload
      ),
      /private database details/
    );
  }
);
