"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isConversationParticipant,
  serializeConversationMessage,
} = require("../server/conversations/conversations");
const {
  listConversationMessages,
} = require("../server/conversations/conversationMessageService");

function ordinaryMessage(overrides = {}) {
  return {
    id: 201,
    sender_id: 9,
    receiver_id: 7,
    message_text: "I’m on my way.",
    image_url: null,
    message_type: "text",
    workflow_type: null,
    workflow_status: null,
    workflow_payload: {},
    created_at: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

test("completed delegated provenance serializes only safe employee presentation fields", () => {
  const serialized = serializeConversationMessage(ordinaryMessage({
    delegated_author_type: "FIELD_EMPLOYEE",
    delegated_author_display_name: "  Liam Molina  ",
    delegated_author_role: "FIELD_EMPLOYEE",
    delegated_command_id: "must-not-leak",
    delegated_membership_id: "must-not-leak",
    delegated_actor_user_id: 44,
  }), 7);

  assert.deepEqual(serialized.delegatedAuthor, {
    type: "FIELD_EMPLOYEE",
    displayName: "Liam Molina",
    role: "FIELD_EMPLOYEE",
  });
  assert.deepEqual(Object.keys(serialized.delegatedAuthor).sort(), ["displayName", "role", "type"]);
  assert.deepEqual(serialized.sender, { id: 9, isViewer: false });
  assert.deepEqual(serialized.recipient, { id: 7 });
  for (const internal of [
    "delegated_command_id",
    "delegated_membership_id",
    "delegated_actor_user_id",
    "assignmentId",
    "idempotencyKey",
    "requestFingerprint",
  ]) {
    assert.equal(Object.hasOwn(serialized, internal), false);
    assert.equal(Object.hasOwn(serialized.delegatedAuthor, internal), false);
  }
});

test("normal, incomplete, and malformed attribution fail closed", () => {
  for (const row of [
    ordinaryMessage(),
    ordinaryMessage({
      delegated_author_type: "FIELD_EMPLOYEE",
      delegated_author_display_name: "Liam Molina",
      delegated_author_role: null,
    }),
    ordinaryMessage({
      delegated_author_type: "FIELD_EMPLOYEE",
      delegated_author_display_name: " ",
      delegated_author_role: "FIELD_EMPLOYEE",
    }),
    ordinaryMessage({
      delegated_author_type: "BUSINESS",
      delegated_author_display_name: "Owner",
      delegated_author_role: "OWNER",
    }),
  ]) {
    assert.equal(Object.hasOwn(serializeConversationMessage(row, 9), "delegatedAuthor"), false);
  }
});

test("immutable completed attribution survives later membership role and status changes", () => {
  for (const currentMembership of [
    { role: "MANAGER", status: "ACTIVE" },
    { role: "FIELD_EMPLOYEE", status: "INACTIVE" },
    { role: "MANAGER", status: "INACTIVE" },
  ]) {
    const serialized = serializeConversationMessage(ordinaryMessage({
      delegated_author_type: "FIELD_EMPLOYEE",
      delegated_author_display_name: "Liam Molina",
      delegated_author_role: "FIELD_EMPLOYEE",
      current_membership_role: currentMembership.role,
      current_membership_status: currentMembership.status,
    }), 7);
    assert.deepEqual(serialized.delegatedAuthor, {
      type: "FIELD_EMPLOYEE",
      displayName: "Liam Molina",
      role: "FIELD_EMPLOYEE",
    });
    assert.equal(Object.hasOwn(serialized, "current_membership_role"), false);
    assert.equal(Object.hasOwn(serialized, "current_membership_status"), false);
  }
});

test("canonical participation remains exactly homeowner and professional", () => {
  const conversation = { homeowner_id: 7, professional_user_id: 9 };
  assert.equal(isConversationParticipant(conversation, 7), true);
  assert.equal(isConversationParticipant(conversation, 9), true);
  assert.equal(isConversationParticipant(conversation, 44), false);
});

test("canonical list batches exact completed provenance and isolates unrelated and private messages", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      return { rows: [] };
    },
  };

  await listConversationMessages({ pool, conversationId: 91, limit: 25 });
  assert.equal(calls.length, 1, "attribution must not introduce an N+1 query");
  const { sql } = calls[0];
  assert.match(sql, /LEFT JOIN business_job_customer_message_commands delegated_commands ON delegated_commands\.result_message_id = messages\.id AND delegated_commands\.completed_at IS NOT NULL/);
  assert.match(sql, /delegated_assignments\.id = delegated_commands\.assignment_id/);
  assert.match(sql, /delegated_assignments\.job_id = delegated_commands\.job_id/);
  assert.match(sql, /delegated_memberships\.id = delegated_commands\.membership_id/);
  assert.match(sql, /delegated_memberships\.user_id = delegated_commands\.actor_user_id/);
  assert.doesNotMatch(sql, /delegated_memberships\.role\s*=/);
  assert.doesNotMatch(sql, /delegated_memberships\.status\s*=/);
  assert.match(sql, /delegated_jobs\.source_request_selection_id = message_conversations\.request_selection_id/);
  assert.match(sql, /delegated_jobs\.source_request_relationship_id = message_conversations\.relationship_id/);
  assert.match(sql, /messages\.sender_id = message_conversations\.professional_user_id/);
  assert.match(sql, /messages\.receiver_id = message_conversations\.homeowner_id/);
  assert.doesNotMatch(sql, /business_job_field_messages/);
  assert.doesNotMatch(sql, /AS delegated_(?:command|membership|assignment|actor)_id/);
});
