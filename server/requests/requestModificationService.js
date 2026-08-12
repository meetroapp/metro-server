"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  normalizeRequestPhoto,
  normalizeRequestPhotoCollection,
  parseStoredRequestPhotos,
  REQUEST_PHOTO_MAX_COUNT,
} = require("../media/requestPhoto");
const {
  serializeOwnedRequest,
  validateRequestPayload,
} = require("./requestLifecycle");

const REQUEST_MODIFICATION_MODES = Object.freeze({
  EDITABLE: "EDITABLE",
  APPEND_ONLY: "APPEND_ONLY",
  CONTRACT_CHANGE_REQUIRED: "CONTRACT_CHANGE_REQUIRED",
  READ_ONLY: "READ_ONLY",
});

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedUuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function booleanValue(value) {
  return value === true || value === "true";
}

function resolveRequestModificationMode(context = {}) {
  if (String(context.status || "").toLowerCase() !== "open") {
    return REQUEST_MODIFICATION_MODES.READ_ONLY;
  }
  if (booleanValue(context.active_work_exists)) {
    return REQUEST_MODIFICATION_MODES.CONTRACT_CHANGE_REQUIRED;
  }
  if (
    booleanValue(context.professional_response_exists) ||
    booleanValue(context.request_relationship_exists) ||
    booleanValue(context.selection_exists) ||
    Boolean(context.job_id)
  ) {
    return REQUEST_MODIFICATION_MODES.APPEND_ONLY;
  }
  return REQUEST_MODIFICATION_MODES.EDITABLE;
}

function serializeRequestModificationAuthority(context = {}, actorUserId) {
  const mode = resolveRequestModificationMode(context);
  const owner = Number(context.user_id || context.homeowner_user_id) === Number(actorUserId);
  const lifecycleV2 = Number(context.lifecycle_contract_version) === 2;
  const appendMode = [
    REQUEST_MODIFICATION_MODES.APPEND_ONLY,
    REQUEST_MODIFICATION_MODES.CONTRACT_CHANGE_REQUIRED,
  ].includes(mode);

  return {
    mode,
    requestVersion: Number(context.modification_version || 1),
    lifecycleContractVersion: Number(context.lifecycle_contract_version || 1),
    concernId: context.primary_concern_id || null,
    jobId: context.job_id || null,
    reliance: {
      professionalResponseExists: booleanValue(context.professional_response_exists),
      requestRelationshipExists: booleanValue(context.request_relationship_exists),
      selectionExists: booleanValue(context.selection_exists),
      jobExists: Boolean(context.job_id),
      activeWorkExists: booleanValue(context.active_work_exists),
    },
    actions: {
      editRequest: owner && mode === REQUEST_MODIFICATION_MODES.EDITABLE,
      appendUpdate: owner && lifecycleV2 && appendMode,
      appendPhoto: owner && lifecycleV2 && appendMode,
      contractChangeGuidance:
        owner && mode === REQUEST_MODIFICATION_MODES.CONTRACT_CHANGE_REQUIRED,
      readOnly: !owner || mode === REQUEST_MODIFICATION_MODES.READ_ONLY,
    },
  };
}

async function loadRequestModificationContext(
  client,
  postId,
  actorUserId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    SELECT id, title, description, location, category, request_category,
           service_domain, service_specialty, location_intake_mode,
           location_normalization_status, service_address_line1, service_city,
           service_region, service_postal_code, service_country_code,
           discovery_area_label, unit_number, access_notes, status,
           lifecycle_contract_version, modification_version,
           created_at, updated_at, cancelled_at, mage_url, image_url,
           request_photos, user_id,
           (
             SELECT jobs.id
             FROM jobs
             WHERE jobs.job_request_id = posts.id
             LIMIT 1
           ) AS job_id,
           (
             SELECT jobs.source_request_relationship_id
             FROM jobs
             WHERE jobs.job_request_id = posts.id
             LIMIT 1
           ) AS source_request_relationship_id,
           (
             SELECT reported_concerns.id
             FROM reported_concerns
             WHERE reported_concerns.job_request_id = posts.id
             ORDER BY reported_concerns.sequence ASC
             LIMIT 1
           ) AS primary_concern_id,
           (
             SELECT relationship_participants.id
             FROM relationship_participants
             INNER JOIN jobs
               ON jobs.id = relationship_participants.job_id
             WHERE jobs.job_request_id = posts.id
               AND relationship_participants.user_id = $2
             LIMIT 1
           ) AS actor_participant_id,
           EXISTS (
             SELECT 1
             FROM professional_responses
             WHERE professional_responses.post_id = posts.id
           ) AS professional_response_exists,
           EXISTS (
             SELECT 1
             FROM request_relationships
             WHERE request_relationships.post_id = posts.id
               AND request_relationships.emergency_request_id IS NULL
           ) AS request_relationship_exists,
           EXISTS (
             SELECT 1
             FROM request_selections
             WHERE request_selections.post_id = posts.id
           ) AS selection_exists,
           EXISTS (
             SELECT 1
             FROM jobs AS work_jobs
             WHERE work_jobs.job_request_id = posts.id
               AND (
                 EXISTS (
                   SELECT 1
                   FROM canonical_workstreams
                   INNER JOIN canonical_workstream_versions
                     ON canonical_workstream_versions.workstream_id =
                        canonical_workstreams.id
                    AND canonical_workstream_versions.job_id =
                        canonical_workstreams.job_id
                   WHERE canonical_workstreams.job_id = work_jobs.id
                     AND canonical_workstream_versions.state IN (
                       'ACTIVE', 'BLOCKED', 'COMPLETED'
                     )
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM canonical_work_activities
                   INNER JOIN canonical_work_activity_versions
                     ON canonical_work_activity_versions.activity_id =
                        canonical_work_activities.id
                    AND canonical_work_activity_versions.workstream_id =
                        canonical_work_activities.workstream_id
                    AND canonical_work_activity_versions.job_id =
                        canonical_work_activities.job_id
                   WHERE canonical_work_activities.job_id = work_jobs.id
                     AND canonical_work_activity_versions.status IN (
                       'IN_PROGRESS', 'DONE'
                     )
                 )
               )
           ) AS active_work_exists
    FROM posts
    /* reported_concern:request_context */
    WHERE id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
    `,
    [postId, actorUserId]
  );
  return result.rows[0] || null;
}

function mediaIdentity(photo = {}) {
  return {
    public_id: String(photo.public_id || ""),
    secure_url: String(photo.secure_url || ""),
    resource_type: String(photo.resource_type || ""),
    format: String(photo.format || ""),
    bytes: Number(photo.bytes || 0),
    width: Number(photo.width || 0),
    height: Number(photo.height || 0),
    version: Number(photo.version || 0),
    display_order: Number(photo.display_order || 0),
  };
}

function samePhotoCollection(left = [], right = []) {
  return JSON.stringify(left.map(mediaIdentity)) ===
    JSON.stringify(right.map(mediaIdentity));
}

function requestHasCanonicalChanges({ body, existing, request, photos }) {
  if (body.title !== undefined && existing.title !== request.title) return true;
  if (body.description !== undefined && existing.description !== request.description) {
    return true;
  }
  if (
    (request.has_service_location_update || request.has_legacy_location_update) &&
    existing.location !== request.location
  ) {
    return true;
  }
  if (request.has_service_location_update) {
    for (const [column, value] of [
      ["location_intake_mode", request.location_intake_mode],
      ["location_normalization_status", request.location_normalization_status],
      ["service_address_line1", request.service_address_line1],
      ["service_city", request.service_city],
      ["service_region", request.service_region],
      ["service_postal_code", request.service_postal_code],
      ["service_country_code", request.service_country_code],
      ["discovery_area_label", request.discovery_area_label],
      ["unit_number", request.unit_number],
    ]) {
      if ((existing[column] ?? null) !== (value ?? null)) return true;
    }
  }
  if (
    request.has_access_notes_update &&
    (existing.access_notes || "") !== (request.access_notes || "")
  ) {
    return true;
  }
  return body.request_photos !== undefined && !samePhotoCollection(
    parseStoredRequestPhotos(existing.request_photos),
    photos
  );
}

function removedRequestPhotos(previous = [], replacement = []) {
  const retained = new Set(replacement.map((photo) => photo.public_id));
  return previous.filter((photo) => photo.public_id && !retained.has(photo.public_id));
}

function modeFailure(mode) {
  if (mode === REQUEST_MODIFICATION_MODES.READ_ONLY) {
    return failure(409, "REQUEST_READ_ONLY", "The request is read-only.");
  }
  if (mode === REQUEST_MODIFICATION_MODES.CONTRACT_CHANGE_REQUIRED) {
    return failure(
      409,
      "CONTRACT_CHANGE_REQUIRED",
      "Active work changes require governed contract-change authority."
    );
  }
  return failure(
    409,
    "REQUEST_APPEND_ONLY",
    "The original request cannot be rewritten after professional reliance."
  );
}

async function updateRequest({
  pool,
  authenticatedActor,
  postId: rawPostId,
  payload,
  logger = console,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const postId = positiveInteger(rawPostId);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!postId) return failure(400, "INVALID_REQUEST_ID", "A valid request ID is required.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return failure(400, "INVALID_REQUEST", "Request details must be an object.");
  }

  const { expected_version: rawExpectedVersion, ...updatePayload } = payload;
  const validation = validateRequestPayload(updatePayload, { partial: true });
  if (!validation.ok) return validation;
  const expectedVersion = rawExpectedVersion === undefined
    ? null
    : positiveInteger(rawExpectedVersion);
  if (rawExpectedVersion !== undefined && !expectedVersion) {
    return failure(400, "INVALID_REQUEST_VERSION", "A valid request version is required.");
  }

  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const existing = await loadRequestModificationContext(
      client,
      postId,
      actorUserId,
      { lock: true }
    );
    if (!existing || Number(existing.user_id) !== actorUserId) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "REQUEST_NOT_FOUND", "Request was not found or cannot be edited.");
    }

    const mode = resolveRequestModificationMode(existing);
    if (mode !== REQUEST_MODIFICATION_MODES.EDITABLE) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return modeFailure(mode);
    }

    const actualVersion = Number(existing.modification_version || 1);
    if (
      Number(existing.lifecycle_contract_version) === 2 &&
      !existing.primary_concern_id
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REPORTED_CONCERN_REQUIRED",
        "Canonical Reported Concern truth is required before editing."
      );
    }
    if (Number(existing.lifecycle_contract_version) === 2 && !expectedVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_VERSION_REQUIRED",
        "The current request version is required."
      );
    }
    const guardedVersion = expectedVersion || actualVersion;
    if (guardedVersion !== actualVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_VERSION_CONFLICT",
        "The request changed before this edit could be saved."
      );
    }
    if (
      validation.request.has_legacy_location_update &&
      (existing.location_normalization_status || "legacy_unclassified") !==
        "legacy_unclassified"
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        400,
        "STRUCTURED_SERVICE_LOCATION_REQUIRED",
        "Normalized requests require structured service location."
      );
    }
    if (
      Number(existing.lifecycle_contract_version) === 2 &&
      updatePayload.description !== undefined &&
      !validation.request.description
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        400,
        "REPORTED_CONCERN_TEXT_REQUIRED",
        "Reported Concern text is required."
      );
    }

    const previousPhotos = parseStoredRequestPhotos(existing.request_photos);
    const replacesPhotos = Object.hasOwn(updatePayload, "request_photos");
    const normalizedPhotos = replacesPhotos
      ? normalizeRequestPhotoCollection(updatePayload.request_photos, {
          userId: actorUserId,
        })
      : previousPhotos;
    if (!requestHasCanonicalChanges({
      body: updatePayload,
      existing,
      request: validation.request,
      photos: normalizedPhotos,
    })) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(400, "REQUEST_UPDATE_REQUIRED", "At least one request value must change.");
    }

    const nextVersion = actualVersion + 1;
    let concernSupersession = null;
    if (
      Number(existing.lifecycle_contract_version) === 2 &&
      updatePayload.description !== undefined &&
      existing.description !== validation.request.description
    ) {
      const clarificationId = randomUUID();
      const idempotencyKey = `request-edit:${postId}:version:${nextVersion}`;
      const requestFingerprint = fingerprint({
        actorUserId,
        concernId: existing.primary_concern_id,
        semantics: "SUPERSEDES_INTERPRETATION",
        text: validation.request.description,
        requestVersion: nextVersion,
      });
      const concernResult = await client.query(
        `
        /* request_modification:concern_supersession_insert */
        INSERT INTO concern_clarifications
        (
          id, concern_id, actor_user_id, actor_participant_id, semantics,
          clarification_text, idempotency_key, request_fingerprint,
          source_evidence_id
        )
        VALUES ($1, $2, $3, NULL, 'SUPERSEDES_INTERPRETATION', $4, $5, $6, $1)
        RETURNING *
        `,
        [
          clarificationId,
          existing.primary_concern_id,
          actorUserId,
          validation.request.description,
          idempotencyKey,
          requestFingerprint,
        ]
      );
      const inserted = concernResult.rows[0];
      concernSupersession = inserted
        ? {
            id: inserted.id,
            semantics: inserted.semantics,
            text: inserted.clarification_text,
            actorUserId: Number(inserted.actor_user_id),
            actorParticipantId: inserted.actor_participant_id || null,
            createdAt: inserted.created_at,
          }
        : null;
    }

    const compatibilityImageUrl = replacesPhotos
      ? normalizedPhotos[0]?.secure_url || null
      : existing.image_url;
    const result = await client.query(
      `
      UPDATE posts
      SET title = CASE WHEN $1::boolean THEN $2 ELSE title END,
          description = CASE WHEN $3::boolean THEN $4 ELSE description END,
          location = CASE WHEN $5::boolean THEN $6 ELSE location END,
          request_photos = CASE WHEN $7::boolean THEN $8::jsonb ELSE request_photos END,
          image_url = CASE WHEN $7::boolean THEN $9 ELSE image_url END,
          location_intake_mode = CASE WHEN $10::boolean THEN $11 ELSE location_intake_mode END,
          location_normalization_status = CASE WHEN $10::boolean THEN $12 ELSE location_normalization_status END,
          service_address_line1 = CASE WHEN $10::boolean THEN $13 ELSE service_address_line1 END,
          service_city = CASE WHEN $10::boolean THEN $14 ELSE service_city END,
          service_region = CASE WHEN $10::boolean THEN $15 ELSE service_region END,
          service_postal_code = CASE WHEN $10::boolean THEN $16 ELSE service_postal_code END,
          service_country_code = CASE WHEN $10::boolean THEN $17 ELSE service_country_code END,
          discovery_area_label = CASE WHEN $10::boolean THEN $18 ELSE discovery_area_label END,
          unit_number = CASE WHEN $10::boolean THEN $19 ELSE unit_number END,
          access_notes = CASE WHEN $20::boolean THEN $21 ELSE access_notes END,
          modification_version = modification_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $22 AND user_id = $23 AND status = 'open'
        AND modification_version = $24
      RETURNING *
      `,
      [
        updatePayload.title !== undefined,
        validation.request.title,
        updatePayload.description !== undefined,
        validation.request.description,
        validation.request.has_service_location_update ||
          validation.request.has_legacy_location_update,
        validation.request.location,
        replacesPhotos,
        JSON.stringify(normalizedPhotos),
        compatibilityImageUrl,
        validation.request.has_service_location_update,
        validation.request.location_intake_mode,
        validation.request.location_normalization_status,
        validation.request.service_address_line1,
        validation.request.service_city,
        validation.request.service_region,
        validation.request.service_postal_code,
        validation.request.service_country_code,
        validation.request.discovery_area_label,
        validation.request.unit_number,
        validation.request.has_access_notes_update,
        validation.request.access_notes,
        postId,
        actorUserId,
        actualVersion,
      ]
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "REQUEST_VERSION_CONFLICT",
        "The request changed before this edit could be saved."
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;
    logger.info("Canonical request edited", {
      code: "REQUEST_UPDATED",
      requestId: postId,
      actorUserId,
      requestVersion: nextVersion,
      concernSuperseded: Boolean(concernSupersession),
    });
    return {
      ok: true,
      status: 200,
      code: "REQUEST_UPDATED",
      post: serializeOwnedRequest(result.rows[0], parseStoredRequestPhotos(result.rows[0].request_photos)),
      concernSupersession,
      cleanupPhotos: replacesPhotos
        ? removedRequestPhotos(previousPhotos, normalizedPhotos)
        : [],
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve failure */ }
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

function validatePhotoAppendPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return failure(400, "INVALID_REQUEST_PHOTO_APPEND", "Photo attachment details are required.");
  }
  if (Object.keys(payload).some((key) => !["expected_version", "media"].includes(key))) {
    return failure(400, "UNSUPPORTED_REQUEST_PHOTO_APPEND_FIELDS", "One or more photo attachment fields are unsupported.");
  }
  const expectedVersion = positiveInteger(payload.expected_version);
  if (!expectedVersion) {
    return failure(400, "INVALID_REQUEST_VERSION", "A valid request version is required.");
  }
  if (!payload.media || typeof payload.media !== "object" || Array.isArray(payload.media)) {
    return failure(400, "INVALID_REQUEST_PHOTO_APPEND", "Photo media details are required.");
  }
  return { ok: true, expectedVersion, media: payload.media };
}

function serializeAttachment(row = {}) {
  const payload = row.media_payload && typeof row.media_payload === "object"
    ? row.media_payload
    : {};
  return {
    ...payload,
    attachment_event_id: row.id,
    request_id: Number(row.request_id),
    concern_id: row.concern_id,
    job_id: row.job_id || null,
    created_by_user_id: Number(row.actor_user_id),
    uploaded_at: row.created_at || payload.uploaded_at,
    request_version: Number(row.request_version),
  };
}

async function appendRequestPhoto({
  pool,
  authenticatedActor,
  postId: rawPostId,
  concernId: rawConcernId,
  payload,
  idempotencyKey: rawIdempotencyKey,
  logger = console,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const postId = positiveInteger(rawPostId);
  const concernId = normalizedUuid(rawConcernId);
  const idempotencyKey = String(rawIdempotencyKey || "").trim();
  const validation = validatePhotoAppendPayload(payload);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!postId) return failure(400, "INVALID_REQUEST_ID", "A valid request ID is required.");
  if (!concernId) return failure(400, "INVALID_REPORTED_CONCERN_ID", "A valid Reported Concern ID is required.");
  if (!validation.ok) return validation;
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return failure(400, "INVALID_REQUEST_PHOTO_IDEMPOTENCY_KEY", "A valid idempotency key is required.");
  }

  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const context = await loadRequestModificationContext(
      client,
      postId,
      actorUserId,
      { lock: true }
    );
    if (!context || Number(context.user_id) !== actorUserId) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "REQUEST_NOT_FOUND", "The request was not found.");
    }
    if (Number(context.lifecycle_contract_version) !== 2) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "LIFECYCLE_V2_REQUIRED", "Lifecycle-v2 request truth is required.");
    }
    const mode = resolveRequestModificationMode(context);
    if (mode === REQUEST_MODIFICATION_MODES.EDITABLE) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "REQUEST_EDITABLE", "Pre-reliance photos belong in the canonical request edit.");
    }
    if (mode === REQUEST_MODIFICATION_MODES.READ_ONLY) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return modeFailure(mode);
    }
    if (context.primary_concern_id !== concernId) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "REPORTED_CONCERN_NOT_FOUND", "The Reported Concern was not found.");
    }

    const normalizedPhoto = normalizeRequestPhoto(validation.media, {
      userId: actorUserId,
    });
    const requestFingerprint = fingerprint({
      actorUserId,
      postId,
      concernId,
      publicId: normalizedPhoto.public_id,
      expectedVersion: validation.expectedVersion,
    });
    const existingCommand = await client.query(
      `
      /* request_modification:photo_existing_command */
      SELECT *
      FROM request_photo_attachment_events
      WHERE actor_user_id = $1
        AND request_id = $2
        AND idempotency_key = $3
      LIMIT 1
      `,
      [actorUserId, postId, idempotencyKey]
    );
    if (existingCommand.rows[0]) {
      if (existingCommand.rows[0].request_fingerprint !== requestFingerprint) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return failure(409, "REQUEST_PHOTO_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for another photo.");
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return {
        ok: true,
        status: 200,
        code: "REQUEST_PHOTO_ATTACHMENT_REPLAYED",
        replayed: true,
        photo: serializeAttachment(existingCommand.rows[0]),
        requestVersion: Number(existingCommand.rows[0].request_version),
      };
    }

    const actualVersion = Number(context.modification_version || 1);
    if (validation.expectedVersion !== actualVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "REQUEST_VERSION_CONFLICT", "The request changed before the photo could be attached.");
    }
    const currentPhotos = parseStoredRequestPhotos(context.request_photos);
    if (currentPhotos.length >= REQUEST_PHOTO_MAX_COUNT) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(400, "MEDIA_COUNT_EXCEEDED", "The request photo limit has been reached.");
    }
    if (currentPhotos.some((photo) => photo.public_id === normalizedPhoto.public_id)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "REQUEST_PHOTO_ALREADY_ATTACHED", "The photo is already attached.");
    }
    const existingMedia = await client.query(
      `
      /* request_modification:photo_existing_media */
      SELECT request_id
      FROM request_photo_attachment_events
      WHERE public_id = $1
      UNION ALL
      SELECT posts.id AS request_id
      FROM posts
      WHERE posts.id <> $2
        AND posts.request_photos @> $3::jsonb
      LIMIT 1
      `,
      [
        normalizedPhoto.public_id,
        postId,
        JSON.stringify([{ public_id: normalizedPhoto.public_id }]),
      ]
    );
    if (existingMedia.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "REQUEST_PHOTO_ALREADY_ASSOCIATED", "The photo is already associated with another request.");
    }

    const eventId = randomUUID();
    const nextVersion = actualVersion + 1;
    const attachment = {
      ...normalizedPhoto,
      attachment_event_id: eventId,
      request_id: postId,
      concern_id: concernId,
      job_id: context.job_id || null,
      display_order: currentPhotos.length,
    };
    const eventResult = await client.query(
      `
      /* request_modification:photo_event_insert */
      INSERT INTO request_photo_attachment_events
      (
        id, request_id, concern_id, job_id, actor_user_id, request_version,
        public_id, secure_url, media_payload, idempotency_key,
        request_fingerprint
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      RETURNING *
      `,
      [
        eventId,
        postId,
        concernId,
        context.job_id || null,
        actorUserId,
        nextVersion,
        attachment.public_id,
        attachment.secure_url,
        JSON.stringify(attachment),
        idempotencyKey,
        requestFingerprint,
      ]
    );
    const postResult = await client.query(
      `
      /* request_modification:photo_append */
      UPDATE posts
      SET request_photos = COALESCE(request_photos, '[]'::jsonb) || $1::jsonb,
          image_url = COALESCE(NULLIF(image_url, ''), $2),
          modification_version = modification_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
        AND user_id = $4
        AND status = 'open'
        AND modification_version = $5
      RETURNING *
      `,
      [
        JSON.stringify([attachment]),
        attachment.secure_url,
        postId,
        actorUserId,
        actualVersion,
      ]
    );
    if (!eventResult.rows[0] || !postResult.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "REQUEST_VERSION_CONFLICT", "The request changed before the photo could be attached.");
    }

    await client.query("COMMIT");
    transactionStarted = false;
    logger.info("Request photo evidence appended", {
      code: "REQUEST_PHOTO_ATTACHED",
      requestId: postId,
      concernId,
      jobId: context.job_id || null,
      actorUserId,
      attachmentEventId: eventId,
      requestVersion: nextVersion,
    });
    return {
      ok: true,
      status: 201,
      code: "REQUEST_PHOTO_ATTACHED",
      photo: serializeAttachment(eventResult.rows[0]),
      post: serializeOwnedRequest(postResult.rows[0], parseStoredRequestPhotos(postResult.rows[0].request_photos)),
      requestVersion: nextVersion,
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve failure */ }
      transactionStarted = false;
    }
    if (error?.code === "23505") {
      return failure(409, "REQUEST_PHOTO_ALREADY_ASSOCIATED", "The photo is already associated with a request.");
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

module.exports = {
  REQUEST_MODIFICATION_MODES,
  appendRequestPhoto,
  loadRequestModificationContext,
  resolveRequestModificationMode,
  serializeRequestModificationAuthority,
  updateRequest,
  validatePhotoAppendPayload,
};
