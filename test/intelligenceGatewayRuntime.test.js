"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  executeIntelligenceGateway,
} = require("../server/intelligence/intelligenceGateway");
const {
  canonicalIntelligenceEngineRegistry,
  createIntelligenceEngineRegistry,
} = require("../server/intelligence/intelligenceEngineRegistry");
const {
  canonicalIntelligenceOperationRegistry,
  createIntelligenceOperationRegistry,
} = require("../server/intelligence/intelligenceOperationRegistry");
const {
  createIntelligenceOperationRepositoryFake,
} = require("./helpers/intelligenceOperationFake");

const BASE_BODY = Object.freeze({
  operation: "test.echo",
  capability: "test.echo",
  locale: "en-US",
  context: { topic: "fixture" },
  input: { message: "hello" },
});

function createFixture({ providerComplete, parseResult, buildContext } = {}) {
  const providerRequests = [];
  const engineCalls = [];
  const repository = createIntelligenceOperationRepositoryFake();
  const operationRegistry = createIntelligenceOperationRegistry([{
    operation: "test.echo",
    capability: "test.echo",
    supportedRoles: ["homeowner"],
    engineIds: ["test_context"],
    providerName: "fixture",
    buildContext: buildContext || (({ context }) => ({ topic: context.topic || null })),
    buildProviderRequest: ({ semanticInput, engineContext }) => ({
      operation: "test.echo",
      message: semanticInput.input.message,
      context: semanticInput.context,
      engineContext,
    }),
    parseResult: parseResult || ((result) => ({ answer: result.answer })),
  }]);
  const engineRegistry = createIntelligenceEngineRegistry([{
    id: "test_context",
    async collectContext({ operation }) {
      engineCalls.push(operation);
      return { source: "server-selected" };
    },
  }]);
  const providers = {
    fixture: {
      name: "fixture",
      async complete(request) {
        providerRequests.push(request);
        return providerComplete
          ? providerComplete(request)
          : { answer: "bounded fixture result" };
      },
    },
  };

  return {
    engineCalls,
    engineRegistry,
    operationRegistry,
    providerRequests,
    providers,
    repository,
    run(overrides = {}) {
      return executeIntelligenceGateway({
        pool: { name: "repository-fake" },
        authenticatedActor: { id: 41, role: "homeowner" },
        idempotencyKey: randomUUID(),
        body: BASE_BODY,
        operationRegistry,
        engineRegistry,
        providers,
        repository,
        ...overrides,
      });
    },
  };
}

test("production registry ships only the bounded Job Request interpretation operation", () => {
  assert.deepEqual(canonicalIntelligenceOperationRegistry.list(), [{
    operation: "job_request.interpret",
    capability: "job_request.interpret",
    supportedRoles: ["homeowner"],
    engineIds: ["job_request_capability", "job_request_validation"],
    providerName: "job_request",
  }]);
  assert.deepEqual(canonicalIntelligenceEngineRegistry.list(), [
    "job_request_capability",
    "job_request_validation",
  ]);
  assert.equal(canonicalIntelligenceOperationRegistry.get("test.echo"), null);
  assert.ok(canonicalIntelligenceOperationRegistry.get("job_request.interpret"));
});

test("operation registration requires explicit server-owned provider packaging", () => {
  assert.throws(
    () => createIntelligenceOperationRegistry([{
      operation: "test.echo",
      capability: "test.echo",
      supportedRoles: ["homeowner"],
      engineIds: [],
      buildContext: () => ({}),
      parseResult: (result) => result,
    }]),
    /missing_provider_request_builder/
  );
});

test("unknown operations and unauthorized capabilities fail before durable or provider work", async () => {
  const fixture = createFixture();
  const unknown = await executeIntelligenceGateway({
    pool: {},
    authenticatedActor: { id: 41, role: "homeowner" },
    idempotencyKey: randomUUID(),
    body: { ...BASE_BODY, operation: "product.unknown" },
    providers: fixture.providers,
    repository: fixture.repository,
  });
  const wrongCapability = await fixture.run({
    body: { ...BASE_BODY, capability: "test.other" },
  });
  const wrongRole = await fixture.run({
    authenticatedActor: { id: 41, role: "professional" },
  });

  assert.equal(unknown.code, "INTELLIGENCE_OPERATION_FORBIDDEN");
  assert.equal(wrongCapability.code, "INTELLIGENCE_CAPABILITY_FORBIDDEN");
  assert.equal(wrongRole.code, "INTELLIGENCE_CAPABILITY_FORBIDDEN");
  assert.equal(fixture.providerRequests.length, 0);
  assert.equal(fixture.repository.calls.length, 0);
});

test("request shape, identity, engine, provider, model, and usage spoofing fail closed", async () => {
  const fixture = createFixture();
  const cases = [
    { ...BASE_BODY, actor: { id: 999 } },
    { ...BASE_BODY, idempotencyKey: randomUUID() },
    { ...BASE_BODY, input: { message: "hello", provider: "attacker" } },
    { ...BASE_BODY, context: { topic: "fixture", engineIds: ["attacker"] } },
    { ...BASE_BODY, input: { message: "hello", model: "caller-selected" } },
    { ...BASE_BODY, input: { message: "hello", usageState: "finalized" } },
    { ...BASE_BODY, context: { userId: 999 } },
  ];

  for (const body of cases) {
    const result = await fixture.run({ body });
    assert.equal(result.ok, false);
  }
  assert.equal(fixture.providerRequests.length, 0);
  assert.equal(fixture.repository.calls.length, 0);
});

test("bounded context rejects accessors and oversized caller text before reservation", async () => {
  const fixture = createFixture();
  const accessorContext = {};
  Object.defineProperty(accessorContext, "topic", {
    enumerable: true,
    get() { throw new Error("must not execute"); },
  });

  const accessor = await fixture.run({
    body: { ...BASE_BODY, context: accessorContext },
  });
  const oversized = await fixture.run({
    body: { ...BASE_BODY, input: { message: "x".repeat(9000) } },
  });

  assert.equal(accessor.code, "INTELLIGENCE_CONTEXT_INVALID");
  assert.equal(oversized.code, "INTELLIGENCE_CONTEXT_INVALID");
  assert.equal(fixture.repository.calls.length, 0);
});

test("top-level accessors and prototype-control keys are rejected without execution", async () => {
  const fixture = createFixture();
  const accessorBody = { ...BASE_BODY };
  Object.defineProperty(accessorBody, "operation", {
    enumerable: true,
    get() { throw new Error("must not execute"); },
  });
  const pollutedInput = JSON.parse(
    '{"message":"hello","__proto__":{"polluted":true}}'
  );

  const accessor = await fixture.run({ body: accessorBody });
  const polluted = await fixture.run({
    body: { ...BASE_BODY, input: pollutedInput },
  });

  assert.equal(accessor.code, "INTELLIGENCE_REQUEST_INVALID");
  assert.equal(polluted.code, "INTELLIGENCE_CONTEXT_INVALID");
  assert.equal({}.polluted, undefined);
  assert.equal(fixture.repository.calls.length, 0);
  assert.equal(fixture.providerRequests.length, 0);
});

test("authorized execution selects server engines, invokes one provider, and returns truthful usage", async () => {
  const fixture = createFixture();
  const diagnostics = [];
  const result = await fixture.run({
    onDiagnostics: (value) => diagnostics.push(value),
  });

  assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.deepEqual(result.result, { answer: "bounded fixture result" });
  assert.deepEqual(result.usage, { state: "not_configured", classification: "stub" });
  assert.equal(fixture.providerRequests.length, 1);
  assert.deepEqual(fixture.engineCalls, ["test.echo"]);
  assert.deepEqual(
    fixture.providerRequests[0].engineContext,
    { test_context: { source: "server-selected" } }
  );
  assert.equal(Object.hasOwn(fixture.providerRequests[0], "authenticatedActor"), false);
  assert.deepEqual(diagnostics, [{
    providerExecutionCount: 1,
    selectedEngines: ["test_context"],
  }]);
});

test("Gateway replay and conflict preserve exactly one provider invocation", async () => {
  const fixture = createFixture();
  const idempotencyKey = randomUUID();
  const first = await fixture.run({ idempotencyKey });
  const replay = await fixture.run({ idempotencyKey });
  const conflict = await fixture.run({
    idempotencyKey,
    body: { ...BASE_BODY, input: { message: "changed" } },
  });

  assert.equal(first.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(replay.code, "INTELLIGENCE_OPERATION_REPLAYED");
  assert.equal(conflict.code, "INTELLIGENCE_OPERATION_CONFLICT");
  assert.equal(replay.operationId, first.operationId);
  assert.deepEqual(replay.result, first.result);
  assert.deepEqual(replay.usage, first.usage);
  assert.equal(fixture.providerRequests.length, 1);
});

test("concurrent Gateway duplicates establish one provider execution owner", async () => {
  let releaseProvider;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseProvider = resolve; });
  const fixture = createFixture({
    async providerComplete() {
      markStarted();
      await gate;
      return { answer: "concurrent result" };
    },
  });
  const idempotencyKey = randomUUID();

  const owner = fixture.run({ idempotencyKey });
  await started;
  const duplicate = await fixture.run({ idempotencyKey });
  releaseProvider();
  const completed = await owner;

  assert.equal(duplicate.code, "INTELLIGENCE_OPERATION_IN_PROGRESS");
  assert.equal(completed.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(fixture.providerRequests.length, 1);
});

test("provider failures and unsafe normalized results do not leak or become success", async () => {
  const failing = createFixture({
    providerComplete() {
      throw new Error("private provider detail");
    },
  });
  const unsafe = createFixture({
    providerComplete() {
      return {
        answer: "unsafe",
        rawProviderResponse: { secret: "private transport" },
      };
    },
    parseResult: (result) => result,
  });

  const failed = await failing.run();
  const rejected = await unsafe.run();

  assert.equal(failed.code, "INTELLIGENCE_PROVIDER_FAILURE");
  assert.equal(JSON.stringify(failed).includes("private provider detail"), false);
  assert.equal(rejected.code, "INTELLIGENCE_RESULT_REJECTED");
  assert.equal(JSON.stringify(rejected).includes("private transport"), false);
  assert.equal(failing.providerRequests.length, 1);
  assert.equal(unsafe.providerRequests.length, 1);
});

test("canonical runtime has no direct product-domain imports", () => {
  const intelligenceDirectory = join(__dirname, "..", "server", "intelligence");
  const runtimeFiles = [
    "intelligenceGateway.js",
    "intelligenceOrchestrator.js",
    "intelligenceContextBuilder.js",
    "intelligenceEngineRegistry.js",
    "intelligenceOperationRegistry.js",
    "intelligenceProviderAdapter.js",
    "intelligenceRoutes.js",
  ];
  const source = runtimeFiles
    .map((name) => readFileSync(join(intelligenceDirectory, name), "utf8"))
    .join("\n");

  assert.doesNotMatch(
    source,
    /require\([^)]*(requests|relationships|conversations|evaluations|quotes|invoices|payments|workflow|projects)/i
  );
  assert.doesNotMatch(source, /test\.echo|ask_meetro/);
});
