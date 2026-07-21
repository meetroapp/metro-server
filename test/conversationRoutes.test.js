"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET =
  "explicit-test-jwt-secret-conversation-routes";

const {
  app,
  createToken,
} = require("../index");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
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

  return layer.route.stack.map((item) => item.handle);
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
  };
}

async function invokeConversationInbox({
  userId = 7,
  perspective = "homeowner",
  includeArchived,
  pool,
  authenticated = true,
} = {}) {
  const user = {
    id: userId,
    email: `user${userId}@example.test`,
    role: "user",
    token_version: 0,
  };

  app.locals.pool = pool;

  const req = {
    app,
    query: {
      perspective,
      ...(includeArchived === undefined
        ? {}
        : { includeArchived: String(includeArchived) }),
    },
    headers: authenticated
      ? {
          authorization: `Bearer ${createToken(user)}`,
        }
      : {},
  };

  const res = response();

  try {
    for (const handler of getHandlers("get", "/conversations")) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise((resolve, reject) => {
        const next = (error) =>
          error ? reject(error) : resolve();

        Promise.resolve(
          handler(req, res, next)
        ).then(
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

function createConversationRoutePool({
  homeownerRows = [{
    id: 91,
    relationship_id: 51,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: null,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-22T14:00:00.000Z",
    closed_at: null,
    business_name: "Trusted Repairs",
    business_image_url: "https://example.test/logo.jpg",
    professional_category: "handyman",
    request_title: "Drywall Repair",
  }],
  professionalRows = [{
    id: 91,
    relationship_id: 51,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: null,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-22T14:00:00.000Z",
    closed_at: null,
    post_id: 41,
    request_title: "Drywall Repair",
    homeowner_display_name: "William Molina",
  }],
  profileRows = [{ id: 80 }],
  failOn,
} = {}) {
  const calls = [];

  return {
    calls,

    pool: {
      async query(text, values = []) {
        const sql = normalizeSql(text);
        calls.push({ sql, values });

        if (failOn && sql.includes(failOn)) {
          throw new Error("simulated conversation route failure");
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
          sql.includes("SELECT id") &&
          sql.includes("FROM contractor_profiles") &&
          sql.includes("WHERE user_id = $1")
        ) {
          return { rows: profileRows };
        }

        if (
          sql.includes("FROM conversations") &&
          sql.includes(
            "WHERE conversations.homeowner_id = $1"
          )
        ) {
          return { rows: homeownerRows };
        }

        if (
          sql.includes("FROM conversations") &&
          sql.includes(
            "WHERE conversations.professional_user_id = $1"
          )
        ) {
          return { rows: professionalRows };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
  };
}

test("homeowner conversation inbox returns privacy-safe summaries", async () => {
  const fake = createConversationRoutePool();

  const result = await invokeConversationInbox({
    userId: 7,
    perspective: "homeowner",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    perspective: "homeowner",
    conversations: [{
      id: 91,
      relationship: {
        id: 51,
        title: "Drywall Repair",
        stage: "conversation",
      },
      display: {
        name: "Trusted Repairs",
        image_url: "https://example.test/logo.jpg",
        category: "handyman",
      },
      status: {
        value: "active",
        active: true,
        archived: false,
        requires_attention: false,
      },
      last_activity: "2026-07-22T14:00:00.000Z",
      last_message_preview: null,
      unread_count: 0,
      conversation_available: true,
    }],
  });

  const summary = result.body.conversations[0];

  for (const privateField of [
    "homeowner_id",
    "professional_user_id",
    "contractor_id",
    "homeowner_archived_at",
    "professional_archived_at",
  ]) {
    assert.equal(Object.hasOwn(summary, privateField), false);
  }

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes(
        "WHERE conversations.homeowner_id = $1"
      )
    ),
    true
  );
});

test("professional conversation inbox returns the same summary contract", async () => {
  const fake = createConversationRoutePool();

  const result = await invokeConversationInbox({
    userId: 9,
    perspective: "professional",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    perspective: "professional",
    conversations: [{
      id: 91,
      relationship: {
        id: 51,
        title: "Drywall Repair",
        stage: "conversation",
      },
      display: {
        name: "William Molina",
        image_url: "",
        category: "",
      },
      status: {
        value: "active",
        active: true,
        archived: false,
        requires_attention: false,
      },
      last_activity: "2026-07-22T14:00:00.000Z",
      last_message_preview: null,
      unread_count: 0,
      conversation_available: true,
    }],
  });

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("FROM contractor_profiles") &&
      call.sql.includes("WHERE user_id = $1")
    ),
    true
  );

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes(
        "WHERE conversations.professional_user_id = $1"
      )
    ),
    true
  );
});

test("conversation inbox returns an authoritative empty list", async () => {
  const fake = createConversationRoutePool({
    homeownerRows: [],
  });

  const result = await invokeConversationInbox({
    userId: 7,
    perspective: "homeowner",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    perspective: "homeowner",
    conversations: [],
  });
});

test("archived filtering is participant specific", async () => {
  const fake = createConversationRoutePool({
    homeownerRows: [],
  });

  const result = await invokeConversationInbox({
    userId: 7,
    perspective: "homeowner",
    includeArchived: true,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  const listCall = fake.calls.find((call) =>
    call.sql.includes(
      "WHERE conversations.homeowner_id = $1"
    )
  );

  assert.ok(listCall);
  assert.deepEqual(listCall.values, [7, true]);
});

test("professional perspective requires an owned business profile", async () => {
  const fake = createConversationRoutePool({
    profileRows: [],
  });

  const result = await invokeConversationInbox({
    userId: 9,
    perspective: "professional",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 403);

  assert.deepEqual(result.body, {
    success: false,
    code: "PROFESSIONAL_PROFILE_REQUIRED",
    message:
      "A business profile is required to view professional conversations.",
  });

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes(
        "WHERE conversations.professional_user_id = $1"
      )
    ),
    false
  );
});

test("conversation inbox requires an explicit supported perspective", async () => {
  const fake = createConversationRoutePool();

  for (const perspective of [
    "",
    "business",
    "admin",
    "unknown",
  ]) {
    const result = await invokeConversationInbox({
      userId: 7,
      perspective,
      pool: fake.pool,
    });

    assert.equal(result.statusCode, 400);
    assert.equal(
      result.body.code,
      "CONVERSATION_PERSPECTIVE_REQUIRED"
    );
  }
});

test("conversation inbox remains authentication protected", async () => {
  const fake = createConversationRoutePool();

  const result = await invokeConversationInbox({
    perspective: "homeowner",
    pool: fake.pool,
    authenticated: false,
  });

  assert.equal(result.statusCode, 401);

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("FROM conversations")
    ),
    false
  );
});

test("conversation inbox database failures use the safe public contract", async () => {
  const fake = createConversationRoutePool({
    failOn: "FROM conversations",
  });

  const result = await invokeConversationInbox({
    userId: 7,
    perspective: "homeowner",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 500);

  assert.deepEqual(result.body, {
    error: "CONVERSATIONS_FETCH_FAILED",
    message: "Conversations could not be loaded.",
  });
});
