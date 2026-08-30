"use strict";

const {
  ALERT_CATEGORIES,
  ALERT_ERROR_CODES,
  ALERT_LIFECYCLE_STATES,
  ALERT_LIMITS,
  ALERT_PRIORITIES,
  ALERT_SOURCE_DOMAINS,
  alertFailure,
  assertAllowed,
  deriveCanonicalEventKey,
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
  countAlertsForRecipientWithClient,
  dismissAlertWithClient,
  expireAlertWithClient,
  findAnyAlertByRecipientWithClient,
  findAlertByRecipientWithClient,
  insertAlertWithClient,
  listAlertsForRecipientWithClient,
  markAlertsReadThroughCutoffWithClient,
  markAlertReadWithClient,
  resolveAlertsBySourceWithClient,
} = require("./alertRepository");
const {
  logSafeServerError,
} = require("../errors/publicErrors");

const DEFAULT_ALERT_PAGE_SIZE = 25;
const MAX_ALERT_PAGE_SIZE = 50;
const MAX_ALERT_CURSOR_LENGTH = 1024;
const ALERT_LIST_QUERY_FIELDS = new Set([
  "limit",
  "cursor",
  "category",
  "priority",
  "lifecycle",
  "unread",
]);

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

function readExactDataObject(value, allowedFields) {
  const input = value === undefined ? {} : value;
  if (!isPlainObject(input)) return null;

  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) =>
      typeof key !== "string" ||
      !allowedFields.has(key) ||
      !descriptors[key]?.enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
  ) {
    return null;
  }

  const output = Object.create(null);
  for (const key of keys) {
    output[key] = descriptors[key].value;
  }
  return output;
}

function invalidAlertQuery(
  code = ALERT_ERROR_CODES.INVALID_QUERY,
  message = "Alert query is invalid."
) {
  return alertFailure(code, message);
}

function parseAlertPageSize(value) {
  if (value === undefined) return DEFAULT_ALERT_PAGE_SIZE;

  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value)
  ) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_ALERT_PAGE_SIZE
    ? parsed
    : null;
}

function serializeCanonicalAlertCursorPayload({ availableAt, id }) {
  return JSON.stringify({ availableAt, id });
}

function encodeAlertCursor(row = {}) {
  const id = typeof row.id === "number" || typeof row.id === "string"
    ? parsePositiveSafeInteger(row.id)
    : null;
  const date = row.available_at instanceof Date
    ? row.available_at
    : new Date(row.available_at);

  if (!id || Number.isNaN(date.getTime())) {
    throw new TypeError("A valid alert cursor row is required.");
  }

  return Buffer.from(
    serializeCanonicalAlertCursorPayload({
      availableAt: date.toISOString(),
      id,
    }),
    "utf8"
  ).toString("base64url");
}

function decodeAlertCursor(value) {
  if (value === undefined) {
    return { valid: true, cursor: null };
  }
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_ALERT_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return { valid: false, cursor: null };
  }

  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      return { valid: false, cursor: null };
    }
    const parsed = JSON.parse(bytes.toString("utf8"));
    const cursor = readExactDataObject(
      parsed,
      new Set(["availableAt", "id"])
    );
    if (
      !cursor ||
      typeof cursor.availableAt !== "string" ||
      typeof cursor.id !== "number" ||
      !parsePositiveSafeInteger(cursor.id)
    ) {
      return { valid: false, cursor: null };
    }

    const date = new Date(cursor.availableAt);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString() !== cursor.availableAt
    ) {
      return { valid: false, cursor: null };
    }

    const canonicalJson = serializeCanonicalAlertCursorPayload({
      availableAt: cursor.availableAt,
      id: cursor.id,
    });
    if (bytes.toString("utf8") !== canonicalJson) {
      return { valid: false, cursor: null };
    }

    return {
      valid: true,
      cursor: {
        availableAt: cursor.availableAt,
        id: cursor.id,
      },
    };
  } catch {
    return { valid: false, cursor: null };
  }
}

function validateAlertListQuery(query) {
  const parsed = readExactDataObject(query, ALERT_LIST_QUERY_FIELDS);
  if (!parsed) return invalidAlertQuery();

  const limit = parseAlertPageSize(parsed.limit);
  if (!limit) {
    return invalidAlertQuery(
      ALERT_ERROR_CODES.INVALID_QUERY,
      `Alert limit must be between 1 and ${MAX_ALERT_PAGE_SIZE}.`
    );
  }

  const category = Object.hasOwn(parsed, "category")
    ? assertAllowed(parsed.category, ALERT_CATEGORIES)
    : null;
  if (Object.hasOwn(parsed, "category") && !category) {
    return invalidAlertQuery(
      ALERT_ERROR_CODES.INVALID_CATEGORY,
      "Alert category is invalid."
    );
  }

  const priority = Object.hasOwn(parsed, "priority")
    ? assertAllowed(parsed.priority, ALERT_PRIORITIES)
    : null;
  if (Object.hasOwn(parsed, "priority") && !priority) {
    return invalidAlertQuery(
      ALERT_ERROR_CODES.INVALID_PRIORITY,
      "Alert priority is invalid."
    );
  }

  const lifecycle = Object.hasOwn(parsed, "lifecycle")
    ? assertAllowed(parsed.lifecycle, ALERT_LIFECYCLE_STATES)
    : "active";
  if (!lifecycle) {
    return invalidAlertQuery(
      ALERT_ERROR_CODES.INVALID_LIFECYCLE,
      "Alert lifecycle is invalid."
    );
  }

  let unread = null;
  if (Object.hasOwn(parsed, "unread")) {
    if (parsed.unread === "true") unread = true;
    else if (parsed.unread === "false") unread = false;
    else {
      return invalidAlertQuery(
        ALERT_ERROR_CODES.INVALID_UNREAD_FILTER,
        "Alert unread filter is invalid."
      );
    }
  }

  const cursorSupplied = Object.hasOwn(parsed, "cursor");
  const decodedCursor = cursorSupplied && parsed.cursor !== undefined
    ? decodeAlertCursor(parsed.cursor)
    : cursorSupplied
      ? { valid: false, cursor: null }
      : { valid: true, cursor: null };
  if (!decodedCursor.valid) {
    return invalidAlertQuery(
      ALERT_ERROR_CODES.INVALID_CURSOR,
      "Alert cursor is invalid."
    );
  }

  return {
    ok: true,
    filters: {
      category,
      priority,
      lifecycle,
      unread,
      cursor: decodedCursor.cursor,
      limit,
    },
  };
}

function validateEmptyAlertQuery(query) {
  return readExactDataObject(query, new Set())
    ? { ok: true }
    : invalidAlertQuery();
}

function validateAlertReadAllInput(input) {
  const parsed = readExactDataObject(input, new Set(["category"]));
  if (!parsed) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_REQUEST,
      "Alert read-all request is invalid."
    );
  }

  const category = Object.hasOwn(parsed, "category")
    ? assertAllowed(parsed.category, ALERT_CATEGORIES)
    : null;
  if (Object.hasOwn(parsed, "category") && !category) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_CATEGORY,
      "Alert category is invalid."
    );
  }

  return { ok: true, category };
}

function normalizePublicTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeAlertCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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

  if (Object.hasOwn(input, "canonicalEventKey")) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_SOURCE,
      "Alert event identity is server-derived."
    );
  }
  const permanentEvent = input.permanentEvent === true;

  if (
    !sourceDomain ||
    !sourceEventType ||
    !sourceEntityType ||
    !sourceEntityId ||
    (sourceEventIdSupplied &&
      input.sourceEventId !== null &&
      sourceEventId === null) ||
    (permanentEvent && !sourceEventId)
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
      canonicalEventKey: permanentEvent
        ? deriveCanonicalEventKey({
            sourceDomain,
            sourceEventType,
            sourceEntityType,
            sourceEntityId,
            sourceEventId,
          })
        : null,
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

async function listAlertsForRecipient({
  pool,
  client,
  recipientUserId,
  query,
  logger = console.error,
}) {
  const parsedRecipientId = parsePositiveSafeInteger(recipientUserId);
  if (!parsedRecipientId) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_RECIPIENT,
      "Alert recipient is invalid."
    );
  }

  const validated = validateAlertListQuery(query);
  if (!validated.ok) return validated;

  const database = client || pool;
  try {
    requireDatabasePool(database);
    const { filters } = validated;
    const rows = await listAlertsForRecipientWithClient({
      client: database,
      recipientUserId: parsedRecipientId,
      category: filters.category,
      priority: filters.priority,
      lifecycle: filters.lifecycle,
      unread: filters.unread,
      cursor: filters.cursor,
      limit: filters.limit + 1,
    });
    if (!Array.isArray(rows)) {
      throw new TypeError("Alert list rows are invalid.");
    }

    const hasMore = rows.length > filters.limit;
    const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
    return {
      ok: true,
      status: 200,
      code: "ALERTS_RETRIEVED",
      alerts: pageRows.map(serializeAlert),
      pagination: {
        limit: filters.limit,
        hasMore,
        nextCursor:
          hasMore && pageRows.length > 0
            ? encodeAlertCursor(pageRows.at(-1))
            : null,
      },
    };
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "list_alerts_for_recipient",
      code: ALERT_ERROR_CODES.FETCH_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.FETCH_FAILED,
      "Alerts could not be loaded.",
      500
    );
  }
}

async function getAlertCountsForRecipient({
  pool,
  client,
  recipientUserId,
  query,
  logger = console.error,
}) {
  const parsedRecipientId = parsePositiveSafeInteger(recipientUserId);
  if (!parsedRecipientId) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_RECIPIENT,
      "Alert recipient is invalid."
    );
  }

  const validatedQuery = validateEmptyAlertQuery(query);
  if (!validatedQuery.ok) return validatedQuery;

  const database = client || pool;
  try {
    requireDatabasePool(database);
    const rows = await countAlertsForRecipientWithClient({
      client: database,
      recipientUserId: parsedRecipientId,
    });
    if (!Array.isArray(rows)) {
      throw new TypeError("Alert count rows are invalid.");
    }

    let active = 0;
    let unread = 0;
    const byCategory = {};
    for (const row of rows) {
      if (!ALERT_CATEGORIES.includes(row?.category)) continue;
      const categoryActive = normalizeAlertCount(row.active_count);
      const categoryUnread = normalizeAlertCount(row.unread_count);
      byCategory[row.category] = {
        active: categoryActive,
        unread: categoryUnread,
      };
      active += categoryActive;
      unread += categoryUnread;
    }

    return {
      ok: true,
      status: 200,
      code: "ALERT_COUNTS_RETRIEVED",
      counts: { active, unread, byCategory },
    };
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "count_alerts_for_recipient",
      code: ALERT_ERROR_CODES.COUNTS_FETCH_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.COUNTS_FETCH_FAILED,
      "Alert counts could not be loaded.",
      500
    );
  }
}

async function markAllAlertsRead({
  pool,
  client,
  recipientUserId,
  query,
  input,
  logger = console.error,
}) {
  const parsedRecipientId = parsePositiveSafeInteger(recipientUserId);
  if (!parsedRecipientId) {
    return alertFailure(
      ALERT_ERROR_CODES.INVALID_RECIPIENT,
      "Alert recipient is invalid."
    );
  }

  const validatedQuery = validateEmptyAlertQuery(query);
  if (!validatedQuery.ok) return validatedQuery;
  const validatedInput = validateAlertReadAllInput(input);
  if (!validatedInput.ok) return validatedInput;

  const database = client || pool;
  try {
    requireDatabasePool(database);
    const row = await markAlertsReadThroughCutoffWithClient({
      client: database,
      recipientUserId: parsedRecipientId,
      category: validatedInput.category,
    });
    const cutoffAt = normalizePublicTimestamp(row?.cutoff_at);
    if (!row || !cutoffAt) {
      throw new TypeError("Alert read-all result is invalid.");
    }

    return {
      ok: true,
      status: 200,
      code: "ALERTS_MARKED_READ",
      markedReadCount: normalizeAlertCount(row.marked_read_count),
      cutoffAt,
    };
  } catch (error) {
    logSafeServerError(logger, {
      event: "Alert operation failed",
      operation: "mark_all_alerts_read",
      code: ALERT_ERROR_CODES.READ_ALL_FAILED,
    }, error);
    if (client) throw error;
    return alertFailure(
      ALERT_ERROR_CODES.READ_ALL_FAILED,
      "Alerts could not be marked read.",
      500
    );
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
  DEFAULT_ALERT_PAGE_SIZE,
  MAX_ALERT_PAGE_SIZE,
  archiveAlert,
  createAlert,
  decodeAlertCursor,
  dismissAlert,
  encodeAlertCursor,
  expireAlert,
  getAlertCountsForRecipient,
  listAlertsForRecipient,
  markAllAlertsRead,
  markAlertRead,
  parseAlertPageSize,
  resolveAlertsBySource,
  serializeAlert,
  validateAlertInput,
  validateAlertListQuery,
  validateAlertReadAllInput,
};
