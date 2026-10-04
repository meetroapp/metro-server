"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");

const {
  BRIDGE_VERSION,
  startBridge,
} = require("../production-maintenance/bridge-v1/server");

async function withBridge(env, callback) {
  const logs = [];
  const server = startBridge({
    env: { ...env, PORT: "0" },
    logger: { info: (line) => logs.push(line) },
  });
  await once(server, "listening");
  try {
    await callback({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      logs,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("exact GET /health is the bridge's only HTTP 200 response", async () => {
  await withBridge({
    BRIDGE_SOURCE_SHA: "a".repeat(40),
    BRIDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  }, async ({ baseUrl }) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), {
      status: "maintenance",
      trafficMode: "blocked",
      bridgeVersion: BRIDGE_VERSION,
      sourceRevision: "a".repeat(40),
      imageDigest: `sha256:${"b".repeat(64)}`,
    });

    for (const target of ["/health?probe=1", "/health/", "/", "/api/requests"]) {
      const response = await fetch(`${baseUrl}${target}`);
      assert.equal(response.status, 503, target);
    }
  });
});

test("all representative methods and Meetro business routes fail with bounded 503", async () => {
  await withBridge({}, async ({ baseUrl }) => {
    const cases = [
      ["GET", "/auth/me"],
      ["POST", "/login"],
      ["PUT", "/requests/1"],
      ["PATCH", "/messages/1"],
      ["DELETE", "/team/members/1"],
      ["OPTIONS", "/quotes/1"],
      ["HEAD", "/invoices/1"],
    ];
    for (const [method, path] of cases) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        body: ["POST", "PUT", "PATCH"].includes(method) ? "sensitive-body" : undefined,
        headers: {
          Authorization: "Bearer sensitive-token",
          Cookie: "session=sensitive-cookie",
          "Content-Type": "text/plain",
        },
      });
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "120");
      if (method !== "HEAD") {
        const body = await response.text();
        assert.match(body, /temporarily unavailable/);
        assert.doesNotMatch(body, /sensitive/i);
      }
    }
  });
});

test("request content is never logged or echoed", async () => {
  await withBridge({}, async ({ baseUrl, logs }) => {
    const response = await fetch(`${baseUrl}/messages?customer=private-query`, {
      method: "POST",
      headers: {
        Authorization: "Bearer private-authorization",
        Cookie: "private-cookie=true",
        "Content-Type": "text/plain",
      },
      body: "private-request-body",
    });
    const output = `${logs.join("\n")}\n${await response.text()}`;
    for (const secret of [
      "private-query", "private-authorization", "private-cookie", "private-request-body",
    ]) {
      assert.doesNotMatch(output, new RegExp(secret));
    }
  });
});

test("bridge starts with no database variable and ignores a dummy database variable", async () => {
  for (const environment of [
    {},
    { DATABASE_URL: "postgresql://should-not-resolve.invalid/never-connected" },
  ]) {
    await withBridge(environment, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
    });
  }
});
