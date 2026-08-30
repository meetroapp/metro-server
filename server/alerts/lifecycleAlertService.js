"use strict";

const {
  deriveCanonicalEventKey,
  parsePositiveSafeInteger,
  requireDatabasePool,
} = require("./alertContracts");
const {
  createAlert,
  resolveAlertsBySource,
} = require("./alertService");

async function createCanonicalLifecycleAlertWithClient({
  client,
  recipientUserId,
  sourceDomain,
  sourceEventType,
  sourceEntityType,
  sourceEntityId,
  sourceEventId,
  category,
  priority = "normal",
  titleKey,
  messageKey,
  safePayload = {},
  destination,
  availableAt = null,
}) {
  requireDatabasePool(client);
  const recipient = parsePositiveSafeInteger(recipientUserId);
  const canonicalEventKey = deriveCanonicalEventKey({
    sourceDomain,
    sourceEventType,
    sourceEntityType,
    sourceEntityId,
    sourceEventId,
  });
  if (!recipient || !canonicalEventKey) {
    throw new TypeError("Canonical lifecycle Alert identity is required.");
  }

  const result = await createAlert({
    client,
    input: {
      recipientUserId: recipient,
      sourceDomain,
      sourceEventType,
      sourceEntityType,
      sourceEntityId,
      sourceEventId,
      permanentEvent: true,
      category,
      priority,
      titleKey,
      messageKey,
      safePayload,
      destination,
      dedupeKey: `event:${canonicalEventKey}`,
      availableAt,
      expiresAt: null,
    },
  });
  if (!result.ok || !result.alert?.id) {
    throw new Error("Canonical lifecycle Alert could not be projected.");
  }
  return { alertId: result.alert.id, created: result.created };
}

async function resolveCanonicalLifecycleAlertsWithClient({
  client,
  sourceDomain,
  sourceEntityType,
  sourceEntityId,
  sourceEventTypes,
  recipientUserId,
  resolvedAt = null,
}) {
  requireDatabasePool(client);
  if (!Array.isArray(sourceEventTypes) || sourceEventTypes.length === 0) {
    throw new TypeError("Canonical lifecycle Alert source types are required.");
  }
  let count = 0;
  for (const sourceEventType of [...new Set(sourceEventTypes)]) {
    const result = await resolveAlertsBySource({
      client,
      input: {
        sourceDomain,
        sourceEntityType,
        sourceEntityId,
        sourceEventType,
        ...(recipientUserId == null ? {} : { recipientUserId }),
        ...(resolvedAt == null ? {} : { resolvedAt }),
      },
    });
    if (!result.ok) {
      throw new Error("Canonical lifecycle Alert resolution failed.");
    }
    count += result.count;
  }
  return { count };
}

module.exports = {
  createCanonicalLifecycleAlertWithClient,
  resolveCanonicalLifecycleAlertsWithClient,
};
