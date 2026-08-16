"use strict";

const HOME_DEPOT_RETAILER = "HOME_DEPOT";
const RETAILER_REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AVAILABILITY = new Set(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "UNKNOWN"]);
const SOURCE_METHODS = new Set([
  "GOVERNED_PROVIDER_REFERENCE",
  "PROFESSIONAL_VERIFIED_REFERENCE",
]);

function contractError(message) {
  return Object.assign(new Error(message), { code: "retailer_reference_invalid" });
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys) {
  return plain(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function text(value, maximum, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum) {
    throw contractError("Retailer reference text is invalid.");
  }
  return value;
}

function normalizeRetailerReference(value, { now = Date.now() } = {}) {
  const keys = [
    "id",
    "retailer",
    "productName",
    "productUrl",
    "storeContext",
    "retrievedAt",
    "unitLabel",
    "packSize",
    "listedPriceMinor",
    "currency",
    "availability",
    "sourceMethod",
  ];
  if (!exact(value, keys)) throw contractError("Retailer reference fields are invalid.");
  const id = text(value.id, 120);
  if (!/^[a-z0-9][a-z0-9_.:-]{0,119}$/i.test(id)) {
    throw contractError("Retailer reference identity is invalid.");
  }
  if (value.retailer !== HOME_DEPOT_RETAILER) {
    throw contractError("The retailer reference is unsupported.");
  }
  let productUrl;
  try {
    productUrl = new URL(text(value.productUrl, 2000));
  } catch {
    throw contractError("Retailer product URL is invalid.");
  }
  if (
    productUrl.protocol !== "https:" ||
    !["homedepot.com", "www.homedepot.com"].includes(productUrl.hostname.toLowerCase())
  ) {
    throw contractError("Retailer product URL is not an approved Home Depot URL.");
  }
  const retrievedAt = new Date(text(value.retrievedAt, 40));
  if (
    Number.isNaN(retrievedAt.getTime()) ||
    retrievedAt.getTime() > now + 5 * 60 * 1000 ||
    now - retrievedAt.getTime() > RETAILER_REFERENCE_MAX_AGE_MS
  ) {
    throw contractError("Retailer reference is not current.");
  }
  const listedPriceMinor = Number(value.listedPriceMinor);
  if (!Number.isSafeInteger(listedPriceMinor) || listedPriceMinor <= 0) {
    throw contractError("Retailer reference price is invalid.");
  }
  if (value.currency !== "USD" || !AVAILABILITY.has(value.availability)) {
    throw contractError("Retailer reference pricing metadata is invalid.");
  }
  if (!SOURCE_METHODS.has(value.sourceMethod)) {
    throw contractError("Retailer reference source is not governed.");
  }
  return Object.freeze({
    id,
    retailer: HOME_DEPOT_RETAILER,
    productName: text(value.productName, 500),
    productUrl: productUrl.toString(),
    storeContext: text(value.storeContext, 300, { nullable: true }),
    retrievedAt: retrievedAt.toISOString(),
    unitLabel: text(value.unitLabel, 120),
    packSize: text(value.packSize, 120),
    listedPriceMinor,
    currency: "USD",
    availability: value.availability,
    sourceMethod: value.sourceMethod,
    priceClassification: "REFERENCE_NOT_GUARANTEED",
    customerVisibleByDefault: false,
  });
}

async function loadGovernedRetailerReferences({ adapter, query, context }) {
  if (!adapter || typeof adapter.findReferences !== "function") return [];
  const values = await adapter.findReferences({
    retailer: HOME_DEPOT_RETAILER,
    query,
    context,
  });
  if (!Array.isArray(values) || values.length > 20) {
    throw contractError("Retailer adapter returned an invalid collection.");
  }
  return values.map((value) => normalizeRetailerReference(value));
}

module.exports = {
  HOME_DEPOT_RETAILER,
  RETAILER_REFERENCE_MAX_AGE_MS,
  loadGovernedRetailerReferences,
  normalizeRetailerReference,
};
