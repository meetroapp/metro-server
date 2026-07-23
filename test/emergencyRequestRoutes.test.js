"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createEmergencyRequestHandlers,
  registerEmergencyRequestRoutes,
  sendServiceResult,
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

function successfulEmergencyRequest(overrides = {}) {
  return {
    id: 41,
    category: "home_repair",
    serviceDomain: "electrical",
    serviceSpecialty: "emergency_wiring",
    title: "Power issue",
    description: "Partial outage.",
    locationText: "Cape Coral",
    unitNumber: "",
    accessNotes: "Call first.",
    status: "draft",
    requestedAt: null,
    assignedAt: null,
    resolvedAt: null,
    cancelledAt: null,
    expiredAt: null,
    createdAt: "created",
    updatedAt: "updated",
    safetyAssessment: null,
    ...overrides,
  };
}

function createService(overrides = {}) {
  const defaultResult = {
    ok: true,
    status: 200,
    code: "EMERGENCY_REQUEST_FOUND",
    emergencyRequest: successfulEmergencyRequest(),
  };

  return {
    async cancelEmergencyRequest() {
      return {
        ...defaultResult,
        code: "EMERGENCY_REQUEST_CANCELLED",
        emergencyRequest: successfulEmergencyRequest({
          status: "cancelled",
          cancelledAt: "cancelled",
        }),
      };
    },

    async createEmergencyDraft() {
      return {
        ...defaultResult,
        status: 201,
        code: "EMERGENCY_DRAFT_CREATED",
      };
    },

    async getOwnedEmergencyRequest() {
      return defaultResult;
    },

    async prepareEmergencyRequest() {
      return {
        ...defaultResult,
        code: "EMERGENCY_REQUEST_PREPARED",
        emergencyRequest: successfulEmergencyRequest({
          status: "ready_for_distribution",
          requestedAt: "requested",
        }),
      };
    },

    async saveEmergencySafetyAssessment() {
      return {
        ...defaultResult,
        code:
          "EMERGENCY_SAFETY_ASSESSMENT_SAVED",
        emergencyRequest: successfulEmergencyRequest({
          safetyAssessment: {
            disposition: "continue",
          },
        }),
      };
    },

    async updateEmergencyDraft() {
      return {
        ...defaultResult,
        code: "EMERGENCY_DRAFT_UPDATED",
      };
    },

    ...overrides,
  };
}

function createHandlers(service) {
  const pool = { marker: "pool" };

  return {
    pool,
    handlers: createEmergencyRequestHandlers({
      getPool(req) {
        assert.equal(req.pool, pool);
        return req.pool;
      },
      sendPublicDatabaseError(args) {
        return args.res.status(args.status || 500).json({
          error: args.code,
          message: args.message,
        });
      },
      service,
    }),
  };
}

test(
  "all Emergency routes are registered with authentication",
  () => {
    const calls = [];
    const authMiddleware = () => {};
    const service = createService();

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
      getPool() {
        return {};
      },
      sendPublicDatabaseError() {},
      service,
    });

    assert.deepEqual(
      calls.map(({ method, path }) => ({
        method,
        path,
      })),
      [
        {
          method: "POST",
          path: "/emergency-requests/drafts",
        },
        {
          method: "GET",
          path:
            "/emergency-requests/:emergencyRequestId",
        },
        {
          method: "PATCH",
          path:
            "/emergency-requests/:emergencyRequestId",
        },
        {
          method: "POST",
          path:
            "/emergency-requests/:emergencyRequestId/safety-assessment",
        },
        {
          method: "POST",
          path:
            "/emergency-requests/:emergencyRequestId/prepare",
        },
        {
          method: "POST",
          path:
            "/emergency-requests/:emergencyRequestId/cancel",
        },
      ]
    );

    for (const route of calls) {
      assert.equal(route.handlers.length, 2);
      assert.equal(
        route.handlers[0],
        authMiddleware
      );
      assert.equal(
        typeof route.handlers[1],
        "function"
      );
    }
  }
);

test(
  "unauthenticated requests cannot reach an Emergency handler",
  async () => {
    let handlerCalled = false;
    const authMiddleware = (_req, res) =>
      res.status(401).json({
        success: false,
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication required.",
      });

    const app = {
      post(_path, auth, handler) {
        const req = {};
        const res = createResponse();

        auth(req, res, () => {
          handlerCalled = true;
          return handler(req, res);
        });

        assert.equal(res.statusCode, 401);
        assert.equal(
          res.payload.code,
          "AUTHENTICATION_REQUIRED"
        );
      },
      get() {},
      patch() {},
    };

    registerEmergencyRequestRoutes({
      app,
      authMiddleware,
      getPool() {
        throw new Error(
          "Database must not be reached."
        );
      },
      sendPublicDatabaseError() {
        throw new Error(
          "Error normalizer must not be reached."
        );
      },
      service: createService(),
    });

    assert.equal(handlerCalled, false);
  }
);

test(
  "draft creation uses authenticated req.user.id and exact request body",
  async () => {
    let received;
    const service = createService({
      async createEmergencyDraft(args) {
        received = args;
        return {
          ok: true,
          status: 201,
          code: "EMERGENCY_DRAFT_CREATED",
          emergencyRequest:
            successfulEmergencyRequest(),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);

    const body = {
      category: "Home Repair",
      serviceDomain: "Electrical",
      serviceSpecialty: "Emergency Wiring",
      title: "Power issue",
      description: "Partial outage.",
      locationText: "Cape Coral",
      unitNumber: "",
      accessNotes: "Call first.",
    };

    const req = {
      pool,
      user: { id: 7 },
      body,
      params: {},
    };
    const res = createResponse();

    await handlers.createDraft(req, res);

    assert.equal(received.pool, pool);
    assert.equal(received.homeownerUserId, 7);
    assert.equal(received.payload, body);
    assert.equal(res.statusCode, 201);
    assert.equal(
      res.payload.code,
      "EMERGENCY_DRAFT_CREATED"
    );
    assert.equal(
      res.payload.emergencyRequest.homeowner_id,
      undefined
    );
  }
);

test(
  "client-supplied homeowner identity is delegated to strict service validation",
  async () => {
    let received;
    const service = createService({
      async createEmergencyDraft(args) {
        received = args;

        return {
          ok: false,
          status: 400,
          code:
            "UNSUPPORTED_EMERGENCY_FIELDS",
          message:
            "One or more Emergency request fields are not supported.",
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const req = {
      pool,
      user: { id: 7 },
      body: {
        homeownerId: 999,
      },
      params: {},
    };
    const res = createResponse();

    await handlers.createDraft(req, res);

    assert.equal(received.homeownerUserId, 7);
    assert.equal(
      received.payload.homeownerId,
      999
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.payload, {
      success: false,
      code:
        "UNSUPPORTED_EMERGENCY_FIELDS",
      message:
        "One or more Emergency request fields are not supported.",
    });
  }
);

test(
  "owner-scoped retrieval passes both authenticated owner and request ID",
  async () => {
    let received;
    const service = createService({
      async getOwnedEmergencyRequest(args) {
        received = args;

        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_REQUEST_FOUND",
          emergencyRequest:
            successfulEmergencyRequest(),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const res = createResponse();

    await handlers.getRequest(
      {
        pool,
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
      },
      res
    );

    assert.equal(received.homeownerUserId, 7);
    assert.equal(
      received.emergencyRequestId,
      "41"
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.payload.success,
      true
    );
  }
);

test(
  "cross-user and missing requests preserve nondisclosing not-found behavior",
  async () => {
    const service = createService({
      async getOwnedEmergencyRequest() {
        return {
          ok: false,
          status: 404,
          code:
            "EMERGENCY_REQUEST_NOT_FOUND",
          message:
            "The Emergency request was not found.",
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const res = createResponse();

    await handlers.getRequest(
      {
        pool,
        user: { id: 999 },
        params: {
          emergencyRequestId: "41",
        },
      },
      res
    );

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.payload, {
      success: false,
      code:
        "EMERGENCY_REQUEST_NOT_FOUND",
      message:
        "The Emergency request was not found.",
    });
  }
);

test(
  "invalid Emergency request IDs preserve service status and code",
  async () => {
    const service = createService({
      async getOwnedEmergencyRequest() {
        return {
          ok: false,
          status: 400,
          code:
            "INVALID_EMERGENCY_REQUEST_ID",
          message:
            "A valid Emergency request ID is required.",
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const res = createResponse();

    await handlers.getRequest(
      {
        pool,
        user: { id: 7 },
        params: {
          emergencyRequestId: "bad",
        },
      },
      res
    );

    assert.equal(res.statusCode, 400);
    assert.equal(
      res.payload.code,
      "INVALID_EMERGENCY_REQUEST_ID"
    );
  }
);

test(
  "draft update uses owner, request identity, and exact allowlisted payload",
  async () => {
    let received;
    const service = createService({
      async updateEmergencyDraft(args) {
        received = args;

        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_DRAFT_UPDATED",
          emergencyRequest:
            successfulEmergencyRequest({
              title: "Updated",
            }),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const body = {
      title: "Updated",
    };
    const res = createResponse();

    await handlers.updateDraft(
      {
        pool,
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
        body,
      },
      res
    );

    assert.equal(received.homeownerUserId, 7);
    assert.equal(
      received.emergencyRequestId,
      "41"
    );
    assert.equal(received.payload, body);
    assert.equal(
      res.payload.emergencyRequest.title,
      "Updated"
    );
  }
);

test(
  "unknown updates and non-editable prepared requests preserve service failures",
  async () => {
    const failures = [
      {
        status: 400,
        code:
          "UNSUPPORTED_EMERGENCY_FIELDS",
        message:
          "One or more Emergency request fields are not supported.",
      },
      {
        status: 409,
        code:
          "EMERGENCY_REQUEST_NOT_EDITABLE",
        message:
          "Only draft Emergency requests can be edited.",
      },
    ];

    for (const failure of failures) {
      const service = createService({
        async updateEmergencyDraft() {
          return {
            ok: false,
            ...failure,
          };
        },
      });

      const { pool, handlers } =
        createHandlers(service);
      const res = createResponse();

      await handlers.updateDraft(
        {
          pool,
          user: { id: 7 },
          params: {
            emergencyRequestId: "41",
          },
          body: {
            unsupported: true,
          },
        },
        res
      );

      assert.equal(
        res.statusCode,
        failure.status
      );
      assert.equal(
        res.payload.code,
        failure.code
      );
    }
  }
);

test(
  "safety assessment receives authenticated ownership and exact answers",
  async () => {
    let received;
    const body = {
      immediateDanger: false,
      medicalEmergency: false,
      fireOrSmoke: false,
      gasOdorOrSuspectedLeak: false,
      activeCrimeOrThreat: false,
      electricalImmediateHazard: false,
      structuralCollapseRisk: false,
      floodingOrWaterDamage: false,
      occupantsUnableToExit: false,
      emergencyServicesContacted: false,
      safeToRemainAtLocation: true,
      additionalSafetyContext: "",
    };

    const service = createService({
      async saveEmergencySafetyAssessment(
        args
      ) {
        received = args;

        return {
          ok: true,
          status: 200,
          code:
            "EMERGENCY_SAFETY_ASSESSMENT_SAVED",
          emergencyRequest:
            successfulEmergencyRequest({
              safetyAssessment: {
                ...body,
                disposition: "continue",
              },
            }),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const res = createResponse();

    await handlers.saveSafetyAssessment(
      {
        pool,
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
        body,
      },
      res
    );

    assert.equal(received.homeownerUserId, 7);
    assert.equal(received.payload, body);
    assert.equal(
      res.payload.emergencyRequest
        .safetyAssessment.disposition,
      "continue"
    );
  }
);

test(
  "incomplete answers and client disposition preserve validation failures",
  async () => {
    const failures = [
      {
        code:
          "INCOMPLETE_SAFETY_ASSESSMENT",
        message:
          "Every required safety question must be answered.",
      },
      {
        code:
          "UNSUPPORTED_SAFETY_FIELDS",
        message:
          "One or more safety assessment fields are not supported.",
      },
    ];

    for (const failure of failures) {
      const service = createService({
        async saveEmergencySafetyAssessment() {
          return {
            ok: false,
            status: 400,
            ...failure,
          };
        },
      });

      const { pool, handlers } =
        createHandlers(service);
      const res = createResponse();

      await handlers.saveSafetyAssessment(
        {
          pool,
          user: { id: 7 },
          params: {
            emergencyRequestId: "41",
          },
          body: {},
        },
        res
      );

      assert.equal(res.statusCode, 400);
      assert.equal(
        res.payload.code,
        failure.code
      );
    }
  }
);

test(
  "unsafe assessment returns the server-derived safety-blocked state",
  async () => {
    const service = createService({
      async saveEmergencySafetyAssessment() {
        return {
          ok: true,
          status: 200,
          code:
            "EMERGENCY_REQUEST_SAFETY_BLOCKED",
          emergencyRequest:
            successfulEmergencyRequest({
              status: "safety_blocked",
              safetyAssessment: {
                immediateDanger: true,
                disposition: "leave_location",
              },
            }),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const res = createResponse();

    await handlers.saveSafetyAssessment(
      {
        pool,
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
        body: {},
      },
      res
    );

    assert.equal(
      res.payload.code,
      "EMERGENCY_REQUEST_SAFETY_BLOCKED"
    );
    assert.equal(
      res.payload.emergencyRequest.status,
      "safety_blocked"
    );
    assert.equal(
      res.payload.emergencyRequest
        .safetyAssessment.disposition,
      "leave_location"
    );
  }
);

test(
  "blocked and incomplete requests cannot be prepared",
  async () => {
    for (const code of [
      "EMERGENCY_REQUEST_SAFETY_BLOCKED",
      "EMERGENCY_REQUEST_INCOMPLETE",
    ]) {
      const service = createService({
        async prepareEmergencyRequest() {
          return {
            ok: false,
            status: 409,
            code,
            message:
              "The Emergency request cannot be prepared.",
          };
        },
      });

      const { pool, handlers } =
        createHandlers(service);
      const res = createResponse();

      await handlers.prepareRequest(
        {
          pool,
          user: { id: 7 },
          params: {
            emergencyRequestId: "41",
          },
        },
        res
      );

      assert.equal(res.statusCode, 409);
      assert.equal(res.payload.code, code);
    }
  }
);

test(
  "complete safe request becomes ready_for_distribution only",
  async () => {
    let received;
    const service = createService({
      async prepareEmergencyRequest(args) {
        received = args;

        return {
          ok: true,
          status: 200,
          code:
            "EMERGENCY_REQUEST_PREPARED",
          emergencyRequest:
            successfulEmergencyRequest({
              status:
                "ready_for_distribution",
              requestedAt: "requested",
            }),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);
    const res = createResponse();

    await handlers.prepareRequest(
      {
        pool,
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
      },
      res
    );

    assert.equal(received.homeownerUserId, 7);
    assert.equal(
      res.payload.emergencyRequest.status,
      "ready_for_distribution"
    );
    assert.notEqual(
      res.payload.emergencyRequest.status,
      "active"
    );
  }
);

test(
  "cancellation is owner scoped and repeated cancellation remains idempotent",
  async () => {
    const results = [
      {
        code:
          "EMERGENCY_REQUEST_CANCELLED",
        cancelledAt: "cancelled",
      },
      {
        code:
          "EMERGENCY_REQUEST_ALREADY_CANCELLED",
        cancelledAt: "cancelled",
      },
    ];
    const received = [];

    const service = createService({
      async cancelEmergencyRequest(args) {
        received.push(args);

        const current = results.shift();

        return {
          ok: true,
          status: 200,
          code: current.code,
          emergencyRequest:
            successfulEmergencyRequest({
              status: "cancelled",
              cancelledAt:
                current.cancelledAt,
            }),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);

    for (const expectedCode of [
      "EMERGENCY_REQUEST_CANCELLED",
      "EMERGENCY_REQUEST_ALREADY_CANCELLED",
    ]) {
      const res = createResponse();

      await handlers.cancelRequest(
        {
          pool,
          user: { id: 7 },
          params: {
            emergencyRequestId: "41",
          },
        },
        res
      );

      assert.equal(
        res.payload.code,
        expectedCode
      );
      assert.equal(
        res.payload.emergencyRequest.status,
        "cancelled"
      );
    }

    assert.equal(received.length, 2);

    for (const args of received) {
      assert.equal(
        args.homeownerUserId,
        7
      );
      assert.equal(
        args.emergencyRequestId,
        "41"
      );
    }
  }
);

test(
  "database failures use the safe public database-error contract",
  async () => {
    const privateError = new Error(
      "postgres://private-host/private-db"
    );
    privateError.code = "08006";

    const service = createService({
      async createEmergencyDraft() {
        throw privateError;
      },
    });

    let normalized;
    const pool = {};

    const handlers =
      createEmergencyRequestHandlers({
        getPool() {
          return pool;
        },
        sendPublicDatabaseError(args) {
          normalized = args;

          return args.res
            .status(503)
            .json({
              error:
                "DATABASE_UNAVAILABLE",
              message:
                "The service is temporarily unavailable.",
            });
        },
        service,
      });

    const res = createResponse();

    await handlers.createDraft(
      {
        user: { id: 7 },
        body: {},
      },
      res
    );

    assert.equal(
      normalized.operation,
      "create_emergency_draft"
    );
    assert.equal(normalized.error, privateError);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.payload, {
      error: "DATABASE_UNAVAILABLE",
      message:
        "The service is temporarily unavailable.",
    });

    const serialized = JSON.stringify(
      res.payload
    );

    assert.doesNotMatch(
      serialized,
      /private-host|private-db|postgres/i
    );
  }
);

test(
  "successful responses expose no raw owner or persistence authority",
  () => {
    const res = createResponse();

    sendServiceResult(res, {
      ok: true,
      status: 200,
      code: "EMERGENCY_REQUEST_FOUND",
      row: {
        homeowner_id: 7,
        private_column: "private",
      },
      assessment: {
        emergency_request_id: 41,
      },
      emergencyRequest:
        successfulEmergencyRequest(),
    });

    assert.equal(res.payload.row, undefined);
    assert.equal(
      res.payload.assessment,
      undefined
    );
    assert.equal(
      res.payload.emergencyRequest
        .homeowner_id,
      undefined
    );
    assert.equal(
      res.payload.emergencyRequest
        .private_column,
      undefined
    );
  }
);

test(
  "route layer invokes only the Emergency aggregate service",
  async () => {
    const invoked = [];

    const service = createService({
      async createEmergencyDraft() {
        invoked.push("createEmergencyDraft");

        return {
          ok: true,
          status: 201,
          code: "EMERGENCY_DRAFT_CREATED",
          emergencyRequest:
            successfulEmergencyRequest(),
        };
      },

      async getOwnedEmergencyRequest() {
        invoked.push(
          "getOwnedEmergencyRequest"
        );

        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_REQUEST_FOUND",
          emergencyRequest:
            successfulEmergencyRequest(),
        };
      },

      async updateEmergencyDraft() {
        invoked.push(
          "updateEmergencyDraft"
        );

        return {
          ok: true,
          status: 200,
          code: "EMERGENCY_DRAFT_UPDATED",
          emergencyRequest:
            successfulEmergencyRequest(),
        };
      },

      async saveEmergencySafetyAssessment() {
        invoked.push(
          "saveEmergencySafetyAssessment"
        );

        return {
          ok: true,
          status: 200,
          code:
            "EMERGENCY_SAFETY_ASSESSMENT_SAVED",
          emergencyRequest:
            successfulEmergencyRequest(),
        };
      },

      async prepareEmergencyRequest() {
        invoked.push(
          "prepareEmergencyRequest"
        );

        return {
          ok: true,
          status: 200,
          code:
            "EMERGENCY_REQUEST_PREPARED",
          emergencyRequest:
            successfulEmergencyRequest({
              status:
                "ready_for_distribution",
            }),
        };
      },

      async cancelEmergencyRequest() {
        invoked.push(
          "cancelEmergencyRequest"
        );

        return {
          ok: true,
          status: 200,
          code:
            "EMERGENCY_REQUEST_CANCELLED",
          emergencyRequest:
            successfulEmergencyRequest({
              status: "cancelled",
            }),
        };
      },
    });

    const { pool, handlers } =
      createHandlers(service);

    const base = {
      pool,
      user: { id: 7 },
      params: {
        emergencyRequestId: "41",
      },
      body: {},
    };

    await handlers.createDraft(
      base,
      createResponse()
    );
    await handlers.getRequest(
      base,
      createResponse()
    );
    await handlers.updateDraft(
      base,
      createResponse()
    );
    await handlers.saveSafetyAssessment(
      base,
      createResponse()
    );
    await handlers.prepareRequest(
      base,
      createResponse()
    );
    await handlers.cancelRequest(
      base,
      createResponse()
    );

    assert.deepEqual(invoked, [
      "createEmergencyDraft",
      "getOwnedEmergencyRequest",
      "updateEmergencyDraft",
      "saveEmergencySafetyAssessment",
      "prepareEmergencyRequest",
      "cancelEmergencyRequest",
    ]);

    assert.equal(
      invoked.some((name) =>
        /relationship|conversation|message|notification|distribution/i.test(
          name
        )
      ),
      false
    );
  }
);
