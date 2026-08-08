"use strict";

const LOCATION_INTAKE_MODE = Object.freeze({
  EXACT_ON_FILE: "exact_on_file",
  ADDRESS_AFTER_SELECTION: "address_after_selection",
});

const LOCATION_NORMALIZATION_STATUS = Object.freeze({
  NORMALIZED: "normalized",
  LEGACY_UNCLASSIFIED: "legacy_unclassified",
});

const SERVICE_LOCATION_INPUT_FIELDS = Object.freeze([
  "location_intake_mode",
  "service_address_line1",
  "service_city",
  "service_region",
  "service_postal_code",
  "service_country_code",
  "unit_number",
  "access_notes",
]);

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function failure(code, message) {
  return { ok: false, status: 400, code, message };
}

function cleanField(value, limit, { uppercase = false } = {}) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (cleaned.length > limit || CONTROL_CHARACTER_PATTERN.test(cleaned)) {
    return null;
  }
  return uppercase ? cleaned.toUpperCase() : cleaned;
}

function hasCanonicalServiceLocationInput(payload = {}) {
  return SERVICE_LOCATION_INPUT_FIELDS.some((field) =>
    Object.hasOwn(payload, field)
  );
}

function deriveDiscoveryAreaLabel({ city = "", region = "" } = {}) {
  return `${city}, ${region}`;
}

function formatCompatibilityLocation({
  intakeMode,
  addressLine1,
  city,
  region,
  postalCode,
  countryCode,
} = {}) {
  const locality = `${city}, ${region} ${postalCode}`.trim();
  const countrySuffix = countryCode && countryCode !== "US"
    ? `, ${countryCode}`
    : "";
  if (intakeMode === LOCATION_INTAKE_MODE.EXACT_ON_FILE) {
    return `${addressLine1}, ${locality}${countrySuffix}`;
  }
  return `${locality}${countrySuffix}`;
}

function validateCanonicalServiceLocation(payload = {}, { required = false } = {}) {
  if (!hasCanonicalServiceLocationInput(payload)) {
    return required
      ? failure(
          "SERVICE_LOCATION_REQUIRED",
          "Structured service location is required."
        )
      : { ok: true, present: false, location: null };
  }

  const intakeMode = cleanField(payload.location_intake_mode, 40);
  if (!Object.values(LOCATION_INTAKE_MODE).includes(intakeMode)) {
    return failure(
      "SERVICE_LOCATION_MODE_INVALID",
      "Service location intake mode is invalid."
    );
  }

  const addressLine1 = cleanField(payload.service_address_line1, 500);
  const city = cleanField(payload.service_city, 120);
  const region = cleanField(payload.service_region, 120);
  const postalCode = cleanField(payload.service_postal_code, 32);
  const countryCode = cleanField(payload.service_country_code, 2, {
    uppercase: true,
  });
  const unitNumber = cleanField(payload.unit_number, 100);
  const accessNotes = cleanField(payload.access_notes, 1000);

  if (countryCode === null || !COUNTRY_CODE_PATTERN.test(countryCode)) {
    return failure(
      "SERVICE_COUNTRY_CODE_INVALID",
      "A valid two-letter country code is required."
    );
  }

  if (
    [addressLine1, city, region, postalCode, unitNumber, accessNotes]
      .includes(null)
  ) {
    return failure(
      "INVALID_REQUEST_FIELD",
      "One or more request fields are invalid."
    );
  }

  if (!city || !region || !postalCode) {
    return failure(
      "SERVICE_LOCALITY_REQUIRED",
      "City, region, and postal code are required."
    );
  }
  if (intakeMode === LOCATION_INTAKE_MODE.EXACT_ON_FILE && !addressLine1) {
    return failure(
      "SERVICE_ADDRESS_REQUIRED",
      "Service address is required for exact-address requests."
    );
  }
  if (
    intakeMode === LOCATION_INTAKE_MODE.ADDRESS_AFTER_SELECTION &&
    (addressLine1 || unitNumber)
  ) {
    return failure(
      "SERVICE_ADDRESS_NOT_ALLOWED",
      "Street address and unit must be omitted until selection."
    );
  }

  const location = {
    intake_mode: intakeMode,
    normalization_status: LOCATION_NORMALIZATION_STATUS.NORMALIZED,
    address_line1:
      intakeMode === LOCATION_INTAKE_MODE.EXACT_ON_FILE
        ? addressLine1
        : null,
    city,
    region,
    postal_code: postalCode,
    country_code: countryCode,
    unit_number:
      intakeMode === LOCATION_INTAKE_MODE.EXACT_ON_FILE ? unitNumber : "",
    access_notes: accessNotes,
  };
  location.discovery_area_label = deriveDiscoveryAreaLabel(location);
  location.compatibility_location = formatCompatibilityLocation({
    intakeMode: location.intake_mode,
    addressLine1: location.address_line1,
    city: location.city,
    region: location.region,
    postalCode: location.postal_code,
    countryCode: location.country_code,
  });

  return { ok: true, present: true, location };
}

module.exports = {
  COUNTRY_CODE_PATTERN,
  LOCATION_INTAKE_MODE,
  LOCATION_NORMALIZATION_STATUS,
  SERVICE_LOCATION_INPUT_FIELDS,
  deriveDiscoveryAreaLabel,
  formatCompatibilityLocation,
  hasCanonicalServiceLocationInput,
  validateCanonicalServiceLocation,
};
