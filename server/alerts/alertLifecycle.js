"use strict";

const {
  ALERT_ERROR_CODES,
  alertFailure,
} = require("./alertContracts");

const ALERT_TRANSITION_MATRIX = Object.freeze({
  read: Object.freeze(["active", "dismissed", "resolved", "expired"]),
  dismiss: Object.freeze(["active", "dismissed"]),
  resolve: Object.freeze(["active", "dismissed", "resolved"]),
  expire: Object.freeze(["active", "dismissed", "expired"]),
  archive: Object.freeze(["resolved", "expired", "archived"]),
});

function isTerminalLifecycle(state) {
  return ["resolved", "expired", "archived"].includes(state);
}

function canMarkRead(alert = {}) {
  return Boolean(
    alert.id &&
    ALERT_TRANSITION_MATRIX.read.includes(alert.lifecycle_state)
  );
}

function canDismiss(alert = {}) {
  if (!alert.id) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }
  if (alert.priority === "critical") {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_DISMISSIBLE,
      "Critical alerts cannot be dismissed.",
      409
    );
  }
  if (!ALERT_TRANSITION_MATRIX.dismiss.includes(alert.lifecycle_state)) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_DISMISSIBLE,
      "Alert cannot be dismissed.",
      409
    );
  }
  return null;
}

function canResolve(alert = {}) {
  if (!alert.id) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }
  if (!ALERT_TRANSITION_MATRIX.resolve.includes(alert.lifecycle_state)) {
    return alertFailure(
      ALERT_ERROR_CODES.RESOLVE_FAILED,
      "Alert cannot be resolved.",
      409
    );
  }
  return null;
}

function timestampMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  return Date.parse(value);
}

function canExpire(alert = {}, { now = new Date() } = {}) {
  if (!alert.id) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }
  if (!ALERT_TRANSITION_MATRIX.expire.includes(alert.lifecycle_state)) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_EXPIRABLE,
      "Alert cannot be expired.",
      409
    );
  }
  const expiresAt = timestampMilliseconds(alert.expires_at);
  const effectiveNow = timestampMilliseconds(now);
  if (
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(effectiveNow) ||
    expiresAt > effectiveNow
  ) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_EXPIRABLE,
      "Alert cannot be expired.",
      409
    );
  }
  return null;
}

function canArchive(alert = {}) {
  if (!alert.id) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }
  if (!ALERT_TRANSITION_MATRIX.archive.includes(alert.lifecycle_state)) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_ARCHIVABLE,
      "Alert cannot be archived.",
      409
    );
  }
  return null;
}

module.exports = {
  ALERT_TRANSITION_MATRIX,
  canArchive,
  canDismiss,
  canExpire,
  canMarkRead,
  canResolve,
  isTerminalLifecycle,
};
