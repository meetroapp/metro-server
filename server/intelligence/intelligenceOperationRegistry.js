"use strict";

const {
  normalizeCapability,
  normalizeOperation,
} = require("./intelligenceGatewayContracts");
const {
  jobRequestInterpretOperationDefinition,
} = require("./operations/jobRequestInterpret");
const {
  quoteComposeOperationDefinition,
} = require("./operations/quoteCompose");

function validateOperationDefinition(definition) {
  const operation = normalizeOperation(definition?.operation);
  const capability = normalizeCapability(definition?.capability);
  const supportedRoles = Array.isArray(definition?.supportedRoles)
    ? [...new Set(definition.supportedRoles.map((role) => String(role).trim().toLowerCase()))]
    : [];
  const engineIds = Array.isArray(definition?.engineIds)
    ? [...new Set(definition.engineIds.map((id) => String(id).trim().toLowerCase()))]
    : [];
  const providerName = String(definition?.providerName || "default").trim().toLowerCase();
  const roleAuthorization = definition?.roleAuthorization || "registry";
  const errors = [];

  if (!operation) errors.push("invalid_operation");
  if (!capability) errors.push("invalid_capability");
  if (!supportedRoles.length || supportedRoles.some((role) => !/^[a-z][a-z0-9_]*$/.test(role))) {
    errors.push("invalid_supported_roles");
  }
  if (engineIds.some((id) => !/^[a-z][a-z0-9_]*$/.test(id))) {
    errors.push("invalid_engine_ids");
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(providerName)) errors.push("invalid_provider_name");
  if (!["registry", "context_builder"].includes(roleAuthorization)) {
    errors.push("invalid_role_authorization");
  }
  if (typeof definition?.buildContext !== "function") errors.push("missing_context_builder");
  if (typeof definition?.buildProviderRequest !== "function") {
    errors.push("missing_provider_request_builder");
  }
  if (typeof definition?.parseResult !== "function") errors.push("missing_result_parser");

  return {
    valid: errors.length === 0,
    errors,
    value: errors.length
      ? null
      : Object.freeze({
          operation,
          capability,
          supportedRoles: Object.freeze(supportedRoles),
          engineIds: Object.freeze(engineIds),
          providerName,
          roleAuthorization,
          buildContext: definition.buildContext,
          buildProviderRequest: definition.buildProviderRequest,
          parseResult: definition.parseResult,
        }),
  };
}

function createIntelligenceOperationRegistry(definitions = []) {
  const operations = new Map();
  for (const definition of definitions) {
    const validated = validateOperationDefinition(definition);
    if (!validated.valid) {
      throw new TypeError(
        `Invalid Intelligence operation definition: ${validated.errors.join(",")}`
      );
    }
    if (operations.has(validated.value.operation)) {
      throw new Error(`Duplicate Intelligence operation: ${validated.value.operation}`);
    }
    operations.set(validated.value.operation, validated.value);
  }

  return Object.freeze({
    get(operation) {
      return operations.get(normalizeOperation(operation)) || null;
    },
    list() {
      return [...operations.values()].map(({
        buildContext,
        buildProviderRequest,
        parseResult,
        roleAuthorization,
        ...metadata
      }) => ({ ...metadata }));
    },
  });
}

const canonicalIntelligenceOperationRegistry =
  createIntelligenceOperationRegistry([
    jobRequestInterpretOperationDefinition,
    quoteComposeOperationDefinition,
  ]);

module.exports = {
  canonicalIntelligenceOperationRegistry,
  createIntelligenceOperationRegistry,
  validateOperationDefinition,
};
