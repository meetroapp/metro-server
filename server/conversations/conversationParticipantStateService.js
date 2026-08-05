"use strict";

const {
  parsePositiveInteger,
} = require("./conversations");
const {
  resolveCommunicationMessageAlerts,
} = require("../alerts/communicationAlertService");

const CONVERSATION_PARTICIPANT_ROLES = Object.freeze({
  HOMEOWNER: "homeowner",
  PROFESSIONAL: "professional",
});

function requireDatabasePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError(
      "A database pool or client is required."
    );
  }
}

function resolveConversationParticipantRole(
  conversation = {},
  participantUserId
) {
  const userId = parsePositiveInteger(participantUserId);

  if (!userId) return null;

  if (
    String(conversation.homeowner_id) === String(userId)
  ) {
    return CONVERSATION_PARTICIPANT_ROLES.HOMEOWNER;
  }

  if (
    String(conversation.professional_user_id) ===
    String(userId)
  ) {
    return CONVERSATION_PARTICIPANT_ROLES.PROFESSIONAL;
  }

  return null;
}

function serializeConversationReadState(row = {}) {
  return {
    lastReadMessageId:
      parsePositiveInteger(row.last_read_message_id),
    lastReadAt: row.last_read_at || null,
  };
}

async function ensureConversationParticipantStatesWithClient({
  client,
  conversationId: rawConversationId,
}) {
  const conversationId = parsePositiveInteger(
    rawConversationId
  );

  if (!conversationId) {
    throw new TypeError(
      "A valid conversation ID is required."
    );
  }

  requireDatabasePool(client);

  await client.query(
    `
    WITH participant_rows AS (
      SELECT
        conversations.id AS conversation_id,
        participants.user_id,
        participants.participant_role
      FROM conversations
      CROSS JOIN LATERAL (
        VALUES
          (
            conversations.homeowner_id,
            'homeowner'
          ),
          (
            conversations.professional_user_id,
            'professional'
          )
      ) AS participants(user_id, participant_role)
      WHERE conversations.id = $1
    ),
    latest_message AS (
      SELECT
        messages.id,
        messages.created_at
      FROM messages
      WHERE messages.conversation_id = $1
      ORDER BY messages.id DESC
      LIMIT 1
    )
    INSERT INTO conversation_participant_state
    (
      conversation_id,
      user_id,
      participant_role,
      last_read_message_id,
      last_read_at
    )
    SELECT
      participant_rows.conversation_id,
      participant_rows.user_id,
      participant_rows.participant_role,
      latest_message.id,
      COALESCE(
        latest_message.created_at,
        CURRENT_TIMESTAMP
      )
    FROM participant_rows
    LEFT JOIN latest_message ON TRUE
    ON CONFLICT (conversation_id, user_id)
    DO NOTHING
    `,
    [conversationId]
  );
}

async function advanceConversationParticipantReadStateWithClient({
  client,
  conversation,
  participantUserId: rawParticipantUserId,
  lastReadMessageId: rawLastReadMessageId = null,
  lastReadAt = null,
}) {
  const conversationId = parsePositiveInteger(
    conversation?.id
  );
  const participantUserId = parsePositiveInteger(
    rawParticipantUserId
  );
  const participantRole =
    resolveConversationParticipantRole(
      conversation,
      participantUserId
    );
  const lastReadMessageId =
    rawLastReadMessageId === null ||
    rawLastReadMessageId === undefined
      ? null
      : parsePositiveInteger(rawLastReadMessageId);

  if (!conversationId || !participantUserId || !participantRole) {
    throw new TypeError(
      "Canonical conversation participant identity is required."
    );
  }

  if (
    rawLastReadMessageId !== null &&
    rawLastReadMessageId !== undefined &&
    !lastReadMessageId
  ) {
    throw new TypeError(
      "A valid last-read message ID is required."
    );
  }

  requireDatabasePool(client);

  const result = await client.query(
    `
    INSERT INTO conversation_participant_state AS participant_state
    (
      conversation_id,
      user_id,
      participant_role,
      last_read_message_id,
      last_read_at
    )
    SELECT
      conversations.id,
      $2,
      $3,
      $4,
      COALESCE($5::timestamp, CURRENT_TIMESTAMP)
    FROM conversations
    WHERE conversations.id = $1
      AND (
        (
          $3 = 'homeowner'
          AND conversations.homeowner_id = $2
        )
        OR
        (
          $3 = 'professional'
          AND conversations.professional_user_id = $2
        )
      )
      AND (
        $4::integer IS NULL
        OR EXISTS (
          SELECT 1
          FROM messages
          WHERE messages.id = $4
            AND messages.conversation_id = $1
        )
      )
    ON CONFLICT (conversation_id, user_id)
    DO UPDATE SET
      participant_role = EXCLUDED.participant_role,
      last_read_message_id = CASE
        WHEN EXCLUDED.last_read_message_id IS NULL
          THEN participant_state.last_read_message_id
        WHEN participant_state.last_read_message_id IS NULL
          THEN EXCLUDED.last_read_message_id
        ELSE GREATEST(
          participant_state.last_read_message_id,
          EXCLUDED.last_read_message_id
        )
      END,
      last_read_at = CASE
        WHEN
          participant_state.last_read_message_id IS NULL
          AND EXCLUDED.last_read_message_id IS NULL
          THEN COALESCE(
            participant_state.last_read_at,
            EXCLUDED.last_read_at
          )
        WHEN
          participant_state.last_read_message_id IS NULL
          AND EXCLUDED.last_read_message_id IS NOT NULL
          THEN EXCLUDED.last_read_at
        WHEN EXCLUDED.last_read_message_id IS NULL
          THEN participant_state.last_read_at
        WHEN
          EXCLUDED.last_read_message_id >
          participant_state.last_read_message_id
          THEN EXCLUDED.last_read_at
        ELSE participant_state.last_read_at
      END,
      updated_at = CASE
        WHEN
          participant_state.last_read_message_id IS NULL
          AND EXCLUDED.last_read_message_id IS NULL
          AND participant_state.last_read_at IS NULL
          THEN CURRENT_TIMESTAMP
        WHEN
          participant_state.last_read_message_id IS NULL
          AND EXCLUDED.last_read_message_id IS NOT NULL
          THEN CURRENT_TIMESTAMP
        WHEN
          EXCLUDED.last_read_message_id >
          participant_state.last_read_message_id
          THEN CURRENT_TIMESTAMP
        ELSE participant_state.updated_at
      END
    WHERE
      participant_state.participant_role IS DISTINCT FROM
        EXCLUDED.participant_role
      OR (
        EXCLUDED.last_read_message_id IS NOT NULL
        AND (
          participant_state.last_read_message_id IS NULL
          OR EXCLUDED.last_read_message_id >
            participant_state.last_read_message_id
        )
      )
      OR (
        participant_state.last_read_message_id IS NULL
        AND EXCLUDED.last_read_message_id IS NULL
        AND participant_state.last_read_at IS NULL
        AND EXCLUDED.last_read_at IS NOT NULL
      )
    RETURNING
      conversation_id,
      user_id,
      participant_role,
      last_read_message_id,
      last_read_at
    `,
    [
      conversationId,
      participantUserId,
      participantRole,
      lastReadMessageId,
      lastReadAt,
    ]
  );

  if (result.rows.length === 0) {
    const currentResult = await client.query(
      `
      SELECT
        conversation_id,
        user_id,
        participant_role,
        last_read_message_id,
        last_read_at
      FROM conversation_participant_state
      WHERE conversation_id = $1
        AND user_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [conversationId, participantUserId]
    );
    if (currentResult.rows.length === 0) {
      throw new Error(
        "The canonical conversation read state could not be advanced."
      );
    }
    return currentResult.rows[0];
  }

  return result.rows[0];
}

async function markConversationRead({
  pool,
  conversationId: rawConversationId,
  participantUserId: rawParticipantUserId,
  lastReadMessageId: rawLastReadMessageId,
}) {
  const conversationId = parsePositiveInteger(
    rawConversationId
  );
  const participantUserId = parsePositiveInteger(
    rawParticipantUserId
  );
  const lastReadMessageId =
    typeof rawLastReadMessageId === "number" &&
    Number.isSafeInteger(rawLastReadMessageId) &&
    rawLastReadMessageId > 0
      ? rawLastReadMessageId
      : null;

  if (!conversationId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CONVERSATION_ID",
      message: "A valid conversation ID is required.",
    };
  }

  if (!participantUserId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PARTICIPANT_USER_ID",
      message: "A valid participant user ID is required.",
    };
  }

  if (!lastReadMessageId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_LAST_READ_MESSAGE_ID",
      message: "A valid last-read message ID is required.",
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
      [conversationId, participantUserId]
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
    const participantRole = resolveConversationParticipantRole(
      conversation,
      participantUserId
    );
    const oppositeParticipantUserId = parsePositiveInteger(
      participantRole === CONVERSATION_PARTICIPANT_ROLES.HOMEOWNER
        ? conversation.professional_user_id
        : conversation.homeowner_id
    );
    if (
      !participantRole ||
      !oppositeParticipantUserId ||
      oppositeParticipantUserId === participantUserId
    ) {
      throw new Error(
        "Canonical conversation participant relationship is invalid."
      );
    }

    const acknowledgedMessageResult = await client.query(
      `
      SELECT
        messages.id,
        messages.created_at
      FROM messages
      WHERE messages.id = $1
        AND messages.conversation_id = $2
      LIMIT 1
      `,
      [lastReadMessageId, conversation.id]
    );
    const acknowledgedMessage =
      acknowledgedMessageResult.rows[0] || null;

    if (!acknowledgedMessage) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "CONVERSATION_MESSAGE_NOT_FOUND",
        message: "The conversation message was not found.",
      };
    }

    const readState =
      await advanceConversationParticipantReadStateWithClient({
        client,
        conversation,
        participantUserId,
        lastReadMessageId: acknowledgedMessage.id,
        lastReadAt: acknowledgedMessage.created_at,
      });

    const authoritativeReadMessageId = parsePositiveInteger(
      readState.last_read_message_id
    );
    if (!authoritativeReadMessageId) {
      throw new Error(
        "Canonical conversation read state is invalid."
      );
    }

    await resolveCommunicationMessageAlerts({
      client,
      conversationId: conversation.id,
      recipientUserId: participantUserId,
      senderUserId: oppositeParticipantUserId,
      lastReadMessageId: authoritativeReadMessageId,
    });

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: "CONVERSATION_MARKED_READ",
      conversationId: conversation.id,
      acknowledgedMessageId: lastReadMessageId,
      readState:
        serializeConversationReadState(readState),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original operation error.
    }

    throw error;
  } finally {
    if (
      client !== pool &&
      typeof client.release === "function"
    ) {
      client.release();
    }
  }
}

module.exports = {
  CONVERSATION_PARTICIPANT_ROLES,
  advanceConversationParticipantReadStateWithClient,
  ensureConversationParticipantStatesWithClient,
  markConversationRead,
  resolveConversationParticipantRole,
  serializeConversationReadState,
};
