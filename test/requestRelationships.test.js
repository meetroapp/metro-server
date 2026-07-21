"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RELATIONSHIP_STATUSES,
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
} = require("../server/relationships/requestRelationships");

test("relationship statuses expose the governed lifecycle", () => {
  assert.deepEqual(RELATIONSHIP_STATUSES, {
    PENDING: "pending",
    ACTIVE: "active",
    DECLINED: "declined",
    WITHDRAWN: "withdrawn",
    CLOSED: "closed",
  });

  for (const status of Object.values(RELATIONSHIP_STATUSES)) {
    assert.equal(validateRelationshipStatus(status), true);
  }

  assert.equal(validateRelationshipStatus("accepted"), false);
  assert.equal(validateRelationshipStatus(""), false);
  assert.equal(validateRelationshipStatus(undefined), false);
});

test("positive integer parsing rejects malformed and unsafe identifiers", () => {
  assert.equal(isValidPositiveInteger("41"), true);
  assert.equal(isValidPositiveInteger(41), true);
  assert.equal(parsePositiveInteger("41"), 41);

  for (const value of [
    "",
    "0",
    0,
    "-1",
    "41abc",
    "1.5",
    null,
    undefined,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(isValidPositiveInteger(value), false);
    assert.equal(parsePositiveInteger(value), null);
  }
});

test("professional response requires a non-empty governed introduction", () => {
  const missing = validateProfessionalResponsePayload({});
  assert.equal(missing.valid, false);
  assert.equal(missing.code, "INTRODUCTION_REQUIRED");

  const whitespace = validateProfessionalResponsePayload({
    introduction_text: "   ",
  });
  assert.equal(whitespace.valid, false);

  const valid = validateProfessionalResponsePayload({
    introduction_text: "  I can help with this repair.  ",
  });

  assert.deepEqual(valid, {
    valid: true,
    value: {
      introductionText: "I can help with this repair.",
    },
  });
});

test("professional introductions are bounded", () => {
  const introduction = "a".repeat(2500);
  const result = validateProfessionalResponsePayload({
    introduction_text: introduction,
  });

  assert.equal(result.valid, true);
  assert.equal(result.value.introductionText.length, 2000);
});

test("pending relationship transitions enforce participant ownership", () => {
  const relationship = {
    status: RELATIONSHIP_STATUSES.PENDING,
    homeowner_id: 7,
    professional_user_id: 9,
  };

  assert.equal(canHomeownerAcceptRelationship(relationship, 7), true);
  assert.equal(canHomeownerAcceptRelationship(relationship, 9), false);

  assert.equal(canHomeownerDeclineRelationship(relationship, "7"), true);
  assert.equal(canHomeownerDeclineRelationship(relationship, 9), false);

  assert.equal(canProfessionalWithdrawRelationship(relationship, 9), true);
  assert.equal(canProfessionalWithdrawRelationship(relationship, 7), false);
});

test("non-pending relationships cannot use pending transitions", () => {
  for (const status of [
    RELATIONSHIP_STATUSES.ACTIVE,
    RELATIONSHIP_STATUSES.DECLINED,
    RELATIONSHIP_STATUSES.WITHDRAWN,
    RELATIONSHIP_STATUSES.CLOSED,
  ]) {
    const relationship = {
      status,
      homeowner_id: 7,
      professional_user_id: 9,
    };

    assert.equal(canHomeownerAcceptRelationship(relationship, 7), false);
    assert.equal(canHomeownerDeclineRelationship(relationship, 7), false);
    assert.equal(canProfessionalWithdrawRelationship(relationship, 9), false);
  }
});

test("homeowner serializer exposes business response without private professional ownership data", () => {
  const serialized = serializePendingRelationshipForHomeowner({
    id: 51,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    request_title: "Drywall Repair",
    business_name: "Trusted Repairs",
    business_image_url: "https://example.test/logo.jpg",
    professional_category: "handyman",
    introduction_text: "I can help.",
    status: "pending",
    created_at: "2026-07-20T10:00:00.000Z",
    responded_at: "2026-07-20T10:00:00.000Z",
  });

  assert.deepEqual(serialized, {
    id: 51,
    request_id: 41,
    contractor_id: 80,
    request_title: "Drywall Repair",
    business_name: "Trusted Repairs",
    business_image_url: "https://example.test/logo.jpg",
    professional_category: "handyman",
    introduction_text: "I can help.",
    status: "pending",
    created_at: "2026-07-20T10:00:00.000Z",
    responded_at: "2026-07-20T10:00:00.000Z",
  });

  assert.equal(Object.hasOwn(serialized, "homeowner_id"), false);
  assert.equal(Object.hasOwn(serialized, "professional_user_id"), false);
});

test("professional serializer exposes request-safe relationship state", () => {
  const serialized = serializeRelationshipForProfessional({
    id: 51,
    post_id: 41,
    homeowner_id: 7,
    professional_user_id: 9,
    request_title: "Drywall Repair",
    request_description: "Repair wall damage",
    request_category: "drywall",
    service_domain: "home_services",
    service_specialty: "drywall_repair",
    introduction_text: "I can help.",
    status: "active",
    created_at: "2026-07-20T10:00:00.000Z",
    responded_at: "2026-07-20T10:00:00.000Z",
    accepted_at: "2026-07-20T11:00:00.000Z",
    declined_at: null,
    withdrawn_at: null,
    closed_at: null,
  });

  assert.equal(serialized.request_id, 41);
  assert.equal(serialized.status, "active");
  assert.equal(serialized.conversation_available, true);
  assert.equal(Object.hasOwn(serialized, "homeowner_id"), false);
  assert.equal(Object.hasOwn(serialized, "professional_user_id"), false);
});

test("cleanText normalizes null values and trims bounded text", () => {
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.equal(cleanText("  hello  "), "hello");
  assert.equal(cleanText("abcdef", 3), "abc");
});
