"use strict";

const { permissionForRole } = require("./teamService");

const WEEK_START_DAYS = Object.freeze([
  "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY",
]);

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeWeekStartDay(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return WEEK_START_DAYS.includes(normalized) ? normalized : null;
}

function normalizeTimeZone(value) {
  const submitted = String(value || "").trim();
  if (submitted.length < 3 || submitted.length > 100 || !submitted.includes("/") || /[\u0000-\u001f\u007f]/.test(submitted)) {
    return null;
  }
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: submitted })
      .resolvedOptions().timeZone;
    if (!canonical) return null;
    return canonical.includes("/") ? canonical : submitted;
  } catch {
    return null;
  }
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeSettings(row = {}, role = null) {
  const timeZone = row.time_zone || null;
  const weekStartDay = row.week_start_day || null;
  return {
    businessId: Number(row.id || row.contractor_profile_id),
    businessName: row.business_name || "",
    configured: Boolean(timeZone && weekStartDay),
    timeZone,
    weekStartDay,
    updatedAt: iso(row.time_settings_updated_at),
    updatedByMembershipId: row.time_settings_updated_by_membership_id || null,
    canManage: permissionForRole(role || row.role, "TIME_SETTINGS_MANAGE"),
  };
}

async function loadActorAndSettings(database, actorUserId, businessId, { lock = false } = {}) {
  const result = await database.query(
    `SELECT profiles.id, profiles.business_name, profiles.time_zone,
            profiles.week_start_day, profiles.time_settings_updated_at,
            profiles.time_settings_updated_by_membership_id,
            memberships.id AS membership_id, memberships.role, memberships.status
       FROM business_team_memberships memberships
       JOIN contractor_profiles profiles
         ON profiles.id = memberships.contractor_profile_id
      WHERE memberships.user_id = $1
        AND memberships.contractor_profile_id = $2
        AND memberships.status = 'ACTIVE'
      ${lock ? "FOR UPDATE OF profiles, memberships" : ""}
      LIMIT 1`,
    [actorUserId, businessId]
  );
  return result.rows[0] || null;
}

async function getBusinessTimeSettings({ pool, authenticatedActor, businessId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "BUSINESS_TIME_SETTINGS_BUSINESS_INVALID", "Exact business identity is required.");
  const row = await loadActorAndSettings(pool, actorId, normalizedBusinessId);
  if (!row || (!permissionForRole(row.role, "TIME_SELF_VIEW") && !permissionForRole(row.role, "TIME_TEAM_VIEW"))) {
    return failure(403, "BUSINESS_TIME_SETTINGS_PERMISSION_REQUIRED", "An active Team membership with time visibility is required.");
  }
  return {
    ok: true,
    status: 200,
    code: "BUSINESS_TIME_SETTINGS_LOADED",
    settings: serializeSettings(row),
  };
}

async function updateBusinessTimeSettings({ pool, authenticatedActor, businessId, timeZone, weekStartDay }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const normalizedWeekStartDay = normalizeWeekStartDay(weekStartDay);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "BUSINESS_TIME_SETTINGS_BUSINESS_INVALID", "Exact business identity is required.");
  if (!normalizedTimeZone) {
    return failure(400, "BUSINESS_TIME_ZONE_INVALID", "Choose a supported IANA timezone such as America/New_York.");
  }
  if (!normalizedWeekStartDay) {
    return failure(400, "BUSINESS_WEEK_START_INVALID", "Choose a valid weekday for the Business week start.");
  }
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const actor = await loadActorAndSettings(client, actorId, normalizedBusinessId, { lock: true });
    if (!actor || !permissionForRole(actor.role, "TIME_SETTINGS_MANAGE")) {
      await client.query("ROLLBACK");
      started = false;
      return failure(403, "BUSINESS_TIME_SETTINGS_OWNER_REQUIRED", "Only the active Business Owner may change time settings.");
    }
    const result = await client.query(
      `UPDATE contractor_profiles
          SET time_zone = $2,
              week_start_day = $3,
              time_settings_updated_at = CURRENT_TIMESTAMP,
              time_settings_updated_by_membership_id = $4
        WHERE id = $1
        RETURNING *`,
      [normalizedBusinessId, normalizedTimeZone, normalizedWeekStartDay, actor.membership_id]
    );
    await client.query("COMMIT");
    started = false;
    return {
      ok: true,
      status: 200,
      code: "BUSINESS_TIME_SETTINGS_UPDATED",
      settings: serializeSettings({ ...result.rows[0], role: actor.role }),
    };
  } catch (error) {
    if (started) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

module.exports = {
  WEEK_START_DAYS,
  getBusinessTimeSettings,
  loadActorAndSettings,
  normalizeTimeZone,
  normalizeWeekStartDay,
  serializeSettings,
  updateBusinessTimeSettings,
};

