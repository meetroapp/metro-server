"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-workflow-event-tests";

const {
  app,
  createToken,
  validateWorkflowEventPayload,
} = require("../index");

const repositoryRoot = path.join(__dirname, "..");
const indexSource = fs.readFileSync(path.join(repositoryRoot, "index.js"), "utf8");
const baselineSql = fs.readFileSync(
  path.join(repositoryRoot, "migrations", "202607050001_initial_schema_baseline.sql"),
  "utf8"
);

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function getRouteHandlers(method, routePath) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === routePath && item.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map((item) => item.handle);
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
  };
}

async function invokeRoute(method, routePath, { pool, body = {}, params = {}, token } = {}) {
  app.locals.pool = pool;
  const req = {
    app,
    body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    method: method.toUpperCase(),
    params,
  };
  const res = createResponse();

  try {
    for (const handler of getRouteHandlers(method, routePath)) {
      if (res.finished) break;
      if (handler.length >= 3) {
        await new Promise((resolve, reject) => {
          const originalJson = res.json.bind(res);
          res.json = (payload) => {
            const result = originalJson(payload);
            resolve();
            return result;
          };
          handler(req, res, (error) => (error ? reject(error) : resolve()));
        });
      } else {
        await handler(req, res);
      }
    }
    return { status: res.statusCode, body: res.body };
  } finally {
    delete app.locals.pool;
  }
}

function createPool({ events = [], insertError = null, selectError = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (sql.includes("SELECT id, email, role, token_version") && sql.includes("FROM users")) {
        return { rows: [{ id: values[0], email: "owner@example.test", role: "homeowner", token_version: 0 }] };
      }
      if (sql.includes("FROM quote_requests") && sql.includes("JOIN contractor_profiles")) {
        return { rows: [{ id: Number(values[0]), homeowner_id: Number(values[1]) }] };
      }
      if (sql.includes("SELECT workflow_events.")) {
        if (selectError) throw selectError;
        return { rows: events };
      }
      if (sql.includes("INSERT INTO workflow_events")) {
        if (insertError) throw insertError;
        return {
          rows: [{
            id: 902,
            quote_request_id: values[0],
            user_id: values[1],
            workflow_type: values[2],
            workflow_status: values[3],
            workflow_payload: JSON.parse(values[4]),
            event_label: values[5],
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function ownerToken() {
  return createToken({ id: 17, email: "owner@example.test", role: "homeowner" });
}

function workflowRouteSource() {
  return indexSource.slice(
    indexSource.indexOf("// Workflow persistence routes"),
    indexSource.indexOf('app.post("/reviews"')
  );
}

test("governed baseline owns the canonical workflow_events schema and index", () => {
  assert.match(baselineSql, /CREATE TABLE IF NOT EXISTS workflow_events/);
  assert.match(baselineSql, /id SERIAL PRIMARY KEY/);
  assert.match(baselineSql, /quote_request_id INTEGER NOT NULL REFERENCES quote_requests\(id\) ON DELETE CASCADE/);
  assert.match(baselineSql, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(baselineSql, /workflow_type TEXT NOT NULL/);
  assert.match(baselineSql, /workflow_payload JSONB DEFAULT '\{\}'::jsonb/);
  assert.match(baselineSql, /workflow_events_quote_request_id_created_at_idx/);
  assert.doesNotMatch(baselineSql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
});

test("workflow-event request handlers contain no runtime DDL or migration bootstrap", () => {
  const source = workflowRouteSource();
  assert.doesNotMatch(source, /CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|DROP\s+TABLE/i);
  assert.doesNotMatch(source, /runMigrations|schema_migrations|migration/i);
});

test("workflow-event payload validation allowlists canonical fields", () => {
  assert.equal(validateWorkflowEventPayload(null).valid, false);
  assert.equal(validateWorkflowEventPayload({ quote_request_id: 1, workflow_type: "" }).valid, false);
  assert.equal(validateWorkflowEventPayload({ quote_request_id: 1, workflow_type: "status", workflow_payload: [] }).valid, false);
  const result = validateWorkflowEventPayload({
    quote_request_id: "44",
    workflow_type: " update ",
    workflow_payload: { safe: true },
    user_id: 999,
    business_id: 888,
  });
  assert.deepEqual(result, {
    valid: true,
    value: {
      quoteRequestId: 44,
      workflowType: "update",
      workflowStatus: null,
      workflowPayload: { safe: true },
      eventLabel: null,
    },
  });
});

test("authenticated GET returns canonical events and confirmed empty results", async () => {
  for (const events of [[], [{ id: 901, workflow_type: "status" }]]) {
    const pool = createPool({ events });
    const result = await invokeRoute("get", "/workflow-events/:quoteRequestId", {
      pool,
      token: ownerToken(),
      params: { quoteRequestId: "44" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { workflow_events: events });
    assert.equal(
      pool.calls.some((call) => /CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+TABLE/i.test(call.sql)),
      false
    );
  }
});

test("authenticated POST writes only the authenticated owner's canonical event", async () => {
  const pool = createPool();
  const result = await invokeRoute("post", "/workflow-events", {
    pool,
    token: ownerToken(),
    body: {
      quote_request_id: 44,
      workflow_type: "status",
      workflow_status: "ready",
      workflow_payload: { step: 2 },
      event_label: "Ready",
      user_id: 999,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.workflow_event.user_id, 17);
  assert.equal(result.body.workflow_event.workflow_type, "status");
  assert.equal(
    pool.calls.some((call) => /CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+TABLE/i.test(call.sql)),
    false
  );
});

test("invalid POST is rejected before ownership lookup or insertion", async () => {
  const pool = createPool();
  const result = await invokeRoute("post", "/workflow-events", {
    pool,
    token: ownerToken(),
    body: { quote_request_id: 44, workflow_type: "status", workflow_payload: [] },
  });
  assert.equal(result.status, 400);
  assert.equal(pool.calls.some((call) => call.sql.includes("INSERT INTO workflow_events")), false);
});

test("missing schema fails truthfully without raw database details or an empty result", async () => {
  const databaseError = Object.assign(
    new Error('relation "workflow_events" does not exist at postgresql://secret'),
    { code: "42P01" }
  );
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);

  try {
    const getResult = await invokeRoute("get", "/workflow-events/:quoteRequestId", {
      pool: createPool({ selectError: databaseError }),
      token: ownerToken(),
      params: { quoteRequestId: "44" },
    });
    const postResult = await invokeRoute("post", "/workflow-events", {
      pool: createPool({ insertError: databaseError }),
      token: ownerToken(),
      body: { quote_request_id: 44, workflow_type: "status" },
    });

    for (const result of [getResult, postResult]) {
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, {
        error: "Workflow events are temporarily unavailable",
        code: "WORKFLOW_EVENTS_UNAVAILABLE",
      });
      assert.doesNotMatch(JSON.stringify(result.body), /relation|postgresql|secret/i);
    }
    assert.doesNotMatch(JSON.stringify(logs), /relation|postgresql|secret/i);
  } finally {
    console.error = originalConsoleError;
  }
});

test("other database failures return normalized errors and never claim success", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const getResult = await invokeRoute("get", "/workflow-events/:quoteRequestId", {
      pool: createPool({ selectError: Object.assign(new Error("private failure"), { code: "XX000" }) }),
      token: ownerToken(),
      params: { quoteRequestId: "44" },
    });
    const postResult = await invokeRoute("post", "/workflow-events", {
      pool: createPool({ insertError: Object.assign(new Error("private failure"), { code: "XX000" }) }),
      token: ownerToken(),
      body: { quote_request_id: 44, workflow_type: "status" },
    });
    assert.deepEqual(getResult, {
      status: 500,
      body: { error: "Failed to fetch workflow events", code: "WORKFLOW_EVENTS_FETCH_FAILED" },
    });
    assert.deepEqual(postResult, {
      status: 500,
      body: { error: "Failed to save workflow events", code: "WORKFLOW_EVENTS_SAVE_FAILED" },
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("workflow-event routes remain authentication protected", async () => {
  const pool = createPool();
  const getResult = await invokeRoute("get", "/workflow-events/:quoteRequestId", {
    pool,
    params: { quoteRequestId: "44" },
  });
  const postResult = await invokeRoute("post", "/workflow-events", {
    pool,
    body: { quote_request_id: 44, workflow_type: "status" },
  });
  assert.equal(getResult.status, 401);
  assert.equal(postResult.status, 401);
  assert.equal(pool.calls.length, 0);
});
