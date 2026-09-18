"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  professionalCanSeeRequest,
} = require("../server/requests/requestLifecycle");

const opportunitySource = readFileSync(
  "server/requests/professionalOpportunityService.js",
  "utf8"
);

function profile() {
  return {
    category: "painting",
    profile_details: JSON.stringify({
      service_specialties: ["painting"],
      service_area: "Cape Coral",
    }),
  };
}

function request(overrides = {}) {
  return {
    status: "open",
    request_origin: "marketplace",
    service_domain: "home_services",
    service_specialty: "painting",
    request_category: "painting",
    location_normalization_status: "normalized",
    discovery_area_label: "Cape Coral",
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    ...overrides,
  };
}

test("normal marketplace requests retain professional eligibility", () => {
  assert.equal(
    professionalCanSeeRequest(
      profile(),
      request()
    ),
    true
  );
});

test("existing-customer requests can never become marketplace opportunities", () => {
  assert.equal(
    professionalCanSeeRequest(
      profile(),
      request({
        request_origin:
          "existing_customer_request",
      })
    ),
    false
  );
});

test("legacy rows without request_origin remain marketplace-compatible", () => {
  const legacy = request();
  delete legacy.request_origin;

  assert.equal(
    professionalCanSeeRequest(profile(), legacy),
    true
  );
});

test("opportunity SQL excludes existing-customer requests before response projection", () => {
  assert.match(
    opportunitySource,
    /COALESCE\(posts\.request_origin, 'marketplace'\) = 'marketplace'/
  );

  const sourceIndex = opportunitySource.indexOf(
    "FROM posts"
  );
  const responseIndex = opportunitySource.indexOf(
    "FROM request_relationships"
  );

  assert.ok(sourceIndex >= 0);
  assert.ok(responseIndex > sourceIndex);
  assert.ok(
    opportunitySource.indexOf(
      "COALESCE(posts.request_origin, 'marketplace') = 'marketplace'"
    ) < responseIndex
  );
});

test("marketplace eligibility contains no Saved Professional or business Contact authority", () => {
  const source = readFileSync(
    "server/requests/requestLifecycle.js",
    "utf8"
  );

  const start = source.indexOf(
    "function professionalCanSeeRequest"
  );
  const end = source.indexOf(
    "function serializeOwnedRequest",
    start
  );
  const body = source.slice(start, end);

  assert.doesNotMatch(
    body,
    /homeowner_saved_professionals|business_contacts|business_customer_relationships/
  );

  assert.match(
    body,
    /request\.request_origin \|\| "marketplace"/
  );
});
