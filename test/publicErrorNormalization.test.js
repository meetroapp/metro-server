"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-public-error-tests";

const { app } = require("../index");
const {
  classifyPublicDatabaseError,
  isProductionRuntime,
  sendPublicDatabaseError,
} = require("../server/errors/publicErrors");

const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function getRouteHandler(method, routePath) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === routePath && item.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

async function invokeHandler(method, routePath, { pool, body = {}, params = {}, user } = {}) {
  app.locals.pool = pool;
  const response = createResponse();
  try {
    await getRouteHandler(method, routePath)({ app, body, params, user }, response);
    return response;
  } finally {
    delete app.locals.pool;
  }
}

test("production disables the public database diagnostic before any query runs", async () => {
  const priorEnvironment = process.env.NODE_ENV;
  let queryCalled = false;
  process.env.NODE_ENV = "production";

  try {
    const response = await invokeHandler("get", "/test-db", {
      pool: { query: async () => { queryCalled = true; } },
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, {
      error: "NOT_FOUND",
      message: "Resource not found.",
    });
    assert.equal(queryCalled, false);
  } finally {
    process.env.NODE_ENV = priorEnvironment;
  }
});

test("production detection honors explicit Railway production metadata", () => {
  assert.equal(isProductionRuntime({ NODE_ENV: "production" }), true);
  assert.equal(isProductionRuntime({ RAILWAY_ENVIRONMENT_NAME: "production" }), true);
  assert.equal(isProductionRuntime({ RAILWAY_ENVIRONMENT: "production" }), true);
  assert.equal(isProductionRuntime({ NODE_ENV: "test", RAILWAY_ENVIRONMENT_NAME: "staging" }), false);
});

test("test diagnostics are explicit and return safe status only", async () => {
  const response = await invokeHandler("get", "/test-db", {
    pool: { query: async () => ({ rows: [{ now: "private timestamp" }] }) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("diagnostic failures never expose database, SQL, schema, or connection details", async () => {
  const privateError = Object.assign(
    new Error('relation "users" does not exist after SELECT * FROM users at postgresql://db-user:password@private-host'),
    { code: "08006", stack: "private stack trace" }
  );
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logs.push(values);

  try {
    const response = await invokeHandler("get", "/test-db", {
      pool: { query: async () => { throw privateError; } },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: "DATABASE_UNAVAILABLE",
      message: "The service is temporarily unavailable.",
    });
    assert.doesNotMatch(JSON.stringify({ response: response.body, logs }), /users|select|postgresql|password|private-host|stack trace/i);
  } finally {
    console.error = originalConsoleError;
  }
});

test("database errors use stable safe conflict and availability categories", () => {
  assert.deepEqual(classifyPublicDatabaseError({ code: "23505" }, {}), {
    status: 409,
    code: "CONFLICT",
    message: "That value is already in use.",
  });
  assert.deepEqual(classifyPublicDatabaseError({ code: "57P03" }, {}), {
    status: 503,
    code: "DATABASE_UNAVAILABLE",
    message: "The service is temporarily unavailable.",
  });
});

test("product-route failures expose only the route public contract", async () => {
  const privateError = Object.assign(
    new Error('duplicate key violates unique constraint "reviews_unique"'),
    { code: "XX000", stack: "private stack" }
  );
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logs.push(values);

  try {
    const response = await invokeHandler("get", "/reviews/:contractorId", {
      params: { contractorId: "44" },
      pool: { query: async () => { throw privateError; } },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: "REVIEWS_FETCH_FAILED",
      message: "Reviews could not be loaded.",
    });
    assert.doesNotMatch(JSON.stringify({ response: response.body, logs }), /duplicate|constraint|reviews_unique|private stack/i);
  } finally {
    console.error = originalConsoleError;
  }
});

test("successful product responses remain backward compatible", async () => {
  let queryCount = 0;
  const response = await invokeHandler("get", "/reviews/:contractorId", {
    params: { contractorId: "44" },
    pool: {
      async query() {
        queryCount += 1;
        return queryCount === 1
          ? { rows: [{ id: 1, review_text: "Careful work" }] }
          : { rows: [{ average_rating: "5.0", total_reviews: "1" }] };
      },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    reviews: [{ id: 1, review_text: "Careful work" }],
    stats: { average_rating: "5.0", total_reviews: "1" },
  });
});

test("safe logging excludes credentials, headers, tokens, private payloads, and raw errors", () => {
  const logs = [];
  const response = createResponse();
  sendPublicDatabaseError({
    res: response,
    error: Object.assign(new Error("private failure"), {
      code: "XX000",
      authorization: "Bearer private-jwt",
      databaseUrl: "postgresql://private",
      resetToken: "private-reset-token",
      verificationCode: "123456",
    }),
    operation: "safe_logging_test",
    code: "INTERNAL_ERROR",
    message: "The request could not be completed.",
    logger: (...values) => logs.push(values),
  });

  const serialized = JSON.stringify(logs);
  assert.match(serialized, /safe_logging_test|INTERNAL_ERROR|XX000/);
  assert.doesNotMatch(serialized, /private|Bearer|postgresql|reset-token|123456/i);
});

test("server source contains no raw exception serialization or stack response", () => {
  assert.doesNotMatch(indexSource, /details\s*:\s*(?:err|error)\.message/);
  assert.doesNotMatch(indexSource, /(?:json|send)\s*\([^)]*(?:err|error)\.stack/);
  assert.doesNotMatch(indexSource, /(?:json|send)\s*\([^)]*(?:err|error)\.message/);
});
