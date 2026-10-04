"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  loadGovernedRetailerReferences,
  normalizeRetailerReference,
} = require("../server/intelligence/retailerReferenceContract");

function reference(overrides = {}) {
  return {
    id: "hd_concrete_80lb",
    retailer: "HOME_DEPOT",
    productName: "80 lb concrete mix",
    productUrl: "https://www.homedepot.com/p/example/100000001",
    storeContext: "Cape Coral, FL",
    retrievedAt: "2026-08-15T12:00:00.000Z",
    unitLabel: "bag",
    packSize: "80 lb",
    listedPriceMinor: 697,
    currency: "USD",
    availability: "UNKNOWN",
    sourceMethod: "GOVERNED_PROVIDER_REFERENCE",
    ...overrides,
  };
}

test("Home Depot reference is current, provenance-bearing, internal by default, and not guaranteed", () => {
  const normalized = normalizeRetailerReference(reference(), {
    now: Date.parse("2026-08-15T13:00:00.000Z"),
  });
  assert.equal(normalized.priceClassification, "REFERENCE_NOT_GUARANTEED");
  assert.equal(normalized.customerVisibleByDefault, false);
  assert.equal(normalized.listedPriceMinor, 697);
});

test("retailer contract rejects wrong domains, stale prices, and ungoverned sources", () => {
  const now = Date.parse("2026-08-15T13:00:00.000Z");
  assert.throws(() => normalizeRetailerReference(reference({ productUrl: "https://example.com/item" }), { now }));
  assert.throws(() => normalizeRetailerReference(reference({ retrievedAt: "2026-08-13T12:00:00.000Z" }), { now }));
  assert.throws(() => normalizeRetailerReference(reference({ sourceMethod: "SCRAPED_BROWSER_HTML" }), { now }));
});

test("no configured retailer adapter returns no invented references", async () => {
  assert.deepEqual(await loadGovernedRetailerReferences({
    adapter: null,
    query: "concrete mix",
    context: {},
  }), []);
});
