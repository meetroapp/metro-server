"use strict";

const REQUEST_STATUSES = Object.freeze(["open", "cancelled"]);
const {
  SUPPORTED_REQUEST_DOMAINS,
  getProfessionalServiceDomain,
  getRequestServiceDomain,
  isProfessionalServiceEligibleForRequest,
  isSupportedRequestService,
  normalizeProfessionalServiceId,
  normalizeRequestServiceId,
} = require("./serviceCompatibility");
const {
  LOCATION_NORMALIZATION_STATUS,
  SERVICE_LOCATION_INPUT_FIELDS,
  validateCanonicalServiceLocation,
} = require("./serviceLocation");

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value, limit, { required = false } = {}) {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > limit) return null;
  return cleaned;
}

function normalizeIdentifier(value = "") {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function validateRequestPayload(body, { partial = false } = {}) {
  if (!isRecord(body)) {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Request details must be an object." };
  }

  const allowed = new Set(partial
    ? [
        "title",
        "description",
        "location",
        "request_photos",
        ...SERVICE_LOCATION_INPUT_FIELDS,
      ]
    : [
        "title", "description", "category", "request_category", "service_domain",
        "service_specialty", "location", ...SERVICE_LOCATION_INPUT_FIELDS, "request_photos",
        "post_type", "status", "direct_request", "direct_request_source",
        "direct_professional_name", "direct_conversation_id",
      ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return { ok: false, status: 400, code: "UNSUPPORTED_REQUEST_FIELDS", message: "One or more request fields are not supported." };
  }
  if (
    partial &&
    ![
      "title",
      "description",
      "location",
      "request_photos",
      ...SERVICE_LOCATION_INPUT_FIELDS,
    ].some((key) => body[key] !== undefined)
  ) {
    return { ok: false, status: 400, code: "REQUEST_UPDATE_REQUIRED", message: "At least one editable request field is required." };
  }

  if (body.direct_request === true || body.post_type === "direct_request") {
    return { ok: false, status: 400, code: "DIRECT_REQUEST_UNAVAILABLE", message: "Direct requests are not available in this workflow." };
  }

  const title = cleanString(body.title, 160, {
    required: !partial || body.title !== undefined,
  });
  const description = cleanString(body.description, 5000);
  const category = cleanString(body.category, 100, { required: !partial });
  const requestCategory = cleanString(body.request_category, 100, { required: !partial });
  const serviceDomain = normalizeIdentifier(body.service_domain);
  const serviceSpecialty = normalizeRequestServiceId(body.service_specialty);
  const legacyLocation = cleanString(body.location, 500, {
    required: partial && body.location !== undefined,
  });
  const serviceLocationValidation = validateCanonicalServiceLocation(body, {
    required: !partial,
  });

  if (!serviceLocationValidation.ok) return serviceLocationValidation;

  const serviceLocation = serviceLocationValidation.location;
  const location = serviceLocation?.compatibility_location || legacyLocation;
  const unitNumber = serviceLocation?.unit_number || "";
  const accessNotes = serviceLocation?.access_notes || "";

  if ([title, description, category, requestCategory, legacyLocation].includes(null)) {
    return { ok: false, status: 400, code: "INVALID_REQUEST_FIELD", message: "One or more request fields are invalid." };
  }
  const canonicalServiceDomain = getRequestServiceDomain(serviceSpecialty);
  if (
    !partial &&
    (!isSupportedRequestService(serviceSpecialty) ||
      !canonicalServiceDomain ||
      serviceDomain !== canonicalServiceDomain)
  ) {
    return { ok: false, status: 400, code: "REQUEST_MATCHING_REQUIRED", message: "A supported service match is required." };
  }
  if (
    partial &&
    body.service_domain !== undefined &&
    !SUPPORTED_REQUEST_DOMAINS.includes(serviceDomain)
  ) {
    return { ok: false, status: 400, code: "INVALID_SERVICE_DOMAIN", message: "Service domain is invalid." };
  }

  return {
    ok: true,
    request: {
      title,
      description,
      category: normalizeIdentifier(category),
      request_category: normalizeIdentifier(requestCategory),
      service_domain: serviceDomain,
      service_specialty: serviceSpecialty,
      location,
      unit_number: unitNumber,
      access_notes: accessNotes,
      location_intake_mode: serviceLocation?.intake_mode || null,
      location_normalization_status:
        serviceLocation?.normalization_status ||
        LOCATION_NORMALIZATION_STATUS.LEGACY_UNCLASSIFIED,
      service_address_line1: serviceLocation?.address_line1 ?? null,
      service_city: serviceLocation?.city ?? null,
      service_region: serviceLocation?.region ?? null,
      service_postal_code: serviceLocation?.postal_code ?? null,
      service_country_code: serviceLocation?.country_code ?? null,
      discovery_area_label: serviceLocation?.discovery_area_label ?? null,
      has_service_location_update: serviceLocationValidation.present,
      has_access_notes_update:
        serviceLocationValidation.present &&
        Object.hasOwn(body, "access_notes"),
      has_legacy_location_update:
        partial &&
        body.location !== undefined &&
        !serviceLocationValidation.present,
    },
  };
}

function parseDetails(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function professionalCanSeeRequest(profile = {}, request = {}) {
  const details = parseDetails(profile.profile_details);
  const specialties = Array.isArray(details.service_specialties)
    ? details.service_specialties.map(normalizeProfessionalServiceId).filter(Boolean)
    : [];
  const professionalCategories = specialties.length > 0
    ? specialties
    : [normalizeProfessionalServiceId(profile.category)].filter(Boolean);
  const requestSpecialty = normalizeRequestServiceId(
    request.service_specialty || request.request_category
  );
  const requestDomain = normalizeIdentifier(request.service_domain);
  const canonicalRequestDomain = getRequestServiceDomain(requestSpecialty);
  const professionalDomains = new Set(
    professionalCategories.map(getProfessionalServiceDomain).filter(Boolean)
  );
  const serviceAreas = [details.service_area, details.city, details.postal_code]
    .flatMap((value) => String(value || "").split(/[,;|]+/))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const normalizedLocation =
    request.location_normalization_status ===
    LOCATION_NORMALIZATION_STATUS.NORMALIZED;

  const requestLocality = [
    request.discovery_area_label,
    request.service_city,
    request.service_region,
    request.service_postal_code,
    request.service_country_code,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  const areaMatched = Boolean(
    normalizedLocation &&
    requestLocality.length > 0 &&
    serviceAreas.length > 0 &&
    serviceAreas.some((area) =>
      requestLocality.some(
        (locality) => locality === area || locality.includes(area)
      )
    )
  );
  const specialtyMatched = professionalCategories.some((category) =>
    isProfessionalServiceEligibleForRequest(category, requestSpecialty)
  );

  return Boolean(
    request.status === "open" &&
    canonicalRequestDomain &&
    requestDomain === canonicalRequestDomain &&
    professionalDomains.has(requestDomain) &&
    specialtyMatched &&
    areaMatched
  );
}

function serializeOwnedRequest(row = {}, requestPhotos = []) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    request_category: row.request_category,
    service_domain: row.service_domain,
    service_specialty: row.service_specialty,
    location: row.location,
    location_intake_mode: row.location_intake_mode ?? null,
    location_normalization_status:
      row.location_normalization_status ||
      LOCATION_NORMALIZATION_STATUS.LEGACY_UNCLASSIFIED,
    service_address_line1: row.service_address_line1 ?? null,
    service_city: row.service_city ?? null,
    service_region: row.service_region ?? null,
    service_postal_code: row.service_postal_code ?? null,
    service_country_code: row.service_country_code ?? null,
    discovery_area_label: row.discovery_area_label ?? null,
    unit_number: row.unit_number,
    access_notes: row.access_notes,
    status: REQUEST_STATUSES.includes(row.status) ? row.status : "open",
    created_at: row.created_at,
    updated_at: row.updated_at,
    cancelled_at: row.cancelled_at,
    mage_url: row.mage_url ?? null,
    image_url: row.image_url ?? requestPhotos[0]?.secure_url ?? "",
    request_photos: requestPhotos,
  };
}

function serializeProfessionalOpportunityPhoto(photo = {}) {
  const secureUrl =
    typeof photo.secure_url === "string" ? photo.secure_url.trim() : "";

  if (!secureUrl) return null;

  return {
    secure_url: secureUrl,
    resource_type: photo.resource_type === "image" ? "image" : null,
    format: typeof photo.format === "string" ? photo.format : null,
    width: Number.isInteger(Number(photo.width))
      ? Number(photo.width)
      : null,
    height: Number.isInteger(Number(photo.height))
      ? Number(photo.height)
      : null,
    display_order: Number.isInteger(Number(photo.display_order))
      ? Math.max(0, Number(photo.display_order))
      : 0,
  };
}

function serializeProfessionalOpportunity(row = {}, requestPhotos = []) {
  const safeRequestPhotos = requestPhotos
    .map(serializeProfessionalOpportunityPhoto)
    .filter(Boolean)
    .sort((left, right) => left.display_order - right.display_order);

  return {
    id: row.id,
    request_id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    request_category: row.request_category,
    service_domain: row.service_domain,
    service_specialty: row.service_specialty,
    service_area: row.discovery_area_label ?? null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    image_url: safeRequestPhotos[0]?.secure_url ?? "",
    request_photos: safeRequestPhotos,
    relationship_scope: "business",
    account_mode: "business",
    has_responded: row.has_responded === true,
    professional_response_id:
      row.has_responded === true ? row.professional_response_id : null,
    response_status:
      row.has_responded === true ? row.response_status : null,
    relationship_status:
      row.has_responded === true ? row.relationship_status : null,
    submitted_at:
      row.has_responded === true ? row.submitted_at : null,
    response_submission_available:
      row.response_submission_available === true,
  };
}

module.exports = {
  REQUEST_STATUSES,
  professionalCanSeeRequest,
  serializeOwnedRequest,
  serializeProfessionalOpportunity,
  serializeProfessionalOpportunityPhoto,
  validateRequestPayload,
};
