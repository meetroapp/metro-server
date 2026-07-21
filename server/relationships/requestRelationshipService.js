"use strict";

const {
  parsePositiveInteger,
  validateProfessionalResponsePayload,
} = require("./requestRelationships");

const {
  ensureConversationWithClient,
} = require("../conversations/conversationService");

async function createProfessionalRequestRelationship({
  pool,
  professionalUserId,
  postId: rawPostId,
  payload = {},
  professionalCanSeeRequest,
}) {
  const postId = parsePositiveInteger(rawPostId);
  const responseValidation = validateProfessionalResponsePayload(payload);

  if (!postId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REQUEST_ID",
      message: "A valid request ID is required.",
    };
  }

  if (!responseValidation.valid) {
    return {
      ok: false,
      status: 400,
      code: responseValidation.code,
      message: responseValidation.message,
    };
  }

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  if (typeof professionalCanSeeRequest !== "function") {
    throw new TypeError("professionalCanSeeRequest is required.");
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const profileResult = await client.query(
      `
      SELECT id, user_id, category, profile_details
      FROM contractor_profiles
      WHERE user_id = $1
      LIMIT 1
      `,
      [professionalUserId]
    );

    if (profileResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 403,
        code: "PROFESSIONAL_PROFILE_REQUIRED",
        message: "A business profile is required to respond to requests.",
      };
    }

    const profile = profileResult.rows[0];

    const requestResult = await client.query(
      `
      SELECT
        id,
        user_id,
        title,
        description,
        category,
        request_category,
        service_domain,
        service_specialty,
        location,
        status,
        created_at,
        updated_at,
        image_url,
        request_photos
      FROM posts
      WHERE id = $1
        AND status = 'open'
        AND user_id <> $2
      LIMIT 1
      FOR UPDATE
      `,
      [postId, professionalUserId]
    );

    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code: "REQUEST_NOT_AVAILABLE",
        message: "The request is not available for response.",
      };
    }

    const request = requestResult.rows[0];

    if (!professionalCanSeeRequest(profile, request)) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 403,
        code: "REQUEST_NOT_ELIGIBLE",
        message: "This business is not eligible to respond to the request.",
      };
    }

    const relationshipResult = await client.query(
      `
      WITH inserted AS (
        INSERT INTO request_relationships
        (
          post_id,
          homeowner_id,
          contractor_id,
          professional_user_id,
          status,
          introduction_text
        )
        VALUES ($1, $2, $3, $4, 'pending', $5)
        ON CONFLICT (post_id, contractor_id)
        DO NOTHING
        RETURNING *, TRUE AS created
      )
      SELECT * FROM inserted

      UNION ALL

      SELECT request_relationships.*, FALSE AS created
      FROM request_relationships
      WHERE post_id = $1
        AND contractor_id = $3

      LIMIT 1
      `,
      [
        request.id,
        request.user_id,
        profile.id,
        professionalUserId,
        responseValidation.value.introductionText,
      ]
    );

    const relationship = relationshipResult.rows[0];

    if (!relationship) {
      throw new Error(
        "The request relationship could not be created or resolved."
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      status: relationship.created ? 201 : 200,
      code: relationship.created
        ? "REQUEST_RELATIONSHIP_CREATED"
        : "REQUEST_RELATIONSHIP_EXISTS",
      created: Boolean(relationship.created),
      relationship,
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

module.exports = {
  acceptHomeownerRequestRelationship,
  createProfessionalRequestRelationship,
  declineHomeownerRequestRelationship,
  listHomeownerRequestRelationships,
  listProfessionalRequestRelationships,
  updateHomeownerRelationshipStatus,
  withdrawProfessionalRequestRelationship,
};

async function listHomeownerRequestRelationships({
  pool,
  homeownerUserId,
}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const result = await pool.query(
    `
    SELECT
      request_relationships.id,
      request_relationships.post_id,
      request_relationships.contractor_id,
      request_relationships.status,
      request_relationships.introduction_text,
      request_relationships.created_at,
      request_relationships.responded_at,
      request_relationships.accepted_at,
      request_relationships.declined_at,
      request_relationships.withdrawn_at,
      request_relationships.closed_at,
      contractor_profiles.business_name,
      contractor_profiles.category AS professional_category,
      contractor_profiles.image_url AS business_image_url,
      posts.title AS request_title
    FROM request_relationships
    JOIN contractor_profiles
      ON request_relationships.contractor_id = contractor_profiles.id
    JOIN posts
      ON request_relationships.post_id = posts.id
    WHERE request_relationships.homeowner_id = $1
      AND posts.user_id = $1
    ORDER BY request_relationships.created_at DESC
    `,
    [homeownerUserId]
  );

  return result.rows;
}

async function updateHomeownerRelationshipStatus({
  pool,
  homeownerUserId,
  relationshipId: rawRelationshipId,
  action,
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

  const transition =
    action === "accept"
      ? {
          status: "active",
          timestampColumn: "accepted_at",
          code: "REQUEST_RELATIONSHIP_ACCEPTED",
        }
      : action === "decline"
        ? {
            status: "declined",
            timestampColumn: "declined_at",
            code: "REQUEST_RELATIONSHIP_DECLINED",
          }
        : null;

  if (!transition) {
    throw new TypeError("A supported homeowner relationship action is required.");
  }

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const relationshipResult = await client.query(
      `
      SELECT
        request_relationships.id,
        request_relationships.post_id,
        request_relationships.homeowner_id,
        request_relationships.contractor_id,
        request_relationships.professional_user_id,
        request_relationships.status
      FROM request_relationships
      JOIN posts
        ON request_relationships.post_id = posts.id
      WHERE request_relationships.id = $1
        AND request_relationships.homeowner_id = $2
        AND posts.user_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [relationshipId, homeownerUserId]
    );

    if (relationshipResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code: "REQUEST_RELATIONSHIP_NOT_FOUND",
        message: "The professional response was not found.",
      };
    }

    const relationship = relationshipResult.rows[0];

    if (relationship.status !== "pending") {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "REQUEST_RELATIONSHIP_NOT_PENDING",
        message: "This professional response is no longer pending.",
      };
    }

    const updateResult = await client.query(
      `
      UPDATE request_relationships
      SET
        status = $1,
        ${transition.timestampColumn} = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND homeowner_id = $3
        AND status = 'pending'
      RETURNING *
      `,
      [
        transition.status,
        relationshipId,
        homeownerUserId,
      ]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "REQUEST_RELATIONSHIP_NOT_PENDING",
        message: "This professional response is no longer pending.",
      };
    }

    let conversation = null;

    if (action === "accept") {
      const conversationResult =
        await ensureConversationWithClient({
          client,
          relationshipId,
        });

      if (!conversationResult.ok) {
        throw new Error(
          "The accepted relationship conversation could not be ensured."
        );
      }

      conversation = conversationResult.conversation;
    }

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: transition.code,
      relationship: updateResult.rows[0],
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

async function acceptHomeownerRequestRelationship(options) {
  return updateHomeownerRelationshipStatus({
    ...options,
    action: "accept",
  });
}

async function declineHomeownerRequestRelationship(options) {
  return updateHomeownerRelationshipStatus({
    ...options,
    action: "decline",
  });
}

async function listProfessionalRequestRelationships({
  pool,
  professionalUserId,
}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const result = await pool.query(
    `
    SELECT
      request_relationships.id,
      request_relationships.post_id,
      request_relationships.contractor_id,
      request_relationships.professional_user_id,
      request_relationships.status,
      request_relationships.introduction_text,
      request_relationships.created_at,
      request_relationships.responded_at,
      request_relationships.accepted_at,
      request_relationships.declined_at,
      request_relationships.withdrawn_at,
      request_relationships.closed_at,
      posts.title AS request_title,
      posts.description AS request_description,
      posts.request_category,
      posts.service_domain,
      posts.service_specialty
    FROM request_relationships
    JOIN contractor_profiles
      ON request_relationships.contractor_id = contractor_profiles.id
    JOIN posts
      ON request_relationships.post_id = posts.id
    WHERE request_relationships.professional_user_id = $1
      AND contractor_profiles.user_id = $1
    ORDER BY request_relationships.created_at DESC
    `,
    [professionalUserId]
  );

  return result.rows;
}

async function withdrawProfessionalRequestRelationship({
  pool,
  professionalUserId,
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

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const relationshipResult = await client.query(
      `
      SELECT
        request_relationships.id,
        request_relationships.post_id,
        request_relationships.homeowner_id,
        request_relationships.contractor_id,
        request_relationships.professional_user_id,
        request_relationships.status
      FROM request_relationships
      JOIN contractor_profiles
        ON request_relationships.contractor_id = contractor_profiles.id
      WHERE request_relationships.id = $1
        AND request_relationships.professional_user_id = $2
        AND contractor_profiles.user_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [relationshipId, professionalUserId]
    );

    if (relationshipResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code: "REQUEST_RELATIONSHIP_NOT_FOUND",
        message: "The professional response was not found.",
      };
    }

    const relationship = relationshipResult.rows[0];

    if (relationship.status !== "pending") {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "REQUEST_RELATIONSHIP_NOT_PENDING",
        message: "This professional response is no longer pending.",
      };
    }

    const updateResult = await client.query(
      `
      UPDATE request_relationships
      SET
        status = 'withdrawn',
        withdrawn_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND professional_user_id = $2
        AND status = 'pending'
      RETURNING *
      `,
      [relationshipId, professionalUserId]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "REQUEST_RELATIONSHIP_NOT_PENDING",
        message: "This professional response is no longer pending.",
      };
    }

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: "REQUEST_RELATIONSHIP_WITHDRAWN",
      relationship: updateResult.rows[0],
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
