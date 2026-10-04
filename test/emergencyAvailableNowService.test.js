"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listHomeownerAvailableEmergencyProfessionals,
  professionalCanBeDirectSelectedForEmergency,
  serializeHomeownerAvailableEmergencyProfessional,
} = require(
  "../server/emergency/emergencyOpportunityService"
);

const FORBIDDEN_SQL =
  /\b(?:BEGIN|COMMIT|ROLLBACK|FOR\s+UPDATE|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i;

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function request(overrides = {}) {
  return {
    id: 41,
    homeowner_id: 9,
    category: "home_repair",
    service_domain: "home_services",
    service_specialty: "electrical",
    location_text: "Cape Coral, FL",
    status: "ready_for_distribution",
    requested_at: "2026-09-21T20:00:00.000Z",
    created_at: "2026-09-21T19:55:00.000Z",
    updated_at: "2026-09-21T20:05:00.000Z",
    expired_at: null,
    disposition: "continue",
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: 17,
    user_id: 7,
    business_name: "Cape Electric",
    category: "electrical",
    image_url: "",
    profile_details: {
      service_specialties: ["electrical"],
      service_area: "Cape Coral",
      city: "Cape Coral",
      postal_code: "33904",
      available_now: true,
      dispatch_ready: true,
    },
    ...overrides,
  };
}

function createPool({
  requests = [request()],
  profiles = [profile()],
} = {}) {
  const calls = [];

  return {
    calls,
    async query(sql, values = []) {
      const source = normalizedSql(sql);
      calls.push({ sql: source, values });

      assert.doesNotMatch(source, FORBIDDEN_SQL);

      if (source.includes("FROM emergency_requests")) {
        return { rows: requests };
      }

      if (source.includes("FROM contractor_profiles")) {
        return { rows: profiles };
      }

      throw new Error(`Unexpected query: ${source}`);
    },
  };
}

test("invalid Emergency ID fails before database access", async () => {
  const pool = createPool();

  const result =
    await listHomeownerAvailableEmergencyProfessionals({
      pool,
      homeownerUserId: 9,
      emergencyRequestId: "invalid",
    });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(
    result.code,
    "INVALID_EMERGENCY_REQUEST_ID"
  );
  assert.equal(pool.calls.length, 0);
});

test("homeowner must own the Emergency request", async () => {
  const pool = createPool({ requests: [] });

  const result =
    await listHomeownerAvailableEmergencyProfessionals({
      pool,
      homeownerUserId: 9,
      emergencyRequestId: 41,
    });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(
    result.code,
    "EMERGENCY_REQUEST_NOT_FOUND"
  );
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].values, [41, 9]);
});

test("only distributable safety-cleared unexpired requests allow discovery", async () => {
  for (const emergencyRequest of [
    request({ status: "assigned" }),
    request({ disposition: "block" }),
    request({
      expired_at: "2026-09-21T21:00:00.000Z",
    }),
  ]) {
    const pool = createPool({
      requests: [emergencyRequest],
    });

    const result =
      await listHomeownerAvailableEmergencyProfessionals({
        pool,
        homeownerUserId: 9,
        emergencyRequestId: 41,
      });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(
      result.code,
      "EMERGENCY_REQUEST_NOT_DISCOVERABLE"
    );
    assert.equal(pool.calls.length, 1);
  }
});

test("Available Now discovery requires both canonical availability flags and excludes existing relationships", async () => {
  const pool = createPool();

  const result =
    await listHomeownerAvailableEmergencyProfessionals({
      pool,
      homeownerUserId: 9,
      emergencyRequestId: 41,
    });

  assert.equal(result.ok, true);
  assert.equal(result.professionals.length, 1);

  const profileQuery = pool.calls.find((call) =>
    call.sql.includes("FROM contractor_profiles")
  );

  assert.ok(profileQuery);
  assert.match(
    profileQuery.sql,
    /profile_details @> '\{"available_now": true, "dispatch_ready": true\}'::jsonb/
  );
  assert.match(profileQuery.sql, /NOT EXISTS/);
  assert.match(
    profileQuery.sql,
    /request_relationships\.emergency_request_id = \$2/
  );
  assert.match(
    profileQuery.sql,
    /request_relationships\.contractor_id = contractor_profiles\.id/
  );
  assert.deepEqual(profileQuery.values, [9, 41]);
});

test("specialty domain and service-area matching are reused for direct selection", () => {
  assert.equal(
    professionalCanBeDirectSelectedForEmergency(
      profile(),
      request()
    ),
    true
  );

  assert.equal(
    professionalCanBeDirectSelectedForEmergency(
      profile({
        profile_details: {
          ...profile().profile_details,
          available_now: false,
        },
      }),
      request()
    ),
    false
  );

  assert.equal(
    professionalCanBeDirectSelectedForEmergency(
      profile({
        profile_details: {
          ...profile().profile_details,
          dispatch_ready: false,
        },
      }),
      request()
    ),
    false
  );

  assert.equal(
    professionalCanBeDirectSelectedForEmergency(
      profile({
        profile_details: {
          ...profile().profile_details,
          service_area: "Miami",
          city: "Miami",
          postal_code: "33101",
        },
      }),
      request()
    ),
    false
  );
});

test("homeowner projection is bounded to safe professional fields", async () => {
  const pool = createPool();

  const result =
    await listHomeownerAvailableEmergencyProfessionals({
      pool,
      homeownerUserId: 9,
      emergencyRequestId: 41,
    });

  assert.deepEqual(result.professionals, [
    {
      contractorProfileId: 17,
      businessName: "Cape Electric",
      category: "electrical",
      serviceSpecialties: ["electrical"],
      profileImageUrl: "",
      serviceArea: "Cape Coral",
      availableNow: true,
      dispatchReady: true,
    },
  ]);

  const serialized =
    serializeHomeownerAvailableEmergencyProfessional(
      profile()
    );

  for (const forbidden of [
    "userId",
    "professionalUserId",
    "phone",
    "streetAddress",
    "homeownerId",
    "locationText",
    "relationshipId",
    "conversationId",
  ]) {
    assert.equal(
      Object.hasOwn(serialized, forbidden),
      false
    );
  }
});

test("false availability rows fail closed even if returned unexpectedly by storage", async () => {
  const pool = createPool({
    profiles: [
      profile({
        id: 18,
        profile_details: {
          ...profile().profile_details,
          available_now: false,
        },
      }),
      profile(),
    ],
  });

  const result =
    await listHomeownerAvailableEmergencyProfessionals({
      pool,
      homeownerUserId: 9,
      emergencyRequestId: 41,
    });

  assert.deepEqual(
    result.professionals.map(
      (professional) =>
        professional.contractorProfileId
    ),
    [17]
  );
});
