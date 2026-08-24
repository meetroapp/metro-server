"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  businessDocumentNumberingInternals: {
    resolveBusinessDocumentOwner,
  },
} = require("../documents/businessDocumentNumberingService");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(status, code, message, extra = {}) {
  return { ok: false, status, code, message, ...extra };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function actorId(value) {
  const id = Number(value?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeCustomerParty(value, { allowOmitted = false } = {}) {
  if (value === undefined && allowOmitted) {
    return { mode: "PRESERVE", party: null };
  }
  if (value == null) return { mode: "CLEAR", party: null };
  if (!onlyKeys(value, new Set([
    "businessContactId",
    "customerRelationshipId",
  ]))) return null;
  const businessContactId = uuid(value.businessContactId);
  const customerRelationshipId = uuid(value.customerRelationshipId);
  if (!businessContactId || !customerRelationshipId) return null;
  return {
    mode: "LINK",
    party: Object.freeze({ businessContactId, customerRelationshipId }),
  };
}

function customerPartyProjection(row) {
  if (!row?.business_contact_id || !row?.business_customer_relationship_id) {
    return null;
  }
  const value = {
    businessContactId: String(row.business_contact_id),
    customerRelationshipId: String(row.business_customer_relationship_id),
  };
  if (row.contractor_profile_id != null) {
    value.contractorProfileId = Number(row.contractor_profile_id);
  }
  if (row.job_id) value.jobId = String(row.job_id);
  if (row.created_at) value.linkedAt = new Date(row.created_at).toISOString();
  return Object.freeze(value);
}

function sameCustomerParty(left, right) {
  return Boolean(left && right) &&
    String(left.businessContactId) === String(right.businessContactId) &&
    String(left.customerRelationshipId) === String(right.customerRelationshipId) &&
    (
      left.contractorProfileId == null ||
      right.contractorProfileId == null ||
      Number(left.contractorProfileId) === Number(right.contractorProfileId)
    );
}

async function loadOwnedCustomerParty(
  client,
  { actorUserId, contractorProfileId, businessContactId, customerRelationshipId },
  { lock = false } = {}
) {
  const result = await client.query(
    `/* customer_party:load_owned */
     SELECT relationships.contractor_profile_id,
       relationships.business_contact_id,
       relationships.id AS business_customer_relationship_id
     FROM business_customer_relationships relationships
     INNER JOIN business_contacts contacts
       ON contacts.id = relationships.business_contact_id
       AND contacts.contractor_profile_id = relationships.contractor_profile_id
     INNER JOIN contractor_profiles profiles
       ON profiles.id = relationships.contractor_profile_id
       AND profiles.user_id = $1
     WHERE relationships.contractor_profile_id = $2
       AND relationships.business_contact_id = $3
       AND relationships.id = $4
     LIMIT 1 ${lock ? "FOR KEY SHARE OF relationships, contacts" : ""}`,
    [
      actorUserId,
      contractorProfileId,
      businessContactId,
      customerRelationshipId,
    ]
  );
  return customerPartyProjection(result.rows[0]);
}

async function loadJobCustomerParty(client, jobId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `/* customer_party:load_job */
     SELECT parties.*
     FROM job_customer_parties parties
     INNER JOIN contractor_profiles profiles
       ON profiles.id = parties.contractor_profile_id
       AND profiles.user_id = $2
     WHERE parties.job_id = $1
     LIMIT 1 ${lock ? "FOR KEY SHARE OF parties" : ""}`,
    [jobId, actorUserId]
  );
  return customerPartyProjection(result.rows[0]);
}

async function insertCanonicalQuoteCustomerParty(
  client,
  { quoteId, jobId, actorUserId, party }
) {
  if (!party) return null;
  const inserted = await client.query(
    `/* customer_party:insert_canonical_quote */
     INSERT INTO canonical_quote_customer_parties (
       quote_id, job_id, contractor_profile_id, business_contact_id,
       business_customer_relationship_id, linked_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (quote_id) DO NOTHING
     RETURNING *`,
    [
      quoteId,
      jobId,
      party.contractorProfileId,
      party.businessContactId,
      party.customerRelationshipId,
      actorUserId,
    ]
  );
  if (inserted.rows[0]) return customerPartyProjection(inserted.rows[0]);
  const existing = await client.query(
    `/* customer_party:load_canonical_quote */
     SELECT * FROM canonical_quote_customer_parties WHERE quote_id = $1 LIMIT 1`,
    [quoteId]
  );
  const projected = customerPartyProjection(existing.rows[0]);
  if (!sameCustomerParty(projected, party)) {
    throw new Error("Canonical Quote customer party identity conflict.");
  }
  return projected;
}

async function loadCanonicalQuoteCustomerParty(client, quoteId) {
  const result = await client.query(
    `/* customer_party:load_canonical_quote */
     SELECT * FROM canonical_quote_customer_parties WHERE quote_id = $1 LIMIT 1`,
    [quoteId]
  );
  return customerPartyProjection(result.rows[0]);
}

function resolveInvoiceCustomerParty({ jobParty = null, quoteParties = [] } = {}) {
  const normalized = quoteParties
    .filter((item) => item?.party)
    .map((item) => ({ sourceQuoteId: item.sourceQuoteId, party: item.party }));
  const distinct = [];
  for (const item of normalized) {
    if (!distinct.some((candidate) => sameCustomerParty(candidate.party, item.party))) {
      distinct.push(item);
    }
  }
  if (distinct.length > 1) return { error: "CUSTOMER_PARTY_SOURCE_CONFLICT" };
  const quoteSource = distinct[0] || null;
  if (jobParty && quoteSource && !sameCustomerParty(jobParty, quoteSource.party)) {
    return { error: "CUSTOMER_PARTY_SOURCE_CONFLICT" };
  }
  if (jobParty) return { party: jobParty, sourceType: "JOB", sourceQuoteId: null };
  if (quoteSource) {
    return {
      party: quoteSource.party,
      sourceType: "CANONICAL_QUOTE",
      sourceQuoteId: quoteSource.sourceQuoteId,
    };
  }
  return { party: null, sourceType: null, sourceQuoteId: null };
}

async function insertCanonicalInvoiceCustomerParty(
  client,
  { invoiceId, jobId, actorUserId, source }
) {
  if (!source?.party) return null;
  const result = await client.query(
    `/* customer_party:insert_canonical_invoice */
     INSERT INTO canonical_invoice_customer_parties (
       invoice_id, job_id, contractor_profile_id, business_contact_id,
       business_customer_relationship_id, linked_by_user_id,
       source_type, source_quote_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      invoiceId,
      jobId,
      source.party.contractorProfileId,
      source.party.businessContactId,
      source.party.customerRelationshipId,
      actorUserId,
      source.sourceType,
      source.sourceQuoteId,
    ]
  );
  return customerPartyProjection(result.rows[0]);
}

async function withTransaction(pool, action) {
  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  if (!client || typeof client.query !== "function") {
    throw new TypeError("A database pool is required.");
  }
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

async function reserveJobCommand(client, input) {
  const inserted = await client.query(
    `/* customer_party:reserve_job_command */
     INSERT INTO job_customer_party_commands (
       id, contractor_profile_id, actor_user_id, operation,
       idempotency_key, request_hash, job_id,
       business_contact_id, business_customer_relationship_id
     ) VALUES ($1, $2, $3, 'LINK', $4, $5, $6, $7, $8)
     ON CONFLICT (actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.commandId,
      input.contractorProfileId,
      input.actorUserId,
      input.idempotencyKey,
      input.requestHash,
      input.jobId,
      input.party.businessContactId,
      input.party.customerRelationshipId,
    ]
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, fresh: true };
  const existing = await client.query(
    `/* customer_party:load_job_command */
     SELECT id, request_hash, response_json
     FROM job_customer_party_commands
     WHERE actor_user_id = $1 AND operation = 'LINK' AND idempotency_key = $2
     LIMIT 1 FOR UPDATE`,
    [input.actorUserId, input.idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== input.requestHash) return { conflict: true };
  if (!row.response_json) return { pending: true };
  return { replay: row.response_json };
}

const sqlStore = Object.freeze({
  link(input) {
    return withTransaction(input.pool, async (client) => {
      const owner = await resolveBusinessDocumentOwner(
        client,
        input.actorUserId,
        input.jobId
      );
      if (owner.kind !== "resolved") return { kind: "authority_denied" };
      const party = await loadOwnedCustomerParty(client, {
        actorUserId: input.actorUserId,
        contractorProfileId: owner.contractorProfileId,
        businessContactId: input.party.businessContactId,
        customerRelationshipId: input.party.customerRelationshipId,
      }, { lock: true });
      if (!party) return { kind: "party_unavailable" };
      const reserved = await reserveJobCommand(client, {
        ...input,
        contractorProfileId: owner.contractorProfileId,
        party,
      });
      if (reserved.conflict) return { kind: "idempotency_conflict" };
      if (reserved.pending) return { kind: "in_progress" };
      if (reserved.replay) return { kind: "replay", customerParty: reserved.replay };
      const inserted = await client.query(
        `/* customer_party:link_job */
         INSERT INTO job_customer_parties (
           job_id, contractor_profile_id, business_contact_id,
           business_customer_relationship_id, linked_by_user_id
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (job_id) DO NOTHING
         RETURNING *`,
        [
          input.jobId,
          owner.contractorProfileId,
          party.businessContactId,
          party.customerRelationshipId,
          input.actorUserId,
        ]
      );
      const linked = inserted.rows[0]
        ? customerPartyProjection(inserted.rows[0])
        : await loadJobCustomerParty(client, input.jobId, input.actorUserId, {
            lock: true,
          });
      if (!sameCustomerParty(linked, party)) {
        await client.query(
          "DELETE FROM job_customer_party_commands WHERE id = $1",
          [reserved.id]
        );
        return { kind: "link_conflict" };
      }
      await client.query(
        `/* customer_party:finish_job_command */
         UPDATE job_customer_party_commands
         SET response_json = $2::jsonb, completed_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [reserved.id, JSON.stringify(linked)]
      );
      return {
        kind: inserted.rows[0] ? "linked" : "existing",
        customerParty: linked,
      };
    });
  },
  get({ pool, actorUserId, jobId }) {
    return loadJobCustomerParty(pool, jobId, actorUserId);
  },
});

async function linkJobCustomerParty(input = {}) {
  if (!onlyKeys(input, new Set([
    "pool",
    "authenticatedActor",
    "jobId",
    "payload",
    "idempotencyKey",
    "store",
    "idFactory",
  ]))) return failure(400, "CUSTOMER_PARTY_FIELD_REJECTED", "The customer link request is invalid.");
  const userId = actorId(input.authenticatedActor);
  if (!userId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  const jobId = uuid(input.jobId);
  const idempotencyKey = uuid(input.idempotencyKey);
  const normalized = normalizeCustomerParty(input.payload);
  if (!jobId || !idempotencyKey || !normalized || normalized.mode !== "LINK") {
    return failure(400, "CUSTOMER_PARTY_INVALID", "Select a valid Contact and Customer Relationship.");
  }
  const requestHash = hash({
    operation: "LINK",
    actorUserId: userId,
    jobId,
    ...normalized.party,
  });
  const result = await (input.store || sqlStore).link({
    pool: input.pool,
    actorUserId: userId,
    jobId,
    party: normalized.party,
    idempotencyKey,
    requestHash,
    commandId: (input.idFactory || randomUUID)(),
  });
  if (result.kind === "authority_denied") {
    return failure(403, "CUSTOMER_PARTY_JOB_AUTHORITY_DENIED", "The Job is unavailable to this business.");
  }
  if (result.kind === "party_unavailable") {
    return failure(404, "CUSTOMER_PARTY_UNAVAILABLE", "The selected Contact and Customer Relationship are unavailable.");
  }
  if (result.kind === "idempotency_conflict") {
    return failure(409, "CUSTOMER_PARTY_IDEMPOTENCY_CONFLICT", "The save identity was already used for different customer linkage.");
  }
  if (result.kind === "in_progress") {
    return failure(409, "CUSTOMER_PARTY_LINK_IN_PROGRESS", "This customer linkage is already in progress.");
  }
  if (result.kind === "link_conflict") {
    return failure(409, "CUSTOMER_PARTY_ALREADY_LINKED", "This Job already belongs to a different durable customer.");
  }
  return {
    ok: true,
    status: result.kind === "linked" ? 201 : 200,
    code: result.kind === "replay"
      ? "JOB_CUSTOMER_PARTY_LINK_REPLAYED"
      : result.kind === "linked"
        ? "JOB_CUSTOMER_PARTY_LINKED"
        : "JOB_CUSTOMER_PARTY_ALREADY_LINKED",
    customerParty: result.customerParty,
    replayed: result.kind === "replay",
  };
}

async function getJobCustomerParty(input = {}) {
  if (!onlyKeys(input, new Set([
    "pool",
    "authenticatedActor",
    "jobId",
    "store",
  ]))) return failure(400, "CUSTOMER_PARTY_FIELD_REJECTED", "The customer link request is invalid.");
  const userId = actorId(input.authenticatedActor);
  if (!userId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  const jobId = uuid(input.jobId);
  if (!jobId) return failure(400, "CUSTOMER_PARTY_JOB_INVALID", "A valid Job is required.");
  const customerParty = await (input.store || sqlStore).get({
    pool: input.pool,
    actorUserId: userId,
    jobId,
  });
  return customerParty
    ? {
        ok: true,
        status: 200,
        code: "JOB_CUSTOMER_PARTY_FOUND",
        customerParty,
      }
    : failure(404, "JOB_CUSTOMER_PARTY_NOT_FOUND", "The Job customer link was not found.");
}

module.exports = {
  getJobCustomerParty,
  linkJobCustomerParty,
  customerPartyInternals: Object.freeze({
    customerPartyProjection,
    hash,
    insertCanonicalInvoiceCustomerParty,
    insertCanonicalQuoteCustomerParty,
    loadCanonicalQuoteCustomerParty,
    loadJobCustomerParty,
    loadOwnedCustomerParty,
    normalizeCustomerParty,
    resolveInvoiceCustomerParty,
    sameCustomerParty,
    sqlStore,
  }),
};

