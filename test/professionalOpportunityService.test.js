"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  materializeProfessionalOpportunities,
} = require("../server/requests/professionalOpportunityService");
const {
  professionalCanSeeRequest,
} = require("../server/requests/requestLifecycle");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
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
    location: "Cape Coral, FL 33904",
    status: "open",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T10:00:00.000Z",
    image_url: null,
    request_photos: [],
    ...overrides,
  };
}

function createOpportunityPool({
  profile = eligibleProfile(),
  requests = [eligibleRequest()],
  relationships = [],
  conversations = [],
  failMaterialization = false,
} = {}) {
  const calls = [];
  const state = {
    relationships: new Map(
      relationships.map((row) => [`${row.post_id}:${row.contractor_id}`, { ...row }])
    ),
    conversations: new Map(
      conversations.map((row) => [row.relationship_id, { ...row }])
    ),
  };
  let nextRelationshipId = 51;
  let nextConversationId = 91;
  let released = 0;

  const client = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }

      if (sql.includes("FROM contractor_profiles")) {
        return {
          rows: profile && Number(profile.user_id) === Number(values[0])
            ? [{ ...profile }]
            : [],
        };
      }

      if (
        sql.includes("INSERT INTO request_relationships") &&
        sql.includes("INSERT INTO conversations")
      ) {
        if (failMaterialization) {
          throw new Error("simulated conversation materialization failure");
        }

        const [professionalUserId, contractorId, requestIds] = values;
        const rows = [];

        for (const requestId of requestIds) {
          const request = requests.find((item) => Number(item.id) === Number(requestId));
          if (!request || request.status !== "open") continue;

          const relationshipKey = `${request.id}:${contractorId}`;
          let relationship = state.relationships.get(relationshipKey);

          if (!relationship) {
            relationship = {
              id: nextRelationshipId++,
              post_id: request.id,
              homeowner_id: request.user_id,
              contractor_id: contractorId,
              professional_user_id: professionalUserId,
              status: "active",
            };
            state.relationships.set(relationshipKey, relationship);
          } else if (
            Number(relationship.homeowner_id) === Number(request.user_id) &&
            Number(relationship.professional_user_id) === Number(professionalUserId) &&
            ["pending", "active"].includes(relationship.status)
          ) {
            relationship.status = "active";
          }

          if (
            relationship.status !== "active" ||
            Number(relationship.homeowner_id) !== Number(request.user_id) ||
            Number(relationship.professional_user_id) !== Number(professionalUserId)
          ) {
            continue;
          }

          let conversation = state.conversations.get(relationship.id);
          if (!conversation) {
            conversation = {
              id: nextConversationId++,
              relationship_id: relationship.id,
              homeowner_id: relationship.homeowner_id,
              contractor_id: relationship.contractor_id,
              professional_user_id: relationship.professional_user_id,
              status: "active",
            };
            state.conversations.set(relationship.id, conversation);
          }

          rows.push({
            post_id: relationship.post_id,
            conversation_id: conversation.id,
          });
        }

        return { rows };
      }

      if (sql.includes("FROM posts") && !sql.includes("ANY($2::integer[])")) {
        return {
          rows: requests
            .filter((row) => row.status === "open" && Number(row.user_id) !== Number(values[0]))
            .map((row) => ({ ...row })),
        };
      }

      if (sql.includes("ANY($2::integer[])")) {
        const ids = new Set(values[1].map(Number));
        return {
          rows: requests
            .filter((row) =>
              ids.has(Number(row.id)) &&
              row.status === "open" &&
              Number(row.user_id) !== Number(values[0])
            )
            .map((row) => ({ ...row })),
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },

    release() {
      released += 1;
    },
  };

  return {
    pool: {
      async connect() {
        return client;
      },
      async query() {
        throw new Error("Pool query must not be used during materialization.");
      },
    },
    calls,
    requests,
    state,
    released: () => released,
  };
}

async function materialize(fake, professionalUserId = 9) {
  return materializeProfessionalOpportunities({
    pool: fake.pool,
    professionalUserId,
    professionalCanSeeRequest,
  });
}

test("new eligible opportunity atomically materializes canonical identity", async () => {
  const fake = createOpportunityPool();
  const result = await materialize(fake);

  assert.equal(result.ok, true);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].conversation_id, 91);
  assert.equal(fake.state.relationships.size, 1);
  assert.equal(fake.state.conversations.size, 1);
  assert.equal([...fake.state.relationships.values()][0].status, "active");
  assert.equal(fake.released(), 1);

  const materialization = fake.calls.find((call) =>
    call.sql.includes("INSERT INTO request_relationships")
  );
  assert.ok(materialization);
  assert.match(materialization.sql, /ON CONFLICT \(post_id, contractor_id\)/);
  assert.match(materialization.sql, /ON CONFLICT \(relationship_id\)/);
  assert.match(materialization.sql, /request_relationships\.professional_user_id = EXCLUDED\.professional_user_id/);
  assert.match(materialization.sql, /conversations\.professional_user_id = EXCLUDED\.professional_user_id/);
  assert.deepEqual(materialization.values, [9, 80, [41]]);
});

test("repeated and concurrent refreshes resolve one relationship and conversation", async () => {
  const fake = createOpportunityPool();
  const first = await materialize(fake);
  const second = await materialize(fake);
  const [third, fourth] = await Promise.all([materialize(fake), materialize(fake)]);

  assert.deepEqual(
    [first, second, third, fourth].map((result) => result.opportunities[0].conversation_id),
    [91, 91, 91, 91]
  );
  assert.equal(fake.state.relationships.size, 1);
  assert.equal(fake.state.conversations.size, 1);
});

test("ineligible and unowned professionals receive no canonical records", async () => {
  const ineligible = createOpportunityPool({
    requests: [eligibleRequest({ location: "Miami, FL" })],
  });
  const ineligibleResult = await materialize(ineligible);

  assert.equal(ineligibleResult.ok, true);
  assert.deepEqual(ineligibleResult.opportunities, []);
  assert.equal(ineligible.state.relationships.size, 0);
  assert.equal(ineligible.state.conversations.size, 0);
  assert.equal(
    ineligible.calls.some((call) => call.sql.includes("INSERT INTO request_relationships")),
    false
  );

  const unowned = createOpportunityPool();
  const unownedResult = await materialize(unowned, 10);
  assert.equal(unownedResult.ok, false);
  assert.equal(unownedResult.status, 403);
  assert.equal(unownedResult.code, "PROFESSIONAL_PROFILE_REQUIRED");
  assert.equal(unowned.state.relationships.size, 0);
  assert.equal(unowned.state.conversations.size, 0);
});

test("conflicting professional authority cannot reuse canonical identity", async () => {
  const fake = createOpportunityPool({
    relationships: [{
      id: 61,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 10,
      status: "active",
    }],
  });

  const result = await materialize(fake, 9);
  assert.equal(result.ok, true);
  assert.deepEqual(result.opportunities, []);
  assert.equal(fake.state.relationships.size, 1);
  assert.equal(fake.state.conversations.size, 0);
});

test("editing a request into service area materializes once without resubmission", async () => {
  const fake = createOpportunityPool({
    requests: [eligibleRequest({ location: "Miami, FL" })],
  });

  const beforeEdit = await materialize(fake);
  assert.deepEqual(beforeEdit.opportunities, []);

  fake.requests[0].location = "Cape Coral, FL";
  const afterEdit = await materialize(fake);
  const afterRefresh = await materialize(fake);

  assert.equal(afterEdit.opportunities[0].conversation_id, 91);
  assert.equal(afterRefresh.opportunities[0].conversation_id, 91);
  assert.equal(fake.state.relationships.size, 1);
  assert.equal(fake.state.conversations.size, 1);
});

test("existing canonical records retain their original conversation identity", async () => {
  const fake = createOpportunityPool({
    relationships: [{
      id: 61,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
    conversations: [{
      id: 101,
      relationship_id: 61,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
  });

  const result = await materialize(fake);
  assert.equal(result.opportunities[0].conversation_id, 101);
  assert.equal(fake.state.relationships.size, 1);
  assert.equal(fake.state.conversations.size, 1);
});

test("conversation materialization failure rolls back the transaction", async () => {
  const fake = createOpportunityPool({ failMaterialization: true });

  await assert.rejects(materialize(fake), /materialization failure/);
  assert.equal(fake.state.relationships.size, 0);
  assert.equal(fake.state.conversations.size, 0);
  assert.equal(fake.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(fake.calls.some((call) => call.sql === "COMMIT"), false);
  assert.equal(fake.released(), 1);
});
