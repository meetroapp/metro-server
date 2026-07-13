"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createAuthRateLimiter } = require("../server/security/authRateLimit");
const { resolveJwtSecret } = require("../server/security/jwtConfig");
const { validatePasswordPolicy } = require("../server/security/passwordPolicy");
const {
  TWO_FACTOR_FAILURE,
  createTwoFactorChallengeStore,
} = require("../server/security/twoFactorChallenges");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("JWT configuration fails closed and accepts an explicit secret", () => {
  assert.throws(() => resolveJwtSecret({}), /JWT_SECRET is required/);
  assert.equal(resolveJwtSecret({ JWT_SECRET: "explicit-secret" }), "explicit-secret");
});

test("server startup fails without JWT_SECRET and succeeds with explicit configuration", () => {
  const indexPath = path.join(__dirname, "..", "index.js");
  const environment = { ...process.env, NODE_ENV: "production" };
  delete environment.JWT_SECRET;
  const missing = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(indexPath)})`], {
    cwd: "/private/tmp",
    env: environment,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}${missing.stdout}`, /JWT_SECRET is required/);

  const configured = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(indexPath)})`], {
    cwd: "/private/tmp",
    env: { ...environment, JWT_SECRET: "explicit-startup-test-secret" },
    encoding: "utf8",
  });
  assert.equal(configured.status, 0);
});

test("shared password policy enforces the documented baseline without echoing passwords", () => {
  const cases = [
    ["Short1", "PASSWORD_TOO_SHORT"],
    ["lowercase12", "PASSWORD_REQUIRES_UPPERCASE"],
    ["UPPERCASE12", "PASSWORD_REQUIRES_LOWERCASE"],
    ["NoNumbersHere", "PASSWORD_REQUIRES_NUMBER"],
  ];

  for (const [password, expectedCode] of cases) {
    const result = validatePasswordPolicy(password);
    assert.equal(result.valid, false);
    assert.equal(result.code, expectedCode);
    assert.equal(JSON.stringify(result).includes(password), false);
  }

  assert.deepEqual(validatePasswordPolicy("StrongPass12"), { valid: true, code: null });
});

test("two-factor challenges expire, limit attempts, bind accounts, and prevent replay", () => {
  let currentTime = 1000;
  let issuedCode = "234567";
  let challengeNumber = 0;
  const store = createTwoFactorChallengeStore({
    now: () => currentTime,
    ttlMs: 100,
    maxAttempts: 2,
    sendCooldownMs: 0,
    codeGenerator: () => issuedCode,
    idGenerator: () => `challenge-${++challengeNumber}`,
  });

  const first = store.issue("Person@Example.Test");
  assert.equal(first.deliveryCode, issuedCode);
  assert.equal(
    store.verify({ challengeId: first.challengeId, identity: "other@example.test", code: issuedCode }).code,
    TWO_FACTOR_FAILURE.ACCOUNT_MISMATCH
  );
  assert.equal(
    store.verify({ challengeId: first.challengeId, identity: "person@example.test", code: "000000" }).code,
    TWO_FACTOR_FAILURE.TOO_MANY_ATTEMPTS
  );
  assert.equal(
    store.verify({ challengeId: first.challengeId, identity: "person@example.test", code: issuedCode }).code,
    TWO_FACTOR_FAILURE.TOO_MANY_ATTEMPTS
  );

  const second = store.issue("person@example.test");
  assert.equal(store.verify({ challengeId: second.challengeId, identity: "person@example.test", code: issuedCode }).ok, true);
  assert.equal(
    store.verify({ challengeId: second.challengeId, identity: "person@example.test", code: issuedCode }).code,
    TWO_FACTOR_FAILURE.CHALLENGE_USED
  );

  const third = store.issue("person@example.test");
  currentTime = 1100;
  assert.equal(
    store.verify({ challengeId: third.challengeId, identity: "person@example.test", code: issuedCode }).code,
    TWO_FACTOR_FAILURE.CHALLENGE_EXPIRED
  );
  assert.equal(
    store.verify({ challengeId: "missing", identity: "person@example.test", code: issuedCode }).code,
    TWO_FACTOR_FAILURE.MISSING_CHALLENGE
  );
});

test("auth rate limiter uses bounded safe keys and resets deterministically", () => {
  let currentTime = 0;
  const limiter = createAuthRateLimiter({
    windowMs: 100,
    maxAttempts: 2,
    maxEntries: 2,
    now: () => currentTime,
    keyResolver: (req) => `login:${req.body.email}`,
  });
  const request = { body: { email: "person@example.test", password: "SecretPassword12" } };

  for (let index = 0; index < 2; index += 1) {
    let nextCalled = false;
    limiter(request, createResponse(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  }

  const blocked = createResponse();
  limiter(request, blocked, () => {});
  assert.equal(blocked.statusCode, 429);
  assert.equal(limiter.getKeys().some((key) => key.includes(request.body.password)), false);

  currentTime = 100;
  let resetCalled = false;
  limiter(request, createResponse(), () => { resetCalled = true; });
  assert.equal(resetCalled, true);
});

test("token-version migration is narrow, additive, and guarded", () => {
  const migrationPath = path.join(__dirname, "..", "migrations", "202607130001_add_user_token_version.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /ALTER TABLE users/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0/i);
  assert.doesNotMatch(sql, /DROP|DELETE|TRUNCATE|UPDATE/i);
  assert.equal((sql.match(/ALTER TABLE/gi) || []).length, 1);
});

test("authentication source contains no JWT fallback, fixed code, or development code response", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

  assert.doesNotMatch(source, /my_super_secret_key_123/);
  assert.doesNotMatch(source, /devCode/);
  assert.doesNotMatch(source, /code\s*===\s*["']\d{6}["']/);
  assert.doesNotMatch(source, /console\.(?:log|error)[^\n]*(?:password|authorization|verification code|submitted code)/i);
});
