"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MediaValidationError,
} = require("../server/media/cloudinary");

const {
  createEmergencyFollowUpJobRequest,
  emergencyFollowUpJobRequestInternals,
} = require("../server/emergency/emergencyFollowUpJobRequestService");

const EMERGENCY_JOB_ID = "11111111-1111-4111-8111-111111111111";
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_KEY = "44444444-4444-4444-8444-444444444444";

function fixture({
  emergencyReady = true,
  replayLink = null,
  commitFails = false,
} = {}) {
  const calls = [];

  const core = async (sql, values = []) => {
    calls.push({ sql, values });

    if (sql === "COMMIT" && commitFails) {
      throw new Error("simulated parent commit failure");
    }

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("/* emergency_follow_up:authority */")) {
      assert.match(
        sql,
        /jobs\.source_emergency_request_id AS emergency_request_id/i
      );
      assert.match(
        sql,
        /emergency\.id = jobs\.source_emergency_request_id/i
      );
      assert.match(
        sql,
        /jobs\.source_emergency_request_id = \$1/i
      );
      assert.doesNotMatch(
        sql,
        /(^|[^A-Za-z0-9_])jobs\.emergency_request_id/i
      );

      return {
        rows: emergencyReady
          ? [{
              emergency_job_id: EMERGENCY_JOB_ID,
              emergency_request_id: 41,
              homeowner_user_id: 7,
            }]
          : [],
        rowCount: emergencyReady ? 1 : 0,
      };
    }

    if (sql.includes("/* emergency_follow_up:link_insert */")) {
      if (replayLink) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: LINK_ID,
          emergency_job_id: values[0],
          emergency_request_id: values[1],
          homeowner_user_id: values[2],
          follow_up_job_request_id: values[3],
          job_request_create_command_id: values[4],
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("/* emergency_follow_up:link_replay */")) {
      return {
        rows: replayLink ? [replayLink] : [],
        rowCount: replayLink ? 1 : 0,
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const pool = {
    query: core,
    async connect() {
      return {
        query: core,
        release() {
          calls.push({ sql: "RELEASE", values: [] });
        },
      };
    },
  };

  return { pool, calls };
}

test("scoped follow-up idempotency is deterministic, UUID-valid, and distinct from the ordinary client key", () => {
  const one =
    emergencyFollowUpJobRequestInternals.scopedIdempotencyKey(41, CLIENT_KEY);
  const two =
    emergencyFollowUpJobRequestInternals.scopedIdempotencyKey(41, CLIENT_KEY);
  const other =
    emergencyFollowUpJobRequestInternals.scopedIdempotencyKey(42, CLIENT_KEY);

  assert.equal(one.valid, true);
  assert.equal(one.value, two.value);
  assert.notEqual(one.value, CLIENT_KEY);
  assert.notEqual(one.value, other.value);
  assert.match(
    one.value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
});

test("completed Emergency and ordinary Job Request linkage commit atomically", async () => {
  const { pool, calls } = fixture();

  const result = await createEmergencyFollowUpJobRequest({
    pool,
    authenticatedActor: { id: 7 },
    emergencyRequestId: 41,
    payload: {
      title: "Replace damaged plumbing",
      description: "Larger scheduled repair.",
    },
    idempotencyKey: CLIENT_KEY,
    jobRequestCreator: async (input) => {
      assert.equal(input.transactionClient != null, true);
      assert.equal(input.pool, input.transactionClient);
      assert.notEqual(input.idempotencyKey, CLIENT_KEY);

      await input.transactionalAfterCreate({
        client: input.transactionClient,
        actorUserId: 7,
        post: { id: 9001 },
        commandId: COMMAND_ID,
        replayed: false,
      });

      return {
        ok: true,
        status: 201,
        code: "JOB_REQUEST_CREATED",
        replayed: false,
        post: { id: 9001, title: "Replace damaged plumbing" },
        reportedConcern: { id: "concern" },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.code, "EMERGENCY_FOLLOW_UP_JOB_REQUEST_CREATED");
  assert.equal(result.emergencyRequestId, 41);
  assert.equal(result.emergencyJobId, EMERGENCY_JOB_ID);
  assert.equal(result.linkageId, LINK_ID);
  assert.equal(result.post.id, 9001);

  assert.deepEqual(
    calls
      .filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "COMMIT"]
  );
});

test("incomplete Emergency fails before ordinary Job Request creation", async () => {
  const { pool, calls } = fixture({ emergencyReady: false });
  let creatorCalled = false;

  const result = await createEmergencyFollowUpJobRequest({
    pool,
    authenticatedActor: { id: 7 },
    emergencyRequestId: 41,
    payload: { title: "Later repair", description: "Not yet allowed." },
    idempotencyKey: CLIENT_KEY,
    jobRequestCreator: async () => {
      creatorCalled = true;
      throw new Error("must not run");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "EMERGENCY_FOLLOW_UP_NOT_READY");
  assert.equal(creatorCalled, false);

  assert.deepEqual(
    calls
      .filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK"]
  );
});

test("exact Job Request replay reuses the immutable Emergency linkage", async () => {
  const replayLink = {
    id: LINK_ID,
    emergency_job_id: EMERGENCY_JOB_ID,
    emergency_request_id: 41,
    homeowner_user_id: 7,
    follow_up_job_request_id: 9001,
    job_request_create_command_id: COMMAND_ID,
  };

  const { pool } = fixture({ replayLink });

  const result = await createEmergencyFollowUpJobRequest({
    pool,
    authenticatedActor: { id: 7 },
    emergencyRequestId: 41,
    payload: {
      title: "Replace damaged plumbing",
      description: "Larger scheduled repair.",
    },
    idempotencyKey: CLIENT_KEY,
    jobRequestCreator: async (input) => {
      await input.transactionalAfterCreate({
        client: input.transactionClient,
        actorUserId: 7,
        post: { id: 9001 },
        commandId: COMMAND_ID,
        replayed: true,
      });

      return {
        ok: true,
        status: 200,
        code: "JOB_REQUEST_REPLAYED",
        replayed: true,
        post: { id: 9001 },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.replayed, true);
  assert.equal(result.code, "EMERGENCY_FOLLOW_UP_JOB_REQUEST_REPLAYED");
  assert.equal(result.linkageId, LINK_ID);
});


test("media validation errors propagate through the parent transaction boundary", async () => {
  const { pool, calls } = fixture();

  await assert.rejects(
    createEmergencyFollowUpJobRequest({
      pool,
      authenticatedActor: { id: 7 },
      emergencyRequestId: 41,
      payload: {
        title: "Later repair",
        description: "Invalid media should stay a media error.",
      },
      idempotencyKey: CLIENT_KEY,
      jobRequestCreator: async () => {
        throw new MediaValidationError("MEDIA_COLLECTION_INVALID");
      },
    }),
    (error) =>
      error instanceof MediaValidationError &&
      error.code === "MEDIA_COLLECTION_INVALID"
  );

  assert.deepEqual(
    calls
      .filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK"]
  );
});

test("parent COMMIT failure returns only newly created request photos for cleanup", async () => {
  const { pool, calls } = fixture({ commitFails: true });
  const requestPhotos = [
    {
      public_id: "meetro/users/7/request-photos/task54-photo",
    },
  ];

  const result = await createEmergencyFollowUpJobRequest({
    pool,
    authenticatedActor: { id: 7 },
    emergencyRequestId: 41,
    payload: {
      title: "Replace damaged plumbing",
      description: "Larger scheduled repair.",
    },
    idempotencyKey: CLIENT_KEY,
    jobRequestCreator: async (input) => {
      await input.transactionalAfterCreate({
        client: input.transactionClient,
        actorUserId: 7,
        post: { id: 9001 },
        commandId: COMMAND_ID,
        replayed: false,
        requestPhotos,
      });

      return {
        ok: true,
        status: 201,
        code: "JOB_REQUEST_CREATED",
        replayed: false,
        post: { id: 9001 },
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.code, "EMERGENCY_FOLLOW_UP_JOB_REQUEST_FAILED");
  assert.deepEqual(result.cleanupPhotos, requestPhotos);

  assert.deepEqual(
    calls
      .filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "COMMIT", "ROLLBACK"]
  );
});

test("replay parent failure never marks existing request photos for cleanup", async () => {
  const replayLink = {
    id: LINK_ID,
    emergency_job_id: EMERGENCY_JOB_ID,
    emergency_request_id: 41,
    homeowner_user_id: 7,
    follow_up_job_request_id: 9001,
    job_request_create_command_id: COMMAND_ID,
  };
  const { pool } = fixture({ replayLink, commitFails: true });

  const result = await createEmergencyFollowUpJobRequest({
    pool,
    authenticatedActor: { id: 7 },
    emergencyRequestId: 41,
    payload: {
      title: "Replace damaged plumbing",
      description: "Larger scheduled repair.",
    },
    idempotencyKey: CLIENT_KEY,
    jobRequestCreator: async (input) => {
      await input.transactionalAfterCreate({
        client: input.transactionClient,
        actorUserId: 7,
        post: { id: 9001 },
        commandId: COMMAND_ID,
        replayed: true,
        requestPhotos: [
          { public_id: "existing-canonical-photo-must-not-delete" },
        ],
      });

      return {
        ok: true,
        status: 200,
        code: "JOB_REQUEST_REPLAYED",
        replayed: true,
        post: { id: 9001 },
      };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.cleanupPhotos, []);
});

test("Emergency follow-up always enters marketplace discovery and cannot claim existing-customer targeting", async () => {
  const { pool } = fixture();
  let forwardedPayload = null;

  const originalPayload = {
    title: "Replace damaged plumbing",
    description: "Larger scheduled repair.",
    request_origin: "existing_customer_request",
    source_meetro_relationship_id:
      "55555555-5555-4555-8555-555555555555",
  };

  const result = await createEmergencyFollowUpJobRequest({
    pool,
    authenticatedActor: { id: 7 },
    emergencyRequestId: 41,
    payload: originalPayload,
    idempotencyKey: CLIENT_KEY,
    jobRequestCreator: async (input) => {
      forwardedPayload = input.payload;

      await input.transactionalAfterCreate({
        client: input.transactionClient,
        actorUserId: 7,
        post: { id: 9001 },
        commandId: COMMAND_ID,
        replayed: false,
        requestPhotos: [],
      });

      return {
        ok: true,
        status: 201,
        code: "JOB_REQUEST_CREATED",
        replayed: false,
        post: { id: 9001 },
        reportedConcern: null,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.ok(forwardedPayload);
  assert.equal(
    forwardedPayload.request_origin,
    "marketplace"
  );
  assert.equal(
    forwardedPayload.source_meetro_relationship_id,
    null
  );

  // Do not mutate the caller's original body.
  assert.equal(
    originalPayload.request_origin,
    "existing_customer_request"
  );
  assert.equal(
    originalPayload.source_meetro_relationship_id,
    "55555555-5555-4555-8555-555555555555"
  );
});

