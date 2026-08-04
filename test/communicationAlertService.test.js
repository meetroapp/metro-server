"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  COMMUNICATION_ALERT_POLICY,
  buildCommunicationAttentionDedupeKey,
  buildCommunicationSafePreview,
  createOrRefreshCommunicationMessageAlert,
  getCommunicationAttentionWindowWithClient,
  resolveCommunicationMessageAlerts,
  resolveCommunicationRecipient,
} = require("../server/alerts/communicationAlertService");

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function alertRow({
  id = 301,
  recipientUserId = 9,
  lifecycle = "active",
  safePayload = { shortPreview: "Hello", unreadCount: 1 },
  sourceEventId = "201",
  availableAt = "2026-08-04T12:00:00.000Z",
} = {}) {
  return {
    id,
    recipient_user_id: recipientUserId,
    source_domain: "communication",
    source_event_type: "conversation.message_created",
    source_entity_type: "conversation",
    source_entity_id: "91",
    source_event_id: sourceEventId,
    category: "communication",
    priority: "normal",
    title_key: "alerts.communication.newMessage.title",
    message_key: "alerts.communication.newMessage.message",
    safe_payload: safePayload,
    destination_type: "conversation",
    destination_payload: { conversationId: 91 },
    dedupe_key: "communication:conversation:91:recipient:9:after:0",
    lifecycle_state: lifecycle,
    available_at: availableAt,
    expires_at: null,
    read_at: null,
    dismissed_at: lifecycle === "dismissed" ? availableAt : null,
    resolved_at: null,
    archived_at: null,
    created_at: availableAt,
    updated_at: availableAt,
  };
}

function createClient({
  marker = null,
  participantStatePresent = true,
  unreadCount = 1,
  existingAlert = null,
  resolvedRows = [],
  failOn = null,
} = {}) {
  const calls = [];
  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });
      if (failOn && sql.includes(failOn)) {
        throw new Error("private communication alert failure");
      }
      if (
        sql.includes("FROM conversation_participant_state") &&
        sql.includes("last_read_message_id")
      ) {
        return {
          rows: participantStatePresent
            ? [{ last_read_message_id: marker }]
            : [],
        };
      }
      if (sql.includes("COUNT(*)::bigint AS unread_count")) {
        return { rows: [{ unread_count: String(unreadCount) }] };
      }
      if (sql.includes("INSERT INTO alerts")) {
        return existingAlert
          ? { rows: [], rowCount: 0 }
          : { rows: [alertRow()], rowCount: 1 };
      }
      if (
        sql.includes("FROM alerts") &&
        sql.includes("dedupe_key = $2")
      ) {
        return { rows: [existingAlert].filter(Boolean) };
      }
      if (
        sql.includes("UPDATE alerts") &&
        sql.includes("safe_payload = $5::jsonb")
      ) {
        return {
          rows: [{
            id: existingAlert?.id || 301,
            lifecycle_state: existingAlert?.lifecycle_state || "active",
          }],
          rowCount: 1,
        };
      }
      if (
        sql.includes("UPDATE alerts") &&
        sql.includes("lifecycle_state = 'resolved'")
      ) {
        return { rows: resolvedRows };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { client, calls };
}

test("communication policy uses exact canonical source, destination, and localization keys", () => {
  assert.deepEqual(COMMUNICATION_ALERT_POLICY, {
    sourceDomain: "communication",
    sourceEventType: "conversation.message_created",
    sourceEntityType: "conversation",
    category: "communication",
    priority: "normal",
    titleKey: "alerts.communication.newMessage.title",
    messageKey: "alerts.communication.newMessage.message",
  });
});

test("recipient derives only from canonical conversation participants", () => {
  const conversation = {
    id: 91,
    homeowner_id: 7,
    professional_user_id: 9,
  };
  assert.equal(resolveCommunicationRecipient(conversation, 7), 9);
  assert.equal(resolveCommunicationRecipient(conversation, 9), 7);
  assert.equal(resolveCommunicationRecipient(conversation, 10), null);
  assert.equal(resolveCommunicationRecipient({ ...conversation, professional_user_id: 7 }, 7), null);
});

test("attention-window dedupe is deterministic, private, and marker scoped", () => {
  assert.equal(
    buildCommunicationAttentionDedupeKey({
      conversationId: 91,
      recipientUserId: 9,
      lastReadMessageId: null,
    }),
    "communication:conversation:91:recipient:9:after:0"
  );
  assert.equal(
    buildCommunicationAttentionDedupeKey({
      conversationId: 91,
      recipientUserId: 9,
      lastReadMessageId: 200,
    }),
    "communication:conversation:91:recipient:9:after:200"
  );
  assert.throws(
    () => buildCommunicationAttentionDedupeKey({
      conversationId: "request-91",
      recipientUserId: 9,
      lastReadMessageId: 0,
    }),
    /canonical communication identity/i
  );
});

test("safe preview is bounded and falls back for unsupported or unsafe content", () => {
  assert.equal(
    buildCommunicationSafePreview({
      message_type: "text",
      message_text: `  ${"a".repeat(200)}  `,
    }),
    "a".repeat(160)
  );
  for (const message of [
    { message_type: "workflow", message_text: "internal" },
    { message_type: "text", message_text: "   " },
    { message_type: "text", message_text: "<strong>private</strong>" },
    { message_type: "text", message_text: "https://example.test/private" },
    { message_type: "image", message_text: "caption" },
  ]) {
    assert.equal(buildCommunicationSafePreview(message), "New message");
  }
});

test("recipient attention marker is read after participant-state repair authority", async () => {
  const fake = createClient({ marker: 155 });
  const result = await getCommunicationAttentionWindowWithClient({
    client: fake.client,
    conversationId: 91,
    recipientUserId: 9,
  });
  assert.deepEqual(result, { lastReadMessageId: 155 });
  assert.deepEqual(fake.calls[0].params, [91, 9]);
  assert.match(fake.calls[0].sql, /conversation_id = \$1 AND user_id = \$2/);
  assert.match(fake.calls[0].sql, /FOR UPDATE/);
});

test("missing recipient participant state fails safely before message alert work", async () => {
  const fake = createClient({ participantStatePresent: false });
  await assert.rejects(
    getCommunicationAttentionWindowWithClient({
      client: fake.client,
      conversationId: 91,
      recipientUserId: 9,
    }),
    /participant state is unavailable/i
  );
  assert.equal(fake.calls.length, 1);
});

test("first unread message creates one recipient-scoped communication alert", async () => {
  const fake = createClient({ marker: null, unreadCount: 1 });
  const result = await createOrRefreshCommunicationMessageAlert({
    client: fake.client,
    conversation: {
      id: 91,
      homeowner_id: 7,
      professional_user_id: 9,
    },
    senderUserId: 7,
    recipientUserId: 9,
    recipientLastReadMessageId: null,
    message: {
      id: 201,
      sender_id: 7,
      receiver_id: 9,
      message_type: "text",
      message_text: "Hello professional",
      created_at: "2026-08-04T12:00:00.000Z",
    },
  });
  assert.equal(result.created, true);
  const count = fake.calls.find(({ sql }) => sql.includes("COUNT(*)::bigint"));
  assert.deepEqual(count.params, [91, 9, null]);
  assert.match(count.sql, /messages\.sender_id <> \$2/);
  assert.match(count.sql, /messages\.id > COALESCE\(\$3::integer, 0\)/);
  const insert = fake.calls.find(({ sql }) => sql.includes("INSERT INTO alerts"));
  assert.equal(insert.params[0], 9);
  assert.equal(insert.params[1], "communication");
  assert.equal(insert.params[2], "conversation.message_created");
  assert.equal(insert.params[3], "conversation");
  assert.equal(insert.params[4], "91");
  assert.equal(insert.params[5], "201");
  assert.deepEqual(JSON.parse(insert.params[10]), {
    shortPreview: "Hello professional",
    unreadCount: 1,
  });
  assert.equal(insert.params[11], "conversation");
  assert.deepEqual(JSON.parse(insert.params[12]), { conversationId: 91 });
  assert.equal(insert.params[13], "communication:conversation:91:recipient:9:after:0");
  assert.doesNotMatch(insert.params[10], /message_text|body|content|location|email|phone/i);
});

test("same unread window refreshes presentation without reopening a dismissed alert", async () => {
  const existing = alertRow({ lifecycle: "dismissed" });
  const fake = createClient({
    marker: null,
    unreadCount: 2,
    existingAlert: existing,
  });
  const result = await createOrRefreshCommunicationMessageAlert({
    client: fake.client,
    conversation: {
      id: 91,
      homeowner_id: 7,
      professional_user_id: 9,
    },
    senderUserId: 7,
    recipientUserId: 9,
    recipientLastReadMessageId: null,
    message: {
      id: 202,
      sender_id: 7,
      receiver_id: 9,
      message_type: "text",
      message_text: "Second message",
      created_at: "2026-08-04T12:01:00.000Z",
    },
  });
  assert.equal(result.created, false);
  const refresh = fake.calls.find(({ sql }) =>
    sql.includes("UPDATE alerts") && sql.includes("safe_payload = $5::jsonb")
  );
  assert.ok(refresh);
  assert.deepEqual(refresh.params.slice(0, 4), [
    301,
    9,
    "communication:conversation:91:recipient:9:after:0",
    "202",
  ]);
  assert.deepEqual(JSON.parse(refresh.params[4]), {
    shortPreview: "Second message",
    unreadCount: 2,
  });
  assert.match(refresh.sql, /lifecycle_state IN \('active', 'dismissed'\)/);
  assert.doesNotMatch(refresh.sql, /SET[\s\S]*lifecycle_state\s*=/);
  assert.doesNotMatch(refresh.sql, /dismissed_at\s*=/);
});

test("post-read marker produces a new attention-window dedupe key", async () => {
  const fake = createClient({ marker: 202, unreadCount: 1 });
  await createOrRefreshCommunicationMessageAlert({
    client: fake.client,
    conversation: {
      id: 91,
      homeowner_id: 7,
      professional_user_id: 9,
    },
    senderUserId: 7,
    recipientUserId: 9,
    recipientLastReadMessageId: 202,
    message: {
      id: 203,
      sender_id: 7,
      receiver_id: 9,
      message_type: "text",
      message_text: "After read",
      created_at: "2026-08-04T12:02:00.000Z",
    },
  });
  const insert = fake.calls.find(({ sql }) => sql.includes("INSERT INTO alerts"));
  assert.equal(insert.params[13], "communication:conversation:91:recipient:9:after:202");
});

test("different recipients and conversations have independent attention windows", () => {
  const first = buildCommunicationAttentionDedupeKey({
    conversationId: 91,
    recipientUserId: 9,
    lastReadMessageId: 200,
  });
  const otherRecipient = buildCommunicationAttentionDedupeKey({
    conversationId: 91,
    recipientUserId: 7,
    lastReadMessageId: 200,
  });
  const otherConversation = buildCommunicationAttentionDedupeKey({
    conversationId: 92,
    recipientUserId: 9,
    lastReadMessageId: 200,
  });
  assert.notEqual(first, otherRecipient);
  assert.notEqual(first, otherConversation);
});

test("communication alert creation rejects mismatched sender, recipient, and message identity", async () => {
  for (const override of [
    { recipientUserId: 7 },
    { senderUserId: 10 },
    { message: { sender_id: 9 } },
    { message: { receiver_id: 7 } },
    { message: { id: 0 } },
  ]) {
    const fake = createClient();
    await assert.rejects(
      createOrRefreshCommunicationMessageAlert({
        client: fake.client,
        conversation: {
          id: 91,
          homeowner_id: 7,
          professional_user_id: 9,
        },
        senderUserId: override.senderUserId ?? 7,
        recipientUserId: override.recipientUserId ?? 9,
        recipientLastReadMessageId: null,
        message: {
          id: 201,
          sender_id: 7,
          receiver_id: 9,
          message_type: "text",
          message_text: "Hello",
          created_at: "2026-08-04T12:00:00.000Z",
          ...override.message,
        },
      }),
      /canonical communication identity/i
    );
    assert.equal(fake.calls.length, 0);
  }
});

test("invalid unread count fails closed before alert persistence", async () => {
  const fake = createClient({ unreadCount: "unsafe" });
  await assert.rejects(
    createOrRefreshCommunicationMessageAlert({
      client: fake.client,
      conversation: {
        id: 91,
        homeowner_id: 7,
        professional_user_id: 9,
      },
      senderUserId: 7,
      recipientUserId: 9,
      recipientLastReadMessageId: null,
      message: {
        id: 201,
        sender_id: 7,
        receiver_id: 9,
        message_type: "text",
        message_text: "Hello",
        created_at: "2026-08-04T12:00:00.000Z",
      },
    }),
    /unread count/i
  );
  assert.equal(fake.calls.some(({ sql }) => sql.includes("INSERT INTO alerts")), false);
});

test("conversation mark-read resolves only the participant communication obligation", async () => {
  const fake = createClient({ resolvedRows: [alertRow()] });
  const result = await resolveCommunicationMessageAlerts({
    client: fake.client,
    conversationId: 91,
    participantUserId: 9,
  });
  assert.equal(result.count, 1);
  const update = fake.calls.find(({ sql }) =>
    sql.includes("UPDATE alerts") && sql.includes("lifecycle_state = 'resolved'")
  );
  assert.ok(update);
  assert.deepEqual(update.params.slice(0, 5), [
    "communication",
    "conversation",
    "91",
    "conversation.message_created",
    9,
  ]);
  assert.match(update.sql, /recipient_user_id = \$5/);
  assert.match(update.sql, /lifecycle_state IN \('active', 'dismissed'\)/);
  assert.doesNotMatch(update.sql, /conversation_participant_state|messages|workflow_events|emergency_requests/i);
});

test("communication resolution is idempotent and validates identity before SQL", async () => {
  const fake = createClient({ resolvedRows: [] });
  assert.equal((await resolveCommunicationMessageAlerts({
    client: fake.client,
    conversationId: 91,
    participantUserId: 9,
  })).count, 0);

  const invalid = createClient();
  await assert.rejects(
    resolveCommunicationMessageAlerts({
      client: invalid.client,
      conversationId: "emergency-91",
      participantUserId: 9,
    }),
    /canonical communication identity/i
  );
  assert.equal(invalid.calls.length, 0);
});

test("communication alert failures propagate without client transaction ownership", async () => {
  const fake = createClient({ failOn: "INSERT INTO alerts" });
  await assert.rejects(
    createOrRefreshCommunicationMessageAlert({
      client: fake.client,
      conversation: {
        id: 91,
        homeowner_id: 7,
        professional_user_id: 9,
      },
      senderUserId: 7,
      recipientUserId: 9,
      recipientLastReadMessageId: null,
      message: {
        id: 201,
        sender_id: 7,
        receiver_id: 9,
        message_type: "text",
        message_text: "Do not log this private body",
        created_at: "2026-08-04T12:00:00.000Z",
      },
    }),
    /private communication alert failure/
  );
  assert.equal(fake.calls.some(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)), false);
});

test("Emergency-backed canonical conversations expose only communication-safe alert data", async () => {
  const fake = createClient();
  await createOrRefreshCommunicationMessageAlert({
    client: fake.client,
    conversation: {
      id: 91,
      homeowner_id: 7,
      professional_user_id: 9,
      emergency_request_id: 41,
      location: "private address",
      access_notes: "private access",
      safety_context: "private safety",
    },
    senderUserId: 7,
    recipientUserId: 9,
    recipientLastReadMessageId: null,
    message: {
      id: 201,
      sender_id: 7,
      receiver_id: 9,
      message_type: "text",
      message_text: "Safe short preview",
      created_at: "2026-08-04T12:00:00.000Z",
    },
  });
  const insert = fake.calls.find(({ sql }) => sql.includes("INSERT INTO alerts"));
  assert.equal(insert.params[1], "communication");
  assert.equal(insert.params[6], "communication");
  assert.equal(insert.params[11], "conversation");
  assert.deepEqual(JSON.parse(insert.params[12]), { conversationId: 91 });
  const persisted = JSON.stringify(insert.params);
  assert.doesNotMatch(
    persisted,
    /emergency|private address|private access|private safety|location|access_notes|safety_context/i
  );
});

test("attention-window authority uses no clock, randomness, browser, or delivery state", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server/alerts/communicationAlertService.js"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /Date\.now|Math\.random|randomUUID|localStorage|sessionStorage|push_token|APNs|FCM|sendEmail|sendSms/i
  );
});
