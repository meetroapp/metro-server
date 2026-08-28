"use strict";

const {
  ALERT_DESTINATION_TYPES,
  ALERT_ERROR_CODES,
  alertFailure,
  assertAllowed,
  isPlainObject,
  parsePositiveSafeInteger,
} = require("./alertContracts");

const FORBIDDEN_DESTINATION_FIELDS = new Set([
  "route",
  "hash",
  "url",
  "href",
  "pathname",
  "query",
  "search",
  "state",
  "replace",
  "returnpage",
  "shell",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidDestination() {
  return alertFailure(
    ALERT_ERROR_CODES.INVALID_DESTINATION,
    "Alert destination is invalid."
  );
}

function exactDataObject(value, keys) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) return null;
  const expected = [...keys].sort();
  const sortedActual = [...actual].sort();
  if (
    sortedActual.length !== expected.length ||
    !sortedActual.every((key, index) => key === expected[index])
  ) {
    return null;
  }
  const output = {};
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
    output[key] = descriptor.value;
  }
  return output;
}

function positiveIdentity(value) {
  return typeof value === "number"
    ? parsePositiveSafeInteger(value)
    : null;
}

function uuidIdentity(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeDestination(input = {}) {
  const root = exactDataObject(input, ["type", "payload"]);
  if (!root) {
    return { error: invalidDestination() };
  }

  const type = typeof root.type === "string"
    ? assertAllowed(root.type, ALERT_DESTINATION_TYPES)
    : null;
  if (!type || !isPlainObject(root.payload)) {
    return { error: invalidDestination() };
  }

  if (type === "notifications") {
    if (!exactDataObject(root.payload, [])) {
      return { error: invalidDestination() };
    }
    return { value: { type, payload: {}, public: { type } } };
  }

  if (type === "conversation") {
    const basic = exactDataObject(root.payload, ["conversationId"]);
    const workContext = exactDataObject(root.payload, [
      "conversationId",
      "jobId",
      "quoteId",
    ]);
    if (!basic && !workContext) return { error: invalidDestination() };
    const conversationId = positiveIdentity(root.payload.conversationId);
    if (!conversationId) return { error: invalidDestination() };
    if (basic) {
      return {
        value: {
          type,
          payload: { conversationId },
          public: { type, conversationId },
        },
      };
    }
    const jobId = uuidIdentity(root.payload.jobId);
    const quoteId = uuidIdentity(root.payload.quoteId);
    if (!jobId || !quoteId) return { error: invalidDestination() };
    return {
      value: {
        type,
        payload: { conversationId, jobId, quoteId },
        public: { type, conversationId, jobId, quoteId },
      },
    };
  }

  const numericDestinations = {
    emergency_request: "emergencyRequestId",
    request: "requestId",
    project: "requestId",
    business_profile: "businessProfileId",
  };

  if (numericDestinations[type]) {
    const field = numericDestinations[type];
    const payload = exactDataObject(root.payload, [field]);
    if (!payload) {
      return { error: invalidDestination() };
    }
    const id = positiveIdentity(payload[field]);
    if (!id) return { error: invalidDestination() };
    return {
      value: {
        type,
        payload: { [field]: id },
        public: { type, [field]: id },
      },
    };
  }

  if (type === "evaluation") {
    const payload = exactDataObject(root.payload, ["evaluationId"]);
    if (!payload || typeof payload.evaluationId !== "string") {
      return { error: invalidDestination() };
    }
    const evaluationId = payload.evaluationId.trim().toLowerCase();
    if (!UUID_PATTERN.test(evaluationId)) {
      return { error: invalidDestination() };
    }
    return {
      value: {
        type,
        payload: { evaluationId },
        public: { type, evaluationId },
      },
    };
  }

  if (type === "review") {
    const payload = exactDataObject(root.payload, ["reviewId"]);
    if (!payload) {
      return { error: invalidDestination() };
    }
    const reviewId = positiveIdentity(payload.reviewId);
    if (!reviewId) {
      return { error: invalidDestination() };
    }
    return {
      value: {
        type,
        payload: { reviewId },
        public: { type, reviewId },
      },
    };
  }

  return { error: invalidDestination() };
}

module.exports = {
  FORBIDDEN_DESTINATION_FIELDS,
  normalizeDestination,
};
