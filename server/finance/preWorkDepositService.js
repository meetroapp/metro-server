"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");
const {
  deriveQuoteDepositGate,
} = require("../authorization/quoteDecisionHandoff");

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
const NORMALIZED_METHOD_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const REVERSAL_REASONS = new Set([
  "REFUND",
  "REVERSAL",
  "CORRECTION",
  "CHARGEBACK",
]);
const COMMANDS = Object.freeze({
  MATERIALIZE: "deposit.materialize",
  RECORD: "deposit.payment.record",
  ALLOCATE: "deposit.payment.allocate",
  REVERSE: "deposit.payment.reverse",
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

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function optionalText(value, maximum) {
  if (value == null || value === "") return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= maximum ? normalized : null;
}

function positiveMinor(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isoInstant(value, { futureAllowed = false } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!futureAllowed && parsed.getTime() > Date.now()) return null;
  return parsed.toISOString();
}

function parseMajorAmount(value) {
  const normalized = String(value || "").replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [major, fraction = ""] = normalized.split(".");
  const minor = Number(major) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

function fixedDepositMinor(paymentTerms) {
  const values = [];
  const patterns = [
    /\b(?:deposit|down payment)(?:\s+(?:required|due(?:\s+on\s+approval)?))?\s*(?:[-—:]\s*)?\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)\b/gi,
    /\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s+(?:deposit|down payment)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of String(paymentTerms || "").matchAll(pattern)) {
      const minor = parseMajorAmount(match[1]);
      if (minor != null && !values.includes(minor)) values.push(minor);
    }
  }
  return values.length === 1 ? values[0] : null;
}

function deriveDepositRequirement({ customerTermsSnapshot, totalMinor } = {}) {
  const gate = deriveQuoteDepositGate({ customerTermsSnapshot, totalMinor });
  if (gate.state === "NONE") {
    return Object.freeze({
      kind: "NOT_REQUIRED",
      paymentTerms: gate.paymentTerms,
    });
  }
  if (gate.state === "DEPOSIT_DUE") {
    return Object.freeze({
      kind: "REQUIRED",
      paymentTerms: gate.paymentTerms,
      ruleType: "PERCENT",
      percentBasisPoints: Math.round(gate.percent * 100),
      fixedMinor: null,
      requiredMinor: gate.dueMinor,
    });
  }
  const fixedMinor = fixedDepositMinor(gate.paymentTerms);
  const canonicalTotal = Number(totalMinor);
  if (
    fixedMinor != null &&
    fixedMinor > 0 &&
    Number.isSafeInteger(canonicalTotal) &&
    fixedMinor <= canonicalTotal
  ) {
    return Object.freeze({
      kind: "REQUIRED",
      paymentTerms: gate.paymentTerms,
      ruleType: "FIXED",
      percentBasisPoints: null,
      fixedMinor,
      requiredMinor: fixedMinor,
    });
  }
  return Object.freeze({
    kind: "UNVERIFIED",
    paymentTerms: gate.paymentTerms,
  });
}

function validateInput(input, allowedFields) {
  const allowed = new Set(["pool", "authenticatedActor", "logger", ...allowedFields]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return {
      error: failure(
        400,
        "PRE_WORK_DEPOSIT_FIELD_REJECTED",
        "Server-owned deposit authority fields cannot be supplied."
      ),
    };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return {
      error: failure(400, "INVALID_PRE_WORK_DEPOSIT_JOB", "A valid Job is required."),
    };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  return { actorId: actor.id, jobId, logger: safeLogger(input.logger) };
}

async function runTransaction(pool, mode, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${mode}`);
    started = true;
    const outcome = await action(client);
    if (outcome?.abort) {
      await rollback(client);
      started = false;
      return outcome.abort;
    }
    await client.query("COMMIT");
    started = false;
    return outcome?.result ?? outcome;
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
      relationships.status AS relationship_status,
      relationships.homeowner_id, relationships.professional_user_id,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
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
      ) AS primary_professional_active
     FROM jobs
     INNER JOIN posts
       ON posts.id = jobs.job_request_id
       AND posts.lifecycle_contract_version = 2
       AND posts.cancelled_at IS NULL
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
       AND relationships.post_id = jobs.job_request_id
       AND relationships.emergency_request_id IS NULL
       AND relationships.status = 'active'
       AND relationships.professional_user_id = $2
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id
       AND professional.request_relationship_id = relationships.id
       AND professional.user_id = relationships.professional_user_id
     INNER JOIN relationship_participants customer
       ON customer.job_id = jobs.id
       AND customer.request_relationship_id = relationships.id
       AND customer.user_id = relationships.homeowner_id
     WHERE jobs.id = $1 AND jobs.lifecycle_contract_version = 2
     LIMIT 1
     ${lock ? "FOR UPDATE OF jobs, relationships" : ""}`,
    [jobId, actorId]
  );
  const context = result.rows[0] || null;
  return context && context.primary_professional_active === true ? context : null;
}

async function loadApprovedDecisionSource(client, {
  jobId,
  decisionId = null,
  lock = false,
} = {}) {
  const values = [jobId];
  let decisionFilter = "";
  if (decisionId) {
    values.push(decisionId);
    decisionFilter = `AND decisions.id = $${values.length}`;
  }
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.status AS relationship_status,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      decisions.id AS customer_decision_id,
      decisions.decision, decisions.issued_quote_version,
      decisions.issued_integrity_hash, decisions.decided_at,
      decisions.customer_participant_id AS decision_customer_participant_id,
      quotes.id AS quote_id, quotes.status AS quote_status,
      versions.status AS quote_version_status,
      versions.currency, versions.total_minor,
      versions.customer_terms_snapshot,
      versions.integrity_hash AS quote_version_integrity_hash,
      issuances.source_snapshot_integrity_hash AS issuance_integrity_hash
     FROM jobs
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
       AND relationships.post_id = jobs.job_request_id
       AND relationships.emergency_request_id IS NULL
       AND relationships.status = 'active'
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id
       AND professional.request_relationship_id = relationships.id
       AND professional.user_id = relationships.professional_user_id
     INNER JOIN relationship_participants customer
       ON customer.job_id = jobs.id
       AND customer.request_relationship_id = relationships.id
       AND customer.user_id = relationships.homeowner_id
     INNER JOIN canonical_quote_customer_decisions decisions
       ON decisions.job_id = jobs.id
       AND decisions.relationship_id = relationships.id
       AND decisions.customer_participant_id = customer.id
       AND decisions.decision = 'APPROVED'
     INNER JOIN canonical_quotes quotes
       ON quotes.id = decisions.quote_id
       AND quotes.job_id = jobs.id
       AND quotes.relationship_id = relationships.id
       AND quotes.status = 'ISSUED'
     INNER JOIN canonical_quote_versions versions
       ON versions.quote_id = quotes.id
       AND versions.job_id = jobs.id
       AND versions.version = decisions.issued_quote_version
       AND versions.status = 'ISSUED'
     INNER JOIN canonical_quote_issuances issuances
       ON issuances.quote_id = quotes.id
       AND issuances.job_id = jobs.id
       AND issuances.quote_version = decisions.issued_quote_version
       AND issuances.source_snapshot_integrity_hash = decisions.issued_integrity_hash
     WHERE jobs.id = $1
       AND jobs.lifecycle_contract_version = 2
       ${decisionFilter}
     ORDER BY decisions.decided_at DESC, decisions.id DESC
     LIMIT 1
     ${lock ? "FOR UPDATE OF jobs, relationships, quotes, decisions" : ""}`,
    values
  );
  const source = result.rows[0] || null;
  if (
    source &&
    (
      source.decision !== "APPROVED" ||
      source.quote_status !== "ISSUED" ||
      source.quote_version_status !== "ISSUED" ||
      source.issued_integrity_hash !== source.quote_version_integrity_hash ||
      source.issued_integrity_hash !== source.issuance_integrity_hash ||
      source.customer_participant_id !== source.decision_customer_participant_id
    )
  ) {
    throw new Error("Pre-work deposit commercial source integrity failed.");
  }
  return source;
}

async function loadObligation(client, decisionId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT obligations.*,
      latest.version AS latest_version,
      latest.state AS latest_state,
      latest.required_minor AS latest_required_minor,
      latest.applied_minor AS latest_applied_minor,
      latest.remaining_minor AS latest_remaining_minor,
      latest.created_at AS latest_version_created_at
     FROM canonical_pre_work_deposit_obligations obligations
     INNER JOIN LATERAL (
       SELECT versions.version, versions.state, versions.required_minor,
         versions.applied_minor, versions.remaining_minor, versions.created_at
       FROM canonical_pre_work_deposit_versions versions
       WHERE versions.obligation_id = obligations.id
       ORDER BY versions.version DESC
       LIMIT 1
     ) latest ON TRUE
     WHERE obligations.customer_decision_id = $1
     LIMIT 1
     ${lock ? "FOR UPDATE OF obligations" : ""}`,
    [decisionId]
  );
  return result.rows[0] || null;
}

async function loadPaymentHistory(client, obligationId) {
  if (!obligationId) return [];
  const result = await client.query(
    `SELECT receipts.id, receipts.gross_amount_minor, receipts.currency,
      receipts.evidence_source, receipts.normalized_method,
      receipts.display_method, receipts.external_reference,
      receipts.received_at, receipts.created_at,
      COALESCE(allocations.allocated_minor, 0) AS allocated_minor,
      COALESCE(allocations.reversed_minor, 0) AS reversed_minor,
      COALESCE(allocations.net_applied_minor, 0) AS net_applied_minor
     FROM canonical_pre_work_payment_receipts receipts
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(allocation.allocated_minor), 0) AS allocated_minor,
         COALESCE(sum(allocation.allocated_minor), 0) -
           COALESCE(sum(allocation.reversed_minor), 0) AS net_applied_minor,
         COALESCE(sum(allocation.reversed_minor), 0) AS reversed_minor
       FROM (
         SELECT payment_allocations.id, payment_allocations.allocated_minor,
           COALESCE(sum(reversals.reversed_minor), 0) AS reversed_minor
         FROM canonical_pre_work_payment_allocations payment_allocations
         LEFT JOIN canonical_pre_work_payment_allocation_reversals reversals
           ON reversals.allocation_id = payment_allocations.id
         WHERE payment_allocations.receipt_id = receipts.id
           AND payment_allocations.obligation_id = $1
         GROUP BY payment_allocations.id, payment_allocations.allocated_minor
       ) allocation
     ) allocations ON TRUE
     WHERE EXISTS (
       SELECT 1 FROM canonical_pre_work_payment_allocations payment_allocations
       WHERE payment_allocations.receipt_id = receipts.id
         AND payment_allocations.obligation_id = $1
     )
     ORDER BY receipts.received_at ASC, receipts.id ASC`,
    [obligationId]
  );
  return result.rows;
}

function depositProjection(source, requirement, obligation, history = []) {
  if (!source) return null;
  if (requirement.kind === "NOT_REQUIRED") {
    return {
      contractVersion: CONTRACT_VERSION,
      jobId: source.job_id,
      quoteId: source.quote_id,
      issuedQuoteVersion: Number(source.issued_quote_version),
      customerDecisionId: source.customer_decision_id,
      materialized: false,
      state: "NOT_REQUIRED",
      schedulingLocked: false,
      currency: source.currency,
      quoteTotalMinor: Number(source.total_minor),
      requiredMinor: 0,
      appliedMinor: 0,
      remainingMinor: 0,
      depositRule: null,
      latestVersion: null,
      paymentHistory: [],
    };
  }
  const state = obligation?.latest_state ||
    (requirement.kind === "UNVERIFIED" ? "TERMS_UNVERIFIED" : "DUE");
  const requiredMinor = obligation
    ? Number(obligation.latest_required_minor)
    : requirement.requiredMinor || null;
  const appliedMinor = obligation ? Number(obligation.latest_applied_minor) : 0;
  const remainingMinor = obligation
    ? Number(obligation.latest_remaining_minor)
    : requiredMinor;
  return {
    contractVersion: CONTRACT_VERSION,
    jobId: source.job_id,
    quoteId: source.quote_id,
    issuedQuoteVersion: Number(source.issued_quote_version),
    customerDecisionId: source.customer_decision_id,
    obligationId: obligation?.id || null,
    materialized: Boolean(obligation),
    state,
    schedulingLocked: state !== "SATISFIED",
    currency: source.currency,
    quoteTotalMinor: Number(source.total_minor),
    requiredMinor,
    appliedMinor,
    remainingMinor,
    depositRule: requirement.kind === "REQUIRED" ? {
      type: requirement.ruleType,
      percentBasisPoints: requirement.percentBasisPoints,
      fixedMinor: requirement.fixedMinor,
    } : null,
    latestVersion: obligation ? Number(obligation.latest_version) : null,
    paymentHistory: history.map((row) => ({
      receiptId: row.id,
      grossAmountMinor: Number(row.gross_amount_minor),
      currency: row.currency,
      evidenceSource: row.evidence_source,
      normalizedMethod: row.normalized_method,
      displayMethod: row.display_method,
      externalReference: row.external_reference,
      receivedAt: new Date(row.received_at).toISOString(),
      allocatedMinor: Number(row.allocated_minor),
      reversedMinor: Number(row.reversed_minor),
      netAppliedMinor: Number(row.net_applied_minor),
      unappliedMinor: Number(row.gross_amount_minor) - Number(row.allocated_minor),
    })),
  };
}

async function reserveCommand(client, {
  jobId,
  participantId = null,
  externalActor = null,
  commandName,
  commandScope,
  idempotencyKey,
  requestFingerprint,
}) {
  const actorType = participantId ? "PARTICIPANT" : "PROCESSOR";
  const inserted = await client.query(
    `INSERT INTO canonical_pre_work_payment_command_idempotency (
      id, job_id, actor_type, actor_participant_id,
      actor_external_reference, command_name, command_scope,
      idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      jobId,
      actorType,
      participantId,
      externalActor,
      commandName,
      commandScope,
      idempotencyKey,
      requestFingerprint,
    ]
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], replay: null };
  const existing = await client.query(
    `SELECT * FROM canonical_pre_work_payment_command_idempotency
     WHERE actor_type = $1
       AND command_name = $2
       AND command_scope = $3
       AND idempotency_key = $4
       AND (
         ($1 = 'PARTICIPANT' AND actor_participant_id = $5)
         OR ($1 = 'PROCESSOR' AND actor_external_reference = $6)
       )
     LIMIT 1
     FOR UPDATE`,
    [actorType, commandName, commandScope, idempotencyKey, participantId, externalActor]
  );
  const row = existing.rows[0];
  if (!row || row.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "PRE_WORK_DEPOSIT_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different deposit command."
      ),
    };
  }
  if (!row.result_reference || !row.completed_at) {
    throw new Error("A matching pre-work deposit command is still incomplete.");
  }
  return {
    row,
    replay: { ...row.result_reference, replayed: true, status: 200 },
  };
}

async function completeCommand(client, commandId, result) {
  const updated = await client.query(
    `UPDATE canonical_pre_work_payment_command_idempotency
     SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND result_reference IS NULL AND completed_at IS NULL`,
    [commandId, JSON.stringify(result)]
  );
  if (updated.rowCount !== 1) {
    throw new Error("Pre-work deposit command completion failed.");
  }
}

async function insertInitialObligation(client, source, requirement, commandId, actorParticipantId) {
  const obligationId = randomUUID();
  await client.query(
    `INSERT INTO canonical_pre_work_deposit_obligations (
      id, job_id, job_request_id, relationship_id,
      quote_id, issued_quote_version, customer_decision_id,
      customer_decision, customer_participant_id, currency,
      quote_total_minor, deposit_rule_type,
      deposit_percent_basis_points, deposit_fixed_minor,
      required_minor, source_integrity_hash, effective_at,
      created_by_participant_id, created_command_idempotency_id
     ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, 'APPROVED', $8, $9,
      $10, $11, $12, $13, $14, $15, $16, $17, $18
     )`,
    [
      obligationId,
      source.job_id,
      Number(source.job_request_id),
      Number(source.relationship_id),
      source.quote_id,
      Number(source.issued_quote_version),
      source.customer_decision_id,
      source.customer_participant_id,
      source.currency,
      Number(source.total_minor),
      requirement.ruleType,
      requirement.percentBasisPoints,
      requirement.fixedMinor,
      requirement.requiredMinor,
      source.issued_integrity_hash,
      source.decided_at,
      actorParticipantId,
      commandId,
    ]
  );
  const integrityHash = hash({
    obligationId,
    version: 1,
    state: "DUE",
    requiredMinor: requirement.requiredMinor,
    appliedMinor: 0,
    remainingMinor: requirement.requiredMinor,
  });
  await client.query(
    `INSERT INTO canonical_pre_work_deposit_versions (
      obligation_id, version, job_id, relationship_id, currency,
      state, required_minor, applied_minor, remaining_minor,
      recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES ($1, 1, $2, $3, $4, 'DUE', $5, 0, $5, $6, $7, $8)`,
    [
      obligationId,
      source.job_id,
      Number(source.relationship_id),
      source.currency,
      requirement.requiredMinor,
      actorParticipantId,
      commandId,
      integrityHash,
    ]
  );
  await client.query(
    `INSERT INTO canonical_pre_work_deposit_events (
      id, obligation_id, obligation_version, previous_obligation_version,
      job_id, event_type, obligation_state,
      recorded_by_participant_id, command_idempotency_id
     ) VALUES ($1, $2, 1, NULL, $3, 'DEPOSIT_OBLIGATION_CREATED',
       'DUE', $4, $5)`,
    [randomUUID(), obligationId, source.job_id, actorParticipantId, commandId]
  );
  return loadObligation(client, source.customer_decision_id, { lock: true });
}

async function materializeApprovedDecisionDepositWithClient({
  client,
  jobId,
  decisionId,
  actorParticipantId,
  idempotencyKey,
}) {
  const source = await loadApprovedDecisionSource(client, {
    jobId,
    decisionId,
    lock: true,
  });
  if (!source) {
    return {
      error: failure(
        409,
        "PRE_WORK_DEPOSIT_APPROVED_AGREEMENT_REQUIRED",
        "An exact approved Quote agreement is required."
      ),
    };
  }
  const requirement = deriveDepositRequirement({
    customerTermsSnapshot: source.customer_terms_snapshot,
    totalMinor: Number(source.total_minor),
  });
  if (requirement.kind !== "REQUIRED") {
    return { source, requirement, obligation: null, materialized: false };
  }
  const requestFingerprint = hash({
    command: COMMANDS.MATERIALIZE,
    jobId: source.job_id,
    relationshipId: Number(source.relationship_id),
    quoteId: source.quote_id,
    issuedQuoteVersion: Number(source.issued_quote_version),
    customerDecisionId: source.customer_decision_id,
    sourceIntegrityHash: source.issued_integrity_hash,
    requiredMinor: requirement.requiredMinor,
  });
  const reserved = await reserveCommand(client, {
    jobId: source.job_id,
    participantId: actorParticipantId,
    commandName: COMMANDS.MATERIALIZE,
    commandScope: `decision:${source.customer_decision_id}`,
    idempotencyKey,
    requestFingerprint,
  });
  if (reserved.error) return { error: reserved.error };
  if (reserved.replay) {
    const obligation = await loadObligation(client, source.customer_decision_id, {
      lock: true,
    });
    return { source, requirement, obligation, materialized: false, replayed: true };
  }
  let obligation = await loadObligation(client, source.customer_decision_id, {
    lock: true,
  });
  const materialized = !obligation;
  if (!obligation) {
    obligation = await insertInitialObligation(
      client,
      source,
      requirement,
      reserved.row.id,
      actorParticipantId
    );
  }
  const result = {
    code: materialized
      ? "PRE_WORK_DEPOSIT_MATERIALIZED"
      : "PRE_WORK_DEPOSIT_ALREADY_MATERIALIZED",
    obligationId: obligation.id,
    customerDecisionId: source.customer_decision_id,
    latestVersion: Number(obligation.latest_version),
  };
  await completeCommand(client, reserved.row.id, result);
  return { source, requirement, obligation, materialized };
}

async function getProfessionalDepositStatus(input = {}) {
  const validated = validateInput(input, ["jobId"]);
  if (validated.error) return validated.error;
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const context = await loadProfessionalJobContext(
      client,
      validated.jobId,
      validated.actorId
    );
    if (!context) {
      return {
        abort: failure(404, "PRE_WORK_DEPOSIT_UNAVAILABLE", "The deposit record is unavailable."),
      };
    }
    const source = await loadApprovedDecisionSource(client, { jobId: validated.jobId });
    if (!source) {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_APPROVED_AGREEMENT_REQUIRED",
          "An approved Quote is required before deposit status is available."
        ),
      };
    }
    const requirement = deriveDepositRequirement({
      customerTermsSnapshot: source.customer_terms_snapshot,
      totalMinor: Number(source.total_minor),
    });
    const obligation = await loadObligation(client, source.customer_decision_id);
    const history = await loadPaymentHistory(client, obligation?.id);
    return {
      result: {
        ok: true,
        success: true,
        status: 200,
        code: obligation
          ? "PRE_WORK_DEPOSIT_FOUND"
          : requirement.kind === "REQUIRED"
            ? "PRE_WORK_DEPOSIT_RECONCILIATION_REQUIRED"
            : "PRE_WORK_DEPOSIT_STATUS_FOUND",
        deposit: depositProjection(source, requirement, obligation, history),
      },
    };
  });
}

async function materializePreWorkDepositObligation(input = {}) {
  const validated = validateInput(input, ["jobId", "idempotencyKey"]);
  if (validated.error) return validated.error;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency.error;
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalJobContext(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    if (!context) {
      return {
        abort: failure(404, "PRE_WORK_DEPOSIT_UNAVAILABLE", "The deposit record is unavailable."),
      };
    }
    const source = await loadApprovedDecisionSource(client, {
      jobId: validated.jobId,
      lock: true,
    });
    if (!source) {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_APPROVED_AGREEMENT_REQUIRED",
          "An exact approved Quote agreement is required."
        ),
      };
    }
    const outcome = await materializeApprovedDecisionDepositWithClient({
      client,
      jobId: validated.jobId,
      decisionId: source.customer_decision_id,
      actorParticipantId: context.professional_participant_id,
      idempotencyKey: idempotency.idempotencyKey,
    });
    if (outcome.error) return { abort: outcome.error };
    if (outcome.requirement.kind === "UNVERIFIED") {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_TERMS_UNVERIFIED",
          "The accepted deposit terms cannot be deterministically materialized."
        ),
      };
    }
    if (outcome.requirement.kind === "NOT_REQUIRED") {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_NOT_REQUIRED",
          "The accepted Quote does not require a pre-work deposit."
        ),
      };
    }
    const history = await loadPaymentHistory(client, outcome.obligation.id);
    return {
      result: {
        ok: true,
        success: true,
        status: outcome.materialized ? 201 : 200,
        code: outcome.materialized
          ? "PRE_WORK_DEPOSIT_MATERIALIZED"
          : "PRE_WORK_DEPOSIT_ALREADY_MATERIALIZED",
        deposit: depositProjection(
          outcome.source,
          outcome.requirement,
          outcome.obligation,
          history
        ),
        ...(outcome.replayed ? { replayed: true } : {}),
      },
    };
  });
}

async function netAppliedMinor(client, obligationId) {
  const result = await client.query(
    `SELECT COALESCE(sum(allocations.allocated_minor), 0) -
       COALESCE(sum(allocations.reversed_minor), 0) AS net_applied_minor
     FROM (
       SELECT payment_allocations.id, payment_allocations.allocated_minor,
         COALESCE(sum(reversals.reversed_minor), 0) AS reversed_minor
       FROM canonical_pre_work_payment_allocations payment_allocations
       LEFT JOIN canonical_pre_work_payment_allocation_reversals reversals
         ON reversals.allocation_id = payment_allocations.id
       WHERE payment_allocations.obligation_id = $1
       GROUP BY payment_allocations.id, payment_allocations.allocated_minor
     ) allocations`,
    [obligationId]
  );
  return Number(result.rows[0]?.net_applied_minor || 0);
}

async function insertNextVersion(client, {
  obligation,
  version,
  state,
  appliedMinor,
  remainingMinor,
  actorParticipantId,
  commandId,
}) {
  const integrityHash = hash({
    obligationId: obligation.id,
    version,
    state,
    requiredMinor: Number(obligation.required_minor),
    appliedMinor,
    remainingMinor,
  });
  await client.query(
    `INSERT INTO canonical_pre_work_deposit_versions (
      obligation_id, version, job_id, relationship_id, currency,
      state, required_minor, applied_minor, remaining_minor,
      recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      obligation.id,
      version,
      obligation.job_id,
      Number(obligation.relationship_id),
      obligation.currency,
      state,
      Number(obligation.required_minor),
      appliedMinor,
      remainingMinor,
      actorParticipantId,
      commandId,
      integrityHash,
    ]
  );
}

async function confirmDepositReceived(input = {}) {
  const validated = validateInput(input, [
    "jobId",
    "amountMinor",
    "currency",
    "normalizedMethod",
    "displayMethod",
    "externalReference",
    "receivedAt",
    "expectedVersion",
    "idempotencyKey",
  ]);
  if (validated.error) return validated.error;
  const amountMinor = positiveMinor(input.amountMinor);
  const currency = typeof input.currency === "string" ? input.currency.trim() : "";
  const normalizedMethod = typeof input.normalizedMethod === "string"
    ? input.normalizedMethod.trim()
    : "";
  const displayMethod = optionalText(input.displayMethod, 160);
  const externalReference = optionalText(input.externalReference, 300);
  const receivedAt = isoInstant(input.receivedAt);
  const expectedVersion = input.expectedVersion == null
    ? null
    : positiveInteger(input.expectedVersion);
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (
    !amountMinor ||
    !CURRENCY_PATTERN.test(currency) ||
    !NORMALIZED_METHOD_PATTERN.test(normalizedMethod) ||
    (input.displayMethod != null && input.displayMethod !== "" && !displayMethod) ||
    (input.externalReference != null && input.externalReference !== "" && !externalReference) ||
    !receivedAt ||
    (input.expectedVersion != null && !expectedVersion) ||
    idempotency.error
  ) {
    return idempotency.error || failure(
      400,
      "INVALID_PRE_WORK_DEPOSIT_PAYMENT",
      "The received deposit confirmation is invalid."
    );
  }

  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalJobContext(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    if (!context) {
      return {
        abort: failure(404, "PRE_WORK_DEPOSIT_UNAVAILABLE", "The deposit record is unavailable."),
      };
    }
    const source = await loadApprovedDecisionSource(client, {
      jobId: validated.jobId,
      lock: true,
    });
    if (!source) {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_APPROVED_AGREEMENT_REQUIRED",
          "An exact approved Quote agreement is required."
        ),
      };
    }
    const ensured = await materializeApprovedDecisionDepositWithClient({
      client,
      jobId: validated.jobId,
      decisionId: source.customer_decision_id,
      actorParticipantId: context.professional_participant_id,
      idempotencyKey: `ensure:${source.customer_decision_id}`,
    });
    if (ensured.error) return { abort: ensured.error };
    if (ensured.requirement.kind === "UNVERIFIED") {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_TERMS_UNVERIFIED",
          "The accepted deposit terms cannot be deterministically materialized."
        ),
      };
    }
    if (ensured.requirement.kind === "NOT_REQUIRED") {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_NOT_REQUIRED",
          "The accepted Quote does not require a pre-work deposit."
        ),
      };
    }
    let obligation = await loadObligation(client, source.customer_decision_id, {
      lock: true,
    });
    if (!obligation) throw new Error("Required pre-work deposit obligation is missing.");
    const requestFingerprint = hash({
      command: COMMANDS.RECORD,
      jobId: validated.jobId,
      obligationId: obligation.id,
      amountMinor,
      currency,
      normalizedMethod,
      displayMethod,
      externalReference,
      receivedAt,
      expectedVersion,
    });
    const reserved = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.RECORD,
      commandScope: `obligation:${obligation.id}:payments`,
      idempotencyKey: idempotency.idempotencyKey,
      requestFingerprint,
    });
    if (reserved.error) return { abort: reserved.error };
    if (reserved.replay) return { result: reserved.replay };

    if (currency !== obligation.currency) {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_CURRENCY_MISMATCH",
          "The received payment currency does not match the accepted Quote."
        ),
      };
    }
    if (expectedVersion != null && expectedVersion !== Number(obligation.latest_version)) {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_VERSION_CONFLICT",
          "The deposit record changed before this payment was confirmed."
        ),
      };
    }
    if (["SUPERSEDED", "VOIDED"].includes(obligation.latest_state)) {
      return {
        abort: failure(409, "PRE_WORK_DEPOSIT_OBSOLETE", "The deposit obligation is no longer active."),
      };
    }
    if (obligation.latest_state === "SATISFIED") {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_ALREADY_SATISFIED",
          "The required deposit is already satisfied."
        ),
      };
    }

    const priorApplied = await netAppliedMinor(client, obligation.id);
    if (priorApplied !== Number(obligation.latest_applied_minor)) {
      throw new Error("Pre-work deposit allocation history does not match its latest version.");
    }
    const remainingBefore = Number(obligation.required_minor) - priorApplied;
    if (remainingBefore <= 0) {
      throw new Error("Pre-work deposit balance is inconsistent with its latest state.");
    }
    const allocatedMinor = Math.min(amountMinor, remainingBefore);
    const receiptId = randomUUID();
    await client.query(
      `INSERT INTO canonical_pre_work_payment_receipts (
        id, job_id, relationship_id, gross_amount_minor, currency,
        evidence_source, normalized_method, display_method,
        external_reference, received_at, recorded_by_participant_id,
        command_idempotency_id, integrity_hash
       ) VALUES ($1, $2, $3, $4, $5, 'MANUAL_EXTERNAL', $6, $7,
         $8, $9, $10, $11, $12)`,
      [
        receiptId,
        validated.jobId,
        Number(context.relationship_id),
        amountMinor,
        currency,
        normalizedMethod,
        displayMethod,
        externalReference,
        receivedAt,
        context.professional_participant_id,
        reserved.row.id,
        hash({
          receiptId,
          jobId: validated.jobId,
          amountMinor,
          currency,
          evidenceSource: "MANUAL_EXTERNAL",
          normalizedMethod,
          displayMethod,
          externalReference,
          receivedAt,
        }),
      ]
    );
    const allocationId = randomUUID();
    const allocationCommand = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.ALLOCATE,
      commandScope: `receipt:${receiptId}:obligation:${obligation.id}`,
      idempotencyKey: idempotency.idempotencyKey,
      requestFingerprint: hash({
        command: COMMANDS.ALLOCATE,
        receiptId,
        obligationId: obligation.id,
        allocatedMinor,
      }),
    });
    if (allocationCommand.error || allocationCommand.replay) {
      throw new Error("Pre-work deposit allocation command reservation failed.");
    }
    await client.query(
      `INSERT INTO canonical_pre_work_payment_allocations (
        id, receipt_id, obligation_id, job_id, relationship_id,
        currency, allocated_minor, recorded_by_participant_id,
        command_idempotency_id, integrity_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        allocationId,
        receiptId,
        obligation.id,
        validated.jobId,
        Number(context.relationship_id),
        currency,
        allocatedMinor,
        context.professional_participant_id,
        allocationCommand.row.id,
        hash({ allocationId, receiptId, obligationId: obligation.id, allocatedMinor }),
      ]
    );
    const appliedMinor = priorApplied + allocatedMinor;
    const remainingMinor = Number(obligation.required_minor) - appliedMinor;
    const state = remainingMinor === 0 ? "SATISFIED" : "PARTIALLY_SATISFIED";
    const version = Number(obligation.latest_version) + 1;
    await insertNextVersion(client, {
      obligation,
      version,
      state,
      appliedMinor,
      remainingMinor,
      actorParticipantId: context.professional_participant_id,
      commandId: allocationCommand.row.id,
    });
    await client.query(
      `INSERT INTO canonical_pre_work_deposit_events (
        id, obligation_id, obligation_version, previous_obligation_version,
        job_id, event_type, obligation_state, receipt_id, allocation_id,
        recorded_by_participant_id, command_idempotency_id
       ) VALUES ($1, $2, $3, $4, $5, 'DEPOSIT_PAYMENT_ALLOCATED',
         $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        obligation.id,
        version,
        version - 1,
        validated.jobId,
        state,
        receiptId,
        allocationId,
        context.professional_participant_id,
        allocationCommand.row.id,
      ]
    );
    const allocationResult = {
      code: "PRE_WORK_DEPOSIT_PAYMENT_ALLOCATED",
      receiptId,
      allocationId,
      obligationId: obligation.id,
      latestVersion: version,
    };
    await completeCommand(client, allocationCommand.row.id, allocationResult);
    obligation = {
      ...obligation,
      latest_version: version,
      latest_state: state,
      latest_required_minor: obligation.required_minor,
      latest_applied_minor: appliedMinor,
      latest_remaining_minor: remainingMinor,
    };
    const history = await loadPaymentHistory(client, obligation.id);
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "PRE_WORK_DEPOSIT_PAYMENT_CONFIRMED",
      payment: {
        receiptId,
        allocationId,
        evidenceSource: "MANUAL_EXTERNAL",
        grossAmountMinor: amountMinor,
        allocatedMinor,
        unappliedMinor: amountMinor - allocatedMinor,
        currency,
        receivedAt,
      },
      deposit: depositProjection(source, ensured.requirement, obligation, history),
    };
    await completeCommand(client, reserved.row.id, result);
    return { result };
  });
}

async function reverseDepositAllocation(input = {}) {
  const validated = validateInput(input, [
    "jobId",
    "allocationId",
    "amountMinor",
    "reasonCategory",
    "reason",
    "expectedVersion",
    "idempotencyKey",
  ]);
  if (validated.error) return validated.error;
  const allocationId = normalizedUuid(input.allocationId);
  const amountMinor = positiveMinor(input.amountMinor);
  const reasonCategory = typeof input.reasonCategory === "string"
    ? input.reasonCategory.trim().toUpperCase()
    : "";
  const reason = optionalText(input.reason, 2000);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (
    !allocationId ||
    !amountMinor ||
    !REVERSAL_REASONS.has(reasonCategory) ||
    !reason ||
    !expectedVersion ||
    idempotency.error
  ) {
    return idempotency.error || failure(
      400,
      "INVALID_PRE_WORK_DEPOSIT_REVERSAL",
      "The deposit correction command is invalid."
    );
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalJobContext(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    if (!context) {
      return {
        abort: failure(404, "PRE_WORK_DEPOSIT_UNAVAILABLE", "The deposit record is unavailable."),
      };
    }
    const allocationResult = await client.query(
      `SELECT allocations.*, receipts.gross_amount_minor,
        obligations.customer_decision_id,
        (
          SELECT COALESCE(sum(reversals.reversed_minor), 0)
          FROM canonical_pre_work_payment_allocation_reversals reversals
          WHERE reversals.allocation_id = allocations.id
        ) AS reversed_minor
       FROM canonical_pre_work_payment_allocations allocations
       INNER JOIN canonical_pre_work_payment_receipts receipts
         ON receipts.id = allocations.receipt_id
         AND receipts.job_id = allocations.job_id
         AND receipts.relationship_id = allocations.relationship_id
         AND receipts.currency = allocations.currency
       INNER JOIN canonical_pre_work_deposit_obligations obligations
         ON obligations.id = allocations.obligation_id
         AND obligations.job_id = allocations.job_id
         AND obligations.relationship_id = allocations.relationship_id
         AND obligations.currency = allocations.currency
       WHERE allocations.id = $1
         AND allocations.job_id = $2
         AND allocations.relationship_id = $3
       LIMIT 1
       FOR UPDATE OF allocations`,
      [allocationId, validated.jobId, Number(context.relationship_id)]
    );
    const allocation = allocationResult.rows[0];
    if (!allocation) {
      return {
        abort: failure(404, "PRE_WORK_DEPOSIT_ALLOCATION_UNAVAILABLE", "The payment allocation is unavailable."),
      };
    }
    let obligation = await loadObligation(client, allocation.customer_decision_id, {
      lock: true,
    });
    if (!obligation || obligation.id !== allocation.obligation_id) {
      throw new Error("Deposit reversal obligation identity failed.");
    }
    const requestFingerprint = hash({
      command: COMMANDS.REVERSE,
      jobId: validated.jobId,
      allocationId,
      obligationId: obligation.id,
      amountMinor,
      reasonCategory,
      reason,
      expectedVersion,
    });
    const reserved = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.REVERSE,
      commandScope: `allocation:${allocationId}:reversals`,
      idempotencyKey: idempotency.idempotencyKey,
      requestFingerprint,
    });
    if (reserved.error) return { abort: reserved.error };
    if (reserved.replay) return { result: reserved.replay };

    if (Number(obligation.latest_version) !== expectedVersion) {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_VERSION_CONFLICT",
          "The deposit record changed before this correction was recorded."
        ),
      };
    }
    if (["SUPERSEDED", "VOIDED"].includes(obligation.latest_state)) {
      return {
        abort: failure(409, "PRE_WORK_DEPOSIT_OBSOLETE", "The deposit obligation is no longer active."),
      };
    }
    const availableToReverse = Number(allocation.allocated_minor) - Number(allocation.reversed_minor);
    if (amountMinor > availableToReverse) {
      return {
        abort: failure(
          409,
          "PRE_WORK_DEPOSIT_REVERSAL_EXCEEDS_ALLOCATION",
          "The correction exceeds the active payment allocation."
        ),
      };
    }

    const reversalId = randomUUID();
    const reversalEffect = reasonCategory === "CORRECTION"
      ? "DEALLOCATE"
      : "RECEIPT_REVERSAL";
    await client.query(
      `INSERT INTO canonical_pre_work_payment_allocation_reversals (
        id, allocation_id, receipt_id, obligation_id, job_id,
        relationship_id, currency, reversed_minor, reversal_effect,
        reason_category, reason, reversed_at,
        recorded_by_participant_id, command_idempotency_id, integrity_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         CURRENT_TIMESTAMP, $12, $13, $14)`,
      [
        reversalId,
        allocationId,
        allocation.receipt_id,
        obligation.id,
        validated.jobId,
        Number(context.relationship_id),
        obligation.currency,
        amountMinor,
        reversalEffect,
        reasonCategory,
        reason,
        context.professional_participant_id,
        reserved.row.id,
        hash({
          reversalId,
          allocationId,
          obligationId: obligation.id,
          amountMinor,
          reversalEffect,
          reasonCategory,
          reason,
        }),
      ]
    );
    const appliedMinor = await netAppliedMinor(client, obligation.id);
    const remainingMinor = Number(obligation.required_minor) - appliedMinor;
    const state = appliedMinor === 0 ? "DUE" : "PARTIALLY_SATISFIED";
    const version = Number(obligation.latest_version) + 1;
    await insertNextVersion(client, {
      obligation,
      version,
      state,
      appliedMinor,
      remainingMinor,
      actorParticipantId: context.professional_participant_id,
      commandId: reserved.row.id,
    });
    await client.query(
      `INSERT INTO canonical_pre_work_deposit_events (
        id, obligation_id, obligation_version, previous_obligation_version,
        job_id, event_type, obligation_state, receipt_id, allocation_id,
        reversal_id, recorded_by_participant_id, command_idempotency_id
       ) VALUES ($1, $2, $3, $4, $5, 'DEPOSIT_PAYMENT_REVERSED',
         $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        obligation.id,
        version,
        version - 1,
        validated.jobId,
        state,
        allocation.receipt_id,
        allocationId,
        reversalId,
        context.professional_participant_id,
        reserved.row.id,
      ]
    );
    const workStarted = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM canonical_visits visits
         INNER JOIN LATERAL (
           SELECT versions.state
           FROM canonical_visit_versions versions
           WHERE versions.visit_id = visits.id AND versions.job_id = visits.job_id
           ORDER BY versions.version DESC LIMIT 1
         ) latest ON TRUE
         WHERE visits.job_id = $1
           AND visits.purpose = 'APPROVED_WORK'
           AND latest.state IN ('STARTED', 'COMPLETED')
       ) AS work_started`,
      [validated.jobId]
    );
    const source = await loadApprovedDecisionSource(client, {
      jobId: validated.jobId,
      decisionId: obligation.customer_decision_id,
    });
    obligation = {
      ...obligation,
      latest_version: version,
      latest_state: state,
      latest_required_minor: obligation.required_minor,
      latest_applied_minor: appliedMinor,
      latest_remaining_minor: remainingMinor,
    };
    const requirement = deriveDepositRequirement({
      customerTermsSnapshot: source.customer_terms_snapshot,
      totalMinor: Number(source.total_minor),
    });
    const history = await loadPaymentHistory(client, obligation.id);
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "PRE_WORK_DEPOSIT_PAYMENT_REVERSED",
      reversal: {
        reversalId,
        allocationId,
        receiptId: allocation.receipt_id,
        reversedMinor: amountMinor,
        reversalEffect,
        reasonCategory,
      },
      deposit: depositProjection(source, requirement, obligation, history),
      commercialException: workStarted.rows[0]?.work_started === true
        ? "APPROVED_WORK_ALREADY_STARTED"
        : null,
    };
    await completeCommand(client, reserved.row.id, result);
    return { result };
  });
}

async function evaluateApprovedWorkDepositGateWithClient({
  client,
  jobId,
  approvedQuoteDecisionId,
  lock = false,
}) {
  const source = await loadApprovedDecisionSource(client, {
    jobId,
    decisionId: approvedQuoteDecisionId,
    lock,
  });
  if (!source) {
    return {
      allowed: false,
      code: "APPROVED_QUOTE_DECISION_UNAVAILABLE",
      state: "UNAVAILABLE",
    };
  }
  const requirement = deriveDepositRequirement({
    customerTermsSnapshot: source.customer_terms_snapshot,
    totalMinor: Number(source.total_minor),
  });
  if (requirement.kind === "NOT_REQUIRED") {
    return {
      allowed: true,
      code: "PRE_WORK_DEPOSIT_NOT_REQUIRED",
      state: "NOT_REQUIRED",
      source,
      requirement,
      obligation: null,
    };
  }
  if (requirement.kind === "UNVERIFIED") {
    return {
      allowed: false,
      code: "PRE_WORK_DEPOSIT_TERMS_UNVERIFIED",
      state: "TERMS_UNVERIFIED",
      source,
      requirement,
      obligation: null,
    };
  }
  const obligation = await loadObligation(client, source.customer_decision_id, { lock });
  if (!obligation) {
    return {
      allowed: false,
      code: "PRE_WORK_DEPOSIT_OBLIGATION_MISSING",
      state: "DUE",
      source,
      requirement,
      obligation: null,
    };
  }
  const allowed = obligation.latest_state === "SATISFIED";
  return {
    allowed,
    code: allowed
      ? "PRE_WORK_DEPOSIT_SATISFIED"
      : "DEPOSIT_REQUIRED_BEFORE_SCHEDULING",
    state: obligation.latest_state,
    source,
    requirement,
    obligation,
  };
}

function schedulingGateFailure(gate) {
  return failure(
    409,
    gate?.code === "PRE_WORK_DEPOSIT_TERMS_UNVERIFIED"
      ? gate.code
      : "DEPOSIT_REQUIRED_BEFORE_SCHEDULING",
    gate?.code === "PRE_WORK_DEPOSIT_TERMS_UNVERIFIED"
      ? "The accepted deposit terms require review before approved work can be scheduled."
      : "The required deposit must be satisfied before approved work can be scheduled."
  );
}

module.exports = {
  COMMANDS,
  confirmDepositReceived,
  evaluateApprovedWorkDepositGateWithClient,
  getProfessionalDepositStatus,
  materializePreWorkDepositObligation,
  preWorkDepositServiceInternals: Object.freeze({
    depositProjection,
    deriveDepositRequirement,
    fixedDepositMinor,
    hash,
    materializeApprovedDecisionDepositWithClient,
    schedulingGateFailure,
  }),
  reverseDepositAllocation,
  schedulingGateFailure,
};
