"use strict";

function createAuthRateLimiter({
  windowMs,
  maxAttempts,
  keyResolver,
  now = () => Date.now(),
  maxEntries = 5000,
  limitResponse,
} = {}) {
  if (!(windowMs > 0) || !(maxAttempts > 0) || typeof keyResolver !== "function") {
    throw new Error("A bounded auth rate-limit configuration is required.");
  }

  const attempts = new Map();

  function prune(currentTime) {
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= currentTime) attempts.delete(key);
    }

    while (attempts.size >= maxEntries) {
      attempts.delete(attempts.keys().next().value);
    }
  }

  function middleware(req, res, next) {
    const currentTime = now();
    prune(currentTime);
    const key = String(keyResolver(req) || "anonymous");
    const current = attempts.get(key);
    const entry = !current || current.resetAt <= currentTime
      ? { count: 0, resetAt: currentTime + windowMs }
      : current;

    entry.count += 1;
    attempts.set(key, entry);

    if (entry.count > maxAttempts) {
      if (typeof limitResponse === "function") {
        return limitResponse(req, res, entry);
      }
      return res.status(429).json({
        success: false,
        code: "TOO_MANY_ATTEMPTS",
        message: "Try again later.",
      });
    }

    next();
  }

  middleware.clear = () => attempts.clear();
  middleware.getKeys = () => [...attempts.keys()];

  return middleware;
}

module.exports = { createAuthRateLimiter };
