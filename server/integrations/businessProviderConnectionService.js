"use strict";

const { getConnectedServicesBusinessAuthority } = require("./connectedServicesBusinessAuthority");
const { CONNECTED_SERVICE_PROVIDER, CONNECTED_SERVICE_STATUS } = require("./connectedServicesRegistry");
const repository = require("./businessProviderConnectionRepository");

const PROVIDERS = Object.freeze(Object.values(CONNECTED_SERVICE_PROVIDER));
const STATES = Object.freeze(Object.values(CONNECTED_SERVICE_STATUS).filter((state) => state !== "COMING_SOON"));
const ENVIRONMENTS = Object.freeze(["TEST", "LIVE"]);
const ACCOUNT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const failure = (status, code) => ({ ok: false, status, code, message: "Business provider connection authority is unavailable." });

function validAccount(provider, value) {
  return value === null || (typeof value === "string" && ACCOUNT_REFERENCE.test(value) &&
    !(provider === "STRIPE_PAYMENTS" && /^cus_/i.test(value)));
}

function normalizeConnection(provider, connection) {
  if (!connection || typeof connection !== "object" || Array.isArray(connection) ||
      Object.keys(connection).some((key) => !["providerAccountId", "status", "lastVerifiedAt"].includes(key))) return null;
  const providerAccountId = connection.providerAccountId ?? null;
  const status = connection.status;
  const verified = connection.lastVerifiedAt ?? null;
  if (!STATES.includes(status) || !validAccount(provider, providerAccountId) ||
      (verified !== null && (typeof verified !== "string" || !Number.isFinite(Date.parse(verified))))) return null;
  if (status === "CONNECTED" && (!providerAccountId || !verified)) return null;
  return { providerAccountId, status, lastVerifiedAt: verified === null ? null : new Date(verified).toISOString() };
}

function projectConnection(row, scope) {
  if (!row) return null;
  const normalized = normalizeConnection(scope.provider, {
    providerAccountId: row.provider_account_id,
    status: row.connection_status,
    lastVerifiedAt: row.last_verified_at instanceof Date ? row.last_verified_at.toISOString() : row.last_verified_at,
  });
  if (Number(row.contractor_profile_id) !== scope.businessId || row.provider !== scope.provider ||
      row.provider_environment !== scope.providerEnvironment || !normalized ||
      !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1) return null;
  return {
    id: row.id,
    businessId: scope.businessId,
    provider: row.provider,
    providerEnvironment: row.provider_environment,
    ...normalized,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function resolveScope({ pool, authenticatedActor, provider, providerEnvironment }) {
  const authority = await getConnectedServicesBusinessAuthority({ pool, authenticatedActor });
  if (!authority.ok) return authority;
  if (!PROVIDERS.includes(provider) || !ENVIRONMENTS.includes(providerEnvironment)) {
    return failure(400, "BUSINESS_PROVIDER_CONNECTION_INVALID_SCOPE");
  }
  return { ...authority, scope: { businessId: authority.business.businessId, provider, providerEnvironment } };
}

async function getBusinessProviderConnection(input = {}) {
  const authority = await resolveScope(input);
  if (!authority.ok) return authority;
  const row = await repository.findConnection(input.pool, authority.scope);
  const connection = projectConnection(row, authority.scope);
  if (row && !connection) return failure(503, "BUSINESS_PROVIDER_CONNECTION_INVALID_AUTHORITY");
  return { ok: true, status: 200, code: "BUSINESS_PROVIDER_CONNECTION_LOADED", business: authority.business, connection };
}

// Internal persistence seam only: no router imports or exposes this function.
// CONNECTED is a stored server assertion, not a provider/API readiness predicate.
// A later verified provider adapter and separate mutation-permission review are required.
async function recordBusinessProviderConnection(input = {}) {
  const authority = await resolveScope(input);
  if (!authority.ok) return authority;
  const connection = normalizeConnection(input.provider, input.connection);
  if (!connection || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return failure(400, "BUSINESS_PROVIDER_CONNECTION_INVALID_RECORD");
  }
  try {
    const row = input.expectedVersion === 0
      ? await repository.createConnection(input.pool, authority.scope, connection)
      : await repository.updateConnection(input.pool, authority.scope, connection, input.expectedVersion);
    if (!row) return failure(409, "BUSINESS_PROVIDER_CONNECTION_CONFLICT");
    const projected = projectConnection(row, authority.scope);
    if (!projected) return failure(503, "BUSINESS_PROVIDER_CONNECTION_INVALID_AUTHORITY");
    return { ok: true, status: 200, code: "BUSINESS_PROVIDER_CONNECTION_RECORDED", business: authority.business, connection: projected };
  } catch (error) {
    if (["23505", "23503", "23514", "P0001"].includes(error?.code)) {
      return failure(409, "BUSINESS_PROVIDER_CONNECTION_CONFLICT");
    }
    throw error;
  }
}

module.exports = { getBusinessProviderConnection, recordBusinessProviderConnection };
