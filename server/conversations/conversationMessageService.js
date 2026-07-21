"use strict";

const {
  parsePositiveInteger,
} = require("./conversations");

const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_TEXT_LENGTH = 5000;
const CONVERSATION_MESSAGE_FIELDS = new Set([
  "message_text",
]);

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

function validateConversationMessageInput(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(payload)
    )
  ) {
    return {
      valid: false,
      status: 400,
      code: "MESSAGE_TEXT_REQUIRED",
      message: "Message text is required.",
    };
  }

  const unsupportedFields = Object.keys(payload)
    .filter((field) =>
      !CONVERSATION_MESSAGE_FIELDS.has(field)
    );

  if (unsupportedFields.length > 0) {
    return {
      valid: false,
      status: 400,
      code: "UNSUPPORTED_MESSAGE_FIELDS",
      message:
        "One or more message fields are not supported.",
    };
  }

  if (typeof payload.message_text !== "string") {
    return {
      valid: false,
      status: 400,
      code: "MESSAGE_TEXT_REQUIRED",
      message: "Message text is required.",
    };
  }

  const messageText = payload.message_text.trim();

  if (!messageText) {
    return {
      valid: false,
      status: 400,
      code: "MESSAGE_TEXT_REQUIRED",
      message: "Message text is required.",
    };
  }

  if (messageText.length > MAX_MESSAGE_TEXT_LENGTH) {
    return {
      valid: false,
      status: 400,
      code: "MESSAGE_TEXT_TOO_LONG",
      message:
        "Message text must be 5000 characters or fewer.",
    };
  }

  return {
    valid: true,
    value: {
      messageText,
    },
  };
}

async function createConversationMessage({
  pool,
  conversationId: rawConversationId,
  senderUserId: rawSenderUserId,
  payload,
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

  const senderUserId =
    parsePositiveInteger(rawSenderUserId);

  if (!senderUserId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_SENDER_USER_ID",
      message: "A valid sender user ID is required.",
    };
  }

  const validation =
    validateConversationMessageInput(payload);

  if (!validation.valid) {
    return {
      ok: false,
      status: validation.status,
      code: validation.code,
      message: validation.message,
    };
  }

  requireDatabasePool(pool);

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const conversationResult = await client.query(
      `
      SELECT
        conversations.id,
        conversations.homeowner_id,
        conversations.professional_user_id,
        conversations.status
      FROM conversations
      WHERE conversations.id = $1
        AND (
          conversations.homeowner_id = $2
          OR conversations.professional_user_id = $2
        )
      LIMIT 1
      FOR UPDATE
      `,
      [conversationId, senderUserId]
    );

    if (conversationResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "CONVERSATION_NOT_FOUND",
        message: "The conversation was not found.",
      };
    }

    const conversation = conversationResult.rows[0];

    if (conversation.status !== "active") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "CONVERSATION_CLOSED",
        message:
          "Messages cannot be sent to a closed conversation.",
      };
    }

    const receiverId =
      Number(conversation.homeowner_id) === senderUserId
        ? parsePositiveInteger(
            conversation.professional_user_id
          )
        : parsePositiveInteger(
            conversation.homeowner_id
          );

    if (!receiverId || receiverId === senderUserId) {
      throw new Error(
        "The canonical message recipient could not be resolved."
      );
    }

    const messageResult = await client.query(
      `
      INSERT INTO messages
      (
        quote_request_id,
        conversation_id,
        sender_id,
        receiver_id,
        message_text,
        image_url,
        message_type,
        workflow_type,
        workflow_status,
        workflow_payload
      )
      VALUES
      (
        NULL,
        $1,
        $2,
        $3,
        $4,
        NULL,
        'text',
        NULL,
        NULL,
        '{}'::jsonb
      )
      RETURNING
        id,
        sender_id,
        receiver_id,
        message_text,
        image_url,
        message_type,
        workflow_type,
        workflow_status,
        workflow_payload,
        created_at
      `,
      [
        conversation.id,
        senderUserId,
        receiverId,
        validation.value.messageText,
      ]
    );

    const message = messageResult.rows[0];

    if (!message) {
      throw new Error(
        "The canonical message was not returned after insertion."
      );
    }

    const activityResult = await client.query(
      `
      UPDATE conversations
      SET updated_at = COALESCE($2, CURRENT_TIMESTAMP)
      WHERE id = $1
      `,
      [conversation.id, message.created_at || null]
    );

    if (activityResult.rowCount === 0) {
      throw new Error(
        "Conversation activity could not be updated."
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      status: 201,
      code: "CONVERSATION_MESSAGE_CREATED",
      conversationId: conversation.id,
      message,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original operation error.
    }

    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
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
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_MESSAGE_PAGE_SIZE,
  createConversationMessage,
  decodeMessageCursor,
  encodeMessageCursor,
  listConversationMessages,
  parseMessagePageSize,
  validateConversationMessageInput,
};
