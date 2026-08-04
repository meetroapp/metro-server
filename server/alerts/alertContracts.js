"use strict";

const { types: { isProxy } } = require("node:util");

const ALERT_SOURCE_DOMAINS = Object.freeze([
  "communication",
  "emergency",
  "workflow",
  "commercial",
  "review",
  "business",
  "system",
]);

const ALERT_CATEGORIES = Object.freeze([
  "communication",
  "emergency",
  "request",
  "evaluation",
  "proposal",
  "invoice",
  "payment",
  "schedule",
  "work",
  "completion",
  "review",
  "business_verification",
  "system",
]);

const ALERT_PRIORITIES = Object.freeze([
  "critical",
  "high",
  "normal",
  "informational",
]);

const ALERT_LIFECYCLE_STATES = Object.freeze([
  "active",
  "dismissed",
  "resolved",
  "expired",
  "archived",
]);

const ALERT_DESTINATION_TYPES = Object.freeze([
  "conversation",
  "emergency_request",
  "request",
  "project",
  "evaluation",
  "business_profile",
  "review",
  "notifications",
]);

const ALERT_LIMITS = Object.freeze({
  sourceEventType: 120,
  sourceEntityType: 120,
  sourceEntityId: 120,
  sourceEventId: 120,
  titleKey: 160,
  messageKey: 160,
  dedupeKey: 240,
  safePayloadBytes: 4096,
  safePayloadDepth: 2,
  safePayloadKeys: 20,
  safePayloadString: 160,
});

const ALERT_ERROR_CODES = Object.freeze({
  INVALID_RECIPIENT: "INVALID_ALERT_RECIPIENT",
  INVALID_SOURCE: "INVALID_ALERT_SOURCE",
  INVALID_CATEGORY: "INVALID_ALERT_CATEGORY",
  INVALID_PRIORITY: "INVALID_ALERT_PRIORITY",
  INVALID_TITLE_KEY: "INVALID_ALERT_TITLE_KEY",
  INVALID_MESSAGE_KEY: "INVALID_ALERT_MESSAGE_KEY",
  INVALID_PAYLOAD: "INVALID_ALERT_PAYLOAD",
  INVALID_DESTINATION: "INVALID_ALERT_DESTINATION",
  INVALID_DEDUPE_KEY: "INVALID_ALERT_DEDUPE_KEY",
  INVALID_ID: "INVALID_ALERT_ID",
  INVALID_QUERY: "INVALID_ALERT_QUERY",
  INVALID_CURSOR: "INVALID_ALERT_CURSOR",
  INVALID_LIFECYCLE: "INVALID_ALERT_LIFECYCLE",
  INVALID_UNREAD_FILTER: "INVALID_ALERT_UNREAD_FILTER",
  INVALID_REQUEST: "INVALID_ALERT_REQUEST",
  NOT_FOUND: "ALERT_NOT_FOUND",
  NOT_DISMISSIBLE: "ALERT_NOT_DISMISSIBLE",
  CREATE_FAILED: "ALERT_CREATE_FAILED",
  READ_FAILED: "ALERT_READ_FAILED",
  DISMISS_FAILED: "ALERT_DISMISS_FAILED",
  RESOLVE_FAILED: "ALERT_RESOLVE_FAILED",
  EXPIRE_FAILED: "ALERT_EXPIRE_FAILED",
  NOT_EXPIRABLE: "ALERT_NOT_EXPIRABLE",
  ARCHIVE_FAILED: "ALERT_ARCHIVE_FAILED",
  NOT_ARCHIVABLE: "ALERT_NOT_ARCHIVABLE",
  FETCH_FAILED: "ALERTS_FETCH_FAILED",
  COUNTS_FETCH_FAILED: "ALERT_COUNTS_FETCH_FAILED",
  READ_ALL_FAILED: "ALERT_READ_ALL_FAILED",
});

const SAFE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const SAFE_SOURCE_PATTERN = /^[A-Za-z0-9._:-]+$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsePositiveSafeInteger(value) {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return value;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function alertFailure(code, message, status = 400) {
  return {
    ok: false,
    status,
    code,
    message,
  };
}

function requireDatabasePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError(
      "A database pool or client is required."
    );
  }
}

function normalizeBoundedToken(value, maximum, pattern = SAFE_SOURCE_PATTERN) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    !pattern.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeOptionalBoundedToken(value, maximum) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return normalizeBoundedToken(value, maximum);
}

function normalizeLocalizationKey(value, maximum) {
  return normalizeBoundedToken(value, maximum, SAFE_KEY_PATTERN);
}

function assertAllowed(value, allowed) {
  return allowed.includes(value) ? value : null;
}

module.exports = {
  ALERT_CATEGORIES,
  ALERT_DESTINATION_TYPES,
  ALERT_ERROR_CODES,
  ALERT_LIFECYCLE_STATES,
  ALERT_LIMITS,
  ALERT_PRIORITIES,
  ALERT_SOURCE_DOMAINS,
  SAFE_KEY_PATTERN,
  SAFE_SOURCE_PATTERN,
  alertFailure,
  assertAllowed,
  isPlainObject,
  normalizeBoundedToken,
  normalizeLocalizationKey,
  normalizeOptionalBoundedToken,
  parsePositiveSafeInteger,
  requireDatabasePool,
};
