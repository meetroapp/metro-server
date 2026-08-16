"use strict";

const {
  cloneBoundedJson,
  isPlainObject,
} = require("./intelligenceGatewayContracts");
const {
  combineEngineContext,
} = require("./intelligenceContextBuilder");
const {
  canonicalIntelligenceEngineRegistry,
} = require("./intelligenceEngineRegistry");
const {
  invokeIntelligenceProvider,
} = require("./intelligenceProviderAdapter");

function logMetadata(logger, level, event, metadata) {
  if (logger && typeof logger[level] === "function") {
    logger[level](event, metadata);
  }
}

async function collectOperationEngineContext({
  definition,
  semanticInput,
  engineRegistry,
  operationId,
  correlationId,
}) {
  const outputs = [];
  for (const engineId of definition.engineIds) {
    const engine = engineRegistry.get(engineId);
    if (!engine) {
      throw Object.assign(new Error("A required Intelligence engine is unavailable."), {
        code: "required_engine_failure",
      });
    }
    const context = await engine.collectContext({
      operation: definition.operation,
      operationId,
      correlationId,
      semanticInput,
    });
    if (!isPlainObject(context || {})) {
      throw Object.assign(new Error("Engine context must be a normalized object."), {
        code: "intelligence_context_invalid",
      });
    }
    outputs.push({ id: engine.id, context: cloneBoundedJson(context || {}) });
  }
  return combineEngineContext(outputs);
}

async function orchestrateIntelligenceOperation({
  definition,
  semanticInput,
  operationId,
  correlationId,
  engineRegistry = canonicalIntelligenceEngineRegistry,
  providers = {},
  timeoutMs,
  logger = null,
  onDiagnostics,
}) {
  const startedAt = Date.now();
  const engineContext = await collectOperationEngineContext({
    definition,
    semanticInput,
    engineRegistry,
    operationId,
    correlationId,
  });
  const providerRequestCandidate = definition.buildProviderRequest({
    operationId,
    correlationId,
    semanticInput,
    engineContext,
  });
  if (!isPlainObject(providerRequestCandidate)) {
    throw Object.assign(new Error("Provider request must be a normalized object."), {
      code: "intelligence_context_invalid",
    });
  }
  const providerRequest = cloneBoundedJson(providerRequestCandidate, {
    maxBytes: 65536,
    maxStringLength: 12000,
    maxKeys: 1800,
    maxArrayLength: 250,
  });

  const providerResult = await invokeIntelligenceProvider({
    providerName: definition.providerName,
    providers,
    request: providerRequest,
    timeoutMs,
    onInvoke: () => onDiagnostics?.({
      providerExecutionCount: 1,
      selectedEngines: [...definition.engineIds],
    }),
  });
  const providerMetadata = providerResult && typeof providerResult === "object"
    ? providerResult.__providerMetadata || providerResult.providerMetadata || null
    : null;
  let parsedResult;
  try {
    parsedResult = await definition.parseResult(providerResult, {
      semanticInput,
      engineContext,
      operationId,
      correlationId,
      providerMetadata,
    });
  } catch (error) {
    const diagnosticCode = /^[a-f0-9]{16}$/.test(String(error?.diagnosticCode || ""))
      ? error.diagnosticCode
      : null;
    const warningMetadata = {
      operation: definition.operation,
      operationId,
      diagnosticCode,
    };
    if (error?.parserDiagnostics) {
      warningMetadata.parserDiagnostics = error.parserDiagnostics;
    }
    logMetadata(logger, "warn", "intelligence.orchestration.result_rejected", warningMetadata);
    throw error;
  }
  if (!isPlainObject(parsedResult)) {
    throw Object.assign(new Error("The provider result was not a normalized object."), {
      code: "malformed_operation_result",
    });
  }
  const result = cloneBoundedJson(parsedResult, {
    maxBytes: 65536,
    maxStringLength: 12000,
    maxKeys: 1800,
    maxArrayLength: 250,
  });

  logMetadata(logger, "info", "intelligence.orchestration.completed", {
    operation: definition.operation,
    operationId,
    correlationId,
    selectedEngines: [...definition.engineIds],
    providerInvoked: true,
    elapsedMs: Date.now() - startedAt,
  });
  return result;
}

module.exports = {
  collectOperationEngineContext,
  orchestrateIntelligenceOperation,
};
