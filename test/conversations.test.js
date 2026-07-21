"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_VALUES,
  canArchiveConversation,
  canCloseConversation,
  canRestoreConversation,
  isConversationParticipant,
  isValidPositiveInteger,
  parsePositiveInteger,
  participantArchiveField,
  serializeConversationForHomeowner,
  serializeConversationForProfessional,
  validateConversationStatus,
} = require("../server/conversations/conversations");

test("conversation statuses expose the governed shared lifecycle", () => {
  assert.deepEqual(CONVERSATION_STATUSES, {
    ACTIVE: "active",
    CLOSED: "closed",
  });

  assert.deepEqual(CONVERSATION_STATUS_VALUES, [
    "active",
    "closed",
  ]);
});

test("positive integer parsing rejects malformed and unsafe identifiers", () => {
  assert.equal(isValidPositiveInteger("1"), true);
  assert.equal(isValidPositiveInteger(42), true);

  for (const invalid of [
    undefined,
    null,
    "",
    "0",
    0,
    "-1",
    "1.5",
    "abc",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(isValidPositiveInteger(invalid), false);
    assert.equal(parsePositiveInteger(invalid), null);
  }

  assert.equal(parsePositiveInteger("42"), 42);
});

test("conversation status validation rejects archive as a shared status", () => {
  assert.equal(validateConversationStatus("active"), true);
  assert.equal(validateConversationStatus("closed"), true);

  for (const unsupported of [
    "archived",
    "pending",
    "declined",
    "withdrawn",
    "deleted",
    "",
    null,
  ]) {
    assert.equal(validateConversationStatus(unsupported), false);
  }
});

test("conversation participant checks are owner scoped", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
  };

  assert.equal(isConversationParticipant(conversation, 7), true);
  assert.equal(isConversationParticipant(conversation, 9), true);
  assert.equal(isConversationParticipant(conversation, 10), false);

  assert.equal(
    participantArchiveField(conversation, 7),
    "homeowner_archived_at"
  );

  assert.equal(
    participantArchiveField(conversation, 9),
    "professional_archived_at"
  );

  assert.equal(participantArchiveField(conversation, 10), null);
});

test("each participant can archive their own active inbox record independently", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
  };

  assert.equal(canArchiveConversation(conversation, 7), true);
  assert.equal(canArchiveConversation(conversation, 9), false);
  assert.equal(canArchiveConversation(conversation, 10), false);
});

test("each participant can restore only their own archived inbox record", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
    homeowner_archived_at: "2026-07-21T14:00:00.000Z",
    professional_archived_at: null,
  };

  assert.equal(canRestoreConversation(conversation, 7), true);
  assert.equal(canRestoreConversation(conversation, 9), false);
  assert.equal(canRestoreConversation(conversation, 10), false);
});

test("closed conversations cannot be archived or restored", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "closed",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
  };

  assert.equal(canArchiveConversation(conversation, 7), false);
  assert.equal(canRestoreConversation(conversation, 9), false);
});

test("conversation closure is participant scoped and irreversible", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
  };

  assert.equal(canCloseConversation(conversation, 7), true);
  assert.equal(canCloseConversation(conversation, 9), true);
  assert.equal(canCloseConversation(conversation, 10), false);

  assert.equal(
    canCloseConversation(
      { ...conversation, status: "closed" },
      7
    ),
    false
  );
});

test("homeowner serializer exposes only the homeowner archive state", () => {
  const serialized = serializeConversationForHomeowner({
    id: 51,
    relationship_id: 31,
    homeowner_id: 7,
    professional_user_id: 9,
    contractor_id: 80,
    business_name: "Molina Home Services",
    business_image_url: "https://example.com/logo.jpg",
    professional_category: "Home Services",
    status: "active",
    homeowner_archived_at: "2026-07-21T14:00:00.000Z",
    professional_archived_at: null,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.deepEqual(serialized, {
    id: 51,
    relationship_id: 31,
    contractor_id: 80,
    business_name: "Molina Home Services",
    business_image_url: "https://example.com/logo.jpg",
    professional_category: "Home Services",
    status: "active",
    archived: true,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.equal(Object.hasOwn(serialized, "homeowner_id"), false);
  assert.equal(Object.hasOwn(serialized, "professional_user_id"), false);
  assert.equal(
    Object.hasOwn(serialized, "professional_archived_at"),
    false
  );
});

test("professional serializer exposes only the professional archive state", () => {
  const serialized = serializeConversationForProfessional({
    id: 51,
    relationship_id: 31,
    post_id: 41,
    homeowner_id: 7,
    professional_user_id: 9,
    contractor_id: 80,
    request_title: "Kitchen drywall repair",
    homeowner_display_name: "William",
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.deepEqual(serialized, {
    id: 51,
    relationship_id: 31,
    request_id: 41,
    request_title: "Kitchen drywall repair",
    homeowner_display_name: "William",
    status: "active",
    archived: true,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.equal(Object.hasOwn(serialized, "homeowner_id"), false);
  assert.equal(Object.hasOwn(serialized, "professional_user_id"), false);
  assert.equal(Object.hasOwn(serialized, "contractor_id"), false);
  assert.equal(
    Object.hasOwn(serialized, "homeowner_archived_at"),
    false
  );
});
