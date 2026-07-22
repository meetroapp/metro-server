"use strict";

const { PROFESSIONAL_SERVICE_IDS } = require("../profile/professionalServiceIds");

const SUPPORTED_REQUEST_DOMAINS = Object.freeze([
  "healthcare",
  "home_services",
  "property_management",
  "transportation",
]);

const MARKETING_SERVICE_IDS = new Set([
  "marketing_strategy",
  "digital_marketing",
  "seo",
  "local_seo",
  "ppc_advertising",
  "social_media_marketing",
  "content_marketing",
  "email_marketing",
  "brand_strategy",
  "brand_identity",
  "graphic_design",
  "website_design",
  "website_development",
  "copywriting",
  "photography",
  "videography",
  "marketing_analytics",
  "public_relations",
  "marketing_consulting",
]);

const HEALTHCARE_SERVICE_IDS = new Set([
  "home_health",
  "senior_care",
  "nursing",
  "caregiver",
  "medical_transport",
]);

const PROPERTY_MANAGEMENT_SERVICE_IDS = new Set([
  "tenant_ticket",
  "rental_maintenance",
  "inspection",
  "unit_turnover",
  "vendor_dispatch",
]);

const TRANSPORTATION_SERVICE_IDS = new Set([
  "mechanic",
  "mobile_services",
  "private_transportation",
  "car_detailing",
]);

const REQUEST_SERVICE_IDS = new Set(
  [...PROFESSIONAL_SERVICE_IDS].filter((id) => !MARKETING_SERVICE_IDS.has(id))
);

// Stable legacy IDs from the shared Community taxonomy or the pre-canonical
// request matcher. They are family aliases, never display labels.
const LEGACY_REQUEST_SERVICE_DOMAINS = Object.freeze({
  appliance_repair: "home_services",
  automotive_services: "transportation",
  contractor: "home_services",
  doors_windows: "home_services",
  general: "home_services",
  healthcare: "healthcare",
  hvac: "home_services",
  junk_removal: "home_services",
  landscaping: "home_services",
  maintenance: "property_management",
  medical_care: "healthcare",
  pest_control: "home_services",
  property_management: "property_management",
  property_maintenance: "property_management",
  real_estate: "home_services",
  repair: "home_services",
  roofing: "home_services",
  storm: "home_services",
  therapy: "healthcare",
  tree_service: "home_services",
});

const PROFESSIONAL_CATEGORY_DOMAINS = Object.freeze({
  appliance_repair: "home_services",
  automotive_services: "transportation",
  cleaning: "home_services",
  contractor: "home_services",
  doors_windows: "home_services",
  healthcare: "healthcare",
  hvac: "home_services",
  junk_removal: "home_services",
  landscaping: "home_services",
  pest_control: "home_services",
  pool_service: "home_services",
  property_management: "property_management",
  real_estate: "home_services",
  roofing: "home_services",
  tree_service: "home_services",
});

const PROFESSIONAL_CATEGORY_ALIASES = Object.freeze({
  cleaning_services: "cleaning",
  general_contractor: "contractor",
  home_health_care: "home_health",
  home_healthcare: "home_health",
  pool_services: "pool_service",
  property_maintenance: "property_management",
  tree_services: "tree_service",
  windows_doors: "doors_windows",
});

const REQUEST_SERVICE_ALIASES = Object.freeze({
  home_health_care: "home_health",
  home_healthcare: "home_health",
  windows_doors: "doors_windows",
});

const COMPATIBILITY_FAMILIES = Object.freeze([
  Object.freeze({
    family: "handyman",
    professionalParents: Object.freeze(["handyman"]),
    requestParents: Object.freeze(["handyman", "general", "repair"]),
    services: Object.freeze([
      "door_repair_replacement", "drywall_repair", "interior_painting",
      "exterior_painting", "tile_repair_installation",
      "cabinet_repair_replacement", "trim_baseboards", "mounting_hanging",
      "minor_plumbing", "minor_electrical", "fence_repair",
      "pressure_washing", "general_maintenance", "furniture_assembly",
      "shelving_installation", "weatherstripping", "caulking",
      "small_repairs", "handyman", "garage_door_opener_installation",
      "door_replacement", "painting", "drywall", "plumbing_repairs",
      "ceiling_fan_installation", "tile", "cabinetry", "flooring",
      "appliance_installation",
    ]),
  }),
  Object.freeze({
    family: "cleaning_services",
    professionalParents: Object.freeze(["cleaning"]),
    requestParents: Object.freeze(["cleaning"]),
    services: Object.freeze([
      "housekeeping", "office_cleaning_services", "carpet_cleaning",
      "industrial_cleaning", "window_cleaning", "medical_facility_cleaning",
      "restaurant_kitchen_cleaning", "event_venue_cleaning", "school_cleaning",
      "retail_cleaning", "hotel_hospitality_cleaning",
      "green_cleaning_services", "pet_cleaning_services",
      "graffiti_removal_services", "biohazard_cleaning",
      "move_in_move_out_cleaning", "post_construction_cleaning",
      "deep_cleaning", "janitorial_services", "cleaning",
    ]),
  }),
  Object.freeze({
    family: "pool_services",
    professionalParents: Object.freeze(["pool_service"]),
    requestParents: Object.freeze(["pool_service"]),
    services: Object.freeze([
      "pool_maintenance", "pool_cleaning", "pool_repair",
      "pool_equipment_installation", "pool_pump_repair",
      "pool_filter_cleaning", "pool_leak_detection", "pool_resurfacing",
      "pool_builders", "new_pool_construction", "spa_hot_tub_service",
      "pool_automation", "pool_lighting", "saltwater_pool_systems",
      "pool_service",
    ]),
  }),
  Object.freeze({
    family: "general_contractor",
    professionalParents: Object.freeze(["contractor"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "architect_coordination", "architectural_designer", "building_designer",
      "draftsperson_drafting_services", "permit_plan_preparation",
      "construction_documents", "home_inspections",
      "pre_purchase_inspections", "renovation_feasibility", "site_evaluation",
      "cost_estimation", "project_planning", "permit_coordination",
      "new_home_construction", "home_additions", "major_renovations",
      "kitchen_remodeling", "bathroom_remodeling", "whole_home_renovation",
      "commercial_build_outs", "structural_repairs", "general_contracting",
      "subcontractor_coordination", "construction_scheduling",
      "budget_management", "quality_control", "final_walkthrough",
    ]),
  }),
  Object.freeze({
    family: "roofing",
    professionalParents: Object.freeze(["roofing"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "roof_repair", "roof_replacement", "roof_inspection", "roof_leak_repair",
      "shingle_roofing", "tile_roofing", "metal_roofing", "flat_roofing",
      "commercial_roofing", "residential_roofing", "roof_maintenance",
      "storm_damage_roofing", "skylight_repair_installation",
      "gutter_installation_repair",
    ]),
  }),
  Object.freeze({
    family: "plumbing",
    professionalParents: Object.freeze(["plumbing"]),
    requestParents: Object.freeze(["plumbing"]),
    services: Object.freeze([
      "plumbing_repair", "drain_cleaning", "water_heater_repair",
      "water_heater_installation", "tankless_water_heaters", "leak_detection",
      "pipe_repair", "pipe_replacement", "sewer_line_repair",
      "toilet_repair_installation", "faucet_repair_installation",
      "garbage_disposal_installation", "shower_tub_plumbing",
      "emergency_plumbing", "plumbing", "plumbing_repairs",
    ]),
  }),
  Object.freeze({
    family: "electrical",
    professionalParents: Object.freeze(["electrical"]),
    requestParents: Object.freeze(["electrical"]),
    services: Object.freeze([
      "electrical_repair", "outlet_switch_installation", "lighting_installation",
      "ceiling_fan_installation", "panel_upgrades", "breaker_replacement",
      "ev_charger_installation", "generator_installation", "smart_home_wiring",
      "security_camera_wiring", "smoke_co_detector_installation",
      "electrical_troubleshooting", "emergency_electrical_service", "electrical",
    ]),
  }),
  Object.freeze({
    family: "hvac",
    professionalParents: Object.freeze(["hvac"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "ac_repair", "ac_installation", "ac_maintenance", "heating_repair",
      "heating_installation", "ductwork", "thermostat_installation",
      "indoor_air_quality", "mini_split_systems", "refrigeration",
      "emergency_hvac_service",
    ]),
  }),
  Object.freeze({
    family: "pest_control",
    professionalParents: Object.freeze(["pest_control"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "general_pest_control", "termite_treatment", "rodent_control",
      "ant_control", "roach_control", "mosquito_control", "bed_bug_treatment",
      "wildlife_removal", "bee_wasp_removal", "lawn_pest_treatment",
      "preventive_pest_service",
    ]),
  }),
  Object.freeze({
    family: "healthcare",
    professionalParents: Object.freeze(["healthcare"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "home_health", "senior_care", "nursing", "caregiver", "medical_transport",
    ]),
  }),
  Object.freeze({
    family: "landscaping",
    professionalParents: Object.freeze(["landscaping"]),
    requestParents: Object.freeze([]),
    services: Object.freeze(["lawn_care", "mulching", "planting", "irrigation_repair"]),
  }),
  Object.freeze({
    family: "tree_services",
    professionalParents: Object.freeze(["tree_service"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "tree_trimming", "tree_removal", "stump_grinding", "emergency_tree_service",
    ]),
  }),
  Object.freeze({
    family: "flooring",
    professionalParents: Object.freeze(["flooring"]),
    requestParents: Object.freeze(["flooring"]),
    services: Object.freeze([
      "flooring", "floor_installation", "floor_repair", "hardwood_flooring",
      "vinyl_flooring",
    ]),
  }),
  Object.freeze({
    family: "painting",
    professionalParents: Object.freeze(["painting"]),
    requestParents: Object.freeze(["painting"]),
    services: Object.freeze([
      "painting", "interior_painting", "exterior_painting", "cabinet_painting",
      "touch_up_painting",
    ]),
  }),
  Object.freeze({
    family: "drywall",
    professionalParents: Object.freeze(["drywall"]),
    requestParents: Object.freeze(["drywall"]),
    services: Object.freeze([
      "drywall", "drywall_repair", "drywall_installation", "texture_matching",
      "patch_repair",
    ]),
  }),
  Object.freeze({
    family: "doors_windows_garage",
    professionalParents: Object.freeze(["doors_windows"]),
    requestParents: Object.freeze(["doors_windows"]),
    services: Object.freeze([
      "door_repair_replacement", "door_replacement",
      "garage_door_opener_installation", "window_repair", "window_replacement",
      "door_installation", "door_repair", "garage_door_repair",
      "garage_door_installation",
    ]),
  }),
  Object.freeze({
    family: "appliance_repair",
    professionalParents: Object.freeze(["appliance_repair"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "refrigerator_repair", "washer_dryer_repair", "oven_repair",
      "dishwasher_repair",
    ]),
  }),
  Object.freeze({
    family: "junk_removal",
    professionalParents: Object.freeze(["junk_removal"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "furniture_removal", "appliance_haul_away", "construction_debris",
      "estate_cleanout",
    ]),
  }),
  Object.freeze({
    family: "property_management",
    professionalParents: Object.freeze(["property_management"]),
    requestParents: Object.freeze([
      "property_management", "property_maintenance", "maintenance",
    ]),
    services: Object.freeze([
      "tenant_ticket", "rental_maintenance", "inspection", "unit_turnover",
      "vendor_dispatch",
    ]),
  }),
  Object.freeze({
    family: "real_estate",
    professionalParents: Object.freeze(["real_estate"]),
    requestParents: Object.freeze([]),
    services: Object.freeze([
      "listing_preparation", "buyer_support", "rental_leasing",
    ]),
  }),
  Object.freeze({
    family: "automotive_services",
    professionalParents: Object.freeze(["automotive_services"]),
    requestParents: Object.freeze([]),
    services: Object.freeze(["mechanic", "mobile_services", "car_detailing"]),
  }),
]);

const ADDITIONAL_COMPATIBILITY = Object.freeze({
  ceiling_fan_installation: Object.freeze(["electrical"]),
  contractor: Object.freeze([
    "carpentry", "concrete", "demolition", "door_installation", "door_repair",
    "door_repair_replacement", "door_replacement", "doors_windows", "drywall",
    "flooring", "garage_door_repair", "painting", "repair", "tile",
    "window_repair", "window_replacement",
  ]),
  door_installation: Object.freeze([
    "door_repair", "door_repair_replacement", "door_replacement",
    "doors_windows", "garage_door_repair",
  ]),
  door_repair: Object.freeze([
    "door_installation", "door_repair_replacement", "doors_windows",
    "garage_door_repair",
  ]),
  door_repair_replacement: Object.freeze([
    "door_installation", "door_repair", "door_replacement", "doors_windows",
  ]),
  door_replacement: Object.freeze([
    "door_installation", "door_repair_replacement", "doors_windows",
  ]),
  drywall_repair: Object.freeze(["drywall"]),
  garage_door_installation: Object.freeze([
    "door_installation", "doors_windows", "garage_door_opener_installation",
    "garage_door_repair",
  ]),
  garage_door_repair: Object.freeze([
    "door_repair", "doors_windows", "garage_door_installation",
    "garage_door_opener_installation",
  ]),
  handyman: Object.freeze([
    "appliance_repair", "doors_windows", "garage_door_installation",
    "garage_door_repair", "locksmith", "window_repair", "window_replacement",
  ]),
  healthcare: Object.freeze(["medical_care", "therapy"]),
  home_health: Object.freeze([
    "caregiver", "medical_care", "nursing", "senior_care", "therapy",
  ]),
  landscaping: Object.freeze(["tree_service"]),
  minor_electrical: Object.freeze(["electrical", "outlet_switch_installation"]),
  minor_plumbing: Object.freeze(["faucet_repair_installation", "plumbing"]),
  permit_plan_preparation: Object.freeze(["permit_plans"]),
  permit_plans: Object.freeze(["permit_plan_preparation"]),
  plumbing_repair: Object.freeze(["plumbing_repairs"]),
  plumbing_repairs: Object.freeze(["minor_plumbing", "plumbing", "plumbing_repair"]),
  pool_builders: Object.freeze(["new_pool_construction"]),
  new_pool_construction: Object.freeze(["pool_builders"]),
  restaurant_cleaning: Object.freeze(["restaurant_kitchen_cleaning"]),
  restaurant_kitchen_cleaning: Object.freeze(["restaurant_cleaning"]),
  tile: Object.freeze(["tile_repair_installation"]),
  tile_repair_installation: Object.freeze(["tile"]),
  window_repair: Object.freeze(["doors_windows", "window_replacement"]),
  window_replacement: Object.freeze(["doors_windows", "window_repair"]),
});

function normalizeIdentifier(value = "") {
  const raw = String(value || "").trim();
  if (!raw || !/^[a-z0-9_]+$/i.test(raw)) return "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

function normalizeProfessionalServiceId(value = "") {
  const normalized = normalizeIdentifier(value);
  return PROFESSIONAL_CATEGORY_ALIASES[normalized] || normalized;
}

function normalizeRequestServiceId(value = "") {
  const normalized = normalizeIdentifier(value);
  return REQUEST_SERVICE_ALIASES[normalized] || normalized;
}

function getCanonicalServiceDomain(serviceId = "") {
  if (!PROFESSIONAL_SERVICE_IDS.has(serviceId)) return "";
  if (MARKETING_SERVICE_IDS.has(serviceId)) return "marketing";
  if (HEALTHCARE_SERVICE_IDS.has(serviceId)) return "healthcare";
  if (PROPERTY_MANAGEMENT_SERVICE_IDS.has(serviceId)) return "property_management";
  if (TRANSPORTATION_SERVICE_IDS.has(serviceId)) return "transportation";
  return "home_services";
}

function getProfessionalServiceDomain(value = "") {
  const serviceId = normalizeProfessionalServiceId(value);
  return getCanonicalServiceDomain(serviceId) || PROFESSIONAL_CATEGORY_DOMAINS[serviceId] || "";
}

function getRequestServiceDomain(value = "") {
  const serviceId = normalizeRequestServiceId(value);
  if (REQUEST_SERVICE_IDS.has(serviceId)) return getCanonicalServiceDomain(serviceId);
  return LEGACY_REQUEST_SERVICE_DOMAINS[serviceId] || "";
}

function addCompatibility(map, professionalId, requestId) {
  const normalizedProfessional = normalizeProfessionalServiceId(professionalId);
  const normalizedRequest = normalizeRequestServiceId(requestId);
  if (!normalizedProfessional || !normalizedRequest) return;
  if (!map.has(normalizedProfessional)) map.set(normalizedProfessional, new Set());
  map.get(normalizedProfessional).add(normalizedRequest);
}

function buildCategoryEligibility() {
  const map = new Map();

  COMPATIBILITY_FAMILIES.forEach((family) => {
    family.professionalParents.forEach((parent) => {
      family.services.forEach((serviceId) => addCompatibility(map, parent, serviceId));
      family.requestParents.forEach((requestId) => addCompatibility(map, parent, requestId));
    });
    family.services.forEach((serviceId) => {
      family.requestParents.forEach((requestId) => addCompatibility(map, serviceId, requestId));
    });
  });

  Object.entries(ADDITIONAL_COMPATIBILITY).forEach(([professionalId, requestIds]) => {
    requestIds.forEach((requestId) => addCompatibility(map, professionalId, requestId));
  });

  return Object.freeze(
    Object.fromEntries(
      [...map.entries()].map(([professionalId, requestIds]) => [
        professionalId,
        Object.freeze([...requestIds].sort()),
      ])
    )
  );
}

const CATEGORY_ELIGIBILITY = buildCategoryEligibility();

function isSupportedRequestService(value = "") {
  const serviceId = normalizeRequestServiceId(value);
  return REQUEST_SERVICE_IDS.has(serviceId) || Boolean(LEGACY_REQUEST_SERVICE_DOMAINS[serviceId]);
}

function isKnownProfessionalService(value = "") {
  const serviceId = normalizeProfessionalServiceId(value);
  return PROFESSIONAL_SERVICE_IDS.has(serviceId) || Boolean(PROFESSIONAL_CATEGORY_DOMAINS[serviceId]);
}

function isProfessionalServiceEligibleForRequest(professionalValue = "", requestValue = "") {
  const professionalId = normalizeProfessionalServiceId(professionalValue);
  const requestId = normalizeRequestServiceId(requestValue);
  const professionalDomain = getProfessionalServiceDomain(professionalId);
  const requestDomain = getRequestServiceDomain(requestId);

  if (!professionalDomain || !requestDomain || professionalDomain !== requestDomain) return false;
  if (!isKnownProfessionalService(professionalId) || !isSupportedRequestService(requestId)) return false;
  if (professionalId === requestId) return true;
  return CATEGORY_ELIGIBILITY[professionalId]?.includes(requestId) === true;
}

function getEligibleProfessionalServiceIdsForRequest(requestValue = "") {
  const requestId = normalizeRequestServiceId(requestValue);
  if (!isSupportedRequestService(requestId)) return [];
  return [...PROFESSIONAL_SERVICE_IDS]
    .filter((professionalId) =>
      isProfessionalServiceEligibleForRequest(professionalId, requestId)
    )
    .sort();
}

function getTaxonomyCompatibilityInventory() {
  return [...PROFESSIONAL_SERVICE_IDS]
    .sort()
    .map((professionalServiceId) => ({
      professionalServiceId,
      domain: getCanonicalServiceDomain(professionalServiceId),
      homeownerRequestId: REQUEST_SERVICE_IDS.has(professionalServiceId)
        ? professionalServiceId
        : "",
      expectedCompatibility: REQUEST_SERVICE_IDS.has(professionalServiceId)
        ? "exact"
        : "intentionally_unsupported",
      status: REQUEST_SERVICE_IDS.has(professionalServiceId)
        ? "PASS"
        : "ORPHAN_PROFESSIONAL_SERVICE",
    }));
}

module.exports = {
  CATEGORY_ELIGIBILITY,
  COMPATIBILITY_FAMILIES,
  LEGACY_REQUEST_SERVICE_DOMAINS,
  MARKETING_SERVICE_IDS,
  PROFESSIONAL_CATEGORY_ALIASES,
  REQUEST_SERVICE_IDS,
  REQUEST_SERVICE_ALIASES,
  SUPPORTED_REQUEST_DOMAINS,
  getEligibleProfessionalServiceIdsForRequest,
  getProfessionalServiceDomain,
  getRequestServiceDomain,
  getTaxonomyCompatibilityInventory,
  isKnownProfessionalService,
  isProfessionalServiceEligibleForRequest,
  isSupportedRequestService,
  normalizeProfessionalServiceId,
  normalizeRequestServiceId,
};
