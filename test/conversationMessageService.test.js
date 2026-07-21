"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_TEXT_LENGTH,
  createConversationMessage,
  decodeMessageCursor,
  encodeMessageCursor,
  listConversationMessages,
  parseMessagePageSize,
  validateConversationMessageInput,
} = require("../server/conversations/conversationMessageService");

function normalizeSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim();
}

function createPool(rows = []) {
  const calls = [];

  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({
          sql: normalizeSql(sql),
          params,
        });

        return { rows };
      },
    },
  };
}

function createWritePool({
  conversationRows,
  failOn,
  activityRowCount = 1,
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

  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });

      if (failOn && sql.includes(failOn)) {
        throw new Error("private simulated database failure");
      }

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }

      if (sql.includes("FROM conversations") && sql.includes("FOR UPDATE")) {
        return {
          rows: conversationRows === undefined
            ? defaultConversationRows
            : conversationRows,
        };
      }

      if (sql.includes("INSERT INTO messages")) {
        return {
          rows: [{
            id: 201,
            sender_id: params[1],
            receiver_id: params[2],
            message_text: params[3],
            image_url: null,
            message_type: "text",
            workflow_type: null,
            workflow_status: null,
            workflow_payload: {},
            created_at: "2026-07-21T12:00:00.000Z",
          }],
        };
      }

      if (sql.includes("UPDATE conversations")) {
        return { rows: [], rowCount: activityRowCount };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },

    release() {
      releases += 1;
    },
  };

  const pool = direct
    ? client
    : {
        async query() {
          throw new Error("Pool query should not own the transaction.");
        },
        async connect() {
          return client;
        },
      };

  return {
    calls,
    pool,
    get releases() {
      return releases;
    },
  };
}

test("canonical message input accepts only trimmed bounded text", () => {
  assert.deepEqual(
    validateConversationMessageInput({
      message_text: "  Hello\nthere  ",
    }),
    {
      valid: true,
      value: {
        messageText: "Hello\nthere",
      },
    }
  );

  for (const payload of [null, [], {}, { message_text: 1 }, { message_text: "   " }]) {
    assert.equal(
      validateConversationMessageInput(payload).code,
      "MESSAGE_TEXT_REQUIRED"
    );
  }

  assert.equal(
    validateConversationMessageInput({
      message_text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
    }).code,
    "MESSAGE_TEXT_TOO_LONG"
  );
});

test("canonical message input rejects every client-controlled authority field", () => {
  for (const field of [
    "sender_id",
    "receiver_id",
    "conversation_id",
    "quote_request_id",
    "homeowner_id",
    "contractor_id",
    "professional_user_id",
    "image_url",
    "image_urls",
    "message_type",
    "workflow_type",
    "workflow_status",
    "workflow_payload",
  ]) {
    assert.equal(
      validateConversationMessageInput({
        message_text: "Hello",
        [field]: "client-controlled",
      }).code,
      "UNSUPPORTED_MESSAGE_FIELDS"
    );
  }
});

test("homeowner canonical send locks, inserts fixed identity, updates activity, and commits", async () => {
  const fake = createWritePool();

  const result = await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 7,
    payload: { message_text: "  Hello\nprofessional  " },
  });

  assert.equal(result.code, "CONVERSATION_MESSAGE_CREATED");
  assert.equal(result.status, 201);
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.equal(fake.calls.at(-1).sql, "COMMIT");
  assert.equal(fake.releases, 1);

  const locked = fake.calls.find(({ sql }) => sql.includes("FOR UPDATE"));
  assert.deepEqual(locked.params, [91, 7]);
  assert.match(locked.sql, /conversations\.homeowner_id = \$2 OR conversations\.professional_user_id = \$2/);

  const inserted = fake.calls.find(({ sql }) => sql.includes("INSERT INTO messages"));
  assert.deepEqual(inserted.params, [91, 7, 9, "Hello\nprofessional"]);
  assert.match(inserted.sql, /quote_request_id, conversation_id, sender_id, receiver_id/);
  assert.match(inserted.sql, /VALUES \( NULL, \$1, \$2, \$3, \$4, NULL, 'text', NULL, NULL, '\{\}'::jsonb \)/);

  const activity = fake.calls.find(({ sql }) => sql.includes("UPDATE conversations"));
  assert.deepEqual(activity.params, [91, "2026-07-21T12:00:00.000Z"]);
});

test("professional canonical send resolves the homeowner server-side", async () => {
  const fake = createWritePool();

  await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 9,
    payload: { message_text: "Hello homeowner" },
  });

  const inserted = fake.calls.find(({ sql }) => sql.includes("INSERT INTO messages"));
  assert.deepEqual(inserted.params, [91, 9, 7, "Hello homeowner"]);
});

test("validation and invalid identity failures occur before database access", async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rows: [] };
    },
  };

  assert.equal((await createConversationMessage({
    pool,
    conversationId: "invalid",
    senderUserId: 7,
    payload: { message_text: "Hello" },
  })).code, "INVALID_CONVERSATION_ID");

  assert.equal((await createConversationMessage({
    pool,
    conversationId: 91,
    senderUserId: 7,
    payload: { message_text: "Hello", receiver_id: 9 },
  })).code, "UNSUPPORTED_MESSAGE_FIELDS");

  assert.equal(queried, false);
});

test("non-participant and closed conversation failures roll back without insertion", async () => {
  for (const scenario of [
    { conversationRows: [], code: "CONVERSATION_NOT_FOUND" },
    {
      conversationRows: [{
        id: 91,
        homeowner_id: 7,
        professional_user_id: 9,
        status: "closed",
      }],
      code: "CONVERSATION_CLOSED",
    },
  ]) {
    const fake = createWritePool(scenario);
    const result = await createConversationMessage({
      pool: fake.pool,
      conversationId: 91,
      senderUserId: 7,
      payload: { message_text: "Hello" },
    });

    assert.equal(result.code, scenario.code);
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
    assert.equal(fake.calls.some(({ sql }) => sql.includes("INSERT INTO messages")), false);
    assert.equal(fake.calls.some(({ sql }) => sql.includes("UPDATE conversations")), false);
  }
});

test("insert and activity failures roll back and release without commit", async () => {
  for (const failOn of ["INSERT INTO messages", "UPDATE conversations"]) {
    const fake = createWritePool({ failOn });

    await assert.rejects(
      createConversationMessage({
        pool: fake.pool,
        conversationId: 91,
        senderUserId: 7,
        payload: { message_text: "Hello" },
      }),
      /private simulated database failure/
    );

    assert.equal(fake.calls.some(({ sql }) => sql === "ROLLBACK"), true);
    assert.equal(fake.calls.some(({ sql }) => sql === "COMMIT"), false);
    assert.equal(fake.releases, 1);
  }
});

test("canonical sending supports a direct database client", async () => {
  const fake = createWritePool({ direct: true });

  const result = await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 7,
    payload: { message_text: "Hello" },
  });

  assert.equal(result.ok, true);
  assert.equal(fake.releases, 0);
});

test("canonical sending rejects an invalid database dependency", async () => {
  await assert.rejects(
    createConversationMessage({
      pool: null,
      conversationId: 91,
      senderUserId: 7,
      payload: { message_text: "Hello" },
    }),
    /database pool or client/
  );
});

test("message page size is bounded and defaults safely", () => {
  assert.equal(
    parseMessagePageSize(undefined),
    DEFAULT_MESSAGE_PAGE_SIZE
  );

  assert.equal(
    parseMessagePageSize("100"),
    MAX_MESSAGE_PAGE_SIZE
  );

  for (const invalid of [
    "0",
    "-1",
    "1.5",
    "101",
    "invalid",
  ]) {
    assert.equal(
      parseMessagePageSize(invalid),
      null
    );
  }
});

test("message cursors round trip deterministic identity", () => {
  const encoded = encodeMessageCursor({
    id: 44,
    created_at:
      "2026-07-21T12:30:00.000Z",
  });

  assert.deepEqual(
    decodeMessageCursor(encoded),
    {
      valid: true,
      cursor: {
        id: 44,
        createdAt:
          "2026-07-21T12:30:00.000Z",
      },
    }
  );
});

test("invalid message cursors fail closed", () => {
  for (const invalid of [
    "not-a-cursor",
    Buffer.from(
      JSON.stringify({ id: 0 }),
      "utf8"
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        id: 1,
        createdAt: "invalid",
      }),
      "utf8"
    ).toString("base64url"),
  ]) {
    assert.deepEqual(
      decodeMessageCursor(invalid),
      {
        valid: false,
        cursor: null,
      }
    );
  }
});

test("conversation messages query only canonical conversation identity", async () => {
  const rows = [{
    id: 101,
    sender_id: 7,
    receiver_id: 9,
    message_text: "Canonical hello",
    image_url: null,
    message_type: "text",
    workflow_type: null,
    workflow_status: null,
    workflow_payload: {},
    created_at:
      "2026-07-21T12:00:00.000Z",
  }];

  const fake = createPool(rows);

  const result =
    await listConversationMessages({
      pool: fake.pool,
      conversationId: 91,
      limit: 25,
    });

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, rows);
  assert.deepEqual(result.pagination, {
    limit: 25,
    hasMore: false,
    nextCursor: null,
  });

  const query = fake.calls[0];

  assert.match(
    query.sql,
    /WHERE messages\.conversation_id = \$1/
  );

  assert.doesNotMatch(
    query.sql,
    /quote_request_id/
  );

  assert.match(
    query.sql,
    /ORDER BY messages\.created_at ASC NULLS LAST, messages\.id ASC/
  );

  assert.deepEqual(
    query.params,
    [91, false, null, 0, 26]
  );
});

test("conversation messages return bounded forward pagination", async () => {
  const rows = [
    {
      id: 101,
      created_at:
        "2026-07-21T12:00:00.000Z",
    },
    {
      id: 102,
      created_at:
        "2026-07-21T12:00:00.000Z",
    },
    {
      id: 103,
      created_at:
        "2026-07-21T12:01:00.000Z",
    },
  ];

  const fake = createPool(rows);

  const result =
    await listConversationMessages({
      pool: fake.pool,
      conversationId: 91,
      limit: 2,
    });

  assert.deepEqual(
    result.messages.map(({ id }) => id),
    [101, 102]
  );

  assert.equal(
    result.pagination.hasMore,
    true
  );

  assert.deepEqual(
    decodeMessageCursor(
      result.pagination.nextCursor
    ),
    {
      valid: true,
      cursor: {
        id: 102,
        createdAt:
          "2026-07-21T12:00:00.000Z",
      },
    }
  );
});

test("forward cursor uses created time and message id", async () => {
  const cursor = encodeMessageCursor({
    id: 102,
    created_at:
      "2026-07-21T12:00:00.000Z",
  });

  const fake = createPool([]);

  await listConversationMessages({
    pool: fake.pool,
    conversationId: 91,
    limit: 10,
    cursor,
  });

  assert.deepEqual(
    fake.calls[0].params,
    [
      91,
      true,
      "2026-07-21T12:00:00.000Z",
      102,
      11,
    ]
  );
});

test("invalid inputs fail before database access", async () => {
  let queried = false;

  const pool = {
    async query() {
      queried = true;
      return { rows: [] };
    },
  };

  assert.equal(
    (
      await listConversationMessages({
        pool,
        conversationId: "invalid",
      })
    ).code,
    "INVALID_CONVERSATION_ID"
  );

  assert.equal(
    (
      await listConversationMessages({
        pool,
        conversationId: 91,
        limit: 101,
      })
    ).code,
    "INVALID_MESSAGE_PAGE_SIZE"
  );

  assert.equal(
    (
      await listConversationMessages({
        pool,
        conversationId: 91,
        cursor: "invalid",
      })
    ).code,
    "INVALID_MESSAGE_CURSOR"
  );

  assert.equal(queried, false);
});

test("message service validates the database dependency", async () => {
  await assert.rejects(
    listConversationMessages({
      pool: null,
      conversationId: 91,
    }),
    /database pool or client/
  );
});


test("non-null cursors retain null-timestamp messages at the ordered tail", async () => {
  const cursor = encodeMessageCursor({
    id: 102,
    created_at:
      "2026-07-21T12:00:00.000Z",
  });

  const fake = createPool([]);

  await listConversationMessages({
    pool: fake.pool,
    conversationId: 91,
    limit: 10,
    cursor,
  });

  const query = fake.calls[0];

  assert.match(
    query.sql,
    /messages\.created_at IS NULL OR \( messages\.created_at IS NOT NULL/
  );

  assert.match(
    query.sql,
    /ORDER BY messages\.created_at ASC NULLS LAST, messages\.id ASC/
  );
});
