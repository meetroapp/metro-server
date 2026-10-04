"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RELATIONSHIP_STATUSES,
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

test("opaque positive identifiers preserve PostgreSQL BIGINT values exactly", () => {
  assert.equal(parsePositiveOpaqueId("41"), 41);
  assert.equal(
    parsePositiveOpaqueId("9007199254740993"),
    "9007199254740993"
  );

  for (const value of ["", "0", 0, "-1", "41abc", "1.5", null, undefined]) {
    assert.equal(parsePositiveOpaqueId(value), null);
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

test("professional response command rejects every client-owned authority field", () => {
  for (const payload of [
    null,
    [],
    "response",
    { introduction_text: "I can help.", responseId: 91 },
    { introduction_text: "I can help.", contractorId: 80 },
    { introduction_text: "I can help.", status: "selected" },
    { introduction_text: "I can help.", conversationId: 101 },
  ]) {
    const result = validateProfessionalResponsePayload(payload);
    assert.equal(result.valid, false);
  }
});

test("professional response idempotency keys are explicit and bounded", () => {
  assert.deepEqual(
    validateProfessionalResponseIdempotencyKey(
      " professional-response:command-1 "
    ),
    {
      valid: true,
      value: "professional-response:command-1",
    }
  );

  for (const value of [
    undefined,
    null,
    "",
    "contains spaces",
    "a".repeat(201),
  ]) {
    const result = validateProfessionalResponseIdempotencyKey(value);
    assert.equal(result.valid, false);
    assert.equal(
      result.code,
      "INVALID_PROFESSIONAL_RESPONSE_IDEMPOTENCY_KEY"
    );
  }
});

test("canonical response serializer keeps response and relationship truth distinct", () => {
  const projection = serializeCanonicalProfessionalResponse({
    response_id: "901",
    post_id: 41,
    response_status: "submitted",
    response_current_version: 1,
    response_introduction_text: "I can help.",
    response_submitted_at: "2026-08-06T12:00:00.000Z",
    response_updated_at: "2026-08-06T12:00:00.000Z",
    relationship_id: 501,
    relationship_status: "pending",
    ordinary_authority_source: "professional_response",
    relationship_current_version: 1,
    relationship_created_at: "2026-08-06T12:00:00.000Z",
    business_name: "Trusted Repairs",
    professional_category: "handyman",
    business_image_url: "https://example.test/logo.jpg",
  }, "created");

  assert.equal(projection.response.status, "submitted");
  assert.equal(projection.relationship.status, "pending");
  assert.equal(projection.relationship.authority_source, "professional_response");
  assert.equal(projection.resultClassification, "created");
  assert.equal(Object.hasOwn(projection, "conversation"), false);
  assert.equal(Object.hasOwn(projection.response, "content_fingerprint"), false);
});

test("Emergency response payload accepts only an absent or empty plain object", () => {
  assert.equal(validateEmergencyResponsePayload(undefined).valid, true);
  assert.equal(validateEmergencyResponsePayload({}).valid, true);
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);

  for (const payload of [
    null,
    [],
    "",
    0,
    false,
    new Date(),
    { status: "pending" },
    { introduction_text: "I can help." },
  ]) {
    const result = validateEmergencyResponsePayload(payload);
    assert.equal(result.valid, false);
    assert.equal(
      result.code,
      "UNSUPPORTED_EMERGENCY_RESPONSE_FIELDS"
    );
  }
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
    response_id: null,
    response_status: null,
    relationship_status: "pending",
    authority_source: null,
    created_at: "2026-07-20T10:00:00.000Z",
    responded_at: "2026-07-20T10:00:00.000Z",
    submitted_at: "2026-07-20T10:00:00.000Z",
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
    response_id: null,
    response_status: null,
    relationship_status: "pending",
    authority_source: null,
    created_at: "2026-07-20T10:00:00.000Z",
    responded_at: "2026-07-20T10:00:00.000Z",
    submitted_at: "2026-07-20T10:00:00.000Z",
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
  assert.equal(serialized.response_id, null);
  assert.equal(serialized.response_status, null);
  assert.equal(serialized.relationship_status, "active");
  assert.equal(serialized.authority_source, null);
  assert.equal(serialized.conversation_available, false);
  assert.equal(Object.hasOwn(serialized, "homeowner_id"), false);
  assert.equal(Object.hasOwn(serialized, "professional_user_id"), false);
});

test("canonical relationship serializers expose response truth without conversation authority", () => {
  const row = {
    id: 501,
    post_id: 41,
    contractor_id: 80,
    professional_user_id: 9,
    request_title: "Drywall Repair",
    request_description: "Repair wall damage",
    request_category: "drywall",
    service_domain: "home_services",
    service_specialty: "drywall_repair",
    business_name: "Trusted Repairs",
    professional_category: "handyman",
    business_image_url: "https://example.test/logo.jpg",
    introduction_text: "",
    status: "pending",
    professional_response_id: "901",
    ordinary_authority_source: "professional_response",
    relationship_current_version: 1,
    response_id: "901",
    response_status: "submitted",
    response_current_version: 1,
    response_introduction_text: "I can help.",
    response_submitted_at: "2026-08-06T12:00:00.000Z",
    created_at: "2026-08-06T12:00:00.000Z",
    responded_at: "2026-08-06T12:00:00.000Z",
  };

  const homeowner = serializePendingRelationshipForHomeowner(row);
  const professional = serializeRelationshipForProfessional(row);

  for (const projection of [homeowner, professional]) {
    assert.equal(projection.response_id, "901");
    assert.equal(projection.response_status, "submitted");
    assert.equal(projection.relationship_status, "pending");
    assert.equal(projection.authority_source, "professional_response");
    assert.equal(projection.introduction_text, "I can help.");
  }
  assert.equal(professional.conversation_available, false);
  assert.equal(professional.conversation_id, null);
  assert.equal(Object.hasOwn(homeowner, "conversation_id"), false);
  assert.equal(Object.hasOwn(homeowner, "professional_user_id"), false);
  assert.equal(Object.hasOwn(professional, "homeowner_id"), false);
});

test("Emergency response serializer exposes only the approved pending projection", () => {
  const serialized = serializeEmergencyResponseRelationship({
    id: 151,
    post_id: null,
    emergency_request_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "pending",
    introduction_text: "",
    created_at: "created",
    responded_at: "responded",
    location_text: "Private",
    disposition: "continue",
    conversation_id: 91,
  });

  assert.deepEqual(serialized, {
    id: 151,
    emergencyRequestId: 41,
    status: "pending",
    conversationAvailable: false,
    createdAt: "created",
    respondedAt: "responded",
  });
  assert.deepEqual(Object.keys(serialized), [
    "id",
    "emergencyRequestId",
    "status",
    "conversationAvailable",
    "createdAt",
    "respondedAt",
  ]);
});

test("homeowner Emergency response serializer exposes the exact approved projection", () => {
  const base = {
    id: 151,
    emergency_request_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    post_id: null,
    status: "active",
    introduction_text: "Private",
    responded_at: "responded",
    created_at: "created",
    accepted_at: "accepted",
    declined_at: null,
    withdrawn_at: null,
    closed_at: null,
    canonical_conversation_exists: true,
    conversation_id: 91,
    business_name: "Example Electric",
    professional_category: "electrical",
    service_specialties:
      '["emergency_wiring","  panel_repair  ",null,""]',
    business_image_url:
      "https://example.test/business-logo.jpg",
    profile_details: { private: true },
    email: "private@example.test",
  };
  const serialized =
    serializeHomeownerEmergencyResponse(base);

  assert.deepEqual(serialized, {
    id: 151,
    emergencyRequestId: 41,
    status: "active",
    respondedAt: "responded",
    createdAt: "created",
    acceptedAt: "accepted",
    declinedAt: null,
    withdrawnAt: null,
    closedAt: null,
    conversationAvailable: true,
    professional: {
      businessName: "Example Electric",
      category: "electrical",
      serviceSpecialties: [
        "emergency_wiring",
        "panel_repair",
      ],
      profileImageUrl: null,
      businessLogoUrl:
        "https://example.test/business-logo.jpg",
    },
  });
  assert.deepEqual(Object.keys(serialized), [
    "id",
    "emergencyRequestId",
    "status",
    "respondedAt",
    "createdAt",
    "acceptedAt",
    "declinedAt",
    "withdrawnAt",
    "closedAt",
    "conversationAvailable",
    "professional",
  ]);
  assert.deepEqual(Object.keys(serialized.professional), [
    "businessName",
    "category",
    "serviceSpecialties",
    "profileImageUrl",
    "businessLogoUrl",
  ]);
  assert.doesNotMatch(
    JSON.stringify(serialized),
    /homeowner_id|contractor_id|professional_user_id|post_id|introduction_text|conversation_id|profile_details|private@example/
  );
});

test("homeowner Emergency response serializer derives conversation availability from canonical state", () => {
  for (const [
    status,
    canonicalConversationExists,
    expected,
  ] of [
    ["pending", true, false],
    ["active", true, true],
    ["active", false, false],
    ["declined", true, false],
    ["withdrawn", true, false],
    ["closed", true, false],
  ]) {
    const serialized =
      serializeHomeownerEmergencyResponse({
        id: 151,
        emergency_request_id: 41,
        status,
        responded_at: "responded",
        created_at: "created",
        accepted_at:
          status === "active" ? "accepted" : null,
        declined_at:
          status === "declined" ? "declined" : null,
        withdrawn_at:
          status === "withdrawn" ? "withdrawn" : null,
        closed_at:
          status === "closed" ? "closed" : null,
        canonical_conversation_exists:
          canonicalConversationExists,
      });

    assert.equal(
      serialized.conversationAvailable,
      expected
    );
    assert.equal(serialized.status, status);
    assert.equal(
      serialized.declinedAt,
      status === "declined" ? "declined" : null
    );
    assert.equal(
      serialized.withdrawnAt,
      status === "withdrawn" ? "withdrawn" : null
    );
    assert.equal(
      serialized.closedAt,
      status === "closed" ? "closed" : null
    );
  }
});

test("cleanText normalizes null values and trims bounded text", () => {
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.equal(cleanText("  hello  "), "hello");
  assert.equal(cleanText("abcdef", 3), "abc");
});
