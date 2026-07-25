"use strict";

const {
  professionalCanSeeRequest,
} = require("../requests/requestLifecycle");
const {
  getProfessionalServiceDomain,
} = require("../requests/serviceCompatibility");

const DISTRIBUTABLE_STATUS = "ready_for_distribution";
const DISTRIBUTABLE_DISPOSITION = "continue";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseProfileDetails(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requireDatabasePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

function hasUsableEmergencyProfile(details = {}) {
  const hasServiceSpecialty =
    Array.isArray(details.service_specialties) &&
    details.service_specialties.some((specialty) =>
      Boolean(getProfessionalServiceDomain(specialty))
    );
  const hasServiceArea = [
    details.service_area,
    details.city,
    details.postal_code,
  ]
    .flatMap((value) => String(value || "").split(/[,;|]+/))
    .some((value) => Boolean(value.trim()));

  return hasServiceSpecialty && hasServiceArea;
}

function serializeProfessionalEmergencyOpportunity(row = {}) {
  // Deliberately bounded: private location, access, safety, and participant
  // details must never be added to the professional opportunity projection.
  return {
    id: row.id,
    sourceType: "emergency",
    category: row.category,
    serviceDomain: row.service_domain,
    serviceSpecialty: row.service_specialty,
    title: row.title,
    description: row.description,
    status: row.status,
    requestedAt: row.requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    relationship: null,
    conversation: null,
  };
}

function professionalCanSeeEmergencyOpportunity(
  profile = {},
  row = {},
  professionalUserId
) {
  const details = parseProfileDetails(profile.profile_details);

  if (
    !hasUsableEmergencyProfile(details) ||
    row.status !== DISTRIBUTABLE_STATUS ||
    row.disposition !== DISTRIBUTABLE_DISPOSITION ||
    Number(row.homeowner_id) === Number(professionalUserId)
  ) {
    return false;
  }

  return professionalCanSeeRequest(profile, {
    category: row.category,
    request_category: row.service_specialty,
    service_domain: row.service_domain,
    service_specialty: row.service_specialty,
    location: row.location_text,
    status: "open",
  });
}

async function listProfessionalEmergencyOpportunities({
  pool,
  professionalUserId,
}) {
  requireDatabasePool(pool);

  const profileResult = await pool.query(
    `
    SELECT
      id,
      user_id,
      category,
      profile_details
    FROM contractor_profiles
    WHERE user_id = $1
    ORDER BY id ASC
    LIMIT 1
    `,
    [professionalUserId]
  );

  if (profileResult.rows.length === 0) {
    return {
      ok: false,
      status: 403,
      code: "PROFESSIONAL_PROFILE_REQUIRED",
      message: "A business profile is required to view Emergency opportunities.",
    };
  }

  const profile = profileResult.rows[0];
  const details = parseProfileDetails(profile.profile_details);

  if (!hasUsableEmergencyProfile(details)) {
    return {
      ok: true,
      status: 200,
      code: "EMERGENCY_OPPORTUNITIES_FOUND",
      opportunities: [],
    };
  }

  const opportunityResult = await pool.query(
    `
    SELECT
      emergency_requests.id,
      emergency_requests.homeowner_id,
      emergency_requests.category,
      emergency_requests.service_domain,
      emergency_requests.service_specialty,
      emergency_requests.title,
      emergency_requests.description,
      emergency_requests.location_text,
      emergency_requests.status,
      emergency_requests.requested_at,
      emergency_requests.created_at,
      emergency_requests.updated_at,
      emergency_request_safety_assessments.disposition
    FROM emergency_requests
    INNER JOIN emergency_request_safety_assessments
      ON emergency_request_safety_assessments.emergency_request_id =
        emergency_requests.id
    WHERE emergency_requests.status = 'ready_for_distribution'
      AND emergency_request_safety_assessments.disposition = 'continue'
      AND emergency_requests.homeowner_id <> $1
    ORDER BY
      emergency_requests.requested_at DESC NULLS LAST,
      emergency_requests.created_at DESC,
      emergency_requests.id DESC
    `,
    [professionalUserId]
  );

  return {
    ok: true,
    status: 200,
    code: "EMERGENCY_OPPORTUNITIES_FOUND",
    opportunities: opportunityResult.rows
      .filter((row) =>
        professionalCanSeeEmergencyOpportunity(
          profile,
          row,
          professionalUserId
        )
      )
      .map(serializeProfessionalEmergencyOpportunity),
  };
}

module.exports = {
  hasUsableEmergencyProfile,
  listProfessionalEmergencyOpportunities,
  parseProfileDetails,
  professionalCanSeeEmergencyOpportunity,
  serializeProfessionalEmergencyOpportunity,
};
