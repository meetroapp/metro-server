"use strict";

const {
  cloneBoundedJson,
  isPlainObject,
} = require("./intelligenceGatewayContracts");

async function prepareOperationSemanticInput({ definition, request, runtimeContext }) {
  const input = cloneBoundedJson(request.input, {
    maxBytes: 32768,
    maxStringLength: 8000,
    maxKeys: 400,
    maxArrayLength: 80,
  });
  const callerContext = cloneBoundedJson(request.context, {
    maxBytes: 32768,
    maxStringLength: 8000,
  });
  const candidateContext = await definition.buildContext({
    locale: request.locale,
    capability: request.capability,
    input,
    context: callerContext,
    runtimeContext,
  });
  if (!isPlainObject(candidateContext || {})) {
    throw Object.assign(new Error("Operation context must be a normalized object."), {
      code: "intelligence_context_invalid",
    });
  }
  const context = cloneBoundedJson(candidateContext || {}, {
    maxBytes: 65536,
    maxStringLength: 8000,
    maxKeys: 1500,
    maxArrayLength: 200,
  });

  return Object.freeze({
    locale: request.locale,
    capability: request.capability,
    input,
    context,
  });
}

function combineEngineContext(outputs) {
  const combined = {};
  for (const output of outputs) {
    combined[output.id] = output.context;
  }
  return cloneBoundedJson(combined, {
    maxBytes: 32768,
    maxStringLength: 8000,
  });
}

module.exports = {
  combineEngineContext,
  prepareOperationSemanticInput,
};
