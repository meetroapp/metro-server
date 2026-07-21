"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  decodeMessageCursor,
  encodeMessageCursor,
  listConversationMessages,
  parseMessagePageSize,
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
