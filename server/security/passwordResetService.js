"use strict";

const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const { validatePasswordPolicy } = require("./passwordPolicy");

const RESET_EXPIRY_MINUTES = 30;
const RESET_EXPIRY_MS = RESET_EXPIRY_MINUTES * 60 * 1000;
const RESET_SEND_COOLDOWN_MS = 60 * 1000;
const GENERIC_REQUEST_RESPONSE = Object.freeze({
  success: true,
  code: "PASSWORD_RESET_REQUEST_ACCEPTED",
  message: "If an account matches that email, password reset instructions will be sent.",
});

class ResetFailure extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function generateResetToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getAllowedPasswordResetHosts(env = process.env) {
  const configuredHosts = String(env.PASSWORD_RESET_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  return new Set(configuredHosts);
}

function resolvePasswordResetWebUrl(env = process.env) {
  const raw = String(env.PASSWORD_RESET_WEB_URL || "").trim();
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    const meetroHost = hostname === "getmeetro.com" || hostname.endsWith(".getmeetro.com");
    const explicitlyAllowedHost = getAllowedPasswordResetHosts(env).has(hostname);
    const localDevelopment = env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !localDevelopment) ||
      (!meetroHost && !explicitlyAllowedHost && !localDevelopment) ||
      url.username || url.password || url.search || url.hash
    ) {
      return { configured: false };
    }
    return { configured: true, url: url.toString() };
  } catch {
    return { configured: false };
  }
}

function buildResetUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

async function withTransaction(pool, operation) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

function createPasswordResetService({
  pool,
  emailDelivery,
  env = process.env,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  bcryptImpl = bcrypt,
  logger = () => {},
} = {}) {
  async function request(emailInput) {
    const email = normalizeEmail(emailInput);
    try {
      const accountResult = await pool.query(
        "SELECT id, email FROM users WHERE email = $1",
        [email]
      );
      const account = accountResult.rows[0];
      if (!account) return { ...GENERIC_REQUEST_RESPONSE };

      const webUrl = resolvePasswordResetWebUrl(env);
      if (!webUrl.configured) {
        logger("password_reset_request", "CONFIGURATION_UNAVAILABLE", account.id);
        return { ...GENERIC_REQUEST_RESPONSE };
      }

      const recent = await pool.query(
        `SELECT created_at FROM password_reset_tokens
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [account.id]
      );
      const lastCreated = recent.rows[0]?.created_at
        ? new Date(recent.rows[0].created_at).getTime()
        : 0;
      if (lastCreated && now().getTime() - lastCreated < RESET_SEND_COOLDOWN_MS) {
        return { ...GENERIC_REQUEST_RESPONSE };
      }

      const rawToken = generateResetToken(randomBytes);
      const tokenHash = hashResetToken(rawToken);
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + RESET_EXPIRY_MS);

      await withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE password_reset_tokens SET revoked_at = $2
           WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
          [account.id, createdAt]
        );
        await client.query(
          `INSERT INTO password_reset_tokens
           (user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4)`,
          [account.id, tokenHash, expiresAt, createdAt]
        );
      });

      const delivery = await emailDelivery.sendPasswordResetEmail({
        recipientEmail: account.email,
        resetUrl: buildResetUrl(webUrl.url, rawToken),
        expiresInMinutes: RESET_EXPIRY_MINUTES,
      });
      if (!delivery?.accepted) {
        await pool.query(
          `UPDATE password_reset_tokens SET revoked_at = $2
           WHERE token_hash = $1 AND used_at IS NULL`,
          [tokenHash, now()]
        );
        logger("password_reset_request", "DELIVERY_UNAVAILABLE", account.id);
      }
    } catch {
      logger("password_reset_request", "REQUEST_FAILED");
    }
    return { ...GENERIC_REQUEST_RESPONSE };
  }

  async function complete({ token, newPassword } = {}) {
    if (!String(token || "").trim()) {
      return { ok: false, status: 400, code: "RESET_TOKEN_REQUIRED" };
    }
    if (!String(newPassword || "").trim()) {
      return { ok: false, status: 400, code: "NEW_PASSWORD_REQUIRED" };
    }
    const policy = validatePasswordPolicy(newPassword);
    if (!policy.valid) {
      return { ok: false, status: 400, code: "PASSWORD_POLICY_FAILED", policyCode: policy.code };
    }

    const tokenHash = hashResetToken(token);
    try {
      await withTransaction(pool, async (client) => {
        const tokenResult = await client.query(
          `SELECT id, user_id, expires_at, used_at, revoked_at
           FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE`,
          [tokenHash]
        );
        const record = tokenResult.rows[0];
        if (!record) throw new ResetFailure("RESET_TOKEN_INVALID");
        if (record.used_at) throw new ResetFailure("RESET_TOKEN_USED");
        if (record.revoked_at) throw new ResetFailure("RESET_TOKEN_INVALID");
        if (new Date(record.expires_at).getTime() <= now().getTime()) {
          throw new ResetFailure("RESET_TOKEN_EXPIRED", 410);
        }

        const userResult = await client.query(
          "SELECT id, password_hash FROM users WHERE id = $1 FOR UPDATE",
          [record.user_id]
        );
        const user = userResult.rows[0];
        if (!user) throw new ResetFailure("RESET_TOKEN_INVALID");
        if (await bcryptImpl.compare(newPassword, user.password_hash)) {
          throw new ResetFailure("PASSWORD_REUSE_NOT_ALLOWED");
        }

        const passwordHash = await bcryptImpl.hash(newPassword, 10);
        const updated = await client.query(
          `UPDATE users SET password_hash = $1, token_version = token_version + 1
           WHERE id = $2 RETURNING id, token_version`,
          [passwordHash, user.id]
        );
        if (!updated.rows[0]) throw new Error("Password update failed");

        const consumed = await client.query(
          `UPDATE password_reset_tokens SET used_at = $2
           WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
          [record.id, now()]
        );
        if (!consumed.rows[0]) throw new ResetFailure("RESET_TOKEN_USED");
        await client.query(
          `UPDATE password_reset_tokens SET revoked_at = $2
           WHERE user_id = $1 AND id <> $3 AND used_at IS NULL AND revoked_at IS NULL`,
          [record.user_id, now(), record.id]
        );
      });
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          code: "PASSWORD_RESET_COMPLETE",
          message: "Your password has been reset. Please sign in.",
        },
      };
    } catch (error) {
      if (error instanceof ResetFailure) {
        return { ok: false, status: error.status, code: error.code };
      }
      logger("password_reset_complete", "PASSWORD_RESET_FAILED");
      return { ok: false, status: 500, code: "PASSWORD_RESET_FAILED" };
    }
  }

  return Object.freeze({ complete, request });
}

module.exports = {
  GENERIC_REQUEST_RESPONSE,
  RESET_EXPIRY_MINUTES,
  buildResetUrl,
  createPasswordResetService,
  generateResetToken,
  getAllowedPasswordResetHosts,
  hashResetToken,
  normalizeEmail,
  resolvePasswordResetWebUrl,
};
