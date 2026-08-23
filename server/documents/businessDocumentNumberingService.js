"use strict";

const DOCUMENT_TYPES = Object.freeze(["QUOTE", "INVOICE"]);
const INITIALIZATION_MODES = Object.freeze(["START_NEW", "CONTINUE_EXISTING"]);
const INITIALIZATION_SOURCE = "PROFESSIONAL_EXPLICIT";
const DEFAULTS = Object.freeze({
  QUOTE: Object.freeze({ prefix: "Q", width: 7 }),
  INVOICE: Object.freeze({ prefix: "INV", width: 7 }),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX_PATTERN = /^[A-Z]{1,8}$/;
const PREVIOUS_NUMBER_PATTERN = /^([A-Z]{1,8})-([0-9]{1,12})$/i;
const MAX_SEQUENCE_NUMBER = 999999999999;

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

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizedDocumentType(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return DOCUMENT_TYPES.includes(normalized) ? normalized : null;
}

function formatDocumentNumber(prefix, width, sequence) {
  const normalizedPrefix = String(prefix || "").trim().toUpperCase();
  const normalizedWidth = Number(width);
  const normalizedSequence = Number(sequence);
  if (
    !PREFIX_PATTERN.test(normalizedPrefix) ||
    !Number.isSafeInteger(normalizedWidth) ||
    normalizedWidth < 1 ||
    normalizedWidth > 12 ||
    !Number.isSafeInteger(normalizedSequence) ||
    normalizedSequence < 0 ||
    normalizedSequence > MAX_SEQUENCE_NUMBER
  ) {
    throw new TypeError("A valid business-document number sequence is required.");
  }
  const suffix = String(normalizedSequence);
  if (suffix.length > 12) {
    throw new TypeError("The business-document number sequence is exhausted.");
  }
  return `${normalizedPrefix}-${suffix.padStart(normalizedWidth, "0")}`;
}

function parsePreviousDocumentNumber(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  const match = normalized.match(PREVIOUS_NUMBER_PATTERN);
  if (!match) return null;
  const lastNumber = Number(match[2]);
  if (!Number.isSafeInteger(lastNumber) || lastNumber < 0 || lastNumber > MAX_SEQUENCE_NUMBER) {
    return null;
  }
  return Object.freeze({
    prefix: match[1],
    width: match[2].length,
    lastNumber,
    previousDocumentNumber: `${match[1]}-${match[2]}`,
  });
}

function requestedConfiguration(documentType, mode, previousDocumentNumber) {
  if (mode === "START_NEW") {
    const defaults = DEFAULTS[documentType];
    return Object.freeze({
      prefix: defaults.prefix,
      width: defaults.width,
      initialLastNumber: 0,
      mode,
      source: INITIALIZATION_SOURCE,
    });
  }
  const previous = parsePreviousDocumentNumber(previousDocumentNumber);
  if (!previous) return null;
  return Object.freeze({
    prefix: previous.prefix,
    width: previous.width,
    initialLastNumber: previous.lastNumber,
    mode,
    source: INITIALIZATION_SOURCE,
  });
}

function sequenceProjection(row, documentType) {
  if (!row) {
    return Object.freeze({ initialized: false, documentType });
  }
  const lastNumber = Number(row.last_number);
  const nextNumberPreview = lastNumber < MAX_SEQUENCE_NUMBER
    ? formatDocumentNumber(row.number_prefix, Number(row.number_width), lastNumber + 1)
    : null;
  return Object.freeze({
    initialized: true,
    documentType,
    prefix: row.number_prefix,
    width: Number(row.number_width),
    lastNumber,
    nextNumberPreview,
    initializationMode: row.initialization_mode,
    initializedAt: new Date(row.initialized_at).toISOString(),
    firstAllocatedAt: row.first_allocated_at
      ? new Date(row.first_allocated_at).toISOString()
      : null,
  });
}

function ownerFailure(result) {
  if (result?.kind === "profile_required") {
    return failure(403, "BUSINESS_DOCUMENT_AUTHORITY_REQUIRED", "A professional business profile is required.");
  }
  if (result?.kind === "profile_ambiguous") {
    return failure(409, "BUSINESS_DOCUMENT_PROFILE_AMBIGUOUS", "Select a Job to identify which business owns this document.");
  }
  return failure(409, "BUSINESS_DOCUMENT_JOB_CONFLICT", "The selected Job is not available to this professional.");
}

async function withTransaction(pool, action) {
  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  if (!client || typeof client.query !== "function") {
    throw new TypeError("A database pool or client is required.");
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

async function resolveBusinessDocumentOwner(client, actorUserId, jobId = null) {
  if (jobId) {
    const result = await client.query(
      `/* business_document_numbering:job_owner */
       SELECT DISTINCT relationships.contractor_id AS contractor_profile_id
       FROM jobs
       INNER JOIN request_relationships relationships
         ON relationships.id = jobs.source_request_relationship_id
        AND relationships.professional_user_id = $1
        AND relationships.status = 'active'
       INNER JOIN contractor_profiles profiles
         ON profiles.id = relationships.contractor_id
        AND profiles.user_id = $1
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
       WHERE jobs.id = $2
         AND revocations.id IS NULL
       LIMIT 2`,
      [actorUserId, jobId]
    );
    return result.rows.length === 1
      ? { kind: "resolved", contractorProfileId: Number(result.rows[0].contractor_profile_id) }
      : { kind: "job_unavailable" };
  }

  const result = await client.query(
    `/* business_document_numbering:profile_owner */
     SELECT profiles.id AS contractor_profile_id
     FROM users
     INNER JOIN contractor_profiles profiles ON profiles.user_id = users.id
     WHERE users.id = $1 AND users.account_type = 'professional'
     ORDER BY profiles.id ASC
     LIMIT 2`,
    [actorUserId]
  );
  if (result.rows.length === 0) return { kind: "profile_required" };
  if (result.rows.length > 1) return { kind: "profile_ambiguous" };
  return { kind: "resolved", contractorProfileId: Number(result.rows[0].contractor_profile_id) };
}

async function readSequence(client, contractorProfileId, documentType, { lock = false } = {}) {
  const result = await client.query(
    `/* business_document_numbering:read */
     SELECT contractor_profile_id, document_type, number_prefix, number_width,
            initial_last_number, last_number, initialization_mode,
            initialization_source, initialized_at, initialized_by_user_id,
            first_allocated_at, updated_at
     FROM business_document_number_sequences
     WHERE contractor_profile_id = $1 AND document_type = $2
     ${lock ? "FOR UPDATE" : ""}`,
    [contractorProfileId, documentType]
  );
  return result.rows[0] || null;
}

function sameConfiguration(row, configuration) {
  return Boolean(row) &&
    row.number_prefix === configuration.prefix &&
    Number(row.number_width) === configuration.width &&
    Number(row.initial_last_number) === configuration.initialLastNumber &&
    row.initialization_mode === configuration.mode &&
    row.initialization_source === configuration.source;
}

async function allocateDocumentNumber(client, contractorProfileId, documentType) {
  const result = await client.query(
    `/* business_document_numbering:allocate */
     UPDATE business_document_number_sequences
     SET last_number = last_number + 1,
         first_allocated_at = COALESCE(first_allocated_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE contractor_profile_id = $1
       AND document_type = $2
       AND last_number < 999999999999
     RETURNING number_prefix, number_width, last_number`,
    [contractorProfileId, documentType]
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await readSequence(client, contractorProfileId, documentType);
    return existing ? { kind: "exhausted" } : { kind: "setup_required" };
  }
  return {
    kind: "allocated",
    documentNumber: formatDocumentNumber(
      row.number_prefix,
      Number(row.number_width),
      Number(row.last_number)
    ),
  };
}

const sqlNumberingStore = Object.freeze({
  resolveBusinessOwner(pool, actorUserId, jobId) {
    return resolveBusinessDocumentOwner(pool, actorUserId, jobId);
  },
  async getState({ pool, contractorProfileId, documentType }) {
    return readSequence(pool, contractorProfileId, documentType);
  },
  initialize({ pool, actorUserId, contractorProfileId, documentType, jobId, configuration }) {
    return withTransaction(pool, async (client) => {
      const owner = await resolveBusinessDocumentOwner(client, actorUserId, jobId);
      if (owner.kind !== "resolved" || owner.contractorProfileId !== contractorProfileId) {
        return owner.kind === "resolved" ? { kind: "job_unavailable" } : owner;
      }
      const existing = await readSequence(client, contractorProfileId, documentType, { lock: true });
      if (existing) {
        return sameConfiguration(existing, configuration)
          ? { kind: "existing", row: existing }
          : { kind: "configuration_conflict" };
      }
      const inserted = await client.query(
        `/* business_document_numbering:initialize */
         INSERT INTO business_document_number_sequences (
           contractor_profile_id, document_type, number_prefix, number_width,
           initial_last_number, last_number, initialization_mode,
           initialization_source, initialized_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)
         ON CONFLICT (contractor_profile_id, document_type) DO NOTHING
         RETURNING contractor_profile_id, document_type, number_prefix,
                   number_width, initial_last_number, last_number,
                   initialization_mode, initialization_source, initialized_at,
                   initialized_by_user_id, first_allocated_at, updated_at`,
        [
          contractorProfileId,
          documentType,
          configuration.prefix,
          configuration.width,
          configuration.initialLastNumber,
          configuration.mode,
          configuration.source,
          actorUserId,
        ]
      );
      if (inserted.rows[0]) return { kind: "initialized", row: inserted.rows[0] };
      const raced = await readSequence(client, contractorProfileId, documentType, { lock: true });
      return sameConfiguration(raced, configuration)
        ? { kind: "existing", row: raced }
        : { kind: "configuration_conflict" };
    });
  },
});

function validatedReadInput(input) {
  const allowed = new Set(["pool", "authenticatedActor", "query", "store"]);
  if (!onlyKeys(input, allowed)) {
    return { error: failure(400, "BUSINESS_DOCUMENT_NUMBERING_FIELD_REJECTED", "The numbering request is invalid.") };
  }
  const id = actorId(input.authenticatedActor);
  if (!id) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  const query = input.query || {};
  if (!onlyKeys(query, new Set(["documentType", "jobId"]))) {
    return { error: failure(400, "BUSINESS_DOCUMENT_NUMBERING_FIELD_REJECTED", "The numbering request is invalid.") };
  }
  const documentType = normalizedDocumentType(query.documentType);
  const hasJobId = query.jobId !== undefined && query.jobId !== null && String(query.jobId).trim() !== "";
  const jobId = hasJobId ? uuid(query.jobId) : null;
  if (!documentType || (hasJobId && !jobId)) {
    return { error: failure(400, "BUSINESS_DOCUMENT_NUMBERING_INVALID", "The numbering request is invalid.") };
  }
  return { actorId: id, documentType, jobId };
}

function validatedInitializeInput(input) {
  const allowed = new Set(["pool", "authenticatedActor", "payload", "store"]);
  if (!onlyKeys(input, allowed)) {
    return { error: failure(400, "BUSINESS_DOCUMENT_NUMBERING_FIELD_REJECTED", "The numbering request is invalid.") };
  }
  const base = validatedReadInput({
    pool: input.pool,
    authenticatedActor: input.authenticatedActor,
    query: {
      documentType: input.payload?.documentType,
      jobId: input.payload?.jobId,
    },
    store: input.store,
  });
  if (base.error) return base;
  if (!onlyKeys(input.payload, new Set(["documentType", "jobId", "mode", "previousDocumentNumber"]))) {
    return { error: failure(400, "BUSINESS_DOCUMENT_NUMBERING_FIELD_REJECTED", "The numbering request is invalid.") };
  }
  const mode = String(input.payload.mode || "").trim().toUpperCase();
  if (!INITIALIZATION_MODES.includes(mode)) {
    return { error: failure(400, "BUSINESS_DOCUMENT_NUMBERING_INVALID", "A valid numbering initialization mode is required.") };
  }
  if (mode === "START_NEW" && Object.hasOwn(input.payload, "previousDocumentNumber") && input.payload.previousDocumentNumber != null && input.payload.previousDocumentNumber !== "") {
    return { error: failure(400, "BUSINESS_DOCUMENT_NUMBERING_INVALID", "A previous number is only valid when continuing an existing sequence.") };
  }
  const configuration = requestedConfiguration(
    base.documentType,
    mode,
    input.payload.previousDocumentNumber
  );
  if (!configuration) {
    return { error: failure(400, "BUSINESS_DOCUMENT_PREVIOUS_NUMBER_INVALID", "The previous business-document number is invalid.") };
  }
  return { ...base, configuration };
}

async function getBusinessDocumentNumbering(input = {}) {
  const validated = validatedReadInput(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlNumberingStore;
  const owner = await store.resolveBusinessOwner(
    input.pool,
    validated.actorId,
    validated.jobId
  );
  if (owner.kind !== "resolved") return ownerFailure(owner);
  const row = await store.getState({
    pool: input.pool,
    contractorProfileId: owner.contractorProfileId,
    documentType: validated.documentType,
  });
  return {
    ok: true,
    status: 200,
    code: "BUSINESS_DOCUMENT_NUMBERING_LOADED",
    numbering: sequenceProjection(row, validated.documentType),
  };
}

async function initializeBusinessDocumentNumbering(input = {}) {
  const validated = validatedInitializeInput(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlNumberingStore;
  const owner = await store.resolveBusinessOwner(
    input.pool,
    validated.actorId,
    validated.jobId
  );
  if (owner.kind !== "resolved") return ownerFailure(owner);
  const result = await store.initialize({
    pool: input.pool,
    actorUserId: validated.actorId,
    contractorProfileId: owner.contractorProfileId,
    documentType: validated.documentType,
    jobId: validated.jobId,
    configuration: validated.configuration,
  });
  if (result.kind === "configuration_conflict") {
    return failure(409, "BUSINESS_DOCUMENT_NUMBERING_ALREADY_INITIALIZED", "This business-document sequence is already initialized with a different configuration.");
  }
  if (result.kind !== "initialized" && result.kind !== "existing") {
    return ownerFailure(result);
  }
  return {
    ok: true,
    status: result.kind === "initialized" ? 201 : 200,
    code: result.kind === "initialized"
      ? "BUSINESS_DOCUMENT_NUMBERING_INITIALIZED"
      : "BUSINESS_DOCUMENT_NUMBERING_ALREADY_INITIALIZED",
    numbering: sequenceProjection(result.row, validated.documentType),
  };
}

module.exports = {
  getBusinessDocumentNumbering,
  initializeBusinessDocumentNumbering,
  businessDocumentNumberingInternals: {
    DEFAULTS,
    DOCUMENT_TYPES,
    INITIALIZATION_MODES,
    INITIALIZATION_SOURCE,
    MAX_SEQUENCE_NUMBER,
    allocateDocumentNumber,
    formatDocumentNumber,
    ownerFailure,
    parsePreviousDocumentNumber,
    requestedConfiguration,
    resolveBusinessDocumentOwner,
    sameConfiguration,
    sequenceProjection,
    sqlNumberingStore,
    validatedInitializeInput,
    validatedReadInput,
    withTransaction,
  },
};
