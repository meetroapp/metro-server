"use strict";

const { createHash, randomBytes } = require("node:crypto");
const {
  entitledStatus,
  stagingQaAccess,
} = require("../subscriptions/subscriptionService");

const TEAM_ROLES = Object.freeze([
  "OWNER",
  "MANAGER",
  "BOOKKEEPER_FINANCE",
  "FIELD_EMPLOYEE",
]);
const INVITABLE_TEAM_ROLES = Object.freeze(TEAM_ROLES.filter((role) => role !== "OWNER"));
const ROLE_PERMISSIONS = Object.freeze({
  OWNER: Object.freeze([
    "TEAM_VIEW",
    "TEAM_INVITE",
    "TEAM_REVOKE_INVITATION",
    "TEAM_MANAGE_ROLES",
    "TEAM_DEACTIVATE",
  ]),
  MANAGER: Object.freeze([
    "TEAM_VIEW",
    "TEAM_INVITE",
    "TEAM_REVOKE_INVITATION",
    "TEAM_DEACTIVATE",
  ]),
  BOOKKEEPER_FINANCE: Object.freeze(["TEAM_SELF", "FINANCE_WORKSPACE"]),
  FIELD_EMPLOYEE: Object.freeze(["TEAM_SELF", "ASSIGNED_WORK"]),
});
const TRIAL_SEAT_LIMIT = 2;
const INVITATION_LIFETIME_DAYS = 7;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 320
    ? email
    : null;
}

function normalizeRole(value, { invitableOnly = false } = {}) {
  const role = String(value || "").trim().toUpperCase().replace(/[\s/]+/g, "_");
  const allowed = invitableOnly ? INVITABLE_TEAM_ROLES : TEAM_ROLES;
  return allowed.includes(role) ? role : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function permissionForRole(role, permission) {
  return (ROLE_PERMISSIONS[normalizeRole(role)] || []).includes(permission);
}

function digestInvitationToken(token) {
  const value = String(token || "").trim();
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(value)) return null;
  return createHash("sha256").update(value).digest("hex");
}

function serializeMembership(row = {}) {
  return {
    id: row.id,
    businessId: Number(row.contractor_profile_id),
    userId: Number(row.user_id),
    displayName: row.username || "",
    email: row.email || "",
    role: row.role,
    status: row.status,
    activatedAt: row.activated_at,
    deactivatedAt: row.deactivated_at,
    version: Number(row.version || 1),
  };
}

function serializeInvitation(row = {}, token = null) {
  const status = row.status === "PENDING" && new Date(row.expires_at).getTime() <= Date.now()
    ? "EXPIRED"
    : row.status;
  return {
    id: row.id,
    businessId: Number(row.contractor_profile_id),
    email: row.email_normalized,
    displayName: row.display_name || "",
    role: row.role,
    status,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    version: Number(row.version || 1),
    ...(token ? { token } : {}),
  };
}

async function withTransaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    if (result?.ok === false) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadActorMembership(database, userId, businessId = null) {
  const result = await database.query(
    `SELECT memberships.*, profiles.business_name, profiles.category
       FROM business_team_memberships memberships
       JOIN contractor_profiles profiles
         ON profiles.id = memberships.contractor_profile_id
      WHERE memberships.user_id = $1
        AND memberships.status = 'ACTIVE'
        AND ($2::integer IS NULL OR memberships.contractor_profile_id = $2)
      ORDER BY CASE memberships.role WHEN 'OWNER' THEN 0 ELSE 1 END,
               memberships.created_at ASC,
               memberships.id ASC`,
    [userId, businessId == null ? null : Number(businessId)]
  );
  if (result.rows.length === 0) return failure(403, "TEAM_MEMBERSHIP_REQUIRED", "An active business Team membership is required.");
  if (businessId == null && result.rows.length > 1) {
    return failure(409, "TEAM_BUSINESS_SELECTION_REQUIRED", "Choose the exact business Team to continue.");
  }
  return { ok: true, membership: result.rows[0] };
}

async function loadSeatAuthority(database, contractorProfileId, environment = process.env) {
  const result = await database.query(
    `SELECT subscriptions.status AS subscription_status,
            subscriptions.seat_limit,
            subscriptions.access_ends_at,
            trials.starts_at AS trial_starts_at,
            trials.ends_at AS trial_ends_at,
            trials.converted_at AS trial_converted_at
       FROM contractor_profiles profiles
       LEFT JOIN professional_subscriptions subscriptions
         ON subscriptions.contractor_profile_id = profiles.id
       LEFT JOIN meetro_business_trials trials
         ON trials.contractor_profile_id = profiles.id
      WHERE profiles.id = $1`,
    [contractorProfileId]
  );
  const row = result.rows[0];
  if (!row) return failure(404, "TEAM_BUSINESS_NOT_FOUND", "Business Team not found.");
  if (row.subscription_status && entitledStatus(row.subscription_status, row.access_ends_at)) {
    return { ok: true, source: "PAID_SUBSCRIPTION", seatLimit: Number(row.seat_limit) };
  }
  const now = Date.now();
  const trialActive = row.trial_starts_at && row.trial_ends_at && !row.trial_converted_at &&
    new Date(row.trial_starts_at).getTime() <= now && new Date(row.trial_ends_at).getTime() > now;
  if (trialActive) return { ok: true, source: "MEETRO_BUSINESS_TRIAL", seatLimit: TRIAL_SEAT_LIMIT };
  if (stagingQaAccess(environment, contractorProfileId)) {
    return { ok: true, source: "STAGING_QA", seatLimit: TRIAL_SEAT_LIMIT };
  }
  return failure(403, "TEAM_ENTITLEMENT_REQUIRED", "An active Meetro Business Trial or paid plan is required to add Team members.");
}

async function loadSeatUsage(database, contractorProfileId) {
  const result = await database.query(
    `SELECT
       (SELECT count(*)::integer
          FROM business_team_memberships
         WHERE contractor_profile_id = $1 AND status = 'ACTIVE') AS active_memberships,
       (SELECT count(*)::integer
          FROM business_team_invitations
         WHERE contractor_profile_id = $1
           AND status = 'PENDING'
           AND expires_at > CURRENT_TIMESTAMP) AS pending_invitations`,
    [contractorProfileId]
  );
  const row = result.rows[0] || {};
  const activeMemberships = Number(row.active_memberships || 0);
  const pendingInvitations = Number(row.pending_invitations || 0);
  return {
    activeMemberships,
    pendingInvitations,
    reservedSeats: activeMemberships + pendingInvitations,
  };
}

async function listTeam({ pool, authenticatedActor, businessId, environment = process.env }) {
  if (!pool || !Number.isSafeInteger(Number(authenticatedActor?.id))) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  }
  const normalizedBusinessId = businessId == null ? null : positiveInteger(businessId);
  if (businessId != null && !normalizedBusinessId) {
    return failure(400, "TEAM_BUSINESS_INVALID", "Business Team identity is invalid.");
  }
  const actor = await loadActorMembership(pool, Number(authenticatedActor.id), normalizedBusinessId);
  if (!actor.ok) return actor;
  if (!permissionForRole(actor.membership.role, "TEAM_VIEW")) {
    return failure(403, "TEAM_PERMISSION_REQUIRED", "Your Team role cannot view this workspace.");
  }
  const profileId = Number(actor.membership.contractor_profile_id);
  const [members, invitations, authority, usage] = await Promise.all([
    pool.query(
      `SELECT memberships.*, users.username, users.email
         FROM business_team_memberships memberships
         JOIN users ON users.id = memberships.user_id
        WHERE memberships.contractor_profile_id = $1
        ORDER BY CASE memberships.role WHEN 'OWNER' THEN 0 ELSE 1 END,
                 memberships.created_at ASC`,
      [profileId]
    ),
    pool.query(
      `SELECT * FROM business_team_invitations
        WHERE contractor_profile_id = $1
        ORDER BY created_at DESC`,
      [profileId]
    ),
    loadSeatAuthority(pool, profileId, environment),
    loadSeatUsage(pool, profileId),
  ]);
  return {
    ok: true,
    status: 200,
    code: "BUSINESS_TEAM_LOADED",
    business: {
      id: profileId,
      name: actor.membership.business_name || "",
      category: actor.membership.category || "",
    },
    actor: serializeMembership(actor.membership),
    permissions: [...(ROLE_PERMISSIONS[actor.membership.role] || [])],
    seatAuthority: authority.ok ? {
      source: authority.source,
      seatLimit: authority.seatLimit,
      ...usage,
      seatsAvailable: Math.max(0, authority.seatLimit - usage.reservedSeats),
    } : {
      source: "NONE",
      seatLimit: 0,
      ...usage,
      seatsAvailable: 0,
    },
    members: members.rows.map(serializeMembership),
    invitations: invitations.rows.map((row) => serializeInvitation(row)),
  };
}

async function inviteTeamMember({ pool, authenticatedActor, businessId, email, displayName, role, environment = process.env }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedEmail = normalizeEmail(email);
  const normalizedRole = normalizeRole(role, { invitableOnly: true });
  const normalizedName = String(displayName || "").trim();
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "TEAM_BUSINESS_INVALID", "Business Team identity is invalid.");
  if (!normalizedEmail || !normalizedRole || normalizedName.length > 160) {
    return failure(400, "TEAM_INVITATION_INVALID", "A valid email and preset Team role are required.");
  }
  return withTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor.ok) return actor;
    if (!permissionForRole(actor.membership.role, "TEAM_INVITE")) {
      return failure(403, "TEAM_PERMISSION_REQUIRED", "Your Team role cannot invite members.");
    }
    const profileId = Number(actor.membership.contractor_profile_id);
    await client.query("SELECT id FROM contractor_profiles WHERE id = $1 FOR UPDATE", [profileId]);
    await client.query(
      `UPDATE business_team_invitations
          SET status = 'EXPIRED'
        WHERE contractor_profile_id = $1 AND status = 'PENDING'
          AND expires_at <= CURRENT_TIMESTAMP`,
      [profileId]
    );
    const existingMember = await client.query(
      `SELECT memberships.status
         FROM users
         JOIN business_team_memberships memberships ON memberships.user_id = users.id
        WHERE lower(users.email) = $1 AND memberships.contractor_profile_id = $2`,
      [normalizedEmail, profileId]
    );
    if (existingMember.rows[0]) {
      return failure(409,
        existingMember.rows[0].status === "ACTIVE" ? "TEAM_MEMBER_ALREADY_EXISTS" : "TEAM_MEMBERSHIP_REACTIVATION_REQUIRES_REVIEW",
        existingMember.rows[0].status === "ACTIVE" ? "This person is already an active Team member." : "A deactivated historical membership requires governed review."
      );
    }
    const existingInvitation = await client.query(
      `SELECT id FROM business_team_invitations
        WHERE contractor_profile_id = $1 AND email_normalized = $2 AND status = 'PENDING'`,
      [profileId, normalizedEmail]
    );
    if (existingInvitation.rows[0]) {
      return failure(409, "TEAM_INVITATION_ALREADY_PENDING", "A pending invitation already reserves this seat.");
    }
    const authority = await loadSeatAuthority(client, profileId, environment);
    if (!authority.ok) return authority;
    const usage = await loadSeatUsage(client, profileId);
    if (usage.reservedSeats >= authority.seatLimit) {
      return failure(409, "TEAM_SEAT_LIMIT_REACHED", `All ${authority.seatLimit} professional seats are reserved or active.`);
    }
    const token = randomBytes(32).toString("base64url");
    const tokenDigest = digestInvitationToken(token);
    const result = await client.query(
      `INSERT INTO business_team_invitations
         (contractor_profile_id, email_normalized, display_name, role, token_digest,
          invited_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               CURRENT_TIMESTAMP + ($7::text || ' days')::interval)
       RETURNING *`,
      [profileId, normalizedEmail, normalizedName, normalizedRole, tokenDigest,
        actorId, String(INVITATION_LIFETIME_DAYS)]
    );
    return {
      ok: true,
      status: 201,
      code: "BUSINESS_TEAM_INVITATION_CREATED",
      invitation: serializeInvitation(result.rows[0], token),
      seatAuthority: {
        source: authority.source,
        seatLimit: authority.seatLimit,
        reservedSeats: usage.reservedSeats + 1,
        seatsAvailable: Math.max(0, authority.seatLimit - usage.reservedSeats - 1),
      },
    };
  });
}

async function acceptTeamInvitation({ pool, authenticatedActor, token }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const tokenDigest = digestInvitationToken(token);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!tokenDigest) {
    return failure(400, "TEAM_INVITATION_INVALID", "Invitation token is invalid.");
  }
  return withTransaction(pool, async (client) => {
    const identity = await client.query("SELECT id, email FROM users WHERE id = $1", [actorId]);
    if (!identity.rows[0]) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
    const invitationResult = await client.query(
      `SELECT * FROM business_team_invitations WHERE token_digest = $1 FOR UPDATE`,
      [tokenDigest]
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) return failure(404, "TEAM_INVITATION_NOT_FOUND", "Invitation not found.");
    if (invitation.status === "ACCEPTED" && Number(invitation.accepted_by_user_id) === actorId) {
      const replay = await client.query(
        `SELECT memberships.*, users.username, users.email
           FROM business_team_memberships memberships
           JOIN users ON users.id = memberships.user_id
          WHERE memberships.invitation_id = $1`,
        [invitation.id]
      );
      return { ok: true, status: 200, code: "BUSINESS_TEAM_INVITATION_ALREADY_ACCEPTED", membership: serializeMembership(replay.rows[0]) };
    }
    if (invitation.status !== "PENDING") {
      return failure(409, "TEAM_INVITATION_NOT_PENDING", "This invitation is no longer pending.");
    }
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE business_team_invitations SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'`,
        [invitation.id]
      );
      return failure(410, "TEAM_INVITATION_EXPIRED", "This invitation has expired.");
    }
    if (normalizeEmail(identity.rows[0].email) !== invitation.email_normalized) {
      return failure(403, "TEAM_INVITATION_IDENTITY_MISMATCH", "Sign in with the exact invited email address.");
    }
    const membership = await client.query(
      `INSERT INTO business_team_memberships
         (contractor_profile_id, user_id, invitation_id, role, status,
          activated_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'ACTIVE', CURRENT_TIMESTAMP, $5)
       ON CONFLICT (contractor_profile_id, user_id) DO NOTHING
       RETURNING *`,
      [invitation.contractor_profile_id, actorId, invitation.id,
        invitation.role, invitation.invited_by_user_id]
    );
    if (!membership.rows[0]) {
      return failure(409, "TEAM_MEMBERSHIP_REACTIVATION_REQUIRES_REVIEW", "An existing Team membership requires governed review.");
    }
    await client.query(
      `UPDATE business_team_invitations
          SET status = 'ACCEPTED', accepted_by_user_id = $2, accepted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'PENDING'`,
      [invitation.id, actorId]
    );
    return {
      ok: true,
      status: 200,
      code: "BUSINESS_TEAM_INVITATION_ACCEPTED",
      membership: serializeMembership({ ...membership.rows[0], ...identity.rows[0] }),
    };
  });
}

async function revokeTeamInvitation({ pool, authenticatedActor, businessId, invitationId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedInvitationId = uuid(invitationId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedInvitationId) return failure(400, "TEAM_INVITATION_INVALID", "Invitation identity is invalid.");
  return withTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor.ok) return actor;
    if (!permissionForRole(actor.membership.role, "TEAM_REVOKE_INVITATION")) {
      return failure(403, "TEAM_PERMISSION_REQUIRED", "Your Team role cannot revoke invitations.");
    }
    const result = await client.query(
      `UPDATE business_team_invitations
          SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND contractor_profile_id = $2 AND status = 'PENDING'
        RETURNING *`,
      [normalizedInvitationId, actor.membership.contractor_profile_id]
    );
    if (!result.rows[0]) return failure(404, "TEAM_INVITATION_NOT_FOUND", "Pending invitation not found.");
    return { ok: true, status: 200, code: "BUSINESS_TEAM_INVITATION_REVOKED", invitation: serializeInvitation(result.rows[0]) };
  });
}

async function updateTeamMemberRole({ pool, authenticatedActor, businessId, membershipId, role }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedMembershipId = uuid(membershipId);
  const normalizedRole = normalizeRole(role, { invitableOnly: true });
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedMembershipId) return failure(400, "TEAM_MEMBER_INVALID", "Team member identity is invalid.");
  if (!normalizedRole) return failure(400, "TEAM_ROLE_INVALID", "Choose a supported Team role.");
  return withTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor.ok) return actor;
    if (!permissionForRole(actor.membership.role, "TEAM_MANAGE_ROLES")) {
      return failure(403, "TEAM_PERMISSION_REQUIRED", "Only the business owner can change Team roles.");
    }
    const result = await client.query(
      `UPDATE business_team_memberships
          SET role = $1
        WHERE id = $2 AND contractor_profile_id = $3
          AND status = 'ACTIVE' AND role <> 'OWNER'
        RETURNING *`,
      [normalizedRole, normalizedMembershipId, actor.membership.contractor_profile_id]
    );
    if (!result.rows[0]) return failure(404, "TEAM_MEMBER_NOT_FOUND", "Active Team member not found.");
    const identity = await client.query("SELECT username, email FROM users WHERE id = $1", [result.rows[0].user_id]);
    return { ok: true, status: 200, code: "BUSINESS_TEAM_ROLE_UPDATED", membership: serializeMembership({ ...result.rows[0], ...identity.rows[0] }) };
  });
}

async function deactivateTeamMember({ pool, authenticatedActor, businessId, membershipId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedMembershipId = uuid(membershipId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedMembershipId) return failure(400, "TEAM_MEMBER_INVALID", "Team member identity is invalid.");
  return withTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor.ok) return actor;
    if (!permissionForRole(actor.membership.role, "TEAM_DEACTIVATE")) {
      return failure(403, "TEAM_PERMISSION_REQUIRED", "Your Team role cannot deactivate members.");
    }
    const target = await client.query(
      `SELECT * FROM business_team_memberships
        WHERE id = $1 AND contractor_profile_id = $2 FOR UPDATE`,
      [normalizedMembershipId, actor.membership.contractor_profile_id]
    );
    const member = target.rows[0];
    if (!member || member.status !== "ACTIVE") return failure(404, "TEAM_MEMBER_NOT_FOUND", "Active Team member not found.");
    if (member.role === "OWNER" || Number(member.user_id) === actorId) {
      return failure(409, "TEAM_OWNER_OR_SELF_DEACTIVATION_FORBIDDEN", "The owner and current actor cannot be deactivated here.");
    }
    if (actor.membership.role === "MANAGER" && member.role === "MANAGER") {
      return failure(403, "TEAM_PERMISSION_REQUIRED", "Managers cannot deactivate another manager.");
    }
    const result = await client.query(
      `UPDATE business_team_memberships
          SET status = 'DEACTIVATED', deactivated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'ACTIVE'
        RETURNING *`,
      [normalizedMembershipId]
    );
    const identity = await client.query("SELECT username, email FROM users WHERE id = $1", [result.rows[0].user_id]);
    return { ok: true, status: 200, code: "BUSINESS_TEAM_MEMBER_DEACTIVATED", membership: serializeMembership({ ...result.rows[0], ...identity.rows[0] }) };
  });
}

async function getMyTeamAuthority({ pool, authenticatedActor }) {
  if (!pool || !Number.isSafeInteger(Number(authenticatedActor?.id))) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  }
  const identity = await pool.query("SELECT id, email FROM users WHERE id = $1", [Number(authenticatedActor.id)]);
  if (!identity.rows[0]) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  const [memberships, invitations] = await Promise.all([
    pool.query(
      `SELECT memberships.*, users.username, users.email,
              profiles.business_name, profiles.category
         FROM business_team_memberships memberships
         JOIN users ON users.id = memberships.user_id
         JOIN contractor_profiles profiles ON profiles.id = memberships.contractor_profile_id
        WHERE memberships.user_id = $1
        ORDER BY memberships.created_at ASC`,
      [Number(authenticatedActor.id)]
    ),
    pool.query(
      `SELECT * FROM business_team_invitations
        WHERE email_normalized = $1 AND status = 'PENDING'
          AND expires_at > CURRENT_TIMESTAMP
        ORDER BY created_at DESC`,
      [normalizeEmail(identity.rows[0].email)]
    ),
  ]);
  return {
    ok: true,
    status: 200,
    code: "BUSINESS_TEAM_AUTHORITY_LOADED",
    memberships: memberships.rows.map((row) => ({
      ...serializeMembership(row),
      businessName: row.business_name || "",
      businessCategory: row.category || "",
      permissions: [...(ROLE_PERMISSIONS[row.role] || [])],
    })),
    pendingInvitations: invitations.rows.map((row) => serializeInvitation(row)),
  };
}

module.exports = {
  INVITABLE_TEAM_ROLES,
  INVITATION_LIFETIME_DAYS,
  ROLE_PERMISSIONS,
  TEAM_ROLES,
  TRIAL_SEAT_LIMIT,
  acceptTeamInvitation,
  deactivateTeamMember,
  digestInvitationToken,
  getMyTeamAuthority,
  inviteTeamMember,
  listTeam,
  normalizeEmail,
  normalizeRole,
  permissionForRole,
  revokeTeamInvitation,
  updateTeamMemberRole,
};
