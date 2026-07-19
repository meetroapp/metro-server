"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-security-tests";

const {
  authMiddleware,
  buildHealthMetadata,
  buildUserPostByIdQuery,
  buildUserPostsQuery,
  createCorsOptions,
  getApprovedCorsOrigins,
  jsonSyntaxErrorHandler,
  toSafePostRow,
  validateLoginRequestBody,
} = require("../index");

function createMockResponse() {
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

function resolveCorsOrigin(options, origin) {
  return new Promise((resolve) => {
    options.origin(origin, (error, allowed) => {
      resolve({ error, allowed });
    });
  });
}

test("GET /posts uses authenticated route inventory and rejects missing tokens", async () => {
  const response = createMockResponse();
  let nextCalled = false;

  await authMiddleware({ headers: {} }, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    success: false,
    code: "AUTHENTICATION_REQUIRED",
    message: "Authentication required.",
  });
  assert.equal(nextCalled, false);
});

test("post list query is scoped to the authenticated user", () => {
  const query = buildUserPostsQuery(101);

  assert.match(query.text, /FROM posts/);
  assert.match(query.text, /WHERE user_id = \$1/);
  assert.doesNotMatch(query.text, /JOIN users/i);
  assert.deepEqual(query.values, [101]);
});

test("single post query rejects cross-user access by requiring owner scope", () => {
  const query = buildUserPostByIdQuery("202", 101);

  assert.match(query.text, /WHERE id = \$1 AND user_id = \$2/);
  assert.doesNotMatch(query.text, /JOIN users/i);
  assert.deepEqual(query.values, ["202", 101]);
});

test("safe post serialization removes owner identity fields", () => {
  const post = toSafePostRow({
    id: 201,
    user_id: 999,
    title: "Private request",
    description: "Needs help",
    location: "Fort Myers",
    category: "handyman",
    created_at: "2026-07-04T12:00:00.000Z",
    mage_url: null,
    image_url: "https://example.test/request.jpg",
    email: "other@example.test",
    username: "Other User",
  });

  assert.deepEqual(post, {
    id: 201,
    title: "Private request",
    description: "Needs help",
    location: "Fort Myers",
    category: "handyman",
    created_at: "2026-07-04T12:00:00.000Z",
    mage_url: null,
    image_url: "https://example.test/request.jpg",
    request_photos: [],
  });
  assert.equal(Object.hasOwn(post, "user_id"), false);
  assert.equal(Object.hasOwn(post, "email"), false);
  assert.equal(Object.hasOwn(post, "username"), false);
});

test("login request validation handles malformed bodies safely", () => {
  assert.deepEqual(validateLoginRequestBody(undefined), {
    ok: false,
    status: 400,
    error: "Email and password are required",
  });
  assert.deepEqual(validateLoginRequestBody({ password: "secret" }), {
    ok: false,
    status: 400,
    error: "Email and password are required",
  });
  assert.deepEqual(validateLoginRequestBody({ email: "person@example.test" }), {
    ok: false,
    status: 400,
    error: "Email and password are required",
  });
  assert.deepEqual(
    validateLoginRequestBody({
      email: " Person@Example.Test ",
      password: "secret",
    }),
    {
      ok: true,
      email: "person@example.test",
      password: "secret",
    }
  );
});

test("invalid JSON handler returns safe 400 response without implementation details", () => {
  const response = createMockResponse();
  let nextCalled = false;
  const syntaxError = new SyntaxError("Unexpected end of JSON input");
  syntaxError.body = "{";

  jsonSyntaxErrorHandler(syntaxError, {}, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: "Invalid JSON body" });
  assert.equal(nextCalled, false);
  assert.equal(Object.hasOwn(response.body, "details"), false);
});

test("production CORS allows only approved origins and never wildcard origins", async () => {
  const options = createCorsOptions({
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://getmeetro.com,https://app.getmeetro.com",
  });

  const approved = await resolveCorsOrigin(options, "https://getmeetro.com");
  const rejected = await resolveCorsOrigin(options, "https://evil.example");

  assert.equal(approved.allowed, true);
  assert.equal(rejected.allowed, undefined);
  assert.match(rejected.error.message, /Origin not allowed/);

  const origins = getApprovedCorsOrigins({
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://getmeetro.com,*",
  });

  assert.equal(origins.has("*"), false);
});

test("development CORS keeps localhost origins without production wildcard behavior", () => {
  const origins = getApprovedCorsOrigins({
    NODE_ENV: "development",
  });

  assert.equal(origins.has("http://localhost:5173"), true);
  assert.equal(origins.has("*"), false);
});

test("health metadata exposes only safe operational fields", () => {
  const metadata = buildHealthMetadata({
    NODE_ENV: "staging",
    RAILWAY_GIT_COMMIT_SHA: "abc123",
    DATABASE_URL: "postgresql://secret.example/database",
    JWT_SECRET: "secret",
  });

  assert.deepEqual(Object.keys(metadata).sort(), [
    "commit",
    "environment",
    "status",
    "uptimeSeconds",
    "version",
  ]);
  assert.equal(metadata.status, "ok");
  assert.equal(metadata.environment, "staging");
  assert.equal(metadata.commit, "abc123");
  assert.equal(typeof metadata.version, "string");
  assert.equal(typeof metadata.uptimeSeconds, "number");
  assert.equal(JSON.stringify(metadata).includes("postgresql://"), false);
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
});
