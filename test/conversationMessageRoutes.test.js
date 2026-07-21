"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET =
  "explicit-test-jwt-secret-conversation-message-routes";

const {
  app,
  createToken,
} = require("../index");

function normalizeSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim();
}

function getHandlers(method, path) {
  const layer = app.router.stack.find(
    (item) =>
      item.route?.path === path &&
      item.route.methods[method]
  );

  assert.ok(
    layer,
    `Route not found: ${method.toUpperCase()} ${path}`
  );

  return layer.route.stack.map(
    (item) => item.handle
  );
}

function response() {
  return {
    statusCode: 200,
    body: null,
    finished: false,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(body) {
      this.body = body;
      this.finished = true;
      return this;
    },

    setHeader() {},

    getHeader() {
      return undefined;
    },
  };
}

function createPool({
  conversationRows,
  messageRows,
  failOn,
} = {}) {
  const calls = [];

  const defaultConversationRows = [{
    id: 91,
    relationship_id: 51,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
  }];

  const defaultMessageRows = [{
    id: 201,
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

  return {
    calls,
    pool: {
      async query(text, values = []) {
        const sql = normalizeSql(text);
        calls.push({ sql, values });

        if (failOn && sql.includes(failOn)) {
          throw new Error(
            "private simulated database failure"
          );
        }

        if (
          sql.includes(
            "SELECT id, email, role, token_version"
          ) &&
          sql.includes("FROM users")
        ) {
          return {
            rows: [{
              id: values[0],
              email:
                `user${values[0]}@example.test`,
              role: "user",
              token_version: 0,
            }],
          };
        }

        if (
          sql.includes("FROM conversations") &&
          sql.includes(
            "WHERE conversations.id = $1"
          )
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
          sql.includes(
            "messages.conversation_id = $1"
          )
        ) {
          return {
            rows:
              messageRows === undefined
                ? defaultMessageRows
                : messageRows,
          };
        }

        throw new Error(
          `Unexpected SQL: ${sql}`
        );
      },
    },
  };
}

async function invoke({
  userId = 7,
  conversationId = "91",
  query = {},
  pool,
  authenticated = true,
} = {}) {
  app.locals.pool = pool;

  const req = {
    app,
    params: {
      conversationId,
    },
    query,
    headers: authenticated
      ? {
          authorization:
            `Bearer ${createToken({
              id: userId,
              email:
                `user${userId}@example.test`,
              role: "user",
              token_version: 0,
            })}`,
        }
      : {},
  };

  const res = response();

  try {
    for (
      const handler of getHandlers(
        "get",
        "/conversations/:conversationId/messages"
      )
    ) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise(
        (resolve, reject) => {
          const next = (error) =>
            error
              ? reject(error)
              : resolve();

          Promise.resolve(
            handler(req, res, next)
          ).then(
            () => {
              if (res.finished) resolve();
            },
            reject
          );
        }
      );
    }

    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("participant receives privacy-safe canonical messages", async () => {
  const fake = createPool();

  const result = await invoke({
    userId: 7,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    conversationId: 91,
    messages: [{
      id: 201,
      sender: {
        id: 7,
        isViewer: true,
      },
      recipient: {
        id: 9,
      },
      content: {
        text: "Canonical hello",
        imageUrl: null,
        type: "text",
      },
      workflow: {
        type: null,
        status: null,
        payload: {},
      },
      createdAt:
        "2026-07-21T12:00:00.000Z",
    }],
    pagination: {
      limit: 50,
      hasMore: false,
      nextCursor: null,
    },
  });

  const messageQuery =
    fake.calls.find(({ sql }) =>
      sql.includes("FROM messages")
    );

  assert.ok(messageQuery);
  assert.match(
    messageQuery.sql,
    /messages\.conversation_id = \$1/
  );
  assert.doesNotMatch(
    messageQuery.sql,
    /quote_request_id/
  );
});

test("professional participant can read the canonical thread", async () => {
  const fake = createPool();

  const result = await invoke({
    userId: 9,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.equal(
    result.body.messages[0].sender.isViewer,
    false
  );

  const conversationQuery =
    fake.calls.find(({ sql }) =>
      sql.includes(
        "WHERE conversations.id = $1"
      )
    );

  assert.deepEqual(
    conversationQuery.values,
    [91, 9]
  );
});

test("canonical endpoint returns an authoritative empty list", async () => {
  const fake = createPool({
    messageRows: [],
  });

  const result = await invoke({
    userId: 7,
    pool: fake.pool,
  });

  assert.deepEqual(result.body, {
    success: true,
    conversationId: 91,
    messages: [],
    pagination: {
      limit: 50,
      hasMore: false,
      nextCursor: null,
    },
  });
});

test("non-participant cannot query canonical messages", async () => {
  const fake = createPool({
    conversationRows: [],
  });

  const result = await invoke({
    userId: 10,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 404);

  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("FROM messages")
    ),
    false
  );
});

test("invalid conversation identifiers fail before message access", async () => {
  const fake = createPool();

  const result = await invoke({
    conversationId: "invalid",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 400);
  assert.equal(
    result.body.code,
    "INVALID_CONVERSATION_ID"
  );

  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("FROM messages")
    ),
    false
  );
});

test("invalid pagination inputs return validation errors", async () => {
  const fake = createPool();

  const invalidLimit = await invoke({
    query: { limit: "101" },
    pool: fake.pool,
  });

  assert.equal(
    invalidLimit.body.code,
    "INVALID_MESSAGE_PAGE_SIZE"
  );

  const invalidCursor = await invoke({
    query: { cursor: "invalid" },
    pool: fake.pool,
  });

  assert.equal(
    invalidCursor.body.code,
    "INVALID_MESSAGE_CURSOR"
  );
});

test("canonical endpoint requires authentication", async () => {
  let queried = false;

  const result = await invoke({
    authenticated: false,
    pool: {
      async query() {
        queried = true;
        return { rows: [] };
      },
    },
  });

  assert.equal(result.statusCode, 401);
  assert.equal(queried, false);
});

test("database failures use the safe public contract", async () => {
  const fake = createPool({
    failOn: "FROM messages",
  });

  const result = await invoke({
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 500);

  assert.deepEqual(result.body, {
    error:
      "CONVERSATION_MESSAGES_FETCH_FAILED",
    message:
      "Conversation messages could not be loaded.",
  });
});

test("legacy message retrieval route remains registered", () => {
  assert.doesNotThrow(() =>
    getHandlers(
      "get",
      "/messages/:quoteRequestId"
    )
  );

  assert.doesNotThrow(() =>
    getHandlers(
      "get",
      "/conversations/:conversationId/messages"
    )
  );
});
