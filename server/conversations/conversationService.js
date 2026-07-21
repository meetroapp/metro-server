"use strict";

const {
  parsePositiveInteger,
} = require("./conversations");

function requireDatabasePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

async function createConversation({
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

    const relationshipResult = await client.query(
      `
      SELECT
        id,
        post_id,
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
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code: "ACTIVE_RELATIONSHIP_NOT_FOUND",
        message: "An active relationship is required to create a conversation.",
      };
    }

    const relationship = relationshipResult.rows[0];

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

    await client.query("COMMIT");

    return {
      ok: true,
      status: conversation.created ? 201 : 200,
      code: conversation.created
        ? "CONVERSATION_CREATED"
        : "CONVERSATION_EXISTS",
      created: Boolean(conversation.created),
      conversation,
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
      conversations.status,
      conversations.homeowner_archived_at,
      conversations.professional_archived_at,
      conversations.closed_at,
      conversations.created_at,
      conversations.updated_at,
      contractor_profiles.business_name,
      contractor_profiles.image_url AS business_image_url,
      contractor_profiles.category AS professional_category
    FROM conversations
    JOIN contractor_profiles
      ON conversations.contractor_id = contractor_profiles.id
    JOIN request_relationships
      ON conversations.relationship_id = request_relationships.id
    WHERE conversations.homeowner_id = $1
      AND request_relationships.homeowner_id = $1
      AND (
        $2::boolean = TRUE
        OR conversations.homeowner_archived_at IS NULL
      )
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
      request_relationships.post_id,
      posts.title AS request_title,
      COALESCE(NULLIF(TRIM(users.username), ''), 'Customer')
        AS homeowner_display_name
    FROM conversations
    JOIN request_relationships
      ON conversations.relationship_id = request_relationships.id
    JOIN contractor_profiles
      ON conversations.contractor_id = contractor_profiles.id
    JOIN posts
      ON request_relationships.post_id = posts.id
    JOIN users
      ON conversations.homeowner_id = users.id
    WHERE conversations.professional_user_id = $1
      AND contractor_profiles.user_id = $1
      AND request_relationships.professional_user_id = $1
      AND (
        $2::boolean = TRUE
        OR conversations.professional_archived_at IS NULL
      )
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
      request_relationships.post_id,
      posts.title AS request_title,
      contractor_profiles.business_name,
      contractor_profiles.image_url AS business_image_url,
      contractor_profiles.category AS professional_category,
      COALESCE(NULLIF(TRIM(users.username), ''), 'Customer')
        AS homeowner_display_name
    FROM conversations
    JOIN request_relationships
      ON conversations.relationship_id = request_relationships.id
    JOIN posts
      ON request_relationships.post_id = posts.id
    JOIN contractor_profiles
      ON conversations.contractor_id = contractor_profiles.id
    JOIN users
      ON conversations.homeowner_id = users.id
    WHERE conversations.id = $1
      AND (
        conversations.homeowner_id = $2
        OR conversations.professional_user_id = $2
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
  createConversation,
  getConversation,
  listHomeownerConversations,
  listProfessionalConversations,
};
