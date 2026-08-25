"use strict";

const RELATIONSHIP_STATUSES = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  DECLINED: "declined",
  WITHDRAWN: "withdrawn",
  CLOSED: "closed",
});

const RELATIONSHIP_STATUS_VALUES = Object.freeze(
  Object.values(RELATIONSHIP_STATUSES)
);

const PROFESSIONAL_RESPONSE_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function cleanText(value, maxLength = 2000) {
  if (value === undefined || value === null) return "";

  return String(value)
    .trim()
    .slice(0, maxLength);
}

function isValidPositiveInteger(value) {
  const normalized = String(value ?? "").trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    return false;
  }

  const parsed = Number(normalized);

  return Number.isSafeInteger(parsed) && parsed > 0;
}

function parsePositiveInteger(value) {
  if (!isValidPositiveInteger(value)) return null;

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveOpaqueId(value) {
  const normalized = String(value ?? "").trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : normalized;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateEmergencyResponsePayload(payload) {
  if (payload === undefined) {
    return { valid: true, value: {} };
  }

  if (!isPlainObject(payload) || Object.keys(payload).length > 0) {
    return {
      valid: false,
      code: "UNSUPPORTED_EMERGENCY_RESPONSE_FIELDS",
      message: "Emergency responses do not accept request fields.",
    };
  }

  return { valid: true, value: {} };
}

function validateProfessionalResponsePayload(payload = {}) {
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      code: "INVALID_PROFESSIONAL_RESPONSE",
      message: "Professional response details must be an object.",
    };
  }

  if (
    Object.keys(payload).some(
      (field) => field !== "introduction_text"
    )
  ) {
    return {
      valid: false,
      code: "UNSUPPORTED_PROFESSIONAL_RESPONSE_FIELDS",
      message: "Professional response identity is managed by Meetro.",
    };
  }

  const introductionText = cleanText(payload.introduction_text, 2000);

  if (!introductionText) {
    return {
      valid: false,
      code: "INTRODUCTION_REQUIRED",
      message: "An introduction is required.",
    };
  }

  return {
    valid: true,
    value: {
      introductionText,
    },
  };
}

function validateProfessionalResponseIdempotencyKey(value) {
  const idempotencyKey =
    typeof value === "string" ? value.trim() : "";

  if (!PROFESSIONAL_RESPONSE_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return {
      valid: false,
      code: "INVALID_PROFESSIONAL_RESPONSE_IDEMPOTENCY_KEY",
      message: "A valid idempotency key is required.",
    };
  }

  return {
    valid: true,
    value: idempotencyKey,
  };
}

function serializeCanonicalProfessionalResponse(row = {}, classification) {
  return {
    response: {
      id: row.response_id,
      request_id: row.post_id,
      status: row.response_status,
      current_version: row.response_current_version,
      introduction_text: row.response_introduction_text,
      submitted_at: row.response_submitted_at,
      updated_at: row.response_updated_at,
      business_profile: {
        business_name: row.business_name || "",
        category: row.professional_category || "",
        image_url: row.business_image_url || "",
      },
    },
    relationship: {
      id: row.relationship_id,
      request_id: row.post_id,
      status: row.relationship_status,
      authority_source: row.ordinary_authority_source,
      current_version: row.relationship_current_version,
      created_at: row.relationship_created_at,
    },
    resultClassification: classification,
    created: classification === "created",
  };
}

function validateRelationshipStatus(status) {
  return RELATIONSHIP_STATUS_VALUES.includes(status);
}

function canHomeownerAcceptRelationship(relationship = {}, userId) {
  return Boolean(
    relationship.status === RELATIONSHIP_STATUSES.PENDING &&
      String(relationship.homeowner_id) === String(userId)
  );
}

function canHomeownerDeclineRelationship(relationship = {}, userId) {
  return Boolean(
    relationship.status === RELATIONSHIP_STATUSES.PENDING &&
      String(relationship.homeowner_id) === String(userId)
  );
}

function canProfessionalWithdrawRelationship(relationship = {}, userId) {
  return Boolean(
    relationship.status === RELATIONSHIP_STATUSES.PENDING &&
      String(relationship.professional_user_id) === String(userId)
  );
}

function hasCanonicalResponseLink(row = {}) {
  const statusPairs = {
    submitted: "pending",
    selected: "active",
    withdrawn: "closed",
    declined: "closed",
    not_selected: "closed",
    expired: "closed",
    cancelled: "closed",
    closed: "closed",
  };

  return Boolean(
    row.response_id &&
      String(row.response_id) === String(row.professional_response_id) &&
      row.ordinary_authority_source === "professional_response" &&
      Number(row.response_current_version) > 0 &&
      Number(row.response_current_version) ===
        Number(row.relationship_current_version) &&
      statusPairs[row.response_status] === row.status
  );
}

function serializePendingRelationshipForHomeowner(row = {}) {
  const canonicalResponse = hasCanonicalResponseLink(row);

  return {
    id: row.id,
    request_id: row.post_id,
    contractor_id: row.contractor_id,
    request_title: row.request_title || "",
    business_name: row.business_name || "",
    business_image_url: row.business_image_url || "",
    professional_category: row.professional_category || "",
    introduction_text: canonicalResponse
      ? row.response_introduction_text || ""
      : row.introduction_text || "",
    status: row.status,
    response_id: canonicalResponse ? row.response_id : null,
    response_status: canonicalResponse ? row.response_status : null,
    relationship_status: row.status,
    authority_source: canonicalResponse
      ? row.ordinary_authority_source
      : null,
    created_at: row.created_at,
    responded_at: row.responded_at,
    submitted_at: canonicalResponse
      ? row.response_submitted_at
      : row.responded_at,
  };
}

function serializeRelationshipForProfessional(row = {}) {
  const canonicalResponse = hasCanonicalResponseLink(row);
  const selectedCanonical = Boolean(
    canonicalResponse &&
      row.response_status === "selected" &&
      row.status === RELATIONSHIP_STATUSES.ACTIVE &&
      row.request_selection_id &&
      row.selection_ended_at == null &&
      row.canonical_conversation_id &&
      row.canonical_conversation_status === "active" &&
      String(row.conversation_selection_id) ===
        String(row.request_selection_id)
  );

  const value = {
    id: row.id,
    request_id: row.post_id,
    request_title: row.request_title || "",
    request_description: row.request_description || "",
    request_category: row.request_category || "",
    service_domain: row.service_domain || "",
    service_specialty: row.service_specialty || "",
    introduction_text: canonicalResponse
      ? row.response_introduction_text || ""
      : row.introduction_text || "",
    status: row.status,
    response_id: canonicalResponse ? row.response_id : null,
    response_status: canonicalResponse ? row.response_status : null,
    relationship_status: row.status,
    authority_source: canonicalResponse
      ? row.ordinary_authority_source
      : null,
    created_at: row.created_at,
    responded_at: row.responded_at,
    accepted_at: row.accepted_at,
    declined_at: row.declined_at,
    withdrawn_at: row.withdrawn_at,
    closed_at: row.closed_at,
    selection_status: selectedCanonical
      ? "selected"
      : canonicalResponse && row.response_status === "not_selected"
        ? "not_selected"
        : null,
    privacy_stage: selectedCanonical ? 3 : 2,
    conversation_available: selectedCanonical,
    conversation_id: selectedCanonical
      ? row.canonical_conversation_id
      : null,
  };

  if (selectedCanonical) {
    value.service_location = row.service_location || "";
    value.unit_number = row.unit_number || "";
  }

  return value;
}

function serializeEmergencyResponseRelationship(row = {}) {
  return {
    id: row.id,
    emergencyRequestId: row.emergency_request_id,
    status: row.status,
    conversationAvailable: false,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

function normalizeServiceSpecialties(value) {
  let specialties = value;

  if (typeof specialties === "string") {
    try {
      specialties = JSON.parse(specialties);
    } catch {
      specialties = [];
    }
  }

  if (!Array.isArray(specialties)) {
    return [];
  }

  return specialties
    .filter((specialty) => typeof specialty === "string")
    .map((specialty) => specialty.trim())
    .filter(Boolean);
}

function serializeHomeownerEmergencyResponse(row = {}) {
  return {
    id: row.id,
    emergencyRequestId: row.emergency_request_id,
    status: row.status,
    respondedAt: row.responded_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? null,
    declinedAt: row.declined_at ?? null,
    withdrawnAt: row.withdrawn_at ?? null,
    closedAt: row.closed_at ?? null,
    conversationAvailable:
      row.status === RELATIONSHIP_STATUSES.ACTIVE &&
      row.canonical_conversation_exists === true,
    professional: {
      businessName: row.business_name || "",
      category: row.professional_category || "",
      serviceSpecialties: normalizeServiceSpecialties(
        row.service_specialties
      ),
      profileImageUrl: null,
      businessLogoUrl: row.business_image_url || null,
    },
  };
}

module.exports = {
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_STATUS_VALUES,
  canHomeownerAcceptRelationship,
  canHomeownerDeclineRelationship,
  canProfessionalWithdrawRelationship,
  cleanText,
  isPlainObject,
  isValidPositiveInteger,
  parsePositiveOpaqueId,
  parsePositiveInteger,
  serializeEmergencyResponseRelationship,
  serializeCanonicalProfessionalResponse,
  serializeHomeownerEmergencyResponse,
  serializePendingRelationshipForHomeowner,
  serializeRelationshipForProfessional,
  validateEmergencyResponsePayload,
  validateProfessionalResponsePayload,
  validateProfessionalResponseIdempotencyKey,
  validateRelationshipStatus,
};
