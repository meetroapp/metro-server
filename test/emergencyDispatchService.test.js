"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const dispatchService = require(
  "../server/emergency/emergencyDispatchService"
);

const {
  completeEmergencyWork,
  markEmergencyArrived,
  markEmergencyEnRoute,
  startEmergencyWork,
} = dispatchService;

const AUTHENTICATED_USER_ID = 52;
const EMERGENCY_REQUEST_ID = 41;

const TRANSITION_CASES = [
  {
    name: "en-route",
    command: markEmergencyEnRoute,
    sourceStatus: "assigned",
    targetStatus: "professional_en_route",
    timestampColumn: "en_route_at",
    timestampField: "enRouteAt",
    successCode: "EMERGENCY_EN_ROUTE",
    repeatCode: "EMERGENCY_ALREADY_EN_ROUTE",
  },
  {
    name: "arrived",
    command: markEmergencyArrived,
    sourceStatus: "professional_en_route",
    targetStatus: "professional_arrived",
    timestampColumn: "arrived_at",
    timestampField: "arrivedAt",
    successCode: "EMERGENCY_ARRIVED",
    repeatCode: "EMERGENCY_ALREADY_ARRIVED",
  },
  {
    name: "start",
    command: startEmergencyWork,
    sourceStatus: "professional_arrived",
    targetStatus: "work_in_progress",
    timestampColumn: "work_started_at",
    timestampField: "workStartedAt",
    successCode: "EMERGENCY_WORK_STARTED",
    repeatCode: "EMERGENCY_WORK_ALREADY_STARTED",
  },
  {
    name: "complete",
    command: completeEmergencyWork,
    sourceStatus: "work_in_progress",
    targetStatus: "completed",
    timestampColumn: "completed_at",
    timestampField: "completedAt",
    successCode: "EMERGENCY_COMPLETED",
    repeatCode: "EMERGENCY_ALREADY_COMPLETED",
  },
];

const TIMESTAMP_BY_TARGET = Object.fromEntries(
  TRANSITION_CASES.map((item) => [
    item.targetStatus,
    item.timestampColumn,
  ])
);

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function classifySql(sql) {
  if (sql === "BEGIN") return "begin";
  if (sql === "COMMIT") return "commit";
  if (sql === "ROLLBACK") return "rollback";
  if (
    /^SELECT EXISTS \( SELECT 1 FROM contractor_profiles/i.test(
      sql
    )
  ) {
    return "profile";
  }
  if (
    /^SELECT .* FROM emergency_requests WHERE id = \$1 LIMIT 1 FOR UPDATE$/i.test(
      sql
    )
  ) {
    return "request";
  }
  if (/FROM request_relationships AS rr/i.test(sql)) {
    return "relationship";
  }
  if (/FROM conversations AS c/i.test(sql)) {
    return "conversation";
  }
  if (/^UPDATE emergency_requests SET/i.test(sql)) {
    return "update";
  }
  if (/^UPDATE conversations SET/i.test(sql)) {
    return "activity";
  }
  return "unknown";
}

function lifecycleTimestamps(status) {
  const values = {
    en_route_at: null,
    arrived_at: null,
    work_started_at: null,
    completed_at: null,
  };

  if (
    [
      "professional_en_route",
      "professional_arrived",
      "work_in_progress",
      "completed",
    ].includes(status)
  ) {
    values.en_route_at = "en-route-original";
  }

  if (
    [
      "professional_arrived",
      "work_in_progress",
      "completed",
    ].includes(status)
  ) {
    values.arrived_at = "arrived-original";
  }

  if (
    ["work_in_progress", "completed"].includes(status)
  ) {
    values.work_started_at = "work-started-original";
  }

  if (status === "completed") {
    values.completed_at = "completed-original";
  }

  return values;
}

function emergencyRow(status = "assigned", overrides = {}) {
  return {
    id: EMERGENCY_REQUEST_ID,
    status,
    assigned_at: "assigned-original",
    ...lifecycleTimestamps(status),
    updated_at: "updated-original",
    homeowner_id: 7,
    resolved_at: "private-resolved-value",
    location_text: "private-address",
    access_notes: "private-access",
    ...overrides,
  };
}

function relationshipRow(overrides = {}) {
  return {
    id: 73,
    emergency_request_id: EMERGENCY_REQUEST_ID,
    homeowner_id: 7,
    contractor_id: 83,
    professional_user_id: AUTHENTICATED_USER_ID,
    status: "active",
    introduction_text: "private-introduction",
    ...overrides,
  };
}

function conversationRow(overrides = {}) {
  return {
    id: 97,
    relationship_id: 73,
    homeowner_id: 7,
    contractor_id: 83,
    professional_user_id: AUTHENTICATED_USER_ID,
    status: "active",
    updated_at: "conversation-updated-original",
    created_at: "private-created",
    ...overrides,
  };
}

function createDispatchPool({
  request = emergencyRow(),
  relationship = relationshipRow(),
  conversation = conversationRow(),
  profileExists = true,
  updateReturnsRow = true,
  activityReturnsRow = true,
  failAt = null,
  invalidClient = false,
} = {}) {
  const calls = [];
  let connectCount = 0;
  let releaseCount = 0;

  const client = invalidClient
    ? {
        release() {
          releaseCount += 1;
        },
      }
    : {
        async query(text, params = []) {
          const sql = normalizeSql(text);
          const kind = classifySql(sql);
          calls.push({ kind, sql, params });

          if (failAt === kind) {
            throw new Error(`private ${kind} failure`);
          }

          if (
            kind === "begin" ||
            kind === "commit" ||
            kind === "rollback"
          ) {
            return { rows: [] };
          }

          if (kind === "profile") {
            return {
              rows: [
                {
                  has_owned_profile:
                    profileExists,
                },
              ],
            };
          }

          if (kind === "request") {
            return {
              rows: request ? [{ ...request }] : [],
            };
          }

          if (kind === "relationship") {
            return {
              rows: relationship
                ? [{ ...relationship }]
                : [],
            };
          }

          if (kind === "conversation") {
            return {
              rows: conversation
                ? [{ ...conversation }]
                : [],
            };
          }

          if (kind === "update") {
            if (!updateReturnsRow) {
              return { rows: [] };
            }

            const [
              requestId,
              targetStatus,
            ] = params;
            const timestampColumn =
              TIMESTAMP_BY_TARGET[targetStatus];

            return {
              rows: [
                {
                  ...request,
                  id: requestId,
                  status: targetStatus,
                  [timestampColumn]:
                    request[timestampColumn] ||
                    `${timestampColumn}-new`,
                  updated_at: "updated-after-transition",
                },
              ],
            };
          }

          if (kind === "activity") {
            return {
              rows: activityReturnsRow
                ? [{
                    id: conversation.id,
                    status: conversation.status,
                    updated_at:
                      "conversation-updated-after-transition",
                  }]
                : [],
            };
          }

          throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() {
          releaseCount += 1;
        },
      };

  return {
    calls,
    get connectCount() {
      return connectCount;
    },
    get releaseCount() {
      return releaseCount;
    },
    async connect() {
      connectCount += 1;

      if (failAt === "connect") {
        throw new Error("private connect failure");
      }

      return client;
    },
  };
}

function commandInput(pool, overrides = {}) {
  return {
    pool,
    authenticatedUserId: AUTHENTICATED_USER_ID,
    emergencyRequestId: EMERGENCY_REQUEST_ID,
    ...overrides,
  };
}

function callsOf(pool, kind) {
  return pool.calls.filter((call) => call.kind === kind);
}

function firstCall(pool, kind) {
  return callsOf(pool, kind)[0];
}

function assertFailure(
  result,
  status,
  code
) {
  assert.deepEqual(
    Object.keys(result).sort(),
    ["code", "message", "status", "success"]
  );
  assert.equal(result.success, false);
  assert.equal(result.status, status);
  assert.equal(result.code, code);
  assert.equal(typeof result.message, "string");
  assert.equal(result.message.length > 0, true);
}

function assertCanonicalSuccess(result, {
  code,
  alreadyApplied,
  status,
  conversationUpdatedAt = alreadyApplied
    ? "conversation-updated-original"
    : "conversation-updated-after-transition",
}) {
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "alreadyApplied",
      "code",
      "conversation",
      "emergencyRequest",
      "relationship",
      "success",
    ]
  );
  assert.equal(result.success, true);
  assert.equal(result.code, code);
  assert.equal(result.alreadyApplied, alreadyApplied);
  assert.deepEqual(
    Object.keys(result.emergencyRequest).sort(),
    [
      "arrivedAt",
      "assignedAt",
      "completedAt",
      "enRouteAt",
      "id",
      "status",
      "updatedAt",
      "workStartedAt",
    ]
  );
  assert.deepEqual(
    Object.keys(result.relationship).sort(),
    ["id", "status"]
  );
  assert.deepEqual(
    Object.keys(result.conversation).sort(),
    ["id", "status", "updatedAt"]
  );
  assert.equal(result.emergencyRequest.status, status);
  assert.deepEqual(result.relationship, {
    id: 73,
    status: "active",
  });
  assert.deepEqual(result.conversation, {
    id: 97,
    status: "active",
    updatedAt: conversationUpdatedAt,
  });
}

function assertNoCreationOrDestruction(calls) {
  const sql = calls.map((call) => call.sql).join("\n");

  assert.doesNotMatch(
    sql,
    /\bINSERT\s+INTO\s+(?:emergency_requests|request_relationships|conversations|messages)\b/i
  );
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
}

test("dispatch service exports only the four fixed lifecycle commands", () => {
  assert.deepEqual(
    Object.keys(dispatchService).sort(),
    [
      "completeEmergencyWork",
      "markEmergencyArrived",
      "markEmergencyEnRoute",
      "startEmergencyWork",
    ]
  );

  for (const command of Object.values(dispatchService)) {
    assert.equal(typeof command, "function");
  }
});

test("invalid request IDs fail before pool acquisition for every command", async () => {
  for (const { command } of TRANSITION_CASES) {
    for (const emergencyRequestId of [
      0,
      -1,
      "",
      "1.2",
      "1x",
      null,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const pool = createDispatchPool();
      const result = await command(
        commandInput(pool, {
          emergencyRequestId,
        })
      );

      assertFailure(
        result,
        400,
        "INVALID_EMERGENCY_REQUEST_ID"
      );
      assert.equal(pool.connectCount, 0);
      assert.equal(pool.calls.length, 0);
    }
  }
});

test("invalid database dependencies fail before transaction work", async () => {
  for (const { command } of TRANSITION_CASES) {
    await assert.rejects(
      command(
        commandInput({})
      ),
      {
        name: "TypeError",
        message:
          "A database pool with connect() is required.",
      }
    );
  }
});

test("invalid authenticated identity fails before pool acquisition", async () => {
  const pool = createDispatchPool();
  const result = await markEmergencyEnRoute(
    commandInput(pool, {
      authenticatedUserId: "not-a-user",
    })
  );

  assertFailure(
    result,
    403,
    "PROFESSIONAL_PROFILE_REQUIRED"
  );
  assert.equal(pool.connectCount, 0);
});

test("all valid dispatch transitions lock, authorize, update, and serialize canonically", async (t) => {
  for (const transition of TRANSITION_CASES) {
    await t.test(transition.name, async () => {
      const sourceRequest = emergencyRow(
        transition.sourceStatus
      );
      const pool = createDispatchPool({
        request: sourceRequest,
      });
      const result = await transition.command(
        commandInput(pool, {
          contractorProfileId: 9999,
          professionalUserId: 9999,
          relationshipId: 9999,
          conversationId: 9999,
          sourceStatus: "cancelled",
          targetStatus: "resolved",
          timestampColumn: "resolved_at",
        })
      );

      assertCanonicalSuccess(result, {
        code: transition.successCode,
        alreadyApplied: false,
        status: transition.targetStatus,
      });

      assert.deepEqual(
        pool.calls.map((call) => call.kind),
        [
          "begin",
          "profile",
          "request",
          "relationship",
          "conversation",
          "update",
          "activity",
          "commit",
        ]
      );
      assert.equal(pool.connectCount, 1);
      assert.equal(pool.releaseCount, 1);

      const profileCall = firstCall(
        pool,
        "profile"
      );
      assert.match(
        profileCall.sql,
        /FROM contractor_profiles WHERE user_id = \$1/i
      );
      assert.doesNotMatch(
        profileCall.sql,
        /\bORDER BY\b|\bLIMIT 1\b/i
      );
      assert.deepEqual(profileCall.params, [
        AUTHENTICATED_USER_ID,
      ]);

      const requestCall = firstCall(
        pool,
        "request"
      );
      assert.match(
        requestCall.sql,
        /FROM emergency_requests WHERE id = \$1 LIMIT 1 FOR UPDATE$/i
      );
      assert.deepEqual(requestCall.params, [
        EMERGENCY_REQUEST_ID,
      ]);

      const relationshipCall = firstCall(
        pool,
        "relationship"
      );
      assert.match(
        relationshipCall.sql,
        /INNER JOIN contractor_profiles AS cp ON cp\.id = rr\.contractor_id AND cp\.user_id = \$2/i
      );
      assert.match(
        relationshipCall.sql,
        /rr\.emergency_request_id = \$1/i
      );
      assert.match(
        relationshipCall.sql,
        /rr\.post_id IS NULL/i
      );
      assert.match(
        relationshipCall.sql,
        /rr\.status = 'active'/i
      );
      assert.match(
        relationshipCall.sql,
        /rr\.professional_user_id = \$2/i
      );
      assert.match(
        relationshipCall.sql,
        /FOR UPDATE OF rr$/i
      );
      assert.deepEqual(relationshipCall.params, [
        EMERGENCY_REQUEST_ID,
        AUTHENTICATED_USER_ID,
      ]);

      const conversationCall = firstCall(
        pool,
        "conversation"
      );
      assert.match(
        conversationCall.sql,
        /c\.relationship_id = \$1/i
      );
      assert.match(
        conversationCall.sql,
        /c\.homeowner_id = \$2/i
      );
      assert.match(
        conversationCall.sql,
        /c\.contractor_id = \$3/i
      );
      assert.match(
        conversationCall.sql,
        /c\.professional_user_id = \$4/i
      );
      assert.match(
        conversationCall.sql,
        /c\.status = 'active'/i
      );
      assert.match(
        conversationCall.sql,
        /FOR UPDATE OF c$/i
      );
      assert.deepEqual(conversationCall.params, [
        73,
        7,
        83,
        AUTHENTICATED_USER_ID,
      ]);

      const updateCall = firstCall(
        pool,
        "update"
      );
      const setClause = updateCall.sql.match(
        /\bSET\b([\s\S]+?)\bWHERE\b/i
      )[1];
      assert.match(
        setClause,
        new RegExp(
          `${transition.timestampColumn} = COALESCE\\( ${transition.timestampColumn}, CURRENT_TIMESTAMP \\)`,
          "i"
        )
      );
      assert.match(
        setClause,
        /updated_at = CURRENT_TIMESTAMP/i
      );

      for (const other of TRANSITION_CASES) {
        if (
          other.timestampColumn !==
          transition.timestampColumn
        ) {
          assert.doesNotMatch(
            setClause,
            new RegExp(
              `\\b${other.timestampColumn}\\b`,
              "i"
            )
          );
        }
      }

      assert.match(
        updateCall.sql,
        /WHERE id = \$1 AND status = \$3/i
      );
      assert.deepEqual(updateCall.params, [
        EMERGENCY_REQUEST_ID,
        transition.targetStatus,
        transition.sourceStatus,
      ]);
      assert.equal(
        updateCall.sql.includes("9999"),
        false
      );
      assert.doesNotMatch(
        updateCall.sql,
        /\bresolved_at\b/i
      );
      assert.equal(
        result.emergencyRequest[
          transition.timestampField
        ],
        `${transition.timestampColumn}-new`
      );
      assert.equal(
        result.emergencyRequest.updatedAt,
        "updated-after-transition"
      );
      assertNoCreationOrDestruction(pool.calls);
      assert.equal(
        callsOf(pool, "update").length,
        1
      );
      const activityCall = firstCall(
        pool,
        "activity"
      );
      assert.match(
        activityCall.sql,
        /SET updated_at = CURRENT_TIMESTAMP/i
      );
      assert.match(
        activityCall.sql,
        /WHERE id = \$1 AND status = 'active'/i
      );
      assert.deepEqual(activityCall.params, [97]);
      assert.equal(
        callsOf(pool, "activity").length,
        1
      );
    });
  }
});

test("later transitions preserve every earlier lifecycle timestamp", async () => {
  for (const transition of TRANSITION_CASES) {
    const sourceRequest = emergencyRow(
      transition.sourceStatus
    );
    const pool = createDispatchPool({
      request: sourceRequest,
    });
    const result = await transition.command(
      commandInput(pool)
    );

    assert.equal(
      result.emergencyRequest.assignedAt,
      sourceRequest.assigned_at
    );

    const fieldMap = {
      en_route_at: "enRouteAt",
      arrived_at: "arrivedAt",
      work_started_at: "workStartedAt",
      completed_at: "completedAt",
    };

    for (const [
      databaseField,
      publicField,
    ] of Object.entries(fieldMap)) {
      if (
        databaseField ===
        transition.timestampColumn
      ) {
        continue;
      }

      assert.equal(
        result.emergencyRequest[publicField],
        sourceRequest[databaseField]
      );
    }
  }
});

test("exact retries remain write-free after canonical validation", async (t) => {
  for (const transition of TRANSITION_CASES) {
    await t.test(transition.name, async () => {
      const request = emergencyRow(
        transition.targetStatus
      );
      const pool = createDispatchPool({ request });
      const result = await transition.command(
        commandInput(pool)
      );

      assertCanonicalSuccess(result, {
        code: transition.repeatCode,
        alreadyApplied: true,
        status: transition.targetStatus,
      });
      assert.deepEqual(
        pool.calls.map((call) => call.kind),
        [
          "begin",
          "profile",
          "request",
          "relationship",
          "conversation",
          "commit",
        ]
      );
      assert.equal(
        callsOf(pool, "update").length,
        0
      );
      assert.equal(
        callsOf(pool, "activity").length,
        0
      );
      assert.equal(
        result.emergencyRequest.updatedAt,
        request.updated_at
      );
      assert.equal(
        result.emergencyRequest[
          transition.timestampField
        ],
        request[transition.timestampColumn]
      );
      assert.equal(pool.releaseCount, 1);
      assertNoCreationOrDestruction(pool.calls);
    });
  }
});

test("skipped, backward, compatibility, and terminal transitions fail without writes", async () => {
  const cases = [
    [markEmergencyArrived, "assigned"],
    [startEmergencyWork, "assigned"],
    [completeEmergencyWork, "assigned"],
    [startEmergencyWork, "professional_en_route"],
    [completeEmergencyWork, "professional_arrived"],
    [markEmergencyEnRoute, "professional_arrived"],
    [markEmergencyArrived, "work_in_progress"],
    [markEmergencyEnRoute, "completed"],
    [markEmergencyArrived, "completed"],
    [startEmergencyWork, "completed"],
    [markEmergencyEnRoute, "in_service"],
    [markEmergencyArrived, "resolved"],
    [startEmergencyWork, "cancelled"],
    [completeEmergencyWork, "expired"],
    [completeEmergencyWork, "safety_blocked"],
    [markEmergencyEnRoute, "unable_to_match"],
  ];

  for (const [command, status] of cases) {
    const pool = createDispatchPool({
      request: emergencyRow(status),
    });
    const result = await command(
      commandInput(pool)
    );

    assertFailure(
      result,
      409,
      "EMERGENCY_INVALID_TRANSITION"
    );
    assert.equal(
      callsOf(pool, "update").length,
      0
    );
    assert.equal(
      callsOf(pool, "commit").length,
      0
    );
    assert.equal(
      callsOf(pool, "rollback").length,
      1
    );
    assert.equal(pool.releaseCount, 1);
  }
});

test("an exact owned active relationship with a pre-assignment request fails as not assigned", async () => {
  for (const status of [
    "draft",
    "ready_for_distribution",
    "active",
    "selection_pending",
  ]) {
    const pool = createDispatchPool({
      request: emergencyRow(status),
    });
    const result = await markEmergencyEnRoute(
      commandInput(pool)
    );

    assertFailure(
      result,
      409,
      "EMERGENCY_NOT_ASSIGNED"
    );
    assert.deepEqual(
      pool.calls.map((call) => call.kind),
      [
        "begin",
        "profile",
        "request",
        "relationship",
        "conversation",
        "rollback",
      ]
    );
    assert.equal(pool.releaseCount, 1);
  }
});

test("missing professional profile fails before request locking", async () => {
  const pool = createDispatchPool({
    profileExists: false,
  });
  const result = await markEmergencyEnRoute(
    commandInput(pool)
  );

  assertFailure(
    result,
    403,
    "PROFESSIONAL_PROFILE_REQUIRED"
  );
  assert.deepEqual(
    pool.calls.map((call) => call.kind),
    ["begin", "profile", "rollback"]
  );
  assert.equal(pool.releaseCount, 1);
});

test("missing requests remain nondisclosing", async () => {
  const pool = createDispatchPool({
    request: null,
  });
  const result = await markEmergencyEnRoute(
    commandInput(pool)
  );

  assertFailure(
    result,
    404,
    "EMERGENCY_REQUEST_NOT_FOUND"
  );
  assert.deepEqual(
    pool.calls.map((call) => call.kind),
    ["begin", "profile", "request", "rollback"]
  );
  assert.equal(pool.releaseCount, 1);
});

test("unowned or invalid active relationships remain nondisclosing", async () => {
  const scenarios = [
    "request assigned to another professional",
    "missing active relationship",
    "inactive relationship",
    "relationship for another Emergency",
    "professional user mismatch",
    "contractor profile ownership mismatch",
    "caller owns another profile but not the selected profile",
  ];

  for (const scenario of scenarios) {
    const pool = createDispatchPool({
      relationship: null,
    });
    const result = await markEmergencyEnRoute(
      commandInput(pool, {
        scenario,
        contractorProfileId: 9999,
        professionalUserId: 9999,
        relationshipId: 9999,
      })
    );

    assertFailure(
      result,
      404,
      "EMERGENCY_REQUEST_NOT_FOUND"
    );
    assert.deepEqual(
      pool.calls.map((call) => call.kind),
      [
        "begin",
        "profile",
        "request",
        "relationship",
        "rollback",
      ]
    );
    assert.deepEqual(
      firstCall(pool, "relationship").params,
      [
        EMERGENCY_REQUEST_ID,
        AUTHENTICATED_USER_ID,
      ]
    );
    assert.equal(pool.releaseCount, 1);
  }
});

test("missing or inconsistent conversations block dispatch without recreation", async () => {
  const scenarios = [
    "missing conversation",
    "closed conversation",
    "conversation for another relationship",
    "homeowner participant mismatch",
    "contractor participant mismatch",
    "professional participant mismatch",
  ];

  for (const scenario of scenarios) {
    const pool = createDispatchPool({
      conversation: null,
    });
    const result = await markEmergencyEnRoute(
      commandInput(pool, { scenario })
    );

    assertFailure(
      result,
      409,
      "EMERGENCY_CONVERSATION_REQUIRED"
    );
    assert.deepEqual(
      pool.calls.map((call) => call.kind),
      [
        "begin",
        "profile",
        "request",
        "relationship",
        "conversation",
        "rollback",
      ]
    );
    assert.equal(
      callsOf(pool, "update").length,
      0
    );
    assert.equal(pool.releaseCount, 1);
    assertNoCreationOrDestruction(pool.calls);
  }
});

test("a zero-row conditional update fails safely", async () => {
  const pool = createDispatchPool({
    updateReturnsRow: false,
  });
  const result = await markEmergencyEnRoute(
    commandInput(pool)
  );

  assertFailure(
    result,
    409,
    "EMERGENCY_INVALID_TRANSITION"
  );
  assert.deepEqual(
    pool.calls.map((call) => call.kind),
    [
      "begin",
      "profile",
      "request",
      "relationship",
      "conversation",
      "update",
      "rollback",
    ]
  );
  assert.equal(
    callsOf(pool, "commit").length,
    0
  );
  assert.equal(pool.releaseCount, 1);
});

test("a zero-row conversation activity update rolls back the aggregate transition", async () => {
  const pool = createDispatchPool({
    activityReturnsRow: false,
  });
  const result = await markEmergencyEnRoute(
    commandInput(pool)
  );

  assertFailure(
    result,
    409,
    "EMERGENCY_CONVERSATION_REQUIRED"
  );
  assert.deepEqual(
    pool.calls.map((call) => call.kind),
    [
      "begin",
      "profile",
      "request",
      "relationship",
      "conversation",
      "update",
      "activity",
      "rollback",
    ]
  );
  assert.equal(
    callsOf(pool, "commit").length,
    0
  );
  assert.equal(pool.releaseCount, 1);
});

test("transaction failures normalize safely, roll back when appropriate, and release once", async () => {
  for (const failAt of [
    "begin",
    "profile",
    "request",
    "relationship",
    "conversation",
    "update",
    "activity",
    "commit",
  ]) {
    const pool = createDispatchPool({ failAt });
    const result = await markEmergencyEnRoute(
      commandInput(pool)
    );

    assertFailure(
      result,
      500,
      "EMERGENCY_DISPATCH_FAILED"
    );
    assert.equal(pool.connectCount, 1);
    assert.equal(pool.releaseCount, 1);
    assert.equal(
      callsOf(pool, "rollback").length,
      failAt === "begin" ? 0 : 1
    );

    if (failAt !== "commit") {
      assert.equal(
        callsOf(pool, "commit").length,
        0
      );
    }

    assert.equal(
      JSON.stringify(result).includes("private"),
      false
    );
  }
});

test("connection and invalid-client failures return the generic safe contract", async () => {
  const connectionPool = createDispatchPool({
    failAt: "connect",
  });
  const connectionResult =
    await markEmergencyEnRoute(
      commandInput(connectionPool)
    );

  assertFailure(
    connectionResult,
    500,
    "EMERGENCY_DISPATCH_FAILED"
  );
  assert.equal(connectionPool.connectCount, 1);
  assert.equal(connectionPool.releaseCount, 0);

  const invalidClientPool = createDispatchPool({
    invalidClient: true,
  });
  const invalidClientResult =
    await markEmergencyEnRoute(
      commandInput(invalidClientPool)
    );

  assertFailure(
    invalidClientResult,
    500,
    "EMERGENCY_DISPATCH_FAILED"
  );
  assert.equal(invalidClientPool.connectCount, 1);
  assert.equal(invalidClientPool.releaseCount, 1);
});

test("dispatch serialization excludes every private persistence field", async () => {
  const pool = createDispatchPool();
  const result = await markEmergencyEnRoute(
    commandInput(pool)
  );

  assertCanonicalSuccess(result, {
    code: "EMERGENCY_EN_ROUTE",
    alreadyApplied: false,
    status: "professional_en_route",
  });

  const serialized = JSON.stringify(result);

  for (const privateField of [
    "homeowner_id",
    "homeownerId",
    "contractor_id",
    "contractorId",
    "professional_user_id",
    "professionalUserId",
    "address",
    "unit",
    "access_instructions",
    "accessInstructions",
    "safety",
    "responses",
    "declinedResponses",
    "created_at",
    "createdAt",
    "database",
    "transaction",
    "resolved",
    "private",
  ]) {
    assert.equal(
      serialized.includes(privateField),
      false
    );
  }
});

test("service source cannot create canonical records or consume caller SQL authority", () => {
  const source = readFileSync(
    join(
      __dirname,
      "../server/emergency/emergencyDispatchService.js"
    ),
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /ensureConversation/i
  );
  assert.doesNotMatch(
    source,
    /\bINSERT\s+INTO\s+(?:emergency_requests|request_relationships|conversations|messages|workflow_events)\b/i
  );
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(source, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(source, /\bTRUNCATE\b/i);
  assert.doesNotMatch(source, /\bresolved_at\b/i);
  assert.doesNotMatch(
    source,
    /input\.(?:targetStatus|sourceStatus|timestampColumn|relationshipId|conversationId|contractorProfileId|professionalUserId)/
  );
});
