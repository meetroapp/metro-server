"use strict";

const PASSWORD_MIN_LENGTH = 10;

const PASSWORD_POLICY_CODES = Object.freeze({
  REQUIRED: "PASSWORD_REQUIRED",
  TOO_SHORT: "PASSWORD_TOO_SHORT",
  REQUIRES_UPPERCASE: "PASSWORD_REQUIRES_UPPERCASE",
  REQUIRES_LOWERCASE: "PASSWORD_REQUIRES_LOWERCASE",
  REQUIRES_NUMBER: "PASSWORD_REQUIRES_NUMBER",
});

function validatePasswordPolicy(password) {
  const value = typeof password === "string" ? password : "";

  if (!value || !value.trim()) {
    return { valid: false, code: PASSWORD_POLICY_CODES.REQUIRED };
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return { valid: false, code: PASSWORD_POLICY_CODES.TOO_SHORT };
  }
  if (!/[A-Z]/.test(value)) {
    return { valid: false, code: PASSWORD_POLICY_CODES.REQUIRES_UPPERCASE };
  }
  if (!/[a-z]/.test(value)) {
    return { valid: false, code: PASSWORD_POLICY_CODES.REQUIRES_LOWERCASE };
  }
  if (!/[0-9]/.test(value)) {
    return { valid: false, code: PASSWORD_POLICY_CODES.REQUIRES_NUMBER };
  }

  return { valid: true, code: null };
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_CODES,
  validatePasswordPolicy,
};
