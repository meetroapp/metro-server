"use strict";

const { PROFESSIONAL_SERVICE_IDS } = require("./professionalServiceIds");

const BASE_FIELDS = Object.freeze([
  "business_name",
  "category",
  "phone",
  "location",
  "bio",
  "image_url",
]);

const DETAIL_FIELDS = Object.freeze([
  "street_address",
  "address_line_2",
  "city",
  "state_province",
  "postal_code",
  "country",
  "service_area",
  "show_business_address_public",
  "business_hours",
  "license_number",
  "license_state",
  "license_type",
  "license_expiration",
  "service_specialties",
  "available_now",
  "dispatch_ready",
]);

const ALLOWED_FIELDS = new Set([...BASE_FIELDS, ...DETAIL_FIELDS]);
const BOOLEAN_FIELDS = new Set([
  "show_business_address_public",
  "available_now",
  "dispatch_ready",
]);
const STRING_LIMITS = Object.freeze({
  business_name: 120,
  category: 100,
  phone: 40,
  location: 500,
  bio: 3000,
  image_url: 2048,
  street_address: 200,
  address_line_2: 200,
  city: 120,
  state_province: 120,
  postal_code: 30,
  country: 40,
  service_area: 500,
  business_hours: 500,
  license_number: 120,
  license_state: 120,
  license_type: 120,
  license_expiration: 10,
});

function failure(code, message) {
  return { ok: false, status: 400, code, message };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value, limit) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length <= limit ? cleaned : null;
}

function validateSpecialties(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const normalized = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const specialty = item.trim();
    if (
      !specialty ||
      specialty.length > 100 ||
      !/^[a-z0-9_-]+$/i.test(specialty) ||
      !PROFESSIONAL_SERVICE_IDS.has(specialty)
    ) {
      return null;
    }
    if (!normalized.includes(specialty)) normalized.push(specialty);
  }
  return normalized;
}

function validateBusinessProfilePayload(
  body,
  { preserveOmittedServiceSpecialties = false } = {}
) {
  if (!isRecord(body)) {
    return failure("INVALID_BUSINESS_PROFILE", "Business profile must be an object.");
  }

  const unsupported = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unsupported.length > 0) {
    return failure(
      "UNSUPPORTED_BUSINESS_PROFILE_FIELDS",
      "One or more business profile fields are not supported."
    );
  }

  const profile = {};
  for (const [field, limit] of Object.entries(STRING_LIMITS)) {
    const cleaned = cleanString(body[field], limit);
    if (cleaned === null) {
      return failure(
        "INVALID_BUSINESS_PROFILE_FIELD",
        "One or more business profile fields are invalid."
      );
    }
    profile[field] = cleaned;
  }

  if (!profile.business_name || !profile.category) {
    return failure(
      "BUSINESS_PROFILE_REQUIRED_FIELDS",
      "Business name and category are required."
    );
  }

  if (profile.image_url) {
    return failure(
      "GOVERNED_MEDIA_REFERENCE_REQUIRED",
      "Business profile media is not available yet."
    );
  }
  if (
    profile.license_expiration &&
    !/^\d{4}-\d{2}-\d{2}$/.test(profile.license_expiration)
  ) {
    return failure("INVALID_LICENSE_EXPIRATION", "License expiration must be a date.");
  }

  for (const field of BOOLEAN_FIELDS) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") {
      return failure(
        "INVALID_BUSINESS_PROFILE_FIELD",
        "One or more business profile fields are invalid."
      );
    }
    profile[field] = body[field] === true;
  }

  const serviceSpecialtiesProvided = Object.hasOwn(body, "service_specialties");
  if (serviceSpecialtiesProvided || !preserveOmittedServiceSpecialties) {
    const specialties = validateSpecialties(body.service_specialties ?? []);
    if (!specialties) {
      return failure(
        "INVALID_SERVICE_SPECIALTIES",
        "Service specialties must use supported stable identifiers."
      );
    }
    profile.service_specialties = specialties;
  }

  return { ok: true, profile };
}

function buildProfileDetails(profile) {
  return Object.fromEntries(
    DETAIL_FIELDS
      .filter((field) => profile[field] !== undefined)
      .map((field) => [field, profile[field]])
  );
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

function serializeOwnedBusinessProfile(row = {}) {
  const details = parseDetails(row.profile_details);
  const profile = {};
  for (const field of BASE_FIELDS) profile[field] = row[field] ?? "";
  for (const field of DETAIL_FIELDS) {
    if (BOOLEAN_FIELDS.has(field)) {
      profile[field] = details[field] === true;
    } else if (field === "service_specialties") {
      profile[field] = Array.isArray(details[field]) ? [...details[field]] : [];
    } else {
      profile[field] = typeof details[field] === "string" ? details[field] : "";
    }
  }
  return {
    id: row.id,
    user_id: row.user_id,
    ...profile,
    created_at: row.created_at,
  };
}

function serializePublicBusinessProfile(row = {}) {
  const owned = serializeOwnedBusinessProfile(row);
  const publicProfile = {
    id: owned.id,
    business_name: owned.business_name,
    category: owned.category,
    phone: owned.phone,
    location: owned.location,
    bio: owned.bio,
    image_url: owned.image_url,
    service_area: owned.service_area,
    business_hours: owned.business_hours,
    license_number: owned.license_number,
    license_state: owned.license_state,
    license_type: owned.license_type,
    license_expiration: owned.license_expiration,
    service_specialties: owned.service_specialties,
    available_now: owned.available_now,
    dispatch_ready: owned.dispatch_ready,
    show_business_address_public: owned.show_business_address_public,
    created_at: owned.created_at,
  };
  if (owned.show_business_address_public) {
    Object.assign(publicProfile, {
      street_address: owned.street_address,
      address_line_2: owned.address_line_2,
      city: owned.city,
      state_province: owned.state_province,
      postal_code: owned.postal_code,
      country: owned.country,
    });
  }
  if (row.username) publicProfile.username = row.username;
  return publicProfile;
}

function buildCreateBusinessProfileQuery(userId, profile) {
  const details = buildProfileDetails(profile);
  return {
    text: `
      WITH inserted_profile AS (
        INSERT INTO contractor_profiles
        (user_id, business_name, category, phone, location, bio, image_url, profile_details)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *
      ), updated_user AS (
        UPDATE users
        SET account_type = 'professional',
            role = $3,
            business_name = $2,
            business_category = $3
        WHERE id = $1 AND EXISTS (SELECT 1 FROM inserted_profile)
        RETURNING id
      )
      SELECT inserted_profile.*
      FROM inserted_profile
      LEFT JOIN updated_user ON TRUE
    `,
    values: [
      userId,
      profile.business_name,
      profile.category,
      profile.phone,
      profile.location,
      profile.bio,
      "",
      JSON.stringify(details),
    ],
  };
}

function buildUpdateBusinessProfileQuery(profileId, userId, profile) {
  const details = buildProfileDetails(profile);
  return {
    text: `
      WITH updated_profile AS (
        UPDATE contractor_profiles
        SET business_name = $1,
            category = $2,
            phone = $3,
            location = $4,
            bio = $5,
            profile_details = COALESCE(profile_details, '{}'::jsonb) || $6::jsonb
        WHERE id = $7 AND user_id = $8
        RETURNING *
      ), updated_user AS (
        UPDATE users
        SET business_name = $1,
            business_category = $2
        WHERE id = $8 AND EXISTS (SELECT 1 FROM updated_profile)
        RETURNING id
      )
      SELECT updated_profile.*
      FROM updated_profile
      LEFT JOIN updated_user ON TRUE
    `,
    values: [
      profile.business_name,
      profile.category,
      profile.phone,
      profile.location,
      profile.bio,
      JSON.stringify(details),
      profileId,
      userId,
    ],
  };
}

module.exports = {
  ALLOWED_FIELDS,
  BASE_FIELDS,
  DETAIL_FIELDS,
  buildCreateBusinessProfileQuery,
  buildUpdateBusinessProfileQuery,
  serializeOwnedBusinessProfile,
  serializePublicBusinessProfile,
  validateBusinessProfilePayload,
};
