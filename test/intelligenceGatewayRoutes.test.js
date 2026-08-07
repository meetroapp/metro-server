"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-intelligence-routes";

const {
  app,
  createCorsOptions,
  createToken,
} = require("../index");
const {
  createIntelligenceEngineRegistry,
} = require("../server/intelligence/intelligenceEngineRegistry");
const {
  createIntelligenceOperationRegistry,
} = require("../server/intelligence/intelligenceOperationRegistry");
const {
  INTELLIGENCE_COMPANION_ROUTE,
  registerIntelligenceRoutes,
  setIntelligenceNoStore,
} = require("../server/intelligence/intelligenceRoutes");
const {
  createIntelligenceOperationRepositoryFake,
} = require("./helpers/intelligenceOperationFake");

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

function actualRoute() {
  return app.router.stack.find(
    (layer) => layer.route?.path === INTELLIGENCE_COMPANION_ROUTE &&
      layer.route.methods.post
  );
}

function createTestRuntime() {
  const repository = createIntelligenceOperationRepositoryFake();
  const providerCalls = [];
  return {
    repository,
    providerCalls,
    operationRegistry: createIntelligenceOperationRegistry([{
      operation: "test.echo",
      capability: "test.echo",
      supportedRoles: ["homeowner"],
      engineIds: ["test_context"],
      providerName: "fixture",
      buildContext: ({ context }) => ({ topic: context.topic || null }),
      buildProviderRequest: ({ semanticInput, engineContext }) => ({
        operation: "test.echo",
        message: semanticInput.input.message,
        context: semanticInput.context,
        engineContext,
      }),
      parseResult: ({ answer }) => ({ answer }),
    }]),
    engineRegistry: createIntelligenceEngineRegistry([{
      id: "test_context",
      async collectContext() {
        return { routeCertified: true };
      },
    }]),
    providers: {
      fixture: {
        async complete(request) {
          providerCalls.push(request);
          return { answer: "route result" };
        },
      },
    },
  };
}

test("canonical companion route is mounted once with no-store before authentication", () => {
  const matches = app.router.stack.filter(
    (layer) => layer.route?.path === INTELLIGENCE_COMPANION_ROUTE &&
      layer.route.methods.post
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0].route.stack.length, 3);
  assert.equal(matches[0].route.stack[0].handle, setIntelligenceNoStore);
  assert.ok(createCorsOptions().allowedHeaders.includes("Idempotency-Key"));
});

test("actual route rejects unauthenticated requests before database access", async () => {
  const route = actualRoute();
  const calls = [];
  const req = {
    app: { locals: { pool: { query() { calls.push("query"); } } } },
    headers: { "idempotency-key": randomUUID() },
    body: {
      operation: "test.echo",
      capability: "test.echo",
      locale: "en",
      context: {},
      input: {},
    },
  };
  const res = response();

  await runHandlers(route.route.stack.map(({ handle }) => handle), req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "AUTHENTICATION_REQUIRED");
  assert.equal(res.getHeader("Cache-Control"), "no-store");
  assert.equal(calls.length, 0);
});

test("actual authenticated route derives actor from token truth and rejects unknown operations", async () => {
  const route = actualRoute();
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text: String(text), values });
      if (String(text).includes("FROM users")) {
        return {
          rows: [{
            id: values[0],
            email: "owner@example.test",
            role: "homeowner",
            token_version: 0,
          }],
        };
      }
      throw new Error("No Intelligence SQL should execute for an unknown operation.");
    },
  };
  const token = createToken({
    id: 73,
    email: "owner@example.test",
    role: "professional",
    token_version: 0,
  });
  const req = {
    app: { locals: { pool } },
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
    },
    body: {
      operation: "product.unknown",
      capability: "product.unknown",
      locale: "en",
      context: {},
      input: {},
    },
  };
  const res = response();

  await runHandlers(route.route.stack.map(({ handle }) => handle), req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "INTELLIGENCE_OPERATION_FORBIDDEN");
  assert.equal(req.user.id, 73);
  assert.equal(req.user.role, "homeowner");
  assert.equal(calls.length, 1);
});

test("registered route reaches the real Gateway, durable service, and one provider", async () => {
  const runtime = createTestRuntime();
  const registrations = [];
  const fakeApp = {
    post(path, ...handlers) {
      registrations.push({ path, handlers });
    },
  };
  const authMiddleware = (req, _res, next) => {
    req.user = { id: 73, role: "homeowner" };
    next();
  };
  registerIntelligenceRoutes({
    app: fakeApp,
    authMiddleware,
    getPool: () => ({ name: "repository-fake" }),
    operationRegistry: runtime.operationRegistry,
    engineRegistry: runtime.engineRegistry,
    providers: runtime.providers,
    repository: runtime.repository,
  });
  const idempotencyKey = randomUUID();
  const request = (input = { message: "hello" }) => ({
    headers: { "idempotency-key": idempotencyKey },
    body: {
      operation: "test.echo",
      capability: "test.echo",
      locale: "en",
      context: { topic: "route" },
      input,
    },
  });
  const invoke = async (req) => {
    const res = response();
    await runHandlers(registrations[0].handlers, req, res);
    return res;
  };

  const first = await invoke(request());
  const replay = await invoke(request());
  const conflict = await invoke(request({ message: "changed" }));
  const record = [...runtime.repository.records.values()][0];

  assert.equal(registrations[0].path, INTELLIGENCE_COMPANION_ROUTE);
  assert.equal(first.body.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(replay.body.code, "INTELLIGENCE_OPERATION_REPLAYED");
  assert.equal(conflict.body.code, "INTELLIGENCE_OPERATION_CONFLICT");
  assert.deepEqual(first.body.result, { answer: "route result" });
  assert.deepEqual(first.body.usage, {
    state: "not_configured",
    classification: "stub",
  });
  assert.equal(record.actor_user_id, 73);
  assert.equal(record.authority_scope, "user:73");
  assert.equal(runtime.providerCalls.length, 1);
});

test("route rejects browser actor fields and never lets injected dependencies override req.user", async () => {
  const runtime = createTestRuntime();
  const registrations = [];
  registerIntelligenceRoutes({
    app: { post(path, ...handlers) { registrations.push({ path, handlers }); } },
    authMiddleware(req, _res, next) {
      req.user = { id: 73, role: "homeowner" };
      next();
    },
    getPool: () => ({}),
    operationRegistry: runtime.operationRegistry,
    engineRegistry: runtime.engineRegistry,
    providers: runtime.providers,
    repository: runtime.repository,
    authenticatedActor: { id: 999, role: "homeowner" },
  });
  const req = {
    headers: { "idempotency-key": randomUUID() },
    body: {
      operation: "test.echo",
      capability: "test.echo",
      locale: "en",
      context: {},
      input: {},
      actor: { id: 999 },
    },
  };
  const res = response();

  await runHandlers(registrations[0].handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "INTELLIGENCE_REQUEST_FIELDS_UNSUPPORTED");
  assert.equal(runtime.repository.calls.length, 0);
  assert.equal(runtime.providerCalls.length, 0);
});
