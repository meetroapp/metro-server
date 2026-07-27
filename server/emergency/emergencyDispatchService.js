"use strict";

const {
  parsePositiveInteger,
} = require("./emergencyRequestService");

const PRE_ASSIGNMENT_STATUSES = new Set([
  "draft",
  "ready_for_distribution",
  "active",
  "selection_pending",
]);

function createTransitionDefinition({
  sourceStatus,
  targetStatus,
  timestampColumn,
  successCode,
  repeatCode,
}) {
  return Object.freeze({
    sourceStatus,
    targetStatus,
    timestampColumn,
    successCode,
    repeatCode,
    updateSql: `
      UPDATE emergency_requests
      SET
        status = $2,
        ${timestampColumn} = COALESCE(
          ${timestampColumn},
          CURRENT_TIMESTAMP
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND status = $3
      RETURNING
        id,
        status,
        assigned_at,
        en_route_at,
        arrived_at,
        work_started_at,
        completed_at,
        updated_at
    `,
  });
}

const TRANSITIONS = Object.freeze({
  enRoute: createTransitionDefinition({
    sourceStatus: "assigned",
    targetStatus: "professional_en_route",
    timestampColumn: "en_route_at",
    successCode: "EMERGENCY_EN_ROUTE",
    repeatCode: "EMERGENCY_ALREADY_EN_ROUTE",
  }),
  arrived: createTransitionDefinition({
    sourceStatus: "professional_en_route",
    targetStatus: "professional_arrived",
    timestampColumn: "arrived_at",
    successCode: "EMERGENCY_ARRIVED",
    repeatCode: "EMERGENCY_ALREADY_ARRIVED",
  }),
  start: createTransitionDefinition({
    sourceStatus: "professional_arrived",
    targetStatus: "work_in_progress",
    timestampColumn: "work_started_at",
    successCode: "EMERGENCY_WORK_STARTED",
    repeatCode: "EMERGENCY_WORK_ALREADY_STARTED",
  }),
  complete: createTransitionDefinition({
    sourceStatus: "work_in_progress",
    targetStatus: "completed",
    timestampColumn: "completed_at",
    successCode: "EMERGENCY_COMPLETED",
    repeatCode: "EMERGENCY_ALREADY_COMPLETED",
  }),
});

function serviceFailure(status, code, message) {
  return {
    success: false,
    status,
    code,
    message,
  };
}

function invalidEmergencyRequestId() {
  return serviceFailure(
    400,
    "INVALID_EMERGENCY_REQUEST_ID",
    "A valid Emergency request ID is required."
  );
}

function professionalProfileRequired() {
  return serviceFailure(
    403,
    "PROFESSIONAL_PROFILE_REQUIRED",
    "A professional profile is required."
  );
}

function emergencyRequestNotFound() {
  return serviceFailure(
    404,
    "EMERGENCY_REQUEST_NOT_FOUND",
    "The Emergency request was not found."
  );
}

function emergencyNotAssigned() {
  return serviceFailure(
    409,
    "EMERGENCY_NOT_ASSIGNED",
    "The Emergency request does not have a valid professional assignment."
  );
}

function emergencyConversationRequired() {
  return serviceFailure(
    409,
    "EMERGENCY_CONVERSATION_REQUIRED",
    "An active Emergency conversation is required before dispatch can continue."
  );
}

function invalidTransition() {
  return serviceFailure(
    409,
    "EMERGENCY_INVALID_TRANSITION",
    "This Emergency request cannot use that dispatch transition."
  );
}

function emergencyDispatchFailed() {
  return serviceFailure(
    500,
    "EMERGENCY_DISPATCH_FAILED",
    "The Emergency dispatch update could not be completed."
  );
}

function serializeDispatchResult({
  code,
  alreadyApplied,
  emergencyRequest,
  relationship,
  conversation,
}) {
  return {
    success: true,
    code,
    alreadyApplied,
    emergencyRequest: {
      id: emergencyRequest.id,
      status: emergencyRequest.status,
      assignedAt: emergencyRequest.assigned_at,
      enRouteAt: emergencyRequest.en_route_at,
      arrivedAt: emergencyRequest.arrived_at,
      workStartedAt: emergencyRequest.work_started_at,
      completedAt: emergencyRequest.completed_at,
      updatedAt: emergencyRequest.updated_at,
    },
    relationship: {
      id: relationship.id,
      status: relationship.status,
    },
    conversation: {
      id: conversation.id,
      status: conversation.status,
      updatedAt: conversation.updated_at || null,
    },
  };
}

async function rollbackSafely(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the governed public failure.
  }
}

async function failTransaction(client, failure) {
  await rollbackSafely(client);
  return failure;
}

async function applyEmergencyTransition(input = {}, definition) {
  const emergencyRequestId = parsePositiveInteger(
    input.emergencyRequestId
  );

  if (!emergencyRequestId) {
    return invalidEmergencyRequestId();
  }

  const authenticatedUserId = parsePositiveInteger(
    input.authenticatedUserId
  );

  if (!authenticatedUserId) {
    return professionalProfileRequired();
  }

  const { pool } = input;

  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError(
      "A database pool with connect() is required."
    );
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    if (!client || typeof client.query !== "function") {
      return emergencyDispatchFailed();
    }

    await client.query("BEGIN");
    transactionStarted = true;

    const profileResult = await client.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM contractor_profiles
        WHERE user_id = $1
      ) AS has_owned_profile
      `,
      [authenticatedUserId]
    );

    if (
      profileResult.rows[0]?.has_owned_profile !==
      true
    ) {
      return await failTransaction(
        client,
        professionalProfileRequired()
      );
    }

    const emergencyResult = await client.query(
      `
      SELECT
        id,
        status,
        assigned_at,
        en_route_at,
        arrived_at,
        work_started_at,
        completed_at,
        updated_at
      FROM emergency_requests
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [emergencyRequestId]
    );

    if (emergencyResult.rows.length === 0) {
      return await failTransaction(
        client,
        emergencyRequestNotFound()
      );
    }

    const emergencyRequest = emergencyResult.rows[0];

    const relationshipResult = await client.query(
      `
      SELECT
        rr.id,
        rr.emergency_request_id,
        rr.homeowner_id,
        rr.contractor_id,
        rr.professional_user_id,
        rr.status
      FROM request_relationships AS rr
      INNER JOIN contractor_profiles AS cp
        ON cp.id = rr.contractor_id
        AND cp.user_id = $2
      WHERE rr.emergency_request_id = $1
        AND rr.post_id IS NULL
        AND rr.status = 'active'
        AND rr.professional_user_id = $2
      LIMIT 1
      FOR UPDATE OF rr
      `,
      [
        emergencyRequestId,
        authenticatedUserId,
      ]
    );

    if (relationshipResult.rows.length === 0) {
      return await failTransaction(
        client,
        emergencyRequestNotFound()
      );
    }

    const relationship = relationshipResult.rows[0];

    const conversationResult = await client.query(
      `
      SELECT
        c.id,
        c.relationship_id,
        c.homeowner_id,
        c.contractor_id,
        c.professional_user_id,
        c.status,
        c.updated_at
      FROM conversations AS c
      WHERE c.relationship_id = $1
        AND c.homeowner_id = $2
        AND c.contractor_id = $3
        AND c.professional_user_id = $4
        AND c.status = 'active'
      LIMIT 1
      FOR UPDATE OF c
      `,
      [
        relationship.id,
        relationship.homeowner_id,
        relationship.contractor_id,
        relationship.professional_user_id,
      ]
    );

    if (conversationResult.rows.length === 0) {
      return await failTransaction(
        client,
        emergencyConversationRequired()
      );
    }

    const conversation = conversationResult.rows[0];

    if (
      PRE_ASSIGNMENT_STATUSES.has(
        emergencyRequest.status
      )
    ) {
      return await failTransaction(
        client,
        emergencyNotAssigned()
      );
    }

    if (
      emergencyRequest.status ===
      definition.targetStatus
    ) {
      await client.query("COMMIT");
      transactionStarted = false;

      return serializeDispatchResult({
        code: definition.repeatCode,
        alreadyApplied: true,
        emergencyRequest,
        relationship,
        conversation,
      });
    }

    if (
      emergencyRequest.status !==
      definition.sourceStatus
    ) {
      return await failTransaction(
        client,
        invalidTransition()
      );
    }

    const updateResult = await client.query(
      definition.updateSql,
      [
        emergencyRequestId,
        definition.targetStatus,
        definition.sourceStatus,
      ]
    );

    if (updateResult.rows.length === 0) {
      return await failTransaction(
        client,
        invalidTransition()
      );
    }

    const activityResult = await client.query(
      `
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND status = 'active'
      RETURNING
        id,
        status,
        updated_at
      `,
      [conversation.id]
    );

    if (activityResult.rows.length === 0) {
      return await failTransaction(
        client,
        emergencyConversationRequired()
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return serializeDispatchResult({
      code: definition.successCode,
      alreadyApplied: false,
      emergencyRequest: updateResult.rows[0],
      relationship,
      conversation: activityResult.rows[0],
    });
  } catch {
    if (transactionStarted && client) {
      await rollbackSafely(client);
    }

    return emergencyDispatchFailed();
  } finally {
    if (
      client &&
      typeof client.release === "function"
    ) {
      try {
        client.release();
      } catch {
        // The transaction result must remain privacy-safe.
      }
    }
  }
}

function markEmergencyEnRoute(input) {
  return applyEmergencyTransition(
    input,
    TRANSITIONS.enRoute
  );
}

function markEmergencyArrived(input) {
  return applyEmergencyTransition(
    input,
    TRANSITIONS.arrived
  );
}

function startEmergencyWork(input) {
  return applyEmergencyTransition(
    input,
    TRANSITIONS.start
  );
}

function completeEmergencyWork(input) {
  return applyEmergencyTransition(
    input,
    TRANSITIONS.complete
  );
}

module.exports = {
  completeEmergencyWork,
  markEmergencyArrived,
  markEmergencyEnRoute,
  startEmergencyWork,
};
