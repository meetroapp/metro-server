"use strict";

const {
  parsePositiveInteger,
} = require("../relationships/requestRelationships");

const {
  ensureConversationWithClient,
} = require("../conversations/conversationService");

const {
  ensureEmergencySelectionJob,
} = require("./emergencyJobFoundationService");

const {
  professionalCanBeDirectSelectedForEmergency,
} = require("./emergencyOpportunityService");

function invalidEmergencyRequestId() {
  return {
    ok: false,
    status: 400,
    code: "INVALID_EMERGENCY_REQUEST_ID",
    message: "A valid Emergency request ID is required.",
  };
}

function invalidRelationshipId() {
  return {
    ok: false,
    status: 400,
    code: "INVALID_RELATIONSHIP_ID",
    message: "A valid relationship ID is required.",
  };
}

function invalidContractorProfileId() {
  return {
    ok: false,
    status: 400,
    code: "INVALID_CONTRACTOR_PROFILE_ID",
    message: "A valid professional profile ID is required.",
  };
}


async function selectHomeownerAvailableEmergencyProfessional({
  pool,
  homeownerUserId,
  emergencyRequestId: rawEmergencyRequestId,
  contractorProfileId: rawContractorProfileId,
  canDirectSelect =
    professionalCanBeDirectSelectedForEmergency,
  ensureConversation =
    ensureConversationWithClient,
  ensureSelectionJob =
    ensureEmergencySelectionJob,
}) {
  const emergencyRequestId =
    parsePositiveInteger(
      rawEmergencyRequestId
    );

  const contractorProfileId =
    parsePositiveInteger(
      rawContractorProfileId
    );

  if (!emergencyRequestId) {
    return invalidEmergencyRequestId();
  }

  if (!contractorProfileId) {
    return invalidContractorProfileId();
  }

  if (
    !pool ||
    typeof pool.query !== "function"
  ) {
    throw new TypeError(
      "A database pool or client is required."
    );
  }

  if (
    typeof canDirectSelect !== "function"
  ) {
    throw new TypeError(
      "canDirectSelect must be a function."
    );
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const emergencyResult =
      await client.query(
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
          emergency_requests.assigned_at,
          emergency_requests.expired_at,
          emergency_request_safety_assessments.disposition
        FROM emergency_requests
        LEFT JOIN emergency_request_safety_assessments
          ON emergency_request_safety_assessments.emergency_request_id =
            emergency_requests.id
        WHERE emergency_requests.id = $1
          AND emergency_requests.homeowner_id = $2
        LIMIT 1
        FOR UPDATE OF emergency_requests
        `,
        [
          emergencyRequestId,
          homeownerUserId,
        ]
      );

    if (
      emergencyResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code:
          "EMERGENCY_REQUEST_NOT_FOUND",
        message:
          "The Emergency request was not found.",
      };
    }

    const emergencyRequest =
      emergencyResult.rows[0];

    const existingResult =
      await client.query(
        `
        SELECT
          id,
          post_id,
          emergency_request_id,
          homeowner_id,
          contractor_id,
          professional_user_id,
          emergency_authority_source,
          status,
          responded_at,
          created_at,
          accepted_at,
          declined_at,
          withdrawn_at,
          closed_at,
          updated_at
        FROM request_relationships
        WHERE emergency_request_id = $1
          AND contractor_id = $2
          AND post_id IS NULL
          AND homeowner_id = $3
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
        `,
        [
          emergencyRequestId,
          contractorProfileId,
          homeownerUserId,
        ]
      );

    const existingRelationship =
      existingResult.rows[0] || null;

    if (
      emergencyRequest.status ===
      "assigned"
    ) {
      if (
        existingRelationship &&
        existingRelationship.status ===
          "active" &&
        existingRelationship
          .emergency_authority_source ===
          "available_now_direct_select"
      ) {
        const conversationResult =
          await ensureConversation({
            client,
            relationshipId:
              existingRelationship.id,
          });

        if (
          !conversationResult ||
          conversationResult.ok !== true
        ) {
          throw new Error(
            "The selected Emergency conversation could not be resolved."
          );
        }

        await ensureSelectionJob({
          client,
          emergencyRequest,
          relationship:
            existingRelationship,
        });

        await client.query("COMMIT");

        return {
          ok: true,
          status: 200,
          code:
            "EMERGENCY_AVAILABLE_PROFESSIONAL_ALREADY_SELECTED",
          alreadySelected: true,
          declinedResponseCount: 0,
          emergencyRequest,
          relationship:
            existingRelationship,
          conversation:
            conversationResult.conversation,
        };
      }

      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code:
          "EMERGENCY_REQUEST_ALREADY_ASSIGNED",
        message:
          "A professional has already been selected for this Emergency request.",
      };
    }

    if (
      emergencyRequest.status !==
        "ready_for_distribution" ||
      emergencyRequest.disposition !==
        "continue" ||
      emergencyRequest.expired_at != null
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code:
          "EMERGENCY_REQUEST_NOT_SELECTABLE",
        message:
          "This Emergency request is not available for professional selection.",
      };
    }

    if (existingRelationship) {
      await client.query("ROLLBACK");

      if (
        existingRelationship
          .emergency_authority_source ===
          "professional_response" &&
        existingRelationship.status ===
          "pending"
      ) {
        return {
          ok: false,
          status: 409,
          code:
            "EMERGENCY_PROFESSIONAL_RESPONSE_AVAILABLE",
          message:
            "This professional has responded to the Emergency request. Refresh the responses before selecting.",
        };
      }

      return {
        ok: false,
        status: 409,
        code:
          "EMERGENCY_PROFESSIONAL_RELATIONSHIP_EXISTS",
        message:
          "This professional already has an Emergency relationship for this request.",
      };
    }

    const profileResult =
      await client.query(
        `
        SELECT
          id,
          user_id,
          business_name,
          category,
          image_url,
          profile_details
        FROM contractor_profiles
        WHERE id = $1
          AND user_id <> $2
        LIMIT 1
        FOR SHARE
        `,
        [
          contractorProfileId,
          homeownerUserId,
        ]
      );

    if (
      profileResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code:
          "EMERGENCY_AVAILABLE_PROFESSIONAL_NOT_FOUND",
        message:
          "The available Emergency professional was not found.",
      };
    }

    const profile =
      profileResult.rows[0];

    if (
      !canDirectSelect(
        profile,
        emergencyRequest
      )
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code:
          "EMERGENCY_PROFESSIONAL_NO_LONGER_AVAILABLE",
        message:
          "This professional is no longer available for direct Emergency selection.",
      };
    }

    const activeResult =
      await client.query(
        `
        SELECT id
        FROM request_relationships
        WHERE emergency_request_id = $1
          AND post_id IS NULL
          AND homeowner_id = $2
          AND status = 'active'
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
        `,
        [
          emergencyRequestId,
          homeownerUserId,
        ]
      );

    if (
      activeResult.rows.length > 0
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code:
          "EMERGENCY_REQUEST_ALREADY_ASSIGNED",
        message:
          "A professional has already been selected for this Emergency request.",
      };
    }

    const competingResult =
      await client.query(
        `
        UPDATE request_relationships
        SET
          status = 'declined',
          declined_at = COALESCE(
            declined_at,
            CURRENT_TIMESTAMP
          ),
          updated_at =
            CURRENT_TIMESTAMP
        WHERE emergency_request_id = $1
          AND post_id IS NULL
          AND homeowner_id = $2
          AND status = 'pending'
        RETURNING id
        `,
        [
          emergencyRequestId,
          homeownerUserId,
        ]
      );

    const relationshipResult =
      await client.query(
        `
        INSERT INTO request_relationships
        (
          post_id,
          emergency_request_id,
          homeowner_id,
          contractor_id,
          professional_user_id,
          emergency_authority_source,
          status,
          introduction_text,
          responded_at,
          accepted_at
        )
        VALUES (
          NULL,
          $1,
          $2,
          $3,
          $4,
          'available_now_direct_select',
          'active',
          '',
          NULL,
          CURRENT_TIMESTAMP
        )
        RETURNING *
        `,
        [
          emergencyRequestId,
          emergencyRequest.homeowner_id,
          profile.id,
          profile.user_id,
        ]
      );

    if (
      relationshipResult.rows.length === 0
    ) {
      throw new Error(
        "The direct-selected Emergency relationship could not be created."
      );
    }

    const relationship =
      relationshipResult.rows[0];

    const assignedResult =
      await client.query(
        `
        UPDATE emergency_requests
        SET
          status = 'assigned',
          assigned_at = COALESCE(
            assigned_at,
            CURRENT_TIMESTAMP
          ),
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = $1
          AND homeowner_id = $2
          AND status =
            'ready_for_distribution'
          AND expired_at IS NULL
        RETURNING
          id,
          homeowner_id,
          status,
          assigned_at,
          updated_at
        `,
        [
          emergencyRequestId,
          homeownerUserId,
        ]
      );

    if (
      assignedResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code:
          "EMERGENCY_REQUEST_NOT_SELECTABLE",
        message:
          "This Emergency request is not available for professional selection.",
      };
    }

    const conversationResult =
      await ensureConversation({
        client,
        relationshipId:
          relationship.id,
      });

    if (
      !conversationResult ||
      conversationResult.ok !== true
    ) {
      throw new Error(
        "The selected Emergency conversation could not be created."
      );
    }

    await ensureSelectionJob({
      client,
      emergencyRequest:
        assignedResult.rows[0],
      relationship,
    });

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code:
        "EMERGENCY_AVAILABLE_PROFESSIONAL_SELECTED",
      alreadySelected: false,
      declinedResponseCount:
        competingResult.rows.length,
      emergencyRequest:
        assignedResult.rows[0],
      relationship,
      conversation:
        conversationResult.conversation,
    };
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
      typeof client.release ===
        "function"
    ) {
      client.release();
    }
  }
}

async function selectHomeownerEmergencyResponse({
  pool,
  homeownerUserId,
  emergencyRequestId: rawEmergencyRequestId,
  relationshipId: rawRelationshipId,
}) {
  const emergencyRequestId = parsePositiveInteger(
    rawEmergencyRequestId
  );

  const relationshipId = parsePositiveInteger(
    rawRelationshipId
  );

  if (!emergencyRequestId) {
    return invalidEmergencyRequestId();
  }

  if (!relationshipId) {
    return invalidRelationshipId();
  }

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError(
      "A database pool or client is required."
    );
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const emergencyResult = await client.query(
      `
      SELECT
        id,
        homeowner_id,
        status,
        assigned_at,
        updated_at
      FROM emergency_requests
      WHERE id = $1
        AND homeowner_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [
        emergencyRequestId,
        homeownerUserId,
      ]
    );

    if (emergencyResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code: "EMERGENCY_REQUEST_NOT_FOUND",
        message:
          "The Emergency request was not found.",
      };
    }

    const emergencyRequest =
      emergencyResult.rows[0];

    const relationshipResult = await client.query(
      `
      SELECT
        id,
        post_id,
        emergency_request_id,
        homeowner_id,
        contractor_id,
        professional_user_id,
        status,
        responded_at,
        created_at,
        accepted_at,
        declined_at,
        withdrawn_at,
        closed_at,
        updated_at
      FROM request_relationships
      WHERE id = $1
        AND emergency_request_id = $2
        AND post_id IS NULL
        AND homeowner_id = $3
      LIMIT 1
      FOR UPDATE
      `,
      [
        relationshipId,
        emergencyRequestId,
        homeownerUserId,
      ]
    );

    if (relationshipResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 404,
        code: "EMERGENCY_RESPONSE_NOT_FOUND",
        message:
          "The Emergency response was not found.",
      };
    }

    const selectedRelationship =
      relationshipResult.rows[0];

    if (emergencyRequest.status === "assigned") {
      if (selectedRelationship.status !== "active") {
        await client.query("ROLLBACK");

        return {
          ok: false,
          status: 409,
          code: "EMERGENCY_REQUEST_ALREADY_ASSIGNED",
          message:
            "A professional has already been selected for this Emergency request.",
        };
      }

      const conversationResult =
        await ensureConversationWithClient({
          client,
          relationshipId,
        });

      if (!conversationResult.ok) {
        throw new Error(
          "The selected Emergency conversation could not be resolved."
        );
      }

      await ensureEmergencySelectionJob({
        client,
        emergencyRequest,
        relationship: selectedRelationship,
      });

      await client.query("COMMIT");

      return {
        ok: true,
        status: 200,
        code: "EMERGENCY_RESPONSE_ALREADY_SELECTED",
        alreadySelected: true,
        emergencyRequest,
        relationship: selectedRelationship,
        conversation:
          conversationResult.conversation,
      };
    }

    if (
      emergencyRequest.status !==
      "ready_for_distribution"
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_NOT_SELECTABLE",
        message:
          "This Emergency request is not available for professional selection.",
      };
    }

    if (selectedRelationship.status !== "pending") {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_RESPONSE_NOT_PENDING",
        message:
          "This Emergency response is no longer pending.",
      };
    }

    const competingResult = await client.query(
      `
      UPDATE request_relationships
      SET
        status = 'declined',
        declined_at = COALESCE(
          declined_at,
          CURRENT_TIMESTAMP
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE emergency_request_id = $1
        AND post_id IS NULL
        AND homeowner_id = $2
        AND id <> $3
        AND status = 'pending'
      RETURNING id
      `,
      [
        emergencyRequestId,
        homeownerUserId,
        relationshipId,
      ]
    );

    const selectedResult = await client.query(
      `
      UPDATE request_relationships
      SET
        status = 'active',
        accepted_at = COALESCE(
          accepted_at,
          CURRENT_TIMESTAMP
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND emergency_request_id = $2
        AND post_id IS NULL
        AND homeowner_id = $3
        AND status = 'pending'
      RETURNING *
      `,
      [
        relationshipId,
        emergencyRequestId,
        homeownerUserId,
      ]
    );

    if (selectedResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_RESPONSE_NOT_PENDING",
        message:
          "This Emergency response is no longer pending.",
      };
    }

    const assignedResult = await client.query(
      `
      UPDATE emergency_requests
      SET
        status = 'assigned',
        assigned_at = COALESCE(
          assigned_at,
          CURRENT_TIMESTAMP
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND homeowner_id = $2
        AND status = 'ready_for_distribution'
      RETURNING
        id,
        homeowner_id,
        status,
        assigned_at,
        updated_at
      `,
      [
        emergencyRequestId,
        homeownerUserId,
      ]
    );

    if (assignedResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_NOT_SELECTABLE",
        message:
          "This Emergency request is not available for professional selection.",
      };
    }

    const conversationResult =
      await ensureConversationWithClient({
        client,
        relationshipId,
      });

    if (!conversationResult.ok) {
      throw new Error(
        "The selected Emergency conversation could not be created."
      );
    }

    await ensureEmergencySelectionJob({
      client,
      emergencyRequest:
        assignedResult.rows[0],
      relationship:
        selectedResult.rows[0],
    });

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: "EMERGENCY_RESPONSE_SELECTED",
      alreadySelected: false,
      declinedResponseCount:
        competingResult.rows.length,
      emergencyRequest:
        assignedResult.rows[0],
      relationship:
        selectedResult.rows[0],
      conversation:
        conversationResult.conversation,
    };
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

module.exports = {
  selectHomeownerAvailableEmergencyProfessional,
  selectHomeownerEmergencyResponse,
};
