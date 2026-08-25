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
      async complete(request, options) {
        providerRequests.push(request);
        return providerComplete
          ? providerComplete(request, options)
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

test("production registry ships only the governed core workflow advisory operations", () => {
  assert.deepEqual(canonicalIntelligenceOperationRegistry.list(), [
    {
      operation: "job_request.interpret",
      capability: "job_request.interpret",
      supportedRoles: ["homeowner", "professional"],
      engineIds: ["job_request_capability", "job_request_validation"],
      providerName: "job_request",
    },
    {
      operation: "quote.compose",
      capability: "quote.compose",
      supportedRoles: ["professional"],
      engineIds: ["quote_composition_advisory", "quote_composition_authority_boundary"],
      providerName: "quote_composition",
    },
    {
      operation: "quick_quote.photo_assist",
      capability: "quick_quote.photo_assist",
      supportedRoles: ["professional"],
      engineIds: ["quick_quote_photo_advisory_boundary"],
      providerName: "workflow_assistance",
    },
    {
      operation: "evaluation.assist",
      capability: "evaluation.assist",
      supportedRoles: ["professional"],
      engineIds: ["evaluation_advisory_boundary"],
      providerName: "workflow_assistance",
    },
    {
      operation: "estimate.compose",
      capability: "estimate.compose",
      supportedRoles: ["professional"],
      engineIds: ["estimate_advisory_boundary"],
      providerName: "workflow_assistance",
    },
    {
      operation: "invoice.assist",
      capability: "invoice.assist",
      supportedRoles: ["professional"],
      engineIds: ["invoice_advisory_boundary"],
      providerName: "workflow_assistance",
    },
  ]);
  assert.deepEqual(canonicalIntelligenceEngineRegistry.list(), [
    "estimate_advisory_boundary",
    "evaluation_advisory_boundary",
    "invoice_advisory_boundary",
    "job_request_capability",
    "job_request_validation",
    "quick_quote_photo_advisory_boundary",
    "quote_composition_advisory",
    "quote_composition_authority_boundary",
  ]);
  assert.equal(canonicalIntelligenceOperationRegistry.get("test.echo"), null);
  assert.ok(canonicalIntelligenceOperationRegistry.get("job_request.interpret"));
  assert.ok(canonicalIntelligenceOperationRegistry.get("quote.compose"));
  assert.ok(canonicalIntelligenceOperationRegistry.get("quick_quote.photo_assist"));
  assert.ok(canonicalIntelligenceOperationRegistry.get("evaluation.assist"));
  assert.ok(canonicalIntelligenceOperationRegistry.get("estimate.compose"));
  assert.ok(canonicalIntelligenceOperationRegistry.get("invoice.assist"));
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

test("operation registration keeps provider-request depth finite and server-owned", () => {
  const definition = {
    operation: "test.depth",
    capability: "test.depth",
    supportedRoles: ["homeowner"],
    engineIds: [],
    providerName: "fixture",
    providerRequestMaxDepth: 9,
    buildContext: () => ({}),
    buildProviderRequest: () => ({}),
    parseResult: (result) => result,
  };
  const registry = createIntelligenceOperationRegistry([definition]);

  assert.equal(registry.get("test.depth").providerRequestMaxDepth, 9);
  assert.equal(
    Object.hasOwn(registry.list()[0], "providerRequestMaxDepth"),
    false
  );
  for (const providerRequestMaxDepth of [0, 17, 8.5, "9"]) {
    assert.throws(
      () => createIntelligenceOperationRegistry([{
        ...definition,
        providerRequestMaxDepth,
      }]),
      /invalid_provider_request_max_depth/
    );
  }
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

test("provider timeout aborts the in-flight provider request and remains a governed failure", async () => {
  let providerSignal = null;

  const fixture = createFixture({
    providerComplete(_request, { signal } = {}) {
      providerSignal = signal;

      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true }
        );
      });
    },
  });

  const result = await fixture.run({
    providerTimeoutMs: 5,
  });

  assert.equal(
    result.code,
    "INTELLIGENCE_PROVIDER_TIMEOUT"
  );
  assert.equal(result.status, 504);
  assert.equal(providerSignal.aborted, true);
  assert.equal(fixture.providerRequests.length, 1);
});

test("parser rejection logs only a non-secret diagnostic fingerprint", async () => {
  const events = [];
  const fixture = createFixture({
    parseResult() {
      throw Object.assign(new Error("private provider result detail"), {
        code: "malformed_operation_result",
        diagnosticCode: "0123456789abcdef",
      });
    },
  });

  const result = await fixture.run({
    logger: {
      info() {},
      warn(event, metadata) { events.push({ event, metadata }); },
    },
  });

  assert.equal(result.code, "INTELLIGENCE_RESULT_REJECTED");
  const rejected = events.find((event) => event.event === "intelligence.orchestration.result_rejected");
  assert.deepEqual(rejected.metadata, {
    operation: "test.echo",
    operationId: result.operationId,
    diagnosticCode: "0123456789abcdef",
  });
  assert.equal(JSON.stringify(events).includes("private provider result detail"), false);
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
    /require\([^)]*(?:\/requests\/|\/relationships\/|\/conversations\/|\/evaluations\/|\/quotes\/|\/invoices\/|\/payments\/|\/workflow\/|\/projects\/)/i
  );
  assert.doesNotMatch(source, /test\.echo|ask_meetro/);
});

test("orchestrator forwards estimate parser diagnostics to orchestration rejection logs", async () => {
  const diagnostics = [];
  const providerMetadata = {
    providerRequestId: "req_route_gate_01",
    configuredModel: "gpt-5.4-mini",
  };
  const result = await createFixture({
    providerComplete() {
      return { answer: "unused", __providerMetadata: providerMetadata };
    },
    parseResult(_, { providerMetadata: receivedMetadata }) {
      const error = Object.assign(
        new Error("Estimate schema invalid for diagnostics capture."),
        {
          code: "malformed_operation_result",
          diagnosticCode: "0123456789abcdef",
          parserDiagnostics: {
            operation: "estimate.compose",
            schemaVersion: 1,
            parserStage: "payload_shape",
            validationBranch: "missing_fields",
            structuralFingerprint: "abc123",
            missingFields: ["disposal"],
            extraFields: ["unexpected"],
            rejectionClassification: "missing_required_fields",
            providerRequestId: receivedMetadata?.providerRequestId || null,
            configuredModel: receivedMetadata?.configuredModel || null,
            timestamp: new Date().toISOString(),
          },
        }
      );
      throw error;
    },
  }).run({
    logger: {
      warn(event, metadata) {
        diagnostics.push({ event, metadata });
      },
      info() {},
    },
  });

  assert.equal(result.code, "INTELLIGENCE_RESULT_REJECTED");
  const rejected = diagnostics.find((entry) => entry.event === "intelligence.orchestration.result_rejected");
  assert.equal(rejected?.metadata?.operation, "test.echo");
  assert.deepEqual(rejected?.metadata?.parserDiagnostics, {
    operation: "estimate.compose",
    schemaVersion: 1,
    parserStage: "payload_shape",
    validationBranch: "missing_fields",
    structuralFingerprint: "abc123",
    missingFields: ["disposal"],
    extraFields: ["unexpected"],
    rejectionClassification: "missing_required_fields",
    providerRequestId: providerMetadata.providerRequestId,
    configuredModel: providerMetadata.configuredModel,
    timestamp: typeof rejected?.metadata?.parserDiagnostics.timestamp === "string" ? rejected.metadata.parserDiagnostics.timestamp : undefined,
  });
});
