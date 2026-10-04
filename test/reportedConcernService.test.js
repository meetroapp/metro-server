"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-lifecycle-foundation";

const { app } = require("../index");
const {
  appendConcernClarification,
  createConcernIntegrityHash,
  listRequestLifecycle,
  serializeLifecycleRequestPhoto,
  validateClarificationPayload,
} = require("../server/requests/reportedConcernService");

const CONCERN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_ID = "66666666-6666-4666-8666-666666666666";

function requestPhoto(number, overrides = {}) {
  const referenceId = `meetro-test/users/7/request-photos/photo-${number}`;
  return {
    id: referenceId,
    purpose: "request-photo",
    public_id: referenceId,
    secure_url:
      `https://res.cloudinary.com/demo-cloud/image/upload/v1/${referenceId}.jpg`,
    resource_type: "image",
    format: "jpg",
    bytes: 2048,
    width: 1200,
    height: 800,
    version: 1,
    display_order: number - 1,
    uploaded_at: "2026-08-16T12:00:00.000Z",
    created_by_user_id: 7,
    lifecycle_state: "attached",
    provider_internal: "must-not-leak",
    ...overrides,
  };
}

function operation(sql) {
  return String(sql).match(/reported_concern:([a-z_]+)/)?.[1] || "";
}

function createConcernClient({
  owner = true,
  version = 2,
  status = "open",
  professional = false,
  grantedCapabilities = [],
  modificationVersion = 1,
  requestPhotos = [],
} = {}) {
  const state = {
    concern: {
      id: CONCERN_ID,
      job_request_id: 41,
      reporter_user_id: 7,
      original_text: "dishwasher issue",
      reported_at: "2026-08-09T12:00:00.000Z",
      sequence: 1,
      integrity_algorithm: "sha256",
      integrity_hash: "a".repeat(64),
      integrity_version: 1,
    },
    clarifications: [],
    modificationVersion,
    requestPhotos: structuredClone(requestPhotos),
  };
  let snapshot = null;
  return {
    state,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      const tag = operation(sql);
      if (sql === "BEGIN") {
        snapshot = structuredClone(state);
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        snapshot = null;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (snapshot) Object.assign(state, snapshot);
        snapshot = null;
        return { rows: [] };
      }
      if (tag === "request_context") {
        return {
          rows: [{
            post_id: 41,
            homeowner_user_id: owner ? 7 : 8,
            status,
            lifecycle_contract_version: version,
            modification_version: state.modificationVersion,
            request_photos: structuredClone(state.requestPhotos),
            job_id: owner ? null : JOB_ID,
            source_request_relationship_id: owner ? null : 501,
            actor_participant_id: professional ? PARTICIPANT_ID : null,
          }],
        };
      }
      if (tag === "clarification_concern_lock") {
        return Number(values[1]) === 41 && values[0] === CONCERN_ID
          ? { rows: [state.concern] }
          : { rows: [] };
      }
      if (tag === "clarification_existing") {
        return {
          rows: state.clarifications.filter((row) =>
            Number(row.actor_user_id) === Number(values[0]) &&
            row.concern_id === values[1] &&
            row.idempotency_key === values[2]
          ).slice(0, 1),
        };
      }
      if (tag === "clarification_insert") {
        const row = {
          id: values[0],
          concern_id: values[1],
          actor_user_id: values[2],
          actor_participant_id: values[3],
          semantics: values[4],
          clarification_text: values[5],
          idempotency_key: values[6],
          request_fingerprint: values[7],
          created_at: "2026-08-09T12:05:00.000Z",
        };
        state.clarifications.push(row);
        return { rows: [row] };
      }
      if (tag === "list") {
        if (state.clarifications.length === 0) {
          return { rows: [{ ...state.concern, concern_id: state.concern.id }] };
        }
        return {
          rows: state.clarifications.map((row) => ({
            ...state.concern,
            concern_id: state.concern.id,
            clarification_id: row.id,
            clarification_actor_user_id: row.actor_user_id,
            clarification_actor_participant_id: row.actor_participant_id,
            semantics: row.semantics,
            clarification_text: row.clarification_text,
            clarification_created_at: row.created_at,
          })),
        };
      }
      if (tag === "list_participants") return { rows: [] };
      if (sql.includes("lifecycle_authority:active_grant")) {
        return {
          rows: grantedCapabilities.includes(values[1])
            ? [{ id: "77777777-7777-4777-8777-777777777777" }]
            : [],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("Test A preserves original concern while clarification appends separately", async () => {
  const client = createConcernClient();
  const before = structuredClone(client.state.concern);
  const first = await appendConcernClarification({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: {
      semantics: "CORRECTS_INTERPRETATION",
      text: "The current understanding is a disposal and drainage fault.",
    },
    idempotencyKey: "concern-clarification:test-a",
    logger: { info() {}, warn() {} },
  });
  const replay = await appendConcernClarification({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: {
      semantics: "CORRECTS_INTERPRETATION",
      text: "The current understanding is a disposal and drainage fault.",
    },
    idempotencyKey: "concern-clarification:test-a",
    logger: { info() {}, warn() {} },
  });
  const lifecycle = await listRequestLifecycle({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
  });

  assert.equal(first.status, 201);
  assert.equal(replay.code, "CONCERN_CLARIFICATION_REPLAYED");
  assert.equal(client.state.clarifications.length, 1);
  assert.deepEqual(client.state.concern, before);
  assert.equal(lifecycle.lifecycle.reportedConcerns[0].originalText, "dishwasher issue");
  assert.equal(lifecycle.lifecycle.reportedConcerns[0].clarifications.length, 1);
  assert.equal(lifecycle.lifecycle.reportedConcerns[0].id, CONCERN_ID);
  assert.equal(lifecycle.lifecycle.modificationAuthority.mode, "EDITABLE");
  assert.equal(
    lifecycle.lifecycle.modificationAuthority.actions.editRequest,
    true
  );
});

test("authorized professional lifecycle read exposes only canonical photo references and current version", async () => {
  const laterPhoto = requestPhoto(2, { display_order: 1 });
  const firstPhoto = requestPhoto(1, { display_order: 0 });
  const invalidPhoto = requestPhoto(3, {
    secure_url: "https://example.test/private-photo.jpg",
  });
  const client = createConcernClient({
    owner: false,
    professional: true,
    grantedCapabilities: ["reported_concern.read", "participant.read"],
    modificationVersion: 4,
    requestPhotos: [laterPhoto, invalidPhoto, firstPhoto],
  });

  const result = await listRequestLifecycle({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
  });

  assert.equal(result.ok, true);
  assert.equal(result.lifecycle.modification_version, 4);
  assert.deepEqual(Object.keys(result.lifecycle).sort(), [
    "contractVersion",
    "job",
    "legacy",
    "modificationAuthority",
    "modification_version",
    "participants",
    "reportedConcerns",
    "requestId",
    "request_photos",
  ]);
  for (const privatePostField of [
    "title",
    "description",
    "user_id",
    "service_address_line1",
    "access_notes",
    "request_photos_raw",
  ]) {
    assert.equal(Object.hasOwn(result.lifecycle, privatePostField), false);
  }
  assert.deepEqual(
    result.lifecycle.request_photos.map((photo) => photo.reference_id),
    [firstPhoto.public_id, laterPhoto.public_id]
  );
  assert.deepEqual(Object.keys(result.lifecycle.request_photos[0]).sort(), [
    "display_metadata",
    "display_order",
    "preview_url",
    "reference_id",
  ]);
  assert.deepEqual(result.lifecycle.request_photos[0].display_metadata, {
    format: "jpg",
    width: 1200,
    height: 800,
  });
  const serialized = JSON.stringify(result.lifecycle.request_photos);
  for (const privateField of [
    "public_id",
    "purpose",
    "bytes",
    "version",
    "uploaded_at",
    "created_by_user_id",
    "lifecycle_state",
    "provider_internal",
  ]) {
    assert.equal(serialized.includes(`\"${privateField}\"`), false);
  }
});

test("lifecycle photo projection is empty without evidence and reflects refreshed media/version truth", async () => {
  const client = createConcernClient({ modificationVersion: 2 });
  const before = await listRequestLifecycle({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
  });
  assert.deepEqual(before.lifecycle.request_photos, []);
  assert.equal(before.lifecycle.modification_version, 2);

  const appended = requestPhoto(1);
  client.state.requestPhotos.push(appended);
  client.state.modificationVersion += 1;
  const after = await listRequestLifecycle({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
  });
  assert.deepEqual(after.lifecycle.request_photos, [{
    reference_id: appended.public_id,
    preview_url: appended.secure_url,
    display_order: 0,
    display_metadata: { format: "jpg", width: 1200, height: 800 },
  }]);
  assert.equal(after.lifecycle.modification_version, 3);
});

test("lifecycle photo serializer maps stored identity to an opaque reference without raw metadata", () => {
  const stored = requestPhoto(1);
  const projected = serializeLifecycleRequestPhoto(stored);
  assert.equal(projected.reference_id, stored.public_id);
  assert.equal(projected.preview_url, stored.secure_url);
  assert.equal(Object.hasOwn(projected, "public_id"), false);
  assert.equal(Object.hasOwn(projected, "secure_url"), false);
});

test("legacy requests remain valid and cannot invoke v2 clarification", async () => {
  const client = createConcernClient({ version: 1 });
  const lifecycle = await listRequestLifecycle({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
  });
  const clarification = await appendConcernClarification({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { semantics: "CLARIFIES", text: "More detail" },
    idempotencyKey: "legacy-clarification",
  });

  assert.equal(lifecycle.lifecycle.legacy, true);
  assert.deepEqual(lifecycle.lifecycle.reportedConcerns, []);
  assert.equal(clarification.code, "LIFECYCLE_V2_REQUIRED");
  assert.deepEqual(client.state.clarifications, []);
});

test("nonparticipant cannot read or clarify a request lifecycle", async () => {
  const client = createConcernClient({ owner: false });
  const read = await listRequestLifecycle({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
  });
  const clarification = await appendConcernClarification({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { semantics: "CLARIFIES", text: "Unauthorized" },
    idempotencyKey: "unauthorized-clarification",
    logger: { info() {}, warn() {} },
  });

  assert.equal(read.code, "REQUEST_NOT_FOUND");
  assert.equal(Object.hasOwn(read, "lifecycle"), false);
  assert.equal(clarification.code, "CONCERN_CLARIFICATION_AUTHORITY_REQUIRED");
  assert.deepEqual(client.state.clarifications, []);
});

test("cancelled requests reject new clarification evidence", async () => {
  const client = createConcernClient({ status: "cancelled" });
  const result = await appendConcernClarification({
    pool: client,
    authenticatedActor: { id: 7 },
    postId: 41,
    concernId: CONCERN_ID,
    payload: { semantics: "CLARIFIES", text: "Too late" },
    idempotencyKey: "cancelled-clarification",
  });

  assert.equal(result.code, "REQUEST_READ_ONLY");
  assert.deepEqual(client.state.clarifications, []);
});

test("clarification validation is strict and concern integrity is deterministic", () => {
  assert.equal(validateClarificationPayload({ semantics: "clarifies", text: "Detail" }).ok, true);
  assert.equal(validateClarificationPayload({ semantics: "REWRITES", text: "Detail" }).code, "INVALID_CLARIFICATION_SEMANTICS");
  assert.equal(validateClarificationPayload({ semantics: "CLARIFIES", text: "Detail", concernId: CONCERN_ID }).code, "UNSUPPORTED_CONCERN_CLARIFICATION_FIELDS");
  const input = {
    jobRequestId: 41,
    reporterUserId: 7,
    originalText: "dishwasher issue",
    sequence: 1,
  };
  assert.equal(createConcernIntegrityHash(input), createConcernIntegrityHash(input));
  assert.notEqual(createConcernIntegrityHash(input), createConcernIntegrityHash({ ...input, originalText: "changed" }));
});

test("pre-reliance description edits append concern supersession history", () => {
  const source = readFileSync(
    join(__dirname, "../server/requests/requestModificationService.js"),
    "utf8"
  );
  assert.match(source, /UPDATE posts[\s\S]*description = CASE/);
  assert.match(
    source,
    /INSERT INTO concern_clarifications[\s\S]*SUPERSEDES_INTERPRETATION/
  );
  assert.doesNotMatch(source, /UPDATE reported_concerns/i);
});

test("only bounded lifecycle read and clarification routes are registered", () => {
  const routes = app.router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: layer.route.methods }));
  const lifecycle = routes.filter((route) =>
    String(route.path).includes("lifecycle") ||
    String(route.path).includes("reported-concerns")
  );
  assert.equal(lifecycle.some((route) => route.path === "/posts/:postId/lifecycle" && route.methods.get), true);
  assert.equal(lifecycle.some((route) => route.path.includes("clarifications") && route.methods.post), true);
  assert.equal(lifecycle.some((route) => route.path.includes("/photos") && route.methods.post), true);
  assert.equal(lifecycle.some((route) => route.methods.put || route.methods.patch || route.methods.delete), false);
});
