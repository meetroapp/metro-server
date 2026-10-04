"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}


test("homeowner relationship inbox returns only homeowner-owned request relationships", async () => {
  const calls = [];

  const pool = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (sql.includes("FROM request_relationships")) {
        return {
          rows: [{
            id: 51,
            post_id: 41,
            contractor_id: 80,
            professional_response_id: "9007199254740993",
            ordinary_authority_source: "professional_response",
            relationship_current_version: 1,
            status: "pending",
            introduction_text: "Legacy introduction must not win.",
            created_at: "2026-07-20T12:00:00.000Z",
            responded_at: "2026-07-20T12:00:00.000Z",
            accepted_at: null,
            declined_at: null,
            withdrawn_at: null,
            closed_at: null,
            business_name: "Trusted Repairs",
            professional_category: "handyman",
            business_image_url: "https://example.test/logo.jpg",
            request_title: "Drywall Repair",
            response_id: "9007199254740993",
            response_status: "submitted",
            response_current_version: 1,
            response_introduction_text: "I can help.",
            response_submitted_at: "2026-07-20T12:00:00.000Z",
          }],
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const {
    listHomeownerRequestRelationships,
  } = require("../server/relationships/requestRelationshipService");

  const rows = await listHomeownerRequestRelationships({
    pool,
    homeownerUserId: 7,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 51);
  assert.equal(rows[0].response_id, "9007199254740993");
  assert.equal(rows[0].response_introduction_text, "I can help.");

  const query = calls[0];

  assert.deepEqual(query.values, [7]);
  assert.match(
    query.sql,
    /request_relationships\.homeowner_id = \$1/
  );
  assert.match(
    query.sql,
    /posts\.user_id = \$1/
  );
  assert.match(
    query.sql,
    /professional_responses\.id AS response_id/
  );
  assert.match(
    query.sql,
    /request_relationships\.professional_response_id/
  );
});

test("homeowner relationship inbox validates the database dependency", async () => {
  const {
    listHomeownerRequestRelationships,
  } = require("../server/relationships/requestRelationshipService");

  await assert.rejects(
    listHomeownerRequestRelationships({
      pool: null,
      homeownerUserId: 7,
    }),
    /database pool or client is required/
  );
});

function createTransitionPool({
  relationshipRows = [{
    id: 51,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "pending",
  }],
  updatedRows = [{
    id: 51,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    accepted_at: "2026-07-20T13:00:00.000Z",
  }],
  activeRelationshipRows = [{
    id: 51,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
  }],
  conversationRows = [{
    id: 91,
    relationship_id: 51,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    created: true,
  }],
  failOn,
} = {}) {
  const calls = [];
  let released = false;

  const client = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (failOn && sql.includes(failOn)) {
        throw new Error("simulated transition failure");
      }

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }

      if (
        sql.includes("FROM request_relationships") &&
        (
          sql.includes("JOIN posts") ||
          sql.includes("JOIN contractor_profiles")
        )
      ) {
        return { rows: relationshipRows };
      }

      if (sql.startsWith("UPDATE request_relationships")) {
        return { rows: updatedRows };
      }

      if (
        sql.includes("FROM request_relationships") &&
        sql.includes("status = 'active'") &&
        sql.includes("FOR UPDATE")
      ) {
        return { rows: activeRelationshipRows };
      }

      if (
        sql.includes("WITH inserted AS") &&
        sql.includes("INSERT INTO conversations")
      ) {
        return { rows: conversationRows };
      }

      if (
        sql.includes(
          "INSERT INTO conversation_participant_state"
        )
      ) {
        return { rows: [], rowCount: 2 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },

    release() {
      released = true;
    },
  };

  return {
    calls,

    pool: {
      async connect() {
        return client;
      },

      async query() {
        throw new Error("Pool query must not be used during transaction.");
      },
    },

    wasReleased() {
      return released;
    },
  };
}

test("legacy homeowner accept fails closed in favor of canonical response selection", async () => {
  const {
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool();

  const result = await acceptHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 7,
    relationshipId: "51",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "CANONICAL_RESPONSE_SELECTION_REQUIRED");

  const conversationInsert = fake.calls.find((call) =>
    call.sql.includes("INSERT INTO conversations")
  );

  assert.equal(conversationInsert, undefined);

  const select = fake.calls.find((call) =>
    call.sql.includes("FROM request_relationships")
  );

  assert.ok(select);
  assert.deepEqual(select.values, [51, 7]);
  assert.match(select.sql, /request_relationships\.homeowner_id = \$2/);
  assert.match(select.sql, /posts\.user_id = \$2/);
  assert.match(select.sql, /professional_response_id IS NULL/);
  assert.match(select.sql, /ordinary_authority_source IS NULL/);

  const update = fake.calls.find((call) =>
    call.sql.startsWith("UPDATE request_relationships")
  );

  assert.equal(update, undefined);
  assert.equal(fake.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(fake.calls.some((call) => call.sql === "COMMIT"), false);

  assert.equal(fake.wasReleased(), true);
});

test("homeowner can decline a pending owned relationship", async () => {
  const {
    declineHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    updatedRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "declined",
      declined_at: "2026-07-20T13:00:00.000Z",
    }],
  });

  const result = await declineHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 7,
    relationshipId: 51,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_DECLINED");
  assert.equal(result.relationship.status, "declined");
  assert.equal(result.conversation, null);

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("INSERT INTO conversations")
    ),
    false
  );

  const update = fake.calls.find((call) =>
    call.sql.startsWith("UPDATE request_relationships")
  );

  assert.ok(update);
  assert.match(update.sql, /declined_at = CURRENT_TIMESTAMP/);
  assert.match(update.sql, /professional_response_id IS NULL/);
  assert.match(update.sql, /ordinary_authority_source IS NULL/);
  assert.deepEqual(update.values, ["declined", 51, 7]);
});

test("unrelated homeowner cannot mutate another homeowner relationship", async () => {
  const {
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    relationshipRows: [],
  });

  const result = await acceptHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 8,
    relationshipId: 51,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_NOT_FOUND");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.startsWith("UPDATE request_relationships")
    ),
    false
  );
});

test("non-pending relationships cannot be accepted or declined again", async () => {
  const {
    declineHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    relationshipRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
  });

  const result = await declineHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 7,
    relationshipId: 51,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_NOT_PENDING");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.startsWith("UPDATE request_relationships")
    ),
    false
  );
});

test("invalid relationship identifiers fail before database access", async () => {
  const {
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool();

  const result = await acceptHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 7,
    relationshipId: "51abc",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, "INVALID_RELATIONSHIP_ID");
  assert.equal(fake.calls.length, 0);
});

test("relationship transition failures roll back and release the client", async () => {
  const {
    declineHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    failOn: "UPDATE request_relationships",
  });

  await assert.rejects(
    declineHomeownerRequestRelationship({
      pool: fake.pool,
      homeownerUserId: 7,
      relationshipId: 51,
    }),
    /simulated transition failure/
  );

  assert.ok(fake.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(fake.wasReleased(), true);
});

test("professional relationship inbox returns only relationships owned by the professional business", async () => {
  const calls = [];

  const pool = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (sql.includes("FROM request_relationships")) {
        return {
          rows: [{
            id: 51,
            post_id: 41,
            contractor_id: 80,
            professional_user_id: 9,
            status: "pending",
            introduction_text: "I can help.",
            request_title: "Drywall Repair",
            request_description: "Repair damaged drywall",
            request_category: "drywall",
            service_domain: "home_services",
            service_specialty: "drywall_repair",
          }],
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const {
    listProfessionalRequestRelationships,
  } = require("../server/relationships/requestRelationshipService");

  const rows = await listProfessionalRequestRelationships({
    pool,
    professionalUserId: 9,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 51);

  const query = calls[0];

  assert.deepEqual(query.values, [9]);
  assert.match(
    query.sql,
    /request_relationships\.professional_user_id = \$1/
  );
  assert.match(
    query.sql,
    /contractor_profiles\.user_id = \$1/
  );
});

test("professional can withdraw an owned pending relationship", async () => {
  const fake = createTransitionPool({
    relationshipRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "pending",
    }],
    updatedRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "withdrawn",
      withdrawn_at: "2026-07-20T14:00:00.000Z",
    }],
  });

  const {
    withdrawProfessionalRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const result = await withdrawProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    relationshipId: "51",
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_WITHDRAWN");
  assert.equal(result.relationship.status, "withdrawn");

  const select = fake.calls.find((call) =>
    call.sql.includes("FROM request_relationships")
  );

  assert.ok(select);
  assert.deepEqual(select.values, [51, 9]);
  assert.match(
    select.sql,
    /request_relationships\.professional_user_id = \$2/
  );
  assert.match(
    select.sql,
    /contractor_profiles\.user_id = \$2/
  );
  assert.match(select.sql, /professional_response_id IS NULL/);
  assert.match(select.sql, /ordinary_authority_source IS NULL/);

  const update = fake.calls.find((call) =>
    call.sql.startsWith("UPDATE request_relationships")
  );

  assert.ok(update);
  assert.match(update.sql, /status = 'withdrawn'/);
  assert.match(update.sql, /withdrawn_at = CURRENT_TIMESTAMP/);
  assert.match(update.sql, /professional_response_id IS NULL/);
  assert.match(update.sql, /ordinary_authority_source IS NULL/);
  assert.deepEqual(update.values, [51, 9]);
});

test("unrelated professional cannot withdraw another business relationship", async () => {
  const fake = createTransitionPool({
    relationshipRows: [],
  });

  const {
    withdrawProfessionalRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const result = await withdrawProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 10,
    relationshipId: 51,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_NOT_FOUND");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.startsWith("UPDATE request_relationships")
    ),
    false
  );
});

test("professional cannot withdraw an active or completed relationship", async () => {
  const fake = createTransitionPool({
    relationshipRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
  });

  const {
    withdrawProfessionalRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const result = await withdrawProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    relationshipId: 51,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_NOT_PENDING");
});


test("legacy acceptance never reaches conversation persistence", async () => {
  const {
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    failOn: "INSERT INTO conversations",
  });

  const result = await acceptHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 7,
    relationshipId: 51,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "CANONICAL_RESPONSE_SELECTION_REQUIRED");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.startsWith("UPDATE request_relationships")
    ),
    false
  );

  assert.ok(
    fake.calls.some((call) => call.sql === "ROLLBACK")
  );

  assert.equal(
    fake.calls.some((call) => call.sql === "COMMIT"),
    false
  );

  assert.equal(fake.wasReleased(), true);
});

test("legacy acceptance cannot adopt an existing conversation", async () => {
  const {
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    conversationRows: [{
      id: 91,
      relationship_id: 51,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
      created: false,
    }],
  });

  const result = await acceptHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 7,
    relationshipId: 51,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "CANONICAL_RESPONSE_SELECTION_REQUIRED");

  assert.equal(
    fake.calls.filter((call) =>
      call.sql.includes("INSERT INTO conversations")
    ).length,
    0
  );
});
