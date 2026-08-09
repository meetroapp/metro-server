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
  validateClarificationPayload,
} = require("../server/requests/reportedConcernService");

const CONCERN_ID = "33333333-3333-4333-8333-333333333333";

function operation(sql) {
  return String(sql).match(/reported_concern:([a-z_]+)/)?.[1] || "";
}

function createConcernClient({ owner = true, version = 2 } = {}) {
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
            lifecycle_contract_version: version,
            job_id: owner ? null : "22222222-2222-4222-8222-222222222222",
            source_request_relationship_id: owner ? null : 501,
            actor_participant_id: null,
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
      if (sql.includes("lifecycle_authority:active_grant")) return { rows: [] };
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
  assert.equal(clarification.code, "CONCERN_CLARIFICATION_AUTHORITY_REQUIRED");
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

test("description edits do not update or synthesize Reported Concern history", () => {
  const source = readFileSync(join(__dirname, "../index.js"), "utf8");
  const updateStart = source.indexOf('app.put("/posts/:id"');
  const updateEnd = source.indexOf('app.post("/posts/:id/cancel"', updateStart);
  const updateRoute = source.slice(updateStart, updateEnd);
  assert.match(updateRoute, /UPDATE posts[\s\S]*description = CASE/);
  assert.doesNotMatch(updateRoute, /UPDATE reported_concerns|INSERT INTO concern_clarifications/i);
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
  assert.equal(lifecycle.some((route) => route.methods.put || route.methods.patch || route.methods.delete), false);
});
