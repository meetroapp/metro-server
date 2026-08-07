"use strict";

const {
  normalizeIdempotencyKey,
  validateGatewayRequestBody,
} = require("./intelligenceGatewayContracts");
const {
  prepareOperationSemanticInput,
} = require("./intelligenceContextBuilder");
const {
  canonicalIntelligenceEngineRegistry,
} = require("./intelligenceEngineRegistry");
const {
  canonicalIntelligenceOperationRegistry,
} = require("./intelligenceOperationRegistry");
const {
  executeIdempotentIntelligenceOperation,
} = require("./intelligenceOperationIdempotencyService");
const {
  orchestrateIntelligenceOperation,
} = require("./intelligenceOrchestrator");

function gatewayResponse(ok, status, code, message) {
  return { ok, status, code, message };
}

function normalizeActor(authenticatedActor) {
  const id = authenticatedActor?.id;
  const role = typeof authenticatedActor?.role === "string"
    ? authenticatedActor.role.trim().toLowerCase()
    : "";
  if (!Number.isInteger(id) || id <= 0 || !/^[a-z][a-z0-9_]*$/.test(role)) {
    return null;
  }
  return Object.freeze({ id, role });
}

function logMetadata(logger, level, event, metadata) {
  if (logger && typeof logger[level] === "function") {
    logger[level](event, metadata);
  }
}

async function executeIntelligenceGateway({
  pool,
  authenticatedActor,
  idempotencyKey: rawIdempotencyKey,
  body,
  operationRegistry = canonicalIntelligenceOperationRegistry,
  engineRegistry = canonicalIntelligenceEngineRegistry,
  providers = {},
  repository,
  usageFinalizer,
  providerTimeoutMs,
  logger = null,
  onDiagnostics,
} = {}) {
  const actor = normalizeActor(authenticatedActor);
  if (!actor) {
    return gatewayResponse(
      false,
      401,
      "INTELLIGENCE_AUTHENTICATION_REQUIRED",
      "Authentication required."
    );
  }

  const validated = validateGatewayRequestBody(body);
  if (!validated.valid) {
    return gatewayResponse(
      false,
      400,
      validated.code,
      "A valid Intelligence request is required."
    );
  }

  const request = validated.value;
  const definition = operationRegistry.get(request.operation);
  if (!definition) {
    return gatewayResponse(
      false,
      403,
      "INTELLIGENCE_OPERATION_FORBIDDEN",
      "The Intelligence operation is not permitted."
    );
  }
  if (
    definition.capability !== request.capability ||
    !definition.supportedRoles.includes(actor.role)
  ) {
    return gatewayResponse(
      false,
      403,
      "INTELLIGENCE_CAPABILITY_FORBIDDEN",
      "The Intelligence capability is not permitted."
    );
  }

  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
  if (!idempotencyKey) {
    return gatewayResponse(
      false,
      400,
      "INTELLIGENCE_IDEMPOTENCY_KEY_INVALID",
      "A valid idempotency key is required."
    );
  }

  let semanticInput;
  try {
    semanticInput = prepareOperationSemanticInput({ definition, request });
  } catch (error) {
    if (
      error?.code !== "intelligence_context_invalid" &&
      error?.code !== "intelligence_context_prohibited"
    ) {
      throw error;
    }
    return gatewayResponse(
      false,
      400,
      "INTELLIGENCE_CONTEXT_INVALID",
      "The Intelligence context is not permitted."
    );
  }

  logMetadata(logger, "info", "intelligence.gateway.authorized", {
    operation: definition.operation,
    authorityScope: `user:${actor.id}`,
    selectedEngines: [...definition.engineIds],
  });

  return executeIdempotentIntelligenceOperation({
    pool,
    authenticatedActor: actor,
    operation: definition.operation,
    idempotencyKey,
    semanticInput,
    repository,
    logger,
    executeProvider: ({ operationId, correlationId }) =>
      orchestrateIntelligenceOperation({
        definition,
        semanticInput,
        operationId,
        correlationId,
        engineRegistry,
        providers,
        timeoutMs: providerTimeoutMs,
        logger,
        onDiagnostics,
      }),
    finalizeUsage: usageFinalizer
      ? (identity) => usageFinalizer({ ...identity, capability: definition.capability })
      : undefined,
  });
}

module.exports = {
  executeIntelligenceGateway,
  normalizeActor,
};
