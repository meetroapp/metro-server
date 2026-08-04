"use strict";

const {
  ALERT_ERROR_CODES,
  ALERT_LIMITS,
  alertFailure,
  isPlainObject,
} = require("./alertContracts");

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "__proto__",
  "proto",
  "constructor",
  "prototype",
  "tostring",
  "valueof",
  "message",
  "messagetext",
  "messagebody",
  "body",
  "content",
  "rawcontent",
  "fullmessage",
  "textcontent",
  "html",
  "markup",
  "url",
  "mediaurl",
  "secureurl",
  "address",
  "location",
  "unit",
  "accessnotes",
  "safetycontext",
  "phone",
  "email",
  "payment",
  "token",
  "secret",
  "password",
]);

const URL_PATTERN = /(?:https?:\/\/|www\.|data:|javascript:)/i;
const HTML_PATTERN = /<[^>]+>/;

function keyFingerprint(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isForbiddenPayloadKey(key) {
  return FORBIDDEN_PAYLOAD_KEYS.has(keyFingerprint(key));
}

function invalidPayload(message = "Alert payload is invalid.") {
  return {
    error: alertFailure(
      ALERT_ERROR_CODES.INVALID_PAYLOAD,
      message
    ),
  };
}

function ownDataDescriptors(value) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);

  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
  }

  return { descriptors, keys };
}

function validatePayloadValue(value, context) {
  if (value === null) return { value: null };

  if (typeof value === "string") {
    const normalized = value.trim();
    if (
      normalized.length > ALERT_LIMITS.safePayloadString ||
      URL_PATTERN.test(normalized) ||
      HTML_PATTERN.test(normalized)
    ) {
      return invalidPayload();
    }
    return { value: normalized };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidPayload();
    }
    return { value };
  }

  if (typeof value === "boolean") return { value };

  if (isPlainObject(value)) {
    return normalizeSafePayloadObject(value, {
      depth: context.depth + 1,
      counter: context.counter,
      ancestors: context.ancestors,
    });
  }

  return invalidPayload();
}

function normalizeSafePayloadObject(value, context) {
  if (!isPlainObject(value) || context.depth > ALERT_LIMITS.safePayloadDepth) {
    return invalidPayload("Alert payload must be a safe object.");
  }

  if (context.ancestors.has(value)) return invalidPayload();

  const ownProperties = ownDataDescriptors(value);
  if (!ownProperties) return invalidPayload();

  context.ancestors.add(value);
  const output = {};
  try {
    for (const key of ownProperties.keys) {
      context.counter.count += 1;
      const rawValue = ownProperties.descriptors[key].value;
      if (
        context.counter.count > ALERT_LIMITS.safePayloadKeys ||
        !key ||
        key.length > 80 ||
        isForbiddenPayloadKey(key) ||
        rawValue === undefined ||
        typeof rawValue === "bigint" ||
        typeof rawValue === "function" ||
        typeof rawValue === "symbol" ||
        Array.isArray(rawValue)
      ) {
        return invalidPayload();
      }

      const normalized = validatePayloadValue(rawValue, {
        depth: context.depth,
        counter: context.counter,
        ancestors: context.ancestors,
      });
      if (normalized.error) return normalized;
      output[key] = normalized.value;
    }
  } finally {
    context.ancestors.delete(value);
  }

  return { value: output };
}

function normalizeSafePayload(value) {
  const root = value === undefined ? {} : value;
  const normalized = normalizeSafePayloadObject(root, {
    depth: 0,
    counter: { count: 0 },
    ancestors: new WeakSet(),
  });
  if (normalized.error) return normalized;

  const serialized = JSON.stringify(normalized.value);
  if (
    Buffer.byteLength(serialized, "utf8") >
    ALERT_LIMITS.safePayloadBytes
  ) {
    return invalidPayload("Alert payload is too large.");
  }

  return normalized;
}

module.exports = {
  FORBIDDEN_PAYLOAD_KEYS,
  normalizeSafePayload,
};
