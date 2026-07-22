"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureConversation,
  ensureConversationWithClient,
  getConversation,
  listHomeownerConversations,
  listProfessionalConversations,
} = require("../server/conversations/conversationService");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createConversationPool({
  relationshipRows = [],
  conversationRows = [],
  failOn = null,
} = {}) {
  const calls = [];
  let released = false;

  const client = {
    async query(sql, params = []) {
      const normalized = normalizeSql(sql);
      calls.push({ sql: normalized, params });

      if (failOn && normalized.includes(failOn)) {
        throw new Error("simulated database failure");
      }

      if (
        normalized === "BEGIN" ||
        normalized === "COMMIT" ||
        normalized === "ROLLBACK"
      ) {
        return { rows: [] };
      }

      if (
        normalized.includes("FROM request_relationships") &&
        normalized.includes("FOR UPDATE")
      ) {
        return { rows: relationshipRows };
      }

      if (
        normalized.includes("WITH inserted AS") &&
        normalized.includes("INSERT INTO conversations")
      ) {
        return { rows: conversationRows };
      }

      throw new Error(`Unexpected SQL: ${normalized}`);
    },

    release() {
      released = true;
    },
  };

  return {
    pool: {
      query: client.query.bind(client),
      async connect() {
        return client;
      },
    },
    calls,
    wasReleased() {
      return released;
    },
  };
}

function createReadPool(handler) {
  const calls = [];

  return {
    calls,

    pool: {
      async query(sql, params = []) {
        const normalized = normalizeSql(sql);
        calls.push({ sql: normalized, params });
        return handler(normalized, params);
      },
    },
  };
}

test("active relationship creates one canonical conversation", async () => {
  const fake = createConversationPool({
    relationshipRows: [{
      id: 31,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
    conversationRows: [{
      id: 51,
      relationship_id: 31,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
      created: true,
    }],
  });

  const result = await ensureConversation({
    pool: fake.pool,
    relationshipId: 31,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.code, "CONVERSATION_CREATED");
  assert.equal(result.created, true);
  assert.equal(result.conversation.id, 51);

  const insertCall = fake.calls.find((call) =>
    call.sql.includes("INSERT INTO conversations")
  );

  assert.deepEqual(insertCall.params, [31, 7, 80, 9]);
  assert.equal(fake.wasReleased(), true);
});

test("repeated creation resolves the existing conversation idempotently", async () => {
  const fake = createConversationPool({
    relationshipRows: [{
      id: 31,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
    conversationRows: [{
      id: 51,
      relationship_id: 31,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
      created: false,
    }],
  });

  const result = await ensureConversation({
    pool: fake.pool,
    relationshipId: "31",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.code, "CONVERSATION_EXISTS");
  assert.equal(result.created, false);
  assert.equal(result.conversation.id, 51);
});

test("invalid relationship identifiers fail before database access", async () => {
  let queried = false;

  const result = await ensureConversation({
    pool: {
      async query() {
        queried = true;
        return { rows: [] };
      },
    },
    relationshipId: "invalid",
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    code: "INVALID_RELATIONSHIP_ID",
    message: "A valid relationship ID is required.",
  });

  assert.equal(queried, false);
});

test("conversation creation requires an active relationship", async () => {
  const fake = createConversationPool({
    relationshipRows: [],
  });

  const result = await ensureConversation({
    pool: fake.pool,
    relationshipId: 31,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    code: "ACTIVE_RELATIONSHIP_NOT_FOUND",
    message: "An active relationship is required to create a conversation.",
  });

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("INSERT INTO conversations")
    ),
    false
  );

  assert.equal(
    fake.calls.some((call) => call.sql === "ROLLBACK"),
    true
  );

  assert.equal(fake.wasReleased(), true);
});

test("conversation creation rolls back and releases on persistence failure", async () => {
  const fake = createConversationPool({
    relationshipRows: [{
      id: 31,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
    failOn: "INSERT INTO conversations",
  });

  await assert.rejects(
    ensureConversation({
      pool: fake.pool,
      relationshipId: 31,
    }),
    /simulated database failure/
  );

  assert.equal(
    fake.calls.some((call) => call.sql === "ROLLBACK"),
    true
  );

  assert.equal(fake.wasReleased(), true);
});

test("homeowner conversation list is owner scoped", async () => {
  const rows = [{
    id: 51,
    relationship_id: 31,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    post_id: 41,
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: null,
    business_name: "Molina Home Services",
  }];

  const fake = createReadPool((sql, params) => {
    assert.match(
      sql,
      /WHERE conversations\.homeowner_id = \$1/
    );

    assert.match(
      sql,
      /request_relationships\.homeowner_id = \$1/
    );

    assert.match(
      sql,
      /JOIN posts ON request_relationships\.post_id = posts\.id/
    );

    assert.match(
      sql,
      /posts\.title AS request_title/
    );

    assert.match(
      sql,
      /request_relationships\.post_id/
    );

    assert.match(
      sql,
      /ORDER BY conversations\.updated_at DESC, conversations\.id DESC/
    );

    assert.deepEqual(params, [7, false]);

    return { rows };
  });

  const result = await listHomeownerConversations({
    pool: fake.pool,
    homeownerUserId: 7,
  });

  assert.deepEqual(result, rows);
});

test("homeowner list can include independently archived records", async () => {
  const fake = createReadPool((sql, params) => {
    assert.match(
      sql,
      /conversations\.homeowner_archived_at IS NULL/
    );

    assert.deepEqual(params, [7, true]);

    return { rows: [] };
  });

  const result = await listHomeownerConversations({
    pool: fake.pool,
    homeownerUserId: 7,
    includeArchived: true,
  });

  assert.deepEqual(result, []);
});

test("professional conversation list enforces business ownership", async () => {
  const rows = [{
    id: 51,
    relationship_id: 31,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    professional_archived_at: null,
    post_id: 41,
    request_title: "Kitchen drywall repair",
  }];

  const fake = createReadPool((sql, params) => {
    assert.match(
      sql,
      /WHERE conversations\.professional_user_id = \$1/
    );

    assert.match(
      sql,
      /contractor_profiles\.user_id = \$1/
    );

    assert.match(
      sql,
      /request_relationships\.professional_user_id = \$1/
    );

    assert.deepEqual(params, [9, false]);

    return { rows };
  });

  const result = await listProfessionalConversations({
    pool: fake.pool,
    professionalUserId: 9,
  });

  assert.deepEqual(result, rows);
});

test("professional list can include independently archived records", async () => {
  const fake = createReadPool((sql, params) => {
    assert.match(
      sql,
      /conversations\.professional_archived_at IS NULL/
    );

    assert.deepEqual(params, [9, true]);

    return { rows: [] };
  });

  const result = await listProfessionalConversations({
    pool: fake.pool,
    professionalUserId: 9,
    includeArchived: true,
  });

  assert.deepEqual(result, []);
});

test("conversation detail is available only to a participant", async () => {
  const row = {
    id: 51,
    relationship_id: 31,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
  };

  const fake = createReadPool((sql, params) => {
    assert.match(
      sql,
      /conversations\.homeowner_id = \$2/
    );

    assert.match(
      sql,
      /conversations\.professional_user_id = \$2/
    );

    assert.deepEqual(params, [51, 7]);

    return { rows: [row] };
  });

  const result = await getConversation({
    pool: fake.pool,
    conversationId: 51,
    participantUserId: 7,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    code: "CONVERSATION_FOUND",
    conversation: row,
  });
});

test("unrelated users receive no conversation disclosure", async () => {
  const fake = createReadPool(() => ({ rows: [] }));

  const result = await getConversation({
    pool: fake.pool,
    conversationId: 51,
    participantUserId: 10,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    code: "CONVERSATION_NOT_FOUND",
    message: "The conversation was not found.",
  });
});

test("invalid conversation identifiers fail before database access", async () => {
  let queried = false;

  const result = await getConversation({
    pool: {
      async query() {
        queried = true;
        return { rows: [] };
      },
    },
    conversationId: "0",
    participantUserId: 7,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    code: "INVALID_CONVERSATION_ID",
    message: "A valid conversation ID is required.",
  });

  assert.equal(queried, false);
});

test("conversation services validate the database dependency", async () => {
  await assert.rejects(
    ensureConversation({
      pool: null,
      relationshipId: 31,
    }),
    /database pool or client/
  );

  await assert.rejects(
    listHomeownerConversations({
      pool: null,
      homeownerUserId: 7,
    }),
    /database pool or client/
  );

  await assert.rejects(
    listProfessionalConversations({
      pool: {},
      professionalUserId: 9,
    }),
    /database pool or client/
  );

  await assert.rejects(
    getConversation({
      pool: {},
      conversationId: 51,
      participantUserId: 7,
    }),
    /database pool or client/
  );
});


test("client-level conversation ensure does not control the caller transaction", async () => {
  const calls = [];

  const client = {
    async query(sql, params = []) {
      const normalized = normalizeSql(sql);
      calls.push({ sql: normalized, params });

      if (
        normalized.includes("FROM request_relationships") &&
        normalized.includes("FOR UPDATE")
      ) {
        return {
          rows: [{
            id: 31,
            post_id: 41,
            homeowner_id: 7,
            contractor_id: 80,
            professional_user_id: 9,
            status: "active",
          }],
        };
      }

      if (
        normalized.includes("WITH inserted AS") &&
        normalized.includes("INSERT INTO conversations")
      ) {
        return {
          rows: [{
            id: 51,
            relationship_id: 31,
            homeowner_id: 7,
            contractor_id: 80,
            professional_user_id: 9,
            status: "active",
            created: true,
          }],
        };
      }

      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };

  const result = await ensureConversationWithClient({
    client,
    relationshipId: 31,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "CONVERSATION_CREATED");

  for (const transactionCommand of [
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
  ]) {
    assert.equal(
      calls.some((call) => call.sql === transactionCommand),
      false
    );
  }
});

test("client-level conversation ensure never releases a caller-owned client", async () => {
  let released = false;

  const client = {
    async query(sql) {
      const normalized = normalizeSql(sql);

      if (
        normalized.includes("FROM request_relationships") &&
        normalized.includes("FOR UPDATE")
      ) {
        return {
          rows: [{
            id: 31,
            post_id: 41,
            homeowner_id: 7,
            contractor_id: 80,
            professional_user_id: 9,
            status: "active",
          }],
        };
      }

      if (
        normalized.includes("WITH inserted AS") &&
        normalized.includes("INSERT INTO conversations")
      ) {
        return {
          rows: [{
            id: 51,
            relationship_id: 31,
            homeowner_id: 7,
            contractor_id: 80,
            professional_user_id: 9,
            status: "active",
            created: false,
          }],
        };
      }

      throw new Error(`Unexpected SQL: ${normalized}`);
    },

    release() {
      released = true;
    },
  };

  const result = await ensureConversationWithClient({
    client,
    relationshipId: 31,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "CONVERSATION_EXISTS");
  assert.equal(released, false);
});
