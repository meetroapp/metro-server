"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const scriptPath = join(__dirname, "..", "scripts", "verify-staging-trust.js");
const scriptSource = readFileSync(scriptPath, "utf8");
const {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LIVE_CLI_CONFIRMATION,
  LIVE_ENV_GATE,
  MEDIA_TRUST,
  cleanupResources,
  createRunId,
  createSummary,
  exitCodeForSummary,
  redactSecrets,
  requestJson,
  runStagingTrust,
  trackResource,
  validateTargetAuthorization,
} = require("../scripts/verify-staging-trust");

function validStagingEnv(overrides = {}) {
  return {
    MEETRO_STAGING_API_URL: "https://staging-api.example.test",
    MEETRO_STAGING_TRUST_TARGET: "staging",
    MEETRO_ALLOW_LIVE_STAGING_TRUST: "1",
    ...overrides,
  };
}

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async text() {
      return JSON.stringify(body);
    },
  };
}

function createSuccessfulTrustFetch() {
  const posts = new Map();
  let accountNumber = 0;

  return async (url, options = {}) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname;
    const method = options.method || "GET";
    const token = String(options.headers?.Authorization || "").replace("Bearer ", "");
    const body = options.body ? JSON.parse(options.body) : null;

    if (endpoint === "/health" && method === "GET") return response(200, { status: "ok" });
    if (endpoint === "/health" && method === "OPTIONS") return response(403, { code: "CORS_DENIED" });
    if (endpoint === "/auth/signup") {
      accountNumber += 1;
      return response(200, {
        token: `signup-token-${accountNumber}`,
        user: { id: accountNumber },
      });
    }
    if (endpoint === "/auth/login") {
      if (!body?.email) return response(400, { code: "INVALID_REQUEST" });
      if (body.email.includes("-missing@")) return response(401, { code: "INVALID_LOGIN" });
      const id = body.email.includes("-a@") ? 1 : 2;
      return response(200, { token: `token-${id}`, user: { id } });
    }
    if (endpoint === "/auth/me") {
      const id = token === "token-1" ? 1 : 2;
      return response(200, { user: { id } });
    }
    if (endpoint === "/posts" && method === "POST") {
      const id = token === "token-1" ? 11 : 22;
      posts.set(id, { id, title: body.title });
      return response(200, { post: posts.get(id) });
    }
    if (endpoint === "/posts" && method === "GET") {
      const id = token === "token-1" ? 11 : 22;
      return response(200, { posts: [posts.get(id)] });
    }
    if (/^\/posts\/\d+$/.test(endpoint)) return response(404, { code: "NOT_FOUND" });
    if (endpoint === "/contractor-profiles" && method === "POST") {
      return response(200, { profile: { id: 31 } });
    }
    if (endpoint === "/quote-requests" && method === "POST") {
      return response(200, { quote: { id: 41 } });
    }
    if (endpoint === "/messages" && method === "POST") {
      return token === "token-1"
        ? response(200, { data: { id: 51 } })
        : response(404, { code: "NOT_FOUND" });
    }
    if (/^\/messages\/\d+$/.test(endpoint)) return response(404, { code: "NOT_FOUND" });
    if (endpoint === "/workflow-events" && method === "POST") {
      return token === "token-1"
        ? response(200, { workflow_event: { id: 61 } })
        : response(404, { code: "NOT_FOUND" });
    }
    if (/^\/workflow-events\/\d+$/.test(endpoint)) return response(404, { code: "NOT_FOUND" });
    if (endpoint === "/contractor-projects" && method === "POST") {
      return response(200, { project: { id: 71 } });
    }
    if (/^\/contractor-projects\/\d+$/.test(endpoint) && method === "PUT") {
      return response(404, { code: "NOT_FOUND" });
    }
    throw new Error(`Unexpected fake trust request: ${method} ${endpoint}`);
  };
}

test("importing verifier never starts network verification", () => {
  const child = spawnSync(
    process.execPath,
    ["-e", `global.fetch = () => { throw new Error('network called'); }; require(${JSON.stringify(scriptPath)});`],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("direct execution without either live gate fails before network access", () => {
  const child = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      MEETRO_STAGING_API_URL: "https://staging-api.example.test",
      MEETRO_STAGING_TRUST_TARGET: "staging",
    },
  });
  assert.equal(child.status, 1);
  const summary = JSON.parse(child.stdout);
  assert.equal(summary.result, "fail");
  assert.equal(summary.checks[0].safeCode, "UNSAFE_TARGET_OR_MISSING_GATE");
});

test("environment gate without CLI confirmation still fails closed", () => {
  const authorization = validateTargetAuthorization({
    env: validStagingEnv(),
    args: [],
  });
  assert.equal(authorization.authorized, false);
  assert.ok(authorization.reasons.includes(`${LIVE_CLI_CONFIRMATION} is required.`));
});

test("both explicit gates authorize evaluation without inferring staging from hostname", () => {
  const authorization = validateTargetAuthorization({
    env: validStagingEnv(),
    args: [LIVE_CLI_CONFIRMATION],
  });
  assert.equal(authorization.authorized, true);
  assert.deepEqual(authorization.target, {
    type: "staging",
    host: "staging-api.example.test",
  });

  const hostnameOnly = validateTargetAuthorization({
    env: {
      MEETRO_STAGING_API_URL: "https://staging-api.example.test",
      [LIVE_ENV_GATE]: "1",
    },
    args: [LIVE_CLI_CONFIRMATION],
  });
  assert.equal(hostnameOnly.authorized, false);
});

test("target authorization rejects missing URL, production, credentials, queries, and public HTTP", () => {
  const missingUrl = validateTargetAuthorization({
    env: validStagingEnv({ MEETRO_STAGING_API_URL: "" }),
    args: [LIVE_CLI_CONFIRMATION],
  });
  assert.equal(missingUrl.authorized, false);

  for (const unsafeUrl of [
    "https://api.production.example.test",
    "https://user:password@staging-api.example.test",
    "https://staging-api.example.test?token=secret",
    "http://staging-api.example.test",
  ]) {
    const result = validateTargetAuthorization({
      env: validStagingEnv({ MEETRO_STAGING_API_URL: unsafeUrl }),
      args: [LIVE_CLI_CONFIRMATION],
    });
    assert.equal(result.authorized, false, unsafeUrl);
  }
});

test("localhost is allowed only in explicit local-test mode", () => {
  const staging = validateTargetAuthorization({
    env: validStagingEnv({ MEETRO_STAGING_API_URL: "https://localhost:3000" }),
    args: [LIVE_CLI_CONFIRMATION],
  });
  assert.equal(staging.authorized, false);

  const local = validateTargetAuthorization({
    env: validStagingEnv({
      NODE_ENV: "test",
      MEETRO_STAGING_API_URL: "http://127.0.0.1:3000/",
      MEETRO_STAGING_TRUST_TARGET: "local-test",
    }),
    args: [LIVE_CLI_CONFIRMATION],
  });
  assert.equal(local.authorized, true);
  assert.equal(local.baseUrl, "http://127.0.0.1:3000");
});

test("recursive redaction removes passwords, tokens, headers, codes, and URL secrets", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
  const redacted = redactSecrets({
    password: "SecretPass12",
    accessToken: jwt,
    authorization: `Bearer ${jwt}`,
    verificationCode: "123456",
    nested: [
      { cookie: "session=secret", code: "123456" },
      `request failed ${jwt}`,
      "https://user:pass@example.test/path?token=secret",
    ],
    status: 401,
    code: "SESSION_INVALID",
  });

  const serialized = JSON.stringify(redacted);
  for (const secret of ["SecretPass12", jwt, "123456", "session=secret", "token=secret", "user:pass"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(redacted.status, 401);
  assert.equal(redacted.code, "SESSION_INVALID");
});

test("requests use a bounded timeout and normalize aborts safely", async () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS >= 10000, true);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS <= 15000, true);
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("private timeout detail");
        error.name = "AbortError";
        reject(error);
      });
    });
  const result = await requestJson({
    baseUrl: "https://staging-api.example.test",
    endpoint: "/health",
    fetchImpl,
    timeoutMs: 5,
  });
  assert.equal(result.status, 0);
  assert.equal(result.errorCode, "REQUEST_TIMEOUT");
  assert.equal(JSON.stringify(result).includes("private timeout detail"), false);
});

test("network failures and raw response text are normalized", async () => {
  const network = await requestJson({
    baseUrl: "https://staging-api.example.test",
    endpoint: "/health",
    fetchImpl: async () => {
      throw new Error("token=private-network-detail");
    },
  });
  assert.equal(network.errorCode, "NETWORK_ERROR");
  assert.equal(JSON.stringify(network).includes("private-network-detail"), false);

  const invalidBody = await requestJson({
    baseUrl: "https://staging-api.example.test",
    endpoint: "/health",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      headers: new Headers(),
      async text() {
        return "raw private response body";
      },
    }),
  });
  assert.equal(invalidBody.body, null);
  assert.equal(JSON.stringify(invalidBody).includes("raw private response body"), false);
});

test("run IDs and tracked resource markers are run-scoped", () => {
  const first = createRunId(() => "11111111-1111-4111-8111-111111111111");
  const second = createRunId(() => "22222222-2222-4222-8222-222222222222");
  assert.notEqual(first, second);

  const resources = [];
  trackResource(resources, {
    type: "post",
    id: 42,
    marker: `qa-staging-trust-${first}-post`,
  });
  assert.equal(resources[0].marker.includes(first), true);
  assert.equal(scriptSource.includes("meetro-stage-a-"), false);
});

test("cleanup runs in reverse order and continues after a redacted failure", async () => {
  const order = [];
  const resources = [
    { type: "first", id: "1", marker: "run-first", cleanupSupported: true },
    { type: "second", id: "2", marker: "run-second", cleanupSupported: true },
    { type: "account", id: "3", marker: "run-account", cleanupSupported: false },
  ];
  const cleanup = await cleanupResources(resources, {
    first: async () => order.push("first"),
    second: async () => {
      order.push("second");
      throw new Error("Bearer secret-token cleanup failed");
    },
  });

  assert.deepEqual(order, ["second", "first"]);
  assert.equal(cleanup.complete, false);
  assert.deepEqual(cleanup.retainedAccounts, ["run-account"]);
  assert.equal(cleanup.failures.length, 1);
  assert.equal(JSON.stringify(cleanup).includes("secret-token"), false);
});

test("unsupported cleanup is never reported as complete", async () => {
  const cleanup = await cleanupResources([
    { type: "post", id: "9", marker: "run-post", cleanupSupported: false },
  ]);
  assert.equal(cleanup.attempted, true);
  assert.equal(cleanup.complete, false);
  assert.deepEqual(cleanup.retainedResources, [
    { type: "post", id: "9", marker: "run-post" },
  ]);
});

test("unsafe runs produce deterministic machine-readable summaries without fetch", async () => {
  let fetchCalled = false;
  const summary = await runStagingTrust({
    env: {},
    args: [],
    fetchImpl: async () => {
      fetchCalled = true;
      return response(200, { status: "ok" });
    },
    idGenerator: () => "33333333-3333-4333-8333-333333333333",
    isoNow: () => "2026-07-13T12:00:00.000Z",
  });

  assert.equal(fetchCalled, false);
  assert.equal(summary.result, "fail");
  assert.equal(summary.target.host, "unknown");
  assert.deepEqual(summary.totals, { passed: 0, failed: 1, skipped: 0 });
  assert.equal(summary.cleanup.attempted, true);
  assert.deepEqual(summary.mediaTrust, MEDIA_TRUST);
  assert.equal(exitCodeForSummary(summary), 1);
});

test("complete two-account run preserves checks and reports retained artifacts truthfully", async () => {
  const runId = "444444444444444444444444";
  const summary = await runStagingTrust({
    env: validStagingEnv(),
    args: [LIVE_CLI_CONFIRMATION],
    fetchImpl: createSuccessfulTrustFetch(),
    idGenerator: () => runId,
    isoNow: () => "2026-07-13T12:00:00.000Z",
  });

  assert.equal(summary.totals.failed, 0);
  assert.equal(summary.result, "pass_with_retained_test_accounts");
  assert.equal(exitCodeForSummary(summary), 1);
  assert.equal(summary.cleanup.complete, false);
  assert.equal(summary.cleanup.retainedAccounts.length, 2);
  assert.equal(summary.resources.length >= 9, true);
  assert.equal(summary.resources.every((item) => item.marker.includes(runId)), true);
  assert.equal(
    summary.checks
      .filter((check) => check.name.includes("cannot_"))
      .every((check) => check.status === "pass" && check.actualStatus === 404),
    true
  );
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("token-1"), false);
  assert.equal(serialized.includes("password"), false);
});

test("critical setup failure still performs cleanup for resources already created", async () => {
  let signupCount = 0;
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url).pathname;
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    if (endpoint === "/health" && method === "GET") return response(200, { status: "ok" });
    if (endpoint === "/health" && method === "OPTIONS") return response(403, { code: "CORS_DENIED" });
    if (endpoint === "/auth/login" && !body?.email) return response(400, { code: "INVALID_REQUEST" });
    if (endpoint === "/auth/login") return response(401, { code: "INVALID_LOGIN" });
    if (endpoint === "/auth/signup") {
      signupCount += 1;
      return signupCount === 1
        ? response(200, { token: "private-signup-token", user: { id: 1 } })
        : response(500, { code: "SIGNUP_FAILED" });
    }
    throw new Error(`Unexpected failure-path request: ${method} ${endpoint}`);
  };
  const summary = await runStagingTrust({
    env: validStagingEnv(),
    args: [LIVE_CLI_CONFIRMATION],
    fetchImpl,
    idGenerator: () => "55555555-5555-4555-8555-555555555555",
  });

  assert.equal(summary.result, "fail");
  assert.equal(summary.cleanup.attempted, true);
  assert.equal(summary.cleanup.retainedAccounts.length, 1);
  assert.equal(JSON.stringify(summary).includes("private-signup-token"), false);
});

test("retained test accounts force a guarded non-zero result", () => {
  const summary = createSummary({
    runId: "run",
    target: { type: "staging", host: "staging-api.example.test" },
    startedAt: "start",
  });
  summary.result = "pass_with_retained_test_accounts";
  assert.equal(exitCodeForSummary(summary), 1);
  summary.result = "pass";
  assert.equal(exitCodeForSummary(summary), 0);
});

test("two-account ownership checks preserve exact private-route expectations", () => {
  for (const requiredCheck of [
    "account_a_cannot_read_b_post",
    "account_b_cannot_read_a_post",
    "account_b_cannot_read_a_messages",
    "account_b_cannot_write_a_messages",
    "account_b_cannot_read_a_workflow",
    "account_b_cannot_write_a_workflow",
    "account_b_cannot_mutate_a_project",
  ]) {
    assert.match(scriptSource, new RegExp(requiredCheck));
  }
  assert.match(scriptSource, /expectedStatus: 404/g);
  assert.match(scriptSource, /qa-staging-trust/);
});

test(
  "live staging verification is skipped unless explicitly requested",
  { skip: process.env.MEETRO_RUN_LIVE_STAGING_TRUST !== "1" },
  () => {
    const child = spawnSync(
      process.execPath,
      [scriptPath, LIVE_CLI_CONFIRMATION],
      {
        encoding: "utf8",
        env: process.env,
      }
    );
    assert.equal([0, 1].includes(child.status), true);
  }
);
