"use strict";

const crypto = require("node:crypto");

const { normalizeRequestPhotoCollection, parseStoredRequestPhotos } = require("../media/requestPhoto");
const { serializeOwnedRequest, validateRequestPayload } = require("./requestLifecycle");

const COMMAND_NAME = "job_request.create";
const COMMAND_SCOPE = "ordinary";
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(status, code, message, extra = {}) {
  return {
    ok: false,
    status,
    code,
    message,
    ...extra,
  };
}

function normalizeActorId(actor = {}) {
  const id = Number(actor?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function requirePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function serializePost(row = {}) {
  return serializeOwnedRequest(row, parseStoredRequestPhotos(row.request_photos));
}

function normalizeString(value) {
  return String(value || "").trim();
}

function canonicalPhotoFingerprint(photo = {}) {
  return {
    public_id: normalizeString(photo.public_id),
    resource_type: normalizeString(photo.resource_type),
    format: normalizeString(photo.format).toLowerCase(),
    bytes: Number(photo.bytes || 0),
    width: Number(photo.width || 0),
    height: Number(photo.height || 0),
    version: Number(photo.version || 0),
    display_order: Number(photo.display_order || 0),
  };
}

function createJobRequestFingerprint({ request, requestPhotos = [] } = {}) {
  const canonical = {
    title: normalizeString(request?.title),
    description: normalizeString(request?.description),
    category: normalizeString(request?.category),
    request_category: normalizeString(request?.request_category),
    service_domain: normalizeString(request?.service_domain),
    service_specialty: normalizeString(request?.service_specialty),
    location: normalizeString(request?.location),
    unit_number: normalizeString(request?.unit_number),
    access_notes: normalizeString(request?.access_notes),
    request_photos: requestPhotos.map(canonicalPhotoFingerprint),
  };

  return crypto
    .createHash("sha256")
    .update(stableStringify(canonical), "utf8")
    .digest("hex");
}

function validateJobRequestIdempotencyKey(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return {
      valid: false,
      code: "JOB_REQUEST_IDEMPOTENCY_KEY_REQUIRED",
      message: "A valid idempotency key is required.",
    };
  }

  const idempotencyKey = String(value).trim();
  if (
    idempotencyKey.length > 200 ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return {
      valid: false,
      code: "JOB_REQUEST_IDEMPOTENCY_KEY_INVALID",
      message: "A valid idempotency key is required.",
    };
  }

  return { valid: true, value: idempotencyKey.toLowerCase() };
}

async function loadHomeownerAuthority(client, actorUserId) {
  const result = await client.query(
    `
    /* job_request_create:homeowner_authority */
    SELECT id, role, account_type
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [actorUserId]
  );
  const user = result.rows[0];
  if (!user) return false;

  const accountType = normalizeString(user.account_type).toLowerCase();
  const role = normalizeString(user.role).toLowerCase();
  return accountType === "homeowner" || (!accountType && role === "homeowner");
}

async function reserveIdempotency({
  client,
  actorUserId,
  idempotencyKey,
  requestFingerprint,
}) {
  const id = crypto.randomUUID();
  const inserted = await client.query(
    `
    /* job_request_create:idempotency_reserve */
    INSERT INTO job_request_create_command_idempotency
    (
      id,
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key,
      request_fingerprint
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key
    )
    DO NOTHING
    RETURNING *
    `,
    [
      id,
      actorUserId,
      COMMAND_NAME,
      COMMAND_SCOPE,
      idempotencyKey,
      requestFingerprint,
    ]
  );

  if (inserted.rows[0]) {
    return { reservation: inserted.rows[0], replay: false };
  }

  const existing = await client.query(
    `
    /* job_request_create:idempotency_existing */
    SELECT *
    FROM job_request_create_command_idempotency
    WHERE actor_user_id = $1
      AND command_name = $2
      AND command_scope = $3
      AND idempotency_key = $4
    LIMIT 1
    FOR UPDATE
    `,
    [actorUserId, COMMAND_NAME, COMMAND_SCOPE, idempotencyKey]
  );
  const reservation = existing.rows[0];

  if (!reservation) {
    return {
      error: failure(
        500,
        "JOB_REQUEST_CREATE_INVARIANT_VIOLATION",
        "The Job Request could not be completed."
      ),
    };
  }

  if (reservation.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "JOB_REQUEST_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different Job Request."
      ),
    };
  }

  if (!reservation.post_id || !reservation.completed_at) {
    return {
      error: failure(
        500,
        "JOB_REQUEST_CREATE_INVARIANT_VIOLATION",
        "The Job Request could not be completed."
      ),
    };
  }

  return { reservation, replay: true };
}

async function selectOwnedPost({ client, postId, actorUserId }) {
  const result = await client.query(
    `
    /* job_request_create:owned_post */
    SELECT *
    FROM posts
    WHERE id = $1
      AND user_id = $2
    LIMIT 1
    `,
    [postId, actorUserId]
  );
  return result.rows[0] || null;
}

async function completeIdempotency({ client, reservationId, post }) {
  const resultReference = {
    post_id: post.id,
    actor_user_id: post.user_id,
  };
  const completed = await client.query(
    `
    /* job_request_create:idempotency_complete */
    UPDATE job_request_create_command_idempotency
    SET
      post_id = $2,
      result_classification = $3,
      result_reference = $4::jsonb,
      completed_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND completed_at IS NULL
    RETURNING *
    `,
    [
      reservationId,
      post.id,
      "created",
      JSON.stringify(resultReference),
    ]
  );

  if (!completed.rows[0]) {
    throw new Error("Canonical Job Request idempotency completion failed.");
  }

  return completed.rows[0];
}

async function insertPost({ client, actorUserId, request, requestPhotos }) {
  const imageUrl = requestPhotos[0]?.secure_url || null;
  const result = await client.query(
    `
    /* job_request_create:insert_post */
    INSERT INTO posts
    (user_id, title, description, category, request_category, service_domain,
     service_specialty, location, unit_number, access_notes, status, image_url,
     request_photos, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $12::jsonb, CURRENT_TIMESTAMP)
    RETURNING *
    `,
    [
      actorUserId,
      request.title,
      request.description,
      request.category,
      request.request_category,
      request.service_domain,
      request.service_specialty,
      request.location,
      request.unit_number,
      request.access_notes,
      imageUrl,
      JSON.stringify(requestPhotos),
    ]
  );

  return result.rows[0];
}

async function createJobRequest({
  pool,
  authenticatedActor,
  payload = {},
  idempotencyKey: rawIdempotencyKey,
  env = process.env,
} = {}) {
  const actorUserId = normalizeActorId(authenticatedActor);
  if (!actorUserId) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }

  const idempotencyValidation =
    validateJobRequestIdempotencyKey(rawIdempotencyKey);
  if (!idempotencyValidation.valid) {
    return failure(
      400,
      idempotencyValidation.code,
      idempotencyValidation.message
    );
  }

  const requestValidation = validateRequestPayload(payload);
  if (!requestValidation.ok) {
    return failure(
      requestValidation.status,
      requestValidation.code,
      requestValidation.message
    );
  }

  let normalizedRequestPhotos = [];
  try {
    normalizedRequestPhotos = normalizeRequestPhotoCollection(
      payload.request_photos || [],
      {
        env,
        userId: actorUserId,
      }
    );
  } catch (error) {
    throw error;
  }

  const request = requestValidation.request;
  const requestFingerprint = createJobRequestFingerprint({
    request,
    requestPhotos: normalizedRequestPhotos,
  });

  requirePool(pool);
  const client =
    typeof pool.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const hasHomeownerAuthority =
      await loadHomeownerAuthority(client, actorUserId);
    if (!hasHomeownerAuthority) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        403,
        "HOMEOWNER_AUTHORITY_REQUIRED",
        "Homeowner authority is required to create a Job Request."
      );
    }

    const idempotency = await reserveIdempotency({
      client,
      actorUserId,
      idempotencyKey: idempotencyValidation.value,
      requestFingerprint,
    });

    if (idempotency.error) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return idempotency.error;
    }

    if (idempotency.replay) {
      const existingPost = await selectOwnedPost({
        client,
        postId: idempotency.reservation.post_id,
        actorUserId,
      });
      if (!existingPost) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return failure(
          500,
          "JOB_REQUEST_CREATE_INVARIANT_VIOLATION",
          "The Job Request could not be completed."
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return {
        ok: true,
        status: 200,
        code: "JOB_REQUEST_REPLAYED",
        replayed: true,
        post: serializePost(existingPost),
      };
    }

    const post = await insertPost({
      client,
      actorUserId,
      request,
      requestPhotos: normalizedRequestPhotos,
    });

    await completeIdempotency({
      client,
      reservationId: idempotency.reservation.id,
      post,
    });

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      ok: true,
      status: 201,
      code: "JOB_REQUEST_CREATED",
      post: serializePost(post),
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
    }
    return failure(
      500,
      "JOB_REQUEST_CREATE_FAILED",
      "The Job Request could not be created.",
      { cleanupPhotos: normalizedRequestPhotos, cause: error }
    );
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

module.exports = {
  COMMAND_NAME,
  COMMAND_SCOPE,
  createJobRequest,
  createJobRequestFingerprint,
  validateJobRequestIdempotencyKey,
};
