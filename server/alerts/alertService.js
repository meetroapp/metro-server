"use strict";

const {
  ALERT_CATEGORIES,
  ALERT_ERROR_CODES,
  ALERT_LIMITS,
  ALERT_PRIORITIES,
  ALERT_SOURCE_DOMAINS,
  alertFailure,
  assertAllowed,
  isPlainObject,
  normalizeBoundedToken,
  normalizeLocalizationKey,
  parsePositiveSafeInteger,
  requireDatabasePool,
} = require("./alertContracts");
const { normalizeDestination } = require("./alertDestinations");
const {
  canArchive,
  canDismiss,
  canExpire,
  canMarkRead,
} = require("./alertLifecycle");
const { normalizeSafePayload } = require("./alertPayload");
const {
  archiveAlertWithClient,
  dismissAlertWithClient,
  expireAlertWithClient,
  findAnyAlertByRecipientWithClient,
  findAlertByRecipientWithClient,
  insertAlertWithClient,
  markAlertReadWithClient,
  resolveAlertsBySourceWithClient,
} = require("./alertRepository");
const {
  logSafeServerError,
} = require("../errors/publicErrors");

function validateTimestamp(value, field) {
  if (value === null || value === undefined || value === "") {
    return { value: null };
  }
  if (typeof value !== "string" && !(value instanceof Date)) {
    return {
      error: alertFailure(
        ALERT_ERROR_CODES.INVALID_SOURCE,
        `${field} is invalid.`
      ),
    };
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      error: alertFailure(
        ALERT_ERROR_CODES.INVALID_SOURCE,
        `${field} is invalid.`
      ),
    };
  }
  return { value: date.toISOString() };
}

function validateAlertInput(input = {}) {
  if (!isPlainObject(input)) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_SOURCE,
      "Alert source is invalid."
    );
  }
  const recipientUserId = parsePositiveSafeInteger(input.recipientUserId);
  if (!recipientUserId) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_RECIPIENT,
      "Alert recipient is invalid."
    );
  }

  const sourceDomain = assertAllowed(
    input.sourceDomain,
    ALERT_SOURCE_DOMAINS
  );
  const sourceEventType = normalizeBoundedToken(
    input.sourceEventType,
    ALERT_LIMITS.sourceEventType
  );
  const sourceEntityType = normalizeBoundedToken(
    input.sourceEntityType,
    ALERT_LIMITS.sourceEntityType
  );
  const sourceEntityId = normalizeBoundedToken(
    input.sourceEntityId,
    ALERT_LIMITS.sourceEntityId
  );
  const sourceEventIdSupplied = Object.hasOwn(input, "sourceEventId");
  const sourceEventId = input.sourceEventId === null || !sourceEventIdSupplied
    ? null
    : normalizeBoundedToken(
        input.sourceEventId,
        ALERT_LIMITS.sourceEventId
      );

  if (
    !sourceDomain ||
    !sourceEventType ||
    !sourceEntityType ||
    !sourceEntityId ||
    (sourceEventIdSupplied &&
      input.sourceEventId !== null &&
      sourceEventId === null)
  ) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_SOURCE,
      "Alert source is invalid."
    );
  }

  const category = assertAllowed(input.category, ALERT_CATEGORIES);
  if (!category) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_CATEGORY,
      "Alert category is invalid."
    );
  }

  const priority = input.priority == null
    ? "normal"
    : assertAllowed(input.priority, ALERT_PRIORITIES);
  if (!priority) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_PRIORITY,
      "Alert priority is invalid."
    );
  }

  const titleKey = normalizeLocalizationKey(
    input.titleKey,
    ALERT_LIMITS.titleKey
  );
  if (!titleKey) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_TITLE_KEY,
      "Alert title key is invalid."
    );
  }

  const messageKey = normalizeLocalizationKey(
    input.messageKey,
    ALERT_LIMITS.messageKey
  );
  if (!messageKey) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_MESSAGE_KEY,
      "Alert message key is invalid."
    );
  }

  const payload = normalizeSafePayload(
    input.safePayload === undefined ? {} : input.safePayload
  );
  if (payload.error) return payload.error;

  const destination = normalizeDestination(input.destination);
  if (destination.error) return destination.error;

  const dedupeKey = normalizeBoundedToken(
    input.dedupeKey,
    ALERT_LIMITS.dedupeKey
  );
  if (!dedupeKey) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_DEDUPE_KEY,
      "Alert dedupe key is invalid."
    );
  }

  const availableAt = validateTimestamp(input.availableAt, "availableAt");
  if (availableAt.error) return availableAt.error;
  const expiresAt = validateTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt.error) return expiresAt.error;

  return {
    ok: true,
    alert: {
      recipientUserId,
      sourceDomain,
      sourceEventType,
      sourceEntityType,
      sourceEntityId,
      sourceEventId,
      category,
      priority,
      titleKey,
      messageKey,
      safePayload: payload.value,
      destination: destination.value,
      dedupeKey,
      availableAt: availableAt.value,
      expiresAt: expiresAt.value,
    },
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function serializeAlert(row = {}) {
  const destinationPayload = parseJsonObject(
    row.destination_payload
  );
  const destination = normalizeDestination({
    type: row.destination_type,
    payload: destinationPayload,
  });

  return {
    id: String(row.id),
    category: row.category,
    priority: row.priority,
    titleKey: row.title_key,
    messageKey: row.message_key,
    payload: parseJsonObject(row.safe_payload),
    destination: destination.value?.public || {
      type: row.destination_type,
    },
    state: {
      lifecycle: row.lifecycle_state,
      isRead: Boolean(row.read_at),
      isDismissed: row.lifecycle_state === "dismissed",
      isResolved: row.lifecycle_state === "resolved",
      isExpired: row.lifecycle_state === "expired",
      isArchived: row.lifecycle_state === "archived",
    },
    availableAt: row.available_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    readAt: row.read_at || null,
    dismissedAt: row.dismissed_at || null,
    resolvedAt: row.resolved_at || null,
    expiresAt: row.expires_at || null,
    archivedAt: row.archived_at || null,
  };
}

async function withAlertTransaction({ pool, client, operation }) {
  if (client) {
    requireDatabasePool(client);
    return operation(client);
  }

  requireDatabasePool(pool);
  const ownedClient =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await ownedClient.query("BEGIN");
    const result = await operation(ownedClient);
    await ownedClient.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await ownedClient.query("ROLLBACK");
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  } finally {
    if (
      ownedClient !== pool &&
      typeof ownedClient.release === "function"
    ) {
      ownedClient.release();
    }
  }
}

async function createAlert({ pool, client, input, logger = console.error }) {
  const validated = validateAlertInput(input);
  if (!validated.ok) return validated;

  try {
    return await withAlertTransaction({
      pool,
      client,
      operation: async (transactionClient) => {
        const result = await insertAlertWithClient({
          client: transactionClient,
          alert: validated.alert,
        });
        if (!result.row) {
          return alertFailure(
            ALERT_ERROR_CODES.CREATE_FAILED,
            "Alert could not be created.",
            500
          );
        }
        return {
          ok: true,
          status: result.created ? 201 : 200,
          code: result.created ? "ALERT_CREATED" : "ALERT_EXISTS",
          created: result.created,
          alert: serializeAlert(result.row),
        };
      },
    });
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "create_alert",
      code: ALERT_ERROR_CODES.CREATE_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.CREATE_FAILED,
      "Alert could not be created.",
      500
    );
  }
}

async function markAlertRead({
  pool,
  client,
  alertId,
  recipientUserId,
  readAt = null,
  logger = console.error,
}) {
  const parsedAlertId = parsePositiveSafeInteger(alertId);
  const parsedRecipientId = parsePositiveSafeInteger(recipientUserId);
  if (!parsedAlertId || !parsedRecipientId) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }

  try {
    return await withAlertTransaction({
      pool,
      client,
      operation: async (transactionClient) => {
        const existing = await findAlertByRecipientWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
        });
        if (!existing || !canMarkRead(existing)) {
          return alertFailure(
            ALERT_ERROR_CODES.NOT_FOUND,
            "Alert was not found.",
            404
          );
        }
        const row = await markAlertReadWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
          readAt,
        });
        return {
          ok: true,
          status: 200,
          code: "ALERT_READ",
          alert: serializeAlert(row),
        };
      },
    });
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "mark_alert_read",
      code: ALERT_ERROR_CODES.READ_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.READ_FAILED,
      "Alert could not be marked read.",
      500
    );
  }
}

async function dismissAlert({
  pool,
  client,
  alertId,
  recipientUserId,
  dismissedAt = null,
  logger = console.error,
}) {
  const parsedAlertId = parsePositiveSafeInteger(alertId);
  const parsedRecipientId = parsePositiveSafeInteger(recipientUserId);
  if (!parsedAlertId || !parsedRecipientId) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }

  try {
    return await withAlertTransaction({
      pool,
      client,
      operation: async (transactionClient) => {
        const existing = await findAlertByRecipientWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
        });
        const lifecycleError = canDismiss(existing);
        if (lifecycleError) return lifecycleError;
        const row = await dismissAlertWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
          dismissedAt,
        });
        if (!row) {
          return alertFailure(
            ALERT_ERROR_CODES.NOT_DISMISSIBLE,
            "Alert cannot be dismissed.",
            409
          );
        }
        return {
          ok: true,
          status: 200,
          code: "ALERT_DISMISSED",
          alert: serializeAlert(row),
        };
      },
    });
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "dismiss_alert",
      code: ALERT_ERROR_CODES.DISMISS_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.DISMISS_FAILED,
      "Alert could not be dismissed.",
      500
    );
  }
}

function validateResolutionInput(input = {}) {
  if (!isPlainObject(input)) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_SOURCE,
      "Alert source is invalid."
    );
  }
  const sourceDomain = assertAllowed(
    input.sourceDomain,
    ALERT_SOURCE_DOMAINS
  );
  const sourceEntityType = normalizeBoundedToken(
    input.sourceEntityType,
    ALERT_LIMITS.sourceEntityType
  );
  const sourceEntityId = normalizeBoundedToken(
    input.sourceEntityId,
    ALERT_LIMITS.sourceEntityId
  );
  const sourceEventTypeSupplied = Object.hasOwn(input, "sourceEventType");
  const sourceEventType = sourceEventTypeSupplied
    ? normalizeBoundedToken(
        input.sourceEventType,
        ALERT_LIMITS.sourceEventType
      )
    : null;
  const recipientUserIdSupplied = Object.hasOwn(input, "recipientUserId");
  const recipientUserId = recipientUserIdSupplied
    ? parsePositiveSafeInteger(input.recipientUserId)
    : null;
  const resolvedAt = validateTimestamp(input.resolvedAt, "resolvedAt");

  if (
    !sourceDomain ||
    !sourceEntityType ||
    !sourceEntityId ||
    (sourceEventTypeSupplied && sourceEventType === null) ||
    (recipientUserIdSupplied && recipientUserId === null) ||
    resolvedAt.error
  ) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_SOURCE,
      "Alert source is invalid."
    );
  }

  return {
    ok: true,
    sourceDomain,
    sourceEntityType,
    sourceEntityId,
    sourceEventType,
    recipientUserId,
    resolvedAt: resolvedAt.value,
  };
}

async function resolveAlertsBySource({
  pool,
  client,
  input,
  logger = console.error,
}) {
  const validated = validateResolutionInput(input);
  if (!validated.ok) return validated;

  try {
    return await withAlertTransaction({
      pool,
      client,
      operation: async (transactionClient) => {
        const rows = await resolveAlertsBySourceWithClient({
          client: transactionClient,
          sourceDomain: validated.sourceDomain,
          sourceEntityType: validated.sourceEntityType,
          sourceEntityId: validated.sourceEntityId,
          sourceEventType: validated.sourceEventType,
          recipientUserId: validated.recipientUserId,
          resolvedAt: validated.resolvedAt,
        });
        return {
          ok: true,
          status: 200,
          code: "ALERTS_RESOLVED",
          count: rows.length,
          alerts: rows.map(serializeAlert),
        };
      },
    });
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "resolve_alerts_by_source",
      code: ALERT_ERROR_CODES.RESOLVE_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.RESOLVE_FAILED,
      "Alerts could not be resolved.",
      500
    );
  }
}

async function expireAlert({
  pool,
  client,
  alertId,
  recipientUserId,
  effectiveAt = null,
  logger = console.error,
}) {
  const parsedAlertId = parsePositiveSafeInteger(alertId);
  const parsedRecipientId = parsePositiveSafeInteger(recipientUserId);
  if (!parsedAlertId || !parsedRecipientId) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }

  const effectiveTimestamp = effectiveAt == null
    ? { value: new Date().toISOString() }
    : validateTimestamp(effectiveAt, "effectiveAt");
  if (effectiveTimestamp.error) {
    return alertFailure(
      ALERT_ERROR_CODES.EXPIRE_FAILED,
      "Alert expiration timestamp is invalid."
    );
  }

  try {
    return await withAlertTransaction({
      pool,
      client,
      operation: async (transactionClient) => {
        const existing = await findAlertByRecipientWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
        });
        const lifecycleError = canExpire(existing, {
          now: effectiveTimestamp.value,
        });
        if (lifecycleError) return lifecycleError;

        const row = await expireAlertWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
          effectiveAt: effectiveTimestamp.value,
        });
        if (!row) {
          return alertFailure(
            ALERT_ERROR_CODES.NOT_EXPIRABLE,
            "Alert cannot be expired.",
            409
          );
        }
        return {
          ok: true,
          status: 200,
          code: "ALERT_EXPIRED",
          alert: serializeAlert(row),
        };
      },
    });
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "expire_alert",
      code: ALERT_ERROR_CODES.EXPIRE_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.EXPIRE_FAILED,
      "Alert could not be expired.",
      500
    );
  }
}

async function archiveAlert({
  pool,
  client,
  alertId,
  recipientUserId,
  archivedAt = null,
  logger = console.error,
}) {
  const parsedAlertId = parsePositiveSafeInteger(alertId);
  const parsedRecipientId = parsePositiveSafeInteger(recipientUserId);
  if (!parsedAlertId || !parsedRecipientId) {
    return alertFailure(
      ALERT_ERROR_CODES.NOT_FOUND,
      "Alert was not found.",
      404
    );
  }

  const archiveTimestamp = archivedAt == null
    ? { value: null }
    : validateTimestamp(archivedAt, "archivedAt");
  if (archiveTimestamp.error) {
    return alertFailure(
      ALERT_ERROR_CODES.ARCHIVE_FAILED,
      "Alert archive timestamp is invalid."
    );
  }

  try {
    return await withAlertTransaction({
      pool,
      client,
      operation: async (transactionClient) => {
        const existing = await findAnyAlertByRecipientWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
        });
        const lifecycleError = canArchive(existing);
        if (lifecycleError) return lifecycleError;

        const row = await archiveAlertWithClient({
          client: transactionClient,
          alertId: parsedAlertId,
          recipientUserId: parsedRecipientId,
          archivedAt: archiveTimestamp.value,
        });
        if (!row) {
          return alertFailure(
            ALERT_ERROR_CODES.NOT_ARCHIVABLE,
            "Alert cannot be archived.",
            409
          );
        }
        return {
          ok: true,
          status: 200,
          code: "ALERT_ARCHIVED",
          alert: serializeAlert(row),
        };
      },
    });
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "archive_alert",
      code: ALERT_ERROR_CODES.ARCHIVE_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.ARCHIVE_FAILED,
      "Alert could not be archived.",
      500
    );
  }
}

module.exports = {
  archiveAlert,
  createAlert,
  dismissAlert,
  expireAlert,
  markAlertRead,
  resolveAlertsBySource,
  serializeAlert,
  validateAlertInput,
};
