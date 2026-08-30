"use strict";

const {
  projectEmergencyResponseAlertWithClient,
} = require("../alerts/opportunityAlertService");

const {
  parsePositiveInteger,
  validateEmergencyResponsePayload,
} = require("./requestRelationships");

async function createProfessionalEmergencyResponse({
  pool,
  professionalUserId,
  emergencyRequestId: rawEmergencyRequestId,
  payload,
  professionalCanSeeEmergencyOpportunity,
  projectEmergencyResponseAlert = projectEmergencyResponseAlertWithClient,
}) {
  const emergencyRequestId = parsePositiveInteger(rawEmergencyRequestId);
  const responseValidation = validateEmergencyResponsePayload(payload);

  if (!emergencyRequestId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_EMERGENCY_REQUEST_ID",
      message: "A valid Emergency request ID is required.",
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

  if (typeof professionalCanSeeEmergencyOpportunity !== "function") {
    throw new TypeError(
      "professionalCanSeeEmergencyOpportunity is required."
    );
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const profileResult = await client.query(
      `
      SELECT
        id,
        user_id,
        category,
        profile_details
      FROM contractor_profiles
      WHERE user_id = $1
      ORDER BY id ASC
      LIMIT 1
      FOR SHARE
      `,
      [professionalUserId]
    );

    if (profileResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 403,
        code: "PROFESSIONAL_PROFILE_REQUIRED",
        message:
          "A business profile is required to respond to Emergency opportunities.",
      };
    }

    const profile = profileResult.rows[0];
    const requestResult = await client.query(
      `
      SELECT
        emergency_requests.id,
        emergency_requests.homeowner_id,
        emergency_requests.category,
        emergency_requests.service_domain,
        emergency_requests.service_specialty,
        emergency_requests.title,
        emergency_requests.description,
        emergency_requests.location_text,
        emergency_requests.status,
        emergency_requests.requested_at,
        emergency_requests.created_at,
        emergency_requests.updated_at,
        emergency_requests.expired_at,
        emergency_request_safety_assessments.disposition
      FROM emergency_requests
      INNER JOIN emergency_request_safety_assessments
        ON emergency_request_safety_assessments.emergency_request_id =
          emergency_requests.id
      WHERE emergency_requests.id = $1
        AND emergency_requests.status = 'ready_for_distribution'
        AND emergency_requests.homeowner_id <> $2
        AND emergency_requests.expired_at IS NULL
        AND emergency_request_safety_assessments.disposition = 'continue'
      LIMIT 1
      FOR UPDATE OF emergency_requests
      `,
      [emergencyRequestId, professionalUserId]
    );

    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "EMERGENCY_OPPORTUNITY_NOT_AVAILABLE",
        message: "The Emergency opportunity is not available for response.",
      };
    }

    const emergencyRequest = requestResult.rows[0];
    if (
      !professionalCanSeeEmergencyOpportunity(
        profile,
        emergencyRequest,
        professionalUserId
      )
    ) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 403,
        code: "EMERGENCY_OPPORTUNITY_NOT_ELIGIBLE",
        message:
          "This business is not eligible to respond to the Emergency opportunity.",
      };
    }

    const relationshipResult = await client.query(
      `
      WITH inserted AS (
        INSERT INTO request_relationships
        (
          post_id,
          emergency_request_id,
          homeowner_id,
          contractor_id,
          professional_user_id,
          status,
          introduction_text
        )
        VALUES (NULL, $1, $2, $3, $4, 'pending', '')
        ON CONFLICT (emergency_request_id, contractor_id)
        WHERE emergency_request_id IS NOT NULL
        DO NOTHING
        RETURNING *, TRUE AS created
      )
      SELECT * FROM inserted

      UNION ALL

      SELECT request_relationships.*, FALSE AS created
      FROM request_relationships
      WHERE emergency_request_id = $1
        AND homeowner_id = $2
        AND contractor_id = $3
        AND professional_user_id = $4

      LIMIT 1
      `,
      [
        emergencyRequest.id,
        emergencyRequest.homeowner_id,
        profile.id,
        professionalUserId,
      ]
    );

    const relationship = relationshipResult.rows[0];
    if (!relationship) {
      throw new Error(
        "The Emergency relationship could not be created or resolved."
      );
    }

    if (relationship.status !== "pending") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_RESPONSE_NOT_PENDING",
        message: "This Emergency response is no longer pending.",
      };
    }

    if (relationship.created) {
      await projectEmergencyResponseAlert({
        client,
        emergencyRequest,
        relationship,
      });
    }

    await client.query("COMMIT");
    return {
      ok: true,
      status: relationship.created ? 201 : 200,
      code: relationship.created
        ? "EMERGENCY_RESPONSE_CREATED"
        : "EMERGENCY_RESPONSE_EXISTS",
      created: Boolean(relationship.created),
      relationship,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

async function listHomeownerEmergencyResponses({
  pool,
  homeownerUserId,
  emergencyRequestId: rawEmergencyRequestId,
}) {
  const emergencyRequestId = parsePositiveInteger(rawEmergencyRequestId);

  if (!emergencyRequestId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_EMERGENCY_REQUEST_ID",
      message: "A valid Emergency request ID is required.",
    };
  }

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const emergencyResult = await pool.query(
    `
    SELECT
      id,
      status
    FROM emergency_requests
    WHERE id = $1
      AND homeowner_id = $2
    LIMIT 1
    `,
    [emergencyRequestId, homeownerUserId]
  );

  if (emergencyResult.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "EMERGENCY_REQUEST_NOT_FOUND",
      message: "The Emergency request was not found.",
    };
  }

  const responseResult = await pool.query(
    `
    SELECT
      request_relationships.id,
      request_relationships.emergency_request_id,
      request_relationships.status,
      request_relationships.responded_at,
      request_relationships.created_at,
      request_relationships.accepted_at,
      request_relationships.declined_at,
      request_relationships.withdrawn_at,
      request_relationships.closed_at,
      contractor_profiles.business_name,
      contractor_profiles.category AS professional_category,
      contractor_profiles.image_url AS business_image_url,
      COALESCE(
        contractor_profiles.profile_details->'service_specialties',
        '[]'::jsonb
      ) AS service_specialties,
      EXISTS (
        SELECT 1
        FROM conversations
        WHERE conversations.relationship_id =
          request_relationships.id
      ) AS canonical_conversation_exists
    FROM request_relationships
    INNER JOIN contractor_profiles
      ON contractor_profiles.id =
        request_relationships.contractor_id
    WHERE request_relationships.emergency_request_id = $1
      AND request_relationships.post_id IS NULL
      AND request_relationships.homeowner_id = $2
    ORDER BY
      request_relationships.responded_at ASC NULLS LAST,
      request_relationships.created_at ASC,
      request_relationships.id ASC
    `,
    [emergencyRequestId, homeownerUserId]
  );

  return {
    ok: true,
    status: 200,
    code: "EMERGENCY_RESPONSES_FOUND",
    emergencyRequest: emergencyResult.rows[0],
    responses: responseResult.rows,
  };
}

module.exports = {
  acceptHomeownerRequestRelationship,
  createProfessionalEmergencyResponse,
  declineHomeownerRequestRelationship,
  listHomeownerEmergencyResponses,
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
      request_relationships.professional_response_id,
      request_relationships.ordinary_authority_source,
      request_relationships.current_version AS relationship_current_version,
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
      posts.title AS request_title,
      professional_responses.id AS response_id,
      professional_responses.status AS response_status,
      professional_responses.current_version AS response_current_version,
      professional_responses.introduction_text AS response_introduction_text,
      professional_responses.submitted_at AS response_submitted_at
    FROM request_relationships
    JOIN contractor_profiles
      ON request_relationships.contractor_id = contractor_profiles.id
    JOIN posts
      ON request_relationships.post_id = posts.id
    LEFT JOIN professional_responses
      ON professional_responses.id =
        request_relationships.professional_response_id
      AND professional_responses.request_relationship_id =
        request_relationships.id
      AND professional_responses.post_id = request_relationships.post_id
      AND professional_responses.homeowner_id =
        request_relationships.homeowner_id
      AND professional_responses.contractor_id =
        request_relationships.contractor_id
      AND professional_responses.professional_user_id =
        request_relationships.professional_user_id
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
        AND request_relationships.professional_response_id IS NULL
        AND request_relationships.ordinary_authority_source IS NULL
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

    if (action === "accept") {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "CANONICAL_RESPONSE_SELECTION_REQUIRED",
        message:
          "Select the exact canonical Professional Response instead.",
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
        AND professional_response_id IS NULL
        AND ordinary_authority_source IS NULL
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

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: transition.code,
      relationship: updateResult.rows[0],
      conversation: null,
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
      request_relationships.professional_response_id,
      request_relationships.ordinary_authority_source,
      request_relationships.current_version AS relationship_current_version,
      professional_responses.id AS response_id,
      professional_responses.status AS response_status,
      professional_responses.current_version AS response_current_version,
      professional_responses.introduction_text
        AS response_introduction_text,
      professional_responses.submitted_at AS response_submitted_at,
      posts.title AS request_title,
      posts.description AS request_description,
      posts.request_category,
      posts.service_domain,
      posts.service_specialty,
      posts.location AS service_location,
      posts.unit_number,
      request_selections.id AS request_selection_id,
      request_selections.ended_at AS selection_ended_at,
      conversations.id AS canonical_conversation_id,
      conversations.status AS canonical_conversation_status,
      conversations.request_selection_id
        AS conversation_selection_id
    FROM request_relationships
    JOIN contractor_profiles
      ON request_relationships.contractor_id = contractor_profiles.id
    JOIN posts
      ON request_relationships.post_id = posts.id
    LEFT JOIN professional_responses
      ON professional_responses.id =
        request_relationships.professional_response_id
      AND professional_responses.request_relationship_id =
        request_relationships.id
      AND professional_responses.post_id = request_relationships.post_id
      AND professional_responses.homeowner_id =
        request_relationships.homeowner_id
      AND professional_responses.contractor_id =
        request_relationships.contractor_id
      AND professional_responses.professional_user_id =
        request_relationships.professional_user_id
    LEFT JOIN request_selections
      ON request_selections.professional_response_id =
        professional_responses.id
      AND request_selections.request_relationship_id =
        request_relationships.id
      AND request_selections.post_id = request_relationships.post_id
      AND request_selections.selected_by_user_id =
        request_relationships.homeowner_id
      AND request_selections.contractor_id =
        request_relationships.contractor_id
      AND request_selections.professional_user_id =
        request_relationships.professional_user_id
    LEFT JOIN conversations
      ON conversations.id = request_selections.conversation_id
      AND conversations.relationship_id = request_relationships.id
      AND conversations.request_selection_id = request_selections.id
      AND conversations.homeowner_id = request_relationships.homeowner_id
      AND conversations.contractor_id = request_relationships.contractor_id
      AND conversations.professional_user_id =
        request_relationships.professional_user_id
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
        AND request_relationships.post_id IS NOT NULL
        AND request_relationships.professional_response_id IS NULL
        AND request_relationships.ordinary_authority_source IS NULL
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
        AND professional_response_id IS NULL
        AND ordinary_authority_source IS NULL
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
