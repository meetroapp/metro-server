"use strict";

function resolveJwtSecret(env = process.env) {
  const secret = String(env.JWT_SECRET || "").trim();

  if (!secret) {
    throw new Error("JWT_SECRET is required.");
  }

  return secret;
}

module.exports = { resolveJwtSecret };
