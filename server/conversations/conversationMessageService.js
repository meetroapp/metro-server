"use strict";

const {
  parsePositiveInteger,
} = require("./conversations");

const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 100;

function requireDatabasePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError(
      "A database pool or client is required."
    );
  }
}

function parseMessagePageSize(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return DEFAULT_MESSAGE_PAGE_SIZE;
  }

  const normalized = String(value).trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_MESSAGE_PAGE_SIZE
  ) {
    return null;
  }

  return parsed;
}

function encodeMessageCursor(row = {}) {
  const id = parsePositiveInteger(row.id);

  if (!id) {
    throw new TypeError(
      "A valid message ID is required for a cursor."
    );
  }

  const createdAt =
    row.created_at === null ||
    row.created_at === undefined
      ? null
      : new Date(row.created_at).toISOString();

  return Buffer.from(
    JSON.stringify({ createdAt, id }),
    "utf8"
  ).toString("base64url");
}

function decodeMessageCursor(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return {
      valid: true,
      cursor: null,
    };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(
        String(value).trim(),
        "base64url"
      ).toString("utf8")
    );

    const id = parsePositiveInteger(parsed?.id);

    if (!id) {
      return {
        valid: false,
        cursor: null,
      };
    }

    let createdAt = null;

    if (
      parsed.createdAt !== null &&
      parsed.createdAt !== undefined
    ) {
      if (
        typeof parsed.createdAt !== "string" ||
        !parsed.createdAt.trim() ||
        Number.isNaN(Date.parse(parsed.createdAt))
      ) {
        return {
          valid: false,
          cursor: null,
        };
      }

      createdAt = new Date(
        parsed.createdAt
      ).toISOString();
    }

    return {
      valid: true,
      cursor: {
        createdAt,
        id,
      },
    };
  } catch {
    return {
      valid: false,
      cursor: null,
    };
  }
}

async function listConversationMessages({
  pool,
  conversationId: rawConversationId,
  limit: rawLimit,
  cursor: rawCursor,
}) {
  const conversationId =
    parsePositiveInteger(rawConversationId);

  if (!conversationId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CONVERSATION_ID",
      message: "A valid conversation ID is required.",
    };
  }

  const limit = parseMessagePageSize(rawLimit);

  if (!limit) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_MESSAGE_PAGE_SIZE",
      message:
        `Message page size must be between 1 and ${MAX_MESSAGE_PAGE_SIZE}.`,
    };
  }

  const decodedCursor =
    decodeMessageCursor(rawCursor);

  if (!decodedCursor.valid) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_MESSAGE_CURSOR",
      message: "The message cursor is invalid.",
    };
  }

  requireDatabasePool(pool);

  const cursor = decodedCursor.cursor;
  const hasCursor = Boolean(cursor);

  const result = await pool.query(
    `
    SELECT
      messages.id,
      messages.sender_id,
      messages.receiver_id,
      messages.message_text,
      messages.image_url,
      messages.message_type,
      messages.workflow_type,
      messages.workflow_status,
      messages.workflow_payload,
      messages.created_at
    FROM messages
    WHERE messages.conversation_id = $1
      AND (
        $2::boolean = FALSE
        OR (
          (
            $3::timestamp IS NULL
            AND messages.created_at IS NULL
            AND messages.id > $4
          )
          OR (
            $3::timestamp IS NOT NULL
            AND (
              messages.created_at IS NULL
              OR (
                messages.created_at IS NOT NULL
                AND (
                  messages.created_at,
                  messages.id
                ) > (
                  $3::timestamp,
                  $4
                )
              )
            )
          )
        )
      )
    ORDER BY
      messages.created_at ASC NULLS LAST,
      messages.id ASC
    LIMIT $5
    `,
    [
      conversationId,
      hasCursor,
      cursor?.createdAt ?? null,
      cursor?.id ?? 0,
      limit + 1,
    ]
  );

  const hasMore =
    result.rows.length > limit;

  const messages = hasMore
    ? result.rows.slice(0, limit)
    : result.rows;

  return {
    ok: true,
    status: 200,
    code: "CONVERSATION_MESSAGES_FOUND",
    messages,
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && messages.length > 0
          ? encodeMessageCursor(
              messages.at(-1)
            )
          : null,
    },
  };
}

module.exports = {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  decodeMessageCursor,
  encodeMessageCursor,
  listConversationMessages,
  parseMessagePageSize,
};
