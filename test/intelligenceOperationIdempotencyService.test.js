"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  createSemanticFingerprint,
  executeIdempotentIntelligenceOperation,
} = require("../server/intelligence/intelligenceOperationIdempotencyService");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createRepositoryDouble({ failAt = "" } = {}) {
  const records = new Map();
  const calls = [];
  const scopedKey = ({ actorUserId, authorityScope, operation, idempotencyKey }) =>
    [actorUserId, authorityScope, operation, idempotencyKey].join("|");

  function maybeFail(name) {
    if (failAt === name) throw new Error("private database detail");
  }

  return {
    calls,
    records,
    async reserveIntelligenceOperation(input) {
      calls.push({ name: "reserve", input: clone(input) });
      maybeFail("reserve");
      const key = scopedKey(input);
      if (records.has(key)) {
        return { created: false, record: clone(records.get(key)) };
      }
      const record = {
        id: input.operationId,
        actor_user_id: input.actorUserId,
        authority_scope: input.authorityScope,
        operation: input.operation,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
        status: "executing",
        provider_execution_state: "started",
        result_classification: null,
        result_payload: null,
        error_classification: null,
        usage_state: "pending",
        usage_classification: null,
        correlation_id: input.correlationId,
        started_at: new Date().toISOString(),
      };
      records.set(key, record);
      return { created: true, record: clone(record) };
    },
    async recordProviderSuccess(input) {
      calls.push({ name: "provider_success", input: clone(input) });
      maybeFail("provider_success");
      const record = [...records.values()].find(({ id }) => id === input.operationId);
      record.provider_execution_state = "succeeded";
      record.result_classification = input.resultClassification;
      record.result_payload = clone(input.resultPayload);
      return clone(record);
    },
    async claimUsageFinalization(input) {
      calls.push({ name: "usage_claim", input: clone(input) });
      maybeFail("usage_claim");
      const record = [...records.values()].find(({ id }) => id === input.operationId);
      record.usage_state = "finalizing";
      return clone(record);
    },
    async completeIntelligenceOperation(input) {
      calls.push({ name: "complete", input: clone(input) });
      maybeFail("complete");
      const record = [...records.values()].find(({ id }) => id === input.operationId);
      assert.equal(record.usage_state, input.expectedUsageState);
      record.status = "completed";
      record.usage_state = input.usageState;
      record.usage_classification = input.usageClassification;
      record.completed_at = new Date().toISOString();
      return clone(record);
    },
    async failIntelligenceOperation(input) {
      calls.push({ name: "fail", input: clone(input) });
      maybeFail("fail");
      const record = [...records.values()].find(({ id }) => id === input.operationId);
      if (!record || record.status !== "executing") return null;
      record.status = "failed";
      record.provider_execution_state = input.providerExecutionState;
      record.usage_state = input.usageState;
      record.error_classification = input.errorClassification;
      if (input.resultPayload) {
        record.result_classification = input.resultClassification;
        record.result_payload = clone(input.resultPayload);
      }
      record.failed_at = new Date().toISOString();
      return clone(record);
    },
  };
}

function execute(repository, overrides = {}) {
  return executeIdempotentIntelligenceOperation({
    pool: { name: "repository-double" },
    authenticatedActor: { id: 41, role: "homeowner" },
    operation: "intelligence.test_operation",
    idempotencyKey: overrides.idempotencyKey || randomUUID(),
    semanticInput: { locale: "en", prompt: "Describe the work" },
    executeProvider: async () => ({ answer: "Normalized result" }),
    repository,
    ...overrides,
  });
}

test("semantic fingerprints are property-order stable and content sensitive", () => {
  const first = createSemanticFingerprint({
    operation: "intelligence.test_operation",
    semanticInput: { nested: { b: 2, a: 1 }, locale: "en" },
  });
  const reordered = createSemanticFingerprint({
    operation: "intelligence.test_operation",
    semanticInput: { locale: "en", nested: { a: 1, b: 2 } },
  });
  const changed = createSemanticFingerprint({
    operation: "intelligence.test_operation",
    semanticInput: { locale: "es", nested: { a: 1, b: 2 } },
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("fingerprints exclude auth, identity, correlation, idempotency, and server-time metadata", () => {
  const first = createSemanticFingerprint({
    operation: "intelligence.test_operation",
    semanticInput: {
      prompt: "Describe the work",
      authorization: "Bearer first",
      userId: 1,
      accountId: "first",
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      serverTimestamp: "2026-08-07T10:00:00Z",
    },
  });
  const second = createSemanticFingerprint({
    operation: "intelligence.test_operation",
    semanticInput: {
      prompt: "Describe the work",
      authorization: "Bearer second",
      userId: 999,
      accountId: "second",
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      serverTimestamp: "2026-08-07T11:00:00Z",
    },
  });

  assert.equal(first, second);
});

test("completed retries replay without a second provider call or usage finalization", async () => {
  const repository = createRepositoryDouble();
  const idempotencyKey = randomUUID();
  let providerCalls = 0;
  let usageCalls = 0;
  const options = {
    idempotencyKey,
    executeProvider: async () => {
      providerCalls += 1;
      return { answer: "Stable result" };
    },
    finalizeUsage: async ({ operationId }) => {
      usageCalls += 1;
      assert.match(operationId, /^[0-9a-f-]{36}$/i);
      return { ok: true, classification: "recorded" };
    },
  };

  const first = await execute(repository, options);
  const replay = await execute(repository, options);

  assert.equal(first.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(replay.code, "INTELLIGENCE_OPERATION_REPLAYED");
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.operationId, first.operationId);
  assert.deepEqual(first.usage, {
    state: "finalized",
    classification: "recorded",
  });
  assert.deepEqual(replay.usage, first.usage);
  assert.equal(providerCalls, 1);
  assert.equal(usageCalls, 1);
});

test("same scoped key with different semantic input conflicts before execution", async () => {
  const repository = createRepositoryDouble();
  const idempotencyKey = randomUUID();
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return { answer: "Result" };
  };

  await execute(repository, { idempotencyKey, executeProvider: provider });
  const conflict = await execute(repository, {
    idempotencyKey,
    semanticInput: { locale: "en", prompt: "Materially changed" },
    executeProvider: provider,
  });

  assert.equal(conflict.code, "INTELLIGENCE_OPERATION_CONFLICT");
  assert.equal(providerCalls, 1);
});

test("concurrent duplicates establish one execution owner", async () => {
  const repository = createRepositoryDouble();
  const idempotencyKey = randomUUID();
  let providerCalls = 0;
  let releaseProvider;
  let signalProviderStarted;
  const providerStarted = new Promise((resolve) => {
    signalProviderStarted = resolve;
  });
  const providerGate = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const provider = async () => {
    providerCalls += 1;
    signalProviderStarted();
    await providerGate;
    return { answer: "Concurrent result" };
  };

  const owner = execute(repository, { idempotencyKey, executeProvider: provider });
  await providerStarted;
  const duplicate = await execute(repository, { idempotencyKey, executeProvider: provider });
  releaseProvider();
  const completed = await owner;

  assert.equal(duplicate.code, "INTELLIGENCE_OPERATION_IN_PROGRESS");
  assert.equal(completed.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(providerCalls, 1);
});

test("provider failure is durable, not chargeable, and closed under the same key", async () => {
  const repository = createRepositoryDouble();
  const idempotencyKey = randomUUID();
  let providerCalls = 0;
  let usageCalls = 0;
  const options = {
    idempotencyKey,
    executeProvider: async () => {
      providerCalls += 1;
      throw Object.assign(new Error("private provider detail"), {
        code: "provider_failure",
      });
    },
    finalizeUsage: async () => {
      usageCalls += 1;
      return { ok: true };
    },
  };

  const failed = await execute(repository, options);
  const replay = await execute(repository, options);
  const record = [...repository.records.values()][0];

  assert.equal(failed.code, "INTELLIGENCE_PROVIDER_FAILURE");
  assert.equal(replay.code, "INTELLIGENCE_OPERATION_FAILED_REPLAY");
  assert.deepEqual(failed.usage, {
    state: "not_chargeable",
    classification: null,
  });
  assert.deepEqual(replay.usage, failed.usage);
  assert.equal(record.status, "failed");
  assert.equal(record.provider_execution_state, "failed");
  assert.equal(record.usage_state, "not_chargeable");
  assert.equal(record.result_payload, null);
  assert.equal(providerCalls, 1);
  assert.equal(usageCalls, 0);
  assert.equal(JSON.stringify(failed).includes("private provider detail"), false);
});

test("usage finalization is claimed once and a failure never becomes success", async () => {
  const repository = createRepositoryDouble();
  const idempotencyKey = randomUUID();
  let providerCalls = 0;
  let usageCalls = 0;
  const options = {
    idempotencyKey,
    executeProvider: async () => {
      providerCalls += 1;
      return { answer: "Provider succeeded" };
    },
    finalizeUsage: async () => {
      usageCalls += 1;
      return { ok: false };
    },
  };

  const failed = await execute(repository, options);
  const replay = await execute(repository, options);
  const record = [...repository.records.values()][0];

  assert.equal(failed.code, "INTELLIGENCE_USAGE_FAILURE");
  assert.equal(replay.code, "INTELLIGENCE_OPERATION_FAILED_REPLAY");
  assert.deepEqual(failed.usage, {
    state: "failed",
    classification: null,
  });
  assert.deepEqual(replay.usage, failed.usage);
  assert.equal(record.status, "failed");
  assert.equal(record.provider_execution_state, "succeeded");
  assert.equal(record.usage_state, "failed");
  assert.equal(providerCalls, 1);
  assert.equal(usageCalls, 1);
});

test("server owns identity and lifecycle while raw credentials are never persisted", async () => {
  const repository = createRepositoryDouble();
  let receivedSemanticInput;
  const result = await execute(repository, {
    authenticatedActor: { id: 73, role: "homeowner" },
    semanticInput: {
      userId: 999,
      accountId: "forged-account",
      status: "completed",
      usageState: "finalized",
      authorization: "Bearer must-not-persist",
    },
    executeProvider: async ({ semanticInput }) => {
      receivedSemanticInput = semanticInput;
      return { answer: "Safe normalized result" };
    },
  });
  const record = [...repository.records.values()][0];
  const persisted = JSON.stringify(record);

  assert.equal(result.ok, true);
  assert.equal(record.actor_user_id, 73);
  assert.equal(record.authority_scope, "user:73");
  assert.equal(record.status, "completed");
  assert.equal(record.usage_state, "not_configured");
  assert.equal(persisted.includes("forged-account"), false);
  assert.equal(persisted.includes("must-not-persist"), false);
  assert.equal(Object.hasOwn(receivedSemanticInput, "userId"), false);
  assert.equal(Object.hasOwn(receivedSemanticInput, "accountId"), false);
  assert.equal(Object.hasOwn(receivedSemanticInput, "authorization"), false);
});

test("privacy-unsafe or oversized results fail closed without usage finalization", async () => {
  for (const providerResult of [
    { answer: "unsafe", authorization: "Bearer secret" },
    { answer: "x".repeat(70000) },
  ]) {
    const repository = createRepositoryDouble();
    let usageCalls = 0;
    const result = await execute(repository, {
      executeProvider: async () => providerResult,
      finalizeUsage: async () => {
        usageCalls += 1;
        return { ok: true };
      },
    });
    const record = [...repository.records.values()][0];

    assert.equal(result.code, "INTELLIGENCE_RESULT_REJECTED");
    assert.equal(record.status, "failed");
    assert.equal(record.result_payload, null);
    assert.equal(record.usage_state, "not_chargeable");
    assert.equal(usageCalls, 0);
  }
});

test("invalid auth, operation, idempotency, and persistence failures are normalized", async () => {
  const repository = createRepositoryDouble();
  let providerCalls = 0;
  const executeProvider = async () => {
    providerCalls += 1;
    return { answer: "unused" };
  };

  const unauthenticated = await execute(repository, {
    authenticatedActor: { id: "browser-forged" },
    executeProvider,
  });
  const invalidOperation = await execute(repository, {
    operation: "job_request.interpret;DROP",
    executeProvider,
  });
  const invalidKey = await execute(repository, {
    idempotencyKey: "not-a-key",
    executeProvider,
  });
  const persistenceFailure = await execute(createRepositoryDouble({ failAt: "reserve" }), {
    executeProvider,
  });

  assert.equal(unauthenticated.code, "INTELLIGENCE_AUTHENTICATION_REQUIRED");
  assert.equal(invalidOperation.code, "INTELLIGENCE_OPERATION_INVALID");
  assert.equal(invalidKey.code, "INTELLIGENCE_IDEMPOTENCY_KEY_INVALID");
  assert.equal(persistenceFailure.code, "INTELLIGENCE_PERSISTENCE_FAILURE");
  assert.equal(providerCalls, 0);
});
