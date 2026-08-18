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
  const accountType = typeof authenticatedActor?.accountType === "string"
    ? authenticatedActor.accountType.trim().toLowerCase()
    : "";
  const rawRole = typeof authenticatedActor?.role === "string"
    ? authenticatedActor.role.trim().toLowerCase()
    : "";
  const role = ["homeowner", "professional"].includes(accountType)
    ? accountType
    : rawRole;
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
  retailerReferenceAdapter,
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
    (
      definition.roleAuthorization !== "context_builder" &&
      !definition.supportedRoles.includes(actor.role)
    )
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
    semanticInput = await prepareOperationSemanticInput({
      definition,
      request,
      runtimeContext: { pool, authenticatedActor: actor, retailerReferenceAdapter },
    });
  } catch (error) {
    const governedFailure = {
      intelligence_job_unavailable: [404, "INTELLIGENCE_JOB_UNAVAILABLE", "The Job is unavailable."],
      intelligence_lifecycle_v2_required: [409, "INTELLIGENCE_LIFECYCLE_V2_REQUIRED", "A lifecycle-v2 Job is required."],
      intelligence_quote_authority_required: [403, "INTELLIGENCE_QUOTE_AUTHORITY_REQUIRED", "Professional Quote authority is required."],
      intelligence_quote_draft_unavailable: [404, "INTELLIGENCE_QUOTE_DRAFT_UNAVAILABLE", "The requested Draft Quote is unavailable."],
      intelligence_evaluation_authority_required: [403, "INTELLIGENCE_EVALUATION_AUTHORITY_REQUIRED", "Professional Evaluation authority is required."],
      intelligence_quick_quote_media_authority_required: [403, "INTELLIGENCE_QUICK_QUOTE_MEDIA_AUTHORITY_REQUIRED", "Professional Quick Quote media authority is required."],
      intelligence_evaluation_unavailable: [404, "INTELLIGENCE_EVALUATION_UNAVAILABLE", "The Evaluation is unavailable."],
      intelligence_invoice_unavailable: [404, "INTELLIGENCE_INVOICE_UNAVAILABLE", "The Invoice context is unavailable."],
    }[error?.code];
    if (governedFailure) {
      return gatewayResponse(false, governedFailure[0], governedFailure[1], governedFailure[2]);
    }
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
