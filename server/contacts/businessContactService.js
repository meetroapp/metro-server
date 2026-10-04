"use strict";

const { createHash, randomUUID } = require("node:crypto");

const PARTY_TYPES = Object.freeze(["PERSON", "ORGANIZATION"]);
const CONTACT_ROLES = Object.freeze([
  "CUSTOMER",
  "PROFESSIONAL_VENDOR",
  "EMPLOYEE",
  "TENANT",
  "PROPERTY_MANAGER",
]);
const CONTACT_STATUSES = Object.freeze(["ACTIVE", "ARCHIVED"]);
const COMMAND_OPERATIONS = Object.freeze({
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  ASSIGN_ROLE: "ASSIGN_ROLE",
  END_ROLE: "END_ROLE",
  ARCHIVE: "ARCHIVE",
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function positiveInteger(value) {
  const normalized = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizedEnum(value, allowed) {
  const normalized = String(value || "").trim().toUpperCase();
  return allowed.includes(normalized) ? normalized : null;
}

function optionalText(value, maximum) {
  if (value === undefined) return { valid: true, supplied: false, value: undefined };
  if (value === null || value === "") return { valid: true, supplied: true, value: null };
  if (typeof value !== "string") return { valid: false, supplied: true, value: null };
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    return { valid: false, supplied: true, value: null };
  }
  return { valid: true, supplied: true, value: normalized };
}

function normalizedEmail(value) {
  const result = optionalText(value, 320);
  if (!result.valid || !result.supplied || result.value === null) return result;
  const email = result.value.toLowerCase();
  return EMAIL_PATTERN.test(email)
    ? { ...result, value: email }
    : { valid: false, supplied: true, value: null };
}

function normalizedPhone(value) {
  const result = optionalText(value, 80);
  if (!result.valid || !result.supplied || result.value === null) return result;
  const digits = result.value.replace(/\D/g, "");
  return digits.length >= 3
    ? result
    : { valid: false, supplied: true, value: null };
}

function version(value) {
  return positiveInteger(value);
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

function isoTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function roleProjection(row = {}) {
  return Object.freeze({
    id: String(row.id),
    role: row.role,
    active: row.ended_at == null,
    assignmentSource: row.assignment_source,
    sourceReference: row.source_reference || null,
    assignedAt: isoTimestamp(row.assigned_at),
    endedAt: isoTimestamp(row.ended_at),
  });
}

function contactProjection(row, roles = []) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id),
    contractorProfileId: Number(row.contractor_profile_id),
    partyType: row.party_type,
    displayName: row.display_name,
    companyName: row.company_name || null,
    email: row.email || null,
    phone: row.phone || null,
    address: row.address_text || null,
    serviceArea: row.service_area_text || null,
    privateNote: row.private_note || null,
    status: row.status,
    version: Number(row.version),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    roles: roles.map(roleProjection),
  });
}

function normalizeContactFields(payload, { partial = false } = {}) {
  const partyType = payload.partyType === undefined
    ? null
    : normalizedEnum(payload.partyType, PARTY_TYPES);
  const displayName = optionalText(payload.displayName, 240);
  const companyName = optionalText(payload.companyName, 240);
  const email = normalizedEmail(payload.email);
  const phone = normalizedPhone(payload.phone);
  const address = optionalText(payload.address, 600);
  const serviceArea = optionalText(payload.serviceArea, 600);
  const privateNote = optionalText(payload.privateNote, 8000);
  if (
    (payload.partyType !== undefined && !partyType) ||
    !displayName.valid || !companyName.valid || !email.valid || !phone.valid ||
    !address.valid || !serviceArea.valid || !privateNote.valid
  ) return null;
  if (!partial && (!partyType || !displayName.supplied || !displayName.value)) return null;

  const fields = {};
  if (payload.partyType !== undefined) fields.partyType = partyType;
  for (const [key, normalized] of Object.entries({
    displayName,
    companyName,
    email,
    phone,
    address,
    serviceArea,
    privateNote,
  })) {
    if (normalized.supplied) fields[key] = normalized.value;
  }
  return fields;
}

function validateCreate(input) {
  if (!onlyKeys(input, new Set([
    "pool", "authenticatedActor", "payload", "idempotencyKey", "store", "idFactory",
  ]))) return { error: failure(400, "BUSINESS_CONTACT_FIELD_REJECTED", "The Contact request contains unsupported fields.") };
  const actor = actorId(input.authenticatedActor);
  if (!actor) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  const key = uuid(input.idempotencyKey);
  if (!key) return { error: failure(400, "BUSINESS_CONTACT_IDEMPOTENCY_REQUIRED", "A valid Contact save identity is required.") };
  const allowed = new Set([
    "contractorProfileId", "partyType", "displayName", "companyName", "email", "phone",
    "address", "serviceArea", "privateNote",
  ]);
  if (!onlyKeys(input.payload, allowed)) {
    return { error: failure(400, "BUSINESS_CONTACT_FIELD_REJECTED", "The Contact request contains unsupported fields.") };
  }
  const contractorProfileId = positiveInteger(input.payload.contractorProfileId);
  const fields = normalizeContactFields(input.payload);
  if (!contractorProfileId || !fields) {
    return { error: failure(400, "BUSINESS_CONTACT_INVALID", "The Contact is invalid.") };
  }
  return { actor, key, contractorProfileId, fields };
}

function validateContactIdInput(input, allowedExtra = []) {
  const allowed = new Set(["pool", "authenticatedActor", "contactId", "store", ...allowedExtra]);
  if (!onlyKeys(input, allowed)) {
    return { error: failure(400, "BUSINESS_CONTACT_FIELD_REJECTED", "The Contact request contains unsupported fields.") };
  }
  const actor = actorId(input.authenticatedActor);
  if (!actor) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  const contactId = uuid(input.contactId);
  if (!contactId) return { error: failure(400, "BUSINESS_CONTACT_ID_INVALID", "A valid Contact ID is required.") };
  return { actor, contactId };
}

function validateUpdate(input) {
  const base = validateContactIdInput(input, ["payload", "idempotencyKey"]);
  if (base.error) return base;
  const key = uuid(input.idempotencyKey);
  if (!key) return { error: failure(400, "BUSINESS_CONTACT_IDEMPOTENCY_REQUIRED", "A valid Contact save identity is required.") };
  const allowed = new Set([
    "expectedVersion", "partyType", "displayName", "companyName", "email", "phone",
    "address", "serviceArea", "privateNote",
  ]);
  if (!onlyKeys(input.payload, allowed)) {
    return { error: failure(400, "BUSINESS_CONTACT_FIELD_REJECTED", "The Contact update contains unsupported fields.") };
  }
  const expectedVersion = version(input.payload.expectedVersion);
  const patch = normalizeContactFields(input.payload, { partial: true });
  if (!expectedVersion || !patch || Object.keys(patch).length === 0 || patch.displayName === null) {
    return { error: failure(400, "BUSINESS_CONTACT_UPDATE_INVALID", "The Contact update is invalid.") };
  }
  return { ...base, key, expectedVersion, patch };
}

function validateRoleMutation(input, operation) {
  const extras = operation === COMMAND_OPERATIONS.END_ROLE
    ? ["roleId", "payload", "idempotencyKey"]
    : ["payload", "idempotencyKey", "idFactory"];
  const base = validateContactIdInput(input, extras);
  if (base.error) return base;
  const key = uuid(input.idempotencyKey);
  if (!key) return { error: failure(400, "BUSINESS_CONTACT_IDEMPOTENCY_REQUIRED", "A valid Contact save identity is required.") };
  const allowed = operation === COMMAND_OPERATIONS.END_ROLE
    ? new Set(["expectedVersion", "sourceReference"])
    : new Set(["expectedVersion", "role", "sourceReference"]);
  if (!onlyKeys(input.payload, allowed)) {
    return { error: failure(400, "BUSINESS_CONTACT_FIELD_REJECTED", "The Contact role request contains unsupported fields.") };
  }
  const expectedVersion = version(input.payload.expectedVersion);
  const sourceReference = optionalText(input.payload.sourceReference, 500);
  const role = operation === COMMAND_OPERATIONS.ASSIGN_ROLE
    ? normalizedEnum(input.payload.role, CONTACT_ROLES)
    : null;
  const roleId = operation === COMMAND_OPERATIONS.END_ROLE ? uuid(input.roleId) : null;
  if (!expectedVersion || !sourceReference.valid ||
      (operation === COMMAND_OPERATIONS.ASSIGN_ROLE && !role) ||
      (operation === COMMAND_OPERATIONS.END_ROLE && !roleId)) {
    return { error: failure(400, "BUSINESS_CONTACT_ROLE_INVALID", "The Contact role request is invalid.") };
  }
  return {
    ...base,
    key,
    expectedVersion,
    role,
    roleId,
    sourceReference: sourceReference.supplied ? sourceReference.value : null,
  };
}

function validateArchive(input) {
  const base = validateContactIdInput(input, ["payload", "idempotencyKey"]);
  if (base.error) return base;
  if (!onlyKeys(input.payload, new Set(["expectedVersion"]))) {
    return { error: failure(400, "BUSINESS_CONTACT_FIELD_REJECTED", "The Contact archive request contains unsupported fields.") };
  }
  const key = uuid(input.idempotencyKey);
  const expectedVersion = version(input.payload.expectedVersion);
  if (!key || !expectedVersion) {
    return { error: failure(400, "BUSINESS_CONTACT_ARCHIVE_INVALID", "The Contact archive request is invalid.") };
  }
  return { ...base, key, expectedVersion };
}

function validateList(input) {
  if (!onlyKeys(input, new Set(["pool", "authenticatedActor", "query", "store"]))) {
    return { error: failure(400, "BUSINESS_CONTACT_FIELD_REJECTED", "The Contact list request contains unsupported fields.") };
  }
  const actor = actorId(input.authenticatedActor);
  if (!actor) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  const allowed = new Set(["contractorProfileId", "search", "status", "role", "limit"]);
  if (!onlyKeys(input.query, allowed)) {
    return { error: failure(400, "BUSINESS_CONTACT_QUERY_INVALID", "The Contact query is invalid.") };
  }
  const contractorProfileId = positiveInteger(input.query.contractorProfileId);
  const search = optionalText(input.query.search, 240);
  const status = input.query.status === undefined || input.query.status === ""
    ? "ACTIVE"
    : normalizedEnum(input.query.status, [...CONTACT_STATUSES, "ALL"]);
  const role = input.query.role === undefined || input.query.role === ""
    ? null
    : normalizedEnum(input.query.role, CONTACT_ROLES);
  const limit = input.query.limit === undefined || input.query.limit === ""
    ? 50
    : positiveInteger(input.query.limit);
  if (!contractorProfileId || !search.valid || !status ||
      (input.query.role && !role) || !limit || limit > 100) {
    return { error: failure(400, "BUSINESS_CONTACT_QUERY_INVALID", "The Contact query is invalid.") };
  }
  return {
    actor,
    contractorProfileId,
    query: {
      search: search.supplied ? search.value : null,
      status,
      role,
      limit,
    },
  };
}

function ownerUnavailable() {
  return failure(404, "BUSINESS_CONTACT_BUSINESS_UNAVAILABLE", "The business is unavailable.");
}

function mutationOutcome(result, successCode, successStatus) {
  if (result.kind === "idempotency_conflict") return failure(409, "BUSINESS_CONTACT_IDEMPOTENCY_CONFLICT", "The save identity was already used for a different Contact request.");
  if (result.kind === "in_progress") return failure(409, "BUSINESS_CONTACT_SAVE_IN_PROGRESS", "This Contact request is already in progress.");
  if (result.kind === "not_found") return failure(404, "BUSINESS_CONTACT_NOT_FOUND", "The Contact was not found.");
  if (result.kind === "version_conflict") return failure(409, "BUSINESS_CONTACT_VERSION_CONFLICT", "A newer Contact version exists.", { currentVersion: result.currentVersion });
  if (result.kind === "archived") return failure(409, "BUSINESS_CONTACT_ARCHIVED", "The archived Contact cannot be changed.");
  if (result.kind === "role_active") return failure(409, "BUSINESS_CONTACT_ROLE_ALREADY_ACTIVE", "The Contact already has this active role.");
  if (result.kind === "role_not_found") return failure(404, "BUSINESS_CONTACT_ROLE_NOT_FOUND", "The active Contact role was not found.");
  return {
    ok: true,
    status: result.kind === "replay" ? 200 : successStatus,
    code: result.kind === "replay" ? `${successCode}_REPLAYED` : successCode,
    contact: result.response.contact,
    ...(result.response.duplicateCandidates ? { duplicateCandidates: result.response.duplicateCandidates } : {}),
    replayed: result.kind === "replay",
  };
}

async function createBusinessContact(input = {}) {
  const validated = validateCreate(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlStore;
  if (!(await store.resolveOwner(input.pool, validated.actor, validated.contractorProfileId))) {
    return ownerUnavailable();
  }
  const contactId = uuid((input.idFactory || randomUUID)());
  if (!contactId) throw new Error("The Contact identity generator returned an invalid UUID.");
  const result = await store.create({
    pool: input.pool,
    actorUserId: validated.actor,
    contractorProfileId: validated.contractorProfileId,
    contactId,
    fields: validated.fields,
    command: {
      operation: COMMAND_OPERATIONS.CREATE,
      key: validated.key,
      hash: requestHash({ contractorProfileId: validated.contractorProfileId, fields: validated.fields }),
    },
  });
  return mutationOutcome(result, "BUSINESS_CONTACT_CREATED", 201);
}

async function getBusinessContact(input = {}) {
  const validated = validateContactIdInput(input);
  if (validated.error) return validated.error;
  const contact = await (input.store || sqlStore).get(input.pool, validated.actor, validated.contactId);
  return contact
    ? { ok: true, status: 200, code: "BUSINESS_CONTACT_LOADED", contact }
    : failure(404, "BUSINESS_CONTACT_NOT_FOUND", "The Contact was not found.");
}

async function listBusinessContacts(input = {}) {
  const validated = validateList(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlStore;
  if (!(await store.resolveOwner(input.pool, validated.actor, validated.contractorProfileId))) {
    return ownerUnavailable();
  }
  const contacts = await store.list(
    input.pool,
    validated.actor,
    validated.contractorProfileId,
    validated.query
  );
  return { ok: true, status: 200, code: "BUSINESS_CONTACTS_LISTED", contacts };
}

async function updateBusinessContact(input = {}) {
  const validated = validateUpdate(input);
  if (validated.error) return validated.error;
  const result = await (input.store || sqlStore).update({
    pool: input.pool,
    actorUserId: validated.actor,
    contactId: validated.contactId,
    expectedVersion: validated.expectedVersion,
    patch: validated.patch,
    command: {
      operation: COMMAND_OPERATIONS.UPDATE,
      key: validated.key,
      hash: requestHash({ contactId: validated.contactId, expectedVersion: validated.expectedVersion, patch: validated.patch }),
    },
  });
  return mutationOutcome(result, "BUSINESS_CONTACT_UPDATED", 200);
}

async function assignBusinessContactRole(input = {}) {
  const validated = validateRoleMutation(input, COMMAND_OPERATIONS.ASSIGN_ROLE);
  if (validated.error) return validated.error;
  const roleId = uuid((input.idFactory || randomUUID)());
  if (!roleId) throw new Error("The Contact role identity generator returned an invalid UUID.");
  const result = await (input.store || sqlStore).assignRole({
    pool: input.pool,
    actorUserId: validated.actor,
    contactId: validated.contactId,
    roleId,
    role: validated.role,
    sourceReference: validated.sourceReference,
    expectedVersion: validated.expectedVersion,
    command: {
      operation: COMMAND_OPERATIONS.ASSIGN_ROLE,
      key: validated.key,
      hash: requestHash({
        contactId: validated.contactId,
        expectedVersion: validated.expectedVersion,
        role: validated.role,
        sourceReference: validated.sourceReference,
      }),
    },
  });
  return mutationOutcome(result, "BUSINESS_CONTACT_ROLE_ASSIGNED", 201);
}

async function endBusinessContactRole(input = {}) {
  const validated = validateRoleMutation(input, COMMAND_OPERATIONS.END_ROLE);
  if (validated.error) return validated.error;
  const result = await (input.store || sqlStore).endRole({
    pool: input.pool,
    actorUserId: validated.actor,
    contactId: validated.contactId,
    roleId: validated.roleId,
    sourceReference: validated.sourceReference,
    expectedVersion: validated.expectedVersion,
    command: {
      operation: COMMAND_OPERATIONS.END_ROLE,
      key: validated.key,
      hash: requestHash({
        contactId: validated.contactId,
        roleId: validated.roleId,
        expectedVersion: validated.expectedVersion,
        sourceReference: validated.sourceReference,
      }),
    },
  });
  return mutationOutcome(result, "BUSINESS_CONTACT_ROLE_ENDED", 200);
}

async function archiveBusinessContact(input = {}) {
  const validated = validateArchive(input);
  if (validated.error) return validated.error;
  const result = await (input.store || sqlStore).archive({
    pool: input.pool,
    actorUserId: validated.actor,
    contactId: validated.contactId,
    expectedVersion: validated.expectedVersion,
    command: {
      operation: COMMAND_OPERATIONS.ARCHIVE,
      key: validated.key,
      hash: requestHash({ contactId: validated.contactId, expectedVersion: validated.expectedVersion }),
    },
  });
  return mutationOutcome(result, "BUSINESS_CONTACT_ARCHIVED", 200);
}

async function withTransaction(pool, action) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("A database pool is required.");
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function resolveOwner(pool, actorUserId, contractorProfileId) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("A database pool is required.");
  const result = await pool.query(
    `/* business_contact:resolve_owner */
     SELECT id FROM contractor_profiles
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [contractorProfileId, actorUserId]
  );
  return Boolean(result.rows[0]);
}

async function loadRoles(client, contactId, contractorProfileId) {
  const result = await client.query(
    `/* business_contact:load_roles */
     SELECT * FROM business_contact_roles
     WHERE business_contact_id = $1 AND contractor_profile_id = $2
     ORDER BY assigned_at ASC, id ASC`,
    [contactId, contractorProfileId]
  );
  return result.rows;
}

async function loadOwnedRow(client, actorUserId, contactId, { lock = false } = {}) {
  const result = await client.query(
    `/* business_contact:load_owned */
     SELECT contacts.*
     FROM business_contacts contacts
     INNER JOIN contractor_profiles profiles
       ON profiles.id = contacts.contractor_profile_id
     WHERE contacts.id = $1 AND profiles.user_id = $2
     LIMIT 1 ${lock ? "FOR UPDATE OF contacts" : ""}`,
    [contactId, actorUserId]
  );
  return result.rows[0] || null;
}

async function loadOwnedProjection(client, actorUserId, contactId, options = {}) {
  const row = await loadOwnedRow(client, actorUserId, contactId, options);
  if (!row) return null;
  return contactProjection(row, await loadRoles(client, row.id, row.contractor_profile_id));
}

async function findDuplicateCandidates(client, row) {
  if (!row?.email_normalized && !row?.phone_normalized) return [];
  const result = await client.query(
    `/* business_contact:duplicate_candidates */
     SELECT * FROM business_contacts
     WHERE contractor_profile_id = $1
       AND id <> $2
       AND (
         ($3::text IS NOT NULL AND email_normalized = $3)
         OR ($4::text IS NOT NULL AND phone_normalized = $4)
       )
     ORDER BY status ASC, updated_at DESC, id ASC
     LIMIT 20`,
    [row.contractor_profile_id, row.id, row.email_normalized || null, row.phone_normalized || null]
  );
  const candidates = [];
  for (const candidate of result.rows) {
    candidates.push(contactProjection(
      candidate,
      await loadRoles(client, candidate.id, candidate.contractor_profile_id)
    ));
  }
  return candidates;
}

async function reserveCommand(client, { contractorProfileId, actorUserId, operation, key, hash }) {
  const inserted = await client.query(
    `/* business_contact:reserve_command */
     INSERT INTO business_contact_commands (
       contractor_profile_id, actor_user_id, operation, idempotency_key, request_hash
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [contractorProfileId, actorUserId, operation, key, hash]
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id };
  const existing = await client.query(
    `/* business_contact:load_command */
     SELECT id, contractor_profile_id, request_hash, response_json
     FROM business_contact_commands
     WHERE actor_user_id = $1 AND operation = $2 AND idempotency_key = $3
     LIMIT 1`,
    [actorUserId, operation, key]
  );
  const row = existing.rows[0];
  if (!row || Number(row.contractor_profile_id) !== contractorProfileId || row.request_hash !== hash) {
    return { conflict: true };
  }
  if (row.response_json) return { replay: row.response_json };
  return { pending: true };
}

async function finishCommand(client, commandId, contractorProfileId, contactId, response) {
  const result = await client.query(
    `/* business_contact:finish_command */
     UPDATE business_contact_commands
     SET business_contact_id = $2, response_json = $3::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND contractor_profile_id = $4`,
    [commandId, contactId, JSON.stringify(response), contractorProfileId]
  );
  if (result.rowCount !== 1) throw new Error("The Contact command could not be completed.");
}

async function cancelCommand(client, commandId) {
  if (commandId) {
    await client.query("/* business_contact:cancel_command */ DELETE FROM business_contact_commands WHERE id = $1", [commandId]);
  }
}

async function reserveForOwnedContact(client, input) {
  const current = await loadOwnedRow(client, input.actorUserId, input.contactId, { lock: true });
  if (!current) return { outcome: { kind: "not_found" } };
  const contractorProfileId = Number(current.contractor_profile_id);
  const reserved = await reserveCommand(client, {
    contractorProfileId,
    actorUserId: input.actorUserId,
    ...input.command,
  });
  if (reserved.conflict) return { outcome: { kind: "idempotency_conflict" } };
  if (reserved.pending) return { outcome: { kind: "in_progress" } };
  if (reserved.replay) return { outcome: { kind: "replay", response: reserved.replay } };
  if (Number(current.version) !== input.expectedVersion) {
    await cancelCommand(client, reserved.id);
    return { outcome: { kind: "version_conflict", currentVersion: Number(current.version) } };
  }
  return { current, contractorProfileId, reserved };
}

const UPDATE_COLUMN_BY_FIELD = Object.freeze({
  partyType: "party_type",
  displayName: "display_name",
  companyName: "company_name",
  email: "email",
  phone: "phone",
  address: "address_text",
  serviceArea: "service_area_text",
  privateNote: "private_note",
});

const sqlStore = Object.freeze({
  resolveOwner,

  create(input) {
    return withTransaction(input.pool, async (client) => {
      const reserved = await reserveCommand(client, {
        contractorProfileId: input.contractorProfileId,
        actorUserId: input.actorUserId,
        ...input.command,
      });
      if (reserved.conflict) return { kind: "idempotency_conflict" };
      if (reserved.pending) return { kind: "in_progress" };
      if (reserved.replay) return { kind: "replay", response: reserved.replay };
      if (!(await resolveOwner(client, input.actorUserId, input.contractorProfileId))) {
        await cancelCommand(client, reserved.id);
        return { kind: "not_found" };
      }
      const fields = input.fields;
      const inserted = await client.query(
        `/* business_contact:create */
         INSERT INTO business_contacts (
           id, contractor_profile_id, created_by_user_id, party_type, display_name,
           company_name, email, phone, address_text, service_area_text, private_note
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          input.contactId, input.contractorProfileId, input.actorUserId,
          fields.partyType, fields.displayName, fields.companyName || null,
          fields.email || null, fields.phone || null, fields.address || null,
          fields.serviceArea || null, fields.privateNote || null,
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("The Contact was not returned after creation.");
      const response = {
        contact: contactProjection(row, []),
        duplicateCandidates: await findDuplicateCandidates(client, row),
      };
      await finishCommand(client, reserved.id, input.contractorProfileId, input.contactId, response);
      return { kind: "created", response };
    });
  },

  async get(pool, actorUserId, contactId) {
    return loadOwnedProjection(pool, actorUserId, contactId);
  },

  async list(pool, actorUserId, contractorProfileId, query) {
    const pattern = query.search ? `%${query.search}%` : null;
    const digits = query.search ? query.search.replace(/\D/g, "") : "";
    const result = await pool.query(
      `/* business_contact:list */
       SELECT contacts.*
       FROM business_contacts contacts
       INNER JOIN contractor_profiles profiles
         ON profiles.id = contacts.contractor_profile_id
       WHERE contacts.contractor_profile_id = $1
         AND profiles.user_id = $2
         AND ($3::text = 'ALL' OR contacts.status = $3)
         AND ($4::text IS NULL OR EXISTS (
           SELECT 1 FROM business_contact_roles roles
           WHERE roles.business_contact_id = contacts.id
             AND roles.contractor_profile_id = contacts.contractor_profile_id
             AND roles.role = $4 AND roles.ended_at IS NULL
         ))
         AND ($5::text IS NULL OR
           contacts.display_name ILIKE $5 OR
           COALESCE(contacts.company_name, '') ILIKE $5 OR
           COALESCE(contacts.email_normalized, '') ILIKE lower($5) OR
           COALESCE(contacts.phone_normalized, '') ILIKE $6 OR
           COALESCE(contacts.address_text, '') ILIKE $5 OR
           COALESCE(contacts.service_area_text, '') ILIKE $5)
       ORDER BY contacts.updated_at DESC, contacts.id ASC
       LIMIT $7`,
      [
        contractorProfileId, actorUserId, query.status, query.role,
        pattern, digits ? `%${digits}%` : "", query.limit,
      ]
    );
    const contacts = [];
    for (const row of result.rows) {
      contacts.push(contactProjection(row, await loadRoles(pool, row.id, row.contractor_profile_id)));
    }
    return contacts;
  },

  update(input) {
    return withTransaction(input.pool, async (client) => {
      const context = await reserveForOwnedContact(client, input);
      if (context.outcome) return context.outcome;
      if (context.current.status === "ARCHIVED") {
        await cancelCommand(client, context.reserved.id);
        return { kind: "archived" };
      }
      const values = [];
      const assignments = [];
      for (const [field, value] of Object.entries(input.patch)) {
        values.push(value);
        assignments.push(`${UPDATE_COLUMN_BY_FIELD[field]} = $${values.length}`);
      }
      values.push(input.contactId);
      await client.query(
        `/* business_contact:update */
         UPDATE business_contacts
         SET ${assignments.join(", ")}, version = version + 1
         WHERE id = $${values.length}`,
        values
      );
      const row = await loadOwnedRow(client, input.actorUserId, input.contactId);
      const response = {
        contact: contactProjection(row, await loadRoles(client, row.id, row.contractor_profile_id)),
        duplicateCandidates: await findDuplicateCandidates(client, row),
      };
      await finishCommand(client, context.reserved.id, context.contractorProfileId, input.contactId, response);
      return { kind: "updated", response };
    });
  },

  assignRole(input) {
    return withTransaction(input.pool, async (client) => {
      const context = await reserveForOwnedContact(client, input);
      if (context.outcome) return context.outcome;
      if (context.current.status === "ARCHIVED") {
        await cancelCommand(client, context.reserved.id);
        return { kind: "archived" };
      }
      const active = await client.query(
        `SELECT id FROM business_contact_roles
         WHERE business_contact_id = $1 AND role = $2 AND ended_at IS NULL
         LIMIT 1`,
        [input.contactId, input.role]
      );
      if (active.rows[0]) {
        await cancelCommand(client, context.reserved.id);
        return { kind: "role_active" };
      }
      await client.query(
        `/* business_contact:assign_role */
         INSERT INTO business_contact_roles (
           id, business_contact_id, contractor_profile_id, role,
           assigned_by_user_id, assignment_source, source_reference
         ) VALUES ($1, $2, $3, $4, $5, 'PROFESSIONAL_EXPLICIT', $6)`,
        [
          input.roleId, input.contactId, context.contractorProfileId,
          input.role, input.actorUserId, input.sourceReference,
        ]
      );
      await client.query(
        "UPDATE business_contacts SET version = version + 1 WHERE id = $1",
        [input.contactId]
      );
      const contact = await loadOwnedProjection(client, input.actorUserId, input.contactId);
      const response = { contact };
      await finishCommand(client, context.reserved.id, context.contractorProfileId, input.contactId, response);
      return { kind: "role_assigned", response };
    });
  },

  endRole(input) {
    return withTransaction(input.pool, async (client) => {
      const context = await reserveForOwnedContact(client, input);
      if (context.outcome) return context.outcome;
      if (context.current.status === "ARCHIVED") {
        await cancelCommand(client, context.reserved.id);
        return { kind: "archived" };
      }
      const role = await client.query(
        `SELECT id FROM business_contact_roles
         WHERE id = $1 AND business_contact_id = $2
           AND contractor_profile_id = $3 AND ended_at IS NULL
         LIMIT 1 FOR UPDATE`,
        [input.roleId, input.contactId, context.contractorProfileId]
      );
      if (!role.rows[0]) {
        await cancelCommand(client, context.reserved.id);
        return { kind: "role_not_found" };
      }
      await client.query(
        `/* business_contact:end_role */
         UPDATE business_contact_roles
         SET ended_at = CURRENT_TIMESTAMP,
           ended_by_user_id = $4,
           ending_source = 'PROFESSIONAL_EXPLICIT',
           end_source_reference = $5
         WHERE id = $1 AND business_contact_id = $2 AND contractor_profile_id = $3`,
        [input.roleId, input.contactId, context.contractorProfileId, input.actorUserId, input.sourceReference]
      );
      await client.query(
        "UPDATE business_contacts SET version = version + 1 WHERE id = $1",
        [input.contactId]
      );
      const contact = await loadOwnedProjection(client, input.actorUserId, input.contactId);
      const response = { contact };
      await finishCommand(client, context.reserved.id, context.contractorProfileId, input.contactId, response);
      return { kind: "role_ended", response };
    });
  },

  archive(input) {
    return withTransaction(input.pool, async (client) => {
      const context = await reserveForOwnedContact(client, input);
      if (context.outcome) return context.outcome;
      if (context.current.status === "ARCHIVED") {
        await cancelCommand(client, context.reserved.id);
        return { kind: "archived" };
      }
      await client.query(
        `/* business_contact:archive */
         UPDATE business_contacts
         SET status = 'ARCHIVED', version = version + 1
         WHERE id = $1`,
        [input.contactId]
      );
      const contact = await loadOwnedProjection(client, input.actorUserId, input.contactId);
      const response = { contact };
      await finishCommand(client, context.reserved.id, context.contractorProfileId, input.contactId, response);
      return { kind: "archived_contact", response };
    });
  },
});

module.exports = {
  archiveBusinessContact,
  assignBusinessContactRole,
  businessContactInternals: Object.freeze({
    COMMAND_OPERATIONS,
    CONTACT_ROLES,
    CONTACT_STATUSES,
    PARTY_TYPES,
    contactProjection,
    normalizeContactFields,
    requestHash,
    sqlStore,
  }),
  createBusinessContact,
  endBusinessContactRole,
  getBusinessContact,
  listBusinessContacts,
  updateBusinessContact,
};
