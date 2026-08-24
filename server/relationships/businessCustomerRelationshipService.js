"use strict";

const { createHash, randomUUID } = require("node:crypto");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ESTABLISH_OPERATION = "ESTABLISH";

function failure(status, code, message) {
  return { ok: false, status, code, message };
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

function relationshipProjection(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id),
    contractorProfileId: Number(row.contractor_profile_id),
    businessContactId: String(row.business_contact_id),
    version: Number(row.version),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    contact: Object.freeze({
      id: String(row.business_contact_id),
      partyType: row.contact_party_type,
      displayName: row.contact_display_name,
      companyName: row.contact_company_name || null,
      email: row.contact_email || null,
      phone: row.contact_phone || null,
      address: row.contact_address_text || null,
      serviceArea: row.contact_service_area_text || null,
      status: row.contact_status,
      version: Number(row.contact_version),
    }),
  });
}

function validateEstablish(input) {
  if (!onlyKeys(input, new Set([
    "pool", "authenticatedActor", "payload", "idempotencyKey", "store", "idFactory",
  ]))) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED", "The Customer Relationship request contains unsupported fields.") };
  }
  const actor = actorId(input.authenticatedActor);
  if (!actor) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  const key = uuid(input.idempotencyKey);
  if (!key) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_IDEMPOTENCY_REQUIRED", "A valid Customer Relationship save identity is required.") };
  }
  if (!onlyKeys(input.payload, new Set(["contractorProfileId", "businessContactId"]))) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED", "The Customer Relationship request contains unsupported fields.") };
  }
  const contractorProfileId = positiveInteger(input.payload.contractorProfileId);
  const businessContactId = uuid(input.payload.businessContactId);
  const relationshipId = uuid((input.idFactory || randomUUID)());
  if (!contractorProfileId || !businessContactId || !relationshipId) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_INVALID", "The Customer Relationship is invalid.") };
  }
  return { actor, key, contractorProfileId, businessContactId, relationshipId };
}

function validateIdentityRead(input, field) {
  if (!onlyKeys(input, new Set(["pool", "authenticatedActor", field, "store"]))) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED", "The Customer Relationship request contains unsupported fields.") };
  }
  const actor = actorId(input.authenticatedActor);
  if (!actor) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  const identity = uuid(input[field]);
  if (!identity) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_ID_INVALID", "A valid Customer Relationship identity is required.") };
  }
  return { actor, identity };
}

function validateList(input) {
  if (!onlyKeys(input, new Set(["pool", "authenticatedActor", "query", "store"]))) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED", "The Customer Relationship request contains unsupported fields.") };
  }
  const actor = actorId(input.authenticatedActor);
  if (!actor) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  if (!onlyKeys(input.query || {}, new Set(["contractorProfileId", "limit"]))) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED", "The Customer Relationship query contains unsupported fields.") };
  }
  const contractorProfileId = positiveInteger(input.query?.contractorProfileId);
  const limit = input.query?.limit === undefined ? 100 : positiveInteger(input.query.limit);
  if (!contractorProfileId || !limit || limit > 200) {
    return { error: failure(400, "BUSINESS_CUSTOMER_RELATIONSHIP_QUERY_INVALID", "The Customer Relationship query is invalid.") };
  }
  return { actor, contractorProfileId, limit };
}

function establishOutcome(result) {
  if (result?.kind === "created") {
    return { ok: true, status: 201, code: "BUSINESS_CUSTOMER_RELATIONSHIP_ESTABLISHED", relationship: result.response.relationship };
  }
  if (result?.kind === "existing") {
    return { ok: true, status: 200, code: "BUSINESS_CUSTOMER_RELATIONSHIP_EXISTS", relationship: result.response.relationship };
  }
  if (result?.kind === "replay") {
    return { ok: true, status: 200, code: "BUSINESS_CUSTOMER_RELATIONSHIP_ESTABLISHED", ...result.response, replayed: true };
  }
  if (result?.kind === "not_found") {
    return failure(404, "BUSINESS_CUSTOMER_RELATIONSHIP_CONTACT_NOT_FOUND", "The business Contact was not found.");
  }
  if (result?.kind === "idempotency_conflict") {
    return failure(409, "BUSINESS_CUSTOMER_RELATIONSHIP_IDEMPOTENCY_CONFLICT", "That Customer Relationship save identity was already used for different input.");
  }
  if (result?.kind === "in_progress") {
    return failure(409, "BUSINESS_CUSTOMER_RELATIONSHIP_IN_PROGRESS", "That Customer Relationship command is still being processed.");
  }
  throw new Error("Unsupported Customer Relationship establishment outcome.");
}

async function establishBusinessCustomerRelationship(input = {}) {
  const validated = validateEstablish(input);
  if (validated.error) return validated.error;
  const result = await (input.store || sqlStore).establish({
    pool: input.pool,
    actorUserId: validated.actor,
    contractorProfileId: validated.contractorProfileId,
    businessContactId: validated.businessContactId,
    relationshipId: validated.relationshipId,
    command: {
      operation: ESTABLISH_OPERATION,
      key: validated.key,
      hash: requestHash({
        contractorProfileId: validated.contractorProfileId,
        businessContactId: validated.businessContactId,
      }),
    },
  });
  return establishOutcome(result);
}

async function getBusinessCustomerRelationship(input = {}) {
  const validated = validateIdentityRead(input, "relationshipId");
  if (validated.error) return validated.error;
  const relationship = await (input.store || sqlStore).get(
    input.pool,
    validated.actor,
    validated.identity
  );
  return relationship
    ? { ok: true, status: 200, code: "BUSINESS_CUSTOMER_RELATIONSHIP_LOADED", relationship }
    : failure(404, "BUSINESS_CUSTOMER_RELATIONSHIP_NOT_FOUND", "The Customer Relationship was not found.");
}

async function getBusinessCustomerRelationshipByContact(input = {}) {
  const validated = validateIdentityRead(input, "businessContactId");
  if (validated.error) return validated.error;
  const relationship = await (input.store || sqlStore).getByContact(
    input.pool,
    validated.actor,
    validated.identity
  );
  return relationship
    ? { ok: true, status: 200, code: "BUSINESS_CUSTOMER_RELATIONSHIP_LOADED", relationship }
    : failure(404, "BUSINESS_CUSTOMER_RELATIONSHIP_NOT_FOUND", "The Customer Relationship was not found.");
}

async function listBusinessCustomerRelationships(input = {}) {
  const validated = validateList(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlStore;
  if (!(await store.resolveOwner(input.pool, validated.actor, validated.contractorProfileId))) {
    return failure(404, "BUSINESS_CUSTOMER_RELATIONSHIP_BUSINESS_UNAVAILABLE", "The business profile was not found.");
  }
  const relationships = await store.list(
    input.pool,
    validated.actor,
    validated.contractorProfileId,
    validated.limit
  );
  return { ok: true, status: 200, code: "BUSINESS_CUSTOMER_RELATIONSHIPS_LISTED", relationships };
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
    `/* business_customer_relationship:resolve_owner */
     SELECT id FROM contractor_profiles
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [contractorProfileId, actorUserId]
  );
  return Boolean(result.rows[0]);
}

const RELATIONSHIP_SELECT = `
  SELECT relationships.*,
    contacts.party_type AS contact_party_type,
    contacts.display_name AS contact_display_name,
    contacts.company_name AS contact_company_name,
    contacts.email AS contact_email,
    contacts.phone AS contact_phone,
    contacts.address_text AS contact_address_text,
    contacts.service_area_text AS contact_service_area_text,
    contacts.status AS contact_status,
    contacts.version AS contact_version
  FROM business_customer_relationships relationships
  INNER JOIN business_contacts contacts
    ON contacts.id = relationships.business_contact_id
   AND contacts.contractor_profile_id = relationships.contractor_profile_id
  INNER JOIN contractor_profiles profiles
    ON profiles.id = relationships.contractor_profile_id`;

async function loadOwnedById(client, actorUserId, relationshipId) {
  const result = await client.query(
    `/* business_customer_relationship:load_owned */
     ${RELATIONSHIP_SELECT}
     WHERE relationships.id = $1 AND profiles.user_id = $2
     LIMIT 1`,
    [relationshipId, actorUserId]
  );
  return relationshipProjection(result.rows[0]);
}

async function loadOwnedByContact(client, actorUserId, businessContactId) {
  const result = await client.query(
    `/* business_customer_relationship:load_by_contact */
     ${RELATIONSHIP_SELECT}
     WHERE relationships.business_contact_id = $1 AND profiles.user_id = $2
     LIMIT 1`,
    [businessContactId, actorUserId]
  );
  return relationshipProjection(result.rows[0]);
}

async function reserveCommand(client, input) {
  const inserted = await client.query(
    `/* business_customer_relationship:reserve_command */
     INSERT INTO business_customer_relationship_commands (
       contractor_profile_id, actor_user_id, operation, idempotency_key,
       request_hash, business_contact_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.contractorProfileId,
      input.actorUserId,
      input.operation,
      input.key,
      input.hash,
      input.businessContactId,
    ]
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id };
  const existing = await client.query(
    `/* business_customer_relationship:load_command */
     SELECT id, contractor_profile_id, business_contact_id, request_hash, response_json
     FROM business_customer_relationship_commands
     WHERE actor_user_id = $1 AND operation = $2 AND idempotency_key = $3
     LIMIT 1`,
    [input.actorUserId, input.operation, input.key]
  );
  const row = existing.rows[0];
  if (
    !row ||
    Number(row.contractor_profile_id) !== input.contractorProfileId ||
    String(row.business_contact_id) !== input.businessContactId ||
    row.request_hash !== input.hash
  ) return { conflict: true };
  if (row.response_json) return { replay: row.response_json };
  return { pending: true };
}

async function finishCommand(client, commandId, input, relationshipId, response) {
  const result = await client.query(
    `/* business_customer_relationship:finish_command */
     UPDATE business_customer_relationship_commands
     SET business_customer_relationship_id = $2,
       response_json = $3::jsonb,
       completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND contractor_profile_id = $4 AND business_contact_id = $5`,
    [
      commandId,
      relationshipId,
      JSON.stringify(response),
      input.contractorProfileId,
      input.businessContactId,
    ]
  );
  if (result.rowCount !== 1) {
    throw new Error("The Customer Relationship command could not be completed.");
  }
}

const sqlStore = Object.freeze({
  resolveOwner,

  establish(input) {
    return withTransaction(input.pool, async (client) => {
      const ownedContact = await client.query(
        `/* business_customer_relationship:load_owned_contact */
         SELECT contacts.id
         FROM business_contacts contacts
         INNER JOIN contractor_profiles profiles
           ON profiles.id = contacts.contractor_profile_id
         WHERE contacts.id = $1
           AND contacts.contractor_profile_id = $2
           AND profiles.user_id = $3
         LIMIT 1
         FOR KEY SHARE OF contacts`,
        [input.businessContactId, input.contractorProfileId, input.actorUserId]
      );
      if (!ownedContact.rows[0]) return { kind: "not_found" };

      const reserved = await reserveCommand(client, {
        contractorProfileId: input.contractorProfileId,
        actorUserId: input.actorUserId,
        businessContactId: input.businessContactId,
        ...input.command,
      });
      if (reserved.conflict) return { kind: "idempotency_conflict" };
      if (reserved.pending) return { kind: "in_progress" };
      if (reserved.replay) return { kind: "replay", response: reserved.replay };

      const inserted = await client.query(
        `/* business_customer_relationship:establish */
         INSERT INTO business_customer_relationships (
           id, contractor_profile_id, business_contact_id, established_by_user_id
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (contractor_profile_id, business_contact_id) DO NOTHING
         RETURNING id`,
        [
          input.relationshipId,
          input.contractorProfileId,
          input.businessContactId,
          input.actorUserId,
        ]
      );
      const relationship = await loadOwnedByContact(
        client,
        input.actorUserId,
        input.businessContactId
      );
      if (!relationship) throw new Error("The Customer Relationship was not returned.");
      const response = { relationship };
      await finishCommand(client, reserved.id, input, relationship.id, response);
      return { kind: inserted.rows[0] ? "created" : "existing", response };
    });
  },

  get(pool, actorUserId, relationshipId) {
    return loadOwnedById(pool, actorUserId, relationshipId);
  },

  getByContact(pool, actorUserId, businessContactId) {
    return loadOwnedByContact(pool, actorUserId, businessContactId);
  },

  async list(pool, actorUserId, contractorProfileId, limit) {
    const result = await pool.query(
      `/* business_customer_relationship:list */
       ${RELATIONSHIP_SELECT}
       WHERE relationships.contractor_profile_id = $1
         AND profiles.user_id = $2
       ORDER BY relationships.created_at DESC, relationships.id ASC
       LIMIT $3`,
      [contractorProfileId, actorUserId, limit]
    );
    return result.rows.map(relationshipProjection);
  },
});

module.exports = {
  businessCustomerRelationshipInternals: Object.freeze({
    ESTABLISH_OPERATION,
    relationshipProjection,
    requestHash,
    sqlStore,
  }),
  establishBusinessCustomerRelationship,
  getBusinessCustomerRelationship,
  getBusinessCustomerRelationshipByContact,
  listBusinessCustomerRelationships,
};
