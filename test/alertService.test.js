"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_ALERT_PAGE_SIZE,
  MAX_ALERT_PAGE_SIZE,
  archiveAlert,
  createAlert,
  decodeAlertCursor,
  dismissAlert,
  encodeAlertCursor,
  expireAlert,
  getAlertCountsForRecipient,
  listAlertsForRecipient,
  markAllAlertsRead,
  markAlertRead,
  parseAlertPageSize,
  resolveAlertsBySource,
  serializeAlert,
  validateAlertInput,
  validateAlertListQuery,
} = require("../server/alerts/alertService");

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

const BASE_ROW = Object.freeze({
  id: 100,
  recipient_user_id: 7,
  source_domain: "communication",
  source_event_type: "conversation.message.created",
  source_entity_type: "conversation",
  source_entity_id: "91",
  source_event_id: "message:205",
  category: "communication",
  priority: "normal",
  title_key: "alerts.communication.message.title",
  message_key: "alerts.communication.message.body",
  safe_payload: { count: 1 },
  destination_type: "conversation",
  destination_payload: { conversationId: 91 },
  dedupe_key: "communication:conversation:91:message:205",
  lifecycle_state: "active",
  available_at: "2026-08-03T12:00:00.000Z",
  expires_at: null,
  read_at: null,
  dismissed_at: null,
  resolved_at: null,
  archived_at: null,
  created_at: "2026-08-03T12:00:00.000Z",
  updated_at: "2026-08-03T12:00:00.000Z",
});

function alertInput(overrides = {}) {
  return {
    recipientUserId: 7,
    sourceDomain: "communication",
    sourceEventType: "conversation.message.created",
    sourceEntityType: "conversation",
    sourceEntityId: "91",
    sourceEventId: "message:205",
    category: "communication",
    priority: "normal",
    titleKey: "alerts.communication.message.title",
    messageKey: "alerts.communication.message.body",
    safePayload: { count: 1 },
    destination: {
      type: "conversation",
      payload: { conversationId: 91 },
    },
    dedupeKey: "communication:conversation:91:message:205",
    ...overrides,
  };
}

function createPool({ duplicate = false, failAt = null, existingRow = BASE_ROW, missing = false } = {}) {
  const calls = [];
  let releases = 0;
  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params: structuredClone(params) });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (failAt && sql.includes(failAt)) {
        throw new Error("private alert persistence failure");
      }
      if (sql.startsWith("INSERT INTO alerts")) {
        return { rows: duplicate ? [] : [structuredClone(BASE_ROW)] };
      }
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM alerts") &&
        sql.includes("AND dedupe_key = $2")
      ) {
        return { rows: [structuredClone(existingRow)] };
      }
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM alerts") &&
        sql.includes("FOR UPDATE")
      ) {
        return { rows: missing ? [] : [structuredClone(existingRow)] };
      }
      if (sql.startsWith("UPDATE alerts") && sql.includes("SET lifecycle_state = 'dismissed'")) {
        return {
          rows: [structuredClone({
            ...existingRow,
            lifecycle_state: "dismissed",
            dismissed_at: "2026-08-03T12:02:00.000Z",
          })],
        };
      }
      if (sql.startsWith("UPDATE alerts") && sql.includes("SET read_at")) {
        return {
          rows: [structuredClone({ ...existingRow, read_at: "2026-08-03T12:01:00.000Z" })],
        };
      }
      if (sql.startsWith("UPDATE alerts") && sql.includes("SET lifecycle_state = 'resolved'")) {
        return {
          rows: [structuredClone({
            ...existingRow,
            lifecycle_state: "resolved",
            resolved_at: "2026-08-03T12:03:00.000Z",
          })],
        };
      }
      if (sql.startsWith("UPDATE alerts") && sql.includes("SET lifecycle_state = 'expired'")) {
        return {
          rows: [structuredClone({
            ...existingRow,
            lifecycle_state: "expired",
          })],
        };
      }
      if (sql.startsWith("UPDATE alerts") && sql.includes("SET lifecycle_state = 'archived'")) {
        return {
          rows: [structuredClone({
            ...existingRow,
            lifecycle_state: "archived",
            archived_at: "2026-08-04T00:00:00.000Z",
          })],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      releases += 1;
    },
  };

  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
      async query() {
        throw new Error("Pool query should not be used directly.");
      },
    },
    client,
    get releases() {
      return releases;
    },
  };
}

test("alert service validates backend alert input before persistence", () => {
  assert.equal(validateAlertInput(alertInput()).ok, true);
  assert.equal(
    validateAlertInput(alertInput({ recipientUserId: "bad" })).code,
    "INVALID_ALERT_RECIPIENT"
  );
  assert.equal(
    validateAlertInput(alertInput({ sourceDomain: "client" })).code,
    "INVALID_ALERT_SOURCE"
  );
  assert.equal(
    validateAlertInput(alertInput({ category: "unknown" })).code,
    "INVALID_ALERT_CATEGORY"
  );
  assert.equal(
    validateAlertInput(alertInput({ priority: "urgent" })).code,
    "INVALID_ALERT_PRIORITY"
  );
  assert.equal(
    validateAlertInput(alertInput({ titleKey: "bad key" })).code,
    "INVALID_ALERT_TITLE_KEY"
  );
  assert.equal(
    validateAlertInput(alertInput({ safePayload: { body: "private" } })).code,
    "INVALID_ALERT_PAYLOAD"
  );
  assert.equal(
    validateAlertInput(alertInput({ safePayload: null })).code,
    "INVALID_ALERT_PAYLOAD"
  );
  assert.equal(
    validateAlertInput(alertInput({ destination: { type: "conversation", payload: { requestId: 1 } } })).code,
    "INVALID_ALERT_DESTINATION"
  );
  assert.equal(
    validateAlertInput(alertInput({ dedupeKey: "" })).code,
    "INVALID_ALERT_DEDUPE_KEY"
  );
  const serverOwned = validateAlertInput(alertInput({
    lifecycleState: "archived",
    readAt: "2026-08-03T12:00:00.000Z",
    resolvedAt: "2026-08-03T12:00:00.000Z",
  }));
  assert.equal(serverOwned.ok, true);
  assert.equal(Object.hasOwn(serverOwned.alert, "lifecycleState"), false);
  assert.equal(Object.hasOwn(serverOwned.alert, "readAt"), false);
  assert.equal(Object.hasOwn(serverOwned.alert, "resolvedAt"), false);
});

test("permanent lifecycle identity is deterministic, required, and server derived", () => {
  const event = alertInput({
    sourceDomain: "workflow",
    sourceEventType: "request.professional_selected",
    sourceEntityType: "request_selection",
    sourceEntityId: "55",
    sourceEventId: "selection:55",
    permanentEvent: true,
  });
  const first = validateAlertInput(event);
  const replay = validateAlertInput({ ...event, dedupeKey: "replayed-command" });

  assert.equal(first.ok, true);
  assert.match(first.alert.canonicalEventKey, /^[0-9a-f]{64}$/);
  assert.equal(replay.alert.canonicalEventKey, first.alert.canonicalEventKey);
  assert.equal(
    validateAlertInput({ ...event, sourceEventId: null }).code,
    "INVALID_ALERT_SOURCE"
  );
  assert.equal(
    validateAlertInput({ ...event, canonicalEventKey: "a".repeat(64) }).code,
    "INVALID_ALERT_SOURCE"
  );

  const communication = validateAlertInput(alertInput());
  assert.equal(communication.ok, true);
  assert.equal(communication.alert.canonicalEventKey, null);
});

test("alert service creates and serializes a backend alert in a service-owned transaction", async () => {
  const context = createPool();
  const result = await createAlert({
    pool: context.pool,
    input: alertInput(),
    logger: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.alert.id, "100");
  assert.equal(result.alert.destination.conversationId, 91);
  assert.equal(result.alert.state.lifecycle, "active");
  assert.equal(Object.hasOwn(result.alert, "dedupe_key"), false);
  assert.equal(Object.hasOwn(result.alert, "recipient_user_id"), false);
  assert.deepEqual(
    context.calls.map((call) => call.sql).filter((sql) => ["BEGIN", "COMMIT"].includes(sql)),
    ["BEGIN", "COMMIT"]
  );
  assert.equal(context.releases, 1);
});

test("alert service returns existing active alert on duplicate dedupe without reopening resolved rows", async () => {
  const { pool, calls } = createPool({ duplicate: true });
  const result = await createAlert({
    pool,
    input: alertInput(),
    logger: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.created, false);
  assert.ok(calls.some((call) => call.sql.includes("resolved_at IS NULL")));
  assert.ok(calls.some((call) => call.sql.includes("lifecycle_state IN ('active', 'dismissed')")));
});

test("alert service rolls back and releases on standalone persistence failure", async () => {
  const context = createPool({ failAt: "INSERT INTO alerts" });
  const result = await createAlert({
    pool: context.pool,
    input: alertInput(),
    logger: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ALERT_CREATE_FAILED");
  assert.ok(context.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(context.releases, 1);
});

test("alert service supports caller-owned clients without commit, rollback, or release", async () => {
  const { client, calls } = createPool();
  const result = await createAlert({
    client,
    input: alertInput(),
    logger: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql)), false);
});

test("alert service propagates caller-owned database errors without rollback or release", async () => {
  const context = createPool({ failAt: "INSERT INTO alerts" });
  await assert.rejects(
    createAlert({
      client: context.client,
      input: alertInput(),
      logger: () => {},
    }),
    /private alert persistence failure/
  );
  assert.equal(
    context.calls.some((call) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql)),
    false
  );
  assert.equal(context.releases, 0);
});

test("alert lifecycle services preserve caller-owned error and transaction authority", async () => {
  const expireContext = createPool({
    failAt: "SET lifecycle_state = 'expired'",
    existingRow: {
      ...BASE_ROW,
      expires_at: "2026-08-03T12:00:00.000Z",
    },
  });
  await assert.rejects(
    expireAlert({
      client: expireContext.client,
      alertId: 100,
      recipientUserId: 7,
      effectiveAt: "2026-08-04T00:00:00.000Z",
      logger: () => {},
    }),
    /private alert persistence failure/
  );
  assert.equal(
    expireContext.calls.some((call) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql)),
    false
  );
  assert.equal(expireContext.releases, 0);

  const archiveContext = createPool({
    failAt: "SET lifecycle_state = 'archived'",
    existingRow: {
      ...BASE_ROW,
      lifecycle_state: "resolved",
      resolved_at: "2026-08-03T13:00:00.000Z",
    },
  });
  await assert.rejects(
    archiveAlert({
      client: archiveContext.client,
      alertId: 100,
      recipientUserId: 7,
      logger: () => {},
    }),
    /private alert persistence failure/
  );
  assert.equal(
    archiveContext.calls.some((call) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql)),
    false
  );
  assert.equal(archiveContext.releases, 0);
});

test("service-owned lifecycle failures roll back safely without leaking SQL details", async () => {
  const logs = [];
  const context = createPool({
    failAt: "SET lifecycle_state = 'expired'",
    existingRow: {
      ...BASE_ROW,
      expires_at: "2026-08-03T12:00:00.000Z",
    },
  });
  const result = await expireAlert({
    pool: context.pool,
    alertId: 100,
    recipientUserId: 7,
    effectiveAt: "2026-08-04T00:00:00.000Z",
    logger: (...args) => logs.push(args),
  });
  assert.equal(result.code, "ALERT_EXPIRE_FAILED");
  assert.doesNotMatch(JSON.stringify({ result, logs }), /private alert persistence failure|UPDATE alerts/i);
  assert.ok(context.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(context.releases, 1);
});

test("alert service marks read and dismisses only recipient-owned alerts", async () => {
  const { pool, calls } = createPool();
  const read = await markAlertRead({
    pool,
    alertId: 100,
    recipientUserId: 7,
    logger: () => {},
  });
  const dismissed = await dismissAlert({
    pool,
    alertId: 100,
    recipientUserId: 7,
    logger: () => {},
  });

  assert.equal(read.alert.state.isRead, true);
  assert.equal(dismissed.alert.state.lifecycle, "dismissed");
  assert.ok(calls.some((call) => call.sql.includes("WHERE id = $1 AND recipient_user_id = $2")));
});

test("alert service rejects outsider read and critical dismissal", async () => {
  assert.equal(
    (await markAlertRead({
      pool: createPool().pool,
      alertId: "bad",
      recipientUserId: 7,
      logger: () => {},
    })).code,
    "ALERT_NOT_FOUND"
  );

  const critical = createPool({
    existingRow: { ...BASE_ROW, priority: "critical" },
  });
  assert.equal(
    (await dismissAlert({
      pool: critical.pool,
      alertId: 100,
      recipientUserId: 7,
      logger: () => {},
    })).code,
    "ALERT_NOT_DISMISSIBLE"
  );

  const outsider = createPool({ missing: true });
  const outsiderResult = await markAlertRead({
    pool: outsider.pool,
    alertId: 100,
    recipientUserId: 999,
    logger: () => {},
  });
  assert.equal(outsiderResult.code, "ALERT_NOT_FOUND");
  assert.equal(
    outsider.calls.some((call) => call.sql.startsWith("UPDATE alerts")),
    false
  );
});

test("alert service resolves matching alerts by trusted source only", async () => {
  const { pool, calls } = createPool();
  const result = await resolveAlertsBySource({
    pool,
    input: {
      sourceDomain: "communication",
      sourceEntityType: "conversation",
      sourceEntityId: "91",
      sourceEventType: "conversation.message.created",
      recipientUserId: 7,
    },
    logger: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.ok(calls.some((call) => call.sql.includes("source_domain = $1")));
  assert.ok(calls.some((call) => call.sql.includes("recipient_user_id = $5")));
});

test("alert service permits omitted resolution filters without fabricating scope", async () => {
  const { pool, calls } = createPool();
  const result = await resolveAlertsBySource({
    pool,
    input: {
      sourceDomain: "communication",
      sourceEntityType: "conversation",
      sourceEntityId: "91",
    },
    logger: () => {},
  });

  assert.equal(result.ok, true);
  const update = calls.find((call) => call.sql.startsWith("UPDATE alerts"));
  assert.equal(update.params[3], null);
  assert.equal(update.params[4], null);
});

test("alert service rejects every malformed supplied resolution filter before SQL", async () => {
  const invalidRecipients = [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    false,
    "",
    "   ",
    "bad",
    null,
    undefined,
    {},
    [],
    Number.NaN,
  ];
  for (const recipientUserId of invalidRecipients) {
    const context = createPool();
    const result = await resolveAlertsBySource({
      pool: context.pool,
      input: {
        sourceDomain: "communication",
        sourceEntityType: "conversation",
        sourceEntityId: "91",
        recipientUserId,
      },
      logger: () => {},
    });
    assert.equal(result.code, "INVALID_ALERT_SOURCE");
    assert.equal(context.calls.length, 0);
  }

  for (const sourceEventType of [false, 0, "", "   ", {}, [], "https://bad"]) {
    const context = createPool();
    const result = await resolveAlertsBySource({
      pool: context.pool,
      input: {
        sourceDomain: "communication",
        sourceEntityType: "conversation",
        sourceEntityId: "91",
        sourceEventType,
      },
      logger: () => {},
    });
    assert.equal(result.code, "INVALID_ALERT_SOURCE");
    assert.equal(context.calls.length, 0);
  }
});

test("alert service expires due active and dismissed alerts idempotently", async () => {
  for (const lifecycle_state of ["active", "dismissed", "expired"]) {
    const context = createPool({
      existingRow: {
        ...BASE_ROW,
        lifecycle_state,
        dismissed_at: lifecycle_state === "dismissed" ? "2026-08-03T12:01:00.000Z" : null,
        expires_at: "2026-08-03T13:00:00.000Z",
      },
    });
    const result = await expireAlert({
      pool: context.pool,
      alertId: 100,
      recipientUserId: 7,
      effectiveAt: "2026-08-03T14:00:00.000Z",
      logger: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.alert.state.lifecycle, "expired");
    assert.equal(result.alert.state.isExpired, true);
    assert.ok(context.calls.some((call) => call.sql.includes("expires_at <= COALESCE")));
  }
});

test("alert service rejects early or terminal expiration without an update", async () => {
  const early = createPool({
    existingRow: {
      ...BASE_ROW,
      expires_at: "2026-08-04T00:00:00.000Z",
    },
  });
  const result = await expireAlert({
    pool: early.pool,
    alertId: 100,
    recipientUserId: 7,
    effectiveAt: "2026-08-03T14:00:00.000Z",
    logger: () => {},
  });
  assert.equal(result.code, "ALERT_NOT_EXPIRABLE");
  assert.equal(early.calls.some((call) => call.sql.startsWith("UPDATE alerts")), false);

  for (const lifecycle_state of ["resolved", "archived"]) {
    const context = createPool({
      existingRow: {
        ...BASE_ROW,
        lifecycle_state,
        expires_at: "2026-08-03T12:00:00.000Z",
        archived_at: lifecycle_state === "archived" ? "2026-08-03T13:00:00.000Z" : null,
      },
    });
    const terminal = await expireAlert({
      pool: context.pool,
      alertId: 100,
      recipientUserId: 7,
      effectiveAt: "2026-08-04T00:00:00.000Z",
      logger: () => {},
    });
    assert.equal(["ALERT_NOT_EXPIRABLE", "ALERT_NOT_FOUND"].includes(terminal.code), true);
    assert.equal(context.calls.some((call) => call.sql.startsWith("UPDATE alerts")), false);
  }
});

test("alert service archives resolved and expired alerts idempotently", async () => {
  for (const lifecycle_state of ["resolved", "expired", "archived"]) {
    const context = createPool({
      existingRow: {
        ...BASE_ROW,
        lifecycle_state,
        resolved_at: lifecycle_state === "resolved" ? "2026-08-03T13:00:00.000Z" : null,
        archived_at: lifecycle_state === "archived" ? "2026-08-03T14:00:00.000Z" : null,
      },
    });
    const result = await archiveAlert({
      pool: context.pool,
      alertId: 100,
      recipientUserId: 7,
      archivedAt: "2026-08-03T14:00:00.000Z",
      logger: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.alert.state.lifecycle, "archived");
    assert.equal(result.alert.state.isArchived, true);
    assert.equal(result.alert.archivedAt, "2026-08-04T00:00:00.000Z");
  }
});

test("alert service refuses to archive active or dismissed obligations", async () => {
  for (const lifecycle_state of ["active", "dismissed"]) {
    const context = createPool({
      existingRow: { ...BASE_ROW, lifecycle_state },
    });
    const result = await archiveAlert({
      pool: context.pool,
      alertId: 100,
      recipientUserId: 7,
      logger: () => {},
    });
    assert.equal(result.code, "ALERT_NOT_ARCHIVABLE");
    assert.equal(context.calls.some((call) => call.sql.startsWith("UPDATE alerts")), false);
  }
});

test("alert serialization exposes only the approved public shape", () => {
  const result = serializeAlert(BASE_ROW);
  assert.deepEqual(Object.keys(result).sort(), [
    "archivedAt",
    "availableAt",
    "category",
    "createdAt",
    "destination",
    "dismissedAt",
    "expiresAt",
    "id",
    "messageKey",
    "payload",
    "priority",
    "readAt",
    "resolvedAt",
    "state",
    "titleKey",
    "updatedAt",
  ].sort());
  assert.equal(result.id, "100");
  assert.deepEqual(result.destination, {
    type: "conversation",
    conversationId: 91,
  });
  assert.deepEqual(result.state, {
    lifecycle: "active",
    isRead: false,
    isDismissed: false,
    isResolved: false,
    isExpired: false,
    isArchived: false,
  });
});

test("alert API pagination constants and cursors are deterministic and fail closed", () => {
  assert.equal(DEFAULT_ALERT_PAGE_SIZE, 25);
  assert.equal(MAX_ALERT_PAGE_SIZE, 50);
  assert.equal(parseAlertPageSize(undefined), 25);
  assert.equal(parseAlertPageSize("1"), 1);
  assert.equal(parseAlertPageSize("50"), 50);
  for (const value of ["", "0", "01", "-1", "1.5", "51", "bad", 25]) {
    assert.equal(parseAlertPageSize(value), null);
  }

  const cursor = encodeAlertCursor({
    id: "100",
    available_at: "2026-08-03T12:00:00.000Z",
  });
  assert.deepEqual(decodeAlertCursor(cursor), {
    valid: true,
    cursor: {
      availableAt: "2026-08-03T12:00:00.000Z",
      id: 100,
    },
  });
  const decoded = decodeAlertCursor(cursor);
  assert.equal(encodeAlertCursor({
    id: decoded.cursor.id,
    available_at: decoded.cursor.availableAt,
  }), cursor);

  for (const value of [
    "",
    "not+a+base64url+cursor",
    "a".repeat(1025),
    `${cursor}=`,
    Buffer.from([0xff]).toString("base64url"),
    Buffer.from(JSON.stringify({ id: 1 }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      availableAt: "2026-08-03T12:00:00.000Z",
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify([]), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      id: 1,
      availableAt: "invalid",
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      id: "1",
      availableAt: "2026-08-03T12:00:00.000Z",
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      id: 0,
      availableAt: "2026-08-03T12:00:00.000Z",
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      id: -1,
      availableAt: "2026-08-03T12:00:00.000Z",
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      id: Number.MAX_SAFE_INTEGER + 1,
      availableAt: "2026-08-03T12:00:00.000Z",
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      id: 1,
      availableAt: "2026-08-03T12:00:00.000Z",
      recipientUserId: 999,
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      id: 1,
      availableAt: "2026-08-03T12:00:00.000Z' OR TRUE --",
    }), "utf8").toString("base64url"),
  ]) {
    assert.deepEqual(decodeAlertCursor(value), {
      valid: false,
      cursor: null,
    });
  }
});

test("alert cursors reject every noncanonical JSON representation", () => {
  const timestamp = "2026-08-04T00:00:00.000Z";
  const encodeJson = (value) =>
    Buffer.from(value, "utf8").toString("base64url");
  const noncanonicalJson = [
    ` {"availableAt":"${timestamp}","id":12}`,
    `{"availableAt":"${timestamp}","id":12} `,
    `{"availableAt": "${timestamp}","id":12}`,
    `{"availableAt":"${timestamp}", "id":12}`,
    `\n{\n  "availableAt": "${timestamp}",\n  "id": 12\n}`,
    `{"availableAt":"${timestamp}","id":12}\n`,
    `{"id":12,"availableAt":"${timestamp}"}`,
    `{"availableAt":"${timestamp}","id":12,"id":12}`,
    `{"availableAt":"${timestamp}","availableAt":"${timestamp}","id":12}`,
    `{"availableAt":"${timestamp}","id":1,"id":12}`,
    `{"availableAt":"${timestamp}","id":12,"id":13}`,
    `{"availableAt":"2026-08-03T00:00:00.000Z","availableAt":"${timestamp}","id":12}`,
    `{"availableAt":"${timestamp}","availableAt":"2026-08-05T00:00:00.000Z","id":12}`,
    `{"availableAt":"${timestamp}","id":12.0}`,
    `{"availableAt":"${timestamp}","id":1.2e1}`,
    `{"availableAt":"${timestamp}","id":12e0}`,
  ];

  for (const json of noncanonicalJson) {
    assert.deepEqual(decodeAlertCursor(encodeJson(json)), {
      valid: false,
      cursor: null,
    });
  }
});

test("noncanonical alert cursors use only the safe cursor error contract", () => {
  const raw = ` {"availableAt":"2026-08-04T00:00:00.000Z","id":12}`;
  const cursor = Buffer.from(raw, "utf8").toString("base64url");
  const result = validateAlertListQuery({ cursor });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    code: "INVALID_ALERT_CURSOR",
    message: "Alert cursor is invalid.",
  });
  assert.doesNotMatch(JSON.stringify(result), /availableAt|2026-08-04|raw|parser|SQL/i);
});

test("alert cursors reject timestamp forms that normalize to another representation", () => {
  const encodeJson = (availableAt) => Buffer.from(JSON.stringify({
    availableAt,
    id: 12,
  }), "utf8").toString("base64url");

  for (const availableAt of [
    "2026-08-03T20:00:00.000-04:00",
    "2026-08-04T00:00:00Z",
    "2026-08-04T00:00:00.0000Z",
    "2026-08-04T00:00:00.000z",
    "2026-08-04",
    " 2026-08-04T00:00:00.000Z ",
  ]) {
    assert.deepEqual(decodeAlertCursor(encodeJson(availableAt)), {
      valid: false,
      cursor: null,
    });
  }
});

test("alert cursor decoding never executes object coercion or accessor hooks", () => {
  let executed = false;
  const custom = Object.create(null, {
    toJSON: {
      enumerable: true,
      value() { executed = true; },
    },
    toString: {
      enumerable: true,
      value() { executed = true; },
    },
    valueOf: {
      enumerable: true,
      value() { executed = true; },
    },
    cursor: {
      enumerable: true,
      get() {
        executed = true;
        return "ignored";
      },
    },
  });

  assert.deepEqual(decodeAlertCursor(custom), {
    valid: false,
    cursor: null,
  });
  const proxied = new Proxy({}, {
    get() {
      executed = true;
      return "ignored";
    },
    getPrototypeOf() {
      executed = true;
      return Object.prototype;
    },
  });
  assert.deepEqual(decodeAlertCursor(proxied), {
    valid: false,
    cursor: null,
  });
  assert.equal(executed, false);
});

test("alert list service applies defaults and bounded descending pagination", async () => {
  const calls = [];
  const rows = Array.from({ length: 26 }, (_, index) => ({
    ...BASE_ROW,
    id: 200 - index,
    available_at: `2026-08-03T12:${String(59 - index).padStart(2, "0")}:00.000Z`,
  }));
  const pool = {
    async query(text, params) {
      calls.push({ sql: normalizeSql(text), params });
      return { rows };
    },
  };

  const result = await listAlertsForRecipient({
    pool,
    recipientUserId: 7,
    query: {},
    logger: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.alerts.length, 25);
  assert.deepEqual(result.pagination, {
    limit: 25,
    hasMore: true,
    nextCursor: result.pagination.nextCursor,
  });
  assert.deepEqual(decodeAlertCursor(result.pagination.nextCursor), {
    valid: true,
    cursor: {
      availableAt: rows[24].available_at,
      id: rows[24].id,
    },
  });
  assert.deepEqual(calls[0].params, [
    7,
    "active",
    null,
    null,
    null,
    false,
    null,
    0,
    26,
  ]);
});

test("alert list service passes only allowlisted exact filters", async () => {
  let params;
  const cursor = encodeAlertCursor({
    id: 100,
    available_at: "2026-08-03T12:00:00.000Z",
  });
  const pool = {
    async query(_text, values) {
      params = values;
      return { rows: [] };
    },
  };

  const result = await listAlertsForRecipient({
    pool,
    recipientUserId: 7,
    query: {
      limit: "10",
      cursor,
      category: "communication",
      priority: "high",
      lifecycle: "dismissed",
      unread: "false",
    },
    logger: () => {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(params, [
    7,
    "dismissed",
    "communication",
    "high",
    false,
    true,
    "2026-08-03T12:00:00.000Z",
    100,
    11,
  ]);
});

test("alert list rejects malformed and authority-bearing queries before SQL", async () => {
  const invalidQueries = [
    { recipientUserId: "9" },
    { userId: "9" },
    { sourceDomain: "communication" },
    { limit: "0" },
    { limit: "51" },
    { limit: "1.5" },
    { limit: String(Number.MAX_SAFE_INTEGER + 1) },
    { category: "unknown" },
    { priority: "urgent" },
    { lifecycle: "unknown" },
    { unread: "1" },
    { unread: "yes" },
    { unread: "" },
    { unread: true },
    { cursor: "invalid" },
    { cursor: undefined },
  ];

  for (const query of invalidQueries) {
    let calls = 0;
    const result = await listAlertsForRecipient({
      pool: { async query() { calls += 1; return { rows: [] }; } },
      recipientUserId: 7,
      query,
      logger: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
});

test("alert count service normalizes one recipient-scoped aggregate", async () => {
  let params;
  const pool = {
    async query(_text, values) {
      params = values;
      return {
        rows: [
          { category: "communication", active_count: "2", unread_count: "1" },
          { category: "emergency", active_count: 3, unread_count: 2 },
          { category: "invented", active_count: 999, unread_count: 999 },
        ],
      };
    },
  };

  const result = await getAlertCountsForRecipient({
    pool,
    recipientUserId: 7,
    query: {},
    logger: () => {},
  });

  assert.deepEqual(params, [7]);
  assert.deepEqual(result.counts, {
    active: 5,
    unread: 3,
    byCategory: {
      communication: { active: 2, unread: 1 },
      emergency: { active: 3, unread: 2 },
    },
  });
});

test("alert counts reject every query parameter before SQL", async () => {
  let calls = 0;
  const result = await getAlertCountsForRecipient({
    pool: { async query() { calls += 1; return { rows: [] }; } },
    recipientUserId: 7,
    query: { category: "communication" },
    logger: () => {},
  });
  assert.equal(result.code, "INVALID_ALERT_QUERY");
  assert.equal(calls, 0);
});

test("alert read-all returns a server cutoff and is idempotently count based", async () => {
  const calls = [];
  const pool = {
    async query(text, params) {
      calls.push({ sql: normalizeSql(text), params });
      return {
        rows: [{
          cutoff_at: new Date("2026-08-03T12:00:00.000Z"),
          marked_read_count: calls.length === 1 ? 3 : 0,
        }],
      };
    },
  };

  const first = await markAllAlertsRead({
    pool,
    recipientUserId: 7,
    query: {},
    input: { category: "communication" },
    logger: () => {},
  });
  const repeated = await markAllAlertsRead({
    pool,
    recipientUserId: 7,
    query: {},
    logger: () => {},
  });

  assert.deepEqual(first, {
    ok: true,
    status: 200,
    code: "ALERTS_MARKED_READ",
    markedReadCount: 3,
    cutoffAt: "2026-08-03T12:00:00.000Z",
  });
  assert.equal(repeated.markedReadCount, 0);
  assert.deepEqual(calls[0].params, [7, "communication"]);
  assert.deepEqual(calls[1].params, [7, null]);
});

test("alert read-all rejects unknown body/query authority before SQL", async () => {
  const inputs = [
    { input: { recipientUserId: 9 }, query: {} },
    { input: { lifecycle: "active" }, query: {} },
    { input: { category: "unknown" }, query: {} },
    { input: { category: undefined }, query: {} },
    { input: {}, query: { cutoffAt: "2026-08-03" } },
  ];

  for (const value of inputs) {
    let calls = 0;
    const result = await markAllAlertsRead({
      pool: { async query() { calls += 1; return { rows: [] }; } },
      recipientUserId: 7,
      ...value,
      logger: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
});

test("alert API services normalize pool failures and preserve caller-owned errors", async () => {
  const error = new Error("private payload and SQL detail");
  const loggerEntries = [];
  const poolResult = await listAlertsForRecipient({
    pool: { async query() { throw error; } },
    recipientUserId: 7,
    query: {},
    logger: (...args) => loggerEntries.push(args),
  });
  assert.equal(poolResult.code, "ALERTS_FETCH_FAILED");
  assert.doesNotMatch(JSON.stringify({ poolResult, loggerEntries }), /private payload|SQL detail/);

  await assert.rejects(
    markAllAlertsRead({
      client: { async query() { throw error; } },
      recipientUserId: 7,
      query: {},
      input: {},
      logger: () => {},
    }),
    (caught) => caught === error
  );
});
