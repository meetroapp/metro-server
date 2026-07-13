"use strict";

const crypto = require("node:crypto");

const TWO_FACTOR_FAILURE = Object.freeze({
  MISSING_CHALLENGE: "MISSING_CHALLENGE",
  CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
  CHALLENGE_USED: "CHALLENGE_USED",
  ACCOUNT_MISMATCH: "CHALLENGE_ACCOUNT_MISMATCH",
  INVALID_CODE: "INVALID_CODE",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
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
  codeGenerator = () => crypto.randomInt(100000, 1000000).toString(),
  idGenerator = () => crypto.randomUUID(),
} = {}) {
  const challenges = new Map();

  function cleanup(currentTime = now()) {
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt + ttlMs <= currentTime) challenges.delete(id);
    }
    while (challenges.size >= maxEntries) {
      challenges.delete(challenges.keys().next().value);
    }
  }

  function issue(identity) {
    const normalizedIdentity = normalizeIdentity(identity);
    if (!normalizedIdentity) throw new Error("Challenge identity is required.");

    cleanup();
    const rawCode = codeGenerator();
    const salt = crypto.randomBytes(16);
    const createdAt = now();
    const challenge = {
      challengeId: idGenerator(),
      identity: normalizedIdentity,
      codeHash: hashCode(rawCode, salt),
      salt,
      createdAt,
      expiresAt: createdAt + ttlMs,
      attemptsRemaining: maxAttempts,
      consumedAt: null,
    };
    challenges.set(challenge.challengeId, challenge);

    return {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      deliveryCode: rawCode,
    };
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

  return {
    clear: () => challenges.clear(),
    issue,
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
