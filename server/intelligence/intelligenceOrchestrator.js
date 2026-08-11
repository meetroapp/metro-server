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
  const parsedResult = await definition.parseResult(providerResult, {
    semanticInput,
    engineContext,
    operationId,
    correlationId,
  });
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
