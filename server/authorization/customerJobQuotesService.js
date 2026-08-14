"use strict";

const {
  commercialAuthorityInternals,
} = require("./commercialAuthorityService");

const {
  databaseClient,
  failure,
  isPlainObject,
  normalizedUuid,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const CURSOR_VERSION = 1;

function iso(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function encodeCursor({ actorId, jobId, priority, activityAt, quoteId }) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    actorId,
    jobId,
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
        "jobId",
        "priority",
        "quoteId",
        "v",
      ]) ||
      parsed.v !== CURSOR_VERSION ||
      !Number.isSafeInteger(parsed.actorId) ||
      parsed.actorId < 1 ||
      !normalizedUuid(parsed.jobId) ||
      !Number.isInteger(parsed.priority) ||
      parsed.priority < 1 ||
      parsed.priority > 3 ||
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
    "jobId",
    "limit",
    "cursor",
  ]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return {
      error: failure(
        400,
        "CUSTOMER_JOB_QUOTES_FIELD_REJECTED",
        "The customer Quotes read is invalid."
      ),
    };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return {
      error: failure(
        400,
        "INVALID_CUSTOMER_JOB_ID",
        "A valid Job ID is required."
      ),
    };
  }
  const limit = input.limit == null ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return {
      error: failure(
        400,
        "INVALID_CUSTOMER_QUOTES_LIMIT",
        "The customer Quotes limit is invalid."
      ),
    };
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor === undefined) {
    return {
      error: failure(
        400,
        "INVALID_CUSTOMER_QUOTES_CURSOR",
        "The customer Quotes cursor is invalid."
      ),
    };
  }
  if (cursor && (cursor.actorId !== actor.id || cursor.jobId !== jobId)) {
    return {
      error: failure(
        400,
        "CUSTOMER_QUOTES_CURSOR_SCOPE_MISMATCH",
        "The customer Quotes cursor is invalid for this read."
      ),
    };
  }
  return { actorId: actor.id, jobId, limit, cursor };
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

async function loadCustomerJobContext(client, { actorId, jobId }) {
  const result = await client.query(
    `SELECT
      jobs.id AS job_id,
      jobs.lifecycle_contract_version,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.status AS relationship_status,
      participants.id AS actor_participant_id,
      posts.title AS job_title,
      posts.category AS job_service,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'CUSTOMER_REPRESENTATIVE'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_customer_representative,
      EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.capability = 'quote.read_customer'
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS can_read_customer_quotes
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
    LIMIT 1`,
    [jobId, actorId]
  );
  return result.rows[0] || null;
}

function customerContextUnavailable(context) {
  return Boolean(
    !context ||
    Number(context.lifecycle_contract_version) !== 2 ||
    context.relationship_status !== "active" ||
    !context.actor_participant_id ||
    context.actor_is_customer_representative !== true ||
    context.can_read_customer_quotes !== true
  );
}

async function loadCustomerQuotePage(
  client,
  { actorId, jobId, limit, cursor, relationshipId, participantId }
) {
  const result = await client.query(
    `SELECT
      quotes.id,
      quotes.job_id,
      quotes.status,
      quotes.currency,
      quotes.lineage_type,
      quotes.created_at,
      quotes.updated_at,
      quotes.issued_at,
      versions.total_minor,
      decisions.decision AS customer_decision,
      decisions.decided_at,
      CASE
        WHEN decisions.id IS NULL THEN 'WAITING_ON_CUSTOMER'
        WHEN decisions.decision = 'APPROVED' THEN 'APPROVED'
        WHEN decisions.decision = 'DECLINED' THEN 'DECLINED'
      END AS business_status,
      CASE
        WHEN decisions.id IS NULL THEN 1
        WHEN decisions.decision = 'APPROVED' THEN 2
        WHEN decisions.decision = 'DECLINED' THEN 3
      END AS relevance_priority,
      GREATEST(
        quotes.updated_at,
        quotes.issued_at,
        COALESCE(decisions.decided_at, quotes.updated_at)
      ) AS last_activity_at,
      EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = customer.id
          AND grants.capability = 'quote.approve'
          AND grants.job_id = quotes.job_id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = quotes.job_id
          AND grants.scope_concern_id IS NULL
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS has_approve_authority,
      EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = customer.id
          AND grants.capability = 'quote.decline'
          AND grants.job_id = quotes.job_id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = quotes.job_id
          AND grants.scope_concern_id IS NULL
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS has_decline_authority
    FROM canonical_quotes quotes
    INNER JOIN commercial_authority_aggregates aggregates
      ON aggregates.id = quotes.id
      AND aggregates.aggregate_type = 'quote'
      AND aggregates.owning_engine = 'authorization_engine'
    INNER JOIN canonical_quote_versions versions
      ON versions.quote_id = quotes.id
      AND versions.job_id = quotes.job_id
      AND versions.version = aggregates.current_version
      AND versions.status = 'ISSUED'
    INNER JOIN canonical_quote_issuances issuances
      ON issuances.quote_id = quotes.id
      AND issuances.job_id = quotes.job_id
      AND issuances.quote_version = aggregates.current_version
    INNER JOIN jobs
      ON jobs.id = quotes.job_id
      AND jobs.job_request_id = quotes.job_request_id
      AND jobs.source_request_relationship_id = quotes.relationship_id
      AND jobs.lifecycle_contract_version = 2
    INNER JOIN request_relationships relationships
      ON relationships.id = quotes.relationship_id
      AND relationships.id = $3
      AND relationships.post_id = quotes.job_request_id
      AND relationships.emergency_request_id IS NULL
      AND relationships.status = 'active'
    INNER JOIN relationship_participants customer
      ON customer.id = $4
      AND customer.job_id = quotes.job_id
      AND customer.request_relationship_id = quotes.relationship_id
      AND customer.user_id = $2
    LEFT JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id
      AND decisions.job_id = quotes.job_id
      AND decisions.relationship_id = quotes.relationship_id
      AND decisions.issued_quote_version = aggregates.current_version
    WHERE quotes.job_id = $1
      AND quotes.status = 'ISSUED'
      AND quotes.issued_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = customer.id
          AND roles.job_id = quotes.job_id
          AND roles.role = 'CUSTOMER_REPRESENTATIVE'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = customer.id
          AND grants.capability = 'quote.read_customer'
          AND grants.job_id = quotes.job_id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = quotes.job_id
          AND grants.scope_concern_id IS NULL
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      )
      AND (
        (quotes.parent_quote_id IS NULL AND quotes.lineage_type IS NULL)
        OR (quotes.parent_quote_id IS NOT NULL
          AND quotes.lineage_type IN ('REVISED_QUOTE', 'SUPPLEMENTAL_QUOTE'))
      )
      AND (
        $5::integer IS NULL
        OR CASE
          WHEN decisions.id IS NULL THEN 1
          WHEN decisions.decision = 'APPROVED' THEN 2
          WHEN decisions.decision = 'DECLINED' THEN 3
        END > $5
        OR (
          CASE
            WHEN decisions.id IS NULL THEN 1
            WHEN decisions.decision = 'APPROVED' THEN 2
            WHEN decisions.decision = 'DECLINED' THEN 3
          END = $5
          AND GREATEST(
            quotes.updated_at,
            quotes.issued_at,
            COALESCE(decisions.decided_at, quotes.updated_at)
          ) < $6::timestamptz
        )
        OR (
          CASE
            WHEN decisions.id IS NULL THEN 1
            WHEN decisions.decision = 'APPROVED' THEN 2
            WHEN decisions.decision = 'DECLINED' THEN 3
          END = $5
          AND GREATEST(
            quotes.updated_at,
            quotes.issued_at,
            COALESCE(decisions.decided_at, quotes.updated_at)
          ) = $6::timestamptz
          AND quotes.id > $7::uuid
        )
      )
    ORDER BY relevance_priority ASC, last_activity_at DESC, quotes.id ASC
    LIMIT $8`,
    [
      jobId,
      actorId,
      relationshipId,
      participantId,
      cursor?.priority ?? null,
      cursor?.activityAt ?? null,
      cursor?.quoteId ?? null,
      limit + 1,
    ]
  );
  return result.rows;
}

function lineageLabel(type) {
  if (type === "REVISED_QUOTE") return "Revised";
  if (type === "SUPPLEMENTAL_QUOTE") return "Additional";
  return "Original";
}

function quoteProjection(row) {
  const waiting = row.business_status === "WAITING_ON_CUSTOMER";
  return {
    quoteId: row.id,
    jobId: row.job_id,
    businessStatus: row.business_status,
    status: row.status,
    customerDecision: row.customer_decision || null,
    totalMinor: Number(row.total_minor),
    currency: row.currency,
    lineageLabel: lineageLabel(row.lineage_type),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    issuedAt: iso(row.issued_at),
    decidedAt: iso(row.decided_at),
    actions: {
      canViewQuote: true,
      canApprove: waiting && row.has_approve_authority === true,
      canDecline: waiting && row.has_decline_authority === true,
    },
  };
}

async function getCustomerJobQuotes(input = {}) {
  const validated = validatedInput(input);
  if (validated.error) return validated.error;
  return runReadTransaction(input.pool, async (client) => {
    const context = await loadCustomerJobContext(client, validated);
    if (customerContextUnavailable(context)) {
      return failure(
        404,
        "CUSTOMER_JOB_QUOTES_UNAVAILABLE",
        "The customer Quotes are unavailable."
      );
    }
    const rows = await loadCustomerQuotePage(client, {
      ...validated,
      relationshipId: Number(context.relationship_id),
      participantId: context.actor_participant_id,
    });
    const hasMore = rows.length > validated.limit;
    const pageRows = hasMore ? rows.slice(0, validated.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      ok: true,
      success: true,
      status: 200,
      code: "CUSTOMER_JOB_QUOTES_LOADED",
      job: {
        id: context.job_id,
        requestId: Number(context.job_request_id),
        title: String(context.job_title || "").trim() ||
          String(context.job_service || "").trim() || "Job",
        service: String(context.job_service || "").trim() || null,
      },
      quotes: pageRows.map(quoteProjection),
      pagination: {
        limit: validated.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({
          actorId: validated.actorId,
          jobId: validated.jobId,
          priority: Number(last.relevance_priority),
          activityAt: iso(last.last_activity_at),
          quoteId: last.id,
        }) : null,
      },
    };
  });
}

module.exports = {
  getCustomerJobQuotes,
  customerJobQuotesInternals: Object.freeze({
    decodeCursor,
    encodeCursor,
    lineageLabel,
    quoteProjection,
  }),
};
