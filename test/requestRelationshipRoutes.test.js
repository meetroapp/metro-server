"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET =
  "explicit-test-jwt-secret-request-relationship-routes";

const {
  app,
  createToken,
} = require("../index");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function getHandlers(method, path) {
  const layer = app.router.stack.find(
    (item) =>
      item.route?.path === path &&
      item.route.methods[method]
  );

  assert.ok(
    layer,
    `Route not found: ${method.toUpperCase()} ${path}`
  );

  return layer.route.stack.map((item) => item.handle);
}

function response() {
  return {
    statusCode: 200,
    body: null,
    finished: false,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(body) {
      this.body = body;
      this.finished = true;
      return this;
    },
  };
}

async function invoke({
  userId = 9,
  postId = "41",
  body = {
    introduction_text: "I can help with this project.",
  },
  pool,
} = {}) {
  const user = {
    id: userId,
    email: `user${userId}@example.test`,
    role: "user",
    token_version: 0,
  };

  app.locals.pool = pool;

  const req = {
    app,
    body,
    params: {
      postId,
    },
    headers: {
      authorization: `Bearer ${createToken(user)}`,
    },
    user,
  };

  const res = response();

  try {
    for (const handler of getHandlers(
      "post",
      "/professional-request-opportunities/:postId/respond"
    )) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise((resolve, reject) => {
        const next = (error) =>
          error ? reject(error) : resolve();

        Promise.resolve(
          handler(req, res, next)
        ).then(
          () => {
            if (res.finished) resolve();
          },
          reject
        );
      });
    }

    return res;
  } finally {
    delete app.locals.pool;
  }
}

function createFakePool({
  profileRows = [{
    id: 80,
    user_id: 9,
    category: "handyman",
    profile_details: {
      city: "Cape Coral",
      postal_code: "33990",
      service_area: "Lee County",
      service_specialties: ["drywall_repair"],
    },
  }],

  requestRows = [{
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
  }],

  relationshipRows = [{
    id: 51,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "pending",
    introduction_text: "I can help with this project.",
    created_at: "2026-07-20T12:00:00.000Z",
    responded_at: "2026-07-20T12:00:00.000Z",
    created: true,
  }],
} = {}) {
  const calls = [];
  let released = false;

  const client = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }

      if (
        sql.includes("SELECT id, email, role, token_version") &&
        sql.includes("FROM users")
      ) {
        return {
          rows: [{
            id: values[0],
            email: `user${values[0]}@example.test`,
            role: "user",
            token_version: 0,
          }],
        };
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

  return {
    calls,

    pool: {
      async connect() {
        return client;
      },

      async query(text, values = []) {
        return client.query(text, values);
      },
    },

    wasReleased() {
      return released;
    },
  };
}

test("professional response route creates a pending relationship", async () => {
  const fake = createFakePool();

  const result = await invoke({
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 201);

  assert.deepEqual(result.body, {
    success: true,
    code: "REQUEST_RELATIONSHIP_CREATED",
    relationship: {
      id: 51,
      request_id: 41,
      contractor_id: 80,
      status: "pending",
      introduction_text:
        "I can help with this project.",
      created_at: "2026-07-20T12:00:00.000Z",
      responded_at: "2026-07-20T12:00:00.000Z",
      conversation_available: false,
    },
    created: true,
  });

  assert.equal(
    Object.hasOwn(result.body.relationship, "homeowner_id"),
    false
  );

  assert.equal(
    Object.hasOwn(
      result.body.relationship,
      "professional_user_id"
    ),
    false
  );

  assert.equal(fake.wasReleased(), true);
});

test("repeated professional response returns existing relationship", async () => {
  const fake = createFakePool({
    relationshipRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "pending",
      introduction_text: "Original introduction",
      created_at: "2026-07-20T12:00:00.000Z",
      responded_at: "2026-07-20T12:00:00.000Z",
      created: false,
    }],
  });

  const result = await invoke({
    pool: fake.pool,
    body: {
      introduction_text:
        "Repeated click must not create another relationship.",
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(
    result.body.code,
    "REQUEST_RELATIONSHIP_EXISTS"
  );
  assert.equal(result.body.created, false);
  assert.equal(result.body.relationship.id, 51);
});

test("invalid request ID is rejected before relationship queries", async () => {
  const fake = createFakePool();

  const result = await invoke({
    pool: fake.pool,
    postId: "41abc",
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, "INVALID_REQUEST_ID");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("FROM contractor_profiles")
    ),
    false
  );
});

test("missing introduction is rejected", async () => {
  const fake = createFakePool();

  const result = await invoke({
    pool: fake.pool,
    body: {},
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, "INTRODUCTION_REQUIRED");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("INSERT INTO request_relationships")
    ),
    false
  );
});

test("professional profile is required", async () => {
  const fake = createFakePool({
    profileRows: [],
  });

  const result = await invoke({
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 403);
  assert.equal(
    result.body.code,
    "PROFESSIONAL_PROFILE_REQUIRED"
  );

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("FROM posts")
    ),
    false
  );
});

test("same-owner, closed, or unavailable request fails closed", async () => {
  const fake = createFakePool({
    requestRows: [],
  });

  const result = await invoke({
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 404);
  assert.equal(result.body.code, "REQUEST_NOT_AVAILABLE");

  const requestQuery = fake.calls.find((call) =>
    call.sql.includes("FROM posts")
  );

  assert.ok(requestQuery);
  assert.match(requestQuery.sql, /status = 'open'/);
  assert.match(requestQuery.sql, /user_id <> \$2/);
});

test("ineligible professional cannot create a relationship", async () => {
  const fake = createFakePool({
    profileRows: [{
      id: 80,
      user_id: 9,
      category: "plumbing",
      profile_details: {
        city: "Miami",
        postal_code: "33101",
        service_area: "Miami",
        service_specialties: ["plumbing_repair"],
      },
    }],
  });

  const result = await invoke({
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, "REQUEST_NOT_ELIGIBLE");

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("INSERT INTO request_relationships")
    ),
    false
  );
});

async function invokeHomeownerRelationshipInbox({
  userId = 7,
  pool,
} = {}) {
  const user = {
    id: userId,
    email: `user${userId}@example.test`,
    role: "user",
    token_version: 0,
  };

  app.locals.pool = pool;

  const req = {
    app,
    body: {},
    params: {},
    headers: {
      authorization: `Bearer ${createToken(user)}`,
    },
    user,
  };

  const res = response();

  try {
    for (const handler of getHandlers(
      "get",
      "/my-request-relationships"
    )) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise((resolve, reject) => {
        const next = (error) =>
          error ? reject(error) : resolve();

        Promise.resolve(
          handler(req, res, next)
        ).then(
          () => {
            if (res.finished) resolve();
          },
          reject
        );
      });
    }

    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("homeowner relationship inbox returns privacy-safe professional responses", async () => {
  const calls = [];

  const pool = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (
        sql.includes("SELECT id, email, role, token_version") &&
        sql.includes("FROM users")
      ) {
        return {
          rows: [{
            id: values[0],
            email: `user${values[0]}@example.test`,
            role: "user",
            token_version: 0,
          }],
        };
      }

      if (sql.includes("FROM request_relationships")) {
        return {
          rows: [{
            id: 51,
            post_id: 41,
            homeowner_id: 7,
            professional_user_id: 9,
            contractor_id: 80,
            request_title: "Drywall Repair",
            business_name: "Trusted Repairs",
            business_image_url:
              "https://example.test/logo.jpg",
            professional_category: "handyman",
            introduction_text: "I can help.",
            status: "pending",
            created_at: "2026-07-20T12:00:00.000Z",
            responded_at: "2026-07-20T12:00:00.000Z",
          }],
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await invokeHomeownerRelationshipInbox({
    userId: 7,
    pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    relationships: [{
      id: 51,
      request_id: 41,
      contractor_id: 80,
      request_title: "Drywall Repair",
      business_name: "Trusted Repairs",
      business_image_url:
        "https://example.test/logo.jpg",
      professional_category: "handyman",
      introduction_text: "I can help.",
      status: "pending",
      created_at: "2026-07-20T12:00:00.000Z",
      responded_at: "2026-07-20T12:00:00.000Z",
    }],
  });

  const projection = result.body.relationships[0];

  assert.equal(
    Object.hasOwn(projection, "homeowner_id"),
    false
  );

  assert.equal(
    Object.hasOwn(projection, "professional_user_id"),
    false
  );

  const query = calls.find((call) =>
    call.sql.includes("FROM request_relationships")
  );

  assert.ok(query);
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

test("homeowner relationship inbox returns an empty authoritative list", async () => {
  const pool = {
    async query(text, values = []) {
      const sql = normalizeSql(text);

      if (
        sql.includes("SELECT id, email, role, token_version") &&
        sql.includes("FROM users")
      ) {
        return {
          rows: [{
            id: values[0],
            email: `user${values[0]}@example.test`,
            role: "user",
            token_version: 0,
          }],
        };
      }

      if (sql.includes("FROM request_relationships")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await invokeHomeownerRelationshipInbox({
    userId: 7,
    pool,
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    success: true,
    relationships: [],
  });
});

async function invokeHomeownerRelationshipTransition({
  action,
  userId = 7,
  relationshipId = "51",
  pool,
} = {}) {
  const user = {
    id: userId,
    email: `user${userId}@example.test`,
    role: "user",
    token_version: 0,
  };

  const path =
    `/request-relationships/:relationshipId/${action}`;

  app.locals.pool = pool;

  const req = {
    app,
    body: {},
    params: {
      relationshipId,
    },
    headers: {
      authorization: `Bearer ${createToken(user)}`,
    },
    user,
  };

  const res = response();

  try {
    for (const handler of getHandlers("post", path)) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise((resolve, reject) => {
        const next = (error) =>
          error ? reject(error) : resolve();

        Promise.resolve(
          handler(req, res, next)
        ).then(
          () => {
            if (res.finished) resolve();
          },
          reject
        );
      });
    }

    return res;
  } finally {
    delete app.locals.pool;
  }
}

function createRelationshipTransitionRoutePool({
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
    declined_at: null,
  }],
} = {}) {
  const calls = [];
  let released = false;

  const client = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

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

      async query(text, values = []) {
        const sql = normalizeSql(text);

        if (
          sql.includes("SELECT id, email, role, token_version") &&
          sql.includes("FROM users")
        ) {
          return {
            rows: [{
              id: values[0],
              email: `user${values[0]}@example.test`,
              role: "user",
              token_version: 0,
            }],
          };
        }

        return client.query(text, values);
      },
    },

    wasReleased() {
      return released;
    },
  };
}

test("homeowner accept route activates the owned pending relationship", async () => {
  const fake = createRelationshipTransitionRoutePool();

  const result = await invokeHomeownerRelationshipTransition({
    action: "accept",
    userId: 7,
    relationshipId: "51",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    code: "REQUEST_RELATIONSHIP_ACCEPTED",
    relationship: {
      id: 51,
      request_id: 41,
      contractor_id: 80,
      status: "active",
      accepted_at: "2026-07-20T13:00:00.000Z",
      conversation_available: true,
    },
  });

  assert.equal(
    Object.hasOwn(result.body.relationship, "homeowner_id"),
    false
  );

  assert.equal(
    Object.hasOwn(
      result.body.relationship,
      "professional_user_id"
    ),
    false
  );

  assert.equal(fake.wasReleased(), true);
});

test("homeowner decline route closes the pending response without conversation access", async () => {
  const fake = createRelationshipTransitionRoutePool({
    updatedRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "declined",
      accepted_at: null,
      declined_at: "2026-07-20T13:00:00.000Z",
    }],
  });

  const result = await invokeHomeownerRelationshipTransition({
    action: "decline",
    userId: 7,
    relationshipId: 51,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    code: "REQUEST_RELATIONSHIP_DECLINED",
    relationship: {
      id: 51,
      request_id: 41,
      contractor_id: 80,
      status: "declined",
      declined_at: "2026-07-20T13:00:00.000Z",
      conversation_available: false,
    },
  });
});

test("unrelated homeowner cannot accept another homeowner relationship", async () => {
  const fake = createRelationshipTransitionRoutePool({
    relationshipRows: [],
  });

  const result = await invokeHomeownerRelationshipTransition({
    action: "accept",
    userId: 8,
    relationshipId: 51,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 404);
  assert.equal(
    result.body.code,
    "REQUEST_RELATIONSHIP_NOT_FOUND"
  );

  assert.equal(
    fake.calls.some((call) =>
      call.sql.startsWith("UPDATE request_relationships")
    ),
    false
  );
});

test("homeowner cannot transition a relationship twice", async () => {
  const fake = createRelationshipTransitionRoutePool({
    relationshipRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
  });

  const result = await invokeHomeownerRelationshipTransition({
    action: "decline",
    userId: 7,
    relationshipId: 51,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "REQUEST_RELATIONSHIP_NOT_PENDING"
  );
});

test("invalid relationship ID is rejected by homeowner transition routes", async () => {
  const fake = createRelationshipTransitionRoutePool();

  const result = await invokeHomeownerRelationshipTransition({
    action: "accept",
    userId: 7,
    relationshipId: "51abc",
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 400);
  assert.equal(
    result.body.code,
    "INVALID_RELATIONSHIP_ID"
  );

  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes("FROM request_relationships")
    ),
    false
  );
});

async function invokeProfessionalRelationshipInbox({
  userId = 9,
  pool,
} = {}) {
  const user = {
    id: userId,
    email: `user${userId}@example.test`,
    role: "user",
    token_version: 0,
  };

  app.locals.pool = pool;

  const req = {
    app,
    body: {},
    params: {},
    headers: {
      authorization: `Bearer ${createToken(user)}`,
    },
    user,
  };

  const res = response();

  try {
    for (const handler of getHandlers(
      "get",
      "/professional-request-relationships"
    )) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise((resolve, reject) => {
        const next = (error) =>
          error ? reject(error) : resolve();

        Promise.resolve(handler(req, res, next)).then(
          () => {
            if (res.finished) resolve();
          },
          reject
        );
      });
    }

    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("professional relationship inbox returns owned privacy-safe request state", async () => {
  const calls = [];

  const pool = {
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (
        sql.includes("SELECT id, email, role, token_version") &&
        sql.includes("FROM users")
      ) {
        return {
          rows: [{
            id: values[0],
            email: `user${values[0]}@example.test`,
            role: "user",
            token_version: 0,
          }],
        };
      }

      if (sql.includes("FROM request_relationships")) {
        return {
          rows: [{
            id: 51,
            post_id: 41,
            contractor_id: 80,
            professional_user_id: 9,
            request_title: "Drywall Repair",
            request_description: "Repair damaged drywall",
            request_category: "drywall",
            service_domain: "home_services",
            service_specialty: "drywall_repair",
            introduction_text: "I can help.",
            status: "active",
            created_at: "2026-07-20T12:00:00.000Z",
            responded_at: "2026-07-20T12:00:00.000Z",
            accepted_at: "2026-07-20T13:00:00.000Z",
            declined_at: null,
            withdrawn_at: null,
            closed_at: null,
          }],
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await invokeProfessionalRelationshipInbox({
    userId: 9,
    pool,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.relationships.length, 1);

  const relationship = result.body.relationships[0];

  assert.equal(relationship.id, 51);
  assert.equal(relationship.request_id, 41);
  assert.equal(relationship.status, "active");
  assert.equal(relationship.conversation_available, true);

  assert.equal(
    Object.hasOwn(relationship, "homeowner_id"),
    false
  );

  assert.equal(
    Object.hasOwn(relationship, "professional_user_id"),
    false
  );

  const query = calls.find((call) =>
    call.sql.includes("FROM request_relationships")
  );

  assert.ok(query);
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

async function invokeProfessionalRelationshipWithdraw({
  userId = 9,
  relationshipId = "51",
  pool,
} = {}) {
  const user = {
    id: userId,
    email: `user${userId}@example.test`,
    role: "user",
    token_version: 0,
  };

  app.locals.pool = pool;

  const req = {
    app,
    body: {},
    params: {
      relationshipId,
    },
    headers: {
      authorization: `Bearer ${createToken(user)}`,
    },
    user,
  };

  const res = response();

  try {
    for (const handler of getHandlers(
      "post",
      "/request-relationships/:relationshipId/withdraw"
    )) {
      if (res.finished) break;

      if (handler.length < 3) {
        await handler(req, res);
        continue;
      }

      await new Promise((resolve, reject) => {
        const next = (error) =>
          error ? reject(error) : resolve();

        Promise.resolve(handler(req, res, next)).then(
          () => {
            if (res.finished) resolve();
          },
          reject
        );
      });
    }

    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("professional withdraw route withdraws only an owned pending response", async () => {
  const fake = createRelationshipTransitionRoutePool({
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

  const result = await invokeProfessionalRelationshipWithdraw({
    userId: 9,
    relationshipId: 51,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(result.body, {
    success: true,
    code: "REQUEST_RELATIONSHIP_WITHDRAWN",
    relationship: {
      id: 51,
      request_id: 41,
      contractor_id: 80,
      status: "withdrawn",
      withdrawn_at: "2026-07-20T14:00:00.000Z",
      conversation_available: false,
    },
  });

  assert.equal(fake.wasReleased(), true);
});

test("unrelated professional cannot withdraw another business response", async () => {
  const fake = createRelationshipTransitionRoutePool({
    relationshipRows: [],
  });

  const result = await invokeProfessionalRelationshipWithdraw({
    userId: 10,
    relationshipId: 51,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 404);
  assert.equal(
    result.body.code,
    "REQUEST_RELATIONSHIP_NOT_FOUND"
  );

  assert.equal(
    fake.calls.some((call) =>
      call.sql.startsWith("UPDATE request_relationships")
    ),
    false
  );
});

test("active relationship cannot be withdrawn", async () => {
  const fake = createRelationshipTransitionRoutePool({
    relationshipRows: [{
      id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    }],
  });

  const result = await invokeProfessionalRelationshipWithdraw({
    userId: 9,
    relationshipId: 51,
    pool: fake.pool,
  });

  assert.equal(result.statusCode, 409);
  assert.equal(
    result.body.code,
    "REQUEST_RELATIONSHIP_NOT_PENDING"
  );
});
