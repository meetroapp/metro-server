"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-request-lifecycle";

const { app, createToken } = require("../index");
const {
  professionalCanSeeRequest,
  serializeProfessionalOpportunity,
  validateRequestPayload,
} = require("../server/requests/requestLifecycle");

function validRequest(overrides = {}) {
  return {
    title: "Interior painting",
    description: "Paint the living room",
    category: "painting",
    request_category: "painting",
    service_domain: "home_services",
    service_specialty: "painting",
    location: "Cape Coral, FL 33904",
    unit_number: "",
    access_notes: "Call on arrival",
    request_photos: [],
    post_type: "quote_request",
    status: "open",
    direct_request: false,
    direct_request_source: "",
    direct_professional_name: "",
    direct_conversation_id: "",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    id: 41,
    user_id: 7,
    ...validRequest(),
    status: "open",
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
    cancelled_at: null,
    request_photos: [],
    ...overrides,
  };
}

function createOpportunityRoutePool({
  profileRows = [{
    id: 80,
    user_id: 9,
    category: "painting",
    profile_details: {
      service_area: "Cape Coral",
      service_specialties: ["painting"],
    },
  }],
  candidateRows = [row()],
} = {}) {
  const calls = [];
  const pool = {
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });

      if (sql.includes("FROM users WHERE id = $1")) {
        return { rows: [{ id: values[0], email: "pro@example.test", role: "painting", token_version: 0 }] };
      }
      if (sql.includes("FROM contractor_profiles")) {
        return {
          rows: profileRows.filter((profile) =>
            Number(profile.user_id) === Number(values[0])
          ),
        };
      }
      if (sql.includes("FROM posts")) {
        return {
          rows: candidateRows.filter((request) =>
            request.status === "open" &&
            Number(request.user_id) !== Number(values[0])
          ),
        };
      }
      if (sql.includes("FROM request_relationships")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  return { calls, pool };
}

function getHandlers(method, path) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((item) => item.handle);
}

function response() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
  };
}

async function invoke(method, path, { userId = 7, body = {}, params = { id: "41" }, pool } = {}) {
  const user = { id: userId, email: `user${userId}@example.test`, role: "user", token_version: 0 };
  app.locals.pool = pool;
  const req = {
    app,
    body,
    params,
    headers: { authorization: `Bearer ${createToken(user)}` },
    user,
  };
  const res = response();
  try {
    for (const handler of getHandlers(method, path)) {
      if (res.finished) break;
      if (handler.length < 3) await handler(req, res);
      else await new Promise((resolve, reject) => {
        const next = (error) => error ? reject(error) : resolve();
        Promise.resolve(handler(req, res, next)).then(() => res.finished && resolve(), reject);
      });
    }
    return res;
  } finally {
    delete app.locals.pool;
  }
}

test("generic request validation preserves canonical lifecycle fields and rejects direct requests", () => {
  const result = validateRequestPayload(validRequest());
  assert.equal(result.ok, true);
  assert.equal(result.request.service_domain, "home_services");
  assert.equal(result.request.service_specialty, "painting");

  const direct = validateRequestPayload(validRequest({ direct_request: true }));
  assert.equal(direct.ok, false);
  assert.equal(direct.code, "DIRECT_REQUEST_UNAVAILABLE");
});

test("request validation rejects unknown, unsupported, and domain-forged service IDs", () => {
  const unknown = validateRequestPayload(
    validRequest({ service_specialty: "made_up_service" })
  );
  const marketing = validateRequestPayload(
    validRequest({ service_specialty: "seo" })
  );
  const forgedDomain = validateRequestPayload(
    validRequest({ service_domain: "healthcare", service_specialty: "painting" })
  );
  const normalized = validateRequestPayload(
    validRequest({ service_specialty: " Painting " })
  );

  assert.equal(unknown.code, "REQUEST_MATCHING_REQUIRED");
  assert.equal(marketing.code, "REQUEST_MATCHING_REQUIRED");
  assert.equal(forgedDomain.code, "REQUEST_MATCHING_REQUIRED");
  assert.equal(normalized.ok, true);
  assert.equal(normalized.request.service_specialty, "painting");
});

test("professional eligibility is fail closed on domain, specialty, status, and service area", () => {
  const profile = {
    category: "painting",
    profile_details: {
      service_area: "Cape Coral",
      service_specialties: ["painting"],
    },
  };
  assert.equal(professionalCanSeeRequest(profile, row()), true);
  assert.equal(professionalCanSeeRequest(profile, row({ status: "cancelled" })), false);
  assert.equal(professionalCanSeeRequest(profile, row({ status: "closed" })), false);
  assert.equal(professionalCanSeeRequest(profile, row({ status: "withdrawn" })), false);
  assert.equal(professionalCanSeeRequest(profile, row({ location: "Miami, FL" })), false);
  assert.equal(professionalCanSeeRequest(profile, row({ service_domain: "healthcare" })), false);
  assert.equal(professionalCanSeeRequest(profile, row({ service_specialty: "plumbing" })), false);
  assert.equal(professionalCanSeeRequest(profile, row({ service_specialty: "unknown" })), false);
});

test("license and verification metadata do not alter deterministic lead eligibility", () => {
  const request = row({ service_specialty: "painting" });
  const profiles = [
    {
      category: "painting",
      profile_details: {
        service_area: "Cape Coral",
        service_specialties: ["painting"],
        license_number: "",
        verified: false,
      },
    },
    {
      category: "painting",
      profile_details: {
        service_area: "Cape Coral",
        service_specialties: ["painting"],
        license_number: "TEST-LICENSE-METADATA",
        verified: true,
      },
    },
  ];

  profiles.forEach((profile) => {
    assert.equal(professionalCanSeeRequest(profile, request), true);
  });
});

test("professional eligibility matches detailed door and window service capabilities", () => {
  const profile = {
    category: "handyman",
    profile_details: {
      service_area: "Cape Coral",
      service_specialties: [
        "door_repair_replacement",
        "door_installation",
        "garage_door_repair",
        "window_repair",
        "window_replacement",
      ],
    },
  };

  assert.equal(
    professionalCanSeeRequest(
      profile,
      row({
        title: "Door Repair",
        request_category: "doors_windows",
        service_specialty: "door_repair",
      })
    ),
    true
  );
  assert.equal(
    professionalCanSeeRequest(
      profile,
      row({
        title: "Door Repair",
        request_category: "doors_windows",
        service_specialty: "doors_windows",
      })
    ),
    true
  );
  assert.equal(
    professionalCanSeeRequest(profile, row({ service_specialty: "window_repair" })),
    true
  );
  assert.equal(
    professionalCanSeeRequest(profile, row({ service_specialty: "plumbing" })),
    false
  );
  assert.equal(
    professionalCanSeeRequest(
      profile,
      row({ service_specialty: "door_repair", location: "Miami, FL" })
    ),
    false
  );
});

test("professional projection excludes private and pre-selection authority fields", () => {
  const projected = serializeProfessionalOpportunity(row(), []);
  for (const key of [
    "user_id",
    "location",
    "unit_number",
    "access_notes",
    "conversation_id",
    "conversation_available",
    "conversation_type",
    "relationship_id",
    "professional_user_id",
    "contractor_id",
  ]) {
    assert.equal(Object.hasOwn(projected, key), false);
  }
  assert.equal(projected.request_id, 41);
  assert.equal(projected.status, "open");
  assert.equal(projected.has_responded, false);
  assert.equal(projected.professional_response_id, null);
  assert.equal(projected.response_status, null);
  assert.equal(projected.relationship_status, null);
  assert.equal(projected.submitted_at, null);
  assert.equal(projected.response_submission_available, false);
  assert.equal(Object.hasOwn(projected, "quote_request_id"), false);
});

test("professional projection ignores relationship and conversation-shaped source fields", () => {
  const projected = serializeProfessionalOpportunity(
    row({
      conversation_id: 91,
      conversation_available: true,
      conversation_type: "canonical_conversation",
      relationship_id: 51,
      contractor_id: 80,
      professional_user_id: 9,
    }),
    []
  );

  for (const key of [
    "conversation_id",
    "conversation_available",
    "conversation_type",
    "relationship_id",
    "contractor_id",
    "professional_user_id",
  ]) {
    assert.equal(Object.hasOwn(projected, key), false);
  }
});

test("owner-only edit persists canonical response and cross-user edit is not disclosed", async () => {
  const calls = [];
  const pool = {
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql.includes("FROM users WHERE id = $1")) {
        return { rows: [{ id: values[0], email: "owner@example.test", role: "user", token_version: 0 }] };
      }
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.startsWith("SELECT id, title") && sql.includes("FOR UPDATE")) {
        return { rows: Number(values[1]) === 7 ? [row()] : [] };
      }
      if (sql.startsWith("UPDATE posts")) {
        return {
          rows: Number(values[10]) === 7
            ? [row({ title: values[1], description: values[3], location: values[5] })]
            : [],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const updated = await invoke("put", "/posts/:id", {
    pool,
    body: { title: "Updated title", description: "Updated details", location: "Cape Coral, FL" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.code, "REQUEST_UPDATED");
  assert.match(calls.find((call) => call.sql.includes("FOR UPDATE")).sql, /FOR UPDATE/);
  assert.match(calls.find((call) => call.sql.startsWith("UPDATE posts")).sql, /WHERE id = \$10 AND user_id = \$11 AND status = 'open'/);

  const denied = await invoke("put", "/posts/:id", {
    userId: 8,
    pool,
    body: { title: "Unauthorized", description: "", location: "Cape Coral" },
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.body.code, "REQUEST_NOT_FOUND");
});

test("cancel is owner scoped, retained, and idempotent", async () => {
  const calls = [];
  const pool = {
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql.includes("FROM users WHERE id = $1")) {
        return { rows: [{ id: values[0], email: "owner@example.test", role: "user", token_version: 0 }] };
      }
      if (sql.startsWith("UPDATE posts")) {
        return { rows: Number(values[1]) === 7 ? [row({ status: "cancelled", cancelled_at: "2026-07-20T11:00:00.000Z" })] : [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const first = await invoke("post", "/posts/:id/cancel", { pool });
  const second = await invoke("post", "/posts/:id/cancel", { pool });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body.post.status, "cancelled");
  assert.match(calls.at(-1).sql, /cancelled_at = COALESCE/);
});

test("professional endpoint returns only eligible privacy-filtered opportunities with SELECT queries", async () => {
  const fake = createOpportunityRoutePool({
    candidateRows: [
      row({ id: 41, user_id: 7 }),
      row({ id: 42, user_id: 8, location: "Miami, FL" }),
      row({ id: 43, user_id: 8, service_specialty: "plumbing" }),
      row({ id: 44, user_id: 8 }),
    ],
  });
  const result = await invoke("get", "/professional-request-opportunities", {
    userId: 9,
    pool: fake.pool,
    params: {},
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.opportunities.map((item) => item.id), [41, 44]);
  for (const opportunity of result.body.opportunities) {
    for (const key of [
      "location",
      "unit_number",
      "access_notes",
      "entry_code",
      "email",
      "phone",
      "customer_email",
      "customer_phone",
      "user_id",
      "relationship_id",
      "professional_user_id",
      "contractor_id",
      "conversation_id",
      "conversation_available",
      "conversation_type",
      "participants",
      "messages",
      "quote_request_id",
    ]) {
      assert.equal(Object.hasOwn(opportunity, key), false);
    }
  }
  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) {
    assert.match(call.sql, /^SELECT\b/i);
    assert.doesNotMatch(
      call.sql,
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL)\b/i
    );
    assert.doesNotMatch(call.sql, /\bFOR\s+(UPDATE|SHARE)\b/i);
  }
  assert.equal(
    fake.calls.some((call) =>
      /\bconversation_participants\b|\bworkflow_events\b/i.test(call.sql)
    ),
    false
  );
});

test("opportunity endpoint does not project source-injected conversation authority", async () => {
  const fake = createOpportunityRoutePool({
    candidateRows: [row({
      conversation_id: 91,
      conversation_available: true,
      conversation_type: "canonical_conversation",
      relationship_id: 51,
    })],
  });

  const result = await invoke("get", "/professional-request-opportunities", {
    userId: 9,
    pool: fake.pool,
    params: {},
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.opportunities.length, 1);
  assert.equal(
    Object.hasOwn(result.body.opportunities[0], "conversation_id"),
    false
  );
  assert.equal(
    Object.hasOwn(result.body.opportunities[0], "conversation_available"),
    false
  );
  assert.equal(
    Object.hasOwn(result.body.opportunities[0], "relationship_id"),
    false
  );
});

test("professional opportunity endpoint requires an owned business profile", async () => {
  const fake = createOpportunityRoutePool({ profileRows: [] });

  const result = await invoke("get", "/professional-request-opportunities", {
    userId: 7,
    pool: fake.pool,
    params: {},
  });

  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, "PROFESSIONAL_PROFILE_REQUIRED");
  assert.equal(
    fake.calls.some((call) => call.sql.includes("FROM posts")),
    false
  );
});

test("request lifecycle migration is additive and constrained", () => {
  const sql = readFileSync(
    join(__dirname, "../migrations/202607200001_add_post_request_lifecycle.sql"),
    "utf8"
  );
  assert.match(sql, /ALTER TABLE posts/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'/);
  assert.match(sql, /CHECK \(status IN \('open', 'cancelled'\)\)/);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)/i);
});
