"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-alert-routes";

const { app, createToken } = require("../index");
const {
  createAlertHandlers,
  registerAlertRoutes,
  setAlertNoStore,
} = require("../server/alerts/alerts");

function response() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      this.finished = true;
      return this;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
  };
}

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function route(method, path) {
  return app.router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method]
  );
}

async function runHandlers(handlers, req, res) {
  for (const handler of handlers) {
    if (res.finished) break;
    if (handler.length < 3) {
      await handler(req, res);
      continue;
    }
    await new Promise((resolve, reject) => {
      const next = (error) => error ? reject(error) : resolve();
      Promise.resolve(handler(req, res, next)).then(
        () => { if (res.finished) resolve(); },
        reject
      );
    });
  }
}

async function invokeAppRoute({
  method,
  path,
  userId = 7,
  authenticated = true,
  params = {},
  query = {},
  body,
  pool,
}) {
  const layer = route(method, path);
  assert.ok(layer, `${method.toUpperCase()} ${path}`);
  app.locals.pool = pool;
  const req = {
    app,
    params,
    query,
    body,
    headers: authenticated
      ? {
          authorization: `Bearer ${createToken({
            id: userId,
            email: `user${userId}@example.test`,
            role: "user",
            token_version: 0,
          })}`,
        }
      : {},
  };
  const res = response();
  try {
    await runHandlers(layer.route.stack.map((item) => item.handle), req, res);
    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("exactly five authenticated alert endpoints are registered in safe order", () => {
  const calls = [];
  const fakeApp = {
    get(path, ...handlers) { calls.push({ method: "get", path, handlers }); },
    post(path, ...handlers) { calls.push({ method: "post", path, handlers }); },
  };
  const authMiddleware = (_req, _res, next) => next();

  registerAlertRoutes({
    app: fakeApp,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
    service: {},
  });

  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["get", "/alerts"],
    ["get", "/alerts/counts"],
    ["post", "/alerts/read-all"],
    ["post", "/alerts/:alertId/read"],
    ["post", "/alerts/:alertId/dismiss"],
  ]);
  assert.ok(calls.every(({ handlers }) => handlers.length === 3));
  assert.ok(calls.every(({ handlers }) => handlers[0] === setAlertNoStore));
  assert.ok(calls.every(({ handlers }) => handlers[1] === authMiddleware));
  assert.equal(calls.findIndex(({ path }) => path === "/alerts/read-all") <
    calls.findIndex(({ path }) => path === "/alerts/:alertId/read"), true);
  assert.equal(calls.some(({ method, path }) => method === "post" && path === "/alerts"), false);
});

test("alert no-store middleware protects every response before authentication", () => {
  const res = response();
  let continued = false;
  setAlertNoStore({}, res, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(res.getHeader("Cache-Control"), "no-store");
  assert.equal(res.getHeader("Pragma"), "no-cache");
});

test("actual alert route rejects unauthenticated access before alert SQL", async () => {
  const calls = [];
  const pool = {
    async query(text) {
      calls.push(normalizeSql(text));
      throw new Error("No SQL should execute.");
    },
  };

  const result = await invokeAppRoute({
    method: "get",
    path: "/alerts",
    authenticated: false,
    pool,
  });

  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "AUTHENTICATION_REQUIRED");
  assert.equal(result.getHeader("Cache-Control"), "no-store");
  assert.equal(calls.length, 0);
});

test("actual list route scopes SQL exclusively to authenticated req.user.id", async () => {
  const calls = [];
  const pool = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });
      if (sql.includes("SELECT id, email, role, token_version") && sql.includes("FROM users")) {
        return {
          rows: [{ id: params[0], email: "owner@example.test", role: "user", token_version: 0 }],
        };
      }
      if (sql.includes("FROM alerts")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const result = await invokeAppRoute({
    method: "get",
    path: "/alerts",
    userId: 7,
    pool,
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    success: true,
    code: "ALERTS_RETRIEVED",
    alerts: [],
    pagination: { limit: 25, hasMore: false, nextCursor: null },
  });
  const alertQuery = calls.find(({ sql }) => sql.includes("FROM alerts"));
  assert.equal(alertQuery.params[0], 7);
  assert.equal(result.getHeader("Cache-Control"), "no-store");
});

test("route handlers derive recipient only from authenticated identity", async () => {
  let received;
  const handlers = createAlertHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {
      async listAlertsForRecipient(input) {
        received = input;
        return {
          ok: true,
          status: 200,
          code: "ALERTS_RETRIEVED",
          alerts: [],
          pagination: { limit: 25, hasMore: false, nextCursor: null },
        };
      },
    },
  });
  const res = response();

  await handlers.listAlerts({
    user: { id: 7 },
    query: {},
    body: {},
  }, res);

  assert.equal(received.recipientUserId, 7);
  assert.equal(Object.hasOwn(received, "userId"), false);
  assert.equal(Object.hasOwn(received, "ownerId"), false);
});

test("list and counts reject authority-bearing GET bodies before service", async () => {
  let calls = 0;
  const handlers = createAlertHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {
      async listAlertsForRecipient() { calls += 1; },
      async getAlertCountsForRecipient() { calls += 1; },
    },
  });

  for (const handler of [handlers.listAlerts, handlers.getCounts]) {
    const res = response();
    await handler({
      user: { id: 7 },
      query: {},
      body: { recipientUserId: 999 },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_ALERT_REQUEST");
  }
  assert.equal(calls, 0);
});

test("mark-one and dismiss reject invalid IDs and authority-bearing bodies before service", async () => {
  let calls = 0;
  const service = {
    async markAlertRead() { calls += 1; return { ok: true, alert: {} }; },
    async dismissAlert() { calls += 1; return { ok: true, code: "ALERT_DISMISSED", alert: {} }; },
  };
  const handlers = createAlertHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service,
  });

  for (const alertId of ["0", "-1", "1.5", "01", "bad", String(Number.MAX_SAFE_INTEGER + 1)]) {
    const res = response();
    await handlers.markOneRead({
      user: { id: 7 }, params: { alertId }, query: {}, body: {},
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_ALERT_ID");
  }

  for (const handler of [handlers.markOneRead, handlers.dismiss]) {
    const res = response();
    await handler({
      user: { id: 7 },
      params: { alertId: "1" },
      query: {},
      body: { recipientUserId: 999 },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_ALERT_REQUEST");
  }
  assert.equal(calls, 0);
});

test("mark-one and dismiss use only canonical ID plus authenticated recipient", async () => {
  const received = [];
  const activeAlert = {
    id: "100",
    state: { lifecycle: "active", isRead: true },
  };
  const handlers = createAlertHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {
      async markAlertRead(input) {
        received.push({ operation: "read", input });
        return { ok: true, status: 200, code: "ALERT_READ", alert: activeAlert };
      },
      async dismissAlert(input) {
        received.push({ operation: "dismiss", input });
        return {
          ok: true,
          status: 200,
          code: "ALERT_DISMISSED",
          alert: { ...activeAlert, state: { lifecycle: "dismissed", isRead: true } },
        };
      },
    },
  });

  const readRes = response();
  await handlers.markOneRead({
    user: { id: 7 }, params: { alertId: "100" }, query: {}, body: {},
  }, readRes);
  const dismissRes = response();
  await handlers.dismiss({
    user: { id: 7 }, params: { alertId: "100" }, query: {}, body: {},
  }, dismissRes);

  assert.equal(readRes.body.code, "ALERT_MARKED_READ");
  assert.equal(readRes.body.alert.state.lifecycle, "active");
  assert.equal(dismissRes.body.code, "ALERT_DISMISSED");
  assert.deepEqual(received.map(({ operation, input }) => ({
    operation,
    alertId: input.alertId,
    recipientUserId: input.recipientUserId,
    hasBody: Object.hasOwn(input, "body"),
  })), [
    { operation: "read", alertId: 100, recipientUserId: 7, hasBody: false },
    { operation: "dismiss", alertId: 100, recipientUserId: 7, hasBody: false },
  ]);
});

test("read-all accepts only optional category and returns the server cutoff", async () => {
  let received;
  const handlers = createAlertHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {
      async markAllAlertsRead(input) {
        received = input;
        return {
          ok: true,
          status: 200,
          code: "ALERTS_MARKED_READ",
          markedReadCount: 2,
          cutoffAt: "2026-08-03T12:00:00.000Z",
        };
      },
    },
  });
  const res = response();
  await handlers.markAllRead({
    user: { id: 7 },
    query: {},
    body: { category: "communication" },
  }, res);

  assert.equal(received.recipientUserId, 7);
  assert.deepEqual(res.body, {
    success: true,
    code: "ALERTS_MARKED_READ",
    markedReadCount: 2,
    cutoffAt: "2026-08-03T12:00:00.000Z",
  });
});

test("non-owned mark-read returns the privacy-safe not-found contract", async () => {
  const calls = [];
  const query = async (text, params = []) => {
    const sql = normalizeSql(text);
    calls.push({ sql, params });
    if (sql.includes("SELECT id, email, role, token_version") && sql.includes("FROM users")) {
      return { rows: [{ id: params[0], email: "owner@example.test", role: "user", token_version: 0 }] };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.includes("FROM alerts") && sql.includes("FOR UPDATE")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const pool = {
    query,
    async connect() { return { query, release() {} }; },
  };

  const result = await invokeAppRoute({
    method: "post",
    path: "/alerts/:alertId/read",
    userId: 999,
    params: { alertId: "100" },
    query: {},
    body: {},
    pool,
  });

  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, {
    success: false,
    code: "ALERT_NOT_FOUND",
    message: "Alert was not found.",
  });
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE alerts")), false);
});

test("unexpected route failures use normalized public errors", async () => {
  const handlers = createAlertHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError({ res, code }) {
      return res.status(500).json({ error: code, message: "The alert operation could not be completed." });
    },
    service: {
      async getAlertCountsForRecipient() {
        throw new Error("private SQL and recipient detail");
      },
    },
  });
  const res = response();
  await handlers.getCounts({ user: { id: 7 }, query: {} }, res);
  assert.deepEqual(res.body, {
    error: "ALERT_COUNTS_FETCH_FAILED",
    message: "The alert operation could not be completed.",
  });
  assert.doesNotMatch(JSON.stringify(res.body), /private|SQL|recipient detail/i);
});
