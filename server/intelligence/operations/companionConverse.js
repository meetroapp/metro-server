"use strict";

const { isPlainObject } = require("../intelligenceGatewayContracts");
const { loadConversationContext } = require("../conversationContext");
const { buildRetrievalContext, retrievalResult } = require("../universalRetrieval");
const OPERATION = "companion.converse";
const CLASSIFICATION = "CONVERSATIONAL_NON_CANONICAL";
function invalid(code = "intelligence_context_invalid") { throw Object.assign(new Error("The conversational payload is invalid."), { code }); }
function text(value, maximum) { return typeof value === "string" && value.trim() && value.length <= maximum; }

async function buildContext({ input, context, runtimeContext }) {
  if (!isPlainObject(input) || Object.keys(input).some((key) => !["message", "history"].includes(key)) || !text(input.message, 5000)) invalid();
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > 8 || history.some((turn) => !isPlainObject(turn) || Object.keys(turn).sort().join(",") !== "role,text" || !["user", "assistant"].includes(turn.role) || !text(turn.text, 2000)) || history.reduce((sum, turn) => sum + turn.text.length, 0) > 8000) invalid();
  if (Object.hasOwn(context, "retrieval")) return buildRetrievalContext({ input, context, runtimeContext });
  const record = await loadConversationContext({ context, runtimeContext });
  return { audience: runtimeContext.authenticatedActor.role, record };
}

const companionConverseOperationDefinition = Object.freeze({
  operation: OPERATION,
  capability: OPERATION,
  supportedRoles: Object.freeze(["homeowner", "professional"]),
  engineIds: Object.freeze([]),
  providerName: "workflow_assistance",
  buildContext,
  resolveWithoutProvider: ({ semanticInput, operationId }) => {
    const retrieval = semanticInput.context.retrieval;
    return retrieval && retrieval.deterministicText !== null
      ? retrievalResult(retrieval.deterministicText, semanticInput, operationId) : null;
  },
  buildProviderRequest: ({ semanticInput }) => ({
    operation: OPERATION,
    locale: semanticInput.locale,
    message: semanticInput.input.message,
    discussionHistory: semanticInput.input.history || [],
    audience: semanticInput.context.audience,
    authorizedRecord: semanticInput.context.record,
    authority: "TEXT_ONLY_NO_MUTATION",
  }),
  parseResult(result, { semanticInput, operationId } = {}) {
    if (!isPlainObject(result) || Object.keys(result).sort().join(",") !== "schemaVersion,text" || result.schemaVersion !== 1 || !text(result.text, 8000)) invalid("malformed_operation_result");
    return Object.freeze(semanticInput?.context?.retrieval ? retrievalResult(result.text.trim(), semanticInput, operationId)
      : { schemaVersion: 1, text: result.text.trim(), authorityClassification: CLASSIFICATION, directMutationAllowed: false });
  },
});
module.exports = { companionConverseOperationDefinition, OPERATION, CLASSIFICATION };
