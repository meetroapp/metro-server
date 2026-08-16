"use strict";

const { createHash, randomUUID } = require("node:crypto");

const defaultRepository = require("./intelligenceOperationIdempotencyRepository");

const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_PATTERN =
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CLASSIFICATION_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/;
const MAX_OPERATION_LENGTH = 160;
const MAX_SEMANTIC_INPUT_BYTES = 65536;
const MAX_RESULT_BYTES = 65536;
const EXCLUDED_SEMANTIC_KEYS = new Set([
  "accesstoken",
  "accountid",
  "actoruserid",
  "apikey",
  "authorization",
  "businessid",
  "cookie",
  "correlationid",
  "constructor",
  "createdat",
  "idempotencykey",
  "password",
  "proto",
  "prototype",
  "refreshtoken",
  "requestid",
  "secret",
  "servertimestamp",
  "token",
  "updatedat",
  "userid",
]);
const PROHIBITED_RESULT_KEYS = new Set([
  "apikey",
  "authorization",
  "constructor",
  "cookie",
  "password",
  "proto",
  "prototype",
  "providertransport",
  "rawproviderresponse",
  "refreshtoken",
  "secret",
  "token",
]);

function response(ok, status, code, message, extra = {}) {
  return { ok, status, code, message, ...extra };
}

function normalizeActorId(authenticatedActor = {}) {
  const actorUserId = authenticatedActor?.id;
  return Number.isInteger(actorUserId) && actorUserId > 0
    ? actorUserId
    : null;
}

function normalizeOperation(value) {
  if (typeof value !== "string") return null;
  const operation = value.trim().toLowerCase();
  return operation.length <= MAX_OPERATION_LENGTH && OPERATION_PATTERN.test(operation)
    ? operation
    : null;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
}

function normalizeClassification(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return CLASSIFICATION_PATTERN.test(normalized) ? normalized : fallback;
}

function stableStringify(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Semantic input numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Semantic input cannot be cyclic.");
    seen.add(value);
    const serialized = `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Semantic input must contain only plain JSON objects.");
    }
    if (seen.has(value)) throw new TypeError("Semantic input cannot be cyclic.");
    seen.add(value);
    const serialized = `{${Object.keys(value).sort().map((key) => {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        throw new TypeError("Semantic input must be JSON serializable.");
      }
      return `${JSON.stringify(key)}:${stableStringify(item, seen)}`;
    }).join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  throw new TypeError("Semantic input must be JSON serializable.");
}

function normalizeSemanticInput(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Semantic input numbers must be finite.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Semantic input cannot be cyclic.");
    seen.add(value);
    const normalized = value.map((item) => normalizeSemanticInput(item, seen));
    seen.delete(value);
    return normalized;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Semantic input must contain only plain JSON objects.");
    }
    if (seen.has(value)) throw new TypeError("Semantic input cannot be cyclic.");
    seen.add(value);
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (EXCLUDED_SEMANTIC_KEYS.has(normalizedKey)) continue;
      normalized[key] = normalizeSemanticInput(value[key], seen);
    }
    seen.delete(value);
    return normalized;
  }
  throw new TypeError("Semantic input must be JSON serializable.");
}

function createSemanticFingerprint({ operation, semanticInput }) {
  const normalizedSemanticInput = normalizeSemanticInput(semanticInput);
  const serialized = stableStringify({ operation, semanticInput: normalizedSemanticInput });
  if (Buffer.byteLength(serialized, "utf8") > MAX_SEMANTIC_INPUT_BYTES) {
    throw Object.assign(new Error("Semantic operation input is too large."), {
      code: "invalid_input",
    });
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function assertResultPrivacy(value) {
  if (Array.isArray(value)) {
    value.forEach(assertResultPrivacy);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (PROHIBITED_RESULT_KEYS.has(normalizedKey)) {
      throw Object.assign(new Error("Normalized result contains prohibited metadata."), {
        code: "result_privacy_violation",
      });
    }
    assertResultPrivacy(item);
  }
}

function normalizeReplayResult(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw Object.assign(new Error("Normalized operation result must be an object."), {
      code: "malformed_operation_result",
    });
  }

  assertResultPrivacy(value);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw Object.assign(new Error("Normalized operation result must be JSON serializable."), {
      code: "malformed_operation_result",
    });
  }

  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
    throw Object.assign(new Error("Normalized operation result is too large."), {
      code: "malformed_operation_result",
    });
  }

  return JSON.parse(serialized);
}

function publicFailureForClassification(classification, extra = {}) {
  const known = {
    provider_failure: [502, "INTELLIGENCE_PROVIDER_FAILURE", "The Intelligence operation could not be completed."],
    provider_unavailable: [503, "INTELLIGENCE_PROVIDER_UNAVAILABLE", "The Intelligence provider is unavailable."],
    provider_timeout: [504, "INTELLIGENCE_PROVIDER_TIMEOUT", "The Intelligence provider timed out."],
    provider_authentication_failed: [503, "INTELLIGENCE_PROVIDER_AUTHENTICATION_FAILED", "The Intelligence provider authentication failed."],
    provider_quota_exhausted: [503, "INTELLIGENCE_PROVIDER_QUOTA_EXHAUSTED", "The Intelligence provider quota is unavailable."],
    provider_billing_required: [503, "INTELLIGENCE_PROVIDER_BILLING_REQUIRED", "The Intelligence provider billing configuration is unavailable."],
    provider_access_denied: [503, "INTELLIGENCE_PROVIDER_ACCESS_DENIED", "The Intelligence provider project access is unavailable."],
    provider_model_unavailable: [503, "INTELLIGENCE_PROVIDER_MODEL_UNAVAILABLE", "The configured Intelligence model is unavailable."],
    provider_rate_limited: [503, "INTELLIGENCE_PROVIDER_RATE_LIMITED", "The Intelligence provider is temporarily rate limited."],
    usage_finalization_failed: [503, "INTELLIGENCE_USAGE_FAILURE", "The Intelligence operation could not be finalized."],
    result_privacy_violation: [502, "INTELLIGENCE_RESULT_REJECTED", "The Intelligence operation returned an invalid result."],
    malformed_operation_result: [502, "INTELLIGENCE_RESULT_REJECTED", "The Intelligence operation returned an invalid result."],
    intelligence_context_invalid: [502, "INTELLIGENCE_RESULT_REJECTED", "The Intelligence operation returned an invalid result."],
    intelligence_context_prohibited: [502, "INTELLIGENCE_RESULT_REJECTED", "The Intelligence operation returned an invalid result."],
    required_engine_failure: [503, "INTELLIGENCE_ENGINE_UNAVAILABLE", "A required Intelligence engine is unavailable."],
  };
  const [status, code, message] = known[classification] || [503, "INTELLIGENCE_PERSISTENCE_FAILURE", "The Intelligence operation could not be persisted."];
  return response(false, status, code, message, extra);
}

function logMetadata(logger, level, event, metadata) {
  if (logger && typeof logger[level] === "function") {
    logger[level](event, metadata);
  }
}

function validateRepository(repository) {
  const methods = [
    "reserveIntelligenceOperation",
    "recordProviderSuccess",
    "claimUsageFinalization",
    "completeIntelligenceOperation",
    "failIntelligenceOperation",
  ];
  if (!repository || methods.some((name) => typeof repository[name] !== "function")) {
    throw new TypeError("A complete Intelligence idempotency repository is required.");
  }
}

async function executeIdempotentIntelligenceOperation({
  pool,
  authenticatedActor,
  operation: rawOperation,
  idempotencyKey: rawIdempotencyKey,
  semanticInput,
  executeProvider,
  finalizeUsage,
  repository = defaultRepository,
  logger = null,
} = {}) {
  validateRepository(repository);
  const actorUserId = normalizeActorId(authenticatedActor);
  const operation = normalizeOperation(rawOperation);
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);

  if (!actorUserId) {
    return response(false, 401, "INTELLIGENCE_AUTHENTICATION_REQUIRED", "Authentication required.");
  }
  if (!operation) {
    return response(false, 400, "INTELLIGENCE_OPERATION_INVALID", "A valid Intelligence operation is required.");
  }
  if (!idempotencyKey) {
    return response(false, 400, "INTELLIGENCE_IDEMPOTENCY_KEY_INVALID", "A valid idempotency key is required.");
  }
  if (typeof executeProvider !== "function") {
    throw new TypeError("An Intelligence execution callback is required.");
  }
  if (finalizeUsage !== undefined && typeof finalizeUsage !== "function") {
    throw new TypeError("Usage finalization must be a function when configured.");
  }

  let normalizedSemanticInput;
  let requestFingerprint;
  try {
    normalizedSemanticInput = normalizeSemanticInput(semanticInput);
    requestFingerprint = createSemanticFingerprint({
      operation,
      semanticInput: normalizedSemanticInput,
    });
  } catch {
    return response(false, 400, "INTELLIGENCE_INPUT_INVALID", "Valid semantic operation input is required.");
  }

  const authorityScope = `user:${actorUserId}`;
  const operationId = randomUUID();
  const correlationId = randomUUID();
  let reservation;

  try {
    reservation = await repository.reserveIntelligenceOperation({
      pool,
      operationId,
      actorUserId,
      authorityScope,
      operation,
      idempotencyKey,
      requestFingerprint,
      correlationId,
    });
  } catch {
    return publicFailureForClassification("persistence_failure");
  }

  const record = reservation.record;
  const publicIdentity = {
    operationId: record.id,
    correlationId: record.correlation_id,
    operation,
  };

  if (!reservation.created) {
    if (record.request_fingerprint !== requestFingerprint) {
      logMetadata(logger, "warn", "intelligence.idempotency.conflict", {
        operationId: record.id,
        operation,
        actorUserId,
      });
      return response(false, 409, "INTELLIGENCE_OPERATION_CONFLICT", "The idempotency key was already used for different operation input.", publicIdentity);
    }
    if (record.status === "completed") {
      logMetadata(logger, "info", "intelligence.idempotency.replayed", {
        operationId: record.id,
        operation,
        actorUserId,
      });
      return response(true, 200, "INTELLIGENCE_OPERATION_REPLAYED", "The completed Intelligence operation was replayed.", {
        ...publicIdentity,
        replayed: true,
        result: record.result_payload,
        usage: {
          state: record.usage_state,
          classification: record.usage_classification,
        },
      });
    }
    if (record.status === "failed") {
      return response(false, 409, "INTELLIGENCE_OPERATION_FAILED_REPLAY", "The prior Intelligence operation failed. Use a new idempotency key for a governed retry.", {
        ...publicIdentity,
        replayed: true,
        errorClassification: record.error_classification,
        usage: {
          state: record.usage_state,
          classification: record.usage_classification,
        },
      });
    }
    return response(false, 409, "INTELLIGENCE_OPERATION_IN_PROGRESS", "The Intelligence operation is already in progress.", publicIdentity);
  }

  logMetadata(logger, "info", "intelligence.idempotency.execution_owned", {
    operationId: record.id,
    operation,
    actorUserId,
  });

  let providerReturned = false;
  let normalizedResult = null;
  let providerResultPersisted = false;
  let usageAttempted = false;
  let usageSucceeded = false;

  try {
    const providerResult = await executeProvider({
      operationId: record.id,
      correlationId: record.correlation_id,
      operation,
      semanticInput: normalizedSemanticInput,
    });
    providerReturned = true;
    normalizedResult = normalizeReplayResult(providerResult);

    await repository.recordProviderSuccess({
      pool,
      operationId: record.id,
      resultClassification: "success",
      resultPayload: normalizedResult,
    });
    providerResultPersisted = true;

    let completed;
    if (finalizeUsage) {
      await repository.claimUsageFinalization({ pool, operationId: record.id });
      usageAttempted = true;
      const usageResult = await finalizeUsage({
        operationId: record.id,
        correlationId: record.correlation_id,
        operation,
        actorUserId,
      });
      if (usageResult?.ok === false) {
        throw Object.assign(new Error("Usage finalization failed."), {
          code: "usage_finalization_failed",
        });
      }
      usageSucceeded = true;
      completed = await repository.completeIntelligenceOperation({
        pool,
        operationId: record.id,
        expectedUsageState: "finalizing",
        usageState: "finalized",
        usageClassification: normalizeClassification(usageResult?.classification, "recorded"),
      });
    } else {
      completed = await repository.completeIntelligenceOperation({
        pool,
        operationId: record.id,
        expectedUsageState: "pending",
        usageState: "not_configured",
        usageClassification: "stub",
      });
    }

    logMetadata(logger, "info", "intelligence.idempotency.completed", {
      operationId: completed.id,
      operation,
      actorUserId,
      usageState: completed.usage_state,
    });
    return response(true, 200, "INTELLIGENCE_OPERATION_COMPLETED", "The Intelligence operation completed.", {
      operationId: completed.id,
      correlationId: completed.correlation_id,
      operation,
      replayed: false,
      result: completed.result_payload,
      usage: {
        state: completed.usage_state,
        classification: completed.usage_classification,
      },
    });
  } catch (error) {
    const errorClassification = normalizeClassification(error?.code, providerReturned ? "persistence_failure" : "provider_failure");
    const providerExecutionState = providerReturned ? "succeeded" : "failed";
    const usageState = usageSucceeded
      ? "ambiguous"
      : usageAttempted
        ? "failed"
        : "not_chargeable";

    try {
      await repository.failIntelligenceOperation({
        pool,
        operationId: record.id,
        providerExecutionState,
        usageState,
        errorClassification,
        resultClassification: providerResultPersisted ? "success" : null,
        resultPayload: providerResultPersisted ? normalizedResult : null,
      });
    } catch {
      // A persistence failure remains private; the operation is never reported as successful.
    }

    logMetadata(logger, "warn", "intelligence.idempotency.failed", {
      operationId: record.id,
      operation,
      actorUserId,
      errorClassification,
      usageState,
    });
    return publicFailureForClassification(errorClassification, {
      ...publicIdentity,
      usage: {
        state: usageState,
        classification: null,
      },
    });
  }
}

module.exports = {
  createSemanticFingerprint,
  executeIdempotentIntelligenceOperation,
};
