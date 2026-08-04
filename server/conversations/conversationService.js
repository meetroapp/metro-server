"use strict";

const { parsePositiveInteger } = require("./conversations");
const {
  ensureConversationParticipantStatesWithClient,
} = require("./conversationParticipantStateService");

const LAST_MESSAGE_PREVIEW_LENGTH = 160;

function requireDatabasePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

function hasExactlyOneRelationshipSource(relationship = {}) {
  const hasPost = parsePositiveInteger(relationship.post_id) !== null;
  const hasEmergency =
    parsePositiveInteger(relationship.emergency_request_id) !== null;
  return hasPost !== hasEmergency;
}

async function ensureConversationWithClient({
  client,
  relationshipId: rawRelationshipId,
}) {
  const relationshipId = parsePositiveInteger(rawRelationshipId);
  if (!relationshipId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_RELATIONSHIP_ID",
      message: "A valid relationship ID is required.",
    };
  }
  requireDatabasePool(client);

  const relationshipResult = await client.query(
    `
    SELECT
      id,
      post_id,
      emergency_request_id,
      homeowner_id,
      contractor_id,
      professional_user_id,
      status
    FROM request_relationships
    WHERE id = $1
      AND status = 'active'
    LIMIT 1
    FOR UPDATE
    `,
    [relationshipId]
  );

  if (relationshipResult.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "ACTIVE_RELATIONSHIP_NOT_FOUND",
      message:
        "An active relationship is required to create a conversation.",
    };
  }

  const relationship = relationshipResult.rows[0];
  if (!hasExactlyOneRelationshipSource(relationship)) {
    return {
      ok: false,
      status: 409,
      code: "RELATIONSHIP_SOURCE_INVALID",
      message: "The relationship source is invalid.",
    };
  }

  const conversationResult = await client.query(
    `
    WITH inserted AS (
      INSERT INTO conversations
      (
        relationship_id,
        homeowner_id,
        contractor_id,
        professional_user_id,
        status
      )
      VALUES ($1, $2, $3, $4, 'active')
      ON CONFLICT (relationship_id)
      DO NOTHING
      RETURNING *, TRUE AS created
    )
    SELECT * FROM inserted

    UNION ALL

    SELECT conversations.*, FALSE AS created
    FROM conversations
    WHERE relationship_id = $1

    LIMIT 1
    `,
    [
      relationship.id,
      relationship.homeowner_id,
      relationship.contractor_id,
      relationship.professional_user_id,
    ]
  );

  const conversation = conversationResult.rows[0];
  if (!conversation) {
    throw new Error(
      "The conversation could not be created or resolved."
    );
  }

  await ensureConversationParticipantStatesWithClient({
    client,
    conversationId: conversation.id,
  });

  return {
    ok: true,
    status: conversation.created ? 201 : 200,
    code: conversation.created ? "CONVERSATION_CREATED" : "CONVERSATION_EXISTS",
    created: Boolean(conversation.created),
    conversation,
  };
}

async function ensureConversation({
  pool,
  relationshipId: rawRelationshipId,
}) {
  const relationshipId = parsePositiveInteger(rawRelationshipId);
  if (!relationshipId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_RELATIONSHIP_ID",
      message: "A valid relationship ID is required.",
    };
  }
  requireDatabasePool(pool);
  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;
  try {
    await client.query("BEGIN");
    const result = await ensureConversationWithClient({ client, relationshipId });
    if (!result.ok) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original persistence error.
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

const SOURCE_PROJECTION = `
  request_relationships.post_id,
  request_relationships.emergency_request_id,
  request_relationships.status AS source_relationship_status,
  CASE
    WHEN request_relationships.emergency_request_id IS NOT NULL THEN 'emergency'
    ELSE 'request'
  END AS source_type,
  CASE
    WHEN request_relationships.emergency_request_id IS NOT NULL THEN emergency_requests.title
    ELSE posts.title
  END AS request_title,
  CASE
    WHEN request_relationships.emergency_request_id IS NOT NULL THEN emergency_requests.service_domain
    ELSE posts.service_domain
  END AS source_service_domain,
  CASE
    WHEN request_relationships.emergency_request_id IS NOT NULL THEN emergency_requests.service_specialty
    ELSE posts.service_specialty
  END AS source_service_specialty,
  emergency_requests.status AS source_workflow_status,
  emergency_requests.assigned_at AS source_assigned_at,
  emergency_requests.en_route_at AS source_en_route_at,
  emergency_requests.arrived_at AS source_arrived_at,
  emergency_requests.work_started_at AS source_work_started_at,
  emergency_requests.completed_at AS source_completed_at,
  emergency_requests.location_text AS source_location_text,
  emergency_requests.unit_number AS source_unit_number,
  emergency_requests.access_notes AS source_access_notes
`;

const SOURCE_JOINS = `
  LEFT JOIN posts
    ON request_relationships.post_id = posts.id
  LEFT JOIN emergency_requests
    ON request_relationships.emergency_request_id = emergency_requests.id
`;

const PARTICIPANT_MESSAGE_PROJECTION = `
  latest_message.last_message_preview,
  CASE
    WHEN participant_state.user_id IS NULL THEN 0
    ELSE COALESCE(unread_messages.unread_count, 0)
  END AS unread_count
`;

const PARTICIPANT_MESSAGE_JOINS = `
  LEFT JOIN conversation_participant_state AS participant_state
    ON participant_state.conversation_id = conversations.id
    AND participant_state.user_id = $1
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN
          messages.message_type = 'text'
          AND NULLIF(TRIM(messages.message_text), '') IS NOT NULL
          THEN LEFT(
            messages.message_text,
            ${LAST_MESSAGE_PREVIEW_LENGTH}
          )
        ELSE NULL
      END AS last_message_preview
    FROM messages
    WHERE messages.conversation_id = conversations.id
    ORDER BY messages.id DESC
    LIMIT 1
  ) AS latest_message ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::integer AS unread_count
    FROM messages
    WHERE messages.conversation_id = conversations.id
      AND messages.sender_id <> $1
      AND participant_state.user_id IS NOT NULL
      AND messages.id > COALESCE(
        participant_state.last_read_message_id,
        0
      )
  ) AS unread_messages ON TRUE
`;

async function listHomeownerConversations({
  pool,
  homeownerUserId,
  includeArchived = false,
}) {
  requireDatabasePool(pool);
  const result = await pool.query(
    `
    SELECT
      conversations.id,
      conversations.relationship_id,
      conversations.homeowner_id,
      conversations.contractor_id,
      conversations.professional_user_id,
      ${SOURCE_PROJECTION},
      conversations.status,
      conversations.homeowner_archived_at,
      conversations.professional_archived_at,
      conversations.closed_at,
      conversations.created_at,
      conversations.updated_at,
      ${PARTICIPANT_MESSAGE_PROJECTION},
      contractor_profiles.business_name,
      contractor_profiles.image_url AS business_image_url,
      contractor_profiles.category AS professional_category
    FROM conversations
    JOIN contractor_profiles
      ON conversations.contractor_id = contractor_profiles.id
    JOIN request_relationships
      ON conversations.relationship_id = request_relationships.id
    ${SOURCE_JOINS}
    ${PARTICIPANT_MESSAGE_JOINS}
    WHERE conversations.homeowner_id = $1
      AND request_relationships.homeowner_id = $1
      AND contractor_profiles.user_id = conversations.professional_user_id
      AND request_relationships.homeowner_id = conversations.homeowner_id
      AND request_relationships.contractor_id = conversations.contractor_id
      AND request_relationships.professional_user_id = conversations.professional_user_id
      AND (
        (
          request_relationships.post_id IS NOT NULL
          AND request_relationships.emergency_request_id IS NULL
        )
        OR
        (
          request_relationships.post_id IS NULL
          AND request_relationships.emergency_request_id IS NOT NULL
          AND request_relationships.status = 'active'
        )
      )
      AND (
        (request_relationships.post_id IS NOT NULL AND posts.user_id = $1)
        OR
        (request_relationships.emergency_request_id IS NOT NULL AND emergency_requests.homeowner_id = $1)
      )
      AND ($2::boolean = TRUE OR conversations.homeowner_archived_at IS NULL)
    ORDER BY conversations.updated_at DESC, conversations.id DESC
    `,
    [homeownerUserId, Boolean(includeArchived)]
  );
  return result.rows;
}

async function listProfessionalConversations({
  pool,
  professionalUserId,
  includeArchived = false,
}) {
  requireDatabasePool(pool);
  const result = await pool.query(
    `
    SELECT
      conversations.id,
      conversations.relationship_id,
      conversations.homeowner_id,
      conversations.contractor_id,
      conversations.professional_user_id,
      conversations.status,
      conversations.homeowner_archived_at,
      conversations.professional_archived_at,
      conversations.closed_at,
      conversations.created_at,
      conversations.updated_at,
      ${PARTICIPANT_MESSAGE_PROJECTION},
      ${SOURCE_PROJECTION},
      COALESCE(NULLIF(TRIM(users.username), ''), 'Customer') AS homeowner_display_name
    FROM conversations
    JOIN request_relationships
      ON conversations.relationship_id = request_relationships.id
    JOIN contractor_profiles
      ON conversations.contractor_id = contractor_profiles.id
    ${SOURCE_JOINS}
    ${PARTICIPANT_MESSAGE_JOINS}
    JOIN users
      ON conversations.homeowner_id = users.id
    WHERE conversations.professional_user_id = $1
      AND contractor_profiles.user_id = $1
      AND contractor_profiles.user_id = conversations.professional_user_id
      AND request_relationships.professional_user_id = $1
      AND request_relationships.homeowner_id = conversations.homeowner_id
      AND request_relationships.contractor_id = conversations.contractor_id
      AND request_relationships.professional_user_id = conversations.professional_user_id
      AND (
        (
          request_relationships.post_id IS NOT NULL
          AND request_relationships.emergency_request_id IS NULL
        )
        OR
        (
          request_relationships.post_id IS NULL
          AND request_relationships.emergency_request_id IS NOT NULL
          AND request_relationships.status = 'active'
        )
      )
      AND ($2::boolean = TRUE OR conversations.professional_archived_at IS NULL)
    ORDER BY conversations.updated_at DESC, conversations.id DESC
    `,
    [professionalUserId, Boolean(includeArchived)]
  );
  return result.rows;
}

async function getConversation({
  pool,
  conversationId: rawConversationId,
  participantUserId,
}) {
  const conversationId = parsePositiveInteger(rawConversationId);
  if (!conversationId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CONVERSATION_ID",
      message: "A valid conversation ID is required.",
    };
  }
  requireDatabasePool(pool);
  const result = await pool.query(
    `
    SELECT
      conversations.id,
      conversations.relationship_id,
      conversations.homeowner_id,
      conversations.contractor_id,
      conversations.professional_user_id,
      conversations.status,
      conversations.homeowner_archived_at,
      conversations.professional_archived_at,
      conversations.closed_at,
      conversations.created_at,
      conversations.updated_at,
      ${SOURCE_PROJECTION},
      contractor_profiles.business_name,
      contractor_profiles.image_url AS business_image_url,
      contractor_profiles.category AS professional_category,
      COALESCE(NULLIF(TRIM(users.username), ''), 'Customer') AS homeowner_display_name
    FROM conversations
    JOIN request_relationships
      ON conversations.relationship_id = request_relationships.id
    ${SOURCE_JOINS}
    JOIN contractor_profiles
      ON conversations.contractor_id = contractor_profiles.id
    JOIN users
      ON conversations.homeowner_id = users.id
    WHERE conversations.id = $1
      AND (conversations.homeowner_id = $2 OR conversations.professional_user_id = $2)
      AND contractor_profiles.user_id = conversations.professional_user_id
      AND request_relationships.homeowner_id = conversations.homeowner_id
      AND request_relationships.contractor_id = conversations.contractor_id
      AND request_relationships.professional_user_id = conversations.professional_user_id
      AND (
        (
          request_relationships.post_id IS NOT NULL
          AND request_relationships.emergency_request_id IS NULL
        )
        OR
        (
          request_relationships.post_id IS NULL
          AND request_relationships.emergency_request_id IS NOT NULL
          AND request_relationships.status = 'active'
        )
      )
    LIMIT 1
    `,
    [conversationId, participantUserId]
  );
  if (result.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "CONVERSATION_NOT_FOUND",
      message: "The conversation was not found.",
    };
  }
  return {
    ok: true,
    status: 200,
    code: "CONVERSATION_FOUND",
    conversation: result.rows[0],
  };
}

module.exports = {
  LAST_MESSAGE_PREVIEW_LENGTH,
  ensureConversation,
  ensureConversationWithClient,
  getConversation,
  hasExactlyOneRelationshipSource,
  listHomeownerConversations,
  listProfessionalConversations,
};
