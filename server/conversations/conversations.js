"use strict";

const CONVERSATION_STATUSES = Object.freeze({
  ACTIVE: "active",
  CLOSED: "closed",
});

const CONVERSATION_STATUS_VALUES = Object.freeze(
  Object.values(CONVERSATION_STATUSES)
);

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

function getConversationSource(row = {}) {
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
    last_message_preview: null,
    unread_count: 0,
    conversation_available: Boolean(conversationId),
    permissions: {
      canSendMessages:
        row.status === CONVERSATION_STATUSES.ACTIVE,
    },
  };

  if (parsePositiveInteger(row.emergency_request_id)) {
    value.request_id = null;
    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = getConversationSource(row);
  }

  return value;
}

function serializeConversationSummaryForProfessional(row = {}) {
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
    last_message_preview: null,
    unread_count: 0,
    conversation_available:
      row.status === CONVERSATION_STATUSES.ACTIVE,
  };

  if (parsePositiveInteger(row.emergency_request_id)) {
    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = getConversationSource(row);
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

  return {
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
        role: viewerIsHomeowner
          ? "homeowner"
          : "professional",
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
    workflow: {
      status: null,
      stage: null,
    },
    permissions: {
      canRead: true,
      canSendMessages:
        row.status === CONVERSATION_STATUSES.ACTIVE,
      canManageWorkflow: false,
    },
  };
}

module.exports = {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_VALUES,
  canArchiveConversation,
  canCloseConversation,
  canRestoreConversation,
  getConversationSource,
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
