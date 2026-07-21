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

function validateProfessionalResponsePayload(payload = {}) {
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

function serializePendingRelationshipForHomeowner(row = {}) {
  return {
    id: row.id,
    request_id: row.post_id,
    contractor_id: row.contractor_id,
    request_title: row.request_title || "",
    business_name: row.business_name || "",
    business_image_url: row.business_image_url || "",
    professional_category: row.professional_category || "",
    introduction_text: row.introduction_text || "",
    status: row.status,
    created_at: row.created_at,
    responded_at: row.responded_at,
  };
}

function serializeRelationshipForProfessional(row = {}) {
  return {
    id: row.id,
    request_id: row.post_id,
    request_title: row.request_title || "",
    request_description: row.request_description || "",
    request_category: row.request_category || "",
    service_domain: row.service_domain || "",
    service_specialty: row.service_specialty || "",
    introduction_text: row.introduction_text || "",
    status: row.status,
    created_at: row.created_at,
    responded_at: row.responded_at,
    accepted_at: row.accepted_at,
    declined_at: row.declined_at,
    withdrawn_at: row.withdrawn_at,
    closed_at: row.closed_at,
    conversation_available: row.status === RELATIONSHIP_STATUSES.ACTIVE,
  };
}

module.exports = {
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_STATUS_VALUES,
  canHomeownerAcceptRelationship,
  canHomeownerDeclineRelationship,
  canProfessionalWithdrawRelationship,
  cleanText,
  isValidPositiveInteger,
  parsePositiveInteger,
  serializePendingRelationshipForHomeowner,
  serializeRelationshipForProfessional,
  validateProfessionalResponsePayload,
  validateRelationshipStatus,
};
