"use strict";

const CONVERSATION_STATUSES = Object.freeze({
  ACTIVE: "active",
  CLOSED: "closed",
});

const CONVERSATION_STATUS_VALUES = Object.freeze(
  Object.values(CONVERSATION_STATUSES)
);

const EMERGENCY_ACTION_BY_STATUS = Object.freeze({
  assigned: "mark_en_route",
  professional_en_route: "mark_arrived",
  professional_arrived: "start_work",
  work_in_progress: "complete_work",
});

function isValidPositiveInteger(value) {
  const normalized = String(value ?? "").trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    return false;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function parsePositiveInteger(value) {
  return isValidPositiveInteger(value)
    ? Number(value)
    : null;
}

function validateConversationStatus(status) {
  return CONVERSATION_STATUS_VALUES.includes(status);
}

function isConversationParticipant(conversation = {}, userId) {
  return (
    String(conversation.homeowner_id) === String(userId) ||
    String(conversation.professional_user_id) === String(userId)
  );
}

function participantArchiveField(conversation = {}, userId) {
  if (String(conversation.homeowner_id) === String(userId)) {
    return "homeowner_archived_at";
  }

  if (
    String(conversation.professional_user_id) === String(userId)
  ) {
    return "professional_archived_at";
  }

  return null;
}

function canArchiveConversation(conversation = {}, userId) {
  const field = participantArchiveField(conversation, userId);

  return Boolean(
    conversation.status === CONVERSATION_STATUSES.ACTIVE &&
      field &&
      !conversation[field]
  );
}

function canRestoreConversation(conversation = {}, userId) {
  const field = participantArchiveField(conversation, userId);

  return Boolean(
    conversation.status === CONVERSATION_STATUSES.ACTIVE &&
      field &&
      conversation[field]
  );
}

function canCloseConversation(conversation = {}, userId) {
  return Boolean(
    conversation.status === CONVERSATION_STATUSES.ACTIVE &&
      isConversationParticipant(conversation, userId)
  );
}

function hasExactlyOneConversationSource(row = {}) {
  const hasRequest =
    parsePositiveInteger(row.post_id) !== null;
  const hasEmergency =
    parsePositiveInteger(row.emergency_request_id) !== null;

  return hasRequest !== hasEmergency;
}

function getConversationSource(row = {}) {
  if (!hasExactlyOneConversationSource(row)) {
    throw new TypeError(
      "The conversation relationship source is invalid."
    );
  }

  const emergencyId = parsePositiveInteger(
    row.emergency_request_id
  );

  if (emergencyId) {
    return {
      type: "emergency",
      id: emergencyId,
      title: row.request_title || "",
      serviceDomain: row.source_service_domain || "",
      serviceSpecialty: row.source_service_specialty || "",
      isEmergency: true,
    };
  }

  const requestId = parsePositiveInteger(row.post_id);

  return {
    type: "request",
    id: requestId,
    title: row.request_title || "",
    serviceDomain: row.source_service_domain || "",
    serviceSpecialty: row.source_service_specialty || "",
    isEmergency: false,
  };
}

function deriveEmergencyWorkflow({
  row = {},
  viewerRole,
} = {}) {
  const isAuthorizedEmergency =
    parsePositiveInteger(row.emergency_request_id) !== null &&
    row.source_relationship_status === "active";
  const canManage =
    isAuthorizedEmergency &&
    viewerRole === "professional" &&
    row.status === CONVERSATION_STATUSES.ACTIVE;
  const action = canManage
    ? EMERGENCY_ACTION_BY_STATUS[
        row.source_workflow_status
      ] || null
    : null;
  const allowedActions = action ? [action] : [];

  return {
    workflow: {
      status: row.source_workflow_status || null,
      assignedAt: row.source_assigned_at || null,
      enRouteAt: row.source_en_route_at || null,
      arrivedAt: row.source_arrived_at || null,
      workStartedAt:
        row.source_work_started_at || null,
      completedAt: row.source_completed_at || null,
      allowedActions,
    },
    permissions: {
      canSendMessages:
        row.status === CONVERSATION_STATUSES.ACTIVE,
      canManageWorkflow: allowedActions.length > 0,
      canMarkEnRoute:
        action === "mark_en_route",
      canMarkArrived:
        action === "mark_arrived",
      canStartWork:
        action === "start_work",
      canCompleteWork:
        action === "complete_work",
    },
  };
}

function requireActiveEmergencyRelationship(row = {}) {
  if (row.source_relationship_status !== "active") {
    throw new TypeError(
      "An active Emergency relationship is required."
    );
  }
}

function serializeConversationForHomeowner(row = {}) {
  return {
    id: row.id,
    relationship_id: row.relationship_id,
    contractor_id: row.contractor_id,
    business_name: row.business_name || "",
    business_image_url: row.business_image_url || "",
    professional_category: row.professional_category || "",
    status: row.status,
    archived: Boolean(row.homeowner_archived_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  };
}

function serializeConversationForProfessional(row = {}) {
  const value = {
    id: row.id,
    relationship_id: row.relationship_id,
    request_id: row.post_id,
    request_title: row.request_title || "",
    homeowner_display_name: row.homeowner_display_name || "",
    status: row.status,
    archived: Boolean(row.professional_archived_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  };

  if (parsePositiveInteger(row.emergency_request_id)) {
    delete value.request_id;
    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = getConversationSource(row);
  }

  return value;
}

function serializeConversationSummaryForHomeowner(row = {}) {
  const conversationId = parsePositiveInteger(row.id);
  const requestId = parsePositiveInteger(row.post_id);
  const source = getConversationSource(row);

  const value = {
    id: conversationId,
    conversation_id: conversationId,
    request_id: requestId,
    request_title: row.request_title || "",
    relationship: {
      title: row.request_title || "",
      stage: "conversation",
    },
    display: {
      name: row.business_name || "",
      image_url: row.business_image_url || "",
      category: row.professional_category || "",
    },
    status: {
      value: row.status,
      active: row.status === CONVERSATION_STATUSES.ACTIVE,
      archived: Boolean(row.homeowner_archived_at),
      requires_attention: false,
    },
    last_activity: row.updated_at || row.created_at || null,
    last_message_preview:
      typeof row.last_message_preview === "string"
        ? row.last_message_preview
        : null,
    unread_count: Math.max(
      0,
      Number.parseInt(row.unread_count, 10) || 0
    ),
    conversation_available: Boolean(conversationId),
    permissions: {
      canSendMessages:
        row.status === CONVERSATION_STATUSES.ACTIVE,
    },
  };

  if (source.type === "emergency") {
    requireActiveEmergencyRelationship(row);
    const emergency = deriveEmergencyWorkflow({
      row,
      viewerRole: "homeowner",
    });

    value.request_id = null;
    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = source;
    value.viewer = {
      role: "homeowner",
    };
    value.workflow = emergency.workflow;
    value.permissions = emergency.permissions;
  }

  return value;
}

function serializeConversationSummaryForProfessional(row = {}) {
  const source = getConversationSource(row);
  const value = {
    id: row.id,
    relationship: {
      id: row.relationship_id,
      title: row.request_title || "",
      stage: "conversation",
    },
    display: {
      name: row.homeowner_display_name || "Customer",
      image_url: "",
      category: "",
    },
    status: {
      value: row.status,
      active: row.status === CONVERSATION_STATUSES.ACTIVE,
      archived: Boolean(row.professional_archived_at),
      requires_attention: false,
    },
    last_activity: row.updated_at || row.created_at || null,
    last_message_preview:
      typeof row.last_message_preview === "string"
        ? row.last_message_preview
        : null,
    unread_count: Math.max(
      0,
      Number.parseInt(row.unread_count, 10) || 0
    ),
    conversation_available:
      row.status === CONVERSATION_STATUSES.ACTIVE,
  };

  if (source.type === "emergency") {
    requireActiveEmergencyRelationship(row);
    const emergency = deriveEmergencyWorkflow({
      row,
      viewerRole: "professional",
    });

    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = source;
    value.viewer = {
      role: "professional",
    };
    value.workflow = emergency.workflow;
    value.permissions = emergency.permissions;
  }

  return value;
}

function normalizeMessageWorkflowPayload(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function serializeConversationMessage(row = {}, viewerUserId) {
  return {
    id: row.id,
    sender: {
      id: row.sender_id,
      isViewer:
        String(row.sender_id) === String(viewerUserId),
    },
    recipient: {
      id: row.receiver_id ?? null,
    },
    content: {
      text: row.message_text || "",
      imageUrl: row.image_url || null,
      type: row.message_type || "text",
    },
    workflow: {
      type: row.workflow_type || null,
      status: row.workflow_status || null,
      payload: normalizeMessageWorkflowPayload(
        row.workflow_payload
      ),
    },
    createdAt: row.created_at || null,
  };
}

function serializeConversationDetail(row = {}, viewerUserId) {
  const viewerIsHomeowner =
    String(row.homeowner_id) === String(viewerUserId);
  const viewerIsProfessional =
    String(row.professional_user_id) === String(viewerUserId);

  if (!viewerIsHomeowner && !viewerIsProfessional) {
    throw new TypeError(
      "The conversation viewer must be an authorized participant."
    );
  }

  const source = getConversationSource(row);
  const viewerRole = viewerIsHomeowner
    ? "homeowner"
    : "professional";

  if (source.type === "emergency") {
    requireActiveEmergencyRelationship(row);
  }

  const emergency =
    source.type === "emergency"
      ? deriveEmergencyWorkflow({
          row,
          viewerRole,
        })
      : null;
  const relationship =
    source.type === "emergency"
      ? {
          id: row.relationship_id,
          emergencyRequestId: source.id,
          title: source.title,
          source,
        }
      : {
          id: row.relationship_id,
          requestId: row.post_id,
          title: row.request_title || "",
        };

  const value = {
    conversation: {
      id: row.id,
      type: source.type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at || null,
    },
    participants: {
      viewer: {
        id: viewerUserId,
        role: viewerRole,
      },
      homeowner: {
        id: row.homeowner_id,
        displayName:
          row.homeowner_display_name || "Customer",
      },
      business: {
        id: row.contractor_id,
        userId: row.professional_user_id,
        name: row.business_name || "",
        imageUrl: row.business_image_url || "",
        category: row.professional_category || "",
      },
    },
    relationship,
    workflow: emergency?.workflow || {
      status: null,
      stage: null,
    },
    permissions: emergency
      ? {
          canRead: true,
          ...emergency.permissions,
        }
      : {
          canRead: true,
          canSendMessages:
            row.status === CONVERSATION_STATUSES.ACTIVE,
          canManageWorkflow: false,
        },
  };

  if (source.type === "emergency") {
    value.location = {
      locationText: row.source_location_text || "",
      unitNumber: row.source_unit_number || "",
      accessNotes: row.source_access_notes || "",
    };
  }

  return value;
}

module.exports = {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_VALUES,
  canArchiveConversation,
  canCloseConversation,
  canRestoreConversation,
  deriveEmergencyWorkflow,
  getConversationSource,
  hasExactlyOneConversationSource,
  isConversationParticipant,
  isValidPositiveInteger,
  parsePositiveInteger,
  participantArchiveField,
  serializeConversationForHomeowner,
  serializeConversationForProfessional,
  serializeConversationDetail,
  serializeConversationMessage,
  serializeConversationSummaryForHomeowner,
  serializeConversationSummaryForProfessional,
  validateConversationStatus,
};
