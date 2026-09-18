"use strict";

const {
  ensureConversationWithClient,
} = require("../conversations/conversationService");

function positiveInteger(value) {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function uuid(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? normalized
    : null;
}

function normalizeSourcePost(post = {}) {
  const id = positiveInteger(post.id);
  const homeownerUserId = positiveInteger(post.user_id);
  const contractorProfileId = positiveInteger(
    post.target_contractor_profile_id
  );
  const professionalUserId = positiveInteger(
    post.target_professional_user_id
  );
  const meetroRelationshipId = uuid(
    post.source_meetro_relationship_id
  );

  if (
    !id ||
    !homeownerUserId ||
    post.request_origin !== "existing_customer_request" ||
    !contractorProfileId ||
    !professionalUserId ||
    professionalUserId === homeownerUserId ||
    !meetroRelationshipId
  ) {
    return null;
  }

  return {
    id,
    homeownerUserId,
    contractorProfileId,
    professionalUserId,
    meetroRelationshipId,
  };
}

async function establishExistingCustomerRequestConversation({
  client,
  post,
  ensureConversationImpl = ensureConversationWithClient,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError(
      "A database client is required."
    );
  }

  const source = normalizeSourcePost(post);

  if (!source) {
    throw new Error(
      "Existing Customer Job Request source identity is invalid."
    );
  }

  const relationshipResult = await client.query(
    `
    /* existing_customer_request:create_relationship */
    WITH inserted AS (
      INSERT INTO request_relationships
      (
        post_id,
        homeowner_id,
        contractor_id,
        professional_user_id,
        status,
        introduction_text,
        professional_response_id,
        ordinary_authority_source,
        current_version,
        closure_reason,
        source_meetro_relationship_id,
        accepted_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4,
        'active',
        '',
        NULL,
        'existing_customer_request',
        1,
        NULL,
        $5,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (post_id, contractor_id)
      WHERE post_id IS NOT NULL
      DO NOTHING
      RETURNING *, TRUE AS created
    )
    SELECT * FROM inserted

    UNION ALL

    SELECT
      request_relationships.*,
      FALSE AS created
    FROM request_relationships
    WHERE request_relationships.post_id = $1
      AND request_relationships.homeowner_id = $2
      AND request_relationships.contractor_id = $3
      AND request_relationships.professional_user_id = $4
      AND request_relationships.professional_response_id IS NULL
      AND request_relationships.ordinary_authority_source =
        'existing_customer_request'
      AND request_relationships.source_meetro_relationship_id = $5

    LIMIT 1
    `,
    [
      source.id,
      source.homeownerUserId,
      source.contractorProfileId,
      source.professionalUserId,
      source.meetroRelationshipId,
    ]
  );

  const relationship = relationshipResult.rows[0];

  if (!relationship) {
    throw new Error(
      "Existing Customer Request Relationship could not be created or resolved."
    );
  }

  if (
    positiveInteger(relationship.post_id) !== source.id ||
    positiveInteger(relationship.homeowner_id) !==
      source.homeownerUserId ||
    positiveInteger(relationship.contractor_id) !==
      source.contractorProfileId ||
    positiveInteger(relationship.professional_user_id) !==
      source.professionalUserId ||
    relationship.status !== "active" ||
    relationship.professional_response_id != null ||
    relationship.ordinary_authority_source !==
      "existing_customer_request" ||
    positiveInteger(relationship.current_version) !== 1 ||
    uuid(relationship.source_meetro_relationship_id) !==
      source.meetroRelationshipId
  ) {
    throw new Error(
      "Existing Customer Request Relationship identity is invalid."
    );
  }

  const conversationResult =
    await ensureConversationImpl({
      client,
      relationshipId: relationship.id,
    });

  if (
    !conversationResult?.ok ||
    !conversationResult.conversation
  ) {
    throw new Error(
      "Existing Customer canonical Conversation could not be established."
    );
  }

  const conversation =
    conversationResult.conversation;

  if (
    positiveInteger(conversation.relationship_id) !==
      positiveInteger(relationship.id) ||
    positiveInteger(conversation.homeowner_id) !==
      source.homeownerUserId ||
    positiveInteger(conversation.contractor_id) !==
      source.contractorProfileId ||
    positiveInteger(conversation.professional_user_id) !==
      source.professionalUserId ||
    conversation.status !== "active" ||
    conversation.request_selection_id != null
  ) {
    throw new Error(
      "Existing Customer canonical Conversation identity is invalid."
    );
  }

  return {
    relationship,
    conversation,
    relationshipCreated:
      relationship.created === true,
    conversationCreated:
      conversationResult.created === true,
  };
}

module.exports = {
  establishExistingCustomerRequestConversation,
  normalizeExistingCustomerRequestSourcePost:
    normalizeSourcePost,
};
