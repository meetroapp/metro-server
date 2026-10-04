"use strict";

const {
  getProfessionalServiceDomain,
  getRequestServiceDomain,
  isProfessionalServiceEligibleForRequest,
  normalizeProfessionalServiceId,
  normalizeRequestServiceId,
} = require("../requests/serviceCompatibility");

const {
  parsePositiveInteger,
} = require("../relationships/requestRelationships");

const DISTRIBUTABLE_STATUS = "ready_for_distribution";
const DISTRIBUTABLE_DISPOSITION = "continue";
const PARTICIPATION_STATES = new Set([
  "pending",
  "active",
  "declined",
  "withdrawn",
  "closed",
]);

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

function serializeProfessionalEmergencyParticipation(status) {
  if (status === undefined || status === null) return null;

  const state = String(status).trim().toLowerCase();

  return {
    state: PARTICIPATION_STATES.has(state) ? state : "unknown",
  };
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
    participation: serializeProfessionalEmergencyParticipation(
      row.participation_status
    ),
    relationship: null,
    conversation: null,
  };
}

function serializeHomeownerAvailableEmergencyProfessional(profile = {}) {
  const details = parseProfileDetails(profile.profile_details);

  return {
    contractorProfileId: profile.id,
    businessName:
      typeof profile.business_name === "string"
        ? profile.business_name
        : "",
    category:
      typeof profile.category === "string"
        ? profile.category
        : "",
    serviceSpecialties:
      Array.isArray(details.service_specialties)
        ? [...details.service_specialties]
        : [],
    profileImageUrl:
      typeof profile.image_url === "string"
        ? profile.image_url
        : "",
    serviceArea:
      typeof details.service_area === "string"
        ? details.service_area
        : "",
    availableNow: details.available_now === true,
    dispatchReady: details.dispatch_ready === true,
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

  const specialties = Array.isArray(details.service_specialties)
    ? details.service_specialties
        .map(normalizeProfessionalServiceId)
        .filter(Boolean)
    : [];

  const professionalCategories =
    specialties.length > 0
      ? specialties
      : [normalizeProfessionalServiceId(profile.category)].filter(Boolean);

  const requestSpecialty = normalizeRequestServiceId(row.service_specialty);
  const requestDomain = String(row.service_domain || "").trim().toLowerCase();
  const canonicalRequestDomain = getRequestServiceDomain(requestSpecialty);

  const professionalDomains = new Set(
    professionalCategories
      .map(getProfessionalServiceDomain)
      .filter(Boolean)
  );

  const specialtyMatched = professionalCategories.some((category) =>
    isProfessionalServiceEligibleForRequest(category, requestSpecialty)
  );

  const serviceAreas = [
    details.service_area,
    details.city,
    details.postal_code,
  ]
    .flatMap((value) => String(value || "").split(/[,;|]+/))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const emergencyLocation = String(row.location_text || "")
    .trim()
    .toLowerCase();

  const areaMatched = Boolean(
    emergencyLocation &&
    serviceAreas.length > 0 &&
    serviceAreas.some((area) => emergencyLocation.includes(area))
  );

  return Boolean(
    canonicalRequestDomain &&
    requestDomain === canonicalRequestDomain &&
    professionalDomains.has(requestDomain) &&
    specialtyMatched &&
    areaMatched
  );
}

function professionalCanBeDirectSelectedForEmergency(
  profile = {},
  row = {}
) {
  const details = parseProfileDetails(profile.profile_details);

  if (
    details.available_now !== true ||
    details.dispatch_ready !== true
  ) {
    return false;
  }

  return professionalCanSeeEmergencyOpportunity(
    profile,
    row,
    profile.user_id
  );
}

async function listHomeownerAvailableEmergencyProfessionals({
  pool,
  homeownerUserId,
  emergencyRequestId: rawEmergencyRequestId,
}) {
  requireDatabasePool(pool);

  const emergencyRequestId = parsePositiveInteger(
    rawEmergencyRequestId
  );

  if (!emergencyRequestId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_EMERGENCY_REQUEST_ID",
      message: "A valid Emergency request ID is required.",
    };
  }

  const emergencyResult = await pool.query(
    `
    SELECT
      emergency_requests.id,
      emergency_requests.homeowner_id,
      emergency_requests.category,
      emergency_requests.service_domain,
      emergency_requests.service_specialty,
      emergency_requests.location_text,
      emergency_requests.status,
      emergency_requests.requested_at,
      emergency_requests.created_at,
      emergency_requests.updated_at,
      emergency_requests.expired_at,
      emergency_request_safety_assessments.disposition
    FROM emergency_requests
    LEFT JOIN emergency_request_safety_assessments
      ON emergency_request_safety_assessments.emergency_request_id =
        emergency_requests.id
    WHERE emergency_requests.id = $1
      AND emergency_requests.homeowner_id = $2
    LIMIT 1
    `,
    [
      emergencyRequestId,
      homeownerUserId,
    ]
  );

  if (emergencyResult.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "EMERGENCY_REQUEST_NOT_FOUND",
      message: "The Emergency request was not found.",
    };
  }

  const emergencyRequest = emergencyResult.rows[0];

  if (
    emergencyRequest.status !== DISTRIBUTABLE_STATUS ||
    emergencyRequest.disposition !== DISTRIBUTABLE_DISPOSITION ||
    emergencyRequest.expired_at != null
  ) {
    return {
      ok: false,
      status: 409,
      code: "EMERGENCY_REQUEST_NOT_DISCOVERABLE",
      message:
        "This Emergency request is not available for Available Now discovery.",
    };
  }

  const profileResult = await pool.query(
    `
    SELECT
      contractor_profiles.id,
      contractor_profiles.user_id,
      contractor_profiles.business_name,
      contractor_profiles.category,
      contractor_profiles.image_url,
      contractor_profiles.profile_details
    FROM contractor_profiles
    WHERE contractor_profiles.user_id <> $1
      AND contractor_profiles.profile_details @>
        '{"available_now": true, "dispatch_ready": true}'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM request_relationships
        WHERE request_relationships.emergency_request_id = $2
          AND request_relationships.contractor_id =
            contractor_profiles.id
          AND request_relationships.post_id IS NULL
      )
    ORDER BY
      contractor_profiles.business_name ASC NULLS LAST,
      contractor_profiles.id ASC
    `,
    [
      homeownerUserId,
      emergencyRequestId,
    ]
  );

  return {
    ok: true,
    status: 200,
    code: "EMERGENCY_AVAILABLE_PROFESSIONALS_FOUND",
    emergencyRequest,
    professionals: profileResult.rows
      .filter((profile) =>
        professionalCanBeDirectSelectedForEmergency(
          profile,
          emergencyRequest
        )
      )
      .map(
        serializeHomeownerAvailableEmergencyProfessional
      ),
  };
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
      emergency_request_safety_assessments.disposition,
      (
        SELECT request_relationships.status
        FROM request_relationships
        WHERE request_relationships.emergency_request_id =
          emergency_requests.id
          AND request_relationships.contractor_id = $2
          AND request_relationships.professional_user_id = $1
          AND request_relationships.post_id IS NULL
        ORDER BY request_relationships.id ASC
        LIMIT 1
      ) AS participation_status
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
    [professionalUserId, profile.id]
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
  listHomeownerAvailableEmergencyProfessionals,
  listProfessionalEmergencyOpportunities,
  professionalCanBeDirectSelectedForEmergency,
  parseProfileDetails,
  professionalCanSeeEmergencyOpportunity,
  serializeHomeownerAvailableEmergencyProfessional,
  serializeProfessionalEmergencyParticipation,
  serializeProfessionalEmergencyOpportunity,
};
