"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listProfessionalEmergencyOpportunities,
  professionalCanSeeEmergencyOpportunity,
  serializeProfessionalEmergencyParticipation,
  serializeProfessionalEmergencyOpportunity,
} = require("../server/emergency/emergencyOpportunityService");

const FORBIDDEN_SQL =
  /\b(?:BEGIN|COMMIT|ROLLBACK|FOR\s+UPDATE|INSERT\s+INTO|UPDATE\s+emergency_requests|DELETE\s+FROM)\b/i;

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function eligibleProfile({
  profileDetails,
  details = {},
  ...overrides
} = {}) {
  return {
    id: 17,
    user_id: 7,
    category: "electrical",
    profile_details:
      profileDetails === undefined
        ? {
            service_specialties: ["electrical"],
            service_area: "Cape Coral",
            city: "Cape Coral",
            postal_code: "33904",
            available_now: true,
            dispatch_ready: true,
            ...details,
          }
        : profileDetails,
    ...overrides,
  };
}

function distributableEmergency(overrides = {}) {
  return {
    id: 41,
    homeowner_id: 9,
    category: "home_repair",
    service_domain: "home_services",
    service_specialty: "electrical",
    title: "Partial power outage",
    description: "Several rooms have lost power.",
    location_text: "Cape Coral, FL",
    status: "ready_for_distribution",
    requested_at: "2026-07-24T14:00:00.000Z",
    created_at: "2026-07-24T13:55:00.000Z",
    updated_at: "2026-07-24T14:05:00.000Z",
    disposition: "continue",
    participation_status: null,
    ...overrides,
  };
}

function createReadOnlyPool({
  profiles = [eligibleProfile()],
  opportunities = [distributableEmergency()],
  profileError,
  opportunityError,
} = {}) {
  const calls = [];

  return {
    calls,
    async query(sql, values = []) {
      const source = normalizedSql(sql);
      calls.push({ sql: source, values });
      assert.doesNotMatch(source, FORBIDDEN_SQL);

      if (source.includes("FROM contractor_profiles")) {
        if (profileError) throw profileError;
        return { rows: profiles };
      }

      if (source.includes("FROM emergency_requests")) {
        if (opportunityError) throw opportunityError;
        return { rows: opportunities };
      }

      throw new Error(`Unexpected read query: ${source}`);
    },
  };
}

function emergencyQueries(pool) {
  return pool.calls.filter((call) =>
    call.sql.includes("FROM emergency_requests")
  );
}

test("owned professional profile is required before Emergency retrieval", async () => {
  const pool = createReadOnlyPool({ profiles: [] });

  const result = await listProfessionalEmergencyOpportunities({
    pool,
    professionalUserId: 7,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    code: "PROFESSIONAL_PROFILE_REQUIRED",
    message: "A business profile is required to view Emergency opportunities.",
  });
  assert.equal(emergencyQueries(pool).length, 0);
  assert.deepEqual(pool.calls[0].values, [7]);
});

test("availability and dispatch readiness do not gate Emergency visibility", async () => {
  const absentVisibilityFields = {
    service_specialties: ["electrical"],
    service_area: "Cape Coral",
    city: "Cape Coral",
    postal_code: "33904",
  };

  for (const profileDetails of [
    eligibleProfile({
      details: { available_now: false, dispatch_ready: true },
    }).profile_details,
    eligibleProfile({
      details: { available_now: true, dispatch_ready: false },
    }).profile_details,
    absentVisibilityFields,
  ]) {
    const pool = createReadOnlyPool({
      profiles: [eligibleProfile({ profileDetails })],
    });

    const result = await listProfessionalEmergencyOpportunities({
      pool,
      professionalUserId: 7,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.opportunities.length, 1);
    assert.equal(emergencyQueries(pool).length, 1);
  }
});

test("usable service specialty and service area remain required", async () => {
  for (const profileDetails of [
    {
      service_specialties: [],
      service_area: "Cape Coral",
    },
    {
      service_specialties: ["unsupported_service"],
      service_area: "Cape Coral",
    },
    {
      service_specialties: ["electrical"],
      service_area: "",
      city: "",
      postal_code: "",
    },
  ]) {
    const pool = createReadOnlyPool({
      profiles: [eligibleProfile({ profileDetails })],
    });
    const result = await listProfessionalEmergencyOpportunities({
      pool,
      professionalUserId: 7,
    });

    assert.deepEqual(result.opportunities, []);
    assert.equal(emergencyQueries(pool).length, 0);
  }
});

test("profile details support object and JSON-string forms and malformed JSON fails closed", async () => {
  const objectDetails = eligibleProfile().profile_details;

  for (const profileDetails of [
    objectDetails,
    JSON.stringify(objectDetails),
  ]) {
    const pool = createReadOnlyPool({
      profiles: [eligibleProfile({ profileDetails })],
    });
    const result = await listProfessionalEmergencyOpportunities({
      pool,
      professionalUserId: 7,
    });

    assert.equal(result.opportunities.length, 1);
  }

  const malformedPool = createReadOnlyPool({
    profiles: [eligibleProfile({ profileDetails: "{not-json" })],
  });
  const malformedResult = await listProfessionalEmergencyOpportunities({
    pool: malformedPool,
    professionalUserId: 7,
  });

  assert.deepEqual(malformedResult.opportunities, []);
  assert.equal(emergencyQueries(malformedPool).length, 0);
});

test("query selects only safety-cleared distributable requests in stable order", async () => {
  const pool = createReadOnlyPool();

  await listProfessionalEmergencyOpportunities({
    pool,
    professionalUserId: 7,
  });

  const [query] = emergencyQueries(pool);
  assert.ok(query);
  assert.match(query.sql, /INNER JOIN emergency_request_safety_assessments/);
  assert.match(query.sql, /emergency_requests\.status = 'ready_for_distribution'/);
  assert.match(query.sql, /emergency_request_safety_assessments\.disposition = 'continue'/);
  assert.match(query.sql, /emergency_requests\.homeowner_id <> \$1/);
  assert.match(
    query.sql,
    /requested_at DESC NULLS LAST, emergency_requests\.created_at DESC, emergency_requests\.id DESC/
  );
  assert.deepEqual(query.values, [7, 17]);
  assert.match(
    query.sql,
    /request_relationships\.emergency_request_id = emergency_requests\.id/
  );
  assert.match(query.sql, /request_relationships\.contractor_id = \$2/);
  assert.match(
    query.sql,
    /request_relationships\.professional_user_id = \$1/
  );
  assert.match(query.sql, /request_relationships\.post_id IS NULL/);
  assert.match(
    query.sql,
    /ORDER BY request_relationships\.id ASC LIMIT 1/
  );
  assert.doesNotMatch(
    query.sql,
    /unit_number|access_notes|additional_safety_context|homeowner.*(?:email|phone)|conversation_id|relationship_id/i
  );
});

test("canonical electrical Emergency remains visible and privacy-safe", async () => {
  const pool = createReadOnlyPool();

  const result = await listProfessionalEmergencyOpportunities({
    pool,
    professionalUserId: 7,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "EMERGENCY_OPPORTUNITIES_FOUND");
  assert.deepEqual(result.opportunities, [
    {
      id: 41,
      sourceType: "emergency",
      category: "home_repair",
      serviceDomain: "home_services",
      serviceSpecialty: "electrical",
      title: "Partial power outage",
      description: "Several rooms have lost power.",
      status: "ready_for_distribution",
      requestedAt: "2026-07-24T14:00:00.000Z",
      createdAt: "2026-07-24T13:55:00.000Z",
      updatedAt: "2026-07-24T14:05:00.000Z",
      participation: null,
      relationship: null,
      conversation: null,
    },
  ]);
});

test("participation is scoped to the exact authenticated professional identity", async () => {
  const request = distributableEmergency({ participation_status: "pending" });
  const firstPool = createReadOnlyPool({
    profiles: [eligibleProfile({ id: 17, user_id: 7 })],
    opportunities: [request],
  });
  const secondPool = createReadOnlyPool({
    profiles: [eligibleProfile({ id: 18, user_id: 8 })],
    opportunities: [
      distributableEmergency({ participation_status: null }),
    ],
  });

  const first = await listProfessionalEmergencyOpportunities({
    pool: firstPool,
    professionalUserId: 7,
  });
  const second = await listProfessionalEmergencyOpportunities({
    pool: secondPool,
    professionalUserId: 8,
  });

  assert.deepEqual(first.opportunities[0].participation, {
    state: "pending",
  });
  assert.equal(second.opportunities[0].participation, null);
  assert.deepEqual(emergencyQueries(firstPool)[0].values, [7, 17]);
  assert.deepEqual(emergencyQueries(secondPool)[0].values, [8, 18]);
});

test("separate professional responses expose only their own bounded participation", async () => {
  for (const [professionalUserId, contractorId, state] of [
    [7, 17, "pending"],
    [8, 18, "declined"],
  ]) {
    const pool = createReadOnlyPool({
      profiles: [
        eligibleProfile({ id: contractorId, user_id: professionalUserId }),
      ],
      opportunities: [
        distributableEmergency({ participation_status: state }),
      ],
    });
    const result = await listProfessionalEmergencyOpportunities({
      pool,
      professionalUserId,
    });

    assert.deepEqual(result.opportunities[0].participation, { state });
    assert.deepEqual(emergencyQueries(pool)[0].values, [
      professionalUserId,
      contractorId,
    ]);
  }
});

test("canonical relationship states remain visible and unexpected states fail closed", () => {
  for (const state of [
    "pending",
    "active",
    "declined",
    "withdrawn",
    "closed",
  ]) {
    assert.deepEqual(serializeProfessionalEmergencyParticipation(state), {
      state,
    });
  }

  assert.equal(serializeProfessionalEmergencyParticipation(null), null);
  assert.deepEqual(
    serializeProfessionalEmergencyParticipation("unexpected_database_state"),
    { state: "unknown" }
  );
});

test("service compatibility fails closed for specialty, domain, and area mismatches", async () => {
  for (const opportunity of [
    distributableEmergency({
      service_specialty: "unsupported_emergency_service",
    }),
    distributableEmergency({ service_domain: "electrical" }),
    distributableEmergency({ service_domain: "healthcare" }),
    distributableEmergency({ location_text: "Miami, FL" }),
  ]) {
    const pool = createReadOnlyPool({ opportunities: [opportunity] });
    const result = await listProfessionalEmergencyOpportunities({
      pool,
      professionalUserId: 7,
    });

    assert.deepEqual(result.opportunities, []);
  }
});

test("defense-in-depth rejects same-user and non-distributable rows", async () => {
  const blockedRows = [
    distributableEmergency({ homeowner_id: 7 }),
    distributableEmergency({ disposition: undefined }),
    distributableEmergency({ disposition: "manual_review" }),
    ...[
      "draft",
      "safety_blocked",
      "cancelled",
      "expired",
      "assigned",
      "resolved",
    ].map((status) => distributableEmergency({ status })),
  ];
  const pool = createReadOnlyPool({ opportunities: blockedRows });

  const result = await listProfessionalEmergencyOpportunities({
    pool,
    professionalUserId: 7,
  });

  assert.deepEqual(result.opportunities, []);
});

test("eligibility helper requires server-owned Emergency authority", () => {
  const profile = eligibleProfile();

  assert.equal(
    professionalCanSeeEmergencyOpportunity(
      profile,
      distributableEmergency(),
      7
    ),
    true
  );
  assert.equal(
    professionalCanSeeEmergencyOpportunity(
      profile,
      distributableEmergency({ homeowner_id: 7 }),
      7
    ),
    false
  );
});

test("serializer excludes owner, safety, access, relationship, and conversation authority", () => {
  const serialized = serializeProfessionalEmergencyOpportunity(
    distributableEmergency({
      homeownerId: 9,
      user_id: 9,
      unit_number: "204",
      access_notes: "Gate code 1234",
      safetyAssessment: { immediateDanger: false },
      additionalSafetyContext: "Private",
      relationship_id: 81,
      conversation_id: 91,
      contractor_id: 17,
      professional_user_id: 7,
      assigned_at: "assigned",
      updated_at: "updated",
      participation_status: "pending",
    })
  );

  const forbidden = [
    "homeowner_id",
    "homeownerId",
    "user_id",
    "userId",
    "unit_number",
    "unitNumber",
    "access_notes",
    "accessNotes",
    "serviceLocation",
    "location",
    "locationText",
    "location_text",
    "emergencyRequestId",
    "emergency",
    "safetyAssessment",
    "additionalSafetyContext",
    "disposition",
    "relationship_id",
    "relationshipId",
    "conversation_id",
    "conversationId",
    "contractor_id",
    "contractorId",
    "professional_user_id",
    "professionalUserId",
    "assigned_at",
    "assignedAt",
    "updated_at",
  ];

  for (const field of forbidden) {
    assert.equal(Object.hasOwn(serialized, field), false, field);
  }
  assert.equal(
    Object.keys(serialized).some((field) => field.includes("_")),
    false
  );
  assert.equal(serialized.updatedAt, "updated");
  assert.deepEqual(serialized.participation, { state: "pending" });
  assert.equal(serialized.relationship, null);
  assert.equal(serialized.conversation, null);
  assert.deepEqual(Object.keys(serialized), [
    "id",
    "sourceType",
    "category",
    "serviceDomain",
    "serviceSpecialty",
    "title",
    "description",
    "status",
    "requestedAt",
    "createdAt",
    "updatedAt",
    "participation",
    "relationship",
    "conversation",
  ]);
});

test("retrieval validates the database dependency and performs reads only", async () => {
  await assert.rejects(
    listProfessionalEmergencyOpportunities({
      pool: null,
      professionalUserId: 7,
    }),
    /database pool or client is required/i
  );

  const pool = createReadOnlyPool();
  await listProfessionalEmergencyOpportunities({
    pool,
    professionalUserId: 7,
  });

  assert.equal(pool.calls.length, 2);
  for (const call of pool.calls) {
    assert.match(call.sql, /^SELECT\b/i);
    assert.doesNotMatch(call.sql, FORBIDDEN_SQL);
  }
});

test("Emergency opportunity read failures propagate for safe route normalization", async () => {
  const privateError = new Error("private database host");
  const pool = createReadOnlyPool({ opportunityError: privateError });

  await assert.rejects(
    listProfessionalEmergencyOpportunities({
      pool,
      professionalUserId: 7,
    }),
    (error) => error === privateError
  );
});
