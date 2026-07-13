"use strict";

const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { createEmailDelivery } = require("../server/email/emailDelivery");
const { PASSWORD_RESET_SUBJECT } = require("../server/email/passwordResetEmail");
const {
  GENERIC_REQUEST_RESPONSE,
  createPasswordResetService,
  generateResetToken,
  hashResetToken,
  resolvePasswordResetWebUrl,
} = require("../server/security/passwordResetService");

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

async function createFakePool() {
  const users = new Map([
    [1, { id: 1, email: "known@example.test", password_hash: await bcrypt.hash("CurrentPass12", 10), token_version: 2 }],
    [2, { id: 2, email: "other@example.test", password_hash: await bcrypt.hash("OtherPass12", 10), token_version: 4 }],
  ]);
  const tokens = [];
  const calls = [];
  let nextId = 1;
  let queue = Promise.resolve();

  const query = async (text, values = []) => {
    const sql = normalizeSql(text);
    calls.push({ sql, values });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql === "SELECT id, email FROM users WHERE email = $1") {
      const user = [...users.values()].find((item) => item.email === values[0]);
      return { rows: user ? [user] : [] };
    }
    if (sql.startsWith("SELECT created_at FROM password_reset_tokens")) {
      const rows = tokens.filter((item) => item.user_id === values[0]).sort((a, b) => b.created_at - a.created_at);
      return { rows: rows.slice(0, 1) };
    }
    if (sql.startsWith("UPDATE password_reset_tokens SET revoked_at") && sql.includes("token_hash = $1")) {
      const record = tokens.find((item) => item.token_hash === values[0] && !item.used_at);
      if (record) record.revoked_at = values[1];
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE password_reset_tokens SET revoked_at") && sql.includes("id <> $3")) {
      tokens.filter((item) => item.user_id === values[0] && item.id !== values[2] && !item.used_at && !item.revoked_at)
        .forEach((item) => { item.revoked_at = values[1]; });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE password_reset_tokens SET revoked_at")) {
      tokens.filter((item) => item.user_id === values[0] && !item.used_at && !item.revoked_at)
        .forEach((item) => { item.revoked_at = values[1]; });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO password_reset_tokens")) {
      tokens.push({ id: nextId++, user_id: values[0], token_hash: values[1], expires_at: values[2], created_at: values[3], used_at: null, revoked_at: null });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id, user_id, expires_at")) {
      const record = tokens.find((item) => item.token_hash === values[0]);
      return { rows: record ? [{ ...record }] : [] };
    }
    if (sql === "SELECT id, password_hash FROM users WHERE id = $1 FOR UPDATE") {
      const user = users.get(Number(values[0]));
      return { rows: user ? [user] : [] };
    }
    if (sql.startsWith("UPDATE users SET password_hash")) {
      const user = users.get(Number(values[1]));
      user.password_hash = values[0];
      user.token_version += 1;
      return { rows: [{ id: user.id, token_version: user.token_version }] };
    }
    if (sql.startsWith("UPDATE password_reset_tokens SET used_at")) {
      const record = tokens.find((item) => item.id === values[0] && !item.used_at && !item.revoked_at);
      if (!record) return { rows: [] };
      record.used_at = values[1];
      return { rows: [{ id: record.id }] };
    }
    throw new Error(`Unexpected reset SQL: ${sql}`);
  };

  return {
    users, tokens, calls, query,
    async connect() {
      let unlock;
      const previous = queue;
      queue = new Promise((resolve) => { unlock = resolve; });
      await previous;
      return { query, release: unlock };
    },
  };
}

function serviceOptions(pool, overrides = {}) {
  return {
    pool,
    env: { NODE_ENV: "production", PASSWORD_RESET_WEB_URL: "https://getmeetro.com/reset-password" },
    emailDelivery: { async sendPasswordResetEmail() { return { accepted: true }; } },
    ...overrides,
  };
}

test("reset tokens are opaque, URL-safe, and hashed deterministically", () => {
  const token = generateResetToken((size) => Buffer.alloc(size, 7));
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(hashResetToken(token).length, 64);
  assert.notEqual(hashResetToken(token), token);
});

test("reset URL configuration is explicit and rejects unsafe public URLs", () => {
  assert.equal(resolvePasswordResetWebUrl({ NODE_ENV: "production" }).configured, false);
  for (const value of [
    "http://getmeetro.com/reset-password",
    "https://user:pass@getmeetro.com/reset-password",
    "https://evil.example/reset-password",
    "https://getmeetro.com/reset-password?existing=true",
    "https://getmeetro.com/reset-password#token",
  ]) {
    assert.equal(resolvePasswordResetWebUrl({ NODE_ENV: "production", PASSWORD_RESET_WEB_URL: value }).configured, false);
  }
  assert.equal(resolvePasswordResetWebUrl({ NODE_ENV: "production", PASSWORD_RESET_WEB_URL: "https://getmeetro.com/reset-password" }).configured, true);
});

test("known and unknown reset requests are identical while only known accounts store hashed tokens", async () => {
  const pool = await createFakePool();
  let delivered;
  const service = createPasswordResetService(serviceOptions(pool, {
    randomBytes: (size) => Buffer.alloc(size, 9),
    emailDelivery: { async sendPasswordResetEmail(payload) { delivered = payload; return { accepted: true }; } },
  }));
  const known = await service.request("  KNOWN@EXAMPLE.TEST ");
  const unknown = await service.request("unknown@example.test");
  assert.deepEqual(known, GENERIC_REQUEST_RESPONSE);
  assert.deepEqual(unknown, GENERIC_REQUEST_RESPONSE);
  assert.equal(pool.tokens.length, 1);
  assert.equal(pool.tokens[0].token_hash.length, 64);
  assert.equal(JSON.stringify(pool.tokens).includes(delivered.resetUrl.split("token=")[1]), false);
  assert.match(delivered.resetUrl, /^https:\/\/getmeetro\.com\/reset-password\?token=/);
  assert.equal(delivered.expiresInMinutes, 30);
});

test("provider failure revokes the new token and a later request revokes prior unused tokens", async () => {
  const pool = await createFakePool();
  let currentTime = new Date("2026-07-13T12:00:00Z");
  const failed = createPasswordResetService(serviceOptions(pool, {
    now: () => currentTime,
    emailDelivery: { async sendPasswordResetEmail() { return { accepted: false }; } },
  }));
  await failed.request("known@example.test");
  assert.ok(pool.tokens[0].revoked_at);

  currentTime = new Date(currentTime.getTime() + 61_000);
  const successful = createPasswordResetService(serviceOptions(pool, { now: () => currentTime }));
  await successful.request("known@example.test");
  assert.equal(pool.tokens.length, 2);
  assert.ok(pool.tokens[0].revoked_at);
  assert.equal(pool.tokens[1].revoked_at, null);
});

test("request failures roll back safely and logs never contain the raw reset token", async () => {
  const transactionCalls = [];
  let delivered = false;
  const pool = {
    async query(text) {
      const sql = normalizeSql(text);
      if (sql === "SELECT id, email FROM users WHERE email = $1") {
        return { rows: [{ id: 1, email: "known@example.test" }] };
      }
      if (sql.startsWith("SELECT created_at FROM password_reset_tokens")) return { rows: [] };
      throw new Error(`Unexpected outer query: ${sql}`);
    },
    async connect() {
      return {
        async query(text) {
          const sql = normalizeSql(text);
          transactionCalls.push(sql);
          if (sql.startsWith("INSERT INTO password_reset_tokens")) throw new Error("database unavailable");
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const rawToken = generateResetToken((size) => Buffer.alloc(size, 4));
  const logs = [];
  const service = createPasswordResetService(serviceOptions(pool, {
    randomBytes: (size) => Buffer.alloc(size, 4),
    logger: (...entry) => logs.push(entry),
    emailDelivery: {
      async sendPasswordResetEmail() {
        delivered = true;
        return { accepted: true };
      },
    },
  }));

  assert.deepEqual(await service.request("known@example.test"), GENERIC_REQUEST_RESPONSE);
  assert.equal(delivered, false);
  assert.ok(transactionCalls.includes("ROLLBACK"));
  assert.equal(JSON.stringify(logs).includes(rawToken), false);
});

test("valid completion hashes the password, consumes once, increments token version, and returns no JWT", async () => {
  const pool = await createFakePool();
  let resetUrl;
  const service = createPasswordResetService(serviceOptions(pool, {
    emailDelivery: { async sendPasswordResetEmail(payload) { resetUrl = payload.resetUrl; return { accepted: true }; } },
  }));
  await service.request("known@example.test");
  const rawToken = new URL(resetUrl).searchParams.get("token");
  const beforeVersion = pool.users.get(1).token_version;
  const otherUserBefore = { ...pool.users.get(2) };
  const result = await service.complete({ token: rawToken, newPassword: "NewSecure12" });
  assert.equal(result.ok, true);
  assert.equal(result.body.code, "PASSWORD_RESET_COMPLETE");
  assert.equal(Object.hasOwn(result.body, "token"), false);
  assert.equal(await bcrypt.compare("NewSecure12", pool.users.get(1).password_hash), true);
  assert.equal(pool.users.get(1).token_version, beforeVersion + 1);
  assert.deepEqual(pool.users.get(2), otherUserBefore);
  assert.ok(pool.tokens[0].used_at);
  const replay = await service.complete({ token: rawToken, newPassword: "AnotherPass12" });
  assert.equal(replay.code, "RESET_TOKEN_USED");
});

test("completion rejects missing, invalid, expired, revoked, reused-password, and weak requests", async () => {
  const pool = await createFakePool();
  const service = createPasswordResetService(serviceOptions(pool));
  assert.equal((await service.complete({ newPassword: "NewSecure12" })).code, "RESET_TOKEN_REQUIRED");
  assert.equal((await service.complete({ token: "opaque" })).code, "NEW_PASSWORD_REQUIRED");
  assert.equal((await service.complete({ token: "opaque", newPassword: "weak" })).code, "PASSWORD_POLICY_FAILED");
  assert.equal((await service.complete({ token: "unknown", newPassword: "NewSecure12" })).code, "RESET_TOKEN_INVALID");

  const token = "valid-opaque-token";
  pool.tokens.push({ id: 10, user_id: 1, token_hash: hashResetToken(token), expires_at: new Date(Date.now() - 1), created_at: new Date(), used_at: null, revoked_at: null });
  assert.equal((await service.complete({ token, newPassword: "NewSecure12" })).code, "RESET_TOKEN_EXPIRED");
  pool.tokens[0].expires_at = new Date(Date.now() + 60_000);
  pool.tokens[0].revoked_at = new Date();
  assert.equal((await service.complete({ token, newPassword: "NewSecure12" })).code, "RESET_TOKEN_INVALID");
  pool.tokens[0].revoked_at = null;
  assert.equal((await service.complete({ token, newPassword: "CurrentPass12" })).code, "PASSWORD_REUSE_NOT_ALLOWED");
});

test("concurrent completion permits exactly one success", async () => {
  const pool = await createFakePool();
  let resetUrl;
  const service = createPasswordResetService(serviceOptions(pool, {
    emailDelivery: { async sendPasswordResetEmail(payload) { resetUrl = payload.resetUrl; return { accepted: true }; } },
  }));
  await service.request("known@example.test");
  const token = new URL(resetUrl).searchParams.get("token");
  const results = await Promise.all([
    service.complete({ token, newPassword: "FirstSecure12" }),
    service.complete({ token, newPassword: "SecondSecure12" }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === "RESET_TOKEN_USED").length, 1);
});

test("Resend password-reset email contains configured sender, link, expiry, and no credential data", async () => {
  let body;
  const delivery = createEmailDelivery({
    env: { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "private", SECURITY_EMAIL_FROM: "Meetro Security <security@auth.getmeetro.com>" },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true }; },
  });
  await delivery.sendPasswordResetEmail({ recipientEmail: "known@example.test", resetUrl: "https://getmeetro.com/reset-password?token=opaque", expiresInMinutes: 30 });
  assert.equal(body.subject, PASSWORD_RESET_SUBJECT);
  assert.match(body.text, /token=opaque/);
  assert.match(body.html, /token=opaque/);
  assert.match(body.text, /30 minutes/);
  assert.doesNotMatch(`${body.text}${body.html}`, /current password:|jwt|verification code/i);
});

test("password reset migration is additive and leaves the baseline unchanged", () => {
  const sql = readFileSync(join(__dirname, "..", "migrations", "202607130002_create_password_reset_tokens.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS password_reset_tokens/);
  assert.match(sql, /token_hash CHAR\(64\).*UNIQUE/i);
  assert.match(sql, /REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /idx_password_reset_tokens_user_id/);
  assert.match(sql, /idx_password_reset_tokens_expires_at/);
  assert.doesNotMatch(sql, /DROP|TRUNCATE|DELETE FROM|ALTER TABLE users/i);
});
