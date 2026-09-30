"use strict";

const { commercialAuthorityInternals } = require("../authorization/commercialAuthorityService");
const { databaseClient, validateAuthenticatedActor, failure, isPlainObject, normalizedUuid, rollback } = commercialAuthorityInternals;

const { quoteDeliveryFingerprintMap } = require("../authorization/quoteDeliveryAuthority");
const { businessCustomerRelationshipInternals: projection } = require("../relationships/businessCustomerRelationshipService");

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const unavailable = () => failure(404, "NATIVE_CUSTOMER_HISTORY_UNAVAILABLE", "Customer History is unavailable.");

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function pageLimit(value) {
  if (value == null || value === "") return DEFAULT_LIMIT;
  const limit = positiveId(value);
  return limit && limit <= MAX_LIMIT ? limit : null;
}

function parseCursor(value, kind, profileId, homeownerId = null) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isPlainObject(parsed) || parsed.v !== 1 || parsed.kind !== kind ||
        parsed.profileId !== profileId || parsed.homeownerId !== homeownerId ||
        Buffer.from(JSON.stringify(parsed)).toString("base64url") !== value) return false;
    if (kind === "directory") {
      return Object.keys(parsed).length === 5 && positiveId(parsed.afterUserId) ? parsed : false;
    }
    const completedAt = new Date(parsed.activityAt || parsed.completedAt);
    return Object.keys(parsed).length === 6 && normalizedUuid(parsed.jobId) &&
      !Number.isNaN(completedAt.getTime()) && completedAt.toISOString() === (parsed.activityAt || parsed.completedAt) ? parsed : false;
  } catch {
    return false;
  }
}

function cursorFor(kind, profileId, homeownerId, row) {
  const value = kind === "directory"
    ? { v: 1, kind, profileId, homeownerId: null, afterUserId: Number(row.homeowner_user_id) }
    : { v: 1, kind, profileId, homeownerId, activityAt: new Date(row.completed_at || row.job_created_at).toISOString(), jobId: row.job_id };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function readOnly(pool, action) {
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

// Historical provenance deliberately does not test an active commercial grant,
// active Conversation, or role valid_until. An explicit role revocation does
// deny history. The two source branches retain their original identities.
const NATIVE_JOBS_SQL = `
  SELECT DISTINCT jobs.id AS job_id, jobs.source_type, jobs.created_at AS job_created_at,
    jobs.job_request_id, jobs.source_request_relationship_id AS relationship_id, relationships.contractor_id AS contractor_profile_id,
    relationships.homeowner_id AS homeowner_user_id, homeowner.username AS display_name,
    CASE WHEN jobs.source_type = 'emergency_request' THEN emergency.title ELSE posts.title END AS service_title,
    completions.completed_at, completions.workstream_count, completions.work_item_count,
    completions.customer_update_count
  FROM jobs
  JOIN request_relationships relationships ON relationships.id = jobs.source_request_relationship_id
    AND relationships.status IN ('active', 'closed')
    AND jobs.created_by_user_id = relationships.homeowner_id
  JOIN contractor_profiles profiles ON profiles.id = relationships.contractor_id
    AND profiles.user_id = relationships.professional_user_id
  JOIN users homeowner ON homeowner.id = relationships.homeowner_id
  JOIN relationship_participants professional ON professional.job_id = jobs.id
    AND professional.request_relationship_id = relationships.id
    AND professional.user_id = relationships.professional_user_id
    AND professional.identity_type = 'authenticated_user'
  JOIN relationship_participants customer ON customer.job_id = jobs.id
    AND customer.request_relationship_id = relationships.id
    AND customer.user_id = relationships.homeowner_id
    AND customer.identity_type = 'authenticated_user'
  JOIN conversations conversation ON conversation.relationship_id = relationships.id
    AND conversation.homeowner_id = relationships.homeowner_id
    AND conversation.contractor_id = relationships.contractor_id
    AND conversation.professional_user_id = relationships.professional_user_id
    AND conversation.status IN ('active', 'closed')
  LEFT JOIN emergency_requests emergency ON emergency.id = jobs.source_emergency_request_id
  LEFT JOIN posts ON posts.id = jobs.job_request_id
  LEFT JOIN request_selections selection ON selection.id = jobs.source_request_selection_id
    AND selection.request_relationship_id = relationships.id
    AND selection.post_id = jobs.job_request_id
    AND selection.selected_by_user_id = relationships.homeowner_id
    AND selection.contractor_id = relationships.contractor_id
    AND selection.professional_user_id = relationships.professional_user_id
    AND selection.conversation_id = conversation.id
  LEFT JOIN canonical_job_completion_records completions ON completions.job_id = jobs.id
  WHERE profiles.id = $1 AND profiles.user_id = $2 AND jobs.lifecycle_contract_version = 2
    AND professional.source_evidence_type = CASE jobs.source_type
      WHEN 'emergency_request' THEN 'emergency_selection'
      WHEN 'ordinary_request_selection' THEN 'request_selection'
      WHEN 'existing_customer_request' THEN 'existing_customer_request' END
    AND customer.source_evidence_type = professional.source_evidence_type
    AND customer.source_evidence_reference = professional.source_evidence_reference
    AND EXISTS (SELECT 1 FROM participant_role_assignments role
      WHERE role.participant_id = professional.id AND role.job_id = jobs.id
        AND role.role = 'PRIMARY_PROFESSIONAL'
        AND role.source_evidence_type = professional.source_evidence_type
        AND role.source_evidence_reference = professional.source_evidence_reference
        AND role.valid_from <= COALESCE(completions.completed_at, CURRENT_TIMESTAMP)
        AND NOT EXISTS (SELECT 1 FROM participant_role_revocations revoked
          WHERE revoked.role_assignment_id = role.id))
    AND NOT EXISTS (SELECT 1 FROM participant_role_assignments role
      JOIN participant_role_revocations revoked ON revoked.role_assignment_id = role.id
      WHERE role.participant_id = professional.id AND role.job_id = jobs.id
        AND role.role = 'PRIMARY_PROFESSIONAL')
    AND EXISTS (SELECT 1 FROM participant_role_assignments role
      WHERE role.participant_id = customer.id AND role.job_id = jobs.id
        AND role.role = 'CUSTOMER_REPRESENTATIVE'
        AND role.source_evidence_type = customer.source_evidence_type
        AND role.source_evidence_reference = customer.source_evidence_reference
        AND role.valid_from <= COALESCE(completions.completed_at, CURRENT_TIMESTAMP)
        AND NOT EXISTS (SELECT 1 FROM participant_role_revocations revoked
          WHERE revoked.role_assignment_id = role.id))
    AND NOT EXISTS (SELECT 1 FROM participant_role_assignments role
      JOIN participant_role_revocations revoked ON revoked.role_assignment_id = role.id
      WHERE role.participant_id = customer.id AND role.job_id = jobs.id
        AND role.role = 'CUSTOMER_REPRESENTATIVE')
    AND ((jobs.source_type = 'emergency_request'
      AND jobs.source_emergency_request_id = emergency.id
      AND jobs.job_request_id IS NULL AND jobs.source_request_selection_id IS NULL
      AND relationships.emergency_request_id = emergency.id AND relationships.post_id IS NULL
      AND emergency.homeowner_id = relationships.homeowner_id
      AND professional.source_evidence_reference =
        ('emergency:' || emergency.id || ':selection:' || relationships.id)
      AND (completions.id IS NULL OR emergency.status = 'completed'))
      OR (jobs.source_type = 'ordinary_request_selection'
        AND jobs.source_emergency_request_id IS NULL AND relationships.emergency_request_id IS NULL
        AND relationships.post_id = jobs.job_request_id AND selection.id IS NOT NULL
        AND professional.source_evidence_reference = selection.id::text
        AND posts.user_id = relationships.homeowner_id)
      OR (jobs.source_type = 'existing_customer_request'
        AND jobs.source_emergency_request_id IS NULL AND relationships.emergency_request_id IS NULL
        AND relationships.post_id = jobs.job_request_id AND selection.id IS NULL
        AND posts.user_id = relationships.homeowner_id
        AND posts.request_origin = 'existing_customer_request'
        AND professional.source_evidence_reference =
          ('request:' || jobs.job_request_id || ':relationship:' || relationships.id)
        AND relationships.ordinary_authority_source = 'existing_customer_request'))`;

function validateInput(input, fields) {
  if (!isPlainObject(input) || Object.keys(input).some(key => !fields.includes(key))) {
    return { error: failure(400, "NATIVE_CUSTOMER_HISTORY_FIELD_REJECTED", "The history request is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const profileId = positiveId(input.contractorProfileId);
  if (!profileId) return { error: failure(400, "INVALID_BUSINESS_ID", "A valid business is required.") };
  if (!input.pool || typeof input.pool.query !== "function") throw new TypeError("A database pool is required.");
  return { actorId: actor.id, profileId };
}

async function ownedProfile(client, profileId, actorId) {
  const result = await client.query("SELECT id FROM contractor_profiles WHERE id = $1 AND user_id = $2", [profileId, actorId]);
  return Boolean(result.rows[0]);
}

function subject(profileId, homeownerId) {
  return { kind: "MEETRO_ACCOUNT", contractorProfileId: profileId, homeownerUserId: homeownerId };
}

async function listNativeCustomers(input = {}) {
  const valid = validateInput(input, ["pool", "authenticatedActor", "contractorProfileId", "limit", "cursor"]);
  if (valid.error) return valid.error;
  const limit = pageLimit(input.limit);
  const cursor = parseCursor(input.cursor, "directory", valid.profileId);
  if (!limit || cursor === false) return failure(400, "INVALID_NATIVE_CUSTOMER_PAGE", "The page is invalid.");
  return readOnly(input.pool, async client => {
    if (!await ownedProfile(client, valid.profileId, valid.actorId)) return unavailable();
    const result = await client.query(`WITH native_jobs AS (${NATIVE_JOBS_SQL}), subjects AS (
      SELECT homeowner_user_id, max(display_name) AS display_name,
        count(completed_at)::integer AS completed_job_count, max(completed_at) AS last_completed_at,
        array_agg(DISTINCT source_type ORDER BY source_type) AS source_types
      FROM native_jobs GROUP BY homeowner_user_id)
      SELECT * FROM subjects WHERE ($3::integer IS NULL OR homeowner_user_id > $3)
      ORDER BY homeowner_user_id ASC LIMIT $4`,
      [valid.profileId, valid.actorId, cursor?.afterUserId || null, limit + 1]);
    const rows = result.rows.slice(0, limit);
    return { ok: true, status: 200, code: "NATIVE_CUSTOMERS_FOUND", nativeCustomers: {
      contractVersion: 1,
      customers: rows.map(row => ({ subject: subject(valid.profileId, Number(row.homeowner_user_id)),
        displayName: row.display_name || "Customer", completedJobCount: Number(row.completed_job_count),
        lastCompletedAt: row.last_completed_at ? new Date(row.last_completed_at).toISOString() : null,
        sourceTypes: row.source_types })),
      pagination: { limit, nextCursor: result.rows.length > limit
        ? cursorFor("directory", valid.profileId, null, rows.at(-1)) : null },
    } };
  });
}

async function readSubject(client, profileId, actorId, homeownerId) {
  const result = await client.query(`WITH native_jobs AS (${NATIVE_JOBS_SQL})
    SELECT display_name FROM native_jobs WHERE homeowner_user_id = $3 LIMIT 1`,
  [profileId, actorId, homeownerId]);
  return result.rows[0] || null;
}

const APPROVED_SQL = `LEFT JOIN LATERAL (
  SELECT sum(versions.total_minor)::bigint AS total_minor,
    CASE WHEN count(DISTINCT versions.currency) = 1 THEN max(versions.currency) END AS currency
  FROM canonical_quote_approvals approvals
  JOIN canonical_quote_versions versions ON versions.quote_id = approvals.quote_id
    AND versions.job_id = approvals.job_id AND versions.version = approvals.issued_quote_version
  WHERE approvals.job_id = native_jobs.job_id AND approvals.decision = 'APPROVED'
    AND approvals.approval_source = 'MEETRO_CUSTOMER'
    AND NOT EXISTS (SELECT 1 FROM canonical_quotes revision
      JOIN canonical_quote_approvals revised ON revised.quote_id = revision.id
        AND revised.job_id = revision.job_id AND revised.decision = 'APPROVED'
      WHERE revision.parent_quote_id = approvals.quote_id
        AND revision.job_id = approvals.job_id AND revision.lineage_type = 'REVISED_QUOTE')
) approved ON TRUE`;

function projectJob(row) {
  return { jobId: row.job_id, sourceType: row.source_type,
    serviceTitle: row.service_title || "Job",
    createdAt: new Date(row.job_created_at).toISOString(),
    completionState: row.completed_at ? "COMPLETED" : "ACTIVE",
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    approvedQuote: row.total_minor == null || !row.currency ? null
      : { currency: row.currency, totalMinor: Number(row.total_minor) },
    completionSummary: { workstreamCount: Number(row.workstream_count || 0),
      workItemCount: Number(row.work_item_count || 0), customerUpdateCount: Number(row.customer_update_count || 0) } };
}

// Every commercial/media row starts from the same authorized native subject. No Contact is created.
const SUBJECT_CTE = `WITH native_jobs AS (${NATIVE_JOBS_SQL}),
  subject_jobs AS (SELECT * FROM native_jobs WHERE homeowner_user_id = $3)`;

const HISTORY_CTE = `${SUBJECT_CTE}, visible_quotes AS (
  SELECT quotes.id AS quote_id, quotes.job_id, quotes.parent_quote_id, quotes.lineage_type,
    sources.document_number, quotes.status, versions.currency, versions.total_minor,
    quotes.created_at, quotes.updated_at, quotes.issued_at, decisions.decision AS customer_decision,
    decisions.decided_at, jobs.service_title AS job_title
  FROM subject_jobs jobs
  JOIN canonical_quotes quotes ON quotes.job_id = jobs.job_id AND quotes.relationship_id = jobs.relationship_id
  JOIN commercial_authority_aggregates aggregates ON aggregates.id = quotes.id
    AND aggregates.aggregate_type = 'quote' AND aggregates.owning_engine = 'authorization_engine'
  JOIN canonical_quote_versions versions ON versions.quote_id = quotes.id AND versions.job_id = jobs.job_id
    AND versions.version = aggregates.current_version AND versions.status = 'ISSUED'
  JOIN canonical_quote_issuances issuances ON issuances.quote_id = quotes.id AND issuances.job_id = jobs.job_id
    AND issuances.quote_version = versions.version
  LEFT JOIN canonical_quote_business_document_sources sources ON sources.quote_id = quotes.id AND sources.job_id = jobs.job_id
  LEFT JOIN canonical_quote_customer_decisions decisions ON decisions.quote_id = quotes.id AND decisions.job_id = jobs.job_id
    AND decisions.relationship_id = jobs.relationship_id AND decisions.issued_quote_version = versions.version
  WHERE quotes.status = 'ISSUED' AND quotes.issued_at IS NOT NULL
    AND ((quotes.parent_quote_id IS NULL AND quotes.lineage_type IS NULL) OR
      (quotes.parent_quote_id IS NOT NULL AND quotes.lineage_type IN ('REVISED_QUOTE','SUPPLEMENTAL_QUOTE')))
    AND EXISTS (SELECT 1 FROM messages delivery JOIN conversations conversation ON conversation.id = delivery.conversation_id
      AND conversation.relationship_id = jobs.relationship_id AND conversation.contractor_id = $1
      AND conversation.professional_user_id = $2 AND conversation.homeowner_id = $3
      AND conversation.status IN ('active','closed')
      WHERE delivery.quote_id = quotes.id AND delivery.job_id = jobs.job_id
        AND delivery.sender_id = $2 AND delivery.receiver_id = $3
        AND delivery.message_type = 'quote_shared' AND delivery.workflow_type = 'QUOTE_SHARED'
        AND delivery.workflow_status = 'SENT'
        AND delivery.delivery_request_fingerprint = COALESCE($4::jsonb ->> quotes.id::text, '')
        AND delivery.workflow_payload ->> 'quoteId' = quotes.id::text
        AND delivery.workflow_payload ->> 'jobId' = jobs.job_id::text)
), visible_invoices AS (
  SELECT invoices.id AS invoice_id, invoices.invoice_number, invoices.job_id, current.status,
    current.currency, current.total_minor, current.paid_minor, current.balance_minor, current.invoice_date,
    invoices.created_at, current.created_at AS updated_at, issuances.issued_at, jobs.service_title AS job_title
  FROM subject_jobs jobs JOIN canonical_invoices invoices ON invoices.job_id = jobs.job_id
    AND invoices.relationship_id = jobs.relationship_id
  JOIN LATERAL (SELECT versions.* FROM canonical_invoice_versions versions
    WHERE versions.invoice_id = invoices.id AND versions.job_id = jobs.job_id ORDER BY versions.version DESC LIMIT 1) current ON TRUE
  JOIN canonical_invoice_issuances issuances ON issuances.invoice_id = invoices.id AND issuances.job_id = jobs.job_id
  WHERE current.status <> 'DRAFT' AND issuances.issued_at IS NOT NULL
), visible_media AS (
  SELECT DISTINCT jobs.job_id, jobs.service_title AS job_title, photo.item->>'public_id' AS media_id,
    photo.item->>'secure_url' AS secure_url, photo.item->>'format' AS format, photo.item->>'uploaded_at' AS uploaded_at
  FROM subject_jobs jobs JOIN posts ON posts.id = jobs.job_request_id AND posts.user_id = $3
    AND posts.lifecycle_contract_version = 2
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(posts.request_photos) = 'array'
    THEN posts.request_photos ELSE '[]'::jsonb END) photo(item)
  WHERE photo.item->>'purpose' = 'request-photo' AND photo.item->>'resource_type' = 'image'
    AND photo.item->>'lifecycle_state' = 'attached' AND COALESCE(photo.item->>'public_id','') <> ''
    AND photo.item->>'secure_url' LIKE 'https://res.cloudinary.com/%'
)`;

async function historyEvidence(client, profileId, actorId, homeownerId, jobIds) {
  const candidates = await client.query(`/* native_history:quote_versions */ ${SUBJECT_CTE}
    SELECT quotes.id, aggregates.current_version FROM subject_jobs jobs
    JOIN canonical_quotes quotes ON quotes.job_id = jobs.job_id AND quotes.relationship_id = jobs.relationship_id
    JOIN commercial_authority_aggregates aggregates ON aggregates.id = quotes.id
      AND aggregates.aggregate_type = 'quote' AND aggregates.owning_engine = 'authorization_engine'
    WHERE quotes.status = 'ISSUED' AND quotes.issued_at IS NOT NULL`, [profileId, actorId, homeownerId]);
  const scope = [profileId, actorId, homeownerId, JSON.stringify(quoteDeliveryFingerprintMap(candidates.rows, actorId))];
  const summaryResult = await client.query(`/* native_history:summary */ ${HISTORY_CTE}
    SELECT (SELECT count(*) FROM subject_jobs WHERE completed_at IS NULL)::integer AS active_jobs,
      (SELECT count(*) FROM subject_jobs WHERE completed_at IS NOT NULL)::integer AS completed_jobs,
      (SELECT count(*) FROM visible_quotes)::integer AS quotes,
      (SELECT count(*) FROM visible_invoices)::integer AS invoices,
      (SELECT count(*) FROM visible_media)::integer AS photos`, scope);
  const summary = summaryResult.rows[0];
  const communication = await client.query(`/* native_history:communication */ ${SUBJECT_CTE}
    SELECT DISTINCT conversation.id FROM subject_jobs jobs
    JOIN request_relationships relationship ON relationship.id = jobs.relationship_id AND relationship.status = 'active'
    JOIN conversations conversation ON conversation.relationship_id = relationship.id
      AND conversation.contractor_id = $1 AND conversation.professional_user_id = $2 AND conversation.homeowner_id = $3
      AND conversation.status = 'active' AND conversation.professional_archived_at IS NULL
    WHERE EXISTS (SELECT 1 FROM relationship_participants participant
      JOIN participant_role_assignments role ON role.participant_id = participant.id AND role.job_id = jobs.job_id
        AND role.role = 'PRIMARY_PROFESSIONAL' AND role.valid_from <= CURRENT_TIMESTAMP
        AND (role.valid_until IS NULL OR role.valid_until > CURRENT_TIMESTAMP)
      WHERE participant.job_id = jobs.job_id AND participant.user_id = $2
        AND participant.request_relationship_id = relationship.id
        AND NOT EXISTS (SELECT 1 FROM participant_role_revocations revoked WHERE revoked.role_assignment_id = role.id))
    ORDER BY conversation.id LIMIT 2`, [profileId, actorId, homeownerId]);
  const quotes = await client.query(`/* native_history:quotes */ ${HISTORY_CTE}
    SELECT * FROM visible_quotes WHERE job_id = ANY($5::uuid[]) ORDER BY issued_at DESC, quote_id ASC`, [...scope, jobIds]);
  const invoices = await client.query(`/* native_history:invoices */ ${HISTORY_CTE}
    SELECT * FROM visible_invoices WHERE job_id = ANY($5::uuid[]) ORDER BY issued_at DESC, invoice_id ASC`, [...scope, jobIds]);
  const media = await client.query(`/* native_history:media */ ${HISTORY_CTE}
    SELECT DISTINCT * FROM visible_media WHERE job_id = ANY($5::uuid[]) ORDER BY uploaded_at DESC NULLS LAST, media_id ASC`, [...scope, jobIds]);
  return {
    actionBridge: { canStartNewJob: false, conversationId: communication.rows.length === 1 ? Number(communication.rows[0].id) : null },
    summary: { activeJobs: Number(summary.active_jobs), completedJobs: Number(summary.completed_jobs),
      quotes: Number(summary.quotes), invoices: Number(summary.invoices),
      documents: Number(summary.quotes) + Number(summary.invoices), photos: Number(summary.photos) },
    quotes: quotes.rows.map(projection.quoteActivityProjection), invoices: invoices.rows.map(projection.invoiceActivityProjection),
    documents: projection.documentActivityProjections(quotes.rows, invoices.rows), media: media.rows.map(projection.mediaActivityProjection),
  };
}

async function listNativeCustomerHistory(input = {}) {
  const valid = validateInput(input, ["pool", "authenticatedActor", "contractorProfileId", "homeownerUserId", "limit", "cursor"]);
  if (valid.error) return valid.error;
  const homeownerId = positiveId(input.homeownerUserId);
  const limit = pageLimit(input.limit);
  const cursor = parseCursor(input.cursor, "history", valid.profileId, homeownerId);
  if (!homeownerId || !limit || cursor === false) return failure(400, "INVALID_NATIVE_CUSTOMER_PAGE", "The page is invalid.");
  return readOnly(input.pool, async client => {
    if (!await ownedProfile(client, valid.profileId, valid.actorId)) return unavailable();
    const found = await readSubject(client, valid.profileId, valid.actorId, homeownerId);
    if (!found) return unavailable();
    const result = await client.query(`/* native_history:jobs */ WITH native_jobs AS (${NATIVE_JOBS_SQL})
      SELECT native_jobs.*, approved.total_minor, approved.currency
      FROM native_jobs ${APPROVED_SQL}
      WHERE native_jobs.homeowner_user_id = $3
        AND ($4::timestamptz IS NULL OR (COALESCE(native_jobs.completed_at, native_jobs.job_created_at), native_jobs.job_id) < ($4::timestamptz, $5::uuid))
      ORDER BY COALESCE(native_jobs.completed_at, native_jobs.job_created_at) DESC, native_jobs.job_id DESC LIMIT $6`,
      [valid.profileId, valid.actorId, homeownerId, cursor?.activityAt || cursor?.completedAt || null, cursor?.jobId || null, limit + 1]);
    const rows = result.rows.slice(0, limit);
    const evidence = await historyEvidence(client, valid.profileId, valid.actorId, homeownerId, rows.map(row => row.job_id));
    return { ok: true, status: 200, code: "NATIVE_CUSTOMER_HISTORY_FOUND", nativeCustomerHistory: {
      contractVersion: 2, subject: subject(valid.profileId, homeownerId), displayName: found.display_name || "Customer",
      ...evidence, jobs: rows.map(projectJob), pagination: { limit, nextCursor: result.rows.length > limit
        ? cursorFor("history", valid.profileId, homeownerId, rows.at(-1)) : null },
    } };
  });
}

async function getNativeCustomerJobHistory(input = {}) {
  const valid = validateInput(input, ["pool", "authenticatedActor", "contractorProfileId", "homeownerUserId", "jobId"]);
  if (valid.error) return valid.error;
  const homeownerId = positiveId(input.homeownerUserId);
  const jobId = normalizedUuid(input.jobId);
  if (!homeownerId || !jobId) return failure(400, "INVALID_NATIVE_CUSTOMER_JOB", "The Job identity is invalid.");
  return readOnly(input.pool, async client => {
    if (!await ownedProfile(client, valid.profileId, valid.actorId)) return unavailable();
    const result = await client.query(`WITH native_jobs AS (${NATIVE_JOBS_SQL})
      SELECT native_jobs.*, approved.total_minor, approved.currency
      FROM native_jobs ${APPROVED_SQL}
      WHERE native_jobs.homeowner_user_id = $3 AND native_jobs.job_id = $4
        LIMIT 1`,
      [valid.profileId, valid.actorId, homeownerId, jobId]);
    const row = result.rows[0];
    if (!row) return unavailable();
    return { ok: true, status: 200, code: "NATIVE_CUSTOMER_JOB_HISTORY_FOUND", nativeCustomerJobHistory: {
      contractVersion: 2, subject: subject(valid.profileId, homeownerId),
      displayName: row.display_name || "Customer", job: projectJob(row),
    } };
  });
}

module.exports = { listNativeCustomers, listNativeCustomerHistory, getNativeCustomerJobHistory };
