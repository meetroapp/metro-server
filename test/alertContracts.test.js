"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ALERT_CATEGORIES,
  ALERT_DESTINATION_TYPES,
  ALERT_ERROR_CODES,
  ALERT_LIFECYCLE_STATES,
  ALERT_LIMITS,
  ALERT_PRIORITIES,
  ALERT_SOURCE_DOMAINS,
  normalizeBoundedToken,
  normalizeLocalizationKey,
  parsePositiveSafeInteger,
} = require("../server/alerts/alertContracts");

test("alert contracts expose the approved enum values and limits", () => {
  assert.deepEqual(ALERT_SOURCE_DOMAINS, [
    "communication",
    "emergency",
    "workflow",
    "commercial",
    "review",
    "business",
    "system",
  ]);
  assert.ok(ALERT_CATEGORIES.includes("evaluation"));
  assert.ok(ALERT_PRIORITIES.includes("critical"));
  assert.ok(ALERT_LIFECYCLE_STATES.includes("dismissed"));
  assert.ok(ALERT_DESTINATION_TYPES.includes("notifications"));
  assert.equal(ALERT_LIMITS.safePayloadBytes, 4096);
  assert.equal(ALERT_LIMITS.dedupeKey, 240);
});

test("alert contracts parse only positive safe integer identities", () => {
  assert.equal(parsePositiveSafeInteger(1), 1);
  assert.equal(parsePositiveSafeInteger("91"), 91);
  for (const value of [0, -1, 1.2, "1.2", "0", "01", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parsePositiveSafeInteger(value), null);
  }
});

test("alert contracts normalize bounded source and localization keys", () => {
  assert.equal(
    normalizeBoundedToken(" message.created ", 120),
    "message.created"
  );
  assert.equal(normalizeBoundedToken("https://bad", 120), null);
  assert.equal(
    normalizeLocalizationKey("alerts.communication.new-message_title", 160),
    "alerts.communication.new-message_title"
  );
  assert.equal(normalizeLocalizationKey("bad key", 160), null);
  assert.equal(normalizeLocalizationKey("<b>bad</b>", 160), null);
});

test("alert error codes remain internal and alert-specific", () => {
  assert.equal(
    ALERT_ERROR_CODES.INVALID_DESTINATION,
    "INVALID_ALERT_DESTINATION"
  );
  assert.equal(ALERT_ERROR_CODES.CREATE_FAILED, "ALERT_CREATE_FAILED");
  assert.equal(ALERT_ERROR_CODES.EXPIRE_FAILED, "ALERT_EXPIRE_FAILED");
  assert.equal(ALERT_ERROR_CODES.ARCHIVE_FAILED, "ALERT_ARCHIVE_FAILED");
});
