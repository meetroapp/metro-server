"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET =
  "explicit-test-jwt-secret-conversation-read-routes";

const {
  app,
  createToken,
} = require("../index");

const routePath = "/conversations/:conversationId/read";

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function getHandlers() {
  const layer = app.router.stack.find(
    (item) =>
      item.route?.path === routePath &&
      item.route.methods.post
  );

  assert.ok(layer, `Route not found: POST ${routePath}`);
  return layer.route.stack.map((item) => item.handle);
}

function response() {
  const headers = new Map();

  return {
    statusCode: 200,
    body: null,
    finished: false,

    status(value) {
      this.statusCode = value;
      return this;
    },

    json(value) {
      this.body = value;
      this.finished = true;
      return this;
    },

    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },

    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
  };
}

function createPool({
  conversationRows,
  latestMessageRows,
  failOn,
} = {}) {
  const calls = [];
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

  const query = async (text, values = []) => {
    const sql = normalizeSql(text);
    calls.push({ sql, values });

    if (failOn && sql.includes(failOn)) {
      throw new Error("private route database failure");
    }

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      return { rows: [] };
    }

    if (
      sql.includes("SELECT id, email, role, token_version") &&
      sql.includes("FROM users")
    ) {
      return {
        rows: [{
          id: values[0],
          email: `user${values[0]}@example.test`,
          role: "user",
          token_version: 0,
        }],
      };
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
        rows: [{
          conversation_id: values[0],
          user_id: values[1],
          participant_role: values[2],
          last_read_message_id: values[3],
          last_read_at:
            values[4] ||
            "2026-08-03T12:01:00.000Z",
        }],
        rowCount: 1,
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  };

  return {
    calls,
    pool: {
      query,
      async connect() {
        return {
          query,
          release() {},
        };
      },
    },
  };
}

async function invoke({
  userId = 7,
  conversationId = "91",
  authenticated = true,
  pool,
} = {}) {
  app.locals.pool = pool;
  const req = {
    app,
    params: { conversationId },
    headers: authenticated
      ? {
          authorization: `Bearer ${createToken({
            id: userId,
            email: `user${userId}@example.test`,
            role: "user",
            token_version: 0,
          })}`,
        }
      : {},
  };
  const res = response();

  try {
    for (const handler of getHandlers()) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise((resolve, reject) => {
        const next = (error) =>
          error ? reject(error) : resolve();
        Promise.resolve(handler(req, res, next)).then(
          () => {
            if (res.finished) resolve();
          },
          reject
        );
      });
    }

    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("canonical participant marks the conversation read with a no-store response", async () => {
  const fake = createPool();
  const result = await invoke({ pool: fake.pool });

  assert.equal(result.statusCode, 200);
  assert.equal(result.getHeader("Cache-Control"), "no-store");
  assert.deepEqual(result.body, {
    success: true,
    code: "CONVERSATION_MARKED_READ",
    conversationId: 91,
    readState: {
      lastReadMessageId: 205,
      lastReadAt: "2026-08-03T12:00:00.000Z",
    },
  });
});
test("mark-read route requires authentication before conversation access", async () => {
  const fake = createPool();
  const result = await invoke({
    authenticated: false,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "AUTHENTICATION_REQUIRED");
  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("FROM conversations")
    ),
    false
  );
});

test("malformed conversation identity is rejected without read-state mutation", async () => {
  const fake = createPool();
  const result = await invoke({
    conversationId: "invalid",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "INVALID_CONVERSATION_ID");
  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes("conversation_participant_state")
    ),
    false
  );
});

test("outsider receives the privacy-safe conversation not-found contract", async () => {
  const fake = createPool({ conversationRows: [] });
  const result = await invoke({
    userId: 10,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, {
    success: false,
    code: "CONVERSATION_NOT_FOUND",
    message: "The conversation was not found.",
  });
});

test("repeated route calls remain successful and do not mutate messages or workflow", async () => {
  const fake = createPool();

  assert.equal((await invoke({ pool: fake.pool })).statusCode, 200);
  assert.equal((await invoke({ pool: fake.pool })).statusCode, 200);

  const sql = fake.calls.map(({ sql: value }) => value).join("\n");
  assert.doesNotMatch(sql, /UPDATE messages|DELETE FROM messages/i);
  assert.doesNotMatch(
    sql,
    /workflow_events|request_relationships|emergency_requests/i
  );
  assert.doesNotMatch(sql, /alerts?|notifications?/i);
});

test("mark-read database errors use the normalized public contract", async () => {
  const fake = createPool({
    failOn: "INSERT INTO conversation_participant_state",
  });
  const result = await invoke({ pool: fake.pool });

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, {
    error: "CONVERSATION_MARK_READ_FAILED",
    message:
      "The conversation read state could not be updated.",
  });
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /private route database failure/
  );
});
