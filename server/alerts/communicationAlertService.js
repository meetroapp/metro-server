"use strict";

const {
  parsePositiveSafeInteger,
  requireDatabasePool,
} = require("./alertContracts");
const {
  normalizeSafePayload,
} = require("./alertPayload");
const {
  createAlert,
} = require("./alertService");

const COMMUNICATION_ALERT_POLICY = Object.freeze({
  sourceDomain: "communication",
  sourceEventType: "conversation.message_created",
  sourceEntityType: "conversation",
  category: "communication",
  priority: "normal",
  titleKey: "alerts.communication.newMessage.title",
  messageKey: "alerts.communication.newMessage.message",
});

const GENERIC_MESSAGE_PREVIEW = "New message";
const MAX_MESSAGE_PREVIEW_LENGTH = 160;

function invalidCommunicationIdentity() {
  throw new TypeError(
    "Canonical communication identity is required."
  );
}

function resolveCommunicationRecipient(
  conversation = {},
  rawSenderUserId
) {
  const senderUserId = parsePositiveSafeInteger(rawSenderUserId);
  const homeownerId = parsePositiveSafeInteger(
    conversation.homeowner_id
  );
  const professionalUserId = parsePositiveSafeInteger(
    conversation.professional_user_id
  );

  if (
    !senderUserId ||
    !homeownerId ||
    !professionalUserId ||
    homeownerId === professionalUserId
  ) {
    return null;
  }

  if (senderUserId === homeownerId) return professionalUserId;
  if (senderUserId === professionalUserId) return homeownerId;
  return null;
}

function buildCommunicationAttentionDedupeKey({
  conversationId: rawConversationId,
  recipientUserId: rawRecipientUserId,
  lastReadMessageId: rawLastReadMessageId = null,
}) {
  const conversationId = parsePositiveSafeInteger(rawConversationId);
  const recipientUserId = parsePositiveSafeInteger(rawRecipientUserId);
  const lastReadMessageId =
    rawLastReadMessageId === null ||
    rawLastReadMessageId === undefined
      ? 0
      : parsePositiveSafeInteger(rawLastReadMessageId);

  if (!conversationId || !recipientUserId || lastReadMessageId === null) {
    return invalidCommunicationIdentity();
  }

  return [
    "communication",
    "conversation",
    conversationId,
    "recipient",
    recipientUserId,
    "after",
    lastReadMessageId,
  ].join(":");
}

function buildCommunicationSafePreview(message = {}) {
  if (
    message.message_type !== "text" ||
    typeof message.message_text !== "string"
  ) {
    return GENERIC_MESSAGE_PREVIEW;
  }

  const candidate = message.message_text
    .trim()
    .slice(0, MAX_MESSAGE_PREVIEW_LENGTH);
  if (!candidate) return GENERIC_MESSAGE_PREVIEW;

  const normalized = normalizeSafePayload({
    shortPreview: candidate,
  });
  return normalized.error
    ? GENERIC_MESSAGE_PREVIEW
    : normalized.value.shortPreview;
}

async function getCommunicationAttentionWindowWithClient({
  client,
  conversationId: rawConversationId,
  recipientUserId: rawRecipientUserId,
}) {
  const conversationId = parsePositiveSafeInteger(rawConversationId);
  const recipientUserId = parsePositiveSafeInteger(rawRecipientUserId);
  if (!conversationId || !recipientUserId) {
    return invalidCommunicationIdentity();
  }

  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT last_read_message_id
    FROM conversation_participant_state
    WHERE conversation_id = $1
      AND user_id = $2
    LIMIT 1
    FOR UPDATE
    `,
    [conversationId, recipientUserId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      "Canonical recipient participant state is unavailable."
    );
  }

  const lastReadMessageId =
    row.last_read_message_id === null ||
    row.last_read_message_id === undefined
      ? null
      : parsePositiveSafeInteger(row.last_read_message_id);
  if (
    row.last_read_message_id !== null &&
    row.last_read_message_id !== undefined &&
    !lastReadMessageId
  ) {
    throw new Error(
      "Canonical recipient read marker is invalid."
    );
  }

  return { lastReadMessageId };
}

async function countUnreadCommunicationMessagesAfterBoundary({
  client,
  conversationId,
  senderUserId,
  recipientUserId,
  lastReadMessageId,
}) {
  const canonicalSenderUserId = parsePositiveSafeInteger(senderUserId);
  const canonicalRecipientUserId = parsePositiveSafeInteger(
    recipientUserId
  );
  if (
    !canonicalSenderUserId ||
    !canonicalRecipientUserId ||
    canonicalSenderUserId === canonicalRecipientUserId
  ) {
    return invalidCommunicationIdentity();
  }
  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT COUNT(*)::bigint AS unread_count
    FROM messages
    INNER JOIN conversations
      ON conversations.id = messages.conversation_id
    WHERE messages.conversation_id = $1
      AND messages.receiver_id = $2
      AND messages.sender_id = CASE
        WHEN conversations.homeowner_id = $2
          THEN conversations.professional_user_id
        WHEN conversations.professional_user_id = $2
          THEN conversations.homeowner_id
        ELSE NULL
      END
      AND messages.id > COALESCE($3::integer, 0)
    `,
    [conversationId, canonicalRecipientUserId, lastReadMessageId]
  );
  const unreadCount = Number(result.rows[0]?.unread_count);
  if (!Number.isSafeInteger(unreadCount) || unreadCount < 1) {
    throw new Error(
      "Canonical communication unread count is invalid."
    );
  }
  return unreadCount;
}

function requireCanonicalMessageAlertIdentity({
  conversation,
  senderUserId: rawSenderUserId,
  recipientUserId: rawRecipientUserId,
  recipientLastReadMessageId,
  message,
}) {
  const conversationId = parsePositiveSafeInteger(conversation?.id);
  const senderUserId = parsePositiveSafeInteger(rawSenderUserId);
  const recipientUserId = parsePositiveSafeInteger(rawRecipientUserId);
  const expectedRecipientId = resolveCommunicationRecipient(
    conversation,
    senderUserId
  );
  const messageId = parsePositiveSafeInteger(message?.id);
  const messageSenderId = parsePositiveSafeInteger(message?.sender_id);
  const messageReceiverId = parsePositiveSafeInteger(message?.receiver_id);
  const lastReadMessageId =
    recipientLastReadMessageId === null ||
    recipientLastReadMessageId === undefined
      ? null
      : parsePositiveSafeInteger(recipientLastReadMessageId);

  if (
    !conversationId ||
    !senderUserId ||
    !recipientUserId ||
    expectedRecipientId !== recipientUserId ||
    !messageId ||
    messageSenderId !== senderUserId ||
    messageReceiverId !== recipientUserId ||
    (
      recipientLastReadMessageId !== null &&
      recipientLastReadMessageId !== undefined &&
      !lastReadMessageId
    )
  ) {
    return invalidCommunicationIdentity();
  }

  return {
    conversationId,
    senderUserId,
    recipientUserId,
    messageId,
    lastReadMessageId,
  };
}

async function refreshCommunicationAlertPresentationWithClient({
  client,
  alertId,
  recipientUserId,
  conversationId,
  messageId,
  dedupeKey,
  safePayload,
  availableAt,
}) {
  const result = await client.query(
    `
    UPDATE alerts
    SET
      source_event_id = $4,
      safe_payload = $5::jsonb,
      available_at = COALESCE($6::timestamp, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND recipient_user_id = $2
      AND dedupe_key = $3
      AND source_domain = 'communication'
      AND source_event_type = 'conversation.message_created'
      AND source_entity_type = 'conversation'
      AND source_entity_id = $7
      AND destination_type = 'conversation'
      AND destination_payload = jsonb_build_object(
        'conversationId',
        $8::integer
      )
      AND archived_at IS NULL
      AND resolved_at IS NULL
      AND lifecycle_state IN ('active', 'dismissed')
    RETURNING id, lifecycle_state
    `,
    [
      alertId,
      recipientUserId,
      dedupeKey,
      String(messageId),
      JSON.stringify(safePayload),
      availableAt || null,
      String(conversationId),
      conversationId,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(
      "Canonical communication alert could not be refreshed."
    );
  }
  return row;
}

async function createOrRefreshCommunicationMessageAlert({
  client,
  conversation,
  senderUserId,
  recipientUserId,
  recipientLastReadMessageId,
  message,
}) {
  requireDatabasePool(client);
  const identity = requireCanonicalMessageAlertIdentity({
    conversation,
    senderUserId,
    recipientUserId,
    recipientLastReadMessageId,
    message,
  });
  const dedupeKey = buildCommunicationAttentionDedupeKey({
    conversationId: identity.conversationId,
    recipientUserId: identity.recipientUserId,
    lastReadMessageId: identity.lastReadMessageId,
  });
  const unreadCount = await countUnreadCommunicationMessagesAfterBoundary({
    client,
    conversationId: identity.conversationId,
    senderUserId: identity.senderUserId,
    recipientUserId: identity.recipientUserId,
    lastReadMessageId: identity.lastReadMessageId,
  });
  const safePayloadResult = normalizeSafePayload({
    shortPreview: buildCommunicationSafePreview(message),
    unreadCount,
  });
  if (safePayloadResult.error) {
    throw new Error(
      "Canonical communication alert payload is invalid."
    );
  }

  const created = await createAlert({
    client,
    input: {
      recipientUserId: identity.recipientUserId,
      sourceDomain: COMMUNICATION_ALERT_POLICY.sourceDomain,
      sourceEventType: COMMUNICATION_ALERT_POLICY.sourceEventType,
      sourceEntityType: COMMUNICATION_ALERT_POLICY.sourceEntityType,
      sourceEntityId: String(identity.conversationId),
      sourceEventId: String(identity.messageId),
      category: COMMUNICATION_ALERT_POLICY.category,
      priority: COMMUNICATION_ALERT_POLICY.priority,
      titleKey: COMMUNICATION_ALERT_POLICY.titleKey,
      messageKey: COMMUNICATION_ALERT_POLICY.messageKey,
      safePayload: safePayloadResult.value,
      destination: {
        type: "conversation",
        payload: {
          conversationId: identity.conversationId,
        },
      },
      dedupeKey,
      availableAt: message.created_at || null,
      expiresAt: null,
    },
  });
  if (!created.ok) {
    throw new Error(
      "Canonical communication alert could not be created."
    );
  }
  if (created.created) return created;

  const alertId = parsePositiveSafeInteger(created.alert?.id);
  if (!alertId) {
    throw new Error(
      "Canonical communication alert identity is invalid."
    );
  }
  const refreshed = await refreshCommunicationAlertPresentationWithClient({
    client,
    alertId,
    recipientUserId: identity.recipientUserId,
    conversationId: identity.conversationId,
    messageId: identity.messageId,
    dedupeKey,
    safePayload: safePayloadResult.value,
    availableAt: message.created_at || null,
  });
  return {
    ok: true,
    status: 200,
    code: "COMMUNICATION_ALERT_REFRESHED",
    created: false,
    alertId: String(refreshed.id),
    lifecycle: refreshed.lifecycle_state,
  };
}

async function resolveCommunicationMessageAlerts({
  client,
  conversationId: rawConversationId,
  recipientUserId: rawRecipientUserId,
  senderUserId: rawSenderUserId,
  lastReadMessageId: rawLastReadMessageId,
}) {
  const conversationId = parsePositiveSafeInteger(rawConversationId);
  const recipientUserId = parsePositiveSafeInteger(rawRecipientUserId);
  const senderUserId = parsePositiveSafeInteger(rawSenderUserId);
  const lastReadMessageId = parsePositiveSafeInteger(
    rawLastReadMessageId
  );
  if (
    !conversationId ||
    !recipientUserId ||
    !senderUserId ||
    senderUserId === recipientUserId ||
    !lastReadMessageId
  ) {
    return invalidCommunicationIdentity();
  }
  requireDatabasePool(client);

  const alertResult = await client.query(
    `
    SELECT
      alerts.id,
      alerts.source_event_id,
      alerts.dedupe_key,
      alerts.safe_payload,
      source_message.id AS source_message_id,
      source_message.conversation_id AS source_conversation_id,
      source_message.sender_id AS source_sender_id,
      source_message.receiver_id AS source_receiver_id,
      source_message.message_type AS source_message_type,
      source_message.message_text AS source_message_text
    FROM alerts
    LEFT JOIN messages AS source_message
      ON source_message.id::text = alerts.source_event_id
    WHERE alerts.source_domain = 'communication'
      AND alerts.source_event_type = 'conversation.message_created'
      AND alerts.source_entity_type = 'conversation'
      AND alerts.source_entity_id = $1
      AND alerts.recipient_user_id = $2
      AND alerts.lifecycle_state IN ('active', 'dismissed')
      AND alerts.archived_at IS NULL
      AND alerts.resolved_at IS NULL
    ORDER BY alerts.id ASC
    FOR UPDATE OF alerts
    `,
    [String(conversationId), recipientUserId]
  );

  const resolvableAlertIds = [];
  const newerAlerts = [];

  for (const row of alertResult.rows) {
    const alertId = parsePositiveSafeInteger(row.id);
    const sourceEventId = parsePositiveSafeInteger(
      row.source_event_id
    );
    const sourceMessageId = parsePositiveSafeInteger(
      row.source_message_id
    );
    const sourceConversationId = parsePositiveSafeInteger(
      row.source_conversation_id
    );
    const sourceReceiverId = parsePositiveSafeInteger(
      row.source_receiver_id
    );
    const sourceSenderId = parsePositiveSafeInteger(
      row.source_sender_id
    );

    if (
      !alertId ||
      !sourceEventId ||
      sourceMessageId !== sourceEventId ||
      sourceConversationId !== conversationId ||
      sourceSenderId !== senderUserId ||
      sourceReceiverId !== recipientUserId
    ) {
      throw new Error(
        "Canonical communication alert source is invalid."
      );
    }

    if (sourceEventId <= lastReadMessageId) {
      resolvableAlertIds.push(alertId);
    } else {
      newerAlerts.push({
        ...row,
        alertId,
        sourceEventId,
      });
    }
  }

  if (newerAlerts.length > 1) {
    throw new Error(
      "Canonical communication attention window is ambiguous."
    );
  }

  let resolvedCount = 0;
  if (resolvableAlertIds.length > 0) {
    const resolved = await client.query(
      `
      UPDATE alerts
      SET
        lifecycle_state = 'resolved',
        resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1::bigint[])
        AND recipient_user_id = $2
        AND source_domain = 'communication'
        AND source_event_type = 'conversation.message_created'
        AND source_entity_type = 'conversation'
        AND source_entity_id = $3
        AND lifecycle_state IN ('active', 'dismissed')
        AND archived_at IS NULL
        AND resolved_at IS NULL
      RETURNING id
      `,
      [
        resolvableAlertIds,
        recipientUserId,
        String(conversationId),
      ]
    );

    if (resolved.rows.length !== resolvableAlertIds.length) {
      throw new Error(
        "Canonical communication alerts could not be resolved."
      );
    }
    resolvedCount = resolved.rows.length;
  }

  if (newerAlerts.length === 1) {
    const newerAlert = newerAlerts[0];
    const dedupeKey = buildCommunicationAttentionDedupeKey({
      conversationId,
      recipientUserId,
      lastReadMessageId,
    });
    const conflictResult = await client.query(
      `
      SELECT id
      FROM alerts
      WHERE recipient_user_id = $1
        AND dedupe_key = $2
        AND archived_at IS NULL
        AND resolved_at IS NULL
        AND lifecycle_state IN ('active', 'dismissed')
      ORDER BY id ASC
      FOR UPDATE
      `,
      [recipientUserId, dedupeKey]
    );
    if (
      conflictResult.rows.some(
        (row) =>
          parsePositiveSafeInteger(row.id) !==
          newerAlert.alertId
      )
    ) {
      throw new Error(
        "Canonical communication attention window conflicts."
      );
    }

    const unreadCount =
      await countUnreadCommunicationMessagesAfterBoundary({
        client,
        conversationId,
        senderUserId,
        recipientUserId,
        lastReadMessageId,
      });
    const safePayloadResult = normalizeSafePayload({
      shortPreview: buildCommunicationSafePreview({
        message_type: newerAlert.source_message_type,
        message_text: newerAlert.source_message_text,
      }),
      unreadCount,
    });
    if (safePayloadResult.error) {
      throw new Error(
        "Canonical communication alert payload is invalid."
      );
    }

    const currentSafePayloadResult = normalizeSafePayload(
      newerAlert.safe_payload
    );
    const currentSafePayload = currentSafePayloadResult.value;
    const targetSafePayload = safePayloadResult.value;
    const currentPayloadKeys = currentSafePayloadResult.error
      ? []
      : Object.keys(currentSafePayload);
    const safePayloadMatches =
      !currentSafePayloadResult.error &&
      currentPayloadKeys.length === 2 &&
      currentPayloadKeys.includes("shortPreview") &&
      currentPayloadKeys.includes("unreadCount") &&
      currentSafePayload.shortPreview ===
        targetSafePayload.shortPreview &&
      currentSafePayload.unreadCount === targetSafePayload.unreadCount;

    if (
      newerAlert.dedupe_key !== dedupeKey ||
      !safePayloadMatches
    ) {
      const rebased = await client.query(
        `
        UPDATE alerts
        SET
          dedupe_key = $3,
          safe_payload = $4::jsonb,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND recipient_user_id = $2
          AND source_domain = 'communication'
          AND source_event_type = 'conversation.message_created'
          AND source_entity_type = 'conversation'
          AND source_entity_id = $5
          AND source_event_id = $6
          AND lifecycle_state IN ('active', 'dismissed')
          AND archived_at IS NULL
          AND resolved_at IS NULL
        RETURNING id, lifecycle_state, source_event_id
        `,
        [
          newerAlert.alertId,
          recipientUserId,
          dedupeKey,
          JSON.stringify(targetSafePayload),
          String(conversationId),
          String(newerAlert.sourceEventId),
        ]
      );
      if (rebased.rows.length !== 1) {
        throw new Error(
          "Canonical communication attention could not be rebased."
        );
      }
    }
  }

  return {
    count: resolvedCount,
    preservedCount: newerAlerts.length,
  };
}

module.exports = {
  COMMUNICATION_ALERT_POLICY,
  GENERIC_MESSAGE_PREVIEW,
  MAX_MESSAGE_PREVIEW_LENGTH,
  buildCommunicationAttentionDedupeKey,
  buildCommunicationSafePreview,
  createOrRefreshCommunicationMessageAlert,
  getCommunicationAttentionWindowWithClient,
  resolveCommunicationMessageAlerts,
  resolveCommunicationRecipient,
};
