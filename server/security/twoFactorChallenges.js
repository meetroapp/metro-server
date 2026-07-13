"use strict";

const crypto = require("node:crypto");

const TWO_FACTOR_FAILURE = Object.freeze({
  MISSING_CHALLENGE: "MISSING_CHALLENGE",
  CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
  CHALLENGE_USED: "CHALLENGE_USED",
  ACCOUNT_MISMATCH: "CHALLENGE_ACCOUNT_MISMATCH",
  INVALID_CODE: "INVALID_CODE",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
  SEND_COOLDOWN: "SEND_COOLDOWN",
  SEND_LIMIT_REACHED: "SEND_LIMIT_REACHED",
});

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function hashCode(code, salt) {
  return crypto.scryptSync(String(code), salt, 32);
}

function createTwoFactorChallengeStore({
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
  maxAttempts = 5,
  maxEntries = 5000,
  sendCooldownMs = 60 * 1000,
  sendWindowMs = 15 * 60 * 1000,
  maxSendsPerWindow = 5,
  codeGenerator = () => crypto.randomInt(100000, 1000000).toString(),
  idGenerator = () => crypto.randomUUID(),
} = {}) {
  const challenges = new Map();
  const pendingDeliveries = new Map();
  const successfulSends = new Map();

  function cleanup(currentTime = now()) {
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt + ttlMs <= currentTime) challenges.delete(id);
    }
    while (challenges.size >= maxEntries) {
      challenges.delete(challenges.keys().next().value);
    }
    for (const [identity, timestamps] of successfulSends) {
      const active = timestamps.filter((timestamp) => timestamp + sendWindowMs > currentTime);
      if (active.length) successfulSends.set(identity, active);
      else successfulSends.delete(identity);
    }
  }

  function getSendAvailability(identity) {
    const normalizedIdentity = normalizeIdentity(identity);
    if (!normalizedIdentity) throw new Error("Challenge identity is required.");

    const currentTime = now();
    cleanup(currentTime);
    const timestamps = successfulSends.get(normalizedIdentity) || [];
    const lastSentAt = timestamps.at(-1);

    if (pendingDeliveries.has(normalizedIdentity)) {
      return { ok: false, code: TWO_FACTOR_FAILURE.SEND_COOLDOWN, retryAfterSeconds: 60 };
    }
    if (lastSentAt !== undefined && lastSentAt + sendCooldownMs > currentTime) {
      return {
        ok: false,
        code: TWO_FACTOR_FAILURE.SEND_COOLDOWN,
        retryAfterSeconds: Math.ceil((lastSentAt + sendCooldownMs - currentTime) / 1000),
      };
    }
    if (timestamps.length >= maxSendsPerWindow) {
      return {
        ok: false,
        code: TWO_FACTOR_FAILURE.SEND_LIMIT_REACHED,
        retryAfterSeconds: Math.ceil((timestamps[0] + sendWindowMs - currentTime) / 1000),
      };
    }
    return { ok: true };
  }

  function prepare(identity, { accountId } = {}) {
    const normalizedIdentity = normalizeIdentity(identity);
    const availability = getSendAvailability(normalizedIdentity);
    if (!availability.ok) return availability;

    const rawCode = codeGenerator();
    const salt = crypto.randomBytes(16);
    const createdAt = now();
    const prepared = {
      challengeId: idGenerator(),
      identity: normalizedIdentity,
      accountId: accountId ?? null,
      codeHash: hashCode(rawCode, salt),
      salt,
      createdAt,
      expiresAt: createdAt + ttlMs,
      attemptsRemaining: maxAttempts,
      consumedAt: null,
      deliveryCode: rawCode,
    };
    pendingDeliveries.set(normalizedIdentity, prepared.challengeId);

    return { ok: true, ...prepared };
  }

  function cancel(prepared) {
    if (!prepared) return;
    if (pendingDeliveries.get(prepared.identity) === prepared.challengeId) {
      pendingDeliveries.delete(prepared.identity);
    }
    delete prepared.deliveryCode;
  }

  function activate(prepared) {
    if (!prepared || pendingDeliveries.get(prepared.identity) !== prepared.challengeId) {
      return { ok: false, code: TWO_FACTOR_FAILURE.MISSING_CHALLENGE };
    }

    for (const [id, challenge] of challenges) {
      if (challenge.identity === prepared.identity && !challenge.consumedAt) challenges.delete(id);
    }

    const { deliveryCode, ok, ...storedChallenge } = prepared;
    delete prepared.deliveryCode;
    void deliveryCode;
    void ok;
    challenges.set(storedChallenge.challengeId, storedChallenge);
    pendingDeliveries.delete(prepared.identity);
    successfulSends.set(prepared.identity, [
      ...(successfulSends.get(prepared.identity) || []),
      now(),
    ]);

    return {
      ok: true,
      challengeId: storedChallenge.challengeId,
      expiresAt: storedChallenge.expiresAt,
    };
  }

  function issue(identity, options) {
    const prepared = prepare(identity, options);
    if (!prepared.ok) return prepared;
    const deliveryCode = prepared.deliveryCode;
    const activated = activate(prepared);
    return { ...activated, deliveryCode };
  }

  function remove(challengeId) {
    challenges.delete(String(challengeId || ""));
  }

  function verify({ challengeId, identity, code }) {
    const challenge = challenges.get(String(challengeId || ""));
    if (!challenge) return { ok: false, code: TWO_FACTOR_FAILURE.MISSING_CHALLENGE };
    if (challenge.consumedAt) return { ok: false, code: TWO_FACTOR_FAILURE.CHALLENGE_USED };
    if (challenge.expiresAt <= now()) {
      return { ok: false, code: TWO_FACTOR_FAILURE.CHALLENGE_EXPIRED };
    }
    if (challenge.attemptsRemaining <= 0) {
      return { ok: false, code: TWO_FACTOR_FAILURE.TOO_MANY_ATTEMPTS };
    }
    if (challenge.identity !== normalizeIdentity(identity)) {
      challenge.attemptsRemaining -= 1;
      return { ok: false, code: TWO_FACTOR_FAILURE.ACCOUNT_MISMATCH };
    }

    const candidate = hashCode(String(code || ""), challenge.salt);
    if (!crypto.timingSafeEqual(candidate, challenge.codeHash)) {
      challenge.attemptsRemaining -= 1;
      return {
        ok: false,
        code: challenge.attemptsRemaining <= 0
          ? TWO_FACTOR_FAILURE.TOO_MANY_ATTEMPTS
          : TWO_FACTOR_FAILURE.INVALID_CODE,
        attemptsRemaining: challenge.attemptsRemaining,
      };
    }

    challenge.consumedAt = now();
    return { ok: true, code: "CODE_VERIFIED" };
  }

  function isActiveForIdentity({ challengeId, identity }) {
    const challenge = challenges.get(String(challengeId || ""));
    return Boolean(
      challenge &&
      !challenge.consumedAt &&
      challenge.expiresAt > now() &&
      challenge.identity === normalizeIdentity(identity)
    );
  }

  return {
    activate,
    cancel,
    clear() {
      challenges.clear();
      pendingDeliveries.clear();
      successfulSends.clear();
    },
    getSendAvailability,
    hasStoredPlaintextCode: () => [...challenges.values()].some(
      (challenge) => Object.hasOwn(challenge, "deliveryCode") || Object.hasOwn(challenge, "code")
    ),
    issue,
    isActiveForIdentity,
    prepare,
    remove,
    size: () => challenges.size,
    verify,
  };
}

module.exports = {
  TWO_FACTOR_FAILURE,
  createTwoFactorChallengeStore,
  normalizeIdentity,
};
