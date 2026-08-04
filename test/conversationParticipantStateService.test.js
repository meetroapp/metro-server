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

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createMarkReadPool({
  conversationRows,
  latestMessageRows,
  readStateRows,
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
        sql.includes("ORDER BY messages.id DESC") &&
        !sql.includes("INSERT INTO")
      ) {
        return {
          rows:
            latestMessageRows === undefined
              ? defaultLatestMessageRows
              : latestMessageRows,
        };
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

test("participant mark-read locks and authorizes before advancing to the current maximum message", async () => {
  const fake = createMarkReadPool();
  const result = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    code: "CONVERSATION_MARKED_READ",
    conversationId: 91,
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
  const latest = fake.calls.find(({ sql }) =>
    sql.includes("ORDER BY messages.id DESC")
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
  assert.deepEqual(latest.params, [91]);
  assert.deepEqual(advanced.params.slice(0, 4), [
    91,
    7,
    "homeowner",
    205,
  ]);
  assert.ok(fake.calls.indexOf(locked) < fake.calls.indexOf(latest));
  assert.ok(fake.calls.indexOf(latest) < fake.calls.indexOf(advanced));
});

test("mark-read remains successful and idempotent with no canonical messages", async () => {
  const fake = createMarkReadPool({ latestMessageRows: [] });

  const first = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
  });
  const second = await markConversationRead({
    pool: fake.pool,
    conversationId: 91,
    participantUserId: 7,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.readState.lastReadMessageId, null);
  assert.equal(second.readState.lastReadMessageId, null);

  const advances = fake.calls.filter(({ sql }) =>
    sql.includes(
      "INSERT INTO conversation_participant_state AS participant_state"
    )
  );
  assert.deepEqual(
    advances.map(({ params }) => params[3]),
    [null, null]
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
    })).code,
    "INVALID_CONVERSATION_ID"
  );
  assert.equal(
    (await markConversationRead({
      pool,
      conversationId: 91,
      participantUserId: "invalid",
    })).code,
    "INVALID_PARTICIPANT_USER_ID"
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

test("004A participant state contains no alert or delivery implementation", () => {
  const sourcePaths = [
    "server/conversations/conversationParticipantStateService.js",
    "server/conversations/conversationMessageService.js",
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
});
