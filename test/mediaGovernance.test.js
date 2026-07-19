"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-media-governance";

const { app, createToken } = require("../index");
const {
  GOVERNED_MEDIA_ERROR,
  findUnsupportedMediaField,
} = require("../server/media/mediaReferencePolicy");

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
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
  };
}

function createPool() {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text: String(text), values });
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (sql.includes("SELECT id, email, role, token_version FROM users")) {
        return {
          rows: [{
            id: 7,
            email: "owner@example.test",
            role: "professional",
            token_version: 0,
          }],
        };
      }
      throw new Error("Mutation query must not run for ungoverned media");
    },
  };
}

async function invoke(method, path, body) {
  const pool = createPool();
  app.locals.pool = pool;
  const req = {
    app,
    body,
    params: path.includes(":id") ? { id: "91" } : {},
    headers: {
      authorization: `Bearer ${createToken({
        id: 7,
        email: "owner@example.test",
        role: "professional",
        token_version: 0,
      })}`,
    },
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
    return { res, pool };
  } finally {
    delete app.locals.pool;
  }
}

test("media policy treats only empty compatibility fields as absent", () => {
  assert.equal(findUnsupportedMediaField({}, ["image_url"]), null);
  assert.equal(findUnsupportedMediaField({ image_url: "" }, ["image_url"]), null);
  assert.equal(findUnsupportedMediaField({ image_urls: [] }, ["image_urls"]), null);
  assert.equal(
    findUnsupportedMediaField({ image_url: "https://example.test/image.jpg" }, ["image_url"]),
    "image_url"
  );
  assert.equal(
    findUnsupportedMediaField({ image_urls: ["https://example.test/image.jpg"] }, ["image_urls"]),
    "image_urls"
  );
});

for (const scenario of [
  {
    method: "post",
    path: "/posts",
    body: { title: "Request", image_url: "https://example.test/request.jpg" },
  },
  {
    method: "post",
    path: "/messages",
    body: { quote_request_id: 1, receiver_id: 2, image_url: "https://example.test/message.jpg" },
  },
  {
    method: "post",
    path: "/contractor-projects",
    body: { contractor_id: 3, image_urls: ["https://example.test/project.jpg"] },
  },
  {
    method: "put",
    path: "/contractor-projects/:id",
    body: { image_url: "https://example.test/project.jpg" },
  },
]) {
  test(`${scenario.method.toUpperCase()} ${scenario.path} rejects ungoverned media before mutation`, async () => {
    const { res, pool } = await invoke(scenario.method, scenario.path, scenario.body);

    assert.equal(res.statusCode, GOVERNED_MEDIA_ERROR.status);
    assert.equal(res.body.code, GOVERNED_MEDIA_ERROR.code);
    assert.equal(pool.calls.length, 1);
    assert.match(
      pool.calls[0].text.replace(/\s+/g, " "),
      /SELECT id, email, role, token_version FROM users/
    );
  });
}
