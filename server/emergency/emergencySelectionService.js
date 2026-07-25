"use strict";

const {
  parsePositiveInteger,
} = require("../relationships/requestRelationships");

const {
  ensureConversationWithClient,
} = require("../conversations/conversationService");

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
  selectHomeownerEmergencyResponse,
};
