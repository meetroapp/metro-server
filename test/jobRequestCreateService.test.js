"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-job-request-create";
process.env.CLOUDINARY_CLOUD_NAME = "demo";
process.env.CLOUDINARY_API_KEY = "key";
process.env.CLOUDINARY_API_SECRET = "secret";
process.env.CLOUDINARY_UPLOAD_FOLDER = "meetro-test";

const { MediaValidationError } = require("../server/media/cloudinary");
const { app, createToken } = require("../index");
const {
  COMMAND_NAME,
  COMMAND_SCOPE,
  createJobRequest,
  createJobRequestFingerprint,
  validateJobRequestIdempotencyKey,
} = require("../server/requests/jobRequestCreateService");
const { professionalCanSeeRequest } = require("../server/requests/requestLifecycle");

const HOMEOWNER_ID = 7;
const OTHER_HOMEOWNER_ID = 8;
const PROFESSIONAL_ID = 9;
const INTERNAL_ID = 10;

function validPayload(overrides = {}) {
  return {
    title: "Interior painting",
    description: "Paint the living room walls.",
    category: "painting",
    request_category: "painting",
    service_domain: "home_services",
    service_specialty: "painting",
    location: "Cape Coral, FL 33904",
    location_intake_mode: "exact_on_file",
    service_address_line1: "123 Palm Ave",
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
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

function validPhoto(publicId = "meetro-test/users/7/request-photos/photo-a") {
  return {
    purpose: "request-photo",
    media: {
      secure_url: `https://res.cloudinary.com/demo/image/upload/v123/${publicId}.jpg`,
      public_id: publicId,
      resource_type: "image",
      format: "jpg",
      bytes: 1234,
      width: 800,
      height: 600,
      version: 123,
    },
  };
}

function rowFromPostValues(id, values, requestPhotos) {
  return {
    id,
    user_id: values[0],
    title: values[1],
    description: values[2],
    category: values[3],
    request_category: values[4],
    service_domain: values[5],
    service_specialty: values[6],
    location: values[7],
    unit_number: values[8],
    access_notes: values[9],
    status: "open",
    image_url: values[10],
    request_photos: requestPhotos,
    location_intake_mode: values[12],
    location_normalization_status: values[13],
    service_address_line1: values[14],
    service_city: values[15],
    service_region: values[16],
    service_postal_code: values[17],
    service_country_code: values[18],
    discovery_area_label: values[19],
    lifecycle_contract_version: Number(values[20] || 1),
    created_at: `2026-08-07T12:00:0${id}.000Z`,
    updated_at: `2026-08-07T12:00:0${id}.000Z`,
    cancelled_at: null,
  };
}

function createPool({
  users = new Map([
    [HOMEOWNER_ID, { id: HOMEOWNER_ID, role: "homeowner", account_type: "homeowner" }],
    [OTHER_HOMEOWNER_ID, { id: OTHER_HOMEOWNER_ID, role: "homeowner", account_type: "homeowner" }],
    [PROFESSIONAL_ID, { id: PROFESSIONAL_ID, role: "painting", account_type: "professional" }],
    [INTERNAL_ID, { id: INTERNAL_ID, role: "admin", account_type: "internal" }],
  ]),
  failAt,
} = {}) {
  const state = {
    posts: [],
    idempotency: [],
    relationships: [],
    responses: [],
    selections: [],
    conversations: [],
    messages: [],
    quotes: [],
    invoices: [],
    evaluations: [],
    reportedConcerns: [],
  };
  const calls = [];
  let transactionSnapshot = null;

  const pool = {
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });

      if (sql === "BEGIN") {
        transactionSnapshot = JSON.parse(JSON.stringify(state));
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        transactionSnapshot = null;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (transactionSnapshot) {
          for (const key of Object.keys(state)) {
            state[key] = transactionSnapshot[key];
          }
        }
        transactionSnapshot = null;
        return { rows: [] };
      }

      if (sql.includes("SELECT id, email, role, token_version FROM users")) {
        const user = users.get(Number(values[0]));
        return {
          rows: user
            ? [{
                id: user.id,
                email: `user${user.id}@example.test`,
                role: user.role,
                token_version: 0,
              }]
            : [],
        };
      }

      if (sql.includes("request_service_authority:authenticated_account")) {
        const user = users.get(Number(values[0]));
        return { rows: user ? [user] : [] };
      }

      if (sql.includes("opportunity_alert:eligible_professional_profiles")) {
        return { rows: [] };
      }

      if (sql.includes("job_request_create:idempotency_reserve")) {
        const [id, actorUserId, commandName, commandScope, key, fingerprint] = values;
        const existing = state.idempotency.find((row) =>
          Number(row.actor_user_id) === Number(actorUserId) &&
          row.command_name === commandName &&
          row.command_scope === commandScope &&
          row.idempotency_key === key
        );
        if (existing) return { rows: [] };
        const row = {
          id,
          actor_user_id: actorUserId,
          command_name: commandName,
          command_scope: commandScope,
          idempotency_key: key,
          request_fingerprint: fingerprint,
          post_id: null,
          result_classification: null,
          result_reference: null,
          completed_at: null,
        };
        state.idempotency.push(row);
        return { rows: [row] };
      }

      if (sql.includes("job_request_create:idempotency_existing")) {
        const [actorUserId, commandName, commandScope, key] = values;
        return {
          rows: state.idempotency.filter((row) =>
            Number(row.actor_user_id) === Number(actorUserId) &&
            row.command_name === commandName &&
            row.command_scope === commandScope &&
            row.idempotency_key === key
          ).slice(0, 1),
        };
      }

      if (sql.includes("job_request_create:insert_post") || sql.includes("INSERT INTO posts")) {
        if (failAt === "insert_post") throw new Error("private insert failure");
        const id = state.posts.length + 1;
        const requestPhotos = JSON.parse(values[11] || "[]");
        const row = rowFromPostValues(id, values, requestPhotos);
        state.posts.push(row);
        return { rows: [row] };
      }

      if (sql.includes("reported_concern:create")) {
        if (failAt === "reported_concern") {
          throw new Error("private concern failure");
        }
        const [id, postId, reporterUserId, originalText, sourceEvidenceId, sequence, integrityHash] = values;
        const row = {
          id,
          job_request_id: postId,
          reporter_user_id: reporterUserId,
          original_text: originalText,
          source_evidence_id: sourceEvidenceId,
          sequence,
          integrity_algorithm: "sha256",
          integrity_hash: integrityHash,
          integrity_version: 1,
          reported_at: "2026-08-09T12:00:00.000Z",
          created_at: "2026-08-09T12:00:00.000Z",
        };
        state.reportedConcerns.push(row);
        return { rows: [row] };
      }

      if (sql.includes("job_request_create:idempotency_complete")) {
        if (failAt === "idempotency_complete") {
          throw new Error("private idempotency failure");
        }
        const [id, postId, classification, reference] = values;
        const row = state.idempotency.find((item) => item.id === id);
        if (!row || row.completed_at) return { rows: [] };
        row.post_id = postId;
        row.result_classification = classification;
        row.result_reference = JSON.parse(reference);
        row.completed_at = "2026-08-07T12:00:30.000Z";
        return { rows: [row] };
      }

      if (sql.includes("job_request_create:owned_post")) {
        return {
          rows: state.posts.filter((row) =>
            Number(row.id) === Number(values[0]) &&
            Number(row.user_id) === Number(values[1])
          ).slice(0, 1),
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  return { calls, pool, state, users };
}

function submit(fixture, overrides = {}) {
  return createJobRequest({
    pool: fixture.pool,
    authenticatedActor: { id: HOMEOWNER_ID },
    payload: validPayload(),
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  });
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
    headers: new Map(),
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
  };
}

async function invokePost({
  fixture,
  body = validPayload(),
  headers = {},
  actorUserId = HOMEOWNER_ID,
  actorRole = "homeowner",
} = {}) {
  app.locals.pool = fixture.pool;
  const req = {
    app,
    body,
    params: {},
    headers: {
      authorization: `Bearer ${createToken({
        id: actorUserId,
        email: `user${actorUserId}@example.test`,
        role: actorRole,
        token_version: 0,
      })}`,
      ...headers,
    },
  };
  const res = response();
  try {
    for (const handler of getHandlers("post", "/posts")) {
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

test("migration defines durable job request create command idempotency", () => {
  const sql = readFileSync(
    join(__dirname, "../migrations/202608070001_create_job_request_create_command_idempotency.sql"),
    "utf8"
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS job_request_create_command_idempotency/i);
  assert.match(sql, /\bid UUID PRIMARY KEY\b/i);
  assert.match(sql, /actor_user_id INTEGER NOT NULL[\s\S]*REFERENCES users\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(sql, /post_id INTEGER[\s\S]*REFERENCES posts\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(sql, /command_name TEXT NOT NULL DEFAULT 'job_request\.create'/i);
  assert.match(sql, /command_scope TEXT NOT NULL DEFAULT 'ordinary'/i);
  assert.match(sql, /request_fingerprint TEXT NOT NULL[\s\S]*request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /UNIQUE \([\s\S]*actor_user_id,[\s\S]*command_name,[\s\S]*command_scope,[\s\S]*idempotency_key[\s\S]*\)/i);
  assert.match(sql, /job_request_create_command_completion_check/i);
  assert.match(sql, /job_request_create_command_result_idx/i);
});

test("idempotency keys are required UUIDs", () => {
  assert.equal(validateJobRequestIdempotencyKey(null).code, "JOB_REQUEST_IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(validateJobRequestIdempotencyKey("").code, "JOB_REQUEST_IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(validateJobRequestIdempotencyKey("not-a-uuid").code, "JOB_REQUEST_IDEMPOTENCY_KEY_INVALID");
  assert.equal(
    validateJobRequestIdempotencyKey("11111111-1111-4111-8111-111111111111").value,
    "11111111-1111-4111-8111-111111111111"
  );
});

test("fingerprints are stable, canonical-content sensitive, and photo-order sensitive", () => {
  const first = createJobRequestFingerprint({
    request: validPayload(),
    requestPhotos: [
      { public_id: "a", resource_type: "image", format: "jpg", bytes: 1, width: 2, height: 3, version: 4, display_order: 0 },
      { public_id: "b", resource_type: "image", format: "jpg", bytes: 1, width: 2, height: 3, version: 4, display_order: 1 },
    ],
  });
  const same = createJobRequestFingerprint({
    request: { ...validPayload(), title: " Interior painting " },
    requestPhotos: [
      { public_id: "a", resource_type: "image", format: "jpg", bytes: 1, width: 2, height: 3, version: 4, display_order: 0 },
      { public_id: "b", resource_type: "image", format: "jpg", bytes: 1, width: 2, height: 3, version: 4, display_order: 1 },
    ],
  });
  const changedContent = createJobRequestFingerprint({
    request: validPayload({ title: "Kitchen painting" }),
    requestPhotos: [],
  });
  const changedStreet = createJobRequestFingerprint({
    request: validPayload({ service_address_line1: "125 Palm Ave" }),
    requestPhotos: [],
  });
  const changedPostal = createJobRequestFingerprint({
    request: validPayload({ service_postal_code: "33905" }),
    requestPhotos: [],
  });
  const changedMode = createJobRequestFingerprint({
    request: validPayload({
      location_intake_mode: "address_after_selection",
      service_address_line1: null,
      unit_number: "",
    }),
    requestPhotos: [],
  });
  const changedOrder = createJobRequestFingerprint({
    request: validPayload(),
    requestPhotos: [
      { public_id: "b", resource_type: "image", format: "jpg", bytes: 1, width: 2, height: 3, version: 4, display_order: 0 },
      { public_id: "a", resource_type: "image", format: "jpg", bytes: 1, width: 2, height: 3, version: 4, display_order: 1 },
    ],
  });

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, changedContent);
  assert.notEqual(first, changedStreet);
  assert.notEqual(first, changedPostal);
  assert.notEqual(first, changedMode);
  assert.notEqual(first, changedOrder);
});

test("first keyed create atomically creates one post and command identity", async () => {
  const fixture = createPool();
  const result = await submit(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.code, "JOB_REQUEST_CREATED");
  assert.equal(result.post.id, 1);
  assert.equal(result.post.status, "open");
  assert.equal(result.post.service_domain, "home_services");
  assert.equal(result.post.service_specialty, "painting");
  assert.equal(result.post.location_intake_mode, "exact_on_file");
  assert.equal(result.post.location_normalization_status, "normalized");
  assert.equal(result.post.service_address_line1, "123 Palm Ave");
  assert.equal(result.post.service_city, "Cape Coral");
  assert.equal(result.post.service_region, "FL");
  assert.equal(result.post.service_postal_code, "33904");
  assert.equal(result.post.service_country_code, "US");
  assert.equal(result.post.discovery_area_label, "Cape Coral, FL");
  assert.equal(fixture.state.posts.length, 1);
  assert.equal(fixture.state.idempotency.length, 1);
  assert.equal(fixture.state.idempotency[0].post_id, 1);
  assert.equal(fixture.state.idempotency[0].completed_at !== null, true);
  assert.equal(result.post.lifecycle_contract_version, 1);
  assert.deepEqual(fixture.state.reportedConcerns, []);
});

test("server-gated v2 creation atomically preserves confirmed Reported Concern truth", async () => {
  const fixture = createPool();
  const result = await submit(fixture, {
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
      CLOUDINARY_CLOUD_NAME: "demo",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
      CLOUDINARY_UPLOAD_FOLDER: "meetro-test",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.post.lifecycle_contract_version, 2);
  assert.equal(result.reportedConcern.originalText, "Paint the living room walls.");
  assert.equal(result.reportedConcern.sequence, 1);
  assert.match(result.reportedConcern.integrity.hash, /^[0-9a-f]{64}$/);
  assert.equal(fixture.state.posts.length, 1);
  assert.equal(fixture.state.reportedConcerns.length, 1);
  assert.deepEqual(fixture.state.relationships, []);
  assert.deepEqual(fixture.state.selections, []);
});

test("v2 gate rejects incomplete readiness and browser-declared versions", async () => {
  const fixture = createPool();
  const rejected = await submit(fixture, {
    env: { JOB_LIFECYCLE_V2_ENABLED: "true" },
  });
  const browserDeclared = await submit(fixture, {
    payload: validPayload({ lifecycle_contract_version: 2 }),
  });

  assert.equal(rejected.status, 503);
  assert.equal(rejected.code, "LIFECYCLE_V2_ACTIVATION_REJECTED");
  assert.equal(browserDeclared.code, "UNSUPPORTED_REQUEST_FIELDS");
  assert.deepEqual(fixture.state.posts, []);
  assert.deepEqual(fixture.state.reportedConcerns, []);
});

test("v2 concern persistence failure rolls back request and command identity", async () => {
  const fixture = createPool({ failAt: "reported_concern" });
  const result = await submit(fixture, {
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
  });

  assert.equal(result.status, 500);
  assert.equal(result.code, "JOB_REQUEST_CREATE_FAILED");
  assert.deepEqual(fixture.state.posts, []);
  assert.deepEqual(fixture.state.reportedConcerns, []);
  assert.deepEqual(fixture.state.idempotency, []);
});

test("same actor key and canonical payload replays the first post", async () => {
  const fixture = createPool();
  const first = await submit(fixture);
  const replay = await submit(fixture);

  assert.equal(replay.ok, true);
  assert.equal(replay.status, 200);
  assert.equal(replay.code, "JOB_REQUEST_REPLAYED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.post.id, first.post.id);
  assert.equal(fixture.state.posts.length, 1);
  assert.equal(fixture.state.idempotency.length, 1);
});

test("same actor key with changed payload conflicts without another post", async () => {
  const fixture = createPool();
  await submit(fixture);
  const conflict = await submit(fixture, {
    payload: validPayload({ description: "Paint two rooms instead." }),
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "JOB_REQUEST_IDEMPOTENCY_CONFLICT");
  assert.equal(fixture.state.posts.length, 1);
  assert.equal(fixture.state.idempotency.length, 1);
});

test("same actor key conflicts when canonical structured location changes", async () => {
  for (const payload of [
    validPayload({ service_address_line1: "125 Palm Ave" }),
    validPayload({ service_postal_code: "33905" }),
    validPayload({
      location_intake_mode: "address_after_selection",
      service_address_line1: null,
      unit_number: "",
    }),
  ]) {
    const fixture = createPool();
    await submit(fixture);
    const conflict = await submit(fixture, { payload });
    assert.equal(conflict.code, "JOB_REQUEST_IDEMPOTENCY_CONFLICT");
    assert.equal(fixture.state.posts.length, 1);
  }
});

test("address-after-selection creates generalized owner truth without exact address", async () => {
  const fixture = createPool();
  const result = await submit(fixture, {
    payload: validPayload({
      location_intake_mode: "address_after_selection",
      service_address_line1: null,
      unit_number: "",
    }),
  });

  assert.equal(result.status, 201);
  assert.equal(result.post.location, "Cape Coral, FL 33904");
  assert.equal(result.post.location_intake_mode, "address_after_selection");
  assert.equal(result.post.service_address_line1, null);
  assert.equal(result.post.unit_number, "");
  assert.equal(result.post.discovery_area_label, "Cape Coral, FL");
});

test("structured create validation enforces exact and address-later location shapes", async () => {
  const cases = [
    [validPayload({ service_address_line1: "" }), "SERVICE_ADDRESS_REQUIRED"],
    [validPayload({ service_city: "" }), "SERVICE_LOCALITY_REQUIRED"],
    [validPayload({ service_region: "" }), "SERVICE_LOCALITY_REQUIRED"],
    [validPayload({ service_postal_code: "" }), "SERVICE_LOCALITY_REQUIRED"],
    [validPayload({ service_country_code: "USA" }), "SERVICE_COUNTRY_CODE_INVALID"],
    [validPayload({ location_intake_mode: "later" }), "SERVICE_LOCATION_MODE_INVALID"],
    [validPayload({
      location_intake_mode: "address_after_selection",
      service_address_line1: "123 Palm Ave",
      unit_number: "",
    }), "SERVICE_ADDRESS_NOT_ALLOWED"],
    [validPayload({
      location_intake_mode: "address_after_selection",
      service_address_line1: null,
      unit_number: "2B",
    }), "SERVICE_ADDRESS_NOT_ALLOWED"],
  ];

  for (const [payload, code] of cases) {
    const fixture = createPool();
    const result = await submit(fixture, { payload });
    assert.equal(result.code, code);
    assert.equal(fixture.state.posts.length, 0);
  }
});

test("different key and actor scoping allow deliberate separate commands", async () => {
  const fixture = createPool();
  await submit(fixture);
  const secondKey = await submit(fixture, {
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  });
  const otherActor = await submit(fixture, {
    authenticatedActor: { id: OTHER_HOMEOWNER_ID },
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(secondKey.status, 201);
  assert.equal(otherActor.status, 201);
  assert.equal(fixture.state.posts.length, 3);
  assert.equal(fixture.state.idempotency.length, 3);
});

test("REQUEST_SERVICE authority aligns homeowner and professional canonical creation", async () => {
  const fixture = createPool();
  const unauthenticated = await createJobRequest({
    pool: fixture.pool,
    authenticatedActor: {},
    payload: validPayload(),
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  });
  const professional = await submit(fixture, {
    authenticatedActor: {
      id: PROFESSIONAL_ID,
      role: "homeowner",
      account_type: "homeowner",
    },
  });
  const professionalReplay = await submit(fixture, {
    authenticatedActor: { id: PROFESSIONAL_ID, role: "customer" },
  });
  const payloadSpoof = await submit(fixture, {
    authenticatedActor: {
      id: INTERNAL_ID,
      role: "homeowner",
      account_type: "professional",
    },
    payload: validPayload({
      isRequester: true,
      requestService: true,
    }),
  });
  const forbidden = await submit(fixture, {
    authenticatedActor: {
      id: INTERNAL_ID,
      role: "homeowner",
      account_type: "professional",
    },
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.code, "AUTHENTICATION_REQUIRED");
  assert.equal(professional.status, 201);
  assert.equal(fixture.state.posts[0].user_id, PROFESSIONAL_ID);
  assert.equal(professionalReplay.status, 200);
  assert.equal(professionalReplay.post.id, professional.post.id);
  assert.equal(fixture.users.get(PROFESSIONAL_ID).account_type, "professional");
  assert.equal(fixture.users.size, 4);
  assert.equal(payloadSpoof.status, 400);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.code, "REQUEST_SERVICE_AUTHORITY_REQUIRED");
  assert.equal(fixture.state.posts.length, 1);
  assert.equal(fixture.state.idempotency.length, 1);
});

test("validation and direct-request defense fail before command reservation", async () => {
  const fixture = createPool();
  const missingTitle = await submit(fixture, {
    payload: validPayload({ title: "" }),
  });
  const unsupportedService = await submit(fixture, {
    payload: validPayload({ service_specialty: "seo" }),
  });
  const direct = await submit(fixture, {
    payload: validPayload({ direct_request: true }),
  });

  assert.equal(missingTitle.code, "INVALID_REQUEST_FIELD");
  assert.equal(unsupportedService.code, "REQUEST_MATCHING_REQUIRED");
  assert.equal(direct.code, "DIRECT_REQUEST_UNAVAILABLE");
  assert.equal(fixture.state.posts.length, 0);
  assert.equal(fixture.state.idempotency.length, 0);
});

test("governed media is persisted and ordered media changes conflict on replay", async () => {
  const fixture = createPool();
  const first = await submit(fixture, {
    payload: validPayload({
      request_photos: [
        validPhoto("meetro-test/users/7/request-photos/photo-a"),
        validPhoto("meetro-test/users/7/request-photos/photo-b"),
      ],
    }),
  });
  const replay = await submit(fixture, {
    payload: validPayload({
      request_photos: [
        validPhoto("meetro-test/users/7/request-photos/photo-a"),
        validPhoto("meetro-test/users/7/request-photos/photo-b"),
      ],
    }),
  });
  const conflict = await submit(fixture, {
    payload: validPayload({
      request_photos: [
        validPhoto("meetro-test/users/7/request-photos/photo-b"),
        validPhoto("meetro-test/users/7/request-photos/photo-a"),
      ],
    }),
  });

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.post.request_photos.length, 2);
  assert.equal(conflict.status, 409);
  assert.equal(fixture.state.posts.length, 1);
});

test("invalid media fails before canonical create", async () => {
  const fixture = createPool();
  await assert.rejects(
    submit(fixture, {
      payload: validPayload({
        request_photos: [
          validPhoto("meetro-test/users/999/request-photos/not-owned"),
        ],
      }),
    }),
    (error) =>
      error instanceof MediaValidationError &&
      error.code === "MEDIA_ASSET_OWNERSHIP_INVALID"
  );
  assert.equal(fixture.state.posts.length, 0);
  assert.equal(fixture.state.idempotency.length, 0);
});

test("persistence failures do not complete idempotency or mutate other authorities", async () => {
  const fixture = createPool({ failAt: "insert_post" });
  const result = await submit(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.code, "JOB_REQUEST_CREATE_FAILED");
  assert.deepEqual(fixture.state.posts, []);
  assert.equal(fixture.state.idempotency.length, 0);

  for (const collection of [
    "relationships",
    "responses",
    "selections",
    "conversations",
    "messages",
    "quotes",
    "invoices",
    "evaluations",
  ]) {
    assert.deepEqual(fixture.state[collection], []);
  }
});

test("created request remains compatible with professional discovery matching rules", async () => {
  const fixture = createPool();
  const result = await submit(fixture);
  const profile = {
    category: "painting",
    profile_details: {
      service_area: "Cape Coral",
      service_specialties: ["painting"],
    },
  };

  assert.equal(professionalCanSeeRequest(profile, {
    ...fixture.state.posts[0],
    user_id: result.post.id + 100,
  }), true);
});

test("command constants stay fixed to ordinary creation scope", () => {
  assert.equal(COMMAND_NAME, "job_request.create");
  assert.equal(COMMAND_SCOPE, "ordinary");
});

test("POST /posts routes all ordinary create traffic through governed idempotency", async () => {
  const keyedFixture = createPool();
  const keyed = await invokePost({
    fixture: keyedFixture,
    headers: {
      "idempotency-key": "33333333-3333-4333-8333-333333333333",
    },
  });

  assert.equal(keyed.statusCode, 201);
  assert.equal(keyed.body.success, true);
  assert.equal(keyed.body.code, "JOB_REQUEST_CREATED");
  assert.equal(keyed.body.post.id, 1);
  assert.equal(keyed.headers.get("cache-control"), "private, no-store");
  assert.equal(keyedFixture.state.idempotency.length, 1);

  const professionalFixture = createPool();
  const professional = await invokePost({
    fixture: professionalFixture,
    actorUserId: PROFESSIONAL_ID,
    actorRole: "painting",
    headers: {
      "idempotency-key": "44444444-4444-4444-8444-444444444444",
    },
  });

  assert.equal(professional.statusCode, 201);
  assert.equal(professionalFixture.state.posts[0].user_id, PROFESSIONAL_ID);
  assert.equal(professionalFixture.users.get(PROFESSIONAL_ID).account_type, "professional");
  assert.equal(professionalFixture.users.size, 4);

  const unkeyedFixture = createPool();
  const unkeyed = await invokePost({ fixture: unkeyedFixture });

  assert.equal(unkeyed.statusCode, 400);
  assert.equal(unkeyed.body.success, false);
  assert.equal(unkeyed.body.code, "JOB_REQUEST_IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(unkeyedFixture.state.posts.length, 0);
  assert.equal(unkeyedFixture.state.idempotency.length, 0);
});
