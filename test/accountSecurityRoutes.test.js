"use strict";

const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { beforeEach, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-account-route-tests";

const {
  app,
  authRateLimiters,
  createToken,
  twoFactorChallengeStore,
} = require("../index");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

async function createFakePool() {
  const users = new Map();
  users.set(1, {
    id: 1,
    username: "Personal User",
    email: "personal@example.test",
    password_hash: await bcrypt.hash("CurrentPass12", 10),
    role: "homeowner",
    account_type: "homeowner",
    business_name: "",
    business_category: "",
    profile_photo_url: "",
    token_version: 0,
  });
  users.set(2, {
    id: 2,
    username: "Other User",
    email: "other@example.test",
    password_hash: await bcrypt.hash("OtherPass12", 10),
    role: "homeowner",
    account_type: "homeowner",
    business_name: "",
    business_category: "",
    profile_photo_url: "",
    token_version: 0,
  });
  const calls = [];

  return {
    calls,
    users,
    failPasswordSelect: false,
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ text: sql, values });

      if (sql.includes("SELECT id, email, role, token_version FROM users WHERE id = $1")) {
        const user = users.get(Number(values[0]));
        return { rows: user ? [user] : [] };
      }

      if (sql.includes("SELECT id, email, role, password_hash, token_version FROM users WHERE id = $1")) {
        if (this.failPasswordSelect) throw new Error("sensitive database detail");
        const user = users.get(Number(values[0]));
        return { rows: user ? [user] : [] };
      }

      if (sql.startsWith("UPDATE users SET password_hash")) {
        const [passwordHash, id, expectedHash] = values;
        const user = users.get(Number(id));
        if (!user || user.password_hash !== expectedHash) return { rows: [] };
        user.password_hash = passwordHash;
        user.token_version += 1;
        return { rows: [user] };
      }

      if (sql.includes("FROM users WHERE email = $1")) {
        const user = [...users.values()].find((candidate) => candidate.email === values[0]);
        return { rows: user ? [user] : [] };
      }

      if (sql.includes("FROM users WHERE id = $1 AND email = $2")) {
        const user = users.get(Number(values[0]));
        return { rows: user?.email === values[1] ? [user] : [] };
      }

      if (sql.includes("SELECT id, username, email, role, account_type") && sql.includes("WHERE id = $1")) {
        const user = users.get(Number(values[0]));
        return { rows: user ? [user] : [] };
      }

      if (sql === "SELECT id FROM users WHERE email = $1") {
        const user = [...users.values()].find((candidate) => candidate.email === values[0]);
        return { rows: user ? [{ id: user.id }] : [] };
      }

      if (sql.startsWith("INSERT INTO users")) {
        const id = Math.max(...users.keys()) + 1;
        const user = {
          id,
          username: values[0],
          email: values[1],
          password_hash: values[2],
          role: values[3],
          account_type: values[4],
          business_name: values[5],
          business_category: values[6],
          profile_photo_url: "",
          token_version: 0,
        };
        users.set(id, user);
        return { rows: [user] };
      }

      throw new Error(`Unexpected account-security query: ${sql}`);
    },
  };
}

function getRouteHandlers(method, routePath) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === routePath && item.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map((item) => item.handle);
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    setHeader() {},
    getHeader() { return undefined; },
  };
}

async function runMiddleware(handler, req, res) {
  if (handler.length < 3) {
    await handler(req, res);
    return;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    const returned = handler(req, res, finish);
    Promise.resolve(returned).then(() => {
      if (res.finished) finish();
    }, finish);
  });
}

async function invokeRoute(method, routePath, { pool, token, body = {}, locals = {} } = {}) {
  app.locals.pool = pool;
  Object.assign(app.locals, locals);
  const req = {
    app,
    body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    method: method.toUpperCase(),
    params: {},
  };
  const res = createResponse();

  try {
    for (const handler of getRouteHandlers(method, routePath)) {
      if (res.finished) break;
      await runMiddleware(handler, req, res);
    }
    return { status: res.statusCode, json: res.body };
  } finally {
    delete app.locals.pool;
    for (const key of Object.keys(locals)) delete app.locals[key];
  }
}

beforeEach(() => {
  Object.values(authRateLimiters).forEach((limiter) => limiter.clear());
  twoFactorChallengeStore.clear();
});

test("signup and password change enforce the same shared password policy", async () => {
  const pool = await createFakePool();
  const signup = await invokeRoute("post", "/auth/signup", {
    pool,
    body: { email: "new@example.test", password: "weakpassword" },
  });
  assert.equal(signup.status, 400);
  assert.equal(signup.json.code, "PASSWORD_POLICY_FAILED");
  assert.equal(signup.json.policyCode, "PASSWORD_REQUIRES_UPPERCASE");

  const passwordChange = await invokeRoute("post", "/auth/change-password", {
    pool,
    token: createToken(pool.users.get(1)),
    body: { currentPassword: "CurrentPass12", newPassword: "weakpassword" },
  });
  assert.equal(passwordChange.status, 400);
  assert.equal(passwordChange.json.policyCode, signup.json.policyCode);
});

test("valid signup remains compatible, hashes the password, and returns a sanitized user", async () => {
  const pool = await createFakePool();
  const signup = await invokeRoute("post", "/auth/signup", {
    pool,
    body: {
      username: "New User",
      email: "new@example.test",
      password: "ValidSignup12",
      account_type: "homeowner",
    },
  });

  assert.equal(signup.status, 200);
  assert.equal(signup.json.message, "User created");
  assert.equal(typeof signup.json.token, "string");
  assert.equal(Object.hasOwn(signup.json.user, "password_hash"), false);
  assert.equal(Object.hasOwn(signup.json.user, "token_version"), false);
  const stored = [...pool.users.values()].find((user) => user.email === "new@example.test");
  assert.ok(stored);
  assert.notEqual(stored.password_hash, "ValidSignup12");
  assert.equal(await bcrypt.compare("ValidSignup12", stored.password_hash), true);
});

test("password change rejects unauthenticated, missing, incorrect, reused, and weak requests", async () => {
  const pool = await createFakePool();
  const token = createToken(pool.users.get(1));

  const unauthenticated = await invokeRoute("post", "/auth/change-password", { pool });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.json.code, "AUTHENTICATION_REQUIRED");

  const missingCurrent = await invokeRoute("post", "/auth/change-password", {
    pool, token, body: { newPassword: "NewSecure12" },
  });
  assert.equal(missingCurrent.json.code, "CURRENT_PASSWORD_REQUIRED");

  const missingNew = await invokeRoute("post", "/auth/change-password", {
    pool, token, body: { currentPassword: "CurrentPass12" },
  });
  assert.equal(missingNew.json.code, "NEW_PASSWORD_REQUIRED");

  const incorrect = await invokeRoute("post", "/auth/change-password", {
    pool, token, body: { currentPassword: "WrongPass12", newPassword: "NewSecure12" },
  });
  assert.equal(incorrect.status, 401);
  assert.equal(incorrect.json.code, "CURRENT_PASSWORD_INCORRECT");

  const reused = await invokeRoute("post", "/auth/change-password", {
    pool, token, body: { currentPassword: "CurrentPass12", newPassword: "CurrentPass12" },
  });
  assert.equal(reused.status, 400);
  assert.equal(reused.json.code, "PASSWORD_REUSE_NOT_ALLOWED");
});

test("password change uses authenticated identity, stores bcrypt, invalidates old tokens, and returns a fresh token", async () => {
  const pool = await createFakePool();
  const firstUser = pool.users.get(1);
  const otherUser = pool.users.get(2);
  const oldToken = createToken(firstUser);
  const otherToken = createToken(otherUser);

  const changed = await invokeRoute("post", "/auth/change-password", {
    pool,
    token: oldToken,
    body: {
      userId: 2,
      email: otherUser.email,
      currentPassword: "CurrentPass12",
      newPassword: "NewSecure12",
    },
  });

  assert.equal(changed.status, 200);
  assert.equal(changed.json.success, true);
  assert.equal(changed.json.code, "PASSWORD_CHANGED");
  assert.equal(typeof changed.json.token, "string");
  assert.equal(Object.hasOwn(changed.json, "password_hash"), false);
  assert.equal(pool.users.get(2).token_version, 0);
  assert.equal(pool.users.get(1).token_version, 1);
  assert.notEqual(pool.users.get(1).password_hash, "NewSecure12");
  assert.equal(await bcrypt.compare("NewSecure12", pool.users.get(1).password_hash), true);
  assert.equal(jwt.decode(changed.json.token).tokenVersion, 1);

  const oldSession = await invokeRoute("get", "/auth/me", { pool, token: oldToken });
  assert.equal(oldSession.status, 401);
  assert.equal(oldSession.json.code, "SESSION_INVALID");

  const freshSession = await invokeRoute("get", "/auth/me", { pool, token: changed.json.token });
  assert.equal(freshSession.status, 200);
  assert.equal(freshSession.json.user.id, 1);

  const unaffectedSession = await invokeRoute("get", "/auth/me", { pool, token: otherToken });
  assert.equal(unaffectedSession.status, 200);
  assert.equal(unaffectedSession.json.user.id, 2);
});

test("login remains bcrypt-compatible and issues JWT only after verification", async () => {
  const pool = await createFakePool();
  pool.users.get(1).token_version = 4;
  let deliveredCode;
  const login = await invokeRoute("post", "/auth/login", {
    pool,
    body: { email: " PERSONAL@EXAMPLE.TEST ", password: "CurrentPass12" },
    locals: {
      emailDelivery: {
        async sendSecurityVerificationCode({ code }) {
          deliveredCode = code;
          return { accepted: true };
        },
      },
    },
  });

  assert.equal(login.status, 200);
  assert.equal(login.json.code, "VERIFICATION_REQUIRED");
  assert.equal(typeof login.json.challengeId, "string");
  assert.equal(Object.hasOwn(login.json, "token"), false);
  assert.equal(Object.hasOwn(login.json, "user"), false);

  const beforeVerification = await invokeRoute("get", "/auth/me", { pool });
  assert.equal(beforeVerification.status, 401);
  assert.equal(beforeVerification.json.code, "AUTHENTICATION_REQUIRED");

  const completed = await invokeRoute("post", "/auth/verify-code", {
    pool,
    body: {
      email: "personal@example.test",
      challengeId: login.json.challengeId,
      code: deliveredCode,
    },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.code, "AUTHENTICATION_COMPLETE");
  assert.equal(jwt.decode(completed.json.token).tokenVersion, 4);
  assert.equal(Object.hasOwn(completed.json.user, "password_hash"), false);

  const authenticated = await invokeRoute("get", "/auth/me", {
    pool,
    token: completed.json.token,
  });
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.json.user.id, 1);

  const passwordChanged = await invokeRoute("post", "/auth/change-password", {
    pool,
    token: completed.json.token,
    body: { currentPassword: "CurrentPass12", newPassword: "NewSecure12" },
  });
  assert.equal(passwordChanged.status, 200);
  const invalidated = await invokeRoute("get", "/auth/me", {
    pool,
    token: completed.json.token,
  });
  assert.equal(invalidated.status, 401);
  assert.equal(invalidated.json.code, "SESSION_INVALID");
});

test("verification fails closed when token version changes after password validation", async () => {
  const pool = await createFakePool();
  let deliveredCode;
  const login = await invokeRoute("post", "/auth/login", {
    pool,
    body: { email: "personal@example.test", password: "CurrentPass12" },
    locals: {
      emailDelivery: {
        async sendSecurityVerificationCode({ code }) {
          deliveredCode = code;
          return { accepted: true };
        },
      },
    },
  });

  pool.users.get(1).token_version += 1;
  const verification = await invokeRoute("post", "/auth/verify-code", {
    pool,
    body: {
      email: "personal@example.test",
      challengeId: login.json.challengeId,
      code: deliveredCode,
    },
  });

  assert.equal(verification.status, 401);
  assert.equal(verification.json.code, "SESSION_INVALID");
  assert.equal(Object.hasOwn(verification.json, "token"), false);
  assert.equal(twoFactorChallengeStore.size(), 0);
});

test("password database failures are normalized and repeated attempts are rate limited with safe keys", async () => {
  const pool = await createFakePool();
  const token = createToken(pool.users.get(1));
  pool.failPasswordSelect = true;
  const failure = await invokeRoute("post", "/auth/change-password", {
    pool, token, body: { currentPassword: "CurrentPass12", newPassword: "NewSecure12" },
  });
  assert.equal(failure.status, 500);
  assert.deepEqual(failure.json, {
    success: false,
    code: "PASSWORD_CHANGE_FAILED",
    message: "Password change could not be completed.",
  });

  pool.failPasswordSelect = false;
  authRateLimiters.passwordChangeRateLimiter.clear();
  let blocked;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    blocked = await invokeRoute("post", "/auth/change-password", {
      pool, token, body: { currentPassword: "WrongPass12", newPassword: "NewSecure12" },
    });
  }
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, "TOO_MANY_ATTEMPTS");
  assert.equal(authRateLimiters.passwordChangeRateLimiter.getKeys().some((key) => key.includes("WrongPass12")), false);
});

test("login and 2FA verification enforce their route-specific limits", async () => {
  const pool = await createFakePool();
  let loginResult;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    loginResult = await invokeRoute("post", "/auth/login", {
      pool,
      body: { email: "personal@example.test", password: "WrongPass12" },
    });
  }
  assert.equal(loginResult.status, 429);
  assert.equal(loginResult.json.code, "TOO_MANY_ATTEMPTS");

  let verificationResult;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    verificationResult = await invokeRoute("post", "/auth/verify-2fa-code", {
      pool,
      body: {
        email: "personal@example.test",
        challengeId: "unknown-challenge",
        code: "000000",
      },
    });
  }
  assert.equal(verificationResult.status, 429);
  assert.equal(verificationResult.json.code, "TOO_MANY_ATTEMPTS");
  const rateLimitKeys = Object.values(authRateLimiters).flatMap((limiter) => limiter.getKeys());
  assert.equal(rateLimitKeys.some((key) => key.includes("WrongPass12")), false);
  assert.equal(rateLimitKeys.some((key) => key.includes("000000")), false);
});

test("2FA delivery never exposes codes and verification is challenge-bound and single-use", async () => {
  const pool = await createFakePool();
  let delivered;
  const requested = await invokeRoute("post", "/auth/login", {
    pool,
    body: { email: "personal@example.test", password: "CurrentPass12" },
    locals: {
      emailDelivery: {
        async sendSecurityVerificationCode(payload) {
          delivered = payload;
          return { accepted: true };
        },
      },
    },
  });

  assert.equal(requested.status, 200);
  assert.equal(typeof requested.json.challengeId, "string");
  assert.equal(requested.json.code, "VERIFICATION_REQUIRED");
  assert.equal(requested.json.maskedEmail, "pe***@example.test");
  assert.equal(Object.hasOwn(requested.json, "token"), false);
  assert.doesNotMatch(String(requested.json.code), /^\d{6}$/);
  assert.equal(Object.hasOwn(requested.json, "devCode"), false);
  assert.equal(typeof delivered.code, "string");

  const fixedCode = await invokeRoute("post", "/auth/verify-2fa-code", {
    pool,
    body: { email: "personal@example.test", challengeId: requested.json.challengeId, code: "000000" },
  });
  assert.notEqual(fixedCode.status, 200);
  assert.equal(Object.hasOwn(fixedCode.json, "token"), false);

  const verified = await invokeRoute("post", "/auth/verify-2fa-code", {
    pool,
    body: { email: "personal@example.test", challengeId: requested.json.challengeId, code: delivered.code },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.code, "AUTHENTICATION_COMPLETE");
  assert.equal(typeof verified.json.token, "string");
  assert.equal(twoFactorChallengeStore.size(), 0);

  const replay = await invokeRoute("post", "/auth/verify-2fa-code", {
    pool,
    body: { email: "personal@example.test", challengeId: requested.json.challengeId, code: delivered.code },
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.code, "MISSING_CHALLENGE");
  assert.equal(Object.hasOwn(replay.json, "token"), false);
});

test("login delivery failure leaves no active challenge and a later retry can succeed", async () => {
  const pool = await createFakePool();
  let attemptedCode = "";
  const logEntries = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logEntries.push(values);
  let unavailable;
  try {
    unavailable = await invokeRoute("post", "/auth/login", {
      pool,
      body: { email: "personal@example.test", password: "CurrentPass12" },
      locals: {
        emailDelivery: {
          async sendSecurityVerificationCode({ code }) {
            attemptedCode = code;
            return { accepted: false, status: "provider_unavailable" };
          },
        },
      },
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.json, {
    success: false,
    code: "VERIFICATION_DELIVERY_UNAVAILABLE",
    message: "Verification code could not be sent. Please try again.",
  });
  assert.equal(Object.hasOwn(unavailable.json, "challengeId"), false);
  assert.equal(twoFactorChallengeStore.size(), 0);
  assert.match(attemptedCode, /^\d{6}$/);
  assert.equal(JSON.stringify(logEntries).includes(attemptedCode), false);
  assert.equal(JSON.stringify(logEntries).includes("personal@example.test"), false);

  const retry = await invokeRoute("post", "/auth/login", {
    pool,
    body: { email: "personal@example.test", password: "CurrentPass12" },
    locals: {
      emailDelivery: {
        async sendSecurityVerificationCode() {
          return { accepted: true };
        },
      },
    },
  });

  assert.equal(retry.status, 200);
  assert.equal(retry.json.code, "VERIFICATION_REQUIRED");
  assert.equal(Object.hasOwn(retry.json, "token"), false);
  assert.equal(twoFactorChallengeStore.size(), 1);
});

test("resend requires prior challenge context and enforces the send cooldown", async () => {
  const pool = await createFakePool();
  const delivery = {
    calls: 0,
    async sendSecurityVerificationCode() {
      this.calls += 1;
      return { accepted: true };
    },
  };
  const login = await invokeRoute("post", "/auth/login", {
    pool,
    body: { email: "personal@example.test", password: "CurrentPass12" },
    locals: { emailDelivery: delivery },
  });
  assert.equal(login.status, 200);
  assert.equal(delivery.calls, 1);

  const resend = await invokeRoute("post", "/auth/request-2fa-code", {
    pool,
    body: {
      email: "personal@example.test",
      challengeId: login.json.challengeId,
    },
    locals: { emailDelivery: delivery },
  });
  assert.equal(resend.status, 429);
  assert.equal(resend.json.code, "TOO_MANY_ATTEMPTS");
  assert.equal(delivery.calls, 1);

  const unrelated = await invokeRoute("post", "/auth/request-2fa-code", {
    pool,
    body: {
      email: "personal@example.test",
      challengeId: "forged-challenge",
    },
    locals: { emailDelivery: delivery },
  });
  assert.equal(unrelated.status, 202);
  assert.equal(unrelated.json.code, "TWO_FACTOR_REQUEST_ACCEPTED");
  assert.equal(delivery.calls, 1);
});

test("2FA management placeholders fail explicitly instead of reporting false success", async () => {
  const pool = await createFakePool();
  const token = createToken(pool.users.get(1));

  for (const [method, path] of [
    ["get", "/auth/security-status"],
    ["post", "/auth/enable-2fa"],
    ["post", "/auth/disable-2fa"],
  ]) {
    const result = await invokeRoute(method, path, { pool, token });
    assert.equal(result.status, 501);
    assert.equal(result.json.code, "TWO_FACTOR_MANAGEMENT_UNSUPPORTED");
    assert.equal(result.json.success, false);
  }
});
