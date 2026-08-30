"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  professionalCanSeeEmergencyOpportunity,
} = require("../server/emergency/emergencyOpportunityService");
const {
  createProfessionalEmergencyResponse,
} = require("../server/relationships/requestRelationshipService");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function eligibleProfile(overrides = {}) {
  return {
    id: 80,
    user_id: 9,
    category: "electrical",
    profile_details: {
      service_specialties: ["electrical"],
      service_area: "Cape Coral",
      city: "Cape Coral",
      postal_code: "33904",
      ...overrides.profile_details,
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "profile_details")
    ),
  };
}

function eligibleEmergency(overrides = {}) {
  return {
    id: 41,
    homeowner_id: 7,
    category: "home_repair",
    service_domain: "home_services",
    service_specialty: "emergency_electrical_service",
    title: "Partial power outage",
    description: "Several rooms have lost power.",
    location_text: "Cape Coral, FL 33904",
    status: "ready_for_distribution",
    requested_at: "requested",
    created_at: "created",
    updated_at: "updated",
    expired_at: null,
    disposition: "continue",
    ...overrides,
  };
}

function pendingRelationship(overrides = {}) {
  return {
    id: 151,
    post_id: null,
    emergency_request_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "pending",
    introduction_text: "",
    created_at: "relationship-created",
    responded_at: "relationship-responded",
    updated_at: "relationship-updated",
    created: true,
    ...overrides,
  };
}

function createPool({
  profileRows = [eligibleProfile()],
  emergencyRows = [eligibleEmergency()],
  relationshipRows = [pendingRelationship()],
  failOn = null,
  useConnect = true,
} = {}) {
  const calls = [];
  let released = 0;

  const client = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (failOn && sql.includes(failOn)) {
        throw new Error("simulated Emergency response failure");
      }
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("FROM contractor_profiles")) {
        return { rows: profileRows };
      }
      if (sql.includes("FROM emergency_requests")) {
        return { rows: emergencyRows };
      }
      if (sql.includes("INSERT INTO request_relationships")) {
        return { rows: relationshipRows };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      released += 1;
    },
  };

  return {
    calls,
    pool: useConnect
      ? {
          async connect() {
            return client;
          },
          query: client.query.bind(client),
        }
      : client,
    released: () => released,
  };
}

function respond(pool, overrides = {}) {
  return createProfessionalEmergencyResponse({
    pool,
    professionalUserId: 9,
    emergencyRequestId: 41,
    payload: {},
    professionalCanSeeEmergencyOpportunity,
    projectEmergencyResponseAlert: async () => ({
      alertId: 901,
      created: true,
    }),
    ...overrides,
  });
}

test("invalid Emergency IDs and unsupported bodies fail before database access", async () => {
  for (const emergencyRequestId of ["", "0", "41abc", -1, null]) {
    const fake = createPool();
    const result = await respond(fake.pool, { emergencyRequestId });
    assert.equal(result.status, 400);
    assert.equal(result.code, "INVALID_EMERGENCY_REQUEST_ID");
    assert.equal(fake.calls.length, 0);
  }

  for (const payload of [
    null,
    [],
    "response",
    1,
    true,
    { introduction_text: "I can help." },
    { professionalUserId: 999 },
    { status: "active" },
  ]) {
    const fake = createPool();
    const result = await respond(fake.pool, { payload });
    assert.equal(result.status, 400);
    assert.equal(result.code, "UNSUPPORTED_EMERGENCY_RESPONSE_FIELDS");
    assert.equal(fake.calls.length, 0);
  }
});

test("missing and empty bodies are both accepted", async () => {
  for (const payload of [undefined, {}]) {
    const fake = createPool();
    const result = await respond(fake.pool, { payload });
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);
  }
});

test("owned profile lookup is authenticated, deterministic, and required", async () => {
  const missing = createPool({ profileRows: [] });
  const missingResult = await respond(missing.pool);
  assert.equal(missingResult.status, 403);
  assert.equal(missingResult.code, "PROFESSIONAL_PROFILE_REQUIRED");
  assert.equal(
    missing.calls.some((call) => call.sql.includes("FROM emergency_requests")),
    false
  );

  const fake = createPool();
  await respond(fake.pool);
  const query = fake.calls.find((call) =>
    call.sql.includes("FROM contractor_profiles")
  );
  assert.deepEqual(query.values, [9]);
  assert.match(query.sql, /WHERE user_id = \$1/);
  assert.match(query.sql, /ORDER BY id ASC LIMIT 1 FOR SHARE/);
});

test("Emergency lookup locks and enforces every availability and safety condition", async () => {
  const fake = createPool();
  await respond(fake.pool);
  const query = fake.calls.find((call) =>
    call.sql.includes("FROM emergency_requests")
  );
  assert.deepEqual(query.values, [41, 9]);
  assert.match(query.sql, /emergency_requests\.id = \$1/);
  assert.match(query.sql, /status = 'ready_for_distribution'/);
  assert.match(query.sql, /homeowner_id <> \$2/);
  assert.match(query.sql, /expired_at IS NULL/);
  assert.match(query.sql, /INNER JOIN emergency_request_safety_assessments/);
  assert.match(query.sql, /disposition = 'continue'/);
  assert.match(query.sql, /FOR UPDATE OF emergency_requests/);

  const unavailable = createPool({ emergencyRows: [] });
  const result = await respond(unavailable.pool);
  assert.equal(result.status, 404);
  assert.equal(result.code, "EMERGENCY_OPPORTUNITY_NOT_AVAILABLE");
  assert.equal(
    unavailable.calls.some((call) =>
      call.sql.includes("INSERT INTO request_relationships")
    ),
    false
  );
});

test("specialty, domain, location, profile specialty, and service area are revalidated", async () => {
  const cases = [
    { emergencyRows: [eligibleEmergency({ service_specialty: "plumbing" })] },
    { emergencyRows: [eligibleEmergency({ service_domain: "healthcare" })] },
    { emergencyRows: [eligibleEmergency({ location_text: "Miami, FL" })] },
    {
      profileRows: [
        eligibleProfile({ profile_details: { service_specialties: [] } }),
      ],
    },
    {
      profileRows: [
        eligibleProfile({
          profile_details: {
            service_area: "",
            city: "",
            postal_code: "",
          },
        }),
      ],
    },
  ];

  for (const options of cases) {
    const fake = createPool(options);
    const result = await respond(fake.pool);
    assert.equal(result.status, 403);
    assert.equal(result.code, "EMERGENCY_OPPORTUNITY_NOT_ELIGIBLE");
    assert.equal(
      fake.calls.some((call) =>
        call.sql.includes("INSERT INTO request_relationships")
      ),
      false
    );
  }
});

test("availability and dispatch readiness never gate a valid response", async () => {
  for (const flags of [
    { available_now: false, dispatch_ready: false },
    {},
  ]) {
    const fake = createPool({
      profileRows: [
        eligibleProfile({
          profile_details: {
            service_specialties: ["electrical"],
            service_area: "Cape Coral",
            ...flags,
          },
        }),
      ],
    });
    const result = await respond(fake.pool);
    assert.equal(result.ok, true);
  }
});

test("valid response inserts exactly one pending Emergency relationship", async () => {
  const fake = createPool();
  const result = await respond(fake.pool);
  assert.equal(result.status, 201);
  assert.equal(result.code, "EMERGENCY_RESPONSE_CREATED");
  assert.equal(result.created, true);

  const insert = fake.calls.find((call) =>
    call.sql.includes("INSERT INTO request_relationships")
  );
  assert.deepEqual(insert.values, [41, 7, 80, 9]);
  assert.match(insert.sql, /post_id, emergency_request_id/);
  assert.match(insert.sql, /VALUES \(NULL, \$1, \$2, \$3, \$4, 'pending', ''\)/);
  assert.match(
    insert.sql,
    /ON CONFLICT \(emergency_request_id, contractor_id\) WHERE emergency_request_id IS NOT NULL DO NOTHING/
  );
  assert.match(insert.sql, /professional_user_id = \$4/);
});

test("duplicate pending response returns the original row without mutation", async () => {
  const original = pendingRelationship({
    created: false,
    created_at: "original-created",
    responded_at: "original-responded",
    updated_at: "original-updated",
  });
  const fake = createPool({ relationshipRows: [original] });
  const result = await respond(fake.pool);

  assert.equal(result.status, 200);
  assert.equal(result.code, "EMERGENCY_RESPONSE_EXISTS");
  assert.equal(result.created, false);
  assert.equal(result.relationship.created_at, "original-created");
  assert.equal(result.relationship.responded_at, "original-responded");
  assert.equal(result.relationship.updated_at, "original-updated");
  assert.equal(
    fake.calls.some((call) => call.sql.startsWith("UPDATE")),
    false
  );
});

test("existing non-pending Emergency relationships return conflict", async () => {
  for (const status of ["active", "declined", "withdrawn", "closed"]) {
    const fake = createPool({
      relationshipRows: [pendingRelationship({ status, created: false })],
    });
    const result = await respond(fake.pool);
    assert.equal(result.status, 409);
    assert.equal(result.code, "EMERGENCY_RESPONSE_NOT_PENDING");
    assert.equal(
      fake.calls.some((call) => call.sql === "COMMIT"),
      false
    );
  }
});

function createStatefulPool() {
  const calls = [];
  const relationships = new Map();
  const profiles = new Map([
    [9, eligibleProfile()],
    [10, eligibleProfile({ id: 81, user_id: 10 })],
  ]);
  let nextId = 151;
  let released = 0;

  function client() {
    return {
      async query(text, values = []) {
        const sql = normalizeSql(text);
        calls.push({ sql, values });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
        if (sql.includes("FROM contractor_profiles")) {
          return { rows: profiles.has(values[0]) ? [profiles.get(values[0])] : [] };
        }
        if (sql.includes("FROM emergency_requests")) {
          return { rows: [eligibleEmergency()] };
        }
        if (sql.includes("INSERT INTO request_relationships")) {
          const [emergencyRequestId, homeownerId, contractorId, professionalUserId] = values;
          const key = `${emergencyRequestId}:${contractorId}`;
          const existing = relationships.get(key);
          if (existing) return { rows: [{ ...existing, created: false }] };
          const relationship = pendingRelationship({
            id: nextId++,
            emergency_request_id: emergencyRequestId,
            homeowner_id: homeownerId,
            contractor_id: contractorId,
            professional_user_id: professionalUserId,
          });
          relationships.set(key, relationship);
          return { rows: [{ ...relationship, created: true }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {
        released += 1;
      },
    };
  }

  return {
    calls,
    relationships,
    released: () => released,
    pool: {
      query() {},
      async connect() {
        return client();
      },
    },
  };
}

test("different professionals may respond while concurrent duplicates resolve once", async () => {
  const fake = createStatefulPool();
  const firstProfessional = await respond(fake.pool);
  const secondProfessional = await respond(fake.pool, {
    professionalUserId: 10,
  });
  assert.equal(firstProfessional.status, 201);
  assert.equal(secondProfessional.status, 201);
  assert.equal(fake.relationships.size, 2);

  const duplicatePool = createStatefulPool();
  const results = await Promise.all([
    respond(duplicatePool.pool),
    respond(duplicatePool.pool),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
  assert.equal(duplicatePool.relationships.size, 1);
});

test("response SQL never creates communication or mutates Emergency lifecycle state", async () => {
  const fake = createPool();
  await respond(fake.pool);
  const sql = fake.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(sql, /INSERT INTO conversations/i);
  assert.doesNotMatch(sql, /INSERT INTO messages/i);
  assert.doesNotMatch(sql, /UPDATE emergency_requests/i);
  assert.doesNotMatch(sql, /DELETE FROM/i);
  assert.doesNotMatch(sql, /visibility/i);
  assert.doesNotMatch(sql, /VALUES \(\$1, [^)]*'active'/i);
  assert.equal(fake.calls.filter((call) => call.sql === "COMMIT").length, 1);
  assert.equal(fake.released(), 1);
});

test("database failures roll back and release while invalid dependencies fail directly", async () => {
  const fake = createPool({ failOn: "INSERT INTO request_relationships" });
  await assert.rejects(respond(fake.pool), /simulated Emergency response failure/);
  assert.equal(fake.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(fake.calls.some((call) => call.sql === "COMMIT"), false);
  assert.equal(fake.released(), 1);

  await assert.rejects(
    respond({}),
    /database pool or client is required/i
  );
});
