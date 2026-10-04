"use strict";

const { createHash } = require("node:crypto");
const { MediaValidationError } = require("../media/cloudinary");
const {
  createJobRequest,
  validateJobRequestIdempotencyKey,
} = require("../requests/jobRequestCreateService");

function failure(status, code, message, extra = {}) {
  return { ok: false, status, code, message, ...extra };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function scopedIdempotencyKey(emergencyRequestId, rawIdempotencyKey) {
  const validated = validateJobRequestIdempotencyKey(rawIdempotencyKey);
  if (!validated.valid) return validated;

  const hex = createHash("sha256")
    .update(
      `emergency-follow-up:${emergencyRequestId}:${validated.value}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, 32);

  return {
    valid: true,
    value:
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
      `5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  };
}

async function loadCompletedEmergencyAuthority(
  client,
  emergencyRequestId,
  homeownerUserId
) {
  const result = await client.query(
    `/* emergency_follow_up:authority */
     SELECT jobs.id AS emergency_job_id,
       jobs.source_emergency_request_id AS emergency_request_id,
       jobs.created_by_user_id AS homeowner_user_id
     FROM jobs
     INNER JOIN emergency_requests emergency
       ON emergency.id = jobs.source_emergency_request_id
      AND emergency.homeowner_id = jobs.created_by_user_id
     INNER JOIN canonical_job_completion_records completions
       ON completions.job_id = jobs.id
      AND completions.completed_at IS NOT NULL
     WHERE jobs.source_type = 'emergency_request'
       AND jobs.job_request_id IS NULL
       AND jobs.source_emergency_request_id = $1
       AND jobs.created_by_user_id = $2
       AND emergency.status = 'completed'
       AND emergency.completed_at IS NOT NULL
     LIMIT 1
     FOR KEY SHARE OF jobs, emergency, completions`,
    [emergencyRequestId, homeownerUserId]
  );

  return result.rows[0] || null;
}

function sameLink(row, {
  emergencyJobId,
  emergencyRequestId,
  homeownerUserId,
  followUpJobRequestId,
  commandId,
}) {
  return Boolean(
    row &&
    String(row.emergency_job_id) === String(emergencyJobId) &&
    Number(row.emergency_request_id) === Number(emergencyRequestId) &&
    Number(row.homeowner_user_id) === Number(homeownerUserId) &&
    Number(row.follow_up_job_request_id) === Number(followUpJobRequestId) &&
    String(row.job_request_create_command_id) === String(commandId)
  );
}

async function persistFollowUpLink(client, {
  emergencyJobId,
  emergencyRequestId,
  homeownerUserId,
  followUpJobRequestId,
  commandId,
}) {
  const inserted = await client.query(
    `/* emergency_follow_up:link_insert */
     INSERT INTO emergency_follow_up_job_requests
       (emergency_job_id, emergency_request_id, homeowner_user_id,
        follow_up_job_request_id, job_request_create_command_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_request_create_command_id) DO NOTHING
     RETURNING *`,
    [
      emergencyJobId,
      emergencyRequestId,
      homeownerUserId,
      followUpJobRequestId,
      commandId,
    ]
  );

  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await client.query(
    `/* emergency_follow_up:link_replay */
     SELECT *
     FROM emergency_follow_up_job_requests
     WHERE job_request_create_command_id = $1
     LIMIT 1
     FOR KEY SHARE`,
    [commandId]
  );

  if (!sameLink(existing.rows[0], {
    emergencyJobId,
    emergencyRequestId,
    homeownerUserId,
    followUpJobRequestId,
    commandId,
  })) {
    throw new Error("Emergency follow-up linkage identity conflict.");
  }

  return existing.rows[0];
}

async function createEmergencyFollowUpJobRequest({
  pool,
  authenticatedActor,
  emergencyRequestId,
  payload = {},
  idempotencyKey,
  env = process.env,
  jobRequestCreator = createJobRequest,
} = {}) {
  const homeownerUserId = positiveInteger(authenticatedActor?.id);
  const requestId = positiveInteger(emergencyRequestId);

  if (!homeownerUserId) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }

  if (!requestId) {
    return failure(
      400,
      "EMERGENCY_FOLLOW_UP_IDENTITY_INVALID",
      "The Emergency follow-up source is invalid."
    );
  }

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const scopedKey = scopedIdempotencyKey(requestId, idempotencyKey);
  if (!scopedKey.valid) {
    return failure(400, scopedKey.code, scopedKey.message);
  }

  // Emergency follow-up work must re-enter the ordinary marketplace
  // lifecycle. It must never inherit or claim existing-customer targeting,
  // professional assignment, or direct relationship authority.
  const marketplacePayload =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? {
          ...payload,
          request_origin: "marketplace",
          source_meetro_relationship_id: null,
        }
      : payload;

  const client =
    typeof pool.connect === "function" ? await pool.connect() : pool;
  let started = false;
  let cleanupPhotos = [];

  try {
    await client.query("BEGIN");
    started = true;

    const emergency = await loadCompletedEmergencyAuthority(
      client,
      requestId,
      homeownerUserId
    );

    if (!emergency) {
      await client.query("ROLLBACK");
      started = false;
      return failure(
        409,
        "EMERGENCY_FOLLOW_UP_NOT_READY",
        "The Emergency must be completed before a Standard follow-up Job Request is created."
      );
    }

    let linkage = null;

    const created = await jobRequestCreator({
      pool: client,
      transactionClient: client,
      transactionalAfterCreate: async ({
        client: transactionClient,
        post,
        commandId,
        replayed,
        requestPhotos,
      }) => {
        linkage = await persistFollowUpLink(transactionClient, {
          emergencyJobId: emergency.emergency_job_id,
          emergencyRequestId: requestId,
          homeownerUserId,
          followUpJobRequestId: post.id,
          commandId,
        });

        if (!replayed && Array.isArray(requestPhotos)) {
          cleanupPhotos = requestPhotos;
        }
      },
      authenticatedActor: { id: homeownerUserId },
      payload: marketplacePayload,
      idempotencyKey: scopedKey.value,
      env,
    });

    if (!created?.ok) {
      await client.query("ROLLBACK");
      started = false;
      return created || failure(
        500,
        "EMERGENCY_FOLLOW_UP_JOB_REQUEST_FAILED",
        "The Standard follow-up Job Request could not be created."
      );
    }

    if (!linkage) {
      throw new Error("Emergency follow-up linkage was not materialized.");
    }

    await client.query("COMMIT");
    started = false;

    return {
      ok: true,
      status: created.replayed ? 200 : 201,
      code: created.replayed
        ? "EMERGENCY_FOLLOW_UP_JOB_REQUEST_REPLAYED"
        : "EMERGENCY_FOLLOW_UP_JOB_REQUEST_CREATED",
      replayed: Boolean(created.replayed),
      emergencyRequestId: requestId,
      emergencyJobId: String(emergency.emergency_job_id),
      linkageId: String(linkage.id),
      post: created.post,
      reportedConcern: created.reportedConcern || null,
    };
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
    }

    if (error instanceof MediaValidationError) {
      throw error;
    }

    return failure(
      500,
      "EMERGENCY_FOLLOW_UP_JOB_REQUEST_FAILED",
      "The Standard follow-up Job Request could not be created.",
      { cleanupPhotos, cause: error }
    );
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

module.exports = {
  createEmergencyFollowUpJobRequest,
  emergencyFollowUpJobRequestInternals: {
    loadCompletedEmergencyAuthority,
    persistFollowUpLink,
    sameLink,
    scopedIdempotencyKey,
  },
};
