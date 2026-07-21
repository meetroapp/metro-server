"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProfessionalRequestRelationship,
} = require("../server/relationships/requestRelationshipService");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function eligibleProfile(overrides = {}) {
  return {
    id: 80,
    user_id: 9,
    category: "handyman",
    profile_details: {
      city: "Cape Coral",
      postal_code: "33990",
      service_area: "Lee County",
      service_specialties: ["drywall_repair"],
    },
    ...overrides,
  };
}

function eligibleRequest(overrides = {}) {
  return {
    id: 41,
    user_id: 7,
    title: "Drywall Repair",
    description: "Repair damaged drywall",
    category: "drywall",
    request_category: "drywall",
    service_domain: "home_services",
    service_specialty: "drywall_repair",
    location: "Cape Coral, FL 33990",
    status: "open",
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
    image_url: null,
    request_photos: [],
    ...overrides,
  };
}

function createFakePool({
  profileRows = [eligibleProfile()],
  requestRows = [eligibleRequest()],
  relationshipRows = [{
    id: 51,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "pending",
    introduction_text: "I can help.",
    created: true,
  }],
  failOn,
  useConnect = true,
} = {}) {
  const calls = [];
  let released = false;

  const client = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (failOn && sql.includes(failOn)) {
        throw new Error("simulated database failure");
      }

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }

      if (sql.includes("FROM contractor_profiles")) {
        return { rows: profileRows };
      }

      if (sql.includes("FROM posts")) {
        return { rows: requestRows };
      }

      if (sql.includes("INSERT INTO request_relationships")) {
        return { rows: relationshipRows };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },

    release() {
      released = true;
    },
  };

  const pool = useConnect
    ? {
        async connect() {
          return client;
        },
        async query() {
          throw new Error("Pool query must not be used during transaction.");
        },
      }
    : client;

  return {
    pool,
    calls,
    wasReleased() {
      return released;
    },
  };
}

test("eligible professional creates one pending request relationship", async () => {
  const fake = createFakePool();

  const result = await createProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    postId: "41",
    payload: {
      introduction_text: "  I can help.  ",
    },
    professionalCanSeeRequest: () => true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_CREATED");
  assert.equal(result.created, true);
  assert.equal(result.relationship.id, 51);

  const insert = fake.calls.find((call) =>
    call.sql.includes("INSERT INTO request_relationships")
  );

  assert.ok(insert);
  assert.deepEqual(insert.values, [
    41,
    7,
    80,
    9,
    "I can help.",
  ]);

  assert.equal(fake.wasReleased(), true);
});

test("repeated response returns the existing relationship idempotently", async () => {
  const fake = createFakePool({
    relationshipRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "pending",
      introduction_text: "I can help.",
      created: false,
    }],
  });

  const result = await createProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    postId: 41,
    payload: {
      introduction_text: "A repeated click must not duplicate.",
    },
    professionalCanSeeRequest: () => true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_EXISTS");
  assert.equal(result.created, false);
  assert.equal(result.relationship.id, 51);
});

test("invalid identifiers and missing introductions fail before database access", async () => {
  const fake = createFakePool();

  const invalidId = await createProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    postId: "41abc",
    payload: {
      introduction_text: "I can help.",
    },
    professionalCanSeeRequest: () => true,
  });

  assert.equal(invalidId.ok, false);
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.code, "INVALID_REQUEST_ID");

  const missingIntroduction = await createProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    postId: 41,
    payload: {},
    professionalCanSeeRequest: () => true,
  });

  assert.equal(missingIntroduction.ok, false);
  assert.equal(missingIntroduction.code, "INTRODUCTION_REQUIRED");
  assert.equal(fake.calls.length, 0);
});

test("professional profile is required", async () => {
  const fake = createFakePool({
    profileRows: [],
  });

  const result = await createProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    postId: 41,
    payload: {
      introduction_text: "I can help.",
    },
    professionalCanSeeRequest: () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "PROFESSIONAL_PROFILE_REQUIRED");

  assert.ok(fake.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(
    fake.calls.some((call) => call.sql.includes("FROM posts")),
    false
  );
});

test("same-owner, closed, or missing requests remain unavailable", async () => {
  const fake = createFakePool({
    requestRows: [],
  });

  const result = await createProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    postId: 41,
    payload: {
      introduction_text: "I can help.",
    },
    professionalCanSeeRequest: () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "REQUEST_NOT_AVAILABLE");

  const requestQuery = fake.calls.find((call) =>
    call.sql.includes("FROM posts")
  );

  assert.ok(requestQuery);
  assert.match(requestQuery.sql, /status = 'open'/);
  assert.match(requestQuery.sql, /user_id <> \$2/);
});

test("server rechecks professional eligibility before relationship creation", async () => {
  const fake = createFakePool();

  const result = await createProfessionalRequestRelationship({
    pool: fake.pool,
    professionalUserId: 9,
    postId: 41,
    payload: {
      introduction_text: "I can help.",
    },
    professionalCanSeeRequest: () => false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "REQUEST_NOT_ELIGIBLE");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("INSERT INTO request_relationships")
    ),
    false
  );
});

test("transaction failures roll back and release the dedicated client", async () => {
  const fake = createFakePool({
    failOn: "INSERT INTO request_relationships",
  });

  await assert.rejects(
    createProfessionalRequestRelationship({
      pool: fake.pool,
      professionalUserId: 9,
      postId: 41,
      payload: {
        introduction_text: "I can help.",
      },
      professionalCanSeeRequest: () => true,
    }),
    /simulated database failure/
  );

  assert.ok(fake.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(fake.wasReleased(), true);
});

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
            status: "pending",
            introduction_text: "I can help.",
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

test("homeowner can accept a pending owned relationship", async () => {
  const {
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool();

  const result = await acceptHomeownerRequestRelationship({
    pool: fake.pool,
    homeownerUserId: 7,
    relationshipId: "51",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.code, "REQUEST_RELATIONSHIP_ACCEPTED");
  assert.equal(result.relationship.status, "active");
  assert.equal(result.conversation.id, 91);
  assert.equal(result.conversation.relationship_id, 51);

  const conversationInsert = fake.calls.find((call) =>
    call.sql.includes("INSERT INTO conversations")
  );

  assert.ok(conversationInsert);
  assert.deepEqual(
    conversationInsert.values,
    [51, 7, 80, 9]
  );

  const select = fake.calls.find((call) =>
    call.sql.includes("FROM request_relationships")
  );

  assert.ok(select);
  assert.deepEqual(select.values, [51, 7]);
  assert.match(select.sql, /request_relationships\.homeowner_id = \$2/);
  assert.match(select.sql, /posts\.user_id = \$2/);

  const update = fake.calls.find((call) =>
    call.sql.startsWith("UPDATE request_relationships")
  );

  assert.ok(update);
  assert.match(update.sql, /status = \$1/);
  assert.match(update.sql, /accepted_at = CURRENT_TIMESTAMP/);
  assert.match(update.sql, /status = 'pending'/);
  assert.deepEqual(update.values, ["active", 51, 7]);

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
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    failOn: "UPDATE request_relationships",
  });

  await assert.rejects(
    acceptHomeownerRequestRelationship({
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

  const update = fake.calls.find((call) =>
    call.sql.startsWith("UPDATE request_relationships")
  );

  assert.ok(update);
  assert.match(update.sql, /status = 'withdrawn'/);
  assert.match(update.sql, /withdrawn_at = CURRENT_TIMESTAMP/);
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


test("acceptance rolls back when conversation persistence fails", async () => {
  const {
    acceptHomeownerRequestRelationship,
  } = require("../server/relationships/requestRelationshipService");

  const fake = createTransitionPool({
    failOn: "INSERT INTO conversations",
  });

  await assert.rejects(
    acceptHomeownerRequestRelationship({
      pool: fake.pool,
      homeownerUserId: 7,
      relationshipId: 51,
    }),
    /simulated transition failure/
  );

  assert.ok(
    fake.calls.some((call) =>
      call.sql.startsWith("UPDATE request_relationships")
    )
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

test("acceptance resolves an existing canonical conversation idempotently", async () => {
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

  assert.equal(result.ok, true);
  assert.equal(result.conversation.id, 91);
  assert.equal(result.conversation.created, false);

  assert.equal(
    fake.calls.filter((call) =>
      call.sql.includes("INSERT INTO conversations")
    ).length,
    1
  );
});
