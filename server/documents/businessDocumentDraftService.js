"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  normalizeQuoteDraftPhotoCollection,
} = require("../media/quoteDraftPhoto");

const DOCUMENT_TYPES = Object.freeze(["QUOTE", "INVOICE"]);
const PHOTO_ROLES = Object.freeze(["UNCLASSIFIED", "GENERAL_EVIDENCE", "BEFORE", "AFTER"]);
const PHOTO_VISIBILITIES = Object.freeze(["PRIVATE_INTERNAL", "CUSTOMER_VISIBLE"]);
const DRAFT_STATUS = "WORKING_DRAFT";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PHOTOS = 5;
const MAX_ROWS = 100;
const MAX_INSTRUCTIONS = 200;

function failure(status, code, message, extra = {}) {
  return { ok: false, status, code, message, ...extra };
}

function exactObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return exactObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function actorId(authenticatedActor) {
  const value = Number(authenticatedActor?.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function text(value, maximum, { nullable = true } = {}) {
  if (value === undefined || value === null) return nullable ? "" : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : null;
}

function optionalTimestamp(value) {
  if (value === undefined || value === null || value === "") return { valid: true, value: null };
  if (typeof value !== "string") return { valid: false, value: null };
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? { valid: false, value: null }
    : { valid: true, value: parsed.toISOString() };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (exactObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

const ROW_KEYS = new Set([
  "id", "description", "name", "quantity", "unitPrice", "cost", "hours",
  "rate", "total", "amount", "notes",
]);

function normalizeRows(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ROWS) return null;
  const rows = [];
  for (const source of value) {
    if (!onlyKeys(source, ROW_KEYS)) return null;
    const row = {};
    for (const [key, raw] of Object.entries(source)) {
      const normalized = text(String(raw ?? ""), key === "notes" ? 2000 : 500);
      if (normalized === null) return null;
      row[key] = normalized;
    }
    rows.push(row);
  }
  return rows;
}

const CONTENT_TEXT_LIMITS = Object.freeze({
  customerName: 240,
  customerLocation: 600,
  serviceLocation: 600,
  projectTitle: 500,
  projectDescription: 12000,
  recommendedSolution: 12000,
  workPerformed: 12000,
  totalOverride: 80,
  terms: 8000,
  paymentTerms: 8000,
  estimatedDuration: 240,
  dueDate: 80,
  notes: 8000,
  quoteReference: 240,
  quoteNumber: 240,
  invoiceNumber: 240,
  quoteDate: 80,
  invoiceDate: 80,
  currency: 12,
});
const CONTENT_KEYS = new Set([
  ...Object.keys(CONTENT_TEXT_LIMITS), "lineItems", "materialItems", "laborItems",
]);

function normalizeContent(value, { partial = false } = {}) {
  if (!onlyKeys(value, CONTENT_KEYS)) return null;
  const result = {};
  for (const [key, maximum] of Object.entries(CONTENT_TEXT_LIMITS)) {
    if (!Object.hasOwn(value, key)) continue;
    const normalized = text(value[key], maximum);
    if (normalized === null) return null;
    result[key] = normalized;
  }
  for (const key of ["lineItems", "materialItems", "laborItems"]) {
    if (!Object.hasOwn(value, key)) continue;
    const rows = normalizeRows(value[key]);
    if (rows === null) return null;
    result[key] = rows;
  }
  if (!partial && JSON.stringify(result).length > 180000) return null;
  return result;
}

function normalizeInstruction(value, documentType) {
  const allowed = new Set([
    "id", "documentType", "originalText", "text", "responseText", "recognized",
    "revisions", "revisionHistory", "privateReminder", "photoIntent", "createdAt",
    "updatedAt",
  ]);
  if (!onlyKeys(value, allowed)) return null;
  const id = text(value.id, 160);
  const instructionText = text(value.text, 12000);
  const type = String(value.documentType || documentType).trim().toUpperCase();
  const revisions = Number(value.revisions || 0);
  if (!id || !instructionText || type !== documentType || !Number.isSafeInteger(revisions) || revisions < 0 || revisions > 100) return null;
  const history = value.revisionHistory ?? [];
  if (!Array.isArray(history) || history.length > 100) return null;
  const revisionHistory = history.map((item) => text(item, 12000));
  if (revisionHistory.some((item) => item === null)) return null;
  const originalText = text(value.originalText ?? revisionHistory[0] ?? instructionText, 12000);
  const responseText = text(value.responseText, 12000);
  const photoIntent = value.photoIntent == null || value.photoIntent === ""
    ? null
    : String(value.photoIntent).trim().toUpperCase();
  const createdAt = optionalTimestamp(value.createdAt);
  const updatedAt = optionalTimestamp(value.updatedAt);
  if (!originalText || responseText === null ||
      (Object.hasOwn(value, "privateReminder") && typeof value.privateReminder !== "boolean") ||
      (photoIntent && !["BEFORE", "AFTER"].includes(photoIntent)) ||
      !createdAt.valid || !updatedAt.valid) return null;
  return {
    id,
    documentType: type,
    originalText,
    text: instructionText,
    responseText,
    recognized: value.recognized === true,
    revisions,
    revisionHistory,
    privateReminder: value.privateReminder === true,
    photoIntent,
    ...(createdAt.value ? { createdAt: createdAt.value } : {}),
    ...(updatedAt.value ? { updatedAt: updatedAt.value } : {}),
  };
}

function normalizeWorkspace(value, documentType) {
  const allowed = new Set(["instructions", "manualOverrides", "privateReminders", "activeDocument"]);
  if (!onlyKeys(value, allowed)) return null;
  const instructions = value.instructions ?? [];
  if (!Array.isArray(instructions) || instructions.length > MAX_INSTRUCTIONS) return null;
  const normalizedInstructions = instructions.map((item) => normalizeInstruction(item, documentType));
  if (normalizedInstructions.some((item) => !item)) return null;
  const manualOverrides = normalizeContent(value.manualOverrides || {}, { partial: true });
  if (!manualOverrides) return null;
  const reminders = value.privateReminders ?? [];
  if (!Array.isArray(reminders) || reminders.length > MAX_INSTRUCTIONS) return null;
  const privateReminders = reminders.map((item) => {
    if (!onlyKeys(item, new Set(["id", "text"]))) return null;
    const id = text(item.id, 160);
    const reminder = text(item.text, 8000);
    return id && reminder ? { id, text: reminder } : null;
  });
  if (privateReminders.some((item) => !item)) return null;
  return {
    activeDocument: documentType,
    instructions: normalizedInstructions,
    manualOverrides,
    privateReminders,
  };
}

function normalizePhotos(value, { env, contractorProfileId, normalizeMediaCollection } = {}) {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) return null;
  const mediaInputs = [];
  const classifications = [];
  for (const [index, item] of value.entries()) {
    const allowed = new Set(["id", "name", "purpose", "media", "role", "visibility"]);
    if (!onlyKeys(item, allowed) || !item.media) return null;
    const role = String(item.role || "UNCLASSIFIED").trim().toUpperCase();
    const visibility = String(item.visibility || "PRIVATE_INTERNAL").trim().toUpperCase();
    if (!PHOTO_ROLES.includes(role) || !PHOTO_VISIBILITIES.includes(visibility)) return null;
    const name = text(item.name || "Document photo", 500);
    if (name === null) return null;
    mediaInputs.push({ purpose: "quote-draft-photo", media: item.media, display_order: index });
    classifications.push({ role, visibility, name: name || "Document photo" });
  }
  let normalized;
  try {
    normalized = (normalizeMediaCollection || normalizeQuoteDraftPhotoCollection)(mediaInputs, {
      env,
      contractorProfileId,
    });
  } catch {
    return null;
  }
  return normalized.map((media, index) => ({
    publicId: media.public_id,
    media: {
      ...media,
      lifecycle_state: "business_document_working_draft",
      customer_visible_by_default: false,
    },
    name: classifications[index].name,
    role: classifications[index].role,
    visibility: classifications[index].visibility,
    displayOrder: index,
  }));
}

function validateCreateInput(input) {
  const allowedInput = new Set([
    "pool", "authenticatedActor", "payload", "idempotencyKey", "env", "store",
    "normalizeMediaCollection",
  ]);
  if (!onlyKeys(input, allowedInput)) return { error: failure(400, "BUSINESS_DOCUMENT_FIELD_REJECTED", "The working document request is invalid.") };
  const id = actorId(input.authenticatedActor);
  if (!id) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  const key = uuid(input.idempotencyKey);
  if (!key) return { error: failure(400, "BUSINESS_DOCUMENT_IDEMPOTENCY_REQUIRED", "A valid save identity is required.") };
  const allowedPayload = new Set(["documentType", "jobId", "content", "workspace", "photos"]);
  if (!onlyKeys(input.payload, allowedPayload)) return { error: failure(400, "BUSINESS_DOCUMENT_FIELD_REJECTED", "Server-owned document fields cannot be supplied.") };
  const documentType = String(input.payload.documentType || "").trim().toUpperCase();
  const jobId = input.payload.jobId == null || input.payload.jobId === "" ? null : uuid(input.payload.jobId);
  const content = normalizeContent(input.payload.content);
  const workspace = normalizeWorkspace(input.payload.workspace, documentType);
  if (!DOCUMENT_TYPES.includes(documentType) || (input.payload.jobId && !jobId) || !content || !workspace || !Array.isArray(input.payload.photos)) {
    return { error: failure(400, "BUSINESS_DOCUMENT_INVALID", "The working document is invalid.") };
  }
  return { actorId: id, idempotencyKey: key, documentType, jobId, content, workspace, rawPhotos: input.payload.photos };
}

function validateUpdateInput(input) {
  const allowedInput = new Set([
    "pool", "authenticatedActor", "draftId", "payload", "idempotencyKey", "env", "store",
    "normalizeMediaCollection",
  ]);
  if (!onlyKeys(input, allowedInput)) return { error: failure(400, "BUSINESS_DOCUMENT_FIELD_REJECTED", "The working document request is invalid.") };
  const base = validateCreateInput({
    pool: input.pool,
    authenticatedActor: input.authenticatedActor,
    payload: {
      documentType: input.payload?.documentType,
      jobId: input.payload?.jobId,
      content: input.payload?.content,
      workspace: input.payload?.workspace,
      photos: input.payload?.photos,
    },
    idempotencyKey: input.idempotencyKey,
    env: input.env,
    store: input.store,
    normalizeMediaCollection: input.normalizeMediaCollection,
  });
  if (base.error) return base;
  const draftId = uuid(input.draftId);
  const expectedVersion = Number(input.payload?.expectedVersion);
  const allowedPayload = new Set(["expectedVersion", "documentType", "jobId", "content", "workspace", "photos"]);
  if (!draftId || !onlyKeys(input.payload, allowedPayload) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { error: failure(400, "BUSINESS_DOCUMENT_VERSION_REQUIRED", "The current saved version is required.") };
  }
  return { ...base, draftId, expectedVersion };
}

function publicProjection(row, photos = []) {
  return Object.freeze({
    id: String(row.id),
    documentType: row.document_type,
    status: DRAFT_STATUS,
    reference: row.draft_reference,
    jobId: row.job_id || null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    content: exactObject(row.content) ? row.content : {},
    workspace: exactObject(row.workspace_context) ? row.workspace_context : {},
    photos: photos.map((photo) => ({
      id: photo.public_id,
      name: photo.name || "Document photo",
      media: exactObject(photo.media) ? photo.media : {},
      role: photo.role,
      visibility: photo.visibility,
      displayOrder: Number(photo.display_order),
      version: Number(photo.version),
    })),
  });
}

async function withTransaction(pool, action) {
  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  if (!client || typeof client.query !== "function") throw new TypeError("A database pool is required.");
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await action(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function professionalContext(client, actorUserId) {
  const result = await client.query(
    `/* business_document:professional_context */
     SELECT profiles.id AS contractor_profile_id
     FROM users
     INNER JOIN contractor_profiles profiles ON profiles.user_id = users.id
     WHERE users.id = $1 AND users.account_type = 'professional'
     ORDER BY profiles.created_at ASC, profiles.id ASC
     LIMIT 1`,
    [actorUserId]
  );
  return result.rows[0] || null;
}

async function jobAssociationAllowed(client, actorUserId, jobId) {
  if (!jobId) return true;
  const result = await client.query(
    `/* business_document:job_authority */
     SELECT jobs.id
     FROM jobs
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
      AND relationships.professional_user_id = $1
      AND relationships.status = 'active'
     INNER JOIN relationship_participants participants
       ON participants.job_id = jobs.id
      AND participants.request_relationship_id = relationships.id
      AND participants.user_id = $1
     INNER JOIN participant_role_assignments roles
       ON roles.participant_id = participants.id
      AND roles.job_id = jobs.id
      AND roles.role = 'PRIMARY_PROFESSIONAL'
      AND roles.valid_from <= CURRENT_TIMESTAMP
      AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
     LEFT JOIN participant_role_revocations revocations
       ON revocations.role_assignment_id = roles.id
     WHERE jobs.id = $2 AND revocations.id IS NULL
     LIMIT 1`,
    [actorUserId, jobId]
  );
  return Boolean(result.rows[0]);
}

async function loadPhotos(client, documentId) {
  const result = await client.query(
    `/* business_document:load_photos */
     SELECT public_id, media, role, visibility, display_order, version,
            media->>'name' AS name
     FROM business_document_draft_media
     WHERE document_draft_id = $1
     ORDER BY display_order ASC, id ASC`,
    [documentId]
  );
  return result.rows;
}

async function loadOwned(client, actorUserId, draftId, { lock = false } = {}) {
  const result = await client.query(
    `/* business_document:load_owned */
     SELECT drafts.*
     FROM business_document_working_drafts drafts
     INNER JOIN contractor_profiles profiles
       ON profiles.id = drafts.contractor_profile_id
     WHERE drafts.id = $1 AND profiles.user_id = $2
     LIMIT 1 ${lock ? "FOR UPDATE OF drafts" : ""}`,
    [draftId, actorUserId]
  );
  const row = result.rows[0];
  return row ? publicProjection(row, await loadPhotos(client, row.id)) : null;
}

async function syncPhotos(client, { draftId, contractorProfileId, actorUserId, photos }) {
  const publicIds = [];
  for (const photo of photos) {
    publicIds.push(photo.publicId);
    await client.query(
      `/* business_document:upsert_photo */
       INSERT INTO business_document_draft_media (
         document_draft_id, contractor_profile_id, uploaded_by_user_id,
         public_id, media, role, visibility, display_order
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (document_draft_id, public_id) DO UPDATE SET
         role = EXCLUDED.role,
         visibility = EXCLUDED.visibility,
         display_order = EXCLUDED.display_order,
         updated_at = CURRENT_TIMESTAMP,
         version = business_document_draft_media.version + 1`,
      [
        draftId,
        contractorProfileId,
        actorUserId,
        photo.publicId,
        JSON.stringify({ ...photo.media, name: photo.name }),
        photo.role,
        photo.visibility,
        photo.displayOrder,
      ]
    );
  }
  await client.query(
    `/* business_document:detach_photos */
     DELETE FROM business_document_draft_media
     WHERE document_draft_id = $1
       AND NOT (public_id = ANY($2::text[]))`,
    [draftId, publicIds]
  );
}

async function reserveCommand(client, { actorUserId, operation, key, hash }) {
  const inserted = await client.query(
    `/* business_document:reserve_command */
     INSERT INTO business_document_draft_commands (
       actor_user_id, operation, idempotency_key, request_hash
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [actorUserId, operation, key, hash]
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, fresh: true };
  const existing = await client.query(
    `/* business_document:load_command */
     SELECT id, request_hash, response_json
     FROM business_document_draft_commands
     WHERE actor_user_id = $1 AND operation = $2 AND idempotency_key = $3
     LIMIT 1`,
    [actorUserId, operation, key]
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== hash) return { conflict: true };
  if (row.response_json) return { replay: row.response_json };
  return { pending: true };
}

async function finishCommand(client, commandId, document) {
  await client.query(
    `/* business_document:finish_command */
     UPDATE business_document_draft_commands
     SET document_draft_id = $2, response_json = $3::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [commandId, document.id, JSON.stringify(document)]
  );
}

async function cancelCommand(client, commandId) {
  if (commandId) {
    await client.query("/* business_document:cancel_command */ DELETE FROM business_document_draft_commands WHERE id = $1", [commandId]);
  }
}

const sqlStore = Object.freeze({
  getProfessionalContext(pool, actorUserId) {
    return professionalContext(pool, actorUserId);
  },
  validateJobAssociation(pool, actorUserId, jobId) {
    return jobAssociationAllowed(pool, actorUserId, jobId);
  },
  create({ pool, actorUserId, contractorProfileId, command, draft }) {
    return withTransaction(pool, async (client) => {
      const reserved = await reserveCommand(client, command);
      if (reserved.conflict) return { kind: "idempotency_conflict" };
      if (reserved.pending) return { kind: "in_progress" };
      if (reserved.replay) return { kind: "replay", document: reserved.replay };
      if (!(await jobAssociationAllowed(client, actorUserId, draft.jobId))) {
        await cancelCommand(client, reserved.id);
        return { kind: "job_unavailable" };
      }
      await client.query(
        `/* business_document:create */
         INSERT INTO business_document_working_drafts (
           id, contractor_profile_id, created_by_user_id, job_id, document_type,
           draft_reference, content, workspace_context
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
        [draft.id, contractorProfileId, actorUserId, draft.jobId, draft.documentType, draft.reference, JSON.stringify(draft.content), JSON.stringify(draft.workspace)]
      );
      await syncPhotos(client, { draftId: draft.id, contractorProfileId, actorUserId, photos: draft.photos });
      const document = await loadOwned(client, actorUserId, draft.id);
      await finishCommand(client, reserved.id, document);
      return { kind: "created", document };
    });
  },
  update({ pool, actorUserId, contractorProfileId, command, draftId, expectedVersion, draft }) {
    return withTransaction(pool, async (client) => {
      const reserved = await reserveCommand(client, command);
      if (reserved.conflict) return { kind: "idempotency_conflict" };
      if (reserved.pending) return { kind: "in_progress" };
      if (reserved.replay) return { kind: "replay", document: reserved.replay };
      const current = await loadOwned(client, actorUserId, draftId, { lock: true });
      if (!current) {
        await cancelCommand(client, reserved.id);
        return { kind: "not_found" };
      }
      if (current.version !== expectedVersion) {
        await cancelCommand(client, reserved.id);
        return { kind: "version_conflict", currentVersion: current.version };
      }
      if (current.documentType !== draft.documentType || !(await jobAssociationAllowed(client, actorUserId, draft.jobId))) {
        await cancelCommand(client, reserved.id);
        return { kind: current.documentType !== draft.documentType ? "type_conflict" : "job_unavailable" };
      }
      await client.query(
        `/* business_document:update */
         UPDATE business_document_working_drafts
         SET job_id = $3, content = $4::jsonb, workspace_context = $5::jsonb,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND contractor_profile_id = $2`,
        [draftId, contractorProfileId, draft.jobId, JSON.stringify(draft.content), JSON.stringify(draft.workspace)]
      );
      await syncPhotos(client, { draftId, contractorProfileId, actorUserId, photos: draft.photos });
      const document = await loadOwned(client, actorUserId, draftId);
      await finishCommand(client, reserved.id, document);
      return { kind: "updated", document };
    });
  },
  async get({ pool, actorUserId, draftId }) {
    return loadOwned(pool, actorUserId, draftId);
  },
  async list({ pool, actorUserId, query }) {
    const since = query.time === "30D" ? "30 days" : query.time === "90D" ? "90 days" : null;
    const result = await pool.query(
      `/* business_document:list */
       SELECT drafts.*
       FROM business_document_working_drafts drafts
       INNER JOIN contractor_profiles profiles ON profiles.id = drafts.contractor_profile_id
       WHERE profiles.user_id = $1
         AND ($2::text IS NULL OR drafts.document_type = $2)
         AND ($3::text IS NULL OR drafts.updated_at >= CURRENT_TIMESTAMP - $3::interval)
         AND ($4::text IS NULL OR
           drafts.draft_reference ILIKE $4 OR
           COALESCE(drafts.content->>'customerName', '') ILIKE $4 OR
           COALESCE(drafts.content->>'projectTitle', '') ILIKE $4 OR
           COALESCE(drafts.content->>'customerLocation', '') ILIKE $4 OR
           COALESCE(drafts.content->>'serviceLocation', '') ILIKE $4)
       ORDER BY drafts.updated_at DESC, drafts.id ASC
       LIMIT 100`,
      [actorUserId, query.type, since, query.search ? `%${query.search}%` : null]
    );
    const documents = [];
    for (const row of result.rows) documents.push(publicProjection(row, await loadPhotos(pool, row.id)));
    return documents;
  },
});

function outcome(result, successCode, successStatus) {
  if (result.kind === "idempotency_conflict") return failure(409, "BUSINESS_DOCUMENT_IDEMPOTENCY_CONFLICT", "The save identity was already used for different content.");
  if (result.kind === "in_progress") return failure(409, "BUSINESS_DOCUMENT_SAVE_IN_PROGRESS", "This working document save is already in progress.");
  if (result.kind === "version_conflict") return failure(409, "BUSINESS_DOCUMENT_VERSION_CONFLICT", "A newer saved version exists.", { currentVersion: result.currentVersion });
  if (result.kind === "type_conflict") return failure(409, "BUSINESS_DOCUMENT_TYPE_CONFLICT", "The saved document type cannot be changed.");
  if (result.kind === "job_unavailable") return failure(409, "BUSINESS_DOCUMENT_JOB_CONFLICT", "The selected Job is no longer available for this document.");
  if (result.kind === "not_found") return failure(404, "BUSINESS_DOCUMENT_NOT_FOUND", "The working document was not found.");
  return {
    ok: true,
    status: result.kind === "replay" ? 200 : successStatus,
    code: result.kind === "replay" ? "BUSINESS_DOCUMENT_SAVE_REPLAYED" : successCode,
    document: result.document,
    replayed: result.kind === "replay",
  };
}

async function createBusinessDocumentDraft(input = {}) {
  const validated = validateCreateInput(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlStore;
  const context = await store.getProfessionalContext(input.pool, validated.actorId);
  if (!context?.contractor_profile_id) return failure(403, "BUSINESS_DOCUMENT_AUTHORITY_REQUIRED", "A professional business profile is required.");
  if (!(await store.validateJobAssociation(input.pool, validated.actorId, validated.jobId))) {
    return failure(409, "BUSINESS_DOCUMENT_JOB_CONFLICT", "The selected Job is not available to this professional.");
  }
  const photos = normalizePhotos(validated.rawPhotos, {
    env: input.env,
    contractorProfileId: Number(context.contractor_profile_id),
    normalizeMediaCollection: input.normalizeMediaCollection,
  });
  if (!photos) return failure(400, "BUSINESS_DOCUMENT_PHOTOS_INVALID", "One or more document photos are invalid.");
  const id = randomUUID();
  const draft = {
    id,
    reference: `${validated.documentType === "QUOTE" ? "WQ" : "WI"}-${id.slice(0, 8).toUpperCase()}`,
    documentType: validated.documentType,
    jobId: validated.jobId,
    content: validated.content,
    workspace: validated.workspace,
    photos,
  };
  const hash = requestHash({
    documentType: draft.documentType,
    jobId: draft.jobId,
    content: draft.content,
    workspace: draft.workspace,
    photos: draft.photos,
  });
  const result = await store.create({
    pool: input.pool,
    actorUserId: validated.actorId,
    contractorProfileId: Number(context.contractor_profile_id),
    command: { actorUserId: validated.actorId, operation: "CREATE", key: validated.idempotencyKey, hash },
    draft,
  });
  return outcome(result, "BUSINESS_DOCUMENT_DRAFT_CREATED", 201);
}

async function updateBusinessDocumentDraft(input = {}) {
  const validated = validateUpdateInput(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlStore;
  const context = await store.getProfessionalContext(input.pool, validated.actorId);
  if (!context?.contractor_profile_id) return failure(403, "BUSINESS_DOCUMENT_AUTHORITY_REQUIRED", "A professional business profile is required.");
  if (!(await store.validateJobAssociation(input.pool, validated.actorId, validated.jobId))) {
    return failure(409, "BUSINESS_DOCUMENT_JOB_CONFLICT", "The selected Job is not available to this professional.");
  }
  const photos = normalizePhotos(validated.rawPhotos, {
    env: input.env,
    contractorProfileId: Number(context.contractor_profile_id),
    normalizeMediaCollection: input.normalizeMediaCollection,
  });
  if (!photos) return failure(400, "BUSINESS_DOCUMENT_PHOTOS_INVALID", "One or more document photos are invalid.");
  const draft = {
    documentType: validated.documentType,
    jobId: validated.jobId,
    content: validated.content,
    workspace: validated.workspace,
    photos,
  };
  const hash = requestHash({ draftId: validated.draftId, expectedVersion: validated.expectedVersion, ...draft });
  const result = await store.update({
    pool: input.pool,
    actorUserId: validated.actorId,
    contractorProfileId: Number(context.contractor_profile_id),
    command: { actorUserId: validated.actorId, operation: "UPDATE", key: validated.idempotencyKey, hash },
    draftId: validated.draftId,
    expectedVersion: validated.expectedVersion,
    draft,
  });
  return outcome(result, "BUSINESS_DOCUMENT_DRAFT_UPDATED", 200);
}

async function getBusinessDocumentDraft(input = {}) {
  const allowed = new Set(["pool", "authenticatedActor", "draftId", "store"]);
  if (!onlyKeys(input, allowed)) return failure(400, "BUSINESS_DOCUMENT_FIELD_REJECTED", "The working document request is invalid.");
  const id = actorId(input.authenticatedActor);
  const draftId = uuid(input.draftId);
  if (!id) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!draftId) return failure(400, "BUSINESS_DOCUMENT_ID_INVALID", "A valid working document ID is required.");
  const document = await (input.store || sqlStore).get({ pool: input.pool, actorUserId: id, draftId });
  return document
    ? { ok: true, status: 200, code: "BUSINESS_DOCUMENT_DRAFT_LOADED", document }
    : failure(404, "BUSINESS_DOCUMENT_NOT_FOUND", "The working document was not found.");
}

async function listBusinessDocumentDrafts(input = {}) {
  const allowed = new Set(["pool", "authenticatedActor", "query", "store"]);
  if (!onlyKeys(input, allowed)) return failure(400, "BUSINESS_DOCUMENT_FIELD_REJECTED", "The working document request is invalid.");
  const id = actorId(input.authenticatedActor);
  if (!id) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  const source = input.query || {};
  if (!onlyKeys(source, new Set(["search", "type", "status", "time"]))) return failure(400, "BUSINESS_DOCUMENT_FILTER_INVALID", "One or more Saved Files filters are invalid.");
  const search = text(source.search || "", 240);
  const type = source.type ? String(source.type).trim().toUpperCase() : null;
  const status = source.status ? String(source.status).trim().toUpperCase() : DRAFT_STATUS;
  const time = source.time ? String(source.time).trim().toUpperCase() : "ALL";
  if (search === null || (type && !DOCUMENT_TYPES.includes(type)) || status !== DRAFT_STATUS || !["ALL", "30D", "90D"].includes(time)) {
    return failure(400, "BUSINESS_DOCUMENT_FILTER_INVALID", "One or more Saved Files filters are invalid.");
  }
  const documents = await (input.store || sqlStore).list({ pool: input.pool, actorUserId: id, query: { search, type, status, time } });
  return { ok: true, status: 200, code: "BUSINESS_DOCUMENT_DRAFTS_LOADED", documents };
}

module.exports = {
  createBusinessDocumentDraft,
  getBusinessDocumentDraft,
  listBusinessDocumentDrafts,
  updateBusinessDocumentDraft,
  businessDocumentDraftInternals: {
    DOCUMENT_TYPES,
    DRAFT_STATUS,
    PHOTO_ROLES,
    PHOTO_VISIBILITIES,
    normalizeContent,
    normalizePhotos,
    normalizeWorkspace,
    publicProjection,
    requestHash,
    sqlStore,
    validateCreateInput,
    validateUpdateInput,
  },
};
