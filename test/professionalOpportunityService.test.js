"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listProfessionalOpportunities,
} = require("../server/requests/professionalOpportunityService");
const {
  professionalCanSeeRequest,
  serializeProfessionalOpportunity,
  serializeProfessionalOpportunityPhoto,
} = require("../server/requests/requestLifecycle");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function eligibleProfile(overrides = {}) {
  return {
    id: 80,
    user_id: 9,
    category: "painting",
    profile_details: {
      service_area: "Cape Coral",
      service_specialties: ["painting"],
    },
    ...overrides,
  };
}

function eligibleRequest(overrides = {}) {
  return {
    id: 41,
    user_id: 7,
    title: "Interior painting",
    description: "Paint the living room",
    category: "painting",
    request_category: "painting",
    service_domain: "home_services",
    service_specialty: "painting",
    location: "123 Synthetic Palm Ave, Cape Coral, FL 33904",
    location_intake_mode: "exact_on_file",
    location_normalization_status: "normalized",
    service_address_line1: "123 Synthetic Palm Ave",
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    discovery_area_label: "Cape Coral, FL",
    unit_number: "Unit 201",
    access_notes: "Gate code 1234",
    status: "open",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T10:00:00.000Z",
    image_url: null,
    request_photos: [],
    ...overrides,
  };
}

function createOpportunityPool({
  profiles = [eligibleProfile()],
  requests = [eligibleRequest()],
  relationships = [],
  conversations = [],
  participants = [],
  responses = [],
  selections = [],
  history = [],
} = {}) {
  const calls = [];
  let connectCalls = 0;
  const state = {
    requests: clone(requests),
    relationships: clone(relationships),
    conversations: clone(conversations),
    participants: clone(participants),
    responses: clone(responses),
    selections: clone(selections),
    history: clone(history),
  };

  return {
    calls,
    state,
    connectCalls: () => connectCalls,
    pool: {
      async connect() {
        connectCalls += 1;
        throw new Error("Opportunity reads must not open a transaction client.");
      },
      async query(text, values = []) {
        const sql = normalizeSql(text);
        calls.push({ sql, values });

        if (!/^SELECT\b/i.test(sql)) {
          throw new Error(`Opportunity read attempted a non-SELECT query: ${sql}`);
        }

        if (sql.includes("FROM contractor_profiles")) {
          return {
            rows: profiles
              .filter((row) => Number(row.user_id) === Number(values[0]))
              .sort((left, right) => Number(left.id) - Number(right.id))
              .slice(0, 2)
              .map((row) => clone(row)),
          };
        }

        if (sql.includes("FROM posts")) {
          return {
            rows: state.requests
              .filter((row) =>
                row.status === "open" &&
                row.location_normalization_status === "normalized" &&
                Number(row.user_id) !== Number(values[0]) &&
                !state.selections.some(
                  (selection) =>
                    Number(selection.post_id) === Number(row.id) &&
                    selection.ended_at == null
                )
              )
              .sort((left, right) =>
                String(right.created_at).localeCompare(String(left.created_at))
              )
              .map((row) => clone(row)),
          };
        }

        if (sql.includes("FROM request_relationships")) {
          const [requestIds, contractorId, professionalUserId] = values;
          return {
            rows: state.relationships
              .filter((row) =>
                requestIds.map(Number).includes(Number(row.post_id)) &&
                row.emergency_request_id == null &&
                Number(row.contractor_id) === Number(contractorId) &&
                Number(row.professional_user_id) ===
                  Number(professionalUserId)
              )
              .sort((left, right) =>
                Number(left.id) - Number(right.id)
              )
              .map((relationship) => {
                const response = state.responses.find(
                  (row) =>
                    String(row.id) ===
                    String(relationship.professional_response_id) &&
                    Number(row.request_relationship_id) ===
                    Number(relationship.id)
                );
                return {
                  post_id: relationship.post_id,
                  relationship_id: relationship.id,
                  relationship_response_id:
                    relationship.professional_response_id,
                  relationship_post_id: relationship.post_id,
                  relationship_emergency_request_id:
                    relationship.emergency_request_id,
                  relationship_contractor_id:
                    relationship.contractor_id,
                  relationship_homeowner_id:
                    relationship.homeowner_id,
                  relationship_professional_user_id:
                    relationship.professional_user_id,
                  relationship_status: relationship.status,
                  ordinary_authority_source:
                    relationship.ordinary_authority_source,
                  relationship_current_version:
                    relationship.current_version,
                  professional_response_id: response?.id || null,
                  response_post_id: response?.post_id || null,
                  response_homeowner_id: response?.homeowner_id || null,
                  contractor_id: response?.contractor_id || null,
                  professional_user_id:
                    response?.professional_user_id || null,
                  response_status: response?.status || null,
                  response_current_version:
                    response?.current_version || null,
                  submitted_at: response?.submitted_at || null,
                  conversation_exists: state.conversations.some(
                    (conversation) =>
                      Number(conversation.relationship_id) ===
                      Number(relationship.id)
                  ),
                };
              }),
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  };
}

async function list(fake, professionalUserId = 9) {
  return listProfessionalOpportunities({
    pool: fake.pool,
    professionalUserId,
    professionalCanSeeRequest,
  });
}

function assertSelectOnly(fake) {
  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) {
    assert.match(call.sql, /^SELECT\b/i);
    assert.doesNotMatch(
      call.sql,
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL)\b/i
    );
    assert.doesNotMatch(call.sql, /\bON\s+CONFLICT\b/i);
    assert.doesNotMatch(call.sql, /\bFOR\s+(UPDATE|SHARE)\b/i);
  }
  assert.equal(fake.calls.some((call) => /\bconversation_participants\b|\bworkflow_events\b/i.test(call.sql)), false);
  assert.equal(fake.connectCalls(), 0);
}

test("professional photo projection removes ownership and storage metadata", () => {
  const photo = {
    id: "meetro/production/users/7/request-photos/photo-1",
    purpose: "request-photo",
    public_id: "meetro/production/users/7/request-photos/photo-1",
    secure_url:
      "https://res.cloudinary.com/test-cloud/image/upload/v1/meetro/production/users/7/request-photos/photo-1.jpg",
    resource_type: "image",
    format: "jpg",
    bytes: 12345,
    width: 1200,
    height: 900,
    version: 1,
    display_order: 0,
    uploaded_at: "2026-08-07T10:00:00.000Z",
    created_by_user_id: 7,
    lifecycle_state: "attached",
  };

  const projected = serializeProfessionalOpportunityPhoto(photo);

  assert.deepEqual(Object.keys(projected).sort(), [
    "display_order",
    "format",
    "height",
    "resource_type",
    "secure_url",
    "width",
  ]);

  assert.equal(Object.hasOwn(projected, "id"), false);
  assert.equal(Object.hasOwn(projected, "purpose"), false);
  assert.equal(Object.hasOwn(projected, "public_id"), false);
  assert.equal(Object.hasOwn(projected, "bytes"), false);
  assert.equal(Object.hasOwn(projected, "version"), false);
  assert.equal(Object.hasOwn(projected, "uploaded_at"), false);
  assert.equal(Object.hasOwn(projected, "created_by_user_id"), false);
  assert.equal(Object.hasOwn(projected, "lifecycle_state"), false);
});

test("professional opportunity recursively excludes private photo metadata", () => {
  const photo = {
    id: "meetro/production/users/7/request-photos/photo-1",
    purpose: "request-photo",
    public_id: "meetro/production/users/7/request-photos/photo-1",
    secure_url:
      "https://res.cloudinary.com/test-cloud/image/upload/v1/meetro/production/users/7/request-photos/photo-1.jpg",
    resource_type: "image",
    format: "jpg",
    bytes: 12345,
    width: 1200,
    height: 900,
    version: 1,
    display_order: 0,
    uploaded_at: "2026-08-07T10:00:00.000Z",
    created_by_user_id: 7,
    lifecycle_state: "attached",
  };

  const serialized = serializeProfessionalOpportunity(
    {
      ...eligibleRequest(),
      image_url: photo.secure_url,
    },
    [photo]
  );

  assert.equal(serialized.request_photos.length, 1);
  assert.equal(serialized.image_url, photo.secure_url);

  const first = serialized.request_photos[0];

  assert.equal(Object.hasOwn(first, "public_id"), false);
  assert.equal(Object.hasOwn(first, "created_by_user_id"), false);
  assert.equal(Object.hasOwn(first, "uploaded_at"), false);
  assert.equal(Object.hasOwn(first, "lifecycle_state"), false);
  assert.equal(Object.hasOwn(first, "bytes"), false);
  assert.equal(Object.hasOwn(first, "version"), false);

  const json = JSON.stringify(serialized);

  assert.equal(json.includes('"created_by_user_id"'), false);
  assert.equal(json.includes('"public_id"'), false);
  assert.equal(json.includes('"lifecycle_state"'), false);
});

test("professional opportunity serialization exposes generalized service area without protected location", () => {
  const request = eligibleRequest();

  const serialized = serializeProfessionalOpportunity(request, []);

  assert.equal(serialized.service_area, "Cape Coral, FL");

  assert.equal(Object.hasOwn(serialized, "location"), false);
  assert.equal(Object.hasOwn(serialized, "location_intake_mode"), false);
  assert.equal(Object.hasOwn(serialized, "location_normalization_status"), false);
  assert.equal(Object.hasOwn(serialized, "service_address_line1"), false);
  assert.equal(Object.hasOwn(serialized, "service_city"), false);
  assert.equal(Object.hasOwn(serialized, "service_region"), false);
  assert.equal(Object.hasOwn(serialized, "service_postal_code"), false);
  assert.equal(Object.hasOwn(serialized, "service_country_code"), false);
  assert.equal(Object.hasOwn(serialized, "discovery_area_label"), false);
  assert.equal(Object.hasOwn(serialized, "unit_number"), false);
  assert.equal(Object.hasOwn(serialized, "access_notes"), false);

  const serializedJson = JSON.stringify(serialized);

  assert.equal(serializedJson.includes("123 Synthetic Palm Ave"), false);
  assert.equal(serializedJson.includes("33904"), false);
  assert.equal(serializedJson.includes("Unit 201"), false);
  assert.equal(serializedJson.includes("Gate code 1234"), false);
});

test("first eligible opportunity read is SELECT-only and leaves all canonical state unchanged", async () => {
  const fake = createOpportunityPool();
  const before = clone(fake.state);

  const result = await list(fake);

  assert.equal(result.ok, true);
  assert.deepEqual(result.opportunities.map((row) => row.id), [41]);
  assert.equal(Object.hasOwn(result.opportunities[0], "conversation_id"), false);
  assert.equal(result.opportunities[0].has_responded, false);
  assert.equal(result.opportunities[0].response_submission_available, true);
  assert.deepEqual(fake.state, before);
  assertSelectOnly(fake);
});

test("legacy unclassified requests are withheld from professional discovery without parsing free-form location", async () => {
  const fake = createOpportunityPool({
    requests: [
      eligibleRequest({
        id: 45,
        location: "999 Private Legacy St, Cape Coral, FL 33904",
        location_intake_mode: null,
        location_normalization_status: "legacy_unclassified",
        service_address_line1: null,
        service_city: null,
        service_region: null,
        service_postal_code: null,
        service_country_code: null,
        discovery_area_label: null,
        unit_number: "Unit 9",
        access_notes: "Gate code 9876",
      }),
    ],
  });

  const result = await list(fake);

  assert.equal(result.ok, true);
  assert.deepEqual(result.opportunities, []);

  const postsQuery = fake.calls.find((call) => call.sql.includes("FROM posts"));
  assert.ok(postsQuery);
  assert.match(
    postsQuery.sql,
    /posts\.location_normalization_status = 'normalized'/
  );

  assertSelectOnly(fake);
});

test("active canonical selection removes the request without mutating opportunity state", async () => {
  const fake = createOpportunityPool({
    selections: [{ id: 701, post_id: 41, ended_at: null }],
  });
  const before = clone(fake.state);

  const result = await list(fake);

  assert.equal(result.ok, true);
  assert.deepEqual(result.opportunities, []);
  assert.deepEqual(fake.state, before);
  assertSelectOnly(fake);
  assert.match(
    fake.calls.find((call) => call.sql.includes("FROM posts")).sql,
    /NOT EXISTS \( SELECT 1 FROM request_selections .* request_selections\.ended_at IS NULL \)/
  );
});

test("repeated and concurrent opportunity reads remain deterministic and state-neutral", async () => {
  const fake = createOpportunityPool({
    requests: [
      eligibleRequest({ id: 41, created_at: "2026-07-22T10:00:00.000Z" }),
      eligibleRequest({ id: 42, created_at: "2026-07-23T10:00:00.000Z" }),
    ],
  });
  const before = clone(fake.state);

  const first = await list(fake);
  const second = await list(fake);
  const [third, fourth] = await Promise.all([list(fake), list(fake)]);

  for (const result of [first, second, third, fourth]) {
    assert.deepEqual(result.opportunities.map((row) => row.id), [42, 41]);
  }
  assert.deepEqual(fake.state, before);
  assertSelectOnly(fake);
});

test("multiple professional businesses can read one eligible request without creating participation", async () => {
  const fake = createOpportunityPool({
    profiles: [
      eligibleProfile(),
      eligibleProfile({ id: 81, user_id: 10 }),
    ],
  });
  const before = clone(fake.state);

  const firstProfessional = await list(fake, 9);
  const secondProfessional = await list(fake, 10);

  assert.deepEqual(firstProfessional.opportunities.map((row) => row.id), [41]);
  assert.deepEqual(secondProfessional.opportunities.map((row) => row.id), [41]);
  assert.deepEqual(fake.state, before);
  assertSelectOnly(fake);
});

test("each viewer resolves only its owned business profile and eligibility projection", async () => {
  const fake = createOpportunityPool({
    profiles: [
      eligibleProfile(),
      eligibleProfile({
        id: 81,
        user_id: 10,
        profile_details: {
          service_area: "Miami",
          service_specialties: ["plumbing"],
        },
      }),
    ],
    requests: [
      eligibleRequest({ id: 41 }),
      eligibleRequest({
        id: 42,
        user_id: 8,
        category: "plumbing",
        request_category: "plumbing",
        service_specialty: "plumbing",
        location: "456 Synthetic Bay Ave, Miami, FL 33101",
        service_address_line1: "456 Synthetic Bay Ave",
        service_city: "Miami",
        service_region: "FL",
        service_postal_code: "33101",
        service_country_code: "US",
        discovery_area_label: "Miami, FL",
      }),
    ],
  });
  const before = clone(fake.state);

  const paintingBusiness = await list(fake, 9);
  const plumbingBusiness = await list(fake, 10);

  assert.deepEqual(paintingBusiness.opportunities.map((row) => row.id), [41]);
  assert.deepEqual(plumbingBusiness.opportunities.map((row) => row.id), [42]);
  assert.deepEqual(fake.state, before);
  assert.deepEqual(
    fake.calls
      .filter((call) => call.sql.includes("FROM contractor_profiles"))
      .map((call) => call.values),
    [[9], [10]]
  );
  assertSelectOnly(fake);
});

test("ineligible, self-owned, closed, and unowned-professional reads fail closed without writes", async () => {
  const fake = createOpportunityPool({
    requests: [
      eligibleRequest({
        id: 41,
        location: "456 Synthetic Bay Ave, Miami, FL 33101",
        service_address_line1: "456 Synthetic Bay Ave",
        service_city: "Miami",
        service_region: "FL",
        service_postal_code: "33101",
        discovery_area_label: "Miami, FL",
      }),
      eligibleRequest({ id: 42, user_id: 9 }),
      eligibleRequest({ id: 43, status: "cancelled" }),
      eligibleRequest({ id: 44, service_specialty: "plumbing" }),
    ],
  });
  const before = clone(fake.state);

  const ineligible = await list(fake, 9);
  const unowned = await list(fake, 11);

  assert.deepEqual(ineligible.opportunities, []);
  assert.equal(unowned.ok, false);
  assert.equal(unowned.status, 403);
  assert.equal(unowned.code, "PROFESSIONAL_PROFILE_REQUIRED");
  assert.deepEqual(fake.state, before);
  assertSelectOnly(fake);
});

test("existing ordinary and Emergency authority records are read only and never modified", async () => {
  const existingState = {
    relationships: [
      {
        id: 61,
        post_id: 41,
        emergency_request_id: null,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        status: "pending",
        updated_at: "2026-07-20T10:00:00.000Z",
      },
      {
        id: 62,
        post_id: null,
        emergency_request_id: 71,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        status: "active",
        updated_at: "2026-07-20T11:00:00.000Z",
      },
    ],
    conversations: [{
      id: 101,
      relationship_id: 61,
      status: "closed",
      updated_at: "2026-07-20T12:00:00.000Z",
    }],
    participants: [{ conversation_id: 101, user_id: 9 }],
    responses: [],
    history: [{ id: 301, event_type: "request.created" }],
  };
  const fake = createOpportunityPool(existingState);
  const before = clone(fake.state);

  const result = await list(fake);

  assert.equal(result.ok, true);
  assert.deepEqual(result.opportunities.map((row) => row.id), [41]);
  assert.equal(Object.hasOwn(result.opportunities[0], "conversation_id"), false);
  assert.equal(result.opportunities[0].response_submission_available, false);
  assert.deepEqual(fake.state, before);
  assertSelectOnly(fake);
});

test("canonical response state is projected only for the exact authenticated business", async () => {
  const fake = createOpportunityPool({
    relationships: [
      {
        id: 61,
        post_id: 41,
        emergency_request_id: null,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        status: "pending",
        professional_response_id: "201",
        ordinary_authority_source: "professional_response",
        current_version: 1,
      },
      {
        id: 62,
        post_id: 41,
        emergency_request_id: null,
        homeowner_id: 7,
        contractor_id: 81,
        professional_user_id: 10,
        status: "pending",
        professional_response_id: "202",
        ordinary_authority_source: "professional_response",
        current_version: 1,
      },
    ],
    responses: [
      {
        id: "201",
        request_relationship_id: 61,
        post_id: 41,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        status: "submitted",
        current_version: 1,
        submitted_at: "2026-08-06T12:00:00.000Z",
      },
      {
        id: "202",
        request_relationship_id: 62,
        post_id: 41,
        homeowner_id: 7,
        contractor_id: 81,
        professional_user_id: 10,
        status: "submitted",
        current_version: 1,
        submitted_at: "2026-08-06T12:05:00.000Z",
        introduction_text: "Private other response",
      },
    ],
  });

  const result = await list(fake, 9);
  assert.equal(result.opportunities[0].has_responded, true);
  assert.equal(result.opportunities[0].professional_response_id, "201");
  assert.equal(result.opportunities[0].response_status, "submitted");
  assert.equal(result.opportunities[0].relationship_status, "pending");
  assert.equal(result.opportunities[0].response_submission_available, false);
  assert.equal(Object.hasOwn(result.opportunities[0], "introduction_text"), false);

  const stateQuery = fake.calls.find((call) =>
    call.sql.includes("FROM request_relationships")
  );
  assert.deepEqual(stateQuery.values, [[41], 80, 9]);
  assertSelectOnly(fake);
});

test("malformed, duplicate, and legacy participation fail closed without hiding the request", async (t) => {
  const relationship = {
    id: 61,
    post_id: 41,
    emergency_request_id: null,
    contractor_id: 80,
    professional_user_id: 9,
    status: "pending",
    professional_response_id: null,
    ordinary_authority_source: null,
    current_version: null,
  };

  for (const relationships of [
    [relationship],
    [relationship, { ...relationship, id: 62 }],
    [{
      ...relationship,
      professional_response_id: "201",
      ordinary_authority_source: "professional_response",
      current_version: 1,
    }],
  ]) {
    await t.test(`rows-${relationships.length}-${relationships[0].professional_response_id || "legacy"}`, async () => {
      const fake = createOpportunityPool({ relationships, responses: [] });
      const result = await list(fake);
      assert.equal(result.opportunities.length, 1);
      assert.equal(result.opportunities[0].has_responded, false);
      assert.equal(result.opportunities[0].response_submission_available, false);
      assertSelectOnly(fake);
    });
  }
});

test("multiple owned profiles fail closed rather than selecting one", async () => {
  const fake = createOpportunityPool({
    profiles: [eligibleProfile(), eligibleProfile({ id: 81 })],
  });
  const result = await list(fake);

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "PROFESSIONAL_PROFILE_AMBIGUOUS");
  assert.equal(fake.calls.some((call) => call.sql.includes("FROM posts")), false);
  assertSelectOnly(fake);
});
