"use strict";

const OPERATION_PATTERN =
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CAPABILITY_PATTERN =
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_REQUEST_KEYS = new Set([
  "operation",
  "locale",
  "capability",
  "context",
  "input",
]);
const PROHIBITED_DATA_KEYS = new Set([
  "accesstoken",
  "accountid",
  "actor",
  "actorid",
  "actoruserid",
  "apikey",
  "authorization",
  "authorityscope",
  "billingidentity",
  "cookie",
  "correlationid",
  "constructor",
  "engine",
  "engineid",
  "engineids",
  "headers",
  "idempotencykey",
  "localstorage",
  "model",
  "operationid",
  "password",
  "payment",
  "provider",
  "providername",
  "proto",
  "prototype",
  "refreshtoken",
  "secret",
  "token",
  "usage",
  "usageclassification",
  "usagestate",
  "userid",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeOperation(value) {
  if (typeof value !== "string") return null;
  const operation = value.trim().toLowerCase();
  return operation.length <= 160 && OPERATION_PATTERN.test(operation)
    ? operation
    : null;
}

function normalizeCapability(value) {
  if (typeof value !== "string") return null;
  const capability = value.trim().toLowerCase();
  return capability.length <= 160 && CAPABILITY_PATTERN.test(capability)
    ? capability
    : null;
}

function normalizeLocale(value) {
  if (value === undefined || value === null || value === "") value = "en";
  if (typeof value !== "string") return null;
  const locale = value.trim();
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale) ? locale : null;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
}

function normalizeDataKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function cloneBoundedJson(value, options = {}, state = null) {
  const limits = {
    maxBytes: options.maxBytes || 32768,
    maxDepth: options.maxDepth || 8,
    maxKeys: options.maxKeys || 120,
    maxArrayLength: options.maxArrayLength || 50,
    maxStringLength: options.maxStringLength || 8000,
  };
  const current = state || { depth: 0, keys: 0, seen: new Set() };

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      throw Object.assign(new Error("Intelligence data contains an oversized string."), {
        code: "intelligence_context_invalid",
      });
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw Object.assign(new Error("Intelligence data contains an invalid number."), {
        code: "intelligence_context_invalid",
      });
    }
    return value;
  }
  if (current.depth >= limits.maxDepth) {
    throw Object.assign(new Error("Intelligence data exceeds the depth limit."), {
      code: "intelligence_context_invalid",
    });
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength || current.seen.has(value)) {
      throw Object.assign(new Error("Intelligence data contains an invalid array."), {
        code: "intelligence_context_invalid",
      });
    }
    current.seen.add(value);
    current.depth += 1;
    const cloned = value.map((item) => cloneBoundedJson(item, limits, current));
    current.depth -= 1;
    current.seen.delete(value);
    return cloned;
  }
  if (!isPlainObject(value) || current.seen.has(value)) {
    throw Object.assign(new Error("Intelligence data must contain plain JSON objects."), {
      code: "intelligence_context_invalid",
    });
  }

  current.seen.add(value);
  current.depth += 1;
  const cloned = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      throw Object.assign(new Error("Intelligence data cannot contain accessors."), {
        code: "intelligence_context_invalid",
      });
    }
    if (PROHIBITED_DATA_KEYS.has(normalizeDataKey(key))) {
      throw Object.assign(new Error("Intelligence data contains prohibited metadata."), {
        code: "intelligence_context_prohibited",
      });
    }
    current.keys += 1;
    if (current.keys > limits.maxKeys) {
      throw Object.assign(new Error("Intelligence data contains too many fields."), {
        code: "intelligence_context_invalid",
      });
    }
    cloned[key] = cloneBoundedJson(value[key], limits, current);
  }
  current.depth -= 1;
  current.seen.delete(value);

  if (!state && Buffer.byteLength(JSON.stringify(cloned), "utf8") > limits.maxBytes) {
    throw Object.assign(new Error("Intelligence data exceeds the byte limit."), {
      code: "intelligence_context_invalid",
    });
  }
  return cloned;
}

function validateGatewayRequestBody(body) {
  if (!isPlainObject(body)) {
    return { valid: false, code: "INTELLIGENCE_REQUEST_INVALID" };
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      return { valid: false, code: "INTELLIGENCE_REQUEST_FIELDS_UNSUPPORTED" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(body, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      return { valid: false, code: "INTELLIGENCE_REQUEST_INVALID" };
    }
  }

  const operation = normalizeOperation(body.operation);
  const capability = normalizeCapability(body.capability);
  const locale = normalizeLocale(body.locale);
  if (!operation || !capability || !locale) {
    return { valid: false, code: "INTELLIGENCE_REQUEST_INVALID" };
  }
  if (body.context !== undefined && !isPlainObject(body.context)) {
    return { valid: false, code: "INTELLIGENCE_REQUEST_INVALID" };
  }
  if (body.input !== undefined && !isPlainObject(body.input)) {
    return { valid: false, code: "INTELLIGENCE_REQUEST_INVALID" };
  }

  return {
    valid: true,
    value: {
      operation,
      capability,
      locale,
      context: body.context || {},
      input: body.input || {},
    },
  };
}

module.exports = {
  CAPABILITY_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  OPERATION_PATTERN,
  cloneBoundedJson,
  isPlainObject,
  normalizeCapability,
  normalizeIdempotencyKey,
  normalizeLocale,
  normalizeOperation,
  validateGatewayRequestBody,
};
