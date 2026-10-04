"use strict";

const COMPLIMENTARY_ACCESS_DEFINITIONS = Object.freeze({
  TESTFLIGHT_STARTER: Object.freeze({
    code: "TESTFLIGHT_STARTER",
    plan: "COMMUNITY_2_USER_MONTHLY",
    seatLimit: 2,
    grantReason: "TESTFLIGHT_TESTER",
    permanent: false,
  }),

  FULL_COMPLIMENTARY: Object.freeze({
    code: "FULL_COMPLIMENTARY",
    plan: "COMMUNITY_10_USER_MONTHLY",
    seatLimit: 10,
    grantReason: "BGONE_PERMANENT",
    permanent: true,
  }),
});

function definitionForComplimentaryGrantType(value) {
  const code =
    typeof value === "string"
      ? value.trim()
      : "";

  return COMPLIMENTARY_ACCESS_DEFINITIONS[code] || null;
}

function serializeComplimentaryAccess(row) {
  if (!row) return null;

  const definition =
    definitionForComplimentaryGrantType(row.grant_type);

  if (!definition) return null;

  if (
    String(row.effective_plan || "") !== definition.plan ||
    Number(row.seat_limit) !== definition.seatLimit ||
    String(row.grant_reason || "") !== definition.grantReason ||
    !row.granted_at
  ) {
    return null;
  }

  const revokedAt = row.revoked_at || null;

  return {
    source: "MEETRO_COMPLIMENTARY",
    status: revokedAt ? "REVOKED" : "ACTIVE",
    grantType: definition.code,
    plan: definition.plan,
    seatLimit: definition.seatLimit,
    grantReason: definition.grantReason,
    grantedAt: row.granted_at,
    revokedAt,
    permanent: definition.permanent,
    entitled: !revokedAt,
  };
}

async function loadActiveComplimentaryAccess(
  database,
  contractorProfileId
) {
  const businessId = Number(contractorProfileId);

  if (
    !database ||
    !Number.isSafeInteger(businessId) ||
    businessId <= 0
  ) {
    return null;
  }

  const result = await database.query(
    `SELECT
       id,
       contractor_profile_id,
       grant_type,
       effective_plan,
       seat_limit,
       grant_reason,
       granted_at,
       revoked_at,
       version
     FROM business_complimentary_access_grants
     WHERE contractor_profile_id = $1
       AND revoked_at IS NULL
     ORDER BY granted_at DESC, id DESC
     LIMIT 1`,
    [businessId]
  );

  return serializeComplimentaryAccess(
    result.rows[0] || null
  );
}

module.exports = {
  COMPLIMENTARY_ACCESS_DEFINITIONS,
  definitionForComplimentaryGrantType,
  loadActiveComplimentaryAccess,
  serializeComplimentaryAccess,
};
