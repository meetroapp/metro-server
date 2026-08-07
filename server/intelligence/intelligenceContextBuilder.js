"use strict";

const {
  cloneBoundedJson,
  isPlainObject,
} = require("./intelligenceGatewayContracts");

function prepareOperationSemanticInput({ definition, request }) {
  const input = cloneBoundedJson(request.input, {
    maxBytes: 32768,
    maxStringLength: 8000,
  });
  const callerContext = cloneBoundedJson(request.context, {
    maxBytes: 32768,
    maxStringLength: 8000,
  });
  const candidateContext = definition.buildContext({
    locale: request.locale,
    capability: request.capability,
    input,
    context: callerContext,
  });
  if (!isPlainObject(candidateContext || {})) {
    throw Object.assign(new Error("Operation context must be a normalized object."), {
      code: "intelligence_context_invalid",
    });
  }
  const context = cloneBoundedJson(candidateContext || {}, {
    maxBytes: 32768,
    maxStringLength: 8000,
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
