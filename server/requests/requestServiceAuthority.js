"use strict";

const REQUEST_SERVICE_AUTHORITY = "request_service";
const REQUEST_SERVICE_ACCOUNT_TYPES = Object.freeze([
  "homeowner",
  "professional",
]);

function normalizeString(value) {
  return String(value || "").trim().toLowerCase();
}

function deriveRequestServiceAuthority(user = {}) {
  const accountType = normalizeString(
    user.account_type || user.accountType
  );
  const role = normalizeString(user.role);
  const legacyHomeowner = !accountType && role === "homeowner";
  const authorized =
    REQUEST_SERVICE_ACCOUNT_TYPES.includes(accountType) ||
    legacyHomeowner;

  return Object.freeze({
    authorized,
    authority: authorized ? REQUEST_SERVICE_AUTHORITY : null,
    accountType: authorized
      ? accountType || "homeowner"
      : accountType || null,
  });
}

async function resolveRequestServiceAuthority({
  pool,
  actorUserId,
} = {}) {
  const normalizedActorUserId = Number(actorUserId);
  if (
    !Number.isInteger(normalizedActorUserId) ||
    normalizedActorUserId <= 0 ||
    !pool ||
    typeof pool.query !== "function"
  ) {
    return deriveRequestServiceAuthority();
  }

  const result = await pool.query(
    `
    /* request_service_authority:authenticated_account */
    SELECT id, role, account_type
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [normalizedActorUserId]
  );
  const user = result.rows[0];
  if (!user || Number(user.id) !== normalizedActorUserId) {
    return deriveRequestServiceAuthority();
  }

  return deriveRequestServiceAuthority(user);
}

module.exports = {
  REQUEST_SERVICE_ACCOUNT_TYPES,
  REQUEST_SERVICE_AUTHORITY,
  deriveRequestServiceAuthority,
  resolveRequestServiceAuthority,
};
