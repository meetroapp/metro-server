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
  resolveRequestModificationMode,
  serializeRequestModificationAuthority,
  updateRequest,
} = require("../server/requests/requestModificationService");

const CONCERN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

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
    professional_response_exists: false,
    request_relationship_exists: false,
    selection_exists: false,
    active_work_exists: false,
    ...overrides,
  };
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
          state.events = snapshot.events;
          state.appendedPayloads = snapshot.appendedPayloads;
        }
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes("reported_concern:request_context")) {
        return { rows: [structuredClone(state.context)] };
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
      if (sql.includes("request_modification:photo_append")) {
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
