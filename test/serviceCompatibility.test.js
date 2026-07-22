"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const { PROFESSIONAL_SERVICE_IDS } = require("../server/profile/professionalServiceIds");
const {
  CATEGORY_ELIGIBILITY,
  COMPATIBILITY_FAMILIES,
  LEGACY_REQUEST_SERVICE_DOMAINS,
  MARKETING_SERVICE_IDS,
  PROFESSIONAL_CATEGORY_ALIASES,
  REQUEST_SERVICE_ALIASES,
  REQUEST_SERVICE_IDS,
  getEligibleProfessionalServiceIdsForRequest,
  getProfessionalServiceDomain,
  getRequestServiceDomain,
  getTaxonomyCompatibilityInventory,
  isKnownProfessionalService,
  isProfessionalServiceEligibleForRequest,
  isSupportedRequestService,
  normalizeProfessionalServiceId,
  normalizeRequestServiceId,
} = require("../server/requests/serviceCompatibility");

const FRONTEND_PROFESSIONAL_IDS_SHA256 =
  "3dac392bf7acb2b3442ab8b7edf643cf58a38341d15c1294951d344d076770ee";
const FRONTEND_REQUEST_IDS_SHA256 =
  "3263c95c42b2711991109003429884397bf766b0a46e6b69852675fda22a94fa";

function checksum(values) {
  return createHash("sha256")
    .update([...values].sort().join("\n"))
    .digest("hex");
}

test("backend inventory is pinned to the complete frontend professional and request taxonomies", () => {
  assert.equal(PROFESSIONAL_SERVICE_IDS.size, 265);
  assert.equal(REQUEST_SERVICE_IDS.size, 246);
  assert.equal(checksum(PROFESSIONAL_SERVICE_IDS), FRONTEND_PROFESSIONAL_IDS_SHA256);
  assert.equal(checksum(REQUEST_SERVICE_IDS), FRONTEND_REQUEST_IDS_SHA256);

  const source = readFileSync(
    require.resolve("../server/profile/professionalServiceIds"),
    "utf8"
  );
  const setBody = source.match(/new Set\(\[([\s\S]*?)\]\)/)?.[1] || "";
  const declaredIds = [...setBody.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.equal(declaredIds.length, PROFESSIONAL_SERVICE_IDS.size);
  assert.equal(new Set(declaredIds).size, declaredIds.length);
});

test("every canonical request service has an exact professional match", () => {
  for (const requestId of REQUEST_SERVICE_IDS) {
    assert.equal(PROFESSIONAL_SERVICE_IDS.has(requestId), true, requestId);
    assert.equal(isSupportedRequestService(requestId), true, requestId);
    assert.equal(isProfessionalServiceEligibleForRequest(requestId, requestId), true, requestId);
    assert.ok(getRequestServiceDomain(requestId), requestId);
  }
});

test("every professional service is exact-matchable or explicitly excluded from Request Help", () => {
  const inventory = getTaxonomyCompatibilityInventory();
  assert.equal(inventory.length, PROFESSIONAL_SERVICE_IDS.size);

  for (const row of inventory) {
    if (MARKETING_SERVICE_IDS.has(row.professionalServiceId)) {
      assert.equal(row.homeownerRequestId, "", row.professionalServiceId);
      assert.equal(row.expectedCompatibility, "intentionally_unsupported");
      assert.equal(row.status, "ORPHAN_PROFESSIONAL_SERVICE");
      assert.equal(row.domain, "marketing");
    } else {
      assert.equal(row.homeownerRequestId, row.professionalServiceId);
      assert.equal(row.expectedCompatibility, "exact");
      assert.equal(row.status, "PASS");
    }
  }
  assert.equal(MARKETING_SERVICE_IDS.size, 19);
});

test("approved category families enforce table-driven parent and child compatibility", () => {
  const nearbyBlocked = {
    handyman: "nursing",
    cleaning_services: "electrical_repair",
    pool_services: "roof_repair",
    general_contractor: "pool_cleaning",
    roofing: "plumbing_repair",
    plumbing: "electrical_repair",
    electrical: "plumbing_repair",
    hvac: "roof_repair",
    pest_control: "pool_cleaning",
    healthcare: "painting",
    landscaping: "pool_cleaning",
    tree_services: "lawn_care",
    flooring: "roof_repair",
    painting: "drywall_installation",
    drywall: "interior_painting",
    doors_windows_garage: "plumbing_repair",
    appliance_repair: "appliance_installation",
    junk_removal: "local_moving",
    property_management: "home_health",
    real_estate: "property_management",
    automotive_services: "private_transportation",
  };

  for (const family of COMPATIBILITY_FAMILIES) {
    for (const parent of family.professionalParents) {
      for (const requestId of family.services) {
        assert.equal(
          isProfessionalServiceEligibleForRequest(parent, requestId),
          true,
          `${family.family}: ${parent} -> ${requestId}`
        );
      }
      assert.equal(
        isProfessionalServiceEligibleForRequest(parent, nearbyBlocked[family.family]),
        false,
        `${family.family}: blocked ${nearbyBlocked[family.family]}`
      );
    }

    for (const requestParent of family.requestParents) {
      for (const professionalId of family.services) {
        assert.equal(
          isProfessionalServiceEligibleForRequest(professionalId, requestParent),
          true,
          `${family.family}: ${professionalId} -> ${requestParent}`
        );
      }
    }
  }
});

test("canonical alias relationships are explicit and nearby services remain incompatible", () => {
  const approved = [
    ["door_repair_replacement", "door_repair"],
    ["door_repair_replacement", "door_replacement"],
    ["minor_plumbing", "faucet_repair_installation"],
    ["minor_electrical", "outlet_switch_installation"],
    ["plumbing_repairs", "plumbing_repair"],
    ["plumbing_repair", "plumbing_repairs"],
    ["pool_builders", "new_pool_construction"],
    ["new_pool_construction", "pool_builders"],
    ["permit_plan_preparation", "permit_plans"],
    ["permit_plans", "permit_plan_preparation"],
    ["restaurant_kitchen_cleaning", "restaurant_cleaning"],
    ["restaurant_cleaning", "restaurant_kitchen_cleaning"],
    ["window_repair", "window_replacement"],
    ["garage_door_repair", "garage_door_opener_installation"],
  ];
  const blocked = [
    ["appliance_installation", "refrigerator_repair"],
    ["interior_painting", "exterior_painting"],
    ["roof_repair", "gutter_installation_repair"],
    ["nursing", "personal_care_support"],
    ["mechanic", "private_transportation"],
    ["architectural_designer", "graphic_design"],
  ];

  approved.forEach(([professionalId, requestId]) => {
    assert.equal(
      isProfessionalServiceEligibleForRequest(professionalId, requestId),
      true,
      `${professionalId} -> ${requestId}`
    );
  });
  blocked.forEach(([professionalId, requestId]) => {
    assert.equal(
      isProfessionalServiceEligibleForRequest(professionalId, requestId),
      false,
      `${professionalId} !-> ${requestId}`
    );
  });
});

test("unknown, null, blank, and display-label IDs fail closed", () => {
  const unknownValues = [null, undefined, "", "   ", "made_up_service", "door repair"];
  for (const value of unknownValues) {
    assert.equal(isSupportedRequestService(value), false);
    assert.equal(isKnownProfessionalService(value), false);
    assert.equal(isProfessionalServiceEligibleForRequest(value, "painting"), false);
    assert.equal(isProfessionalServiceEligibleForRequest("painting", value), false);
    assert.deepEqual(getEligibleProfessionalServiceIdsForRequest(value), []);
  }

  assert.equal(isProfessionalServiceEligibleForRequest(" Painting ", " painting "), true);
  assert.equal(normalizeProfessionalServiceId("homeHealthCare"), "home_health");
  assert.equal(normalizeRequestServiceId("windowsDoors"), "doors_windows");
});

test("aliases target documented canonical services or compatibility families", () => {
  for (const [alias, target] of Object.entries(PROFESSIONAL_CATEGORY_ALIASES)) {
    assert.match(alias, /^[a-z0-9_]+$/);
    assert.equal(isKnownProfessionalService(target), true, `${alias} -> ${target}`);
  }
  for (const [alias, target] of Object.entries(REQUEST_SERVICE_ALIASES)) {
    assert.match(alias, /^[a-z0-9_]+$/);
    assert.equal(isSupportedRequestService(target), true, `${alias} -> ${target}`);
  }
  for (const legacyId of Object.keys(LEGACY_REQUEST_SERVICE_DOMAINS)) {
    assert.match(legacyId, /^[a-z0-9_]+$/);
    assert.equal(isSupportedRequestService(legacyId), true, legacyId);
  }
});

test("compatibility rules never use labels or turn a family into a universal match", () => {
  const requestCount = REQUEST_SERVICE_IDS.size;
  for (const [professionalId, requestIds] of Object.entries(CATEGORY_ELIGIBILITY)) {
    assert.match(professionalId, /^[a-z0-9_]+$/);
    requestIds.forEach((requestId) => assert.match(requestId, /^[a-z0-9_]+$/));
    const activeMatches = requestIds.filter((requestId) => REQUEST_SERVICE_IDS.has(requestId));
    assert.ok(activeMatches.length < requestCount, professionalId);
  }
});

test("unsupported marketing and conflicting moving family aliases stay fail closed", () => {
  assert.equal(isSupportedRequestService("seo"), false);
  assert.equal(getRequestServiceDomain("seo"), "");
  assert.equal(isProfessionalServiceEligibleForRequest("seo", "painting"), false);

  assert.equal(isSupportedRequestService("local_moving"), true);
  assert.equal(getRequestServiceDomain("local_moving"), "home_services");
  assert.equal(isSupportedRequestService("moving"), false);
  assert.equal(isProfessionalServiceEligibleForRequest("moving", "local_moving"), false);
});
