"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const {
  buildCreateBusinessProfileQuery,
  buildUpdateBusinessProfileQuery,
  serializeOwnedBusinessProfile,
  serializePublicBusinessProfile,
  validateBusinessProfilePayload,
} = require("../server/profile/businessProfile");

const completePayload = Object.freeze({
  business_name: "Trusted Home Services",
  category: "Home Services",
  phone: "555-0100",
  location: "Orlando, FL",
  bio: "Repairs and maintenance.",
  image_url: "https://example.test/logo.png",
  street_address: "100 Main Street",
  address_line_2: "Suite 2",
  city: "Orlando",
  state_province: "FL",
  postal_code: "32801",
  country: "US",
  service_area: "Greater Orlando",
  show_business_address_public: false,
  business_hours: "Monday-Friday 8-5",
  license_number: "LIC-100",
  license_state: "FL",
  license_type: "Contractor",
  license_expiration: "2027-12-31",
  service_specialties: ["door_repair_replacement", "drywall_repair"],
  available_now: true,
  dispatch_ready: false,
});

function storedRow(overrides = {}) {
  const validated = validateBusinessProfilePayload({ ...completePayload, ...overrides });
  assert.equal(validated.ok, true);
  const create = buildCreateBusinessProfileQuery(41, validated.profile);
  return {
    id: 7,
    user_id: 41,
    business_name: validated.profile.business_name,
    category: validated.profile.category,
    phone: validated.profile.phone,
    location: validated.profile.location,
    bio: validated.profile.bio,
    image_url: validated.profile.image_url,
    profile_details: JSON.parse(create.values[7]),
    created_at: "2026-07-14T12:00:00.000Z",
  };
}

test("business profile payload validates supported fields without mutating caller input", () => {
  const input = { ...completePayload, service_specialties: [...completePayload.service_specialties] };
  const before = structuredClone(input);
  const result = validateBusinessProfilePayload(input);

  assert.equal(result.ok, true);
  assert.deepEqual(input, before);
  assert.notEqual(result.profile.service_specialties, input.service_specialties);
});

test("legacy base profile payload receives safe extended defaults", () => {
  const result = validateBusinessProfilePayload({
    business_name: "Legacy Business",
    category: "Handyman",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.profile.service_specialties, []);
  assert.equal(result.profile.available_now, false);
  assert.equal(result.profile.dispatch_ready, false);
  assert.equal(result.profile.show_business_address_public, false);
});

test("unsupported and malformed business profile fields fail closed", () => {
  const unsupported = validateBusinessProfilePayload({
    ...completePayload,
    revenue: "not supported",
  });
  const malformed = validateBusinessProfilePayload({
    ...completePayload,
    dispatch_ready: "yes",
  });

  assert.equal(unsupported.code, "UNSUPPORTED_BUSINESS_PROFILE_FIELDS");
  assert.equal(malformed.code, "INVALID_BUSINESS_PROFILE_FIELD");
});

test("business profile queries enforce authenticated ownership and preserve stable fields", () => {
  const profile = validateBusinessProfilePayload(completePayload).profile;
  const create = buildCreateBusinessProfileQuery(41, profile);
  const update = buildUpdateBusinessProfileQuery(7, 41, profile);

  assert.match(create.text, /profile_details/);
  assert.equal(create.values[0], 41);
  assert.match(update.text, /WHERE id = \$8 AND user_id = \$9/);
  assert.deepEqual(update.values.slice(-2), [7, 41]);
  assert.deepEqual(JSON.parse(update.values[6]).service_specialties, completePayload.service_specialties);
});

test("owned serializer restores persisted fields while public serializer protects private address", () => {
  const row = storedRow();
  const owned = serializeOwnedBusinessProfile(row);
  const hidden = serializePublicBusinessProfile(row);
  const visible = serializePublicBusinessProfile(
    storedRow({ show_business_address_public: true })
  );

  assert.equal(owned.street_address, "100 Main Street");
  assert.equal(hidden.user_id, undefined);
  assert.equal(hidden.street_address, undefined);
  assert.equal(visible.street_address, "100 Main Street");
});

test("profile details migration is additive, guarded, and limited to contractor profiles", () => {
  const sql = readFileSync(
    join(__dirname, "../migrations/202607140001_add_contractor_profile_details.sql"),
    "utf8"
  );

  assert.match(sql, /ALTER TABLE contractor_profiles/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS profile_details JSONB/);
  assert.doesNotMatch(sql, /DROP|DELETE|TRUNCATE|UPDATE users/i);
});
