"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  AUTHORITY_SOURCE,
  OWNING_ENGINE,
  TRACEABILITY,
  commercialAuthorityInternals,
} = require("./commercialAuthorityService");
const {
  hasActiveLifecycleGrant,
} = require("./lifecycleAuthorityService");

const {
  completeIdempotency,
  databaseClient,
  failure,
  fingerprint,
  isPlainObject,
  normalizedUuid,
  positiveInteger,
  reserveIdempotency,
  rollback,
  validateAuthenticatedActor,
  validateIdempotencyKey,
} = commercialAuthorityInternals;

const QUOTE_STATUS = Object.freeze({ DRAFT: "DRAFT", ISSUED: "ISSUED" });
const QUOTE_CAPABILITIES = Object.freeze({
  CREATE: "quote.create",
  READ: "quote.read",
  SCOPE_MANAGE: "quote.scope.manage",
  ISSUE: "quote.issue",
  READ_CUSTOMER: "quote.read_customer",
  APPROVE: "quote.approve",
  DECLINE: "quote.decline",
  REVISE: "quote.revise",
});
const QUOTE_COMMANDS = Object.freeze({
  CREATE: "quote.draft.create",
  SCOPE_ADD: "quote.scope.add",
  SCOPE_REMOVE: "quote.scope.remove",
  ISSUE: "quote.issue",
  APPROVE: "quote.customer.approve",
  DECLINE: "quote.customer.decline",
  REVISE: "quote.revision.create",
});
const QUOTE_EVIDENCE_TYPES = Object.freeze({
  CREATED: "quote_draft_created",
  SCOPE_ADDED: "quote_scope_item_added",
  SCOPE_REMOVED: "quote_scope_item_removed",
  ISSUED: "quote_issued",
  REVISION_CREATED: "quote_revision_created",
});
const CAPABILITY_MILESTONE_ID = "MC-JOB-LIFECYCLE-004F-A";
const ISSUE_CAPABILITY_MILESTONE_ID = "MC-JOB-LIFECYCLE-004F-B";
const CUSTOMER_CAPABILITY_MILESTONE_ID = "MC-JOB-LIFECYCLE-004F-C";
const QUOTE_DECISIONS = Object.freeze(["APPROVED", "DECLINED"]);
const QUOTE_LINEAGE_TYPES = Object.freeze(["REVISED_QUOTE", "SUPPLEMENTAL_QUOTE"]);
const QUOTE_LINEAGE_REASONS = Object.freeze([
  "SCOPE_CHANGE",
  "PRICING_CHANGE",
  "CUSTOMER_DECLINED",
  "SUPPLEMENTAL_WORK",
  "OTHER",
]);
const CLASSIFICATIONS = Object.freeze(["MATERIAL", "LABOR_SERVICE"]);
const SCOPE_SEMANTICS = Object.freeze([
  "COMPLETED_BILLABLE_SERVICE",
  "TEMPORARY_SERVICE",
  "FUTURE_WORK",
  "MATERIAL_INCLUDED",
  "MATERIAL_EXCLUDED",
  "CUSTOMER_SUPPLIED_MATERIAL",
  "SEPARATE_PROPOSAL",
]);
const MATERIAL_RESPONSIBILITIES = Object.freeze([
  "PROFESSIONAL_SUPPLIED",
  "CUSTOMER_SUPPLIED",
  "EXCLUDED",
  "PENDING_SELECTION",
  "NOT_APPLICABLE",
]);
const SOURCE_TYPES = Object.freeze([
  "FINDING",
  "RECOMMENDATION",
  "WORKSTREAM",
  "WORK_ACTIVITY",
  "WORKSTREAM_OBLIGATION",
  "MANUAL_PROFESSIONAL",
]);
const MAX_MINOR_AMOUNT = 9_000_000_000_000;
const MAX_QUANTITY = 10_000;
const QUOTE_INTEGRITY_VERSION_V1 = 1;
const QUOTE_INTEGRITY_VERSION_V2 = 2;
const CUSTOMER_TERMS_SCHEMA_VERSION = 1;
const CUSTOMER_TERMS_TEXT_LIMITS = Object.freeze({
  paymentTerms: 8000,
  estimatedDuration: 240,
  customerNotes: 8000,
});
const CUSTOMER_AGREEMENT_TEXT_LIMITS = Object.freeze({
  additionalWorkTerms: 8000,
  hiddenConditionsTerms: 8000,
  diagnosticTerms: 8000,
  customerResponsibilities: 8000,
  warrantyTerms: 8000,
  cancellationTerms: 8000,
  acceptanceTerms: 8000,
  preauthorizedAdditionalWorkLimit: 240,
});

function safeLogger(logger) {
  return logger && typeof logger.info === "function" && typeof logger.warn === "function"
    ? logger
    : console;
}

function validateInput(input, allowedFields) {
  if (!isPlainObject(input)) {
    return failure(400, "INVALID_QUOTE_COMMAND", "The Quote command is invalid.");
  }
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    "idempotencyKey",
    "logger",
    "failureInjector",
    ...allowedFields,
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return failure(
      400,
      "QUOTE_AUTHORITY_FIELD_REJECTED",
      "Server-owned Quote fields cannot be supplied."
    );
  }
  return null;
}

function validateCommand(input, allowedFields) {
  const inputError = validateInput(input, allowedFields);
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  return { actorId: actor.id, idempotencyKey: idempotency.idempotencyKey };
}

function validateRead(input, allowedFields) {
  const inputError = validateInput(input, allowedFields);
  if (inputError) return { error: inputError };
  return validateAuthenticatedActor(input.authenticatedActor);
}

function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function safeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_MINOR_AMOUNT
    ? parsed
    : null;
}

function safeQuantity(value) {
  const parsed = value == null ? 1 : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_QUANTITY
    ? parsed
    : null;
}

function validateCurrency(value) {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizedCustomerTermText(value, maximum) {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : null;
}

function normalizeCustomerTermsSnapshot(value) {
  if (!isPlainObject(value)) return { error: "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT" };
  const allowed = new Set([
    "schemaVersion",
    "paymentTerms",
    "estimatedDuration",
    "customerNotes",
    "agreement",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.schemaVersion !== CUSTOMER_TERMS_SCHEMA_VERSION ||
    !isPlainObject(value.agreement)
  ) {
    return { error: "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT" };
  }
  const agreementAllowed = new Set([
    "exclusions",
    ...Object.keys(CUSTOMER_AGREEMENT_TEXT_LIMITS),
  ]);
  if (Object.keys(value.agreement).some((key) => !agreementAllowed.has(key))) {
    return { error: "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT" };
  }
  const normalized = { schemaVersion: CUSTOMER_TERMS_SCHEMA_VERSION };
  for (const [key, maximum] of Object.entries(CUSTOMER_TERMS_TEXT_LIMITS)) {
    const text = normalizedCustomerTermText(value[key], maximum);
    if (text == null) return { error: "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT" };
    normalized[key] = text;
  }
  const exclusions = value.agreement.exclusions === undefined
    ? []
    : value.agreement.exclusions;
  if (!Array.isArray(exclusions) || exclusions.length > 100) {
    return { error: "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT" };
  }
  normalized.agreement = { exclusions: [] };
  for (const exclusion of exclusions) {
    const text = normalizedCustomerTermText(exclusion, 3000);
    if (!text) return { error: "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT" };
    normalized.agreement.exclusions.push(text);
  }
  for (const [key, maximum] of Object.entries(CUSTOMER_AGREEMENT_TEXT_LIMITS)) {
    const text = normalizedCustomerTermText(value.agreement[key], maximum);
    if (text == null) return { error: "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT" };
    normalized.agreement[key] = text;
  }
  return { snapshot: normalized };
}

function quoteIntegrityContract(integrityVersion, customerTermsSnapshot) {
  const version = Number(integrityVersion || QUOTE_INTEGRITY_VERSION_V1);
  if (version === QUOTE_INTEGRITY_VERSION_V1 && customerTermsSnapshot == null) {
    return { integrityVersion: version, customerTermsSnapshot: null };
  }
  if (version === QUOTE_INTEGRITY_VERSION_V2) {
    const normalized = normalizeCustomerTermsSnapshot(customerTermsSnapshot);
    if (!normalized.error) {
      return {
        integrityVersion: version,
        customerTermsSnapshot: normalized.snapshot,
      };
    }
  }
  return { error: "INVALID_QUOTE_INTEGRITY_CONTRACT" };
}

function validateSource(value) {
  if (!isPlainObject(value)) return { error: "INVALID_QUOTE_SOURCE" };
  const type = String(value.type || "").trim().toUpperCase();
  if (!SOURCE_TYPES.includes(type)) return { error: "INVALID_QUOTE_SOURCE" };
  const allowedByType = {
    MANUAL_PROFESSIONAL: new Set(["type"]),
    FINDING: new Set(["type", "findingId", "version"]),
    RECOMMENDATION: new Set(["type", "recommendationId", "version"]),
    WORKSTREAM: new Set(["type", "workstreamId", "version"]),
    WORK_ACTIVITY: new Set(["type", "workstreamId", "activityId", "version"]),
    WORKSTREAM_OBLIGATION: new Set([
      "type",
      "workstreamId",
      "obligationId",
      "version",
    ]),
  };
  if (Object.keys(value).some((key) => !allowedByType[type].has(key))) {
    return { error: "INVALID_QUOTE_SOURCE" };
  }
  if (type === "MANUAL_PROFESSIONAL") return { source: { type } };

  const version = positiveInteger(value.version);
  if (!version) return { error: "INVALID_QUOTE_SOURCE" };
  const idField = {
    FINDING: "findingId",
    RECOMMENDATION: "recommendationId",
    WORKSTREAM: "workstreamId",
    WORK_ACTIVITY: "activityId",
    WORKSTREAM_OBLIGATION: "obligationId",
  }[type];
  const id = normalizedUuid(value[idField]);
  if (!id) return { error: "INVALID_QUOTE_SOURCE" };
  const source = { type, version, [idField]: id };
  if (["WORK_ACTIVITY", "WORKSTREAM_OBLIGATION"].includes(type)) {
    const workstreamId = normalizedUuid(value.workstreamId);
    if (!workstreamId) return { error: "INVALID_QUOTE_SOURCE" };
    source.workstreamId = workstreamId;
  }
  return { source };
}

function commercialShape({ classification, scopeSemantic, materialResponsibility }) {
  if (classification === "MATERIAL") {
    if (
      scopeSemantic === "MATERIAL_INCLUDED" &&
      materialResponsibility === "PROFESSIONAL_SUPPLIED"
    ) {
      return { includedInTotal: true };
    }
    if (
      scopeSemantic === "CUSTOMER_SUPPLIED_MATERIAL" &&
      materialResponsibility === "CUSTOMER_SUPPLIED"
    ) {
      return { includedInTotal: false };
    }
    if (
      scopeSemantic === "MATERIAL_EXCLUDED" &&
      ["EXCLUDED", "PENDING_SELECTION"].includes(materialResponsibility)
    ) {
      return { includedInTotal: false };
    }
    if (
      scopeSemantic === "SEPARATE_PROPOSAL" &&
      ["EXCLUDED", "PENDING_SELECTION"].includes(materialResponsibility)
    ) {
      return { includedInTotal: false };
    }
    return null;
  }
  if (
    classification === "LABOR_SERVICE" &&
    materialResponsibility === "NOT_APPLICABLE" &&
    [
      "COMPLETED_BILLABLE_SERVICE",
      "TEMPORARY_SERVICE",
      "FUTURE_WORK",
      "SEPARATE_PROPOSAL",
    ].includes(scopeSemantic)
  ) {
    return { includedInTotal: scopeSemantic !== "SEPARATE_PROPOSAL" };
  }
  return null;
}

function validateScopeItem(value) {
  if (!isPlainObject(value)) {
    return { error: failure(400, "INVALID_QUOTE_SCOPE_ITEM", "The Quote Scope Item is invalid.") };
  }
  const allowed = new Set([
    "classification",
    "scopeSemantic",
    "materialResponsibility",
    "description",
    "quantity",
    "unitAmountMinor",
    "source",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return {
      error: failure(
        400,
        "QUOTE_AUTHORITY_FIELD_REJECTED",
        "Server-owned Quote totals and Scope Item fields cannot be supplied."
      ),
    };
  }
  const classification = String(value.classification || "").trim().toUpperCase();
  const scopeSemantic = String(value.scopeSemantic || "").trim().toUpperCase();
  const materialResponsibility = String(value.materialResponsibility || "")
    .trim()
    .toUpperCase();
  const description = boundedText(value.description, 1000);
  const quantity = safeQuantity(value.quantity);
  const unitAmountMinor = safeNonNegativeInteger(value.unitAmountMinor);
  const source = validateSource(value.source);
  const shape = commercialShape({
    classification,
    scopeSemantic,
    materialResponsibility,
  });
  if (
    !CLASSIFICATIONS.includes(classification) ||
    !SCOPE_SEMANTICS.includes(scopeSemantic) ||
    !MATERIAL_RESPONSIBILITIES.includes(materialResponsibility) ||
    !description ||
    !quantity ||
    unitAmountMinor == null ||
    source.error ||
    !shape
  ) {
    return { error: failure(400, "INVALID_QUOTE_SCOPE_ITEM", "The Quote Scope Item is invalid.") };
  }
  const lineTotalMinor = quantity * unitAmountMinor;
  if (!Number.isSafeInteger(lineTotalMinor) || lineTotalMinor > MAX_MINOR_AMOUNT) {
    return { error: failure(400, "INVALID_QUOTE_AMOUNT", "The Quote amount is invalid.") };
  }
  return {
    item: {
      classification,
      scopeSemantic,
      materialResponsibility,
      description,
      quantity,
      unitAmountMinor,
      lineTotalMinor,
      includedInTotal: shape.includedInTotal,
      source: source.source,
    },
  };
}

async function runTransaction(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const outcome = await action(client);
    if (outcome.abort) {
      await rollback(client);
      started = false;
      return outcome.abort;
    }
    await client.query("COMMIT");
    started = false;
    if (outcome.afterCommit) outcome.afterCommit();
    return outcome.result;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function invokeFailure(injector, stage) {
  if (typeof injector === "function") await injector(stage);
}

async function loadJobContext(client, jobId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      jobs.lifecycle_contract_version,
      posts.user_id AS homeowner_user_id,
      relationships.status AS relationship_status,
      relationships.professional_user_id AS selected_professional_user_id,
      participants.id AS actor_participant_id,
      participants.user_id AS actor_user_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_primary_professional
    FROM jobs
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
    LEFT JOIN relationship_participants participants
      ON participants.job_id = jobs.id
      AND participants.request_relationship_id = relationships.id
      AND participants.user_id = $2
    WHERE jobs.id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE OF jobs" : ""}
    `,
    [jobId, actorUserId]
  );
  return result.rows[0] || null;
}

async function loadQuoteContext(client, quoteId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT
      quotes.*,
      aggregates.current_version,
      jobs.lifecycle_contract_version,
      relationships.status AS relationship_status,
      relationships.homeowner_id AS homeowner_user_id,
      relationships.professional_user_id AS selected_professional_user_id,
      participants.id AS actor_participant_id,
      participants.user_id AS actor_user_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = quotes.job_id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_primary_professional
    FROM canonical_quotes quotes
    INNER JOIN commercial_authority_aggregates aggregates
      ON aggregates.id = quotes.id
      AND aggregates.aggregate_type = 'quote'
      AND aggregates.owning_engine = $3
    INNER JOIN jobs ON jobs.id = quotes.job_id
    INNER JOIN request_relationships relationships
      ON relationships.id = quotes.relationship_id
      AND relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = quotes.job_request_id
      AND relationships.emergency_request_id IS NULL
    LEFT JOIN relationship_participants participants
      ON participants.job_id = quotes.job_id
      AND participants.request_relationship_id = quotes.relationship_id
      AND participants.user_id = $2
    WHERE quotes.id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE OF quotes, aggregates" : ""}
    `,
    [quoteId, actorUserId, OWNING_ENGINE]
  );
  return result.rows[0] || null;
}

async function loadCustomerQuoteContext(client, quoteId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT
      quotes.*,
      aggregates.current_version,
      jobs.lifecycle_contract_version,
      relationships.status AS relationship_status,
      participants.id AS actor_participant_id,
      participants.user_id AS actor_user_id,
      decisions.id AS decision_id,
      decisions.decision,
      decisions.issued_quote_version AS decision_quote_version,
      decisions.decided_at,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = quotes.job_id
          AND roles.role = 'CUSTOMER_REPRESENTATIVE'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_customer_representative
    FROM canonical_quotes quotes
    INNER JOIN commercial_authority_aggregates aggregates
      ON aggregates.id = quotes.id
      AND aggregates.aggregate_type = 'quote'
      AND aggregates.owning_engine = $3
    INNER JOIN jobs ON jobs.id = quotes.job_id
    INNER JOIN request_relationships relationships
      ON relationships.id = quotes.relationship_id
      AND relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = quotes.job_request_id
      AND relationships.emergency_request_id IS NULL
    LEFT JOIN relationship_participants participants
      ON participants.job_id = quotes.job_id
      AND participants.request_relationship_id = quotes.relationship_id
      AND participants.user_id = $2
    LEFT JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id
    WHERE quotes.id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE OF quotes, aggregates" : ""}
    `,
    [quoteId, actorUserId, OWNING_ENGINE]
  );
  return result.rows[0] || null;
}

async function requireCustomerQuoteAuthority({ client, context, capability, logger }) {
  if (!context || Number(context.lifecycle_contract_version) !== 2) {
    return failure(404, "QUOTE_UNAVAILABLE", "The Quote is unavailable.");
  }
  if (context.relationship_status !== "active") {
    return failure(409, "QUOTE_CONTEXT_INACTIVE", "The Quote context is inactive.");
  }
  if (!context.actor_participant_id || context.actor_is_customer_representative !== true) {
    logger.warn("Customer Quote authority denied", {
      code: "CUSTOMER_QUOTE_AUTHORITY_DENIED",
      capability,
      jobId: context.job_id,
    });
    return failure(403, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED", "Customer Quote authority is required.");
  }
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.actor_participant_id,
    capability,
    jobId: context.job_id,
    logger,
  });
  if (!granted) {
    logger.warn("Customer Quote authority denied", {
      code: "CUSTOMER_QUOTE_AUTHORITY_DENIED",
      participantId: context.actor_participant_id,
      capability,
      jobId: context.job_id,
    });
    return failure(403, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED", "Customer Quote authority is required.");
  }
  return null;
}

async function requireQuoteAuthority({ client, context, capability, logger }) {
  if (!context) {
    return failure(404, "QUOTE_UNAVAILABLE", "The Quote is unavailable.");
  }
  if (Number(context.lifecycle_contract_version) !== 2) {
    return failure(409, "LIFECYCLE_V2_REQUIRED", "Quote authority requires a lifecycle-v2 Job.");
  }
  if (context.relationship_status !== "active") {
    return failure(409, "QUOTE_CONTEXT_INACTIVE", "The Quote context is inactive.");
  }
  if (
    !context.actor_participant_id ||
    Number(context.selected_professional_user_id) !== Number(context.actor_user_id) ||
    context.actor_is_primary_professional !== true
  ) {
    logger.warn("Quote authority denied", {
      code: "QUOTE_AUTHORITY_DENIED",
      capability,
      jobId: context.job_id,
    });
    return failure(403, "QUOTE_AUTHORITY_REQUIRED", "Quote authority is required.");
  }
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.actor_participant_id,
    capability,
    jobId: context.job_id,
    logger,
  });
  if (!granted) {
    logger.warn("Quote authority denied", {
      code: "QUOTE_AUTHORITY_DENIED",
      participantId: context.actor_participant_id,
      capability,
      jobId: context.job_id,
    });
    return failure(403, "QUOTE_AUTHORITY_REQUIRED", "Quote authority is required.");
  }
  return null;
}

async function loadActiveQuoteGrant(client, context, capability) {
  const result = await client.query(
    `
    SELECT grants.id
    FROM lifecycle_authority_grants grants
    LEFT JOIN lifecycle_authority_grant_revocations revocations
      ON revocations.authority_grant_id = grants.id
    WHERE grants.grantee_participant_id = $1
      AND grants.job_id = $2
      AND grants.scope_type = 'job'
      AND grants.scope_job_id = $2
      AND grants.scope_concern_id IS NULL
      AND grants.capability = $3
      AND grants.valid_from <= CURRENT_TIMESTAMP
      AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
      AND revocations.id IS NULL
    ORDER BY grants.valid_from DESC, grants.created_at DESC, grants.id DESC
    LIMIT 1
    `,
    [context.actor_participant_id, context.job_id, capability]
  );
  return result.rows[0]?.id || null;
}

function sourceColumns(source) {
  return {
    source_type: source.type,
    source_version:
      source.type === "WORKSTREAM" || source.type === "MANUAL_PROFESSIONAL"
        ? null
        : source.version,
    source_workstream_version:
      source.type === "WORKSTREAM" ? source.version : null,
    source_finding_id: source.findingId || null,
    source_recommendation_id: source.recommendationId || null,
    source_workstream_id: source.workstreamId || null,
    source_activity_id: source.activityId || null,
    source_obligation_id: source.obligationId || null,
  };
}

async function validateCanonicalSource(
  client,
  source,
  jobId,
  scopeSemantic,
  { requireCurrent = false } = {}
) {
  if (source.type === "MANUAL_PROFESSIONAL") return { ok: true };
  const definitions = {
    FINDING: {
      sql: `SELECT versions.confirmation_state, versions.resolution_state,
          versions.version = (
            SELECT max(current.version)
            FROM canonical_evaluation_finding_versions current
            WHERE current.finding_id = versions.finding_id
              AND current.job_id = versions.job_id
          ) AS is_current
        FROM canonical_evaluation_finding_versions versions
        WHERE versions.finding_id = $1 AND versions.version = $2
          AND versions.job_id = $3 LIMIT 1`,
      values: [source.findingId, source.version, jobId],
    },
    RECOMMENDATION: {
      sql: `SELECT versions.status,
          versions.version = (
            SELECT max(current.version)
            FROM canonical_recommendation_versions current
            WHERE current.recommendation_id = versions.recommendation_id
              AND current.job_id = versions.job_id
          ) AS is_current
        FROM canonical_recommendation_versions versions
        WHERE versions.recommendation_id = $1 AND versions.version = $2
          AND versions.job_id = $3 LIMIT 1`,
      values: [source.recommendationId, source.version, jobId],
    },
    WORKSTREAM: {
      sql: `SELECT versions.state,
          versions.version = (
            SELECT max(current.version)
            FROM canonical_workstream_versions current
            WHERE current.workstream_id = versions.workstream_id
              AND current.job_id = versions.job_id
          ) AS is_current
        FROM canonical_workstream_versions versions
        WHERE versions.workstream_id = $1 AND versions.version = $2
          AND versions.job_id = $3 LIMIT 1`,
      values: [source.workstreamId, source.version, jobId],
    },
    WORK_ACTIVITY: {
      sql: `SELECT versions.status, versions.temporary_intervention,
          versions.version = (
            SELECT max(current.version)
            FROM canonical_work_activity_versions current
            WHERE current.activity_id = versions.activity_id
              AND current.workstream_id = versions.workstream_id
              AND current.job_id = versions.job_id
          ) AS is_current
        FROM canonical_work_activity_versions versions
        WHERE versions.activity_id = $1 AND versions.version = $2
          AND versions.workstream_id = $3 AND versions.job_id = $4 LIMIT 1`,
      values: [source.activityId, source.version, source.workstreamId, jobId],
    },
    WORKSTREAM_OBLIGATION: {
      sql: `SELECT versions.status,
          versions.version = (
            SELECT max(current.version)
            FROM canonical_workstream_obligation_versions current
            WHERE current.obligation_id = versions.obligation_id
              AND current.workstream_id = versions.workstream_id
              AND current.job_id = versions.job_id
          ) AS is_current
        FROM canonical_workstream_obligation_versions versions
        WHERE versions.obligation_id = $1 AND versions.version = $2
          AND versions.workstream_id = $3 AND versions.job_id = $4 LIMIT 1`,
      values: [source.obligationId, source.version, source.workstreamId, jobId],
    },
  };
  const result = await client.query(definitions[source.type].sql, definitions[source.type].values);
  const row = result.rows[0];
  if (!row) {
    return {
      error: failure(
        409,
        "QUOTE_SOURCE_SCOPE_MISMATCH",
        "The Quote source does not belong to the same Job and version."
      ),
    };
  }
  if (requireCurrent && row.is_current !== true) {
    return {
      error: failure(
        409,
        "QUOTE_SOURCE_VERSION_STALE",
        "The Quote source version is no longer current."
      ),
    };
  }
  if (
    source.type === "WORK_ACTIVITY" &&
    scopeSemantic === "TEMPORARY_SERVICE" &&
    (row.status !== "DONE" || row.temporary_intervention !== true)
  ) {
    return {
      error: failure(
        409,
        "QUOTE_SOURCE_SEMANTIC_MISMATCH",
        "The Quote source does not support the requested commercial semantic."
      ),
    };
  }
  if (
    source.type === "WORK_ACTIVITY" &&
    scopeSemantic === "COMPLETED_BILLABLE_SERVICE" &&
    row.status !== "DONE"
  ) {
    return {
      error: failure(
        409,
        "QUOTE_SOURCE_SEMANTIC_MISMATCH",
        "The Quote source does not support the requested commercial semantic."
      ),
    };
  }
  return { ok: true };
}

function snapshotFromRow(row) {
  return {
    scopeItemId: row.scope_item_id,
    scopeItemRevision: Number(row.scope_item_revision),
    sequence: Number(row.sequence),
    classification: row.classification,
    scopeSemantic: row.scope_semantic,
    materialResponsibility: row.material_responsibility,
    description: row.description,
    quantity: Number(row.quantity),
    unitAmountMinor: Number(row.unit_amount_minor),
    lineTotalMinor: Number(row.line_total_minor),
    includedInTotal: row.included_in_total === true,
    source: {
      type: row.source_type,
      version:
        row.source_type === "WORKSTREAM"
          ? Number(row.source_workstream_version)
          : row.source_version == null
            ? null
            : Number(row.source_version),
      findingId: row.source_finding_id || null,
      recommendationId: row.source_recommendation_id || null,
      workstreamId: row.source_workstream_id || null,
      activityId: row.source_activity_id || null,
      obligationId: row.source_obligation_id || null,
    },
    createdAt: row.created_at,
  };
}

async function loadCurrentSnapshots(client, quoteId, version) {
  const result = await client.query(
    `SELECT * FROM canonical_quote_scope_item_snapshots
     WHERE quote_id = $1 AND quote_version = $2
     ORDER BY sequence ASC, scope_item_id ASC`,
    [quoteId, version]
  );
  return result.rows.map(snapshotFromRow);
}

async function loadQuoteVersionContract(client, quoteId, version, jobId) {
  const result = await client.query(
    `SELECT integrity_version, customer_terms_snapshot
     FROM canonical_quote_versions
     WHERE quote_id = $1 AND version = $2 AND job_id = $3
     LIMIT 1`,
    [quoteId, version, jobId]
  );
  const row = result.rows[0];
  if (!row) return { error: "INVALID_QUOTE_INTEGRITY_CONTRACT" };
  return quoteIntegrityContract(row.integrity_version, row.customer_terms_snapshot);
}

function calculateTotals(snapshots) {
  let materialsSubtotalMinor = 0;
  let laborServiceSubtotalMinor = 0;
  for (const item of snapshots) {
    if (!item.includedInTotal) continue;
    if (item.classification === "MATERIAL") {
      materialsSubtotalMinor += item.lineTotalMinor;
    } else if (item.classification === "LABOR_SERVICE") {
      laborServiceSubtotalMinor += item.lineTotalMinor;
    }
    if (
      !Number.isSafeInteger(materialsSubtotalMinor) ||
      !Number.isSafeInteger(laborServiceSubtotalMinor) ||
      materialsSubtotalMinor > MAX_MINOR_AMOUNT ||
      laborServiceSubtotalMinor > MAX_MINOR_AMOUNT
    ) {
      return { error: failure(400, "INVALID_QUOTE_TOTAL", "The Quote total is invalid.") };
    }
  }
  const totalMinor = materialsSubtotalMinor + laborServiceSubtotalMinor;
  if (!Number.isSafeInteger(totalMinor) || totalMinor > MAX_MINOR_AMOUNT) {
    return { error: failure(400, "INVALID_QUOTE_TOTAL", "The Quote total is invalid.") };
  }
  return {
    materialsSubtotalMinor,
    laborServiceSubtotalMinor,
    totalMinor,
  };
}

function deriveCommercialSnapshots(snapshots) {
  return {
    conditions: [],
    exclusions: snapshots
      .filter((item) => !item.includedInTotal)
      .map((item) => ({
        scopeItemId: item.scopeItemId,
        sequence: item.sequence,
        classification: item.classification,
        scopeSemantic: item.scopeSemantic,
        materialResponsibility: item.materialResponsibility,
        source: sourceColumns(item.source),
      })),
  };
}

function persistedSnapshotIsValid(item) {
  const shape = commercialShape(item);
  return Boolean(
    shape &&
    shape.includedInTotal === item.includedInTotal &&
    Number.isSafeInteger(item.quantity) &&
    item.quantity >= 1 &&
    Number.isSafeInteger(item.unitAmountMinor) &&
    item.unitAmountMinor >= 0 &&
    Number.isSafeInteger(item.lineTotalMinor) &&
    item.lineTotalMinor === item.quantity * item.unitAmountMinor
  );
}

function integrityHash({
  quoteId,
  version,
  currency,
  status,
  issuedAt,
  totals,
  snapshots,
  conditions,
  exclusions,
  integrityVersion = QUOTE_INTEGRITY_VERSION_V1,
  customerTermsSnapshot = null,
}) {
  const contract = quoteIntegrityContract(integrityVersion, customerTermsSnapshot);
  if (contract.error) throw new TypeError("The Quote integrity contract is invalid.");
  const payload = {
      quoteId,
      version,
      currency,
      status,
      issuedAt: issuedAt || null,
      materialsSubtotalMinor: totals.materialsSubtotalMinor,
      laborServiceSubtotalMinor: totals.laborServiceSubtotalMinor,
      totalMinor: totals.totalMinor,
      scope: snapshots.map((item) => ({
        scopeItemId: item.scopeItemId,
        scopeItemRevision: item.scopeItemRevision,
        sequence: item.sequence,
        classification: item.classification,
        scopeSemantic: item.scopeSemantic,
        materialResponsibility: item.materialResponsibility,
        description: item.description,
        quantity: item.quantity,
        unitAmountMinor: item.unitAmountMinor,
        lineTotalMinor: item.lineTotalMinor,
        includedInTotal: item.includedInTotal,
        source: sourceColumns(item.source),
      })),
      conditions,
      exclusions,
  };
  if (contract.integrityVersion === QUOTE_INTEGRITY_VERSION_V2) {
    payload.integrityVersion = QUOTE_INTEGRITY_VERSION_V2;
    payload.customerTermsSnapshot = contract.customerTermsSnapshot;
  }
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function insertQuoteVersion({
  client,
  quoteId,
  version,
  jobId,
  currency,
  actorParticipantId,
  snapshots,
  status = QUOTE_STATUS.DRAFT,
  issuedAt = null,
  customerTermsSnapshot = null,
}) {
  const totals = calculateTotals(snapshots);
  if (totals.error) return totals;
  const commercialSnapshots = deriveCommercialSnapshots(snapshots);
  const integrityVersion = customerTermsSnapshot == null
    ? QUOTE_INTEGRITY_VERSION_V1
    : QUOTE_INTEGRITY_VERSION_V2;
  const contract = quoteIntegrityContract(integrityVersion, customerTermsSnapshot);
  if (contract.error) {
    return {
      error: failure(400, "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT", "The Quote customer terms are invalid."),
    };
  }
  const hash = integrityHash({
    quoteId,
    version,
    currency,
    status,
    issuedAt,
    totals,
    snapshots,
    ...commercialSnapshots,
    integrityVersion: contract.integrityVersion,
    customerTermsSnapshot: contract.customerTermsSnapshot,
  });
  const result = await client.query(
    `
    INSERT INTO canonical_quote_versions (
      quote_id, version, job_id, status, currency,
      materials_subtotal_minor, labor_service_subtotal_minor, total_minor,
      scope_item_count, conditions_snapshot, exclusions_snapshot,
      customer_terms_snapshot, issued_at, created_by_participant_id,
      integrity_hash, integrity_version
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
      $12::jsonb, $13, $14, $15, $16)
    RETURNING *
    `,
    [
      quoteId,
      version,
      jobId,
      status,
      currency,
      totals.materialsSubtotalMinor,
      totals.laborServiceSubtotalMinor,
      totals.totalMinor,
      snapshots.length,
      JSON.stringify(commercialSnapshots.conditions),
      JSON.stringify(commercialSnapshots.exclusions),
      contract.customerTermsSnapshot == null
        ? null
        : JSON.stringify(contract.customerTermsSnapshot),
      issuedAt,
      actorParticipantId,
      hash,
      contract.integrityVersion,
    ]
  );
  return { row: result.rows[0], totals, ...commercialSnapshots };
}

async function insertSnapshot(client, quoteId, quoteVersion, jobId, actorParticipantId, item) {
  const source = sourceColumns(item.source);
  await client.query(
    `
    INSERT INTO canonical_quote_scope_item_snapshots (
      quote_id, quote_version, scope_item_id, scope_item_revision,
      job_id, sequence, classification, scope_semantic,
      material_responsibility, description, quantity, unit_amount_minor,
      line_total_minor, included_in_total, source_type, source_version,
      source_workstream_version, source_finding_id, source_recommendation_id,
      source_workstream_id, source_activity_id, source_obligation_id,
      created_by_participant_id
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21, $22, $23
    )
    `,
    [
      quoteId,
      quoteVersion,
      item.scopeItemId,
      item.scopeItemRevision,
      jobId,
      item.sequence,
      item.classification,
      item.scopeSemantic,
      item.materialResponsibility,
      item.description,
      item.quantity,
      item.unitAmountMinor,
      item.lineTotalMinor,
      item.includedInTotal,
      source.source_type,
      source.source_version,
      source.source_workstream_version,
      source.source_finding_id,
      source.source_recommendation_id,
      source.source_workstream_id,
      source.source_activity_id,
      source.source_obligation_id,
      actorParticipantId,
    ]
  );
}

async function insertQuoteEvidence({
  client,
  quoteId,
  relationshipId,
  actorUserId,
  idempotencyId,
  evidenceType,
  commandName,
  previousVersion,
  resultingVersion,
  totals,
  scopeItemCount,
  authorityGrantId = null,
  snapshotIntegrityHash = null,
  capabilityMilestoneId = CAPABILITY_MILESTONE_ID,
}) {
  const result = await client.query(
    `
    INSERT INTO commercial_authority_evidence (
      id, aggregate_id, aggregate_type, owning_engine, evidence_type,
      actor_user_id, actor_role, relationship_id, previous_version,
      resulting_version, idempotency_id, evidence_payload, source_command,
      governing_charter_id, governing_program_id, implementation_milestone_id,
      capability_milestone_id, certification_target
    )
    VALUES (
      $1, $2, 'quote', $3, $4, $5, 'professional', $6, $7, $8, $9,
      $10::jsonb, $11, $12, $13, $14, $15, $16
    )
    RETURNING id
    `,
    [
      randomUUID(),
      quoteId,
      OWNING_ENGINE,
      evidenceType,
      actorUserId,
      relationshipId,
      previousVersion,
      resultingVersion,
      idempotencyId,
      JSON.stringify({
        schemaVersion: 1,
        status: QUOTE_STATUS.DRAFT,
        scopeItemCount,
        materialsSubtotalMinor: totals.materialsSubtotalMinor,
        laborServiceSubtotalMinor: totals.laborServiceSubtotalMinor,
        totalMinor: totals.totalMinor,
        authorityGrantId,
        snapshotIntegrityHash,
      }),
      commandName,
      TRACEABILITY.governingCharterId,
      TRACEABILITY.governingProgramId,
      TRACEABILITY.implementationMilestoneId,
      capabilityMilestoneId,
      TRACEABILITY.certificationTarget,
    ]
  );
  return result.rows[0] || null;
}

function quoteResult(code, status, quote, extra = {}) {
  return {
    ok: true,
    success: true,
    status,
    code,
    authoritySource: AUTHORITY_SOURCE,
    quote,
    ...extra,
  };
}

async function loadQuoteProjection(client, quoteId) {
  const identityResult = await client.query(
    `
    SELECT quotes.*, aggregates.current_version,
      versions.materials_subtotal_minor,
      versions.labor_service_subtotal_minor,
      versions.total_minor,
      versions.scope_item_count,
      versions.conditions_snapshot,
      versions.exclusions_snapshot,
      versions.customer_terms_snapshot,
      versions.issued_at AS version_issued_at,
      versions.integrity_hash,
      versions.integrity_version,
      versions.created_at AS version_created_at,
      decisions.decision AS customer_decision,
      decisions.issued_quote_version AS customer_decision_quote_version,
      decisions.decided_at AS customer_decided_at
    FROM canonical_quotes quotes
    INNER JOIN commercial_authority_aggregates aggregates
      ON aggregates.id = quotes.id
      AND aggregates.aggregate_type = 'quote'
      AND aggregates.owning_engine = $2
    INNER JOIN canonical_quote_versions versions
      ON versions.quote_id = quotes.id
      AND versions.version = aggregates.current_version
    LEFT JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id
    WHERE quotes.id = $1
    LIMIT 1
    `,
    [quoteId, OWNING_ENGINE]
  );
  const identity = identityResult.rows[0];
  if (!identity) return null;
  const scopes = await loadCurrentSnapshots(client, quoteId, Number(identity.current_version));
  const historyResult = await client.query(
    `
    SELECT version, status, currency, materials_subtotal_minor,
      labor_service_subtotal_minor, total_minor, scope_item_count,
      conditions_snapshot, exclusions_snapshot, issued_at,
      customer_terms_snapshot, integrity_hash, integrity_version, created_at
    FROM canonical_quote_versions
    WHERE quote_id = $1
    ORDER BY version ASC
    `,
    [quoteId]
  );
  return {
    id: identity.id,
    jobId: identity.job_id,
    requestId: Number(identity.job_request_id),
    relationshipId: Number(identity.relationship_id),
    issuerParticipantId: identity.issuer_participant_id,
    parentQuoteId: identity.parent_quote_id,
    lineageType: identity.lineage_type,
    lineageReasonCategory: identity.lineage_reason_category,
    status: identity.status,
    issuedAt: identity.issued_at,
    currency: identity.currency,
    currentVersion: Number(identity.current_version),
    materialsSubtotalMinor: Number(identity.materials_subtotal_minor),
    laborServiceSubtotalMinor: Number(identity.labor_service_subtotal_minor),
    totalMinor: Number(identity.total_minor),
    scopeItemCount: Number(identity.scope_item_count),
    conditions: identity.conditions_snapshot,
    exclusions: identity.exclusions_snapshot,
    customerTermsSnapshot: identity.customer_terms_snapshot,
    integrityVersion: Number(identity.integrity_version || QUOTE_INTEGRITY_VERSION_V1),
    scopeItems: scopes,
    versions: historyResult.rows.map((row) => ({
      version: Number(row.version),
      status: row.status,
      currency: row.currency,
      materialsSubtotalMinor: Number(row.materials_subtotal_minor),
      laborServiceSubtotalMinor: Number(row.labor_service_subtotal_minor),
      totalMinor: Number(row.total_minor),
      scopeItemCount: Number(row.scope_item_count),
      conditions: row.conditions_snapshot,
      exclusions: row.exclusions_snapshot,
      customerTermsSnapshot: row.customer_terms_snapshot,
      issuedAt: row.issued_at,
      integrityHash: row.integrity_hash,
      integrityVersion: Number(row.integrity_version || QUOTE_INTEGRITY_VERSION_V1),
      createdAt: row.created_at,
    })),
    createdAt: identity.created_at,
    updatedAt: identity.updated_at,
    decisionState: identity.customer_decision || null,
    decisionVersion: identity.customer_decision_quote_version == null
      ? null
      : Number(identity.customer_decision_quote_version),
    decidedAt: identity.customer_decided_at || null,
  };
}

function customerQuoteLineageLabel(quote = {}) {
  if (quote.lineageType === "REVISED_QUOTE") return "Revised";
  if (quote.lineageType === "SUPPLEMENTAL_QUOTE") return "Additional";
  return "Original";
}

function customerFacingText(value) {
  const candidate = typeof value === "string"
    ? value
    : isPlainObject(value)
      ? value.description
      : "";
  return boundedText(candidate, 1000);
}

function customerFacingTextList(values) {
  if (!Array.isArray(values)) return [];
  return values.map(customerFacingText).filter(Boolean);
}

function customerScopeItemProjection(item = {}, { includeAmount = false } = {}) {
  const description = customerFacingText(item);
  const quantity = safeQuantity(item.quantity);
  const amountMinor = includeAmount
    ? safeNonNegativeInteger(item.lineTotalMinor)
    : null;
  if (!description || !quantity || (includeAmount && amountMinor == null)) {
    return null;
  }
  const projection = {
    description,
    quantity,
  };
  if (includeAmount) {
    projection.amountMinor = amountMinor;
  }
  return projection;
}

function customerQuoteDetailProjection(
  quote = {},
  { canApprove = false, canDecline = false } = {}
) {
  if (quote.status !== QUOTE_STATUS.ISSUED) return null;
  const customerDecision = QUOTE_DECISIONS.includes(quote.decisionState)
    ? quote.decisionState
    : null;
  const decisionPending = customerDecision == null;
  const includedScopeItems = Array.isArray(quote.scopeItems)
    ? quote.scopeItems
        .filter((item) => item?.includedInTotal === true)
        .map((item) => customerScopeItemProjection(item, { includeAmount: true }))
        .filter(Boolean)
    : [];
  const excludedScopeItems = Array.isArray(quote.scopeItems)
    ? quote.scopeItems
        .filter((item) => item?.includedInTotal === false)
        .map((item) => customerScopeItemProjection(item))
        .filter(Boolean)
    : [];
  const persistedExclusions = customerFacingTextList(quote.exclusions).map(
    (description) => ({ description, quantity: 1 })
  );
  const seenExclusions = new Set();
  const exclusions = [...excludedScopeItems, ...persistedExclusions].filter(
    ({ description, quantity }) => {
      const key = `${description}\u0000${quantity}`;
      if (seenExclusions.has(key)) return false;
      seenExclusions.add(key);
      return true;
    }
  );

  const projection = {
    quoteId: quote.id,
    jobId: quote.jobId,
    status: QUOTE_STATUS.ISSUED,
    businessStatus: customerDecision || "WAITING_ON_CUSTOMER",
    customerDecision,
    lineageLabel: customerQuoteLineageLabel(quote),
    totalMinor: safeNonNegativeInteger(quote.totalMinor),
    currency: validateCurrency(quote.currency),
    scopeItems: includedScopeItems,
    conditions: customerFacingTextList(quote.conditions),
    exclusions,
    issuedAt: quote.issuedAt || null,
    decidedAt: quote.decidedAt || null,
    decisionCommandVersion: positiveInteger(quote.currentVersion),
    actions: {
      canViewQuote: true,
      canApprove: decisionPending && canApprove === true,
      canDecline: decisionPending && canDecline === true,
    },
  };
  if (quote.customerTermsSnapshot != null) {
    const normalized = normalizeCustomerTermsSnapshot(quote.customerTermsSnapshot);
    if (normalized.error) return null;
    projection.customerTermsSnapshot = normalized.snapshot;
  }
  return projection;
}

async function createDraftQuote(input = {}) {
  const validated = validateCommand(input, ["jobId", "currency", "customerTermsSnapshot"]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  const currency = validateCurrency(input.currency);
  if (!jobId || !currency) {
    return failure(400, "INVALID_DRAFT_QUOTE", "The Draft Quote is invalid.");
  }
  const terms = input.customerTermsSnapshot === undefined
    ? { snapshot: null }
    : normalizeCustomerTermsSnapshot(input.customerTermsSnapshot);
  if (terms.error) {
    return failure(400, "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT", "The Quote customer terms are invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadJobContext(client, jobId, validated.actorId, { lock: true });
    const authorityError = await requireQuoteAuthority({
      client,
      context,
      capability: QUOTE_CAPABILITIES.CREATE,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: QUOTE_COMMANDS.CREATE,
      jobId,
      currency,
      expectedVersion: 0,
      customerTermsSnapshot: terms.snapshot,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: QUOTE_COMMANDS.CREATE,
      commandScope: `job:${jobId}:quote:draft`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Draft Quote create replayed", {
          code: "DRAFT_QUOTE_CREATE_REPLAYED",
          jobId,
        }),
      };
    }
    const existing = await client.query(
      `SELECT id FROM canonical_quotes WHERE job_id = $1 AND parent_quote_id IS NULL
       LIMIT 1 FOR UPDATE`,
      [jobId]
    );
    if (existing.rows[0]) {
      return {
        abort: failure(409, "ROOT_QUOTE_ALREADY_EXISTS", "A canonical Quote already exists for this Job."),
      };
    }

    const quoteId = randomUUID();
    const aggregateResult = await client.query(
      `
      INSERT INTO commercial_authority_aggregates (
        id, aggregate_type, owning_engine, source_context_type,
        ordinary_request_id, emergency_request_id, relationship_id,
        source_owner_user_id, created_by_user_id, current_version
      )
      VALUES ($1, 'quote', $2, 'ordinary_request', $3, NULL, $4, $5, $6, 1)
      RETURNING *
      `,
      [
        quoteId,
        OWNING_ENGINE,
        Number(context.job_request_id),
        Number(context.relationship_id),
        Number(context.homeowner_user_id),
        validated.actorId,
      ]
    );
    if (!aggregateResult.rows[0]) throw new Error("Canonical Quote aggregate creation failed.");
    const quoteResultRow = await client.query(
      `
      INSERT INTO canonical_quotes (
        id, job_id, job_request_id, relationship_id,
        issuer_participant_id, currency, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT')
      RETURNING *
      `,
      [
        quoteId,
        jobId,
        Number(context.job_request_id),
        Number(context.relationship_id),
        context.actor_participant_id,
        currency,
      ]
    );
    if (!quoteResultRow.rows[0]) throw new Error("Canonical Quote identity creation failed.");
    const version = await insertQuoteVersion({
      client,
      quoteId,
      version: 1,
      jobId,
      currency,
      actorParticipantId: context.actor_participant_id,
      snapshots: [],
      customerTermsSnapshot: terms.snapshot,
    });
    if (!version.row) throw new Error("Canonical Quote version creation failed.");
    const evidence = await insertQuoteEvidence({
      client,
      quoteId,
      relationshipId: Number(context.relationship_id),
      actorUserId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType: QUOTE_EVIDENCE_TYPES.CREATED,
      commandName: QUOTE_COMMANDS.CREATE,
      previousVersion: 0,
      resultingVersion: 1,
      totals: version.totals,
      scopeItemCount: 0,
    });
    if (!evidence) throw new Error("Canonical Quote evidence creation failed.");
    await invokeFailure(input.failureInjector, "after_write");
    const quote = await loadQuoteProjection(client, quoteId);
    const result = quoteResult("DRAFT_QUOTE_CREATED", 201, quote);
    if (!(await completeIdempotency(client, idempotency.reservation.id, quoteId, result))) {
      throw new Error("Canonical Quote idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Draft Quote created", {
        code: "DRAFT_QUOTE_CREATED",
        quoteId,
        jobId,
        version: 1,
        currency,
      }),
    };
  });
}

async function addDraftScopeItem(input = {}) {
  const validated = validateCommand(input, ["quoteId", "expectedVersion", "item"]);
  if (validated.error) return validated.error;
  const quoteId = normalizedUuid(input.quoteId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const itemValidation = validateScopeItem(input.item);
  if (!quoteId || !expectedVersion || itemValidation.error) {
    return itemValidation.error || failure(400, "INVALID_QUOTE_SCOPE_COMMAND", "The Quote scope command is invalid.");
  }
  const item = itemValidation.item;
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadQuoteContext(client, quoteId, validated.actorId, { lock: true });
    const authorityError = await requireQuoteAuthority({
      client,
      context,
      capability: QUOTE_CAPABILITIES.SCOPE_MANAGE,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    if (context.status !== QUOTE_STATUS.DRAFT) {
      logger.warn("Issued Quote mutation rejected", {
        code: "ISSUED_QUOTE_IMMUTABLE",
        quoteId,
        jobId: context.job_id,
        operation: QUOTE_COMMANDS.SCOPE_ADD,
      });
      return { abort: failure(409, "DRAFT_QUOTE_REQUIRED", "Only a Draft Quote can be changed.") };
    }
    const requestFingerprint = fingerprint({
      command: QUOTE_COMMANDS.SCOPE_ADD,
      quoteId,
      expectedVersion,
      item,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: QUOTE_COMMANDS.SCOPE_ADD,
      commandScope: `quote:${quoteId}:scope`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Quote Scope Item add replayed", {
          code: "QUOTE_SCOPE_ADD_REPLAYED",
          quoteId,
          jobId: context.job_id,
        }),
      };
    }
    if (Number(context.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_QUOTE_VERSION", "The Quote version is stale.") };
    }
    const sourceValidation = await validateCanonicalSource(
      client,
      item.source,
      context.job_id,
      item.scopeSemantic
    );
    if (sourceValidation.error) {
      logger.warn("Quote source scope rejected", {
        code: sourceValidation.error.code,
        quoteId,
        jobId: context.job_id,
        sourceType: item.source.type,
      });
      return { abort: sourceValidation.error };
    }
    const existingSnapshots = await loadCurrentSnapshots(client, quoteId, expectedVersion);
    const currentContract = await loadQuoteVersionContract(
      client,
      quoteId,
      expectedVersion,
      context.job_id
    );
    if (currentContract.error) {
      return { abort: failure(409, "QUOTE_SNAPSHOT_INVALID", "The Draft Quote snapshot is invalid.") };
    }
    const scopeItemId = randomUUID();
    const newSnapshot = {
      scopeItemId,
      scopeItemRevision: 1,
      sequence: existingSnapshots.length + 1,
      ...item,
      createdAt: null,
    };
    const nextSnapshots = [...existingSnapshots, newSnapshot];
    const nextVersion = expectedVersion + 1;
    const aggregate = await client.query(
      `UPDATE commercial_authority_aggregates
       SET current_version = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND current_version = $3
         AND aggregate_type = 'quote' AND owning_engine = $4
       RETURNING id`,
      [quoteId, nextVersion, expectedVersion, OWNING_ENGINE]
    );
    if (!aggregate.rows[0]) {
      return { abort: failure(409, "STALE_QUOTE_VERSION", "The Quote version is stale.") };
    }
    await client.query(
      `UPDATE canonical_quotes SET updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'DRAFT'`,
      [quoteId]
    );
    const version = await insertQuoteVersion({
      client,
      quoteId,
      version: nextVersion,
      jobId: context.job_id,
      currency: context.currency,
      actorParticipantId: context.actor_participant_id,
      snapshots: nextSnapshots,
      customerTermsSnapshot: currentContract.customerTermsSnapshot,
    });
    if (version.error) return { abort: version.error };
    await client.query(
      `INSERT INTO canonical_quote_scope_items
        (id, quote_id, job_id, created_by_participant_id)
       VALUES ($1, $2, $3, $4)`,
      [scopeItemId, quoteId, context.job_id, context.actor_participant_id]
    );
    for (const snapshot of nextSnapshots) {
      await insertSnapshot(
        client,
        quoteId,
        nextVersion,
        context.job_id,
        context.actor_participant_id,
        snapshot
      );
    }
    const evidence = await insertQuoteEvidence({
      client,
      quoteId,
      relationshipId: Number(context.relationship_id),
      actorUserId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType: QUOTE_EVIDENCE_TYPES.SCOPE_ADDED,
      commandName: QUOTE_COMMANDS.SCOPE_ADD,
      previousVersion: expectedVersion,
      resultingVersion: nextVersion,
      totals: version.totals,
      scopeItemCount: nextSnapshots.length,
    });
    if (!evidence) throw new Error("Canonical Quote scope evidence creation failed.");
    await invokeFailure(input.failureInjector, "after_write");
    const quote = await loadQuoteProjection(client, quoteId);
    const result = quoteResult("QUOTE_SCOPE_ITEM_ADDED", 201, quote, {
      scopeItem: quote.scopeItems.find((scope) => scope.scopeItemId === scopeItemId),
    });
    if (!(await completeIdempotency(client, idempotency.reservation.id, quoteId, result))) {
      throw new Error("Canonical Quote scope idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Quote Scope Item added", {
        code: "QUOTE_SCOPE_ITEM_ADDED",
        quoteId,
        jobId: context.job_id,
        scopeItemId,
        version: nextVersion,
        classification: item.classification,
        includedInTotal: item.includedInTotal,
        totalMinor: version.totals.totalMinor,
      }),
    };
  });
}

async function removeDraftScopeItem(input = {}) {
  const validated = validateCommand(input, ["quoteId", "scopeItemId", "expectedVersion"]);
  if (validated.error) return validated.error;
  const quoteId = normalizedUuid(input.quoteId);
  const scopeItemId = normalizedUuid(input.scopeItemId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  if (!quoteId || !scopeItemId || !expectedVersion) {
    return failure(400, "INVALID_QUOTE_SCOPE_COMMAND", "The Quote scope command is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadQuoteContext(client, quoteId, validated.actorId, { lock: true });
    const authorityError = await requireQuoteAuthority({
      client,
      context,
      capability: QUOTE_CAPABILITIES.SCOPE_MANAGE,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    if (context.status !== QUOTE_STATUS.DRAFT) {
      logger.warn("Issued Quote mutation rejected", {
        code: "ISSUED_QUOTE_IMMUTABLE",
        quoteId,
        jobId: context.job_id,
        operation: QUOTE_COMMANDS.SCOPE_REMOVE,
      });
      return { abort: failure(409, "DRAFT_QUOTE_REQUIRED", "Only a Draft Quote can be changed.") };
    }
    const requestFingerprint = fingerprint({
      command: QUOTE_COMMANDS.SCOPE_REMOVE,
      quoteId,
      scopeItemId,
      expectedVersion,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: QUOTE_COMMANDS.SCOPE_REMOVE,
      commandScope: `quote:${quoteId}:scope`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Quote Scope Item remove replayed", {
          code: "QUOTE_SCOPE_REMOVE_REPLAYED",
          quoteId,
          jobId: context.job_id,
          scopeItemId,
        }),
      };
    }
    if (Number(context.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_QUOTE_VERSION", "The Quote version is stale.") };
    }
    const currentSnapshots = await loadCurrentSnapshots(client, quoteId, expectedVersion);
    const currentContract = await loadQuoteVersionContract(
      client,
      quoteId,
      expectedVersion,
      context.job_id
    );
    if (currentContract.error) {
      return { abort: failure(409, "QUOTE_SNAPSHOT_INVALID", "The Draft Quote snapshot is invalid.") };
    }
    if (!currentSnapshots.some((item) => item.scopeItemId === scopeItemId)) {
      return { abort: failure(404, "QUOTE_SCOPE_ITEM_UNAVAILABLE", "The Quote Scope Item is unavailable.") };
    }
    const nextSnapshots = currentSnapshots
      .filter((item) => item.scopeItemId !== scopeItemId)
      .map((item, index) => ({ ...item, sequence: index + 1 }));
    const nextVersion = expectedVersion + 1;
    const aggregate = await client.query(
      `UPDATE commercial_authority_aggregates
       SET current_version = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND current_version = $3
         AND aggregate_type = 'quote' AND owning_engine = $4
       RETURNING id`,
      [quoteId, nextVersion, expectedVersion, OWNING_ENGINE]
    );
    if (!aggregate.rows[0]) {
      return { abort: failure(409, "STALE_QUOTE_VERSION", "The Quote version is stale.") };
    }
    await client.query(
      `UPDATE canonical_quotes SET updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'DRAFT'`,
      [quoteId]
    );
    const version = await insertQuoteVersion({
      client,
      quoteId,
      version: nextVersion,
      jobId: context.job_id,
      currency: context.currency,
      actorParticipantId: context.actor_participant_id,
      snapshots: nextSnapshots,
      customerTermsSnapshot: currentContract.customerTermsSnapshot,
    });
    if (version.error) return { abort: version.error };
    for (const snapshot of nextSnapshots) {
      await insertSnapshot(
        client,
        quoteId,
        nextVersion,
        context.job_id,
        context.actor_participant_id,
        snapshot
      );
    }
    const evidence = await insertQuoteEvidence({
      client,
      quoteId,
      relationshipId: Number(context.relationship_id),
      actorUserId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType: QUOTE_EVIDENCE_TYPES.SCOPE_REMOVED,
      commandName: QUOTE_COMMANDS.SCOPE_REMOVE,
      previousVersion: expectedVersion,
      resultingVersion: nextVersion,
      totals: version.totals,
      scopeItemCount: nextSnapshots.length,
    });
    if (!evidence) throw new Error("Canonical Quote scope evidence creation failed.");
    await invokeFailure(input.failureInjector, "after_write");
    const quote = await loadQuoteProjection(client, quoteId);
    const result = quoteResult("QUOTE_SCOPE_ITEM_REMOVED", 200, quote, {
      removedScopeItemId: scopeItemId,
    });
    if (!(await completeIdempotency(client, idempotency.reservation.id, quoteId, result))) {
      throw new Error("Canonical Quote scope idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Quote Scope Item removed", {
        code: "QUOTE_SCOPE_ITEM_REMOVED",
        quoteId,
        jobId: context.job_id,
        scopeItemId,
        version: nextVersion,
        totalMinor: version.totals.totalMinor,
      }),
    };
  });
}

async function issueQuote(input = {}) {
  const validated = validateCommand(input, ["quoteId", "expectedVersion"]);
  if (validated.error) return validated.error;
  const quoteId = normalizedUuid(input.quoteId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  if (!quoteId || !expectedVersion) {
    return failure(400, "INVALID_QUOTE_ISSUE_COMMAND", "The Quote issue command is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadQuoteContext(client, quoteId, validated.actorId, { lock: true });
    const authorityError = await requireQuoteAuthority({
      client,
      context,
      capability: QUOTE_CAPABILITIES.ISSUE,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const authorityGrantId = await loadActiveQuoteGrant(
      client,
      context,
      QUOTE_CAPABILITIES.ISSUE
    );
    if (!authorityGrantId) {
      return { abort: failure(403, "QUOTE_AUTHORITY_REQUIRED", "Quote authority is required.") };
    }

    const requestFingerprint = fingerprint({
      command: QUOTE_COMMANDS.ISSUE,
      quoteId,
      expectedVersion,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: QUOTE_COMMANDS.ISSUE,
      commandScope: `quote:${quoteId}:issue`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Quote issue replayed", {
          code: "QUOTE_ISSUE_REPLAYED",
          quoteId,
          jobId: context.job_id,
        }),
      };
    }

    logger.info("Quote issue attempted", {
      code: "QUOTE_ISSUE_ATTEMPTED",
      quoteId,
      jobId: context.job_id,
      expectedVersion,
    });
    if (context.status !== QUOTE_STATUS.DRAFT) {
      logger.warn("Quote issue eligibility rejected", {
        code: "QUOTE_ALREADY_ISSUED",
        quoteId,
        jobId: context.job_id,
      });
      return { abort: failure(409, "QUOTE_ALREADY_ISSUED", "The Quote is already issued.") };
    }
    if (Number(context.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_QUOTE_VERSION", "The Quote version is stale.") };
    }

    const currentResult = await client.query(
      `SELECT * FROM canonical_quote_versions
       WHERE quote_id = $1 AND version = $2 AND job_id = $3
       LIMIT 1`,
      [quoteId, expectedVersion, context.job_id]
    );
    const current = currentResult.rows[0];
    const snapshots = await loadCurrentSnapshots(client, quoteId, expectedVersion);
    const totals = calculateTotals(snapshots);
    const commercialSnapshots = deriveCommercialSnapshots(snapshots);
    const currentContract = current
      ? quoteIntegrityContract(current.integrity_version, current.customer_terms_snapshot)
      : { error: "INVALID_QUOTE_INTEGRITY_CONTRACT" };
    let expectedIntegrityHash = null;
    if (!currentContract.error && !totals.error) {
      expectedIntegrityHash = integrityHash({
        quoteId,
        version: expectedVersion,
        currency: context.currency,
        status: QUOTE_STATUS.DRAFT,
        issuedAt: null,
        totals,
        snapshots,
        ...commercialSnapshots,
        integrityVersion: currentContract.integrityVersion,
        customerTermsSnapshot: currentContract.customerTermsSnapshot,
      });
    }
    const includedCount = snapshots.filter((item) => item.includedInTotal).length;
    const eligibilityInvalid =
      !current ||
      current.status !== QUOTE_STATUS.DRAFT ||
      validateCurrency(context.currency) !== context.currency ||
      snapshots.length !== Number(current.scope_item_count) ||
      snapshots.some((item) => !persistedSnapshotIsValid(item)) ||
      totals.error ||
      Number(current.materials_subtotal_minor) !== totals.materialsSubtotalMinor ||
      Number(current.labor_service_subtotal_minor) !== totals.laborServiceSubtotalMinor ||
      Number(current.total_minor) !== totals.totalMinor ||
      fingerprint(current.conditions_snapshot) !==
        fingerprint(commercialSnapshots.conditions) ||
      fingerprint(current.exclusions_snapshot) !==
        fingerprint(commercialSnapshots.exclusions) ||
      currentContract.error ||
      current.integrity_hash !== expectedIntegrityHash;
    if (eligibilityInvalid || includedCount < 1) {
      logger.warn("Quote issue eligibility rejected", {
        code: includedCount < 1 ? "QUOTE_INCLUDED_SCOPE_REQUIRED" : "QUOTE_SNAPSHOT_INVALID",
        quoteId,
        jobId: context.job_id,
        expectedVersion,
      });
      return {
        abort: failure(
          409,
          includedCount < 1 ? "QUOTE_INCLUDED_SCOPE_REQUIRED" : "QUOTE_SNAPSHOT_INVALID",
          "The Draft Quote is not eligible to issue."
        ),
      };
    }

    for (const snapshot of snapshots) {
      const sourceValidation = await validateCanonicalSource(
        client,
        snapshot.source,
        context.job_id,
        snapshot.scopeSemantic,
        { requireCurrent: true }
      );
      if (sourceValidation.error) {
        logger.warn("Quote issue source rejected", {
          code: sourceValidation.error.code,
          quoteId,
          jobId: context.job_id,
          sourceType: snapshot.source.type,
        });
        return { abort: sourceValidation.error };
      }
    }

    const issuedAtResult = await client.query("SELECT CURRENT_TIMESTAMP AS issued_at");
    const issuedAt = issuedAtResult.rows[0].issued_at;
    const issuedVersion = expectedVersion + 1;
    const aggregate = await client.query(
      `UPDATE commercial_authority_aggregates
       SET current_version = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND current_version = $3
         AND aggregate_type = 'quote' AND owning_engine = $4
       RETURNING id`,
      [quoteId, issuedVersion, expectedVersion, OWNING_ENGINE]
    );
    if (!aggregate.rows[0]) {
      return { abort: failure(409, "STALE_QUOTE_VERSION", "The Quote version is stale.") };
    }
    const version = await insertQuoteVersion({
      client,
      quoteId,
      version: issuedVersion,
      jobId: context.job_id,
      currency: context.currency,
      actorParticipantId: context.actor_participant_id,
      snapshots,
      status: QUOTE_STATUS.ISSUED,
      issuedAt,
      customerTermsSnapshot: currentContract.customerTermsSnapshot,
    });
    if (version.error) return { abort: version.error };
    for (const snapshot of snapshots) {
      await insertSnapshot(
        client,
        quoteId,
        issuedVersion,
        context.job_id,
        context.actor_participant_id,
        snapshot
      );
    }
    const evidence = await insertQuoteEvidence({
      client,
      quoteId,
      relationshipId: Number(context.relationship_id),
      actorUserId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType: QUOTE_EVIDENCE_TYPES.ISSUED,
      commandName: QUOTE_COMMANDS.ISSUE,
      previousVersion: expectedVersion,
      resultingVersion: issuedVersion,
      totals: version.totals,
      scopeItemCount: snapshots.length,
      authorityGrantId,
      snapshotIntegrityHash: version.row.integrity_hash,
      capabilityMilestoneId: ISSUE_CAPABILITY_MILESTONE_ID,
    });
    if (!evidence) throw new Error("Canonical Quote issuance evidence creation failed.");
    await client.query(
      `INSERT INTO canonical_quote_issuances (
        quote_id, quote_version, job_id, issuer_participant_id,
        authority_grant_id, commercial_evidence_id, idempotency_id,
        issued_at, source_snapshot_integrity_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        quoteId,
        issuedVersion,
        context.job_id,
        context.actor_participant_id,
        authorityGrantId,
        evidence.id,
        idempotency.reservation.id,
        issuedAt,
        version.row.integrity_hash,
      ]
    );
    const transitioned = await client.query(
      `UPDATE canonical_quotes
       SET status = 'ISSUED', issued_at = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'DRAFT' AND issued_at IS NULL
       RETURNING id`,
      [quoteId, issuedAt]
    );
    if (!transitioned.rows[0]) {
      throw new Error("Canonical Quote issuance transition failed.");
    }
    await invokeFailure(input.failureInjector, "after_write");
    const quote = await loadQuoteProjection(client, quoteId);
    const result = quoteResult("QUOTE_ISSUED", 200, quote);
    if (!(await completeIdempotency(client, idempotency.reservation.id, quoteId, result))) {
      throw new Error("Canonical Quote issue idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Quote issued", {
        code: "QUOTE_ISSUED",
        quoteId,
        jobId: context.job_id,
        version: issuedVersion,
        issuedAt,
        totalMinor: version.totals.totalMinor,
        snapshotIntegrityHash: version.row.integrity_hash,
      }),
    };
  });
}

async function getCustomerIssuedQuote(input = {}) {
  const validated = validateRead(input, ["quoteId"]);
  if (validated.error) return validated.error;
  const quoteId = normalizedUuid(input.quoteId);
  if (!quoteId) return failure(400, "INVALID_QUOTE_ID", "A valid Quote ID is required.");
  const logger = safeLogger(input.logger);
  const context = await loadCustomerQuoteContext(input.pool, quoteId, validated.id);
  const authorityError = await requireCustomerQuoteAuthority({
    client: input.pool,
    context,
    capability: QUOTE_CAPABILITIES.READ_CUSTOMER,
    logger,
  });
  if (authorityError) return authorityError;
  if (context.status !== QUOTE_STATUS.ISSUED) {
    return failure(404, "QUOTE_UNAVAILABLE", "The Quote is unavailable.");
  }
  const quote = await loadQuoteProjection(input.pool, quoteId);
  const decisionPending = quote.decisionState == null;
  const [canApprove, canDecline] = decisionPending
    ? await Promise.all([
        hasActiveLifecycleGrant({
          client: input.pool,
          participantId: context.actor_participant_id,
          capability: QUOTE_CAPABILITIES.APPROVE,
          jobId: context.job_id,
          logger,
        }),
        hasActiveLifecycleGrant({
          client: input.pool,
          participantId: context.actor_participant_id,
          capability: QUOTE_CAPABILITIES.DECLINE,
          jobId: context.job_id,
          logger,
        }),
      ])
    : [false, false];
  return {
    ok: true,
    success: true,
    status: 200,
    code: "CUSTOMER_QUOTE_FOUND",
    quote: customerQuoteDetailProjection(quote, { canApprove, canDecline }),
  };
}

async function decideIssuedQuote(input = {}, decision) {
  const validated = validateCommand(input, ["quoteId", "expectedIssuedVersion"]);
  if (validated.error) return validated.error;
  const quoteId = normalizedUuid(input.quoteId);
  const expectedIssuedVersion = positiveInteger(input.expectedIssuedVersion);
  if (!quoteId || !expectedIssuedVersion || !QUOTE_DECISIONS.includes(decision)) {
    return failure(400, "INVALID_QUOTE_DECISION", "The Quote decision command is invalid.");
  }
  const capability = decision === "APPROVED"
    ? QUOTE_CAPABILITIES.APPROVE
    : QUOTE_CAPABILITIES.DECLINE;
  const commandName = decision === "APPROVED"
    ? QUOTE_COMMANDS.APPROVE
    : QUOTE_COMMANDS.DECLINE;
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadCustomerQuoteContext(
      client,
      quoteId,
      validated.actorId,
      { lock: true }
    );
    const authorityError = await requireCustomerQuoteAuthority({
      client,
      context,
      capability,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const authorityGrantId = await loadActiveQuoteGrant(client, context, capability);
    if (!authorityGrantId) {
      return { abort: failure(403, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED", "Customer Quote authority is required.") };
    }
    const requestFingerprint = fingerprint({
      command: commandName,
      quoteId,
      expectedIssuedVersion,
      decision,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName,
      commandScope: `quote:${quoteId}:customer-decision`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Customer Quote decision replayed", {
          code: "QUOTE_DECISION_REPLAYED",
          quoteId,
          jobId: context.job_id,
          decision,
        }),
      };
    }
    logger.info("Customer Quote decision attempted", {
      code: "QUOTE_DECISION_ATTEMPTED",
      quoteId,
      jobId: context.job_id,
      decision,
      expectedIssuedVersion,
    });
    if (
      context.status !== QUOTE_STATUS.ISSUED ||
      Number(context.current_version) !== expectedIssuedVersion
    ) {
      return { abort: failure(409, "ISSUED_QUOTE_VERSION_REQUIRED", "The exact issued Quote version is required.") };
    }
    if (context.decision_id) {
      logger.warn("Customer Quote decision conflict", {
        code: "QUOTE_DECISION_FINAL",
        quoteId,
        jobId: context.job_id,
        existingDecision: context.decision,
      });
      return { abort: failure(409, "QUOTE_DECISION_FINAL", "The Quote already has a terminal customer decision.") };
    }
    const issuance = await client.query(
      `SELECT quote_version, source_snapshot_integrity_hash
       FROM canonical_quote_issuances
       WHERE quote_id = $1 AND quote_version = $2 AND job_id = $3
       LIMIT 1`,
      [quoteId, expectedIssuedVersion, context.job_id]
    );
    if (!issuance.rows[0]) {
      return { abort: failure(409, "ISSUED_QUOTE_VERSION_REQUIRED", "The exact issued Quote version is required.") };
    }
    const decisionResult = await client.query(
      `INSERT INTO canonical_quote_customer_decisions (
        id, quote_id, issued_quote_version, job_id, relationship_id,
        customer_participant_id, authority_grant_id, decision,
        idempotency_id, issued_integrity_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        randomUUID(),
        quoteId,
        expectedIssuedVersion,
        context.job_id,
        Number(context.relationship_id),
        context.actor_participant_id,
        authorityGrantId,
        decision,
        idempotency.reservation.id,
        issuance.rows[0].source_snapshot_integrity_hash,
      ]
    );
    await invokeFailure(input.failureInjector, "after_write");
    const quote = await loadQuoteProjection(client, quoteId);
    const customerDecision = {
      id: decisionResult.rows[0].id,
      quoteId,
      issuedQuoteVersion: expectedIssuedVersion,
      decision,
      decidedAt: decisionResult.rows[0].decided_at,
      issuedIntegrityHash: decisionResult.rows[0].issued_integrity_hash,
    };
    const result = quoteResult("QUOTE_CUSTOMER_DECISION_RECORDED", 200, quote, {
      customerDecision,
    });
    if (!(await completeIdempotency(client, idempotency.reservation.id, quoteId, result))) {
      throw new Error("Customer Quote decision idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Customer Quote decision recorded", {
        code: "QUOTE_CUSTOMER_DECISION_RECORDED",
        quoteId,
        jobId: context.job_id,
        issuedQuoteVersion: expectedIssuedVersion,
        decision,
      }),
    };
  });
}

function approveIssuedQuote(input = {}) {
  return decideIssuedQuote(input, "APPROVED");
}

function declineIssuedQuote(input = {}) {
  return decideIssuedQuote(input, "DECLINED");
}

async function createDerivedDraftQuote(input = {}) {
  const validated = validateCommand(input, [
    "parentQuoteId",
    "expectedIssuedVersion",
    "lineageType",
    "reasonCategory",
  ]);
  if (validated.error) return validated.error;
  const parentQuoteId = normalizedUuid(input.parentQuoteId);
  const expectedIssuedVersion = positiveInteger(input.expectedIssuedVersion);
  const lineageType = String(input.lineageType || "").trim().toUpperCase();
  const reasonCategory = String(input.reasonCategory || "").trim().toUpperCase();
  if (
    !parentQuoteId ||
    !expectedIssuedVersion ||
    !QUOTE_LINEAGE_TYPES.includes(lineageType) ||
    !QUOTE_LINEAGE_REASONS.includes(reasonCategory)
  ) {
    return failure(400, "INVALID_QUOTE_REVISION", "The derived Quote command is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadQuoteContext(client, parentQuoteId, validated.actorId, { lock: true });
    const authorityError = await requireQuoteAuthority({
      client,
      context,
      capability: QUOTE_CAPABILITIES.REVISE,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const requestFingerprint = fingerprint({
      command: QUOTE_COMMANDS.REVISE,
      parentQuoteId,
      expectedIssuedVersion,
      lineageType,
      reasonCategory,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: QUOTE_COMMANDS.REVISE,
      commandScope: `quote:${parentQuoteId}:derived`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Derived Quote create replayed", {
          code: "QUOTE_REVISION_REPLAYED",
          parentQuoteId,
          jobId: context.job_id,
        }),
      };
    }
    if (
      context.status !== QUOTE_STATUS.ISSUED ||
      Number(context.current_version) !== expectedIssuedVersion
    ) {
      return { abort: failure(409, "ISSUED_QUOTE_VERSION_REQUIRED", "The exact issued Quote version is required.") };
    }
    const authorityGrantId = await loadActiveQuoteGrant(
      client,
      context,
      QUOTE_CAPABILITIES.REVISE
    );
    if (!authorityGrantId) {
      return { abort: failure(403, "QUOTE_AUTHORITY_REQUIRED", "Quote authority is required.") };
    }
    const existingDraft = await client.query(
      `SELECT id FROM canonical_quotes
       WHERE job_id = $1 AND status = 'DRAFT'
       LIMIT 1 FOR UPDATE`,
      [context.job_id]
    );
    if (existingDraft.rows[0]) {
      return { abort: failure(409, "QUOTE_REVISION_ALREADY_EXISTS", "A derived Draft Quote already exists for this Job.") };
    }

    const quoteId = randomUUID();
    await client.query(
      `INSERT INTO commercial_authority_aggregates (
        id, aggregate_type, owning_engine, source_context_type,
        ordinary_request_id, emergency_request_id, relationship_id,
        source_owner_user_id, created_by_user_id, current_version
      ) VALUES ($1, 'quote', $2, 'ordinary_request', $3, NULL, $4, $5, $6, 1)`,
      [
        quoteId,
        OWNING_ENGINE,
        Number(context.job_request_id),
        Number(context.relationship_id),
        Number(context.homeowner_user_id),
        validated.actorId,
      ]
    );
    await client.query(
      `INSERT INTO canonical_quotes (
        id, job_id, job_request_id, relationship_id,
        issuer_participant_id, parent_quote_id, lineage_type,
        lineage_reason_category, currency, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT')`,
      [
        quoteId,
        context.job_id,
        Number(context.job_request_id),
        Number(context.relationship_id),
        context.actor_participant_id,
        parentQuoteId,
        lineageType,
        reasonCategory,
        context.currency,
      ]
    );
    const version = await insertQuoteVersion({
      client,
      quoteId,
      version: 1,
      jobId: context.job_id,
      currency: context.currency,
      actorParticipantId: context.actor_participant_id,
      snapshots: [],
    });
    if (!version.row) throw new Error("Derived Quote version creation failed.");
    const evidence = await insertQuoteEvidence({
      client,
      quoteId,
      relationshipId: Number(context.relationship_id),
      actorUserId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType: QUOTE_EVIDENCE_TYPES.REVISION_CREATED,
      commandName: QUOTE_COMMANDS.REVISE,
      previousVersion: 0,
      resultingVersion: 1,
      totals: version.totals,
      scopeItemCount: 0,
      authorityGrantId,
      snapshotIntegrityHash: version.row.integrity_hash,
      capabilityMilestoneId: CUSTOMER_CAPABILITY_MILESTONE_ID,
    });
    if (!evidence) throw new Error("Derived Quote evidence creation failed.");
    await invokeFailure(input.failureInjector, "after_write");
    const quote = await loadQuoteProjection(client, quoteId);
    const result = quoteResult("DERIVED_DRAFT_QUOTE_CREATED", 201, quote);
    if (!(await completeIdempotency(client, idempotency.reservation.id, quoteId, result))) {
      throw new Error("Derived Quote idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Derived Draft Quote created", {
        code: "DERIVED_DRAFT_QUOTE_CREATED",
        quoteId,
        parentQuoteId,
        jobId: context.job_id,
        lineageType,
        reasonCategory,
      }),
    };
  });
}

async function getDraftQuote(input = {}) {
  const validated = validateRead(input, ["quoteId"]);
  if (validated.error) return validated.error;
  const quoteId = normalizedUuid(input.quoteId);
  if (!quoteId) return failure(400, "INVALID_QUOTE_ID", "A valid Quote ID is required.");
  const logger = safeLogger(input.logger);
  const context = await loadQuoteContext(input.pool, quoteId, validated.id);
  const authorityError = await requireQuoteAuthority({
    client: input.pool,
    context,
    capability: QUOTE_CAPABILITIES.READ,
    logger,
  });
  if (authorityError) return authorityError;
  return quoteResult("DRAFT_QUOTE_FOUND", 200, await loadQuoteProjection(input.pool, quoteId));
}

async function listDraftQuotesByJob(input = {}) {
  const validated = validateRead(input, ["jobId"]);
  if (validated.error) return validated.error;
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) return failure(400, "INVALID_JOB_ID", "A valid Job ID is required.");
  const logger = safeLogger(input.logger);
  const context = await loadJobContext(input.pool, jobId, validated.id);
  const authorityError = await requireQuoteAuthority({
    client: input.pool,
    context,
    capability: QUOTE_CAPABILITIES.READ,
    logger,
  });
  if (authorityError) return authorityError;
  const ids = await input.pool.query(
    `SELECT id FROM canonical_quotes WHERE job_id = $1
     ORDER BY updated_at DESC, id DESC`,
    [jobId]
  );
  const quotes = [];
  for (const row of ids.rows) quotes.push(await loadQuoteProjection(input.pool, row.id));
  return {
    ok: true,
    success: true,
    status: 200,
    code: "JOB_DRAFT_QUOTES_FOUND",
    authoritySource: AUTHORITY_SOURCE,
    quotes,
  };
}

module.exports = {
  CAPABILITY_MILESTONE_ID,
  CUSTOMER_CAPABILITY_MILESTONE_ID,
  CLASSIFICATIONS,
  MATERIAL_RESPONSIBILITIES,
  QUOTE_CAPABILITIES,
  QUOTE_COMMANDS,
  QUOTE_EVIDENCE_TYPES,
  QUOTE_DECISIONS,
  QUOTE_LINEAGE_REASONS,
  QUOTE_LINEAGE_TYPES,
  QUOTE_STATUS,
  SCOPE_SEMANTICS,
  SOURCE_TYPES,
  addDraftScopeItem,
  approveIssuedQuote,
  calculateTotals,
  createDraftQuote,
  createDerivedDraftQuote,
  declineIssuedQuote,
  getCustomerIssuedQuote,
  getDraftQuote,
  issueQuote,
  listDraftQuotesByJob,
  removeDraftScopeItem,
  validateScopeItem,
  quoteDraftServiceInternals: Object.freeze({
    CUSTOMER_TERMS_SCHEMA_VERSION,
    QUOTE_INTEGRITY_VERSION_V1,
    QUOTE_INTEGRITY_VERSION_V2,
    customerQuoteDetailProjection,
    deriveCommercialSnapshots,
    integrityHash,
    loadQuoteContext,
    loadQuoteProjection,
    persistedSnapshotIsValid,
    normalizeCustomerTermsSnapshot,
    quoteIntegrityContract,
    requireQuoteAuthority,
  }),
};
