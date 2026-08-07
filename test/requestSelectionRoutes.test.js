"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-request-selection-routes";

const { app, createToken } = require("../index");
const {
  createRequestSelectionFake,
} = require("./helpers/requestSelectionFake");

function getHandlers(method, path) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
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

async function invoke({
  method = "post",
  userId = 7,
  postId = "41",
  responseId = "901",
  body = {},
  idempotencyKey = "request-selection:route-command",
  pool,
} = {}) {
  const user = {
    id: userId,
    email: `user${userId}@example.test`,
    role: "user",
    token_version: 0,
  };
  const path = method === "get"
    ? "/posts/:postId/professional-responses"
    : "/posts/:postId/professional-responses/:responseId/select";
  app.locals.pool = pool;
  const req = {
    app,
    body,
    params: { postId, responseId },
    headers: {
      authorization: `Bearer ${createToken(user)}`,
      "idempotency-key": idempotencyKey,
    },
    user,
  };
  const res = response();

  try {
    for (const handler of getHandlers(method, path)) {
      if (res.finished) break;
      if (handler.length < 3) {
        await handler(req, res);
      } else {
        await new Promise((resolve, reject) => {
          const next = (error) => error ? reject(error) : resolve();
          Promise.resolve(handler(req, res, next)).then(() => {
            if (res.finished) resolve();
          }, reject);
        });
      }
    }
    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("homeowner list route returns strict pre-selection response truth", async () => {
  const fake = createRequestSelectionFake();
  const result = await invoke({ method: "get", pool: fake.pool });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.code, "PROFESSIONAL_RESPONSES_FOUND");
  assert.equal(result.body.responses.length, 2);
  assert.equal(
    result.body.responses.every((row) =>
      row.status === "submitted" &&
      row.relationship_status === "pending" &&
      row.selection_eligible === true &&
      row.conversation_available === false &&
      row.conversation_id === null
    ),
    true
  );
});

test("selection route returns only the canonical exact authority result", async () => {
  const fake = createRequestSelectionFake();
  const result = await invoke({ pool: fake.pool });

  assert.equal(result.statusCode, 201);
  assert.equal(result.body.success, true);
  assert.equal(result.body.code, "REQUEST_SELECTION_CREATED");
  assert.equal(result.body.response.status, "selected");
  assert.equal(result.body.relationship.status, "active");
  assert.equal(result.body.conversation.status, "active");
  assert.equal(result.body.privacy_stage, 3);
  assert.equal(result.body.resultClassification, "created");
  assert.equal(result.body.replayed, false);
  const serialized = JSON.stringify(result.body);
  assert.doesNotMatch(serialized, /location|unit_number|access|email|phone/i);
});

test("selection route rejects browser-authored authority fields", async () => {
  const fake = createRequestSelectionFake();
  const result = await invoke({
    pool: fake.pool,
    body: { conversationId: 55 },
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, "UNSUPPORTED_REQUEST_SELECTION_FIELDS");
  assert.equal(fake.state.selections.length, 0);
});

test("selection route requires a governed idempotency key", async () => {
  const fake = createRequestSelectionFake();
  const result = await invoke({ pool: fake.pool, idempotencyKey: "" });

  assert.equal(result.statusCode, 400);
  assert.equal(
    result.body.code,
    "INVALID_REQUEST_SELECTION_IDEMPOTENCY_KEY"
  );
  assert.equal(fake.state.selections.length, 0);
});

test("selection route preserves owner-scoped not-found behavior", async () => {
  const fake = createRequestSelectionFake();
  const result = await invoke({ pool: fake.pool, userId: 8 });

  assert.equal(result.statusCode, 404);
  assert.equal(result.body.code, "REQUEST_NOT_FOUND");
  assert.equal(fake.state.selections.length, 0);
});
