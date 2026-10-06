"use strict";

const CONNECTED_SERVICES_READ_ROLES = Object.freeze(["OWNER", "MANAGER"]);

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function loadBusinessAuthority(database, userId) {
  const result = await database.query(
    `SELECT memberships.contractor_profile_id,
            memberships.role,
            profiles.business_name
       FROM business_team_memberships memberships
       JOIN contractor_profiles profiles
         ON profiles.id = memberships.contractor_profile_id
      WHERE memberships.user_id = $1
        AND memberships.status = 'ACTIVE'
        AND memberships.role IN ('OWNER', 'MANAGER')
      ORDER BY CASE memberships.role WHEN 'OWNER' THEN 0 ELSE 1 END,
               memberships.created_at ASC,
               memberships.id ASC
      LIMIT 2`,
    [userId]
  );

  if (result.rows.length === 0) {
    return failure(
      403,
      "CONNECTED_SERVICES_BUSINESS_AUTHORITY_REQUIRED",
      "Owner or Manager authority in an active Business is required."
    );
  }

  if (result.rows.length > 1) {
    return failure(
      409,
      "CONNECTED_SERVICES_BUSINESS_SELECTION_REQUIRED",
      "Choose the exact Business before viewing Connected Services."
    );
  }

  return { ok: true, membership: result.rows[0] };
}

async function getConnectedServicesBusinessAuthority({ pool, authenticatedActor } = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);

  if (!pool || typeof pool.query !== "function" || !actorUserId) {
    return failure(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication required."
    );
  }

  const authority = await loadBusinessAuthority(pool, actorUserId);
  if (!authority.ok) return authority;

  const businessId = positiveInteger(
    authority.membership.contractor_profile_id
  );

  if (
    !businessId ||
    !CONNECTED_SERVICES_READ_ROLES.includes(authority.membership.role)
  ) {
    return failure(
      403,
      "CONNECTED_SERVICES_BUSINESS_AUTHORITY_REQUIRED",
      "Owner or Manager authority in an active Business is required."
    );
  }

  return {
    ok: true,
    status: 200,
    business: {
      businessId,
      displayName:
        String(authority.membership.business_name || "").trim() ||
        "Business",
      role: authority.membership.role,
    },
  };
}

module.exports = {
  CONNECTED_SERVICES_READ_ROLES,
  getConnectedServicesBusinessAuthority,
  connectedServicesBusinessAuthorityInternals: Object.freeze({
    loadBusinessAuthority,
    positiveInteger,
  }),
};
