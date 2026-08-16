"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud";
process.env.CLOUDINARY_API_KEY = "test-key";
process.env.CLOUDINARY_API_SECRET = "test-secret";
process.env.CLOUDINARY_UPLOAD_FOLDER = "meetro-test";

const { MediaValidationError } = require("../server/media/cloudinary");
const {
  REQUEST_MODIFICATION_MODES,
  appendRequestPhoto,
  loadRequestModificationContext,
  resolveRequestModificationMode,
  serializeRequestModificationAuthority,
  updateRequest,
} = require("../server/requests/requestModificationService");

const CONCERN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_ID = "66666666-6666-4666-8666-666666666666";

function context(overrides = {}) {
  return {
    id: 41,
    user_id: 7,
    title: "Sink cabinet water damage",
    description: "Water is visible beneath the sink.",
    location: "Cape Coral, FL 33904",
    category: "handyman",
    request_category: "handyman",
    service_domain: "home_services",
    service_specialty: "handyman",
    location_intake_mode: "address_after_selection",
    location_normalization_status: "normalized",
    service_address_line1: null,
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    discovery_area_label: "Cape Coral, FL",
    unit_number: "",
    access_notes: "",
    status: "open",
    lifecycle_contract_version: 2,
    modification_version: 1,
    created_at: "2026-08-11T12:00:00.000Z",
    updated_at: "2026-08-11T12:00:00.000Z",
    cancelled_at: null,
    image_url: null,
    mage_url: null,
    request_photos: [],
    primary_concern_id: CONCERN_ID,
    job_id: null,
    source_request_relationship_id: null,
    actor_participant_id: null,
    actor_primary_professional_role_active: false,
    actor_evaluation_grant_active: false,
    professional_response_exists: false,
    request_relationship_exists: false,
    selection_exists: false,
    active_work_exists: false,
    ...overrides,
  };
}

function professionalContext(overrides = {}) {
  return context({
    job_id: JOB_ID,
    source_request_relationship_id: 91,
    actor_participant_id: PARTICIPANT_ID,
    actor_primary_professional_role_active: true,
    actor_evaluation_grant_active: true,
    request_relationship_exists: true,
    ...overrides,
  });
}

function logger() {
  return { info() {}, warn() {} };
}

function createEditPool(initialContext) {
  const state = {
    context: structuredClone(initialContext),
    supersessions: [],
    updates: 0,
  };
  let snapshot = null;
  return {
    state,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (sql === "BEGIN") {
        snapshot = structuredClone(state);
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        snapshot = null;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (snapshot) {
          state.context = snapshot.context;
          state.supersessions = snapshot.supersessions;
          state.updates = snapshot.updates;
        }
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes("reported_concern:request_context")) {
        return { rows: [structuredClone(state.context)] };
      }
      if (sql.includes("request_modification:concern_supersession_insert")) {
        const row = {
          id: values[0],
          concern_id: values[1],
          actor_user_id: values[2],
          actor_participant_id: null,
          semantics: "SUPERSEDES_INTERPRETATION",
          clarification_text: values[3],
          idempotency_key: values[4],
          request_fingerprint: values[5],
          created_at: "2026-08-11T12:05:00.000Z",
        };
        state.supersessions.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith("UPDATE posts")) {
        if (Number(values[23]) !== Number(state.context.modification_version)) {
          return { rows: [] };
        }
        state.updates += 1;
        state.context = {
          ...state.context,
          title: values[0] ? values[1] : state.context.title,
          description: values[2] ? values[3] : state.context.description,
          modification_version: state.context.modification_version + 1,
        };
        return { rows: [structuredClone(state.context)] };
      }
      throw new Error(`Unexpected edit query: ${sql}`);
    },
  };
}

function requestPhoto(number, userId = 7) {
  const publicId =
    `meetro-test/users/${userId}/request-photos/photo-${number}`;
  return {
    purpose: "request-photo",
    media: {
      secure_url:
        `https://res.cloudinary.com/demo-cloud/image/upload/v1/${publicId}.jpg`,
      public_id: publicId,
      resource_type: "image",
      format: "jpg",
      bytes: 2048,
      width: 1200,
      height: 800,
      version: 1,
      uploaded_at: "2026-08-11T12:10:00.000Z",
    },
  };
}

function createPhotoPool(initialContext, initialEvents = []) {
  const state = {
    context: structuredClone(initialContext),
    events: structuredClone(initialEvents),
    appendedPayloads: [],
    queries: [],
  };
  let snapshot = null;
  return {
    state,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      state.queries.push(sql);
      if (sql === "BEGIN") {
        snapshot = structuredClone(state);
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        snapshot = null;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (snapshot) {
          state.context = snapshot.context;
          state.events = snapshot.events;
          state.appendedPayloads = snapshot.appendedPayloads;
        }
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes("reported_concern:request_context")) {
        return { rows: [structuredClone(state.context)] };
      }
      if (sql.includes("lifecycle_authority:active_grant")) {
        return {
          rows: state.context.actor_evaluation_grant_active
            ? [{ id: "77777777-7777-4777-8777-777777777777" }]
            : [],
        };
      }
      if (sql.includes("request_modification:photo_existing_command")) {
        return {
          rows: state.events.filter((event) =>
            Number(event.actor_user_id) === Number(values[0]) &&
            Number(event.request_id) === Number(values[1]) &&
            event.idempotency_key === values[2]
          ).slice(0, 1),
        };
      }
      if (sql.includes("request_modification:photo_existing_media")) {
        return {
          rows: state.events.filter((event) => event.public_id === values[0])
            .map((event) => ({ request_id: event.request_id }))
            .slice(0, 1),
        };
      }
      if (sql.includes("request_modification:photo_event_insert")) {
        const row = {
          id: values[0],
          request_id: values[1],
          concern_id: values[2],
          job_id: values[3],
          actor_user_id: values[4],
          request_version: values[5],
          public_id: values[6],
          secure_url: values[7],
          media_payload: JSON.parse(values[8]),
          idempotency_key: values[9],
          request_fingerprint: values[10],
          created_at: "2026-08-11T12:11:00.000Z",
        };
        state.events.push(row);
        return { rows: [row] };
      }
      if (sql.includes("request_modification:photo_append_")) {
        if (Number(values[4]) !== Number(state.context.modification_version)) {
          return { rows: [] };
        }
        const appended = JSON.parse(values[0]);
        state.appendedPayloads.push(appended);
        state.context.request_photos = [
          ...state.context.request_photos,
          ...appended,
        ];
        state.context.modification_version += 1;
        state.context.image_url ||= values[1];
        return { rows: [structuredClone(state.context)] };
      }
      throw new Error(`Unexpected photo query: ${sql}`);
    },
  };
}

test("server-owned mode resolution covers editable, reliance, active work, and read-only", () => {
  assert.equal(
    resolveRequestModificationMode(context()),
    REQUEST_MODIFICATION_MODES.EDITABLE
  );
  assert.equal(
    resolveRequestModificationMode(context({ professional_response_exists: true })),
    REQUEST_MODIFICATION_MODES.APPEND_ONLY
  );
  assert.equal(
    resolveRequestModificationMode(context({ request_relationship_exists: true })),
    REQUEST_MODIFICATION_MODES.APPEND_ONLY
  );
  assert.equal(
    resolveRequestModificationMode(context({ job_id: JOB_ID, selection_exists: true })),
    REQUEST_MODIFICATION_MODES.APPEND_ONLY
  );
  assert.equal(
    resolveRequestModificationMode(context({ job_id: JOB_ID, active_work_exists: true })),
    REQUEST_MODIFICATION_MODES.CONTRACT_CHANGE_REQUIRED
  );
  assert.equal(
    resolveRequestModificationMode(context({ status: "cancelled" })),
    REQUEST_MODIFICATION_MODES.READ_ONLY
  );

  const authority = serializeRequestModificationAuthority(
    context({ job_id: JOB_ID, active_work_exists: true }),
    7
  );
  assert.equal(authority.actions.editRequest, false);
  assert.equal(authority.actions.appendPhoto, true);
  assert.equal(authority.actions.contractChangeGuidance, true);
});

test("request context proves exact active primary-professional relationship server-side", async () => {
  let contextQuery = "";
  const client = {
    async query(text) {
      contextQuery = String(text).replace(/\s+/g, " ").trim();
      return { rows: [professionalContext()] };
    },
  };
  const result = await loadRequestModificationContext(client, 41, 8);

  assert.equal(result.actor_participant_id, PARTICIPANT_ID);
  for (const requiredSql of [
    "jobs.job_request_id = posts.id",
    "request_relationships.id = jobs.source_request_relationship_id",
    "request_relationships.post_id = jobs.job_request_id",
    "request_relationships.professional_user_id = $2",
    "request_relationships.status = 'active'",
    "relationship_participants.request_relationship_id = request_relationships.id",
    "relationship_participants.user_id = $2",
    "participant_role_assignments.role = 'PRIMARY_PROFESSIONAL'",
    "participant_role_assignments.valid_from <= CURRENT_TIMESTAMP",
    "participant_role_revocations.id IS NULL",
    "jobs.lifecycle_contract_version = 2",
  ]) {
    assert.ok(contextQuery.includes(requiredSql), requiredSql);
  }
});

test("pre-reliance lifecycle-v2 edit advances version and appends concern supersession", async () => {
  const pool = createEditPool(context());
  const result = await updateRequest({
    pool,
    authenticatedActor: { id: 7 },
    postId: 41,
    payload: {
      expected_version: 1,
      description: "Water now appears to come from the disposal connection.",
    },
    logger: logger(),
  });

  assert.equal(result.code, "REQUEST_UPDATED");
  assert.equal(result.post.modification_version, 2);
  assert.equal(pool.state.updates, 1);
  assert.equal(pool.state.supersessions.length, 1);
  assert.equal(pool.state.supersessions[0].semantics, "SUPERSEDES_INTERPRETATION");
  assert.equal(pool.state.supersessions[0].concern_id, CONCERN_ID);
  assert.equal(pool.state.context.description, result.post.description);
  assert.equal(
    Object.hasOwn(result.concernSupersession, "request_fingerprint"),
    false
  );
});

test("response, Job, active work, cancellation, and stale version fail before rewrite", async () => {
  for (const [overrides, code] of [
    [{ professional_response_exists: true }, "REQUEST_APPEND_ONLY"],
    [{ request_relationship_exists: true }, "REQUEST_APPEND_ONLY"],
    [{ job_id: JOB_ID, selection_exists: true }, "REQUEST_APPEND_ONLY"],
    [{ job_id: JOB_ID, active_work_exists: true }, "CONTRACT_CHANGE_REQUIRED"],
    [{ status: "cancelled" }, "REQUEST_READ_ONLY"],
  ]) {
    const pool = createEditPool(context(overrides));
    const result = await updateRequest({
      pool,
      authenticatedActor: { id: 7 },
      postId: 41,
      payload: { expected_version: 1, title: "Silently rewritten" },
      logger: logger(),
    });
    assert.equal(result.code, code);
    assert.equal(pool.state.updates, 0);
  }

  const stalePool = createEditPool(context({ modification_version: 2 }));
  const stale = await updateRequest({
    pool: stalePool,
    authenticatedActor: { id: 7 },
    postId: 41,
    payload: { expected_version: 1, title: "Stale edit" },
    logger: logger(),
  });
  assert.equal(stale.code, "REQUEST_VERSION_CONFLICT");
  assert.equal(stalePool.state.updates, 0);
});

test("post-reliance photo append preserves prior media and persists provenance", async () => {
  const existing = {
    ...requestPhoto(1).media,
    purpose: "request-photo",
    display_order: 0,
    created_by_user_id: 7,
  };
  const pool = createPhotoPool(context({
    modification_version: 4,
    professional_response_exists: true,
    request_photos: [existing],
  }));
  const input = {
    pool,
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { expected_version: 4, media: requestPhoto(2) },
    idempotencyKey: "request-photo:test-append",
    logger: logger(),
  };
  const result = await appendRequestPhoto(input);
  const replay = await appendRequestPhoto(input);

  assert.equal(result.code, "REQUEST_PHOTO_ATTACHED");
  assert.equal(result.requestVersion, 5);
  assert.equal(replay.code, "REQUEST_PHOTO_ATTACHMENT_REPLAYED");
  assert.equal(pool.state.context.request_photos.length, 2);
  assert.equal(pool.state.context.request_photos[0].public_id, existing.public_id);
  assert.equal(pool.state.events.length, 1);
  assert.equal(pool.state.events[0].request_id, 41);
  assert.equal(pool.state.events[0].concern_id, CONCERN_ID);
  assert.equal(pool.state.events[0].actor_user_id, 7);
  assert.equal(pool.state.appendedPayloads.length, 1);
  assert.ok(pool.state.queries.some((sql) =>
    sql.includes("request_modification:photo_append_owner") &&
    sql.includes("AND user_id = $4")
  ));
});

test("authorized exact-Job primary professional can append governed Evaluation photo evidence", async () => {
  const pool = createPhotoPool(professionalContext({ modification_version: 3 }));
  const result = await appendRequestPhoto({
    pool,
    authenticatedActor: { id: 8 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { expected_version: 3, media: requestPhoto(1, 8) },
    idempotencyKey: "request-photo:professional-append",
    logger: logger(),
  });

  assert.equal(result.code, "REQUEST_PHOTO_ATTACHED");
  assert.equal(result.requestVersion, 4);
  assert.equal(result.photo.created_by_user_id, 8);
  assert.equal(Object.hasOwn(result, "post"), false);
  assert.equal(pool.state.context.request_photos.length, 1);
  assert.ok(pool.state.queries.some((sql) =>
    sql.includes("lifecycle_authority:active_grant")
  ));
  assert.ok(pool.state.queries.some((sql) =>
    sql.includes("request_modification:photo_append_professional") &&
    sql.includes("PRIMARY_PROFESSIONAL") &&
    sql.includes("evaluation.perform") &&
    sql.includes("request_relationships.status = 'active'")
  ));
  const mutationQueries = pool.state.queries.filter((sql) =>
    sql.includes("request_modification:photo_event_insert") ||
    sql.includes("request_modification:photo_append_")
  );
  assert.equal(mutationQueries.length, 2);
  assert.ok(mutationQueries.some((sql) =>
    sql.includes("INSERT INTO request_photo_attachment_events")
  ));
  assert.ok(mutationQueries.some((sql) =>
    sql.includes("UPDATE posts")
  ));
});

test("professional photo authority fails closed for wrong Job request role relationship or grant", async () => {
  const cases = [
    ["another Job", { actor_primary_professional_role_active: false }],
    ["another request relationship", { actor_primary_professional_role_active: false }],
    ["missing participant", { actor_participant_id: null }],
    ["different participant user", { actor_primary_professional_role_active: false }],
    ["inactive relationship", { actor_primary_professional_role_active: false }],
    ["inactive or revoked role", { actor_primary_professional_role_active: false }],
    ["missing Evaluation authority", { actor_evaluation_grant_active: false }],
  ];

  for (const [label, overrides] of cases) {
    const pool = createPhotoPool(professionalContext(overrides));
    const result = await appendRequestPhoto({
      pool,
      authenticatedActor: { id: 8 },
      postId: 41,
      concernId: CONCERN_ID,
      payload: { expected_version: 1, media: requestPhoto(1, 8) },
      idempotencyKey: `request-photo:denied-${label.replaceAll(" ", "-")}`,
      logger: logger(),
    });
    assert.equal(result.status, 404, label);
    assert.equal(result.code, "REQUEST_NOT_FOUND", label);
    assert.equal(result.message, "The request was not found.", label);
    assert.equal(pool.state.events.length, 0, label);
    assert.equal(pool.state.appendedPayloads.length, 0, label);
  }
});

test("professional append preserves concern lifecycle normalization capacity and non-photo truth", async () => {
  const wrongConcernPool = createPhotoPool(professionalContext());
  const wrongConcern = await appendRequestPhoto({
    pool: wrongConcernPool,
    authenticatedActor: { id: 8 },
    postId: 41,
    concernId: "44444444-4444-4444-8444-444444444444",
    payload: { expected_version: 1, media: requestPhoto(1, 8) },
    idempotencyKey: "request-photo:professional-wrong-concern",
    logger: logger(),
  });
  assert.equal(wrongConcern.code, "REPORTED_CONCERN_NOT_FOUND");

  const readOnlyPool = createPhotoPool(professionalContext({ status: "cancelled" }));
  const readOnly = await appendRequestPhoto({
    pool: readOnlyPool,
    authenticatedActor: { id: 8 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { expected_version: 1, media: requestPhoto(1, 8) },
    idempotencyKey: "request-photo:professional-read-only",
    logger: logger(),
  });
  assert.equal(readOnly.code, "REQUEST_READ_ONLY");

  const fullPool = createPhotoPool(professionalContext({
    request_photos: Array.from({ length: 12 }, (_, index) => ({
      ...requestPhoto(index + 1, 7).media,
      purpose: "request-photo",
      display_order: index,
      created_by_user_id: 7,
    })),
  }));
  const full = await appendRequestPhoto({
    pool: fullPool,
    authenticatedActor: { id: 8 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { expected_version: 1, media: requestPhoto(13, 8) },
    idempotencyKey: "request-photo:professional-capacity",
    logger: logger(),
  });
  assert.equal(full.code, "MEDIA_COUNT_EXCEEDED");

  await assert.rejects(
    appendRequestPhoto({
      pool: createPhotoPool(professionalContext()),
      authenticatedActor: { id: 8 },
      postId: 41,
      concernId: CONCERN_ID,
      payload: { expected_version: 1, media: requestPhoto(1, 7) },
      idempotencyKey: "request-photo:professional-foreign-media",
      logger: logger(),
    }),
    (error) => error instanceof MediaValidationError &&
      error.code === "MEDIA_ASSET_OWNERSHIP_INVALID"
  );

  for (const pool of [wrongConcernPool, readOnlyPool, fullPool]) {
    assert.equal(pool.state.events.length, 0);
    assert.equal(pool.state.appendedPayloads.length, 0);
    assert.equal(pool.state.queries.some((sql) => /canonical_evaluations|findings|recommendations|quotes|invoices|payments/i.test(sql)), false);
  }
});

test("photo append rejects editable requests, wrong concern, and foreign media", async () => {
  const editable = await appendRequestPhoto({
    pool: createPhotoPool(context()),
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { expected_version: 1, media: requestPhoto(1) },
    idempotencyKey: "request-photo:editable",
    logger: logger(),
  });
  assert.equal(editable.code, "REQUEST_EDITABLE");

  const wrongConcern = await appendRequestPhoto({
    pool: createPhotoPool(context({ professional_response_exists: true })),
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: "44444444-4444-4444-8444-444444444444",
    payload: { expected_version: 1, media: requestPhoto(1) },
    idempotencyKey: "request-photo:wrong-concern",
    logger: logger(),
  });
  assert.equal(wrongConcern.code, "REPORTED_CONCERN_NOT_FOUND");

  const unauthorized = await appendRequestPhoto({
    pool: createPhotoPool(context({ professional_response_exists: true })),
    authenticatedActor: { id: 8 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { expected_version: 1, media: requestPhoto(1, 8) },
    idempotencyKey: "request-photo:unauthorized",
    logger: logger(),
  });
  assert.equal(unauthorized.code, "REQUEST_NOT_FOUND");

  await assert.rejects(
    appendRequestPhoto({
      pool: createPhotoPool(context({ professional_response_exists: true })),
      authenticatedActor: { id: 7 },
      postId: 41,
      concernId: CONCERN_ID,
      payload: { expected_version: 1, media: requestPhoto(1, 8) },
      idempotencyKey: "request-photo:foreign",
      logger: logger(),
    }),
    (error) => error instanceof MediaValidationError &&
      error.code === "MEDIA_ASSET_OWNERSHIP_INVALID"
  );
});
