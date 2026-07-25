"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  registerEmergencyRequestRoutes,
} = require("../server/emergency/emergencyRequests");

const ROUTES = [
  {
    name: "en-route",
    path:
      "/emergency-requests/:emergencyRequestId/en-route",
    command: "markEmergencyEnRoute",
    successCode: "EMERGENCY_EN_ROUTE",
    repeatCode: "EMERGENCY_ALREADY_EN_ROUTE",
    operation: "mark_emergency_en_route",
    status: "professional_en_route",
  },
  {
    name: "arrived",
    path:
      "/emergency-requests/:emergencyRequestId/arrived",
    command: "markEmergencyArrived",
    successCode: "EMERGENCY_ARRIVED",
    repeatCode: "EMERGENCY_ALREADY_ARRIVED",
    operation: "mark_emergency_arrived",
    status: "professional_arrived",
  },
  {
    name: "start",
    path:
      "/emergency-requests/:emergencyRequestId/start",
    command: "startEmergencyWork",
    successCode: "EMERGENCY_WORK_STARTED",
    repeatCode:
      "EMERGENCY_WORK_ALREADY_STARTED",
    operation: "start_emergency_work",
    status: "work_in_progress",
  },
  {
    name: "complete",
    path:
      "/emergency-requests/:emergencyRequestId/complete",
    command: "completeEmergencyWork",
    successCode: "EMERGENCY_COMPLETED",
    repeatCode: "EMERGENCY_ALREADY_COMPLETED",
    operation: "complete_emergency_work",
    status: "completed",
  },
];

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

function opportunityServiceStub() {
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

function relationshipServiceStub() {
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

function selectionServiceStub() {
  return {
    async selectHomeownerEmergencyResponse() {},
  };
}

function canonicalResult({
  code = "EMERGENCY_EN_ROUTE",
  alreadyApplied = false,
  status = "professional_en_route",
  httpStatus,
  overrides = {},
} = {}) {
  return {
    success: true,
    ...(httpStatus
      ? { status: httpStatus }
      : {}),
    code,
    alreadyApplied,
    emergencyRequest: {
      id: 41,
      status,
      assignedAt: "assigned",
      enRouteAt: "en-route",
      arrivedAt: null,
      workStartedAt: null,
      completedAt: null,
      updatedAt: "updated",
    },
    relationship: {
      id: 73,
      status: "active",
    },
    conversation: {
      id: 97,
      status: "active",
    },
    ...overrides,
  };
}

function createDispatchService(overrides = {}) {
  return {
    async completeEmergencyWork() {
      return canonicalResult({
        code: "EMERGENCY_COMPLETED",
        status: "completed",
      });
    },
    async markEmergencyArrived() {
      return canonicalResult({
        code: "EMERGENCY_ARRIVED",
        status: "professional_arrived",
      });
    },
    async markEmergencyEnRoute() {
      return canonicalResult();
    },
    async startEmergencyWork() {
      return canonicalResult({
        code: "EMERGENCY_WORK_STARTED",
        status: "work_in_progress",
      });
    },
    ...overrides,
  };
}

function register({
  authMiddleware =
    (_req, _res, next) => next(),
  dispatchService = createDispatchService(),
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
    service: requestServiceStub(),
    opportunityService:
      opportunityServiceStub(),
    relationshipService:
      relationshipServiceStub(),
    selectionService:
      selectionServiceStub(),
    dispatchService,
  });

  return {
    authMiddleware,
    routes,
  };
}

function findRoute(routes, path) {
  return routes.find(
    (route) =>
      route.method === "POST" &&
      route.path === path
  );
}

function hostileRequest(pool = {}) {
  return {
    pool,
    user: {
      id: 52,
    },
    params: {
      emergencyRequestId: "41",
      relationshipId: "999",
    },
    body: {
      professionalUserId: 999,
      professional_user_id: 999,
      contractorId: 999,
      contractor_id: 999,
      relationshipId: 999,
      relationship_id: 999,
      conversationId: 999,
      conversation_id: 999,
      status: "completed",
      targetStatus: "completed",
      enRouteAt: "forged",
      completedAt: "forged",
    },
    query: {
      professionalUserId: 888,
      contractorId: 888,
      relationshipId: 888,
      conversationId: 888,
      targetStatus: "resolved",
    },
  };
}

test("all four dispatch routes are registered exactly once with authentication first", () => {
  const {
    authMiddleware,
    routes,
  } = register();
  const dispatchRoutes = routes.filter((route) =>
    ROUTES.some(
      ({ path }) => path === route.path
    )
  );

  assert.equal(dispatchRoutes.length, 4);

  for (const expected of ROUTES) {
    const matching = routes.filter(
      (route) =>
        route.method === "POST" &&
        route.path === expected.path
    );

    assert.equal(matching.length, 1);
    assert.equal(
      matching[0].handlers.length,
      2
    );
    assert.equal(
      matching[0].handlers[0],
      authMiddleware
    );
    assert.equal(
      typeof matching[0].handlers[1],
      "function"
    );
  }

  const registeredPaths = routes.map(
    ({ method, path }) => `${method} ${path}`
  );

  for (const alias of [
    "PATCH /emergency-requests/:emergencyRequestId/en-route",
    "PUT /emergency-requests/:emergencyRequestId/arrived",
    "POST /professional-emergency-opportunities/:emergencyRequestId/start",
    "POST /emergency-requests/:emergencyRequestId/dispatch",
  ]) {
    assert.equal(
      registeredPaths.includes(alias),
      false
    );
  }
});

test("authentication failure blocks every dispatch handler, pool lookup, and service command", () => {
  let poolAccessed = false;
  let serviceCalled = false;
  const authMiddleware = (_req, res) =>
    res.status(401).json({
      success: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication required.",
    });
  const command = async () => {
    serviceCalled = true;
    return canonicalResult();
  };
  const { routes } = register({
    authMiddleware,
    getPool() {
      poolAccessed = true;
      throw new Error(
        "Pool must not be accessed."
      );
    },
    dispatchService:
      createDispatchService({
        completeEmergencyWork: command,
        markEmergencyArrived: command,
        markEmergencyEnRoute: command,
        startEmergencyWork: command,
      }),
  });

  for (const { path } of ROUTES) {
    const route = findRoute(routes, path);
    const res = createResponse();
    let handlerCalled = false;

    route.handlers[0]({}, res, () => {
      handlerCalled = true;
      return route.handlers[1]({}, res);
    });

    assert.equal(res.statusCode, 401);
    assert.equal(
      res.payload.code,
      "AUTHENTICATION_REQUIRED"
    );
    assert.equal(handlerCalled, false);
  }

  assert.equal(poolAccessed, false);
  assert.equal(serviceCalled, false);
});

test("every endpoint invokes only its fixed command with authenticated identity and path ID", async (t) => {
  for (const expected of ROUTES) {
    await t.test(expected.name, async () => {
      const calls = Object.fromEntries(
        ROUTES.map(({ command }) => [
          command,
          [],
        ])
      );
      const dispatchService =
        createDispatchService(
          Object.fromEntries(
            ROUTES.map((item) => [
              item.command,
              async (args) => {
                calls[item.command].push(args);
                return canonicalResult({
                  code: item.successCode,
                  status: item.status,
                });
              },
            ])
          )
        );
      const { routes } = register({
        dispatchService,
      });
      const pool = {
        marker: "canonical-pool",
      };
      const req = hostileRequest(pool);
      const res = createResponse();

      await findRoute(
        routes,
        expected.path
      ).handlers[1](req, res);

      assert.deepEqual(
        calls[expected.command],
        [
          {
            pool,
            authenticatedUserId: 52,
            emergencyRequestId: "41",
          },
        ]
      );

      for (const { command } of ROUTES) {
        assert.equal(
          calls[command].length,
          command === expected.command ? 1 : 0
        );
      }

      assert.deepEqual(
        Object.keys(
          calls[expected.command][0]
        ).sort(),
        [
          "authenticatedUserId",
          "emergencyRequestId",
          "pool",
        ]
      );
      assert.equal(res.statusCode, 200);
    });
  }
});

test("successful transitions preserve service status and canonical objects exactly", async (t) => {
  for (const expected of ROUTES) {
    await t.test(expected.name, async () => {
      const serviceResult = canonicalResult({
        code: expected.successCode,
        status: expected.status,
        httpStatus: 202,
        overrides: {
          privateTopLevel: "omit",
        },
      });
      const dispatchService =
        createDispatchService({
          [expected.command]: async () =>
            serviceResult,
        });
      const { routes } = register({
        dispatchService,
      });
      const res = createResponse();

      await findRoute(
        routes,
        expected.path
      ).handlers[1](
        hostileRequest(),
        res
      );

      assert.equal(res.statusCode, 202);
      assert.deepEqual(res.payload, {
        success: true,
        code: expected.successCode,
        alreadyApplied: false,
        emergencyRequest:
          serviceResult.emergencyRequest,
        relationship:
          serviceResult.relationship,
        conversation:
          serviceResult.conversation,
      });
      assert.equal(
        res.payload.emergencyRequest,
        serviceResult.emergencyRequest
      );
      assert.equal(
        res.payload.relationship,
        serviceResult.relationship
      );
      assert.equal(
        res.payload.conversation,
        serviceResult.conversation
      );
      assert.equal(
        res.payload.privateTopLevel,
        undefined
      );
    });
  }
});

test("exact retry responses remain successful and preserve command-specific codes", async (t) => {
  for (const expected of ROUTES) {
    await t.test(expected.name, async () => {
      const dispatchService =
        createDispatchService({
          [expected.command]: async () =>
            canonicalResult({
              code: expected.repeatCode,
              alreadyApplied: true,
              status: expected.status,
            }),
        });
      const { routes } = register({
        dispatchService,
      });
      const res = createResponse();

      await findRoute(
        routes,
        expected.path
      ).handlers[1](
        hostileRequest(),
        res
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.success, true);
      assert.equal(
        res.payload.code,
        expected.repeatCode
      );
      assert.equal(
        res.payload.alreadyApplied,
        true
      );
    });
  }
});

test("service failures preserve exact status, code, and message without success objects", async () => {
  const failures = [
    [400, "INVALID_EMERGENCY_REQUEST_ID"],
    [403, "PROFESSIONAL_PROFILE_REQUIRED"],
    [404, "EMERGENCY_REQUEST_NOT_FOUND"],
    [409, "EMERGENCY_NOT_ASSIGNED"],
    [409, "EMERGENCY_CONVERSATION_REQUIRED"],
    [409, "EMERGENCY_INVALID_TRANSITION"],
    [500, "EMERGENCY_DISPATCH_FAILED"],
  ];

  for (const [status, code] of failures) {
    const message = `Public ${code} message.`;
    const { routes } = register({
      dispatchService:
        createDispatchService({
          async markEmergencyEnRoute() {
            return {
              success: false,
              status,
              code,
              message,
              emergencyRequest: {
                private: true,
              },
            };
          },
        }),
    });
    const res = createResponse();

    await findRoute(
      routes,
      ROUTES[0].path
    ).handlers[1](
      hostileRequest(),
      res
    );

    assert.equal(res.statusCode, status);
    assert.deepEqual(res.payload, {
      success: false,
      code,
      message,
    });
    assert.equal(
      res.payload.emergencyRequest,
      undefined
    );
    assert.equal(
      res.payload.relationship,
      undefined
    );
    assert.equal(
      res.payload.conversation,
      undefined
    );
  }
});

test("missing service results use only the dispatch fallback contract", async () => {
  const { routes } = register({
    dispatchService:
      createDispatchService({
        async markEmergencyEnRoute() {
          return null;
        },
      }),
  });
  const res = createResponse();

  await findRoute(
    routes,
    ROUTES[0].path
  ).handlers[1](
    hostileRequest(),
    res
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, {
    success: false,
    code: "EMERGENCY_DISPATCH_FAILED",
    message:
      "The Emergency dispatch transition could not be completed.",
  });
});

test("unexpected command failures use stable transition-specific safe normalization", async (t) => {
  for (const expected of ROUTES) {
    await t.test(expected.name, async () => {
      const privateError = new Error(
        "postgres://private-host/private-db"
      );
      let normalized;
      const { routes } = register({
        dispatchService:
          createDispatchService({
            [expected.command]: async () => {
              throw privateError;
            },
          }),
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

      await findRoute(
        routes,
        expected.path
      ).handlers[1](
        hostileRequest(),
        res
      );

      assert.equal(
        normalized.operation,
        expected.operation
      );
      assert.equal(
        normalized.code,
        "EMERGENCY_DISPATCH_FAILED"
      );
      assert.equal(
        normalized.message,
        "The Emergency dispatch transition could not be completed."
      );
      assert.equal(
        normalized.error,
        privateError
      );
      assert.deepEqual(res.payload, {
        success: false,
        code: "EMERGENCY_DISPATCH_FAILED",
        message:
          "The Emergency dispatch transition could not be completed.",
      });
      assert.doesNotMatch(
        JSON.stringify(res.payload),
        /private-host|private-db|postgres/i
      );
    });
  }
});

test("dispatch responses add no private authority or persistence fields", async () => {
  const { routes } = register();
  const res = createResponse();

  await findRoute(
    routes,
    ROUTES[0].path
  ).handlers[1](
    hostileRequest(),
    res
  );

  const serialized = JSON.stringify(
    res.payload
  );

  for (const privateField of [
    "homeownerId",
    "homeowner_id",
    "contractorId",
    "contractor_id",
    "professionalUserId",
    "professional_user_id",
    "address",
    "accessInstructions",
    "access_instructions",
    "safety",
    "responses",
    "database",
    "transaction",
  ]) {
    assert.equal(
      serialized.includes(privateField),
      false
    );
  }
});

test("dispatch route transport block contains no database or lifecycle authority", () => {
  const source = readFileSync(
    require.resolve(
      "../server/emergency/emergencyRequests"
    ),
    "utf8"
  );
  const start = source.indexOf(
    "async function runDispatchCommand"
  );
  const end = source.indexOf(
    "async function updateDraft",
    start
  );
  const dispatchBlock = source.slice(
    start,
    end
  );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(
    dispatchBlock,
    /authenticatedUserId:\s*req\.user\.id/
  );
  assert.match(
    dispatchBlock,
    /emergencyRequestId:\s*req\.params\.emergencyRequestId/
  );
  assert.doesNotMatch(
    dispatchBlock,
    /req\.(?:body|query)/
  );
  assert.doesNotMatch(
    dispatchBlock,
    /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b|FOR UPDATE|ensureConversation/i
  );
  assert.doesNotMatch(
    dispatchBlock,
    /targetStatus|sourceStatus|timestamp/
  );
  assert.doesNotMatch(
    dispatchBlock,
    /relationship(?:Id|_id)|conversation(?:Id|_id)|contractor(?:Id|_id)|professional_user_id/
  );
});
