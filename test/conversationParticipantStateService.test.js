"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  advanceConversationParticipantReadStateWithClient,
  ensureConversationParticipantStatesWithClient,
  markConversationRead,
  resolveConversationParticipantRole,
  serializeConversationReadState,
} = require(
  "../server/conversations/conversationParticipantStateService"
);
const {
  createConversationMessage,
} = require("../server/conversations/conversationMessageService");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createMarkReadPool({
  conversationRows,
  latestMessageRows,
  readStateRows,
  alertRows = [],
  dedupeConflictRows = [],
  unreadCount = 1,
  failOn,
  direct = false,
} = {}) {
  const calls = [];
  let releases = 0;
  const defaultConversationRows = [{
    id: 91,
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
  }];
  const defaultLatestMessageRows = [{
    id: 205,
    created_at: "2026-08-03T12:00:00.000Z",
  }];

  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });

      if (failOn && sql.includes(failOn)) {
        throw new Error("private simulated read-state failure");
      }

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }

      if (
        sql.includes("FROM conversations") &&
        sql.includes("FOR UPDATE")
      ) {
        return {
          rows:
            conversationRows === undefined
              ? defaultConversationRows
              : conversationRows,
        };
      }

      if (
        sql.includes("FROM messages") &&
        sql.includes("messages.id = $1") &&
        sql.includes("messages.conversation_id = $2")
      ) {
        return {
          rows:
            latestMessageRows === undefined
              ? defaultLatestMessageRows
              : latestMessageRows,
        };
      }

      if (
        sql.includes("FROM alerts") &&
        sql.includes("LEFT JOIN messages AS source_message")
      ) {
        return { rows: alertRows };
      }

      if (
        sql.includes("FROM alerts") &&
        sql.includes("dedupe_key = $2") &&
        sql.includes("FOR UPDATE")
      ) {
        return { rows: dedupeConflictRows };
      }

      if (sql.includes("COUNT(*)::bigint AS unread_count")) {
        return { rows: [{ unread_count: String(unreadCount) }] };
      }

      if (
        sql.includes(
          "INSERT INTO conversation_participant_state AS participant_state"
        )
      ) {
        return {
          rows:
            readStateRows === undefined
              ? [{
                  conversation_id: params[0],
                  user_id: params[1],
                  participant_role: params[2],
                  last_read_message_id: params[3],
                  last_read_at:
                    params[4] ||
                    "2026-08-03T12:01:00.000Z",
                }]
              : readStateRows,
          rowCount:
            readStateRows?.length ?? 1,
        };
      }

      if (
        sql.includes("UPDATE alerts") &&
        sql.includes("lifecycle_state = 'resolved'")
      ) {
        return {
          rows: params[0].map((id) => ({ id })),
          rowCount: params[0].length,
        };
      }

      if (
        sql.includes("UPDATE alerts") &&
        sql.includes("dedupe_key = $3") &&
        sql.includes("safe_payload = $4::jsonb")
      ) {
        return {
          rows: [{
            id: params[0],
            lifecycle_state: "active",
            source_event_id: params[5],
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },

    release() {
      releases += 1;
    },
  };

  return {
    calls,
    pool: direct
      ? client
      : {
          async query() {
            throw new Error(
              "Pool query must not own the transaction."
            );
          },
          async connect() {
            return client;
          },
        },
    get releases() {
      return releases;
    },
  };
}

function statefulMessage({
  id,
  senderId = 9,
  receiverId = 7,
  text = `Message ${id}`,
} = {}) {
  return {
    id,
    conversation_id: 91,
    sender_id: senderId,
    receiver_id: receiverId,
    message_text: text,
    message_type: "text",
    created_at: `2026-08-03T12:${String(id).slice(-2)}:00.000Z`,
  };
}

function statefulAlert({
  id = 301,
  sourceEventId = 103,
  dedupeKey =
    "communication:conversation:91:recipient:7:after:101",
  safePayload = {
    shortPreview: `Message ${sourceEventId}`,
    unreadCount: 1,
  },
  lifecycle = "active",
  sourceEntityId = "91",
} = {}) {
  const timestamp = "2026-08-03T12:03:00.000Z";
  return {
    id,
    recipient_user_id: 7,
    source_domain: "communication",
    source_event_type: "conversation.message_created",
    source_entity_type: "conversation",
    source_entity_id: sourceEntityId,
    source_event_id: String(sourceEventId),
    category: "communication",
    priority: "normal",
    title_key: "alerts.communication.newMessage.title",
    message_key: "alerts.communication.newMessage.message",
    safe_payload: safePayload,
    destination_type: "conversation",
    destination_payload: { conversationId: 91 },
    dedupe_key: dedupeKey,
    lifecycle_state: lifecycle,
    available_at: timestamp,
    expires_at: null,
    read_at: null,
    dismissed_at: lifecycle === "dismissed" ? timestamp : null,
    resolved_at: null,
    archived_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function createStatefulConversationPool({
  marker = 101,
  messages = [statefulMessage({ id: 101 }), statefulMessage({ id: 103 })],
  alerts = [statefulAlert()],
  failOn = null,
  failCommit = false,
  conflictRows = null,
} = {}) {
  const calls = [];
  let releases = 0;
  let committed = {
    conversation: {
      id: 91,
      homeowner_id: 7,
      professional_user_id: 9,
      status: "active",
    },
    participants: {
      7: {
        conversation_id: 91,
        user_id: 7,
        participant_role: "homeowner",
        last_read_message_id: marker,
        last_read_at: "2026-08-03T12:01:00.000Z",
        updated_at: "2026-08-03T12:01:00.000Z",
      },
      9: {
        conversation_id: 91,
        user_id: 9,
        participant_role: "professional",
        last_read_message_id: null,
        last_read_at: null,
        updated_at: "2026-08-03T12:01:00.000Z",
      },
    },
    messages,
    alerts,
    participantMutations: 0,
    alertMutations: 0,
  };
  let transaction = null;
  const current = () => transaction || committed;
  const clone = (value) => structuredClone(value);

  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });

      if (sql === "BEGIN") {
        transaction = clone(committed);
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        transaction = null;
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        if (failCommit) {
          throw new Error("private simulated commit failure");
        }
        committed = transaction;
        transaction = null;
        return { rows: [] };
      }
      if (failOn && sql.includes(failOn)) {
        throw new Error("private simulated transactional failure");
      }

      const state = current();
      if (
        sql.includes("FROM conversations") &&
        sql.includes("FOR UPDATE")
      ) {
        const userId = Number(params[1]);
        const conversation = state.conversation;
        return {
          rows:
            Number(params[0]) === conversation.id &&
            [conversation.homeowner_id, conversation.professional_user_id]
              .includes(userId)
              ? [clone(conversation)]
              : [],
        };
      }

      if (
        sql.includes("FROM messages") &&
        sql.includes("messages.id = $1") &&
        sql.includes("messages.conversation_id = $2")
      ) {
        const message = state.messages.find(
          (candidate) =>
            candidate.id === Number(params[0]) &&
            candidate.conversation_id === Number(params[1])
        );
        return {
          rows: message
            ? [{ id: message.id, created_at: message.created_at }]
            : [],
        };
      }

      if (
        sql.includes("WITH participant_rows AS") &&
        sql.includes("INSERT INTO conversation_participant_state")
      ) {
        return { rows: [], rowCount: 2 };
      }

      if (
        sql.includes(
          "INSERT INTO conversation_participant_state AS participant_state"
        )
      ) {
        const userId = Number(params[1]);
        const participant = state.participants[userId];
        const nextMarker = params[3] === null ? null : Number(params[3]);
        const advances =
          nextMarker !== null &&
          (participant.last_read_message_id === null ||
            nextMarker > participant.last_read_message_id);
        const roleChanges = participant.participant_role !== params[2];
        if (!advances && !roleChanges) {
          return { rows: [], rowCount: 0 };
        }
        participant.participant_role = params[2];
        if (advances) {
          participant.last_read_message_id = nextMarker;
          participant.last_read_at = params[4];
          participant.updated_at = params[4];
        }
        state.participantMutations += 1;
        return { rows: [clone(participant)], rowCount: 1 };
      }

      if (
        sql.includes("FROM conversation_participant_state") &&
        sql.includes("conversation_id = $1") &&
        sql.includes("user_id = $2")
      ) {
        const participant = state.participants[Number(params[1])];
        if (!participant) return { rows: [] };
        if (sql.includes("SELECT last_read_message_id")) {
          return {
            rows: [{
              last_read_message_id: participant.last_read_message_id,
            }],
          };
        }
        return { rows: [clone(participant)] };
      }

      if (sql.includes("INSERT INTO messages")) {
        const nextId = Math.max(...state.messages.map(({ id }) => id)) + 1;
        const message = statefulMessage({
          id: nextId,
          senderId: Number(params[1]),
          receiverId: Number(params[2]),
          text: params[3],
        });
        state.messages.push(message);
        return { rows: [clone(message)], rowCount: 1 };
      }

      if (sql.includes("UPDATE conversations")) {
        return { rows: [], rowCount: 1 };
      }

      if (
        sql.includes("FROM alerts") &&
        sql.includes("LEFT JOIN messages AS source_message")
      ) {
        return {
          rows: state.alerts
            .filter((alert) =>
              alert.source_domain === "communication" &&
              alert.source_event_type === "conversation.message_created" &&
              alert.source_entity_type === "conversation" &&
              alert.source_entity_id === String(params[0]) &&
              alert.recipient_user_id === Number(params[1]) &&
              ["active", "dismissed"].includes(alert.lifecycle_state) &&
              alert.archived_at === null &&
              alert.resolved_at === null
            )
            .map((alert) => {
              const message = state.messages.find(
                ({ id }) => id === Number(alert.source_event_id)
              );
              return {
                id: alert.id,
                source_event_id: alert.source_event_id,
                dedupe_key: alert.dedupe_key,
                safe_payload: clone(alert.safe_payload),
                source_message_id: message?.id ?? null,
                source_conversation_id:
                  message?.conversation_id ?? null,
                source_sender_id: message?.sender_id ?? null,
                source_receiver_id: message?.receiver_id ?? null,
                source_message_type: message?.message_type ?? null,
                source_message_text: message?.message_text ?? null,
              };
            }),
        };
      }

      if (
        sql.includes("FROM alerts") &&
        sql.includes("dedupe_key = $2") &&
        sql.includes("FOR UPDATE")
      ) {
        const rows = conflictRows === null
          ? state.alerts
              .filter((alert) =>
                alert.recipient_user_id === Number(params[0]) &&
                alert.dedupe_key === params[1] &&
                ["active", "dismissed"].includes(alert.lifecycle_state) &&
                alert.archived_at === null &&
                alert.resolved_at === null
              )
              .map(({ id }) => ({ id }))
          : conflictRows;
        return { rows: clone(rows) };
      }

      if (
        sql.includes("FROM alerts") &&
        sql.includes("dedupe_key = $2")
      ) {
        const alert = state.alerts.find((candidate) =>
          candidate.recipient_user_id === Number(params[0]) &&
          candidate.dedupe_key === params[1] &&
          ["active", "dismissed"].includes(candidate.lifecycle_state) &&
          candidate.archived_at === null &&
          candidate.resolved_at === null
        );
        return { rows: alert ? [clone(alert)] : [] };
      }

      if (sql.includes("COUNT(*)::bigint AS unread_count")) {
        const conversation = state.conversation;
        const recipientId = Number(params[1]);
        const senderId = recipientId === conversation.homeowner_id
          ? conversation.professional_user_id
          : conversation.homeowner_id;
        const boundary = params[2] === null ? 0 : Number(params[2]);
        const unreadCount = state.messages.filter((message) =>
          message.conversation_id === Number(params[0]) &&
          message.sender_id === senderId &&
          message.receiver_id === recipientId &&
          message.id > boundary
        ).length;
        return { rows: [{ unread_count: String(unreadCount) }] };
      }

      if (sql.includes("INSERT INTO alerts")) {
        const existing = state.alerts.find((alert) =>
          alert.recipient_user_id === Number(params[0]) &&
          alert.dedupe_key === params[14] &&
          ["active", "dismissed"].includes(alert.lifecycle_state) &&
          alert.archived_at === null &&
          alert.resolved_at === null
        );
        if (existing) return { rows: [], rowCount: 0 };
        const nextId = Math.max(300, ...state.alerts.map(({ id }) => id)) + 1;
        const alert = statefulAlert({
          id: nextId,
          sourceEventId: Number(params[5]),
          dedupeKey: params[14],
          safePayload: JSON.parse(params[11]),
        });
        alert.recipient_user_id = Number(params[0]);
        alert.available_at = params[15];
        alert.created_at = params[15];
        alert.updated_at = params[15];
        state.alerts.push(alert);
        state.alertMutations += 1;
        return { rows: [clone(alert)], rowCount: 1 };
      }

      if (
        sql.includes("UPDATE alerts") &&
        sql.includes("source_event_id = $4")
      ) {
        const alert = state.alerts.find(({ id }) => id === Number(params[0]));
        alert.source_event_id = String(params[3]);
        alert.safe_payload = JSON.parse(params[4]);
        alert.available_at = params[5];
        alert.updated_at = params[5];
        state.alertMutations += 1;
        return {
          rows: [{ id: alert.id, lifecycle_state: alert.lifecycle_state }],
          rowCount: 1,
        };
      }

      if (
        sql.includes("UPDATE alerts") &&
        sql.includes("lifecycle_state = 'resolved'")
      ) {
        const rows = [];
        for (const alertId of params[0]) {
          const alert = state.alerts.find(({ id }) => id === Number(alertId));
          if (!alert) continue;
          alert.lifecycle_state = "resolved";
          alert.resolved_at = "2026-08-03T12:30:00.000Z";
          alert.updated_at = "2026-08-03T12:30:00.000Z";
          state.alertMutations += 1;
          rows.push({ id: alert.id });
        }
        return { rows, rowCount: rows.length };
      }

      if (
        sql.includes("UPDATE alerts") &&
        sql.includes("dedupe_key = $3") &&
        sql.includes("safe_payload = $4::jsonb")
      ) {
        const alert = state.alerts.find(({ id }) => id === Number(params[0]));
        alert.dedupe_key = params[2];
        alert.safe_payload = JSON.parse(params[3]);
        alert.updated_at = "2026-08-03T12:30:00.000Z";
        state.alertMutations += 1;
        return {
          rows: [{
            id: alert.id,
            lifecycle_state: alert.lifecycle_state,
            source_event_id: alert.source_event_id,
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },

    release() {
      releases += 1;
    },
  };

  return {
    calls,
    pool: {
      async query() {
        throw new Error("Pool query must not own the transaction.");
      },
      async connect() {
        return client;
      },
    },
    snapshot() {
      return clone(committed);
    },
    get releases() {
      return releases;
    },
  };
}

test("participant role derives only from canonical conversation truth", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
  };

  assert.equal(
    resolveConversationParticipantRole(conversation, 7),
    "homeowner"
  );
  assert.equal(
    resolveConversationParticipantRole(conversation, "9"),
    "professional"
  );
  assert.equal(
    resolveConversationParticipantRole(conversation, 10),
    null
  );
});

test("participant-state ensure creates both rows from conversation identity and latest canonical message", async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ sql: normalizeSql(text), params });
      return { rows: [], rowCount: 2 };
    },
  };

  await ensureConversationParticipantStatesWithClient({
    client,
    conversationId: 91,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [91]);
  assert.match(
    calls[0].sql,
    /conversations\.homeowner_id, 'homeowner'/
  );
  assert.match(
    calls[0].sql,
    /conversations\.professional_user_id, 'professional'/
  );
  assert.match(
    calls[0].sql,
    /messages\.conversation_id = \$1/
  );
  assert.match(
    calls[0].sql,
    /ON CONFLICT \(conversation_id, user_id\) DO NOTHING/
  );
  assert.doesNotMatch(calls[0].sql, /quote_request_id/);
});

test("participant advance reauthorizes identity and is monotonic", async () => {
  let captured;
  const row = {
    conversation_id: 91,
    user_id: 7,
    participant_role: "homeowner",
    last_read_message_id: 205,
    last_read_at: "2026-08-03T12:00:00.000Z",
  };
  const client = {
    async query(text, params) {
      captured = {
        sql: normalizeSql(text),
        params,
      };
      return { rows: [row], rowCount: 1 };
    },
  };

  const result =
    await advanceConversationParticipantReadStateWithClient({
      client,
      conversation: {
        id: 91,
        homeowner_id: 7,
        professional_user_id: 9,
      },
      participantUserId: 7,
      lastReadMessageId: 205,
      lastReadAt: row.last_read_at,
    });

  assert.deepEqual(result, row);
  assert.deepEqual(captured.params, [
    91,
    7,
    "homeowner",
    205,
    row.last_read_at,
  ]);
  assert.match(
    captured.sql,
    /messages\.id = \$4 AND messages\.conversation_id = \$1/
  );
  assert.match(
    captured.sql,
    /ELSE GREATEST\( participant_state\.last_read_message_id, EXCLUDED\.last_read_message_id \)/
  );
  assert.match(
    captured.sql,
    /ELSE participant_state\.last_read_at/
  );
});

test("outsider identity cannot advance participant state", async () => {
  let queried = false;

  await assert.rejects(
    advanceConversationParticipantReadStateWithClient({
      client: {
        async query() {
          queried = true;
          return { rows: [] };
        },
      },
      conversation: {
        id: 91,
        homeowner_id: 7,
        professional_user_id: 9,
      },
      participantUserId: 10,
      lastReadMessageId: 205,
    }),
    /participant identity/
  );

  assert.equal(queried, false);
});

test("participant mark-read locks and authorizes before advancing to the exact visible message", async () => {
  const fake = createMarkReadPool();
  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 205,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    code: "CONVERSATION_MARKED_READ",
    conversationId: 91,
    acknowledgedMessageId: 205,
    readState: {
      lastReadMessageId: 205,
      lastReadAt: "2026-08-03T12:00:00.000Z",
    },
  });
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.equal(fake.calls.at(-1).sql, "COMMIT");
  assert.equal(fake.releases, 1);

  const locked = fake.calls.find(({ sql }) =>
    sql.includes("FOR UPDATE")
  );
  const acknowledged = fake.calls.find(({ sql }) =>
    sql.includes("messages.id = $1") &&
    sql.includes("messages.conversation_id = $2")
  );
  const advanced = fake.calls.find(({ sql }) =>
    sql.includes(
      "INSERT INTO conversation_participant_state AS participant_state"
    )
  );

  assert.deepEqual(locked.params, [91, 7]);
  assert.match(
    locked.sql,
    /conversations\.homeowner_id = \$2 OR conversations\.professional_user_id = \$2/
  );
  assert.deepEqual(acknowledged.params, [205, 91]);
  assert.doesNotMatch(acknowledged.sql, /ORDER BY messages\.id DESC/);
  assert.deepEqual(advanced.params.slice(0, 4), [
    91,
    7,
    "homeowner",
    205,
  ]);
  assert.ok(fake.calls.indexOf(locked) < fake.calls.indexOf(acknowledged));
  assert.ok(fake.calls.indexOf(acknowledged) < fake.calls.indexOf(advanced));
  const alertLock = fake.calls.find(({ sql }) =>
    sql.includes("LEFT JOIN messages AS source_message") &&
    sql.includes("FOR UPDATE OF alerts")
  );
  assert.deepEqual(alertLock.params, ["91", 7]);
  assert.ok(fake.calls.indexOf(advanced) < fake.calls.indexOf(alertLock));
  assert.ok(
    fake.calls.indexOf(alertLock) <
      fake.calls.findIndex(({ sql }) => sql === "COMMIT")
  );
});

test("acknowledgment identity remains exact when canonical stored state is already farther ahead", async () => {
  const fake = createMarkReadPool({
    readStateRows: [{
      conversation_id: 91,
      user_id: 7,
      participant_role: "homeowner",
      last_read_message_id: 207,
      last_read_at: "2026-08-03T12:02:00.000Z",
    }],
  });

  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 205,
  });

  assert.equal(result.acknowledgedMessageId, 205);
  assert.deepEqual(result.readState, {
    lastReadMessageId: 207,
    lastReadAt: "2026-08-03T12:02:00.000Z",
  });
});

test("send-first ordering preserves and rebases newer Attention before commit", async () => {
  const fake = createMarkReadPool({
    alertRows: [{
      id: 304,
      source_event_id: "206",
      lifecycle_state: "active",
      dedupe_key:
        "communication:conversation:91:recipient:7:after:201",
      source_message_id: 206,
      source_conversation_id: 91,
      source_sender_id: 9,
      source_receiver_id: 7,
      source_message_type: "text",
      source_message_text: "Newer",
      source_message_created_at:
        "2026-08-03T12:01:00.000Z",
    }],
  });

  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 205,
  });

  assert.equal(result.ok, true);
  const rebaseIndex = fake.calls.findIndex(({ sql }) =>
    sql.includes("safe_payload = $4::jsonb")
  );
  const commitIndex = fake.calls.findIndex(({ sql }) => sql === "COMMIT");
  assert.ok(rebaseIndex >= 0);
  assert.ok(rebaseIndex < commitIndex);
  assert.deepEqual(fake.calls[rebaseIndex].params.slice(0, 3), [
    304,
    7,
    "communication:conversation:91:recipient:7:after:205",
  ]);
});

test("attention-window conflict rolls back participant and Alert reconciliation atomically", async () => {
  const fake = createMarkReadPool({
    alertRows: [{
      id: 304,
      source_event_id: "206",
      lifecycle_state: "active",
      dedupe_key:
        "communication:conversation:91:recipient:7:after:201",
      source_message_id: 206,
      source_conversation_id: 91,
      source_sender_id: 9,
      source_receiver_id: 7,
      source_message_type: "text",
      source_message_text: "Newer",
      source_message_created_at:
        "2026-08-03T12:01:00.000Z",
    }],
    dedupeConflictRows: [{ id: 999 }],
  });

  await assert.rejects(
    markConversationRead({
      pool: fake.pool,
      conversationId: 91,
      participantUserId: 7,
      lastReadMessageId: 205,
    }),
    /attention window conflicts/i
  );
  assert.equal(
    fake.calls.some(({ sql }) => sql === "ROLLBACK"),
    true
  );
  assert.equal(
    fake.calls.some(({ sql }) => sql === "COMMIT"),
    false
  );
  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("safe_payload = $4::jsonb")
    ),
    false
  );
});

test("missing or cross-conversation acknowledged message fails closed without mutation", async () => {
  const fake = createMarkReadPool({ latestMessageRows: [] });

  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 205,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    code: "CONVERSATION_MESSAGE_NOT_FOUND",
    message: "The conversation message was not found.",
  });
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("INSERT INTO conversation_participant_state") ||
      sql.includes("FROM alerts")
    ),
    false
  );
});

test("closed conversations can be marked read without lifecycle mutation", async () => {
  const fake = createMarkReadPool({
    conversationRows: [{
      id: 91,
      homeowner_id: 7,
      professional_user_id: 9,
      status: "closed",
    }],
  });

  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 205,
  });

  assert.equal(result.ok, true);
  const sql = fake.calls.map(({ sql: value }) => value).join("\n");
  assert.doesNotMatch(sql, /UPDATE conversations|status = 'active'/i);
});

test("unauthorized and missing conversations share privacy-safe not-found behavior", async () => {
  const fake = createMarkReadPool({ conversationRows: [] });
  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 10,
    lastReadMessageId: 205,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    code: "CONVERSATION_NOT_FOUND",
    message: "The conversation was not found.",
  });
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("INSERT INTO conversation_participant_state")
    ),
    false
  );
});

test("invalid mark-read identities fail before database access", async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rows: [] };
    },
  };

  assert.equal(
    (await markConversationRead({
      pool,
      conversationId: "invalid",
      participantUserId: 7,
      lastReadMessageId: 205,
    })).code,
    "INVALID_CONVERSATION_ID"
  );
  assert.equal(
    (await markConversationRead({
      pool,
      conversationId: 91,
      participantUserId: "invalid",
      lastReadMessageId: 205,
    })).code,
    "INVALID_PARTICIPANT_USER_ID"
  );
  assert.equal(
    (await markConversationRead({
      pool,
      conversationId: 91,
      participantUserId: 7,
      lastReadMessageId: "205",
    })).code,
    "INVALID_LAST_READ_MESSAGE_ID"
  );
  assert.equal(queried, false);
});

test("mark-read rolls back transaction failures and releases the client", async () => {
  const fake = createMarkReadPool({
    failOn: "INSERT INTO conversation_participant_state",
  });

  await assert.rejects(
    markConversationRead({
      pool: fake.pool,
      conversationId: 91,
      participantUserId: 7,
      lastReadMessageId: 205,
    }),
    /private simulated read-state failure/
  );

  assert.equal(
    fake.calls.some(({ sql }) => sql === "ROLLBACK"),
    true
  );
  assert.equal(
    fake.calls.some(({ sql }) => sql === "COMMIT"),
    false
  );
  assert.equal(fake.releases, 1);
});

test("alert resolution failure rolls back the participant read marker", async () => {
  const fake = createMarkReadPool({
    failOn: "LEFT JOIN messages AS source_message",
  });

  await assert.rejects(
    markConversationRead({
      pool: fake.pool,
      conversationId: 91,
      participantUserId: 7,
      lastReadMessageId: 205,
    }),
    /private simulated read-state failure/
  );

  const advanceIndex = fake.calls.findIndex(({ sql }) =>
    sql.includes("INSERT INTO conversation_participant_state AS participant_state")
  );
  const resolveIndex = fake.calls.findIndex(({ sql }) =>
    sql.includes("LEFT JOIN messages AS source_message")
  );
  const rollbackIndex = fake.calls.findIndex(({ sql }) => sql === "ROLLBACK");
  assert.ok(advanceIndex >= 0);
  assert.ok(advanceIndex < resolveIndex);
  assert.ok(resolveIndex < rollbackIndex);
  assert.equal(fake.calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(fake.releases, 1);
});

test("source participant mismatches roll back participant and Alert state", async () => {
  for (const malformedMessage of [
    statefulMessage({ id: 104, senderId: 10, receiverId: 7 }),
    statefulMessage({ id: 104, senderId: 9, receiverId: 8 }),
  ]) {
    const fake = createStatefulConversationPool({
      messages: [
        statefulMessage({ id: 101 }),
        statefulMessage({ id: 103 }),
        malformedMessage,
      ],
      alerts: [statefulAlert({ sourceEventId: 104 })],
    });
    const before = fake.snapshot();

    await assert.rejects(
      markConversationRead({
        pool: fake.pool,
        conversationId: 91,
        participantUserId: 7,
        lastReadMessageId: 103,
      }),
      /alert source is invalid/i
    );

    assert.deepEqual(fake.snapshot(), before);
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
    assert.equal(
      fake.calls.some(({ sql }) => sql === "COMMIT"),
      false
    );
  }
});

test("unread count and rebase failures restore the entire transaction", async () => {
  for (const failOn of [
    "COUNT(*)::bigint AS unread_count",
    "SET dedupe_key = $3",
  ]) {
    const fake = createStatefulConversationPool({
      messages: [
        statefulMessage({ id: 101 }),
        statefulMessage({ id: 103 }),
        statefulMessage({ id: 104 }),
      ],
      alerts: [statefulAlert({ sourceEventId: 104 })],
      failOn,
    });
    const before = fake.snapshot();

    await assert.rejects(
      markConversationRead({
        pool: fake.pool,
        conversationId: 91,
        participantUserId: 7,
        lastReadMessageId: 103,
      }),
      /private simulated transactional failure/
    );

    assert.deepEqual(fake.snapshot(), before);
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  }
});

test("duplicate newer Attention and dedupe conflict roll back stateful writes", async () => {
  const messages = [
    statefulMessage({ id: 101 }),
    statefulMessage({ id: 103 }),
    statefulMessage({ id: 104 }),
    statefulMessage({ id: 105 }),
  ];
  const scenarios = [
    {
      alerts: [
        statefulAlert({ id: 301, sourceEventId: 104 }),
        statefulAlert({ id: 302, sourceEventId: 105 }),
      ],
      expected: /attention window is ambiguous/i,
    },
    {
      alerts: [statefulAlert({ sourceEventId: 104 })],
      conflictRows: [{ id: 999 }],
      expected: /attention window conflicts/i,
    },
  ];

  for (const scenario of scenarios) {
    const fake = createStatefulConversationPool({
      messages,
      alerts: scenario.alerts,
      conflictRows: scenario.conflictRows ?? null,
    });
    const before = fake.snapshot();

    await assert.rejects(
      markConversationRead({
        pool: fake.pool,
        conversationId: 91,
        participantUserId: 7,
        lastReadMessageId: 103,
      }),
      scenario.expected
    );

    assert.deepEqual(fake.snapshot(), before);
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  }
});

test("commit failure leaves no participant or Alert mutation", async () => {
  const fake = createStatefulConversationPool({ failCommit: true });
  const before = fake.snapshot();

  await assert.rejects(
    markConversationRead({
      pool: fake.pool,
      conversationId: 91,
      participantUserId: 7,
      lastReadMessageId: 103,
    }),
    /commit failure/i
  );

  assert.deepEqual(fake.snapshot(), before);
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
});

test("an identical boundary and canonical newer Alert produce no state mutation", async () => {
  const alert = statefulAlert({
    sourceEventId: 104,
    dedupeKey:
      "communication:conversation:91:recipient:7:after:103",
    safePayload: { shortPreview: "Message 104", unreadCount: 1 },
  });
  const fake = createStatefulConversationPool({
    marker: 103,
    messages: [
      statefulMessage({ id: 101 }),
      statefulMessage({ id: 103 }),
      statefulMessage({ id: 104 }),
    ],
    alerts: [alert],
  });
  const before = fake.snapshot();

  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 103,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(fake.snapshot(), before);
  assert.equal(fake.snapshot().participantMutations, 0);
  assert.equal(fake.snapshot().alertMutations, 0);
  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("UPDATE alerts")
    ),
    false
  );
});

test("a changed Attention target updates once and its retry becomes a no-op", async () => {
  const fake = createStatefulConversationPool({
    messages: [
      statefulMessage({ id: 101 }),
      statefulMessage({ id: 103 }),
      statefulMessage({ id: 104 }),
    ],
    alerts: [statefulAlert({ sourceEventId: 104 })],
  });

  await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 103,
  });
  const afterFirst = fake.snapshot();
  assert.equal(afterFirst.participants[7].last_read_message_id, 103);
  assert.equal(afterFirst.participantMutations, 1);
  assert.equal(afterFirst.alertMutations, 1);
  assert.equal(
    afterFirst.alerts[0].dedupe_key,
    "communication:conversation:91:recipient:7:after:103"
  );

  await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 103,
  });

  assert.deepEqual(fake.snapshot(), afterFirst);
});

test("read-first then send creates one exact next Attention window", async () => {
  const fake = createStatefulConversationPool();

  await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 103,
  });
  await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 9,
    payload: { message_text: "Message 104" },
  });

  const state = fake.snapshot();
  const activeAlerts = state.alerts.filter(
    ({ lifecycle_state }) => lifecycle_state === "active"
  );
  assert.equal(state.participants[7].last_read_message_id, 103);
  assert.equal(state.messages.at(-1).id, 104);
  assert.equal(activeAlerts.length, 1);
  assert.equal(activeAlerts[0].source_event_id, "104");
  assert.equal(
    activeAlerts[0].dedupe_key,
    "communication:conversation:91:recipient:7:after:103"
  );
  assert.deepEqual(activeAlerts[0].safe_payload, {
    shortPreview: "Message 104",
    unreadCount: 1,
  });
});

test("send-first then read preserves one newer exact Attention window", async () => {
  const fake = createStatefulConversationPool();

  await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 9,
    payload: { message_text: "Message 104" },
  });
  await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
    lastReadMessageId: 103,
  });

  const state = fake.snapshot();
  const activeAlerts = state.alerts.filter(
    ({ lifecycle_state }) => lifecycle_state === "active"
  );
  assert.equal(state.participants[7].last_read_message_id, 103);
  assert.equal(state.messages.at(-1).id, 104);
  assert.equal(activeAlerts.length, 1);
  assert.equal(activeAlerts[0].source_event_id, "104");
  assert.equal(
    activeAlerts[0].dedupe_key,
    "communication:conversation:91:recipient:7:after:103"
  );
  assert.deepEqual(activeAlerts[0].safe_payload, {
    shortPreview: "Message 104",
    unreadCount: 1,
  });
});

test("message production counts only exact opposite-to-recipient messages", async () => {
  const otherConversationMessage = statefulMessage({
    id: 107,
    senderId: 9,
    receiverId: 7,
  });
  otherConversationMessage.conversation_id = 92;
  const fake = createStatefulConversationPool({
    marker: 103,
    messages: [
      statefulMessage({ id: 100 }),
      statefulMessage({ id: 103 }),
      statefulMessage({ id: 104, senderId: 7, receiverId: 9 }),
      statefulMessage({ id: 105, senderId: 10, receiverId: 7 }),
      statefulMessage({ id: 106, senderId: 9, receiverId: 8 }),
      otherConversationMessage,
    ],
    alerts: [],
  });

  await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 9,
    payload: { message_text: "Exact incoming message" },
  });

  const activeAlerts = fake.snapshot().alerts.filter(
    ({ lifecycle_state }) => lifecycle_state === "active"
  );
  assert.equal(activeAlerts.length, 1);
  assert.deepEqual(activeAlerts[0].safe_payload, {
    shortPreview: "Exact incoming message",
    unreadCount: 1,
  });
  const count = fake.calls.find(({ sql }) =>
    sql.includes("COUNT(*)::bigint AS unread_count")
  );
  assert.match(count.sql, /messages\.receiver_id = \$2/);
  assert.match(count.sql, /messages\.sender_id = CASE/);
  assert.match(count.sql, /messages\.id > COALESCE\(\$3::integer, 0\)/);
});

test("read-state serialization exposes only the viewer projection", () => {
  assert.deepEqual(
    serializeConversationReadState({
      conversation_id: 91,
      user_id: 7,
      participant_role: "homeowner",
      last_read_message_id: "205",
      last_read_at: "2026-08-03T12:00:00.000Z",
    }),
    {
      lastReadMessageId: 205,
      lastReadAt: "2026-08-03T12:00:00.000Z",
    }
  );
});

test("message creation and mark-read share the same conversation lock authority", () => {
  const serviceSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "conversations",
      "conversationParticipantStateService.js"
    ),
    "utf8"
  );
  const messageSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "conversations",
      "conversationMessageService.js"
    ),
    "utf8"
  );

  for (const source of [serviceSource, messageSource]) {
    assert.match(
      source,
      /WHERE conversations\.id = \$1[\s\S]*?conversations\.homeowner_id = \$2[\s\S]*?conversations\.professional_user_id = \$2[\s\S]*?FOR UPDATE/
    );
  }
});

test("canonical summary path no longer hard-codes unread or preview placeholders", () => {
  const serializerSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "conversations",
      "conversations.js"
    ),
    "utf8"
  );
  const serviceSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "conversations",
      "conversationService.js"
    ),
    "utf8"
  );

  assert.doesNotMatch(
    serializerSource,
    /last_message_preview:\s*null/
  );
  assert.doesNotMatch(
    serializerSource,
    /unread_count:\s*0/
  );
  assert.match(
    serviceSource,
    /LEFT JOIN LATERAL[\s\S]*?last_message_preview/
  );
  assert.match(
    serviceSource,
    /COUNT\(\*\)::integer AS unread_count/
  );
});

test("004A storage and summary remain separate from alert and delivery authority", () => {
  const sourcePaths = [
    "server/conversations/conversationService.js",
    "migrations/202608030001_create_conversation_participant_state.sql",
  ];
  const sources = sourcePaths.map((relativePath) =>
    fs.readFileSync(
      path.join(__dirname, "..", relativePath),
      "utf8"
    )
  );

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /\b(?:alerts?|notifications?|createNotification|localStorage|sessionStorage|push_token|APNs|FCM|SMS)\b/i
    );
  }

  const participantSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server/conversations/conversationParticipantStateService.js"
    ),
    "utf8"
  );
  assert.match(
    participantSource,
    /resolveCommunicationMessageAlerts/
  );
  assert.doesNotMatch(
    participantSource,
    /localStorage|sessionStorage|push_token|APNs|FCM|SMS/i
  );
});
