"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");
const {
  advanceConversationParticipantReadStateWithClient,
  ensureConversationParticipantStatesWithClient,
} = require("../conversations/conversationParticipantStateService");
const {
  createOrRefreshCommunicationMessageAlert,
  getCommunicationAttentionWindowWithClient,
  resolveCommunicationRecipient,
} = require("../alerts/communicationAlertService");
const {
  customerPartyInternals: {
    customerPartyProjection,
    insertCanonicalInvoiceCustomerParty,
    loadJobCustomerParty,
    resolveInvoiceCustomerParty,
  },
} = require("../relationships/customerPartyService");

const {
  databaseClient,
  failure,
  isPlainObject,
  normalizedUuid,
  positiveInteger,
  rollback,
  validateAuthenticatedActor,
  validateIdempotencyKey,
} = commercialAuthorityInternals;

const CONTRACT_VERSION = 1;
const PAYMENT_METHODS = new Set(["CASH", "CHECK", "BANK_TRANSFER", "OTHER"]);
const INVOICE_STATUSES = new Set(["DRAFT", "SENT", "PARTIALLY_PAID", "PAID"]);
const MESSAGE_TYPE = "invoice_shared";
const WORKFLOW_TYPE = "INVOICE_SHARED";
const WORKFLOW_STATUS = "SENT";
const DEFAULT_WORKSPACE_LIMIT = 20;
const MAX_WORKSPACE_LIMIT = 50;
const MAX_EXTRA_WORK_ITEMS = 100;
const INVOICE_LINE_SOURCE_TYPES = Object.freeze({
  APPROVED_QUOTE_SCOPE: "APPROVED_QUOTE_SCOPE",
  EXTRA_WORK: "EXTRA_WORK",
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function safeText(value, maximum = 2000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= maximum ? normalized : null;
}

function optionalText(value, maximum) {
  if (value == null || value === "") return null;
  return safeText(value, maximum);
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeExtraWorkItems(value) {
  if (value == null) return { items: [] };
  if (!Array.isArray(value) || value.length > MAX_EXTRA_WORK_ITEMS) {
    return { error: true };
  }
  const items = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: true };
    const allowed = new Set(["description", "quantity", "unitAmountMinor"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) return { error: true };
    const description = safeText(item.description, 1000);
    const quantity = positiveInteger(item.quantity);
    const unitAmountMinor = nonNegativeInteger(item.unitAmountMinor);
    const lineTotalMinor = quantity == null || unitAmountMinor == null
      ? null
      : quantity * unitAmountMinor;
    if (
      !description || !quantity || quantity > 10000 || unitAmountMinor == null ||
      !Number.isSafeInteger(lineTotalMinor)
    ) return { error: true };
    items.push({ description, quantity, unitAmountMinor, lineTotalMinor });
  }
  return { items };
}

function dateOnly(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sqlDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const normalized = String(value || "").slice(0, 10);
  return dateOnly(normalized);
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function validateInput(input, fields, { invoice = false, job = false } = {}) {
  const allowed = new Set(["pool", "authenticatedActor", "logger", ...fields]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: failure(400, "INVOICE_FIELD_REJECTED", "The Invoice request is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const result = { actorId: actor.id };
  if (invoice) {
    result.invoiceId = normalizedUuid(input.invoiceId);
    if (!result.invoiceId) {
      return { error: failure(400, "INVALID_INVOICE_ID", "A valid Invoice is required.") };
    }
  }
  if (job) {
    result.jobId = normalizedUuid(input.jobId);
    if (!result.jobId) {
      return { error: failure(400, "INVALID_JOB_ID", "A valid Job is required.") };
    }
  }
  return result;
}

async function runTransaction(pool, mode, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${mode}`);
    started = true;
    const value = await action(client);
    if (value?.abort) {
      await rollback(client);
      started = false;
      return value.abort;
    }
    await client.query("COMMIT");
    started = false;
    return value;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadProfessionalJobContext(client, jobId, actorId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.homeowner_id, relationships.professional_user_id,
      relationships.status AS relationship_status,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      completions.id AS completion_id,
      completions.version AS completion_version,
      completions.completed_at,
      work_completion.execution_id AS work_completion_execution_id,
      work_completion.execution_version AS work_completion_version,
      work_completion.completed_at AS work_completed_at,
      posts.title AS job_title, posts.category AS job_service,
      homeowner.username AS customer_name,
      COALESCE(NULLIF(contractor_profiles.business_name, ''), professional_user.username)
        AS business_name,
      conversations.id AS conversation_id,
      conversations.status AS conversation_status,
      EXISTS (
        SELECT 1 FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = professional.id
          AND roles.job_id = jobs.id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS primary_role_active
    FROM jobs
    INNER JOIN posts ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2 AND posts.cancelled_at IS NULL
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
      AND relationships.professional_user_id = $2
    INNER JOIN relationship_participants professional
      ON professional.job_id = jobs.id
      AND professional.request_relationship_id = relationships.id
      AND professional.user_id = $2
    INNER JOIN relationship_participants customer
      ON customer.job_id = jobs.id
      AND customer.request_relationship_id = relationships.id
      AND customer.user_id = relationships.homeowner_id
    INNER JOIN users homeowner ON homeowner.id = relationships.homeowner_id
    INNER JOIN users professional_user ON professional_user.id = relationships.professional_user_id
    LEFT JOIN contractor_profiles ON contractor_profiles.user_id = relationships.professional_user_id
    LEFT JOIN conversations ON conversations.relationship_id = relationships.id
    LEFT JOIN canonical_job_completion_records completions ON completions.job_id = jobs.id
    LEFT JOIN LATERAL (
      SELECT executions.id AS execution_id,
        current.version AS execution_version,
        current.created_at AS completed_at
      FROM canonical_approved_work_executions executions
      INNER JOIN LATERAL (
        SELECT version, state, command_idempotency_id, created_at
        FROM canonical_approved_work_execution_versions versions
        WHERE versions.execution_id = executions.id
          AND versions.job_id = executions.job_id
        ORDER BY version DESC LIMIT 1
      ) current ON TRUE
      INNER JOIN canonical_approved_work_execution_command_idempotency commands
        ON commands.id = current.command_idempotency_id
        AND commands.job_id = executions.job_id
        AND commands.command_scope =
          'execution:' || executions.id::text || ':complete-work'
        AND commands.completed_at IS NOT NULL
        AND commands.result_reference ->> 'code' = 'APPROVED_WORK_COMPLETED'
      WHERE executions.job_id = jobs.id AND current.state = 'CLOSED'
      ORDER BY current.created_at DESC, executions.id DESC
      LIMIT 1
    ) work_completion ON TRUE
    WHERE jobs.id = $1 AND jobs.lifecycle_contract_version = 2
    LIMIT 1
    ${lock ? "FOR UPDATE OF jobs, relationships" : ""}`,
    [jobId, actorId]
  );
  return result.rows[0] || null;
}

function professionalAuthorized(context, actorId) {
  return Boolean(
    context &&
    Number(context.professional_user_id) === actorId &&
    context.primary_role_active === true &&
    ["active", "closed"].includes(context.relationship_status)
  );
}

async function loadEffectiveApprovedBillingLines(client, jobId) {
  const result = await client.query(
    `SELECT quotes.id AS quote_id,
      decisions.issued_quote_version AS quote_version,
      versions.currency,
      customer_parties.contractor_profile_id AS customer_party_contractor_profile_id,
      customer_parties.business_contact_id,
      customer_parties.business_customer_relationship_id,
      CASE
        WHEN quotes.parent_quote_id IS NULL THEN 'ORIGINAL'
        WHEN quotes.lineage_type = 'REVISED_QUOTE' THEN 'REVISED'
        ELSE 'ADDITIONAL'
      END AS lineage_label,
      snapshots.scope_item_id, snapshots.sequence,
      snapshots.description, snapshots.quantity,
      snapshots.unit_amount_minor, snapshots.line_total_minor
    FROM canonical_quotes quotes
    INNER JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id
      AND decisions.job_id = quotes.job_id
      AND decisions.decision = 'APPROVED'
    INNER JOIN canonical_quote_versions versions
      ON versions.quote_id = quotes.id
      AND versions.job_id = quotes.job_id
      AND versions.version = decisions.issued_quote_version
      AND versions.status = 'ISSUED'
    INNER JOIN canonical_quote_scope_item_snapshots snapshots
      ON snapshots.quote_id = quotes.id
      AND snapshots.job_id = quotes.job_id
      AND snapshots.quote_version = decisions.issued_quote_version
      AND snapshots.included_in_total = TRUE
    LEFT JOIN canonical_quote_customer_parties customer_parties
      ON customer_parties.quote_id = quotes.id
      AND customer_parties.job_id = quotes.job_id
    WHERE quotes.job_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM canonical_quotes revision
        INNER JOIN canonical_quote_customer_decisions revision_decision
          ON revision_decision.quote_id = revision.id
          AND revision_decision.job_id = revision.job_id
          AND revision_decision.decision = 'APPROVED'
        WHERE revision.parent_quote_id = quotes.id
          AND revision.lineage_type = 'REVISED_QUOTE'
      )
    ORDER BY quotes.created_at ASC, quotes.id ASC,
      snapshots.sequence ASC, snapshots.scope_item_id ASC`,
    [jobId]
  );
  return result.rows;
}

async function loadApplicablePaymentsReceived(client, jobId, effectiveLines) {
  const quoteVersions = [...new Map(effectiveLines.map((line) => [
    `${line.quote_id}:${line.quote_version}`,
    { quoteId: line.quote_id, quoteVersion: Number(line.quote_version) },
  ])).values()];
  if (!quoteVersions.length) return 0;
  const result = await client.query(
    `SELECT COALESCE(sum(current.applied_minor), 0)::bigint AS paid_minor
     FROM canonical_pre_work_deposit_obligations obligations
     INNER JOIN LATERAL (
       SELECT versions.state, versions.applied_minor
       FROM canonical_pre_work_deposit_versions versions
       WHERE versions.obligation_id = obligations.id
         AND versions.job_id = obligations.job_id
       ORDER BY versions.version DESC LIMIT 1
     ) current ON TRUE
     WHERE obligations.job_id = $1
       AND current.state NOT IN ('SUPERSEDED', 'VOIDED')
       AND (obligations.quote_id, obligations.issued_quote_version) IN (
         SELECT source.quote_id, source.quote_version
         FROM jsonb_to_recordset($2::jsonb)
           AS source(quote_id uuid, quote_version integer)
       )`,
    [jobId, JSON.stringify(quoteVersions.map((item) => ({
      quote_id: item.quoteId,
      quote_version: item.quoteVersion,
    })))]
  );
  const paidMinor = Number(result.rows[0]?.paid_minor || 0);
  return Number.isSafeInteger(paidMinor) && paidMinor >= 0 ? paidMinor : 0;
}

async function loadInvoiceContext(client, invoiceId, actorId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT invoices.id AS invoice_id, invoices.invoice_number, invoices.job_id,
      invoices.job_request_id, invoices.relationship_id,
      invoices.issuer_participant_id,
      relationships.homeowner_id, relationships.professional_user_id,
      relationships.status AS relationship_status,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      posts.title AS job_title, posts.category AS job_service,
      homeowner.username AS customer_name,
      COALESCE(NULLIF(contractor_profiles.business_name, ''), professional_user.username)
        AS business_name,
      conversations.id AS conversation_id,
      conversations.status AS conversation_status,
      current.version, current.status, current.currency,
      current.subtotal_minor, current.total_minor,
      current.paid_minor, current.balance_minor,
      current.invoice_date, current.due_mode, current.due_date,
      current.customer_notes, current.terms,
      current.integrity_hash, current.created_at AS version_created_at,
      issuances.issued_at,
      customer_parties.contractor_profile_id AS customer_party_contractor_profile_id,
      customer_parties.business_contact_id,
      customer_parties.business_customer_relationship_id,
      EXISTS (
        SELECT 1 FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = professional.id
          AND roles.job_id = invoices.job_id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS primary_role_active
    FROM canonical_invoices invoices
    INNER JOIN jobs ON jobs.id = invoices.job_id
    INNER JOIN posts ON posts.id = invoices.job_request_id
    INNER JOIN request_relationships relationships
      ON relationships.id = invoices.relationship_id
      AND relationships.professional_user_id = $2
    INNER JOIN relationship_participants professional
      ON professional.id = invoices.issuer_participant_id
      AND professional.user_id = $2
    INNER JOIN relationship_participants customer
      ON customer.job_id = invoices.job_id
      AND customer.request_relationship_id = relationships.id
      AND customer.user_id = relationships.homeowner_id
    INNER JOIN users homeowner ON homeowner.id = relationships.homeowner_id
    INNER JOIN users professional_user ON professional_user.id = relationships.professional_user_id
    LEFT JOIN contractor_profiles ON contractor_profiles.user_id = relationships.professional_user_id
    LEFT JOIN conversations ON conversations.relationship_id = relationships.id
    INNER JOIN LATERAL (
      SELECT * FROM canonical_invoice_versions versions
      WHERE versions.invoice_id = invoices.id
      ORDER BY versions.version DESC LIMIT 1
    ) current ON TRUE
    LEFT JOIN canonical_invoice_issuances issuances ON issuances.invoice_id = invoices.id
    LEFT JOIN canonical_invoice_customer_parties customer_parties
      ON customer_parties.invoice_id = invoices.id
      AND customer_parties.job_id = invoices.job_id
    WHERE invoices.id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE OF invoices, relationships" : ""}`,
    [invoiceId, actorId]
  );
  return result.rows[0] || null;
}

async function loadCustomerInvoiceContext(client, { invoiceId = null, jobId = null, actorId }) {
  const result = await client.query(
    `SELECT invoices.id AS invoice_id, invoices.invoice_number, invoices.job_id,
      invoices.job_request_id, invoices.relationship_id,
      relationships.homeowner_id, relationships.professional_user_id,
      posts.title AS job_title, posts.category AS job_service,
      homeowner.username AS customer_name,
      COALESCE(NULLIF(contractor_profiles.business_name, ''), professional_user.username)
        AS business_name,
      conversations.id AS conversation_id,
      current.version, current.status, current.currency,
      current.subtotal_minor, current.total_minor,
      current.paid_minor, current.balance_minor,
      current.invoice_date, current.due_mode, current.due_date,
      current.customer_notes, current.terms,
      current.integrity_hash, current.created_at AS version_created_at,
      issuances.issued_at
    FROM canonical_invoices invoices
    INNER JOIN posts ON posts.id = invoices.job_request_id
    INNER JOIN request_relationships relationships
      ON relationships.id = invoices.relationship_id
      AND relationships.homeowner_id = $3
    INNER JOIN users homeowner ON homeowner.id = relationships.homeowner_id
    INNER JOIN users professional_user ON professional_user.id = relationships.professional_user_id
    LEFT JOIN contractor_profiles ON contractor_profiles.user_id = relationships.professional_user_id
    LEFT JOIN conversations ON conversations.relationship_id = relationships.id
    INNER JOIN LATERAL (
      SELECT * FROM canonical_invoice_versions versions
      WHERE versions.invoice_id = invoices.id
      ORDER BY versions.version DESC LIMIT 1
    ) current ON TRUE
    LEFT JOIN canonical_invoice_issuances issuances ON issuances.invoice_id = invoices.id
    WHERE ($1::uuid IS NULL OR invoices.id = $1)
      AND ($2::uuid IS NULL OR invoices.job_id = $2)
      AND current.status <> 'DRAFT'
    LIMIT 1`,
    [invoiceId, jobId, actorId]
  );
  return result.rows[0] || null;
}

async function loadInvoiceLines(client, invoiceId) {
  const result = await client.query(
    `SELECT id, sequence, source_type, source_quote_id, source_quote_version,
      source_scope_item_id, lineage_label, description, quantity,
      unit_amount_minor, line_total_minor
    FROM canonical_invoice_line_item_snapshots
    WHERE invoice_id = $1
    ORDER BY sequence ASC, id ASC`,
    [invoiceId]
  );
  return result.rows;
}

async function loadInvoicePayments(client, invoiceId) {
  const result = await client.query(
    `SELECT id, amount_minor, currency, received_date, method,
      customer_reference, recorded_at
    FROM canonical_invoice_payments
    WHERE invoice_id = $1
    ORDER BY recorded_at ASC, id ASC`,
    [invoiceId]
  );
  return result.rows;
}

function dueProjection(row) {
  return {
    mode: row.due_mode,
    date: row.due_date ? sqlDate(row.due_date) : null,
  };
}

function lineProjection(row, audience) {
  const value = {
    sequence: Number(row.sequence),
    type: row.source_type === INVOICE_LINE_SOURCE_TYPES.EXTRA_WORK
      ? "extraWork"
      : "approvedWork",
    description: row.description,
    quantity: Number(row.quantity),
    unitAmountMinor: Number(row.unit_amount_minor),
    lineTotalMinor: Number(row.line_total_minor),
  };
  if (audience === "professional") {
    value.lineItemId = row.id;
    if (row.source_type === INVOICE_LINE_SOURCE_TYPES.APPROVED_QUOTE_SCOPE) {
      value.sourceQuoteId = row.source_quote_id;
      value.sourceQuoteVersion = Number(row.source_quote_version);
      value.sourceScopeItemId = row.source_scope_item_id;
      value.lineageLabel = row.lineage_label;
    }
  }
  return value;
}

function paymentProjection(row, audience) {
  const value = {
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    receivedDate: sqlDate(row.received_date),
    method: row.method,
    customerReference: row.customer_reference || null,
    recordedAt: iso(row.recorded_at),
  };
  if (audience === "professional") value.paymentId = row.id;
  return value;
}

function invoiceProjection(row, lines, payments, audience) {
  const professional = audience === "professional";
  const value = {
    contractVersion: CONTRACT_VERSION,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    jobId: row.job_id,
    requestId: Number(row.job_request_id),
    relationshipId: Number(row.relationship_id),
    conversationId: positiveInteger(row.conversation_id),
    business: { displayName: row.business_name || "Professional" },
    customer: { displayName: row.customer_name || "Customer" },
    job: {
      title: row.job_title || row.job_service || "Job",
      service: row.job_service || null,
    },
    status: row.status,
    currency: row.currency,
    invoiceDate: sqlDate(row.invoice_date),
    due: dueProjection(row),
    lineItems: lines.map((line) => lineProjection(line, audience)),
    subtotalMinor: Number(row.subtotal_minor),
    totalMinor: Number(row.total_minor),
    paidMinor: Number(row.paid_minor),
    balanceMinor: Number(row.balance_minor),
    customerNotes: row.customer_notes || null,
    terms: row.terms || null,
    issuedAt: iso(row.issued_at),
    payments: payments.map((payment) => paymentProjection(payment, audience)),
    actions: professional
      ? {
          canIssue: row.status === "DRAFT" && positiveInteger(row.conversation_id) !== null,
          canRecordPayment: ["SENT", "PARTIALLY_PAID"].includes(row.status),
          canShareExternal: row.status !== "DRAFT",
        }
      : { canReview: true, canPayOnline: false },
  };
  if (professional) {
    value.currentVersion = Number(row.version);
    value.customerParty = customerPartyProjection({
      contractor_profile_id: row.customer_party_contractor_profile_id,
      business_contact_id: row.business_contact_id,
      business_customer_relationship_id:
        row.business_customer_relationship_id,
    });
  }
  return value;
}

async function loadInvoiceProjection(client, context, audience) {
  const lines = await loadInvoiceLines(client, context.invoice_id);
  const payments = await loadInvoicePayments(client, context.invoice_id);
  return invoiceProjection(context, lines, payments, audience);
}

function invoiceVersionHash(value) {
  return hash({ schemaVersion: 1, ...value });
}

function paymentHash(value) {
  return hash({ schemaVersion: 1, ...value });
}

async function reserveCommand(client, {
  actorId, commandName, jobId, invoiceId = null, idempotencyKey, fingerprint,
}) {
  const id = randomUUID();
  const inserted = await client.query(
    `INSERT INTO canonical_invoice_command_idempotency (
      id, actor_user_id, command_name, job_id, invoice_id,
      idempotency_key, request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (actor_user_id, command_name, idempotency_key) DO NOTHING
    RETURNING *`,
    [id, actorId, commandName, jobId, invoiceId, idempotencyKey, fingerprint]
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], replay: null };
  const existing = await client.query(
    `SELECT * FROM canonical_invoice_command_idempotency
     WHERE actor_user_id = $1 AND command_name = $2 AND idempotency_key = $3
     LIMIT 1 FOR UPDATE`,
    [actorId, commandName, idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row || row.request_fingerprint !== fingerprint) {
    return { error: failure(409, "INVOICE_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different command.") };
  }
  if (!row.result_payload) {
    return { error: failure(409, "INVOICE_COMMAND_IN_PROGRESS", "The Invoice command is still being processed.") };
  }
  return { row, replay: { ...row.result_payload, replayed: true, status: 200 } };
}

async function completeCommand(client, commandId, invoiceId, result) {
  const updated = await client.query(
    `UPDATE canonical_invoice_command_idempotency
     SET invoice_id = $2, result_payload = $3::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND result_payload IS NULL`,
    [commandId, invoiceId, JSON.stringify(result)]
  );
  if (updated.rowCount !== 1) throw new Error("Invoice command idempotency could not be completed.");
}

function createCommandFingerprint({
  actorId, jobId, expectedCompletionVersion, due, customerNotes, terms, extraWork,
}) {
  return hash({
    command: "invoice.create", actorId, jobId, expectedCompletionVersion,
    due, customerNotes, terms, extraWork,
  });
}

async function createInvoice(input = {}) {
  const validated = validateInput(input, [
    "jobId", "expectedCompletionVersion", "due", "customerNotes", "terms",
    "extraWork", "idempotencyKey",
  ], { job: true });
  if (validated.error) return validated.error;
  const expectedCompletionVersion = positiveInteger(input.expectedCompletionVersion);
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  const due = isPlainObject(input.due) ? input.due : null;
  const dueMode = due?.mode;
  const dueDate = dueMode === "SPECIFIC_DATE" ? dateOnly(due?.date) : null;
  const customerNotes = optionalText(input.customerNotes, 2000);
  const terms = optionalText(input.terms, 2000);
  const extraWorkResult = normalizeExtraWorkItems(input.extraWork);
  if (
    !expectedCompletionVersion || idempotency.error ||
    !["DUE_ON_RECEIPT", "SPECIFIC_DATE"].includes(dueMode) ||
    (dueMode === "SPECIFIC_DATE" && (!dueDate || dueDate < today())) ||
    (dueMode === "DUE_ON_RECEIPT" && due?.date != null) ||
    (input.customerNotes != null && input.customerNotes !== "" && !customerNotes) ||
    (input.terms != null && input.terms !== "" && !terms) || extraWorkResult.error
  ) return failure(400, "INVALID_INVOICE_CREATE_COMMAND", "The Invoice details are invalid.");

  const fingerprint = createCommandFingerprint({
    ...validated, expectedCompletionVersion,
    due: { mode: dueMode, date: dueDate }, customerNotes, terms,
    extraWork: extraWorkResult.items,
  });
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalJobContext(
      client, validated.jobId, validated.actorId, { lock: true }
    );
    if (!professionalAuthorized(context, validated.actorId)) {
      return { abort: failure(403, "INVOICE_AUTHORITY_DENIED", "Invoice authority is unavailable.") };
    }
    const reserved = await reserveCommand(client, {
      actorId: validated.actorId,
      commandName: "invoice.create",
      jobId: validated.jobId,
      idempotencyKey: idempotency.idempotencyKey,
      fingerprint,
    });
    if (reserved.error) return { abort: reserved.error };
    if (reserved.replay) return reserved.replay;
    const invoiceCompletionVersion = context.completion_id
      ? Number(context.completion_version)
      : context.work_completion_execution_id
        ? Number(context.work_completion_version)
        : null;
    if (!invoiceCompletionVersion || invoiceCompletionVersion !== expectedCompletionVersion) {
      return { abort: failure(409, "JOB_NOT_READY_TO_INVOICE", "The completed Job is not ready to invoice.") };
    }
    const existing = await client.query(
      `SELECT id FROM canonical_invoices WHERE job_id = $1 LIMIT 1`,
      [validated.jobId]
    );
    if (existing.rows[0]) {
      return { abort: failure(409, "INVOICE_ALREADY_EXISTS", "This Job already has an Invoice.") };
    }
    const billingLines = await loadEffectiveApprovedBillingLines(client, validated.jobId);
    const currencies = new Set(billingLines.map((line) => line.currency));
    const approvedMinor = billingLines.reduce(
      (sum, line) => sum + Number(line.line_total_minor), 0
    );
    const extraWorkMinor = extraWorkResult.items.reduce(
      (sum, line) => sum + line.lineTotalMinor, 0
    );
    const totalMinor = approvedMinor + extraWorkMinor;
    if (
      !billingLines.length || currencies.size !== 1 || approvedMinor <= 0 ||
      !Number.isSafeInteger(approvedMinor) || !Number.isSafeInteger(extraWorkMinor) ||
      totalMinor <= 0 || !Number.isSafeInteger(totalMinor)
    ) {
      return { abort: failure(409, "INVOICE_BILLING_BASIS_UNAVAILABLE", "Approved billing details are unavailable.") };
    }
    const paidMinor = Math.min(
      totalMinor,
      await loadApplicablePaymentsReceived(client, validated.jobId, billingLines)
    );
    const balanceMinor = totalMinor - paidMinor;
    const jobParty = await loadJobCustomerParty(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    const invoiceCustomerParty = resolveInvoiceCustomerParty({
      jobParty,
      quoteParties: billingLines.map((line) => ({
        sourceQuoteId: line.quote_id,
        party: customerPartyProjection({
          contractor_profile_id:
            line.customer_party_contractor_profile_id,
          business_contact_id: line.business_contact_id,
          business_customer_relationship_id:
            line.business_customer_relationship_id,
        }),
      })),
    });
    if (invoiceCustomerParty.error) {
      return {
        abort: failure(
          409,
          "INVOICE_CUSTOMER_PARTY_CONFLICT",
          "The approved Quote and Job customer links do not agree."
        ),
      };
    }
    const invoiceId = randomUUID();
    const invoiceNumber = `INV-${invoiceId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    const invoiceDate = today();
    const currency = [...currencies][0];
    const versionHash = invoiceVersionHash({
      invoiceId, version: 1, jobId: validated.jobId, status: "DRAFT", currency,
      subtotalMinor: totalMinor, totalMinor, paidMinor, balanceMinor,
      invoiceDate, due: { mode: dueMode, date: dueDate }, customerNotes, terms,
    });
    await client.query(
      `INSERT INTO canonical_invoices (
        id, job_id, job_request_id, relationship_id,
        issuer_participant_id, invoice_number
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [invoiceId, validated.jobId, context.job_request_id, context.relationship_id,
        context.professional_participant_id, invoiceNumber]
    );
    await insertCanonicalInvoiceCustomerParty(client, {
      invoiceId,
      jobId: validated.jobId,
      actorUserId: validated.actorId,
      source: invoiceCustomerParty,
    });
    await client.query(
      `INSERT INTO canonical_invoice_versions (
        invoice_id, version, job_id, status, currency,
        subtotal_minor, total_minor, paid_minor, balance_minor,
        invoice_date, due_mode, due_date, customer_notes, terms,
        created_by_participant_id, integrity_hash
      ) VALUES ($1, 1, $2, 'DRAFT', $3, $4, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13)`,
      [invoiceId, validated.jobId, currency, totalMinor, paidMinor, balanceMinor, invoiceDate,
        dueMode, dueDate, customerNotes, terms,
        context.professional_participant_id, versionHash]
    );
    for (const [index, line] of billingLines.entries()) {
      await client.query(
        `INSERT INTO canonical_invoice_line_item_snapshots (
          id, invoice_id, invoice_version, job_id, sequence,
          source_type,
          source_quote_id, source_quote_version, source_scope_item_id,
          lineage_label, description, quantity, unit_amount_minor,
          line_total_minor, created_by_participant_id
        ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [randomUUID(), invoiceId, validated.jobId, index + 1,
          INVOICE_LINE_SOURCE_TYPES.APPROVED_QUOTE_SCOPE,
          line.quote_id, line.quote_version, line.scope_item_id,
          line.lineage_label, line.description, line.quantity,
          line.unit_amount_minor, line.line_total_minor,
          context.professional_participant_id]
      );
    }
    for (const [index, line] of extraWorkResult.items.entries()) {
      await client.query(
        `INSERT INTO canonical_invoice_line_item_snapshots (
          id, invoice_id, invoice_version, job_id, sequence, source_type,
          source_quote_id, source_quote_version, source_scope_item_id,
          lineage_label, description, quantity, unit_amount_minor,
          line_total_minor, created_by_participant_id
        ) VALUES ($1, $2, 1, $3, $4, 'EXTRA_WORK',
          NULL, NULL, NULL, NULL, $5, $6, $7, $8, $9)`,
        [randomUUID(), invoiceId, validated.jobId, billingLines.length + index + 1,
          line.description, line.quantity, line.unitAmountMinor,
          line.lineTotalMinor, context.professional_participant_id]
      );
    }
    const loaded = await loadInvoiceContext(client, invoiceId, validated.actorId);
    const invoice = await loadInvoiceProjection(client, loaded, "professional");
    const result = {
      ok: true, success: true, status: 201,
      code: "INVOICE_CREATED", invoice,
    };
    await completeCommand(client, reserved.row.id, invoiceId, result);
    return result;
  });
}

function invoiceMessageSnapshot(invoice) {
  return {
    schemaVersion: 1,
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    jobId: invoice.jobId,
    status: "SENT",
    totalMinor: invoice.totalMinor,
    balanceMinor: invoice.balanceMinor,
    currency: invoice.currency,
    due: invoice.due,
    business: invoice.business,
    job: invoice.job,
    issuedAt: invoice.issuedAt,
  };
}

async function issueInvoice(input = {}) {
  const validated = validateInput(
    input, ["invoiceId", "expectedVersion", "idempotencyKey"], { invoice: true }
  );
  if (validated.error) return validated.error;
  const expectedVersion = positiveInteger(input.expectedVersion);
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (!expectedVersion || idempotency.error) {
    return idempotency.error || failure(400, "INVALID_INVOICE_ISSUE_COMMAND", "The Invoice issue command is invalid.");
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadInvoiceContext(
      client, validated.invoiceId, validated.actorId, { lock: true }
    );
    if (!professionalAuthorized(context, validated.actorId)) {
      return { abort: failure(403, "INVOICE_AUTHORITY_DENIED", "Invoice authority is unavailable.") };
    }
    const fingerprint = hash({
      command: "invoice.issue", actorId: validated.actorId,
      invoiceId: validated.invoiceId, jobId: context.job_id, expectedVersion,
    });
    const reserved = await reserveCommand(client, {
      actorId: validated.actorId, commandName: "invoice.issue",
      jobId: context.job_id, invoiceId: validated.invoiceId,
      idempotencyKey: idempotency.idempotencyKey, fingerprint,
    });
    if (reserved.error) return { abort: reserved.error };
    if (reserved.replay) return reserved.replay;
    if (Number(context.version) !== expectedVersion) {
      return { abort: failure(409, "STALE_INVOICE_VERSION", "The Invoice version is stale.") };
    }
    if (context.status !== "DRAFT") {
      return { abort: failure(409, "INVOICE_NOT_ISSUABLE", "Only a Draft Invoice can be sent.") };
    }
    const conversation = {
      id: positiveInteger(context.conversation_id),
      homeowner_id: Number(context.homeowner_id),
      professional_user_id: Number(context.professional_user_id),
      status: context.conversation_status,
    };
    const receiverId = resolveCommunicationRecipient(conversation, validated.actorId);
    if (!conversation.id || conversation.status !== "active" || !receiverId) {
      return { abort: failure(409, "INVOICE_CONVERSATION_UNAVAILABLE", "The Invoice cannot be sent in Meetro.") };
    }
    const nextVersion = expectedVersion + 1;
    const issuedAt = new Date().toISOString();
    const issuedPaidMinor = Number(context.paid_minor);
    const issuedBalanceMinor = Number(context.balance_minor);
    const issuedStatus = issuedPaidMinor === Number(context.total_minor)
      ? "PAID"
      : issuedPaidMinor > 0
        ? "PARTIALLY_PAID"
        : "SENT";
    const versionHash = invoiceVersionHash({
      invoiceId: context.invoice_id, version: nextVersion,
      jobId: context.job_id, status: issuedStatus, currency: context.currency,
      subtotalMinor: Number(context.subtotal_minor), totalMinor: Number(context.total_minor),
      paidMinor: issuedPaidMinor, balanceMinor: issuedBalanceMinor,
      invoiceDate: sqlDate(context.invoice_date),
      due: dueProjection(context), customerNotes: context.customer_notes,
      terms: context.terms, issuedAt,
    });
    await client.query(
      `INSERT INTO canonical_invoice_versions (
        invoice_id, version, job_id, status, currency,
        subtotal_minor, total_minor, paid_minor, balance_minor,
        invoice_date, due_mode, due_date, customer_notes, terms,
        created_by_participant_id, integrity_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16)`,
      [context.invoice_id, nextVersion, context.job_id, issuedStatus,
        context.currency, context.subtotal_minor, context.total_minor,
        issuedPaidMinor, issuedBalanceMinor,
        sqlDate(context.invoice_date), context.due_mode,
        context.due_date ? sqlDate(context.due_date) : null,
        context.customer_notes, context.terms,
        context.professional_participant_id, versionHash]
    );
    await ensureConversationParticipantStatesWithClient({
      client, conversationId: conversation.id,
    });
    const attention = await getCommunicationAttentionWindowWithClient({
      client, conversationId: conversation.id, recipientUserId: receiverId,
    });
    const provisional = {
      ...context, version: nextVersion, status: issuedStatus,
      paid_minor: issuedPaidMinor, balance_minor: issuedBalanceMinor, issued_at: issuedAt,
    };
    const invoice = await loadInvoiceProjection(client, provisional, "professional");
    const snapshot = invoiceMessageSnapshot(invoice);
    const deliveryFingerprint = hash({
      command: "invoice.issue", actorId: validated.actorId,
      invoiceId: validated.invoiceId, expectedVersion,
    });
    const inserted = await client.query(
      `INSERT INTO messages (
        quote_request_id, conversation_id, sender_id, receiver_id,
        message_text, image_url, message_type, workflow_type, workflow_status,
        workflow_payload, invoice_id, job_id,
        invoice_delivery_idempotency_key, invoice_delivery_request_fingerprint
      ) VALUES (
        NULL, $1, $2, $3, $4, NULL, 'invoice_shared', 'INVOICE_SHARED', 'SENT',
        $5::jsonb, $6, $7, $8, $9
      ) RETURNING id, conversation_id, sender_id, receiver_id, message_text,
        message_type, workflow_type, workflow_status, workflow_payload,
        invoice_id, job_id, invoice_delivery_request_fingerprint, created_at`,
      [conversation.id, validated.actorId, receiverId,
        `${context.business_name || "Professional"} shared an Invoice.`,
        JSON.stringify(snapshot), context.invoice_id, context.job_id,
        idempotency.idempotencyKey, deliveryFingerprint]
    );
    const message = inserted.rows[0];
    if (!message) throw new Error("Invoice delivery message was not created.");
    await client.query(
      `INSERT INTO canonical_invoice_issuances (
        invoice_id, invoice_version, job_id, conversation_id, message_id,
        issued_by_participant_id, issued_at, source_integrity_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [context.invoice_id, nextVersion, context.job_id, conversation.id,
        message.id, context.professional_participant_id, issuedAt, versionHash]
    );
    await advanceConversationParticipantReadStateWithClient({
      client, conversation, participantUserId: validated.actorId,
      lastReadMessageId: message.id, lastReadAt: message.created_at || null,
    });
    await client.query(
      `UPDATE conversations SET updated_at = COALESCE($2, CURRENT_TIMESTAMP) WHERE id = $1`,
      [conversation.id, message.created_at || null]
    );
    await createOrRefreshCommunicationMessageAlert({
      client, conversation, senderUserId: validated.actorId,
      recipientUserId: receiverId,
      recipientLastReadMessageId: attention.lastReadMessageId,
      message,
    });
    const refreshed = await loadInvoiceContext(client, validated.invoiceId, validated.actorId);
    const issuedInvoice = await loadInvoiceProjection(client, refreshed, "professional");
    const result = {
      ok: true, success: true, status: 201, code: "INVOICE_SENT_IN_MEETRO",
      invoice: issuedInvoice,
      delivery: {
        messageId: Number(message.id), conversationId: conversation.id,
        invoiceId: context.invoice_id, jobId: context.job_id,
        messageType: WORKFLOW_TYPE, state: "SENT_IN_MEETRO",
        sentAt: iso(message.created_at), replayed: false,
      },
    };
    await completeCommand(client, reserved.row.id, context.invoice_id, result);
    return result;
  });
}

async function recordPayment(input = {}) {
  const validated = validateInput(input, [
    "invoiceId", "expectedVersion", "amountMinor", "method",
    "receivedDate", "customerReference", "idempotencyKey",
  ], { invoice: true });
  if (validated.error) return validated.error;
  const expectedVersion = positiveInteger(input.expectedVersion);
  const amountMinor = positiveInteger(input.amountMinor);
  const method = typeof input.method === "string" ? input.method.trim().toUpperCase() : "";
  const receivedDate = dateOnly(input.receivedDate);
  const customerReference = optionalText(input.customerReference, 500);
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (
    !expectedVersion || !amountMinor || !PAYMENT_METHODS.has(method) ||
    !receivedDate || receivedDate > today() || idempotency.error ||
    (input.customerReference != null && input.customerReference !== "" && !customerReference)
  ) return failure(400, "INVALID_PAYMENT_COMMAND", "The Payment details are invalid.");

  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadInvoiceContext(
      client, validated.invoiceId, validated.actorId, { lock: true }
    );
    if (!professionalAuthorized(context, validated.actorId)) {
      return { abort: failure(403, "PAYMENT_AUTHORITY_DENIED", "Payment authority is unavailable.") };
    }
    const fingerprint = hash({
      command: "payment.record", actorId: validated.actorId,
      invoiceId: validated.invoiceId, expectedVersion, amountMinor,
      method, receivedDate, customerReference,
    });
    const reserved = await reserveCommand(client, {
      actorId: validated.actorId, commandName: "payment.record",
      jobId: context.job_id, invoiceId: validated.invoiceId,
      idempotencyKey: idempotency.idempotencyKey, fingerprint,
    });
    if (reserved.error) return { abort: reserved.error };
    if (reserved.replay) return reserved.replay;
    if (Number(context.version) !== expectedVersion) {
      return { abort: failure(409, "STALE_INVOICE_VERSION", "The Invoice version is stale.") };
    }
    if (!["SENT", "PARTIALLY_PAID"].includes(context.status)) {
      return { abort: failure(409, "PAYMENT_NOT_RECORDABLE", "Payment cannot be recorded for this Invoice.") };
    }
    const balanceMinor = Number(context.balance_minor);
    if (amountMinor > balanceMinor) {
      return { abort: failure(409, "PAYMENT_EXCEEDS_BALANCE", "Payment cannot exceed the remaining balance.") };
    }
    const paidMinor = Number(context.paid_minor) + amountMinor;
    const remainingMinor = balanceMinor - amountMinor;
    const status = remainingMinor === 0 ? "PAID" : "PARTIALLY_PAID";
    const nextVersion = expectedVersion + 1;
    const versionHash = invoiceVersionHash({
      invoiceId: context.invoice_id, version: nextVersion,
      jobId: context.job_id, status, currency: context.currency,
      subtotalMinor: Number(context.subtotal_minor), totalMinor: Number(context.total_minor),
      paidMinor, balanceMinor: remainingMinor,
      invoiceDate: sqlDate(context.invoice_date),
      due: dueProjection(context), customerNotes: context.customer_notes,
      terms: context.terms,
    });
    await client.query(
      `INSERT INTO canonical_invoice_versions (
        invoice_id, version, job_id, status, currency,
        subtotal_minor, total_minor, paid_minor, balance_minor,
        invoice_date, due_mode, due_date, customer_notes, terms,
        created_by_participant_id, integrity_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16)`,
      [context.invoice_id, nextVersion, context.job_id, status, context.currency,
        context.subtotal_minor, context.total_minor, paidMinor, remainingMinor,
        sqlDate(context.invoice_date), context.due_mode,
        context.due_date ? sqlDate(context.due_date) : null,
        context.customer_notes, context.terms,
        context.professional_participant_id, versionHash]
    );
    const paymentId = randomUUID();
    const recordedAt = new Date().toISOString();
    const evidenceHash = paymentHash({
      paymentId, invoiceId: context.invoice_id, invoiceVersion: nextVersion,
      jobId: context.job_id, amountMinor, currency: context.currency,
      receivedDate, method, customerReference, recordedAt,
    });
    await client.query(
      `INSERT INTO canonical_invoice_payments (
        id, invoice_id, invoice_version, job_id, amount_minor, currency,
        received_date, method, customer_reference,
        recorded_by_participant_id, integrity_hash, recorded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [paymentId, context.invoice_id, nextVersion, context.job_id,
        amountMinor, context.currency, receivedDate, method,
        customerReference, context.professional_participant_id,
        evidenceHash, recordedAt]
    );
    const refreshed = await loadInvoiceContext(client, validated.invoiceId, validated.actorId);
    const invoice = await loadInvoiceProjection(client, refreshed, "professional");
    const payment = invoice.payments.find((item) => item.paymentId === paymentId);
    const result = {
      ok: true, success: true, status: 201, code: "PAYMENT_RECORDED",
      invoice, payment,
    };
    await completeCommand(client, reserved.row.id, context.invoice_id, result);
    return result;
  });
}

async function getProfessionalInvoice(input = {}) {
  const validated = validateInput(input, ["invoiceId"], { invoice: true });
  if (validated.error) return validated.error;
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const context = await loadInvoiceContext(client, validated.invoiceId, validated.actorId);
    if (!professionalAuthorized(context, validated.actorId)) {
      return { abort: failure(404, "INVOICE_UNAVAILABLE", "The Invoice is unavailable.") };
    }
    return {
      ok: true, success: true, status: 200, code: "PROFESSIONAL_INVOICE_LOADED",
      invoice: await loadInvoiceProjection(client, context, "professional"),
    };
  });
}

async function getProfessionalJobInvoice(input = {}) {
  const validated = validateInput(input, ["jobId"], { job: true });
  if (validated.error) return validated.error;
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const result = await client.query(
      `SELECT invoices.id AS invoice_id
       FROM canonical_invoices invoices
       INNER JOIN request_relationships relationships
         ON relationships.id = invoices.relationship_id
         AND relationships.professional_user_id = $2
       WHERE invoices.job_id = $1
       LIMIT 1`,
      [validated.jobId, validated.actorId]
    );
    if (!result.rows[0]) {
      return { abort: failure(404, "INVOICE_UNAVAILABLE", "The Invoice is unavailable.") };
    }
    const context = await loadInvoiceContext(
      client, result.rows[0].invoice_id, validated.actorId
    );
    if (!professionalAuthorized(context, validated.actorId)) {
      return { abort: failure(404, "INVOICE_UNAVAILABLE", "The Invoice is unavailable.") };
    }
    return {
      ok: true, success: true, status: 200, code: "PROFESSIONAL_INVOICE_LOADED",
      invoice: await loadInvoiceProjection(client, context, "professional"),
    };
  });
}

async function getCustomerInvoice(input = {}) {
  const validated = validateInput(input, ["invoiceId"], { invoice: true });
  if (validated.error) return validated.error;
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const context = await loadCustomerInvoiceContext(client, {
      invoiceId: validated.invoiceId, actorId: validated.actorId,
    });
    if (!context) {
      return { abort: failure(404, "INVOICE_UNAVAILABLE", "The Invoice is unavailable.") };
    }
    return {
      ok: true, success: true, status: 200, code: "CUSTOMER_INVOICE_LOADED",
      invoice: await loadInvoiceProjection(client, context, "customer"),
    };
  });
}

async function getCustomerJobInvoice(input = {}) {
  const validated = validateInput(input, ["jobId"], { job: true });
  if (validated.error) return validated.error;
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const context = await loadCustomerInvoiceContext(client, {
      jobId: validated.jobId, actorId: validated.actorId,
    });
    if (!context) {
      return { abort: failure(404, "INVOICE_UNAVAILABLE", "The Invoice is unavailable.") };
    }
    return {
      ok: true, success: true, status: 200, code: "CUSTOMER_INVOICE_LOADED",
      invoice: await loadInvoiceProjection(client, context, "customer"),
    };
  });
}

function workspaceLimit(value) {
  if (value == null || value === "") return DEFAULT_WORKSPACE_LIMIT;
  const parsed = positiveInteger(value);
  return parsed && parsed <= MAX_WORKSPACE_LIMIT ? parsed : null;
}

async function getProfessionalInvoiceWorkspace(input = {}) {
  const validated = validateInput(input, ["limit"]);
  if (validated.error) return validated.error;
  const limit = workspaceLimit(input.limit);
  if (!limit) return failure(400, "INVALID_INVOICE_WORKSPACE_LIMIT", "The Invoice workspace limit is invalid.");
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const ready = await client.query(
      `WITH completion_evidence AS (
         SELECT completions.job_id, completions.version AS completion_version,
           completions.completed_at, 1 AS precedence
         FROM canonical_job_completion_records completions
         UNION ALL
         SELECT executions.job_id, current.version AS completion_version,
           current.created_at AS completed_at, 2 AS precedence
         FROM canonical_approved_work_executions executions
         INNER JOIN LATERAL (
           SELECT version, state, command_idempotency_id, created_at
           FROM canonical_approved_work_execution_versions versions
           WHERE versions.execution_id = executions.id
             AND versions.job_id = executions.job_id
           ORDER BY version DESC LIMIT 1
         ) current ON TRUE
         INNER JOIN canonical_approved_work_execution_command_idempotency commands
           ON commands.id = current.command_idempotency_id
           AND commands.job_id = executions.job_id
           AND commands.command_scope =
             'execution:' || executions.id::text || ':complete-work'
           AND commands.completed_at IS NOT NULL
           AND commands.result_reference ->> 'code' = 'APPROVED_WORK_COMPLETED'
         WHERE current.state = 'CLOSED'
       ), current_completions AS (
         SELECT DISTINCT ON (job_id)
           job_id, completion_version, completed_at
         FROM completion_evidence
         ORDER BY job_id, precedence ASC, completed_at DESC
       )
       SELECT jobs.id AS job_id, jobs.job_request_id AS request_id,
        jobs.source_request_relationship_id AS relationship_id,
        completions.completion_version, completions.completed_at,
        posts.title AS service_title,
        homeowner.username AS customer_name
      FROM current_completions completions
      INNER JOIN jobs ON jobs.id = completions.job_id
      INNER JOIN posts ON posts.id = jobs.job_request_id
      INNER JOIN request_relationships relationships
        ON relationships.id = jobs.source_request_relationship_id
        AND relationships.professional_user_id = $1
      INNER JOIN users homeowner ON homeowner.id = relationships.homeowner_id
      INNER JOIN relationship_participants professional
        ON professional.job_id = jobs.id
        AND professional.request_relationship_id = relationships.id
        AND professional.user_id = $1
      LEFT JOIN canonical_invoices invoices ON invoices.job_id = jobs.id
      WHERE invoices.id IS NULL
        AND EXISTS (
          SELECT 1 FROM participant_role_assignments roles
          LEFT JOIN participant_role_revocations revocations
            ON revocations.role_assignment_id = roles.id
          WHERE roles.participant_id = professional.id
            AND roles.job_id = jobs.id AND roles.role = 'PRIMARY_PROFESSIONAL'
            AND roles.valid_from <= CURRENT_TIMESTAMP
            AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
            AND revocations.id IS NULL
        )
      ORDER BY completions.completed_at ASC, jobs.id ASC
      LIMIT $2`,
      [validated.actorId, limit]
    );
    const readyJobs = [];
    for (const row of ready.rows) {
      const approvedLines = await loadEffectiveApprovedBillingLines(client, row.job_id);
      const currencies = new Set(approvedLines.map((line) => line.currency));
      const approvedMinor = approvedLines.reduce(
        (sum, line) => sum + Number(line.line_total_minor), 0
      );
      const paymentsReceivedMinor = await loadApplicablePaymentsReceived(
        client, row.job_id, approvedLines
      );
      const currency = currencies.size === 1 ? [...currencies][0] : null;
      readyJobs.push({
        jobId: row.job_id,
        requestId: Number(row.request_id),
        relationshipId: Number(row.relationship_id),
        customerName: row.customer_name || "Customer",
        serviceTitle: row.service_title || "Job",
        completedAt: iso(row.completed_at),
        completionVersion: Number(row.completion_version),
        approvedAmount: currency && Number.isSafeInteger(approvedMinor)
          ? { currency, totalMinor: approvedMinor }
          : null,
        paymentsReceivedMinor,
        amountStillDueMinor: Number.isSafeInteger(approvedMinor)
          ? Math.max(0, approvedMinor - paymentsReceivedMinor)
          : null,
        approvedWork: approvedLines.map((line) => ({
          description: line.description,
          quantity: Number(line.quantity),
          unitAmountMinor: Number(line.unit_amount_minor),
          lineTotalMinor: Number(line.line_total_minor),
        })),
      });
    }
    const invoices = await client.query(
      `SELECT invoices.id AS invoice_id, invoices.invoice_number, invoices.job_id,
        invoices.job_request_id AS request_id, invoices.relationship_id,
        current.version, current.status, current.currency,
        current.total_minor, current.paid_minor, current.balance_minor,
        current.invoice_date, current.due_mode, current.due_date,
        current.created_at AS updated_at, issuances.issued_at,
        posts.title AS service_title, homeowner.username AS customer_name
      FROM canonical_invoices invoices
      INNER JOIN request_relationships relationships
        ON relationships.id = invoices.relationship_id
        AND relationships.professional_user_id = $1
      INNER JOIN posts ON posts.id = invoices.job_request_id
      INNER JOIN users homeowner ON homeowner.id = relationships.homeowner_id
      INNER JOIN LATERAL (
        SELECT * FROM canonical_invoice_versions versions
        WHERE versions.invoice_id = invoices.id
        ORDER BY versions.version DESC LIMIT 1
      ) current ON TRUE
      LEFT JOIN canonical_invoice_issuances issuances ON issuances.invoice_id = invoices.id
      ORDER BY current.created_at DESC, invoices.id DESC
      LIMIT $2`,
      [validated.actorId, limit]
    );
    const rows = invoices.rows.map((row) => ({
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      jobId: row.job_id,
      requestId: Number(row.request_id),
      relationshipId: Number(row.relationship_id),
      customerName: row.customer_name || "Customer",
      serviceTitle: row.service_title || "Job",
      currentVersion: Number(row.version),
      status: row.status,
      currency: row.currency,
      totalMinor: Number(row.total_minor),
      paidMinor: Number(row.paid_minor),
      balanceMinor: Number(row.balance_minor),
      invoiceDate: sqlDate(row.invoice_date),
      due: dueProjection(row),
      issuedAt: iso(row.issued_at),
    }));
    const currencies = new Set(rows.filter((row) => row.balanceMinor > 0).map((row) => row.currency));
    const summaryCurrency = currencies.size === 1 ? [...currencies][0] : null;
    return {
      ok: true, success: true, status: 200, code: "PROFESSIONAL_INVOICE_WORKSPACE_LOADED",
      workspace: {
        contractVersion: CONTRACT_VERSION,
        summary: {
          readyToInvoice: readyJobs.length,
          drafts: rows.filter((row) => row.status === "DRAFT").length,
          waitingForPayment: rows.filter((row) => ["SENT", "PARTIALLY_PAID"].includes(row.status)).length,
          paid: rows.filter((row) => row.status === "PAID").length,
          totalOutstandingMinor: summaryCurrency
            ? rows.reduce((sum, row) => sum + row.balanceMinor, 0)
            : null,
          currency: summaryCurrency,
        },
        readyJobs,
        invoices: rows,
        limit,
      },
    };
  });
}

module.exports = {
  CONTRACT_VERSION,
  INVOICE_LINE_SOURCE_TYPES,
  INVOICE_STATUSES,
  MESSAGE_TYPE,
  PAYMENT_METHODS,
  WORKFLOW_STATUS,
  WORKFLOW_TYPE,
  createInvoice,
  getCustomerInvoice,
  getCustomerJobInvoice,
  getProfessionalInvoice,
  getProfessionalJobInvoice,
  getProfessionalInvoiceWorkspace,
  issueInvoice,
  recordPayment,
  invoicePaymentInternals: Object.freeze({
    canonicalJson,
    createCommandFingerprint,
    dateOnly,
    dueProjection,
    hash,
    invoiceMessageSnapshot,
    invoiceProjection,
    invoiceVersionHash,
    lineProjection,
    normalizeExtraWorkItems,
    paymentHash,
    paymentProjection,
    professionalAuthorized,
    sqlDate,
    workspaceLimit,
  }),
};
