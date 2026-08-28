"use strict";

const {
  commercialAuthorityInternals,
} = require("./commercialAuthorityService");
const {
  quoteDeliveryFingerprintMap,
} = require("./quoteDeliveryAuthority");

const {
  databaseClient,
  failure,
  isPlainObject,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_VERSION = 1;
const FILTERS = Object.freeze({
  all: null,
  draft: "DRAFT",
  delivery_pending: "DELIVERY_PENDING",
  waiting_on_customer: "WAITING_ON_CUSTOMER",
  approved: "APPROVED",
  declined: "DECLINED",
});

function iso(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizedUuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function encodeCursor({ actorId, classification, priority, activityAt, quoteId }) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    actorId,
    classification,
    priority,
    activityAt,
    quoteId,
  })).toString("base64url");
}

function decodeCursor(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const keys = Object.keys(parsed || {}).sort();
    if (
      !isPlainObject(parsed) ||
      JSON.stringify(keys) !== JSON.stringify([
        "activityAt",
        "actorId",
        "classification",
        "priority",
        "quoteId",
        "v",
      ]) ||
      parsed.v !== CURSOR_VERSION ||
      !Number.isSafeInteger(parsed.actorId) ||
      parsed.actorId < 1 ||
      !Object.hasOwn(FILTERS, parsed.classification) ||
      !Number.isInteger(parsed.priority) ||
      parsed.priority < 1 ||
      parsed.priority > 5 ||
      iso(parsed.activityAt) !== parsed.activityAt ||
      !normalizedUuid(parsed.quoteId)
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function validatedInput(input) {
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    "classification",
    "limit",
    "cursor",
  ]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: failure(400, "PROFESSIONAL_QUOTES_FIELD_REJECTED", "The Quotes read is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const classification = input.classification == null
    ? "all"
    : String(input.classification).trim().toLowerCase();
  if (!Object.hasOwn(FILTERS, classification)) {
    return { error: failure(400, "INVALID_QUOTES_CLASSIFICATION", "The Quotes classification is invalid.") };
  }
  const limit = input.limit == null ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: failure(400, "INVALID_QUOTES_LIMIT", "The Quotes limit is invalid.") };
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor === undefined) {
    return { error: failure(400, "INVALID_QUOTES_CURSOR", "The Quotes cursor is invalid.") };
  }
  if (cursor && (cursor.actorId !== actor.id || cursor.classification !== classification)) {
    return { error: failure(400, "QUOTES_CURSOR_SCOPE_MISMATCH", "The Quotes cursor is invalid for this read.") };
  }
  return {
    actorId: actor.id,
    classification,
    classificationValue: FILTERS[classification],
    limit,
    cursor,
  };
}

async function runReadTransaction(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    started = true;
    const result = await action(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

const AUTHORIZED_QUOTES_CTE = `
  authorized_quotes AS (
    SELECT
      quotes.id,
      quotes.job_id,
      quotes.parent_quote_id,
      quotes.lineage_type,
      quotes.status,
      quotes.currency,
      quotes.issued_at,
      quotes.created_at,
      quotes.updated_at,
      versions.total_minor,
      decisions.decision AS customer_decision,
      decisions.issued_quote_version AS decision_version,
      decisions.decided_at,
      posts.title AS job_title,
      posts.category AS job_service,
      customers.username AS customer_name,
      CASE
        WHEN quotes.status = 'DRAFT' AND decisions.id IS NULL THEN 'DRAFT'
        WHEN quotes.status = 'ISSUED' AND delivery.id IS NULL THEN 'DELIVERY_PENDING'
        WHEN quotes.status = 'ISSUED' AND decisions.id IS NULL THEN 'WAITING_ON_CUSTOMER'
        WHEN quotes.status = 'ISSUED' AND decisions.decision = 'APPROVED'
          AND decisions.issued_quote_version = aggregates.current_version THEN 'APPROVED'
        WHEN quotes.status = 'ISSUED' AND decisions.decision = 'DECLINED'
          AND decisions.issued_quote_version = aggregates.current_version THEN 'DECLINED'
        ELSE NULL
      END AS classification,
      CASE
        WHEN quotes.status = 'DRAFT' AND decisions.id IS NULL THEN 1
        WHEN quotes.status = 'ISSUED' AND delivery.id IS NULL THEN 2
        WHEN quotes.status = 'ISSUED' AND decisions.id IS NULL THEN 3
        WHEN quotes.status = 'ISSUED' AND decisions.decision = 'APPROVED'
          AND decisions.issued_quote_version = aggregates.current_version THEN 4
        WHEN quotes.status = 'ISSUED' AND decisions.decision = 'DECLINED'
          AND decisions.issued_quote_version = aggregates.current_version THEN 5
        ELSE NULL
      END AS classification_priority,
      GREATEST(
        quotes.updated_at,
        COALESCE(quotes.issued_at, quotes.updated_at),
        COALESCE(decisions.decided_at, quotes.updated_at)
      ) AS last_activity_at,
      EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants continue_grants
        LEFT JOIN lifecycle_authority_grant_revocations continue_revocations
          ON continue_revocations.authority_grant_id = continue_grants.id
        WHERE continue_grants.grantee_participant_id = professional.id
          AND continue_grants.capability = 'quote.scope.manage'
          AND continue_grants.job_id = quotes.job_id
          AND continue_grants.scope_type = 'job'
          AND continue_grants.scope_job_id = quotes.job_id
          AND continue_grants.valid_from <= CURRENT_TIMESTAMP
          AND (continue_grants.valid_until IS NULL OR continue_grants.valid_until > CURRENT_TIMESTAMP)
          AND continue_revocations.id IS NULL
      ) AS can_manage_scope,
      (
        EXISTS (
          SELECT 1
          FROM lifecycle_authority_grants participant_read_grants
          LEFT JOIN lifecycle_authority_grant_revocations participant_read_revocations
            ON participant_read_revocations.authority_grant_id = participant_read_grants.id
          WHERE participant_read_grants.grantee_participant_id = professional.id
            AND participant_read_grants.capability = 'participant.read'
            AND participant_read_grants.job_id = quotes.job_id
            AND participant_read_grants.scope_type = 'job'
            AND participant_read_grants.scope_job_id = quotes.job_id
            AND participant_read_grants.valid_from <= CURRENT_TIMESTAMP
            AND (participant_read_grants.valid_until IS NULL
              OR participant_read_grants.valid_until > CURRENT_TIMESTAMP)
            AND participant_read_revocations.id IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM lifecycle_authority_grants concern_read_grants
          LEFT JOIN lifecycle_authority_grant_revocations concern_read_revocations
            ON concern_read_revocations.authority_grant_id = concern_read_grants.id
          WHERE concern_read_grants.grantee_participant_id = professional.id
            AND concern_read_grants.capability = 'reported_concern.read'
            AND concern_read_grants.job_id = quotes.job_id
            AND concern_read_grants.scope_type = 'job'
            AND concern_read_grants.scope_job_id = quotes.job_id
            AND concern_read_grants.valid_from <= CURRENT_TIMESTAMP
            AND (concern_read_grants.valid_until IS NULL
              OR concern_read_grants.valid_until > CURRENT_TIMESTAMP)
            AND concern_read_revocations.id IS NULL
        )
      ) AS can_view_job
    FROM canonical_quotes quotes
    INNER JOIN commercial_authority_aggregates aggregates
      ON aggregates.id = quotes.id
      AND aggregates.aggregate_type = 'quote'
      AND aggregates.owning_engine = 'authorization_engine'
    INNER JOIN canonical_quote_versions versions
      ON versions.quote_id = quotes.id
      AND versions.version = aggregates.current_version
    INNER JOIN jobs
      ON jobs.id = quotes.job_id
      AND jobs.job_request_id = quotes.job_request_id
      AND jobs.source_request_relationship_id = quotes.relationship_id
      AND jobs.lifecycle_contract_version = 2
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
      AND posts.cancelled_at IS NULL
    INNER JOIN request_relationships relationships
      ON relationships.id = quotes.relationship_id
      AND relationships.post_id = quotes.job_request_id
      AND relationships.emergency_request_id IS NULL
      AND relationships.status = 'active'
      AND relationships.professional_user_id = $1
    INNER JOIN relationship_participants professional
      ON professional.job_id = quotes.job_id
      AND professional.request_relationship_id = quotes.relationship_id
      AND professional.user_id = $1
    INNER JOIN participant_role_assignments professional_roles
      ON professional_roles.participant_id = professional.id
      AND professional_roles.job_id = quotes.job_id
      AND professional_roles.role = 'PRIMARY_PROFESSIONAL'
      AND professional_roles.valid_from <= CURRENT_TIMESTAMP
      AND (professional_roles.valid_until IS NULL OR professional_roles.valid_until > CURRENT_TIMESTAMP)
    LEFT JOIN participant_role_revocations professional_role_revocations
      ON professional_role_revocations.role_assignment_id = professional_roles.id
    INNER JOIN users customers ON customers.id = relationships.homeowner_id
    LEFT JOIN LATERAL (
      SELECT deliveries.id
      FROM messages deliveries
      INNER JOIN conversations delivery_conversations
        ON delivery_conversations.id = deliveries.conversation_id
        AND delivery_conversations.relationship_id = quotes.relationship_id
        AND delivery_conversations.homeowner_id = relationships.homeowner_id
        AND delivery_conversations.professional_user_id = $1
        AND delivery_conversations.status = 'active'
      WHERE deliveries.quote_id = quotes.id
        AND deliveries.job_id = quotes.job_id
        AND deliveries.sender_id = $1
        AND deliveries.receiver_id = relationships.homeowner_id
        AND deliveries.message_type = 'quote_shared'
        AND deliveries.workflow_type = 'QUOTE_SHARED'
        AND deliveries.workflow_status = 'SENT'
        AND deliveries.delivery_request_fingerprint =
          COALESCE($2::jsonb ->> quotes.id::text, '')
        AND deliveries.workflow_payload ->> 'quoteId' = quotes.id::text
        AND deliveries.workflow_payload ->> 'jobId' = quotes.job_id::text
      ORDER BY deliveries.id ASC
      LIMIT 1
    ) delivery ON TRUE
    LEFT JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id
    WHERE professional_role_revocations.id IS NULL
      AND EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants read_grants
        LEFT JOIN lifecycle_authority_grant_revocations read_revocations
          ON read_revocations.authority_grant_id = read_grants.id
        WHERE read_grants.grantee_participant_id = professional.id
          AND read_grants.capability = 'quote.read'
          AND read_grants.job_id = quotes.job_id
          AND read_grants.scope_type = 'job'
          AND read_grants.scope_job_id = quotes.job_id
          AND read_grants.valid_from <= CURRENT_TIMESTAMP
          AND (read_grants.valid_until IS NULL OR read_grants.valid_until > CURRENT_TIMESTAMP)
          AND read_revocations.id IS NULL
      )
      AND (
        (quotes.parent_quote_id IS NULL AND quotes.lineage_type IS NULL)
        OR (quotes.parent_quote_id IS NOT NULL
          AND quotes.lineage_type IN ('REVISED_QUOTE', 'SUPPLEMENTAL_QUOTE'))
      )
      AND (
        (quotes.status = 'DRAFT' AND quotes.issued_at IS NULL AND decisions.id IS NULL)
        OR (quotes.status = 'ISSUED' AND quotes.issued_at IS NOT NULL
          AND (decisions.id IS NULL OR (
            decisions.decision IN ('APPROVED', 'DECLINED')
            AND decisions.issued_quote_version = aggregates.current_version
          )))
      )
  )`;

async function loadSummary(client, actorId, deliveryFingerprints) {
  const result = await client.query(
    `WITH ${AUTHORIZED_QUOTES_CTE}
    SELECT
      COUNT(*) FILTER (WHERE classification = 'DRAFT') AS drafts,
      COUNT(*) FILTER (WHERE classification = 'DELIVERY_PENDING') AS delivery_pending,
      COUNT(*) FILTER (WHERE classification = 'WAITING_ON_CUSTOMER') AS waiting_on_customer,
      COUNT(*) FILTER (WHERE classification = 'APPROVED') AS approved,
      COUNT(*) FILTER (WHERE classification = 'DECLINED') AS declined
    FROM authorized_quotes
    WHERE classification IS NOT NULL`,
    [actorId, JSON.stringify(deliveryFingerprints)]
  );
  const row = result.rows[0] || {};
  return {
    drafts: Number(row.drafts || 0),
    deliveryPending: Number(row.delivery_pending || 0),
    waitingOnCustomer: Number(row.waiting_on_customer || 0),
    approved: Number(row.approved || 0),
    declined: Number(row.declined || 0),
  };
}

async function loadPage(
  client,
  { actorId, classificationValue, cursor, limit, deliveryFingerprints }
) {
  const result = await client.query(
    `WITH ${AUTHORIZED_QUOTES_CTE}
    SELECT
      id, job_id, parent_quote_id, lineage_type, status, currency,
      issued_at, created_at, updated_at, total_minor, customer_decision,
      decided_at, job_title, job_service, customer_name, classification,
      classification_priority, last_activity_at, can_manage_scope, can_view_job
    FROM authorized_quotes
    WHERE classification IS NOT NULL
      AND ($3::text IS NULL OR classification = $3)
      AND (
        $4::integer IS NULL
        OR classification_priority > $4
        OR (classification_priority = $4 AND last_activity_at < $5::timestamptz)
        OR (classification_priority = $4 AND last_activity_at = $5::timestamptz AND id > $6::uuid)
      )
    ORDER BY classification_priority ASC, last_activity_at DESC, id ASC
    LIMIT $7`,
    [
      actorId,
      JSON.stringify(deliveryFingerprints),
      classificationValue,
      cursor?.priority ?? null,
      cursor?.activityAt ?? null,
      cursor?.quoteId ?? null,
      limit + 1,
    ]
  );
  return result.rows;
}

async function loadProfessionalQuoteDeliveryFingerprints(client, actorId) {
  const result = await client.query(
    `SELECT quotes.id, aggregates.current_version
     FROM canonical_quotes quotes
     INNER JOIN commercial_authority_aggregates aggregates
       ON aggregates.id = quotes.id
       AND aggregates.aggregate_type = 'quote'
       AND aggregates.owning_engine = 'authorization_engine'
     INNER JOIN request_relationships relationships
       ON relationships.id = quotes.relationship_id
       AND relationships.professional_user_id = $1
       AND relationships.status = 'active'
       AND relationships.emergency_request_id IS NULL
     WHERE quotes.status = 'ISSUED'
       AND quotes.issued_at IS NOT NULL`,
    [actorId]
  );
  return quoteDeliveryFingerprintMap(result.rows, actorId);
}

function lineageLabel(type) {
  if (type === "REVISED_QUOTE") return "Revised";
  if (type === "SUPPLEMENTAL_QUOTE") return "Additional";
  return "Original";
}

function quoteProjection(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    classification: row.classification,
    status: row.status,
    customerDecision: row.customer_decision || null,
    totalMinor: Number(row.total_minor),
    currency: row.currency,
    lineageType: row.lineage_type || null,
    lineageLabel: lineageLabel(row.lineage_type),
    parentQuoteId: row.parent_quote_id || null,
    customer: {
      displayName: String(row.customer_name || "").trim() || "Customer",
    },
    job: {
      title: String(row.job_title || "").trim() || String(row.job_service || "").trim() || "Job",
      service: String(row.job_service || "").trim() || null,
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    issuedAt: iso(row.issued_at),
    decidedAt: iso(row.decided_at),
    lastActivityAt: iso(row.last_activity_at),
    actions: {
      canViewQuote: true,
      canContinueDraft: row.classification === "DRAFT" && row.can_manage_scope === true,
      canViewJob: row.can_view_job === true,
    },
  };
}

async function getProfessionalQuotes(input = {}) {
  const validated = validatedInput(input);
  if (validated.error) return validated.error;
  return runReadTransaction(input.pool, async (client) => {
    const deliveryFingerprints = await loadProfessionalQuoteDeliveryFingerprints(
      client,
      validated.actorId
    );
    const summary = await loadSummary(client, validated.actorId, deliveryFingerprints);
    const rows = await loadPage(client, { ...validated, deliveryFingerprints });
    const hasMore = rows.length > validated.limit;
    const pageRows = hasMore ? rows.slice(0, validated.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      ok: true,
      success: true,
      status: 200,
      code: "PROFESSIONAL_QUOTES_LOADED",
      classification: validated.classification,
      summary,
      quotes: pageRows.map(quoteProjection),
      pagination: {
        limit: validated.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({
          actorId: validated.actorId,
          classification: validated.classification,
          priority: Number(last.classification_priority),
          activityAt: iso(last.last_activity_at),
          quoteId: last.id,
        }) : null,
      },
    };
  });
}

module.exports = {
  getProfessionalQuotes,
  professionalQuotesInternals: Object.freeze({
    decodeCursor,
    encodeCursor,
    lineageLabel,
    loadProfessionalQuoteDeliveryFingerprints,
    quoteProjection,
  }),
};
