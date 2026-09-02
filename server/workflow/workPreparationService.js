"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");
const {
  evaluateApprovedWorkDepositGateWithClient,
  preWorkDepositServiceInternals,
} = require("../finance/preWorkDepositService");

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

const { hasActiveLifecycleGrant } = require("../authorization/lifecycleAuthorityService");

const CONTRACT_VERSION = 1;
const CAPABILITIES = Object.freeze({
  READ: "work_preparation.plan.read",
  WRITE: "work_preparation.plan.write",
  PURCHASE: "work_preparation.purchase.record",
  PREPARATION: "work_preparation.preparation.record",
  READ_CUSTOMER: "work_preparation.read_customer",
});
const COMMANDS = Object.freeze({
  MATERIALIZE: "work_preparation.plan.create",
  REVISE: "work_preparation.plan.revise",
  PURCHASE: "work_preparation.purchase.record",
  CORRECT_PURCHASE: "work_preparation.purchase.correct",
  CUSTOMER_ITEM_REQUEST: "work_preparation.customer_item.request",
  CUSTOMER_ITEM_RECEIVE: "work_preparation.customer_item.receive",
  MATERIAL_STAGE: "work_preparation.material.stage",
  INVENTORY_ALLOCATE: "work_preparation.inventory.allocate",
  TOOLS_READY: "work_preparation.tools.ready",
  EQUIPMENT_READY: "work_preparation.equipment.ready",
  PREPARATION_RECORD: "work_preparation.preparation.record",
  EVIDENCE_ATTACH: "work_preparation.evidence.attach",
});
const PLAN_STATES = new Set(["PLANNING", "PLANNED", "RETIRED"]);
const WORK_START_POLICIES = new Set(["NONE", "REQUIRED_ITEMS_READY"]);
const ITEM_KINDS = new Set(["MATERIAL", "TOOL", "EQUIPMENT", "PREPARATION_TASK"]);
const PROVIDERS = new Set(["BUSINESS", "CUSTOMER"]);
const COMMERCIAL_TREATMENTS = new Set([
  "INCLUDED_IN_ACCEPTED_TOTAL",
  "SEPARATELY_ACCEPTED",
  "CUSTOMER_SUPPLIED",
  "ALLOWANCE",
  "APPROVAL_REQUIRED",
  "NOT_CUSTOMER_BILLABLE",
]);
const VISIBILITIES = new Set(["BUSINESS_ONLY", "CUSTOMER_VISIBLE"]);
const LINEAGES = new Set(["QUOTE_SCOPE_ITEM", "ACCEPTED_SCOPE_ELABORATION"]);
const EVENT_COMMANDS = Object.freeze({
  CUSTOMER_ITEM_REQUESTED: COMMANDS.CUSTOMER_ITEM_REQUEST,
  CUSTOMER_ITEM_RECEIVED: COMMANDS.CUSTOMER_ITEM_RECEIVE,
  MATERIAL_STAGED: COMMANDS.MATERIAL_STAGE,
  BUSINESS_INVENTORY_ALLOCATED: COMMANDS.INVENTORY_ALLOCATE,
  TOOLS_READY: COMMANDS.TOOLS_READY,
  EQUIPMENT_READY: COMMANDS.EQUIPMENT_READY,
  PREPARATION_STARTED: COMMANDS.PREPARATION_RECORD,
  PREPARATION_READY: COMMANDS.PREPARATION_RECORD,
  PREPARATION_BLOCKED: COMMANDS.PREPARATION_RECORD,
});
const EVIDENCE_TYPES = new Set([
  "PURCHASE_RECEIPT",
  "VENDOR_INVOICE",
  "PURCHASE_PHOTO",
  "STAGING_PHOTO",
  "PREPARATION_PHOTO",
  "EXTERNAL_REFERENCE",
]);
const CORRECTION_REASONS = new Set(["RETURN", "VOID", "CORRECTION", "REFUND"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const REFERENCE_NAMESPACE_PATTERN = /^[a-z][a-z0-9_.-]{1,79}$/;

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

function nullableInteger(value) { return value == null ? null : Number(value); }

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function boundedText(value, maximum, { optional = false } = {}) {
  if ((value == null || value === "") && optional) return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= maximum ? normalized : null;
}

function positiveDecimal(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 99999999999.999
    ? Number(parsed.toFixed(3))
    : null;
}

function nonnegativeDecimal(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 99999999999.999
    ? Number(parsed.toFixed(3))
    : null;
}

function nonnegativeMinor(value, { positive = false, optional = false } = {}) {
  if (value == null && optional) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (positive ? parsed > 0 : parsed >= 0)
    ? parsed
    : null;
}

function isoInstant(value, { futureAllowed = false } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!futureAllowed && parsed.getTime() > Date.now()) return null;
  return parsed.toISOString();
}

function iso(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function validateInput(input, allowedFields, { idempotency = false } = {}) {
  const allowed = new Set(["pool", "authenticatedActor", "logger", ...allowedFields]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return {
      error: failure(
        400,
        "WORK_PREPARATION_FIELD_REJECTED",
        "Server-owned Work Preparation authority fields cannot be supplied."
      ),
    };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return { error: failure(400, "INVALID_WORK_PREPARATION_JOB", "A valid Job is required.") };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  let idempotencyKey = null;
  if (idempotency) {
    const key = validateIdempotencyKey(input.idempotencyKey);
    if (key?.error) return key;
    idempotencyKey = key.idempotencyKey;
  }
  return {
    actorId: actor.id,
    jobId,
    idempotencyKey,
    logger: safeLogger(input.logger),
  };
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
    if (outcome?.afterCommit) outcome.afterCommit();
    return outcome?.result ?? outcome;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadProfessionalContext(client, jobId, actorId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.source_type, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      professional.user_id AS professional_user_id, relationships.homeowner_id,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      roles.id AS professional_role_assignment_id,
      ARRAY(
        SELECT DISTINCT grants.capability
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = professional.id
          AND grants.job_id = jobs.id
          AND grants.scope_job_id = jobs.id
          AND grants.capability = ANY($3::text[])
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS active_capabilities
     FROM jobs
     LEFT JOIN posts ON posts.id = jobs.job_request_id
       AND posts.lifecycle_contract_version = 2 AND posts.cancelled_at IS NULL
     LEFT JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
       AND relationships.post_id = jobs.job_request_id
       AND relationships.status = 'active'
       AND relationships.emergency_request_id IS NULL
       AND relationships.professional_user_id = $2
     LEFT JOIN contractor_profiles profiles
       ON jobs.source_type='business_document' AND profiles.id=jobs.contractor_profile_id AND profiles.user_id=$2
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id
       AND professional.user_id=$2
       AND ((jobs.source_type='ordinary_request_selection' AND professional.request_relationship_id=relationships.id)
         OR (jobs.source_type='business_document' AND professional.request_relationship_id IS NULL))
     LEFT JOIN relationship_participants customer
       ON customer.job_id = jobs.id
       AND customer.request_relationship_id = relationships.id
       AND customer.user_id = relationships.homeowner_id
     INNER JOIN participant_role_assignments roles
       ON roles.participant_id = professional.id
       AND roles.job_id = jobs.id
       AND roles.role = 'PRIMARY_PROFESSIONAL'
       AND roles.valid_from <= CURRENT_TIMESTAMP
       AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
     LEFT JOIN participant_role_revocations role_revocations
       ON role_revocations.role_assignment_id = roles.id
     WHERE jobs.id = $1
       AND jobs.lifecycle_contract_version = 2
       AND role_revocations.id IS NULL
       AND ((jobs.source_type='ordinary_request_selection' AND posts.id IS NOT NULL AND relationships.id IS NOT NULL AND customer.id IS NOT NULL)
         OR (jobs.source_type='business_document' AND profiles.id IS NOT NULL AND jobs.job_request_id IS NULL
           AND jobs.source_request_relationship_id IS NULL AND jobs.originating_business_document_id IS NOT NULL))
     LIMIT 1
     ${lock ? "FOR UPDATE OF jobs" : ""}`,
    [jobId, actorId, ["quote.read", ...Object.values(CAPABILITIES)]]
  );
  return result.rows[0] || null;
}

function requireCapability(context, capability, { bootstrap = false } = {}) {
  if (!context) {
    return failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.");
  }
  const capabilities = Array.isArray(context.active_capabilities)
    ? context.active_capabilities
    : [];
  const allowed = capabilities.includes(capability) ||
    (bootstrap && capabilities.includes("quote.read"));
  return allowed
    ? null
    : failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.");
}

async function requirePlanCapability(client, context, plan, capability) {
  if (!context || !plan) {
    return failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.");
  }
  const allowed = await hasActiveLifecycleGrant({
    client,
    participantId: context.professional_participant_id,
    jobId: context.job_id,
    capability,
    quoteApprovalId: plan.quote_approval_id,
    approvedQuoteDecisionId: plan.approved_customer_decision_id,
    allowJobScope: false,
  });
  return allowed ? null : failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.");
}

async function loadPlan(client, jobId, planId = null, { lock = false } = {}) {
  const values = [jobId];
  const planFilter = planId ? `AND plans.id = $${values.push(planId)}` : "";
  const result = await client.query(
    `SELECT plans.*,
      COALESCE(plans.quote_approval_id, common_approval.id) AS quote_approval_id,
      COALESCE(plans.approval_source, common_approval.approval_source) AS approval_source,
      current.version AS current_version,
      current.planning_state, current.work_start_policy,
      current.internal_notes, current.integrity_hash AS current_integrity_hash,
      current.created_at AS current_version_created_at
     FROM canonical_work_preparation_plans plans
     LEFT JOIN canonical_quote_approvals common_approval ON common_approval.customer_decision_id=plans.approved_customer_decision_id
     INNER JOIN LATERAL (
       SELECT versions.version, versions.planning_state,
         versions.work_start_policy, versions.internal_notes,
         versions.integrity_hash, versions.created_at
       FROM canonical_work_preparation_plan_versions versions
       WHERE versions.plan_id = plans.id
         AND versions.job_id = plans.job_id
       ORDER BY versions.version DESC LIMIT 1
     ) current ON TRUE
     WHERE plans.job_id = $1 ${planFilter}
     ORDER BY plans.created_at DESC, plans.id DESC
     LIMIT 1
     ${lock ? "FOR UPDATE OF plans" : ""}`,
    values
  );
  return result.rows[0] || null;
}

async function loadPlanByApproval(client, jobId, quoteApprovalId, decisionId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT plans.id
     FROM canonical_work_preparation_plans plans
     WHERE plans.job_id = $1 AND (plans.quote_approval_id = $3
       OR (plans.quote_approval_id IS NULL AND plans.approved_customer_decision_id = $2))
     LIMIT 1
     ${lock ? "FOR UPDATE" : ""}`,
    [jobId, decisionId, quoteApprovalId]
  );
  return result.rows[0]
    ? loadPlan(client, jobId, result.rows[0].id, { lock })
    : null;
}

async function reserveCommand(client, {
  jobId,
  participantId,
  commandName,
  commandScope,
  idempotencyKey,
  requestFingerprint,
}) {
  const id = randomUUID();
  const inserted = await client.query(
    `INSERT INTO canonical_work_preparation_command_idempotency (
       id, job_id, actor_participant_id, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [id, jobId, participantId, commandName, commandScope,
      idempotencyKey, requestFingerprint]
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], replay: null };
  const existing = await client.query(
    `SELECT * FROM canonical_work_preparation_command_idempotency
     WHERE actor_participant_id = $1 AND command_name = $2
       AND command_scope = $3 AND idempotency_key = $4
     LIMIT 1 FOR UPDATE`,
    [participantId, commandName, commandScope, idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row || row.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "WORK_PREPARATION_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different command."
      ),
    };
  }
  if (!row.completed_at || !row.result_reference) {
    return {
      error: failure(
        409,
        "WORK_PREPARATION_COMMAND_IN_PROGRESS",
        "The Work Preparation command is still in progress."
      ),
    };
  }
  return { row, replay: row.result_reference };
}

async function completeCommand(client, commandId, result) {
  const updated = await client.query(
    `UPDATE canonical_work_preparation_command_idempotency
     SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND completed_at IS NULL
     RETURNING id`,
    [commandId, JSON.stringify(result)]
  );
  if (!updated.rows[0]) throw new Error("Work Preparation command completion failed.");
}

function replayResult(value) {
  return { ...value, replayed: true };
}

async function grantPlanCapabilities(client, context, planId, decisionId, quoteApprovalId, approvalSource) {
  const grants = [
    [context.professional_participant_id, CAPABILITIES.READ],
    [context.professional_participant_id, CAPABILITIES.WRITE],
    [context.professional_participant_id, CAPABILITIES.PURCHASE],
    [context.professional_participant_id, CAPABILITIES.PREPARATION],
    [context.customer_participant_id, CAPABILITIES.READ_CUSTOMER],
  ];
  for (const [participantId, capability] of grants.filter(([participantId]) => participantId)) {
    const key = `work-preparation:${quoteApprovalId}:${participantId}:${capability}`;
    await client.query(
      `INSERT INTO lifecycle_authority_grants (
        id, grantee_participant_id, grantor_participant_id, job_id,
        capability, scope_type, scope_job_id, scope_concern_id,
        scope_evaluation_id, scope_approved_quote_decision_id,
        scope_approved_quote_decision, source_evidence_type,
        source_evidence_reference, idempotency_key, scope_quote_approval_id, scope_quote_approval_source
       ) VALUES ($1,$2,$3,$4,$5,'approved_work',$4,NULL,NULL,$6,CASE WHEN $6::uuid IS NULL THEN NULL ELSE 'APPROVED' END,
         'canonical_work_preparation_plan',$7,$8,$9,$10)
       ON CONFLICT (
         grantor_participant_id, grantee_participant_id, capability,
         scope_type, scope_job_id, idempotency_key
       ) DO NOTHING`,
      [randomUUID(), participantId, context.professional_participant_id,
        context.job_id, capability, decisionId, planId, key, quoteApprovalId, approvalSource]
    );
  }
}

function depositProjection(gate) {
  return {
    state: gate?.state || "UNAVAILABLE",
    commitmentLocked: !gate?.allowed,
  };
}

function depositEvidence(gate) {
  if (!gate?.allowed) return null;
  if (gate.state === "NOT_REQUIRED") {
    return {
      gateType: "NO_DEPOSIT_REQUIRED",
      obligationId: null,
      obligationVersion: null,
      obligationState: null,
      currency: null,
    };
  }
  if (
    gate.state !== "SATISFIED" ||
    !gate.obligation?.id ||
    !positiveInteger(gate.obligation.latest_version) ||
    gate.obligation.latest_state !== "SATISFIED"
  ) return null;
  return {
    gateType: "SATISFIED",
    obligationId: gate.obligation.id,
    obligationVersion: Number(gate.obligation.latest_version),
    obligationState: "SATISFIED",
    currency: gate.obligation.currency,
  };
}

function commitmentGateFailure(gate) {
  return failure(
    409,
    "DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT",
    gate?.state === "TERMS_UNVERIFIED"
      ? "The accepted deposit terms require review before materials can be committed."
      : "The required deposit must be satisfied before materials can be committed."
  );
}

async function evaluateCommitmentGate(client, plan) {
  const gate = await evaluateApprovedWorkDepositGateWithClient({
    client,
    jobId: plan.job_id,
    approvedQuoteDecisionId: plan.approved_customer_decision_id,
    quoteApprovalId: plan.quote_approval_id,
    lock: true,
  });
  const evidence = depositEvidence(gate);
  return gate.allowed && evidence
    ? { gate, evidence }
    : { error: commitmentGateFailure(gate) };
}

async function loadProjectionRows(client, plan) {
  const items = await client.query(
      `SELECT snapshots.*
       FROM canonical_work_preparation_item_snapshots snapshots
       WHERE snapshots.plan_id = $1 AND snapshots.plan_version = $2
       ORDER BY snapshots.sequence, snapshots.item_id`,
      [plan.id, plan.current_version]
    );
  const purchases = await client.query(
      `SELECT purchases.*
       FROM canonical_material_purchase_records purchases
       WHERE purchases.plan_id = $1
       ORDER BY purchases.purchased_at, purchases.id`,
      [plan.id]
    );
  const corrections = await client.query(
      `SELECT corrections.*
       FROM canonical_material_purchase_corrections corrections
       WHERE corrections.plan_id = $1
       ORDER BY corrections.corrected_at, corrections.id`,
      [plan.id]
    );
  const events = await client.query(
      `SELECT events.*
       FROM canonical_work_preparation_events events
       WHERE events.plan_id = $1
       ORDER BY events.event_sequence, events.id`,
      [plan.id]
    );
  const evidence = await client.query(
      `SELECT refs.*
       FROM canonical_work_preparation_evidence_references refs
       WHERE refs.plan_id = $1
       ORDER BY refs.created_at, refs.id`,
      [plan.id]
    );
  return {
    items: items.rows,
    purchases: purchases.rows,
    corrections: corrections.rows,
    events: events.rows,
    evidence: evidence.rows,
  };
}

function latestEvent(events, itemId, dimension, eventTypes = null) {
  return [...events].reverse().find((event) =>
    (itemId === null ? event.item_id == null : event.item_id === itemId) &&
    event.readiness_dimension === dimension &&
    (!eventTypes || eventTypes.includes(event.event_type))
  ) || null;
}

function netPurchaseForItem(itemId, purchases, corrections) {
  const itemPurchases = purchases.filter((row) => row.item_id === itemId);
  const totals = itemPurchases.reduce((sum, purchase) => {
    const purchaseCorrections = corrections.filter((row) => row.purchase_id === purchase.id);
    const reversedQuantity = purchaseCorrections.reduce(
      (value, row) => value + Number(row.reversed_quantity), 0
    );
    const reversedCost = purchaseCorrections.reduce(
      (value, row) => value + Number(row.reversed_internal_cost_minor), 0
    );
    return {
      quantity: sum.quantity + Math.max(0, Number(purchase.quantity) - reversedQuantity),
      internalCostMinor: sum.internalCostMinor + Math.max(
        0,
        Number(purchase.internal_cost_minor || 0) - reversedCost
      ),
    };
  }, { quantity: 0, internalCostMinor: 0 });
  return {
    recordCount: itemPurchases.length,
    netQuantity: Number(totals.quantity.toFixed(3)),
    internalCostMinor: totals.internalCostMinor,
  };
}

function itemReadiness(item, rows) {
  const purchase = netPurchaseForItem(item.item_id, rows.purchases, rows.corrections);
  const acquisitionEvent = latestEvent(rows.events, item.item_id, "ACQUISITION");
  const preparationEvent = latestEvent(rows.events, item.item_id, "PREPARATION");
  let acquisitionState = "NOT_REQUIRED";
  if (item.item_kind === "MATERIAL") {
    if (item.provider_responsibility === "CUSTOMER") {
      acquisitionState = acquisitionEvent?.event_type === "CUSTOMER_ITEM_RECEIVED"
        ? "READY"
        : item.required_for_work_start
          ? "CUSTOMER_ITEM_PENDING"
          : acquisitionEvent?.resulting_readiness_state || "NOT_STARTED";
    } else if (
      ["MATERIAL_STAGED", "BUSINESS_INVENTORY_ALLOCATED"].includes(acquisitionEvent?.event_type)
    ) {
      acquisitionState = acquisitionEvent.resulting_readiness_state;
    } else if (purchase.netQuantity >= Number(item.quantity)) {
      acquisitionState = "PURCHASED";
    } else if (purchase.netQuantity > 0) {
      acquisitionState = "PARTIALLY_PURCHASED";
    } else {
      acquisitionState = acquisitionEvent?.resulting_readiness_state || "NOT_STARTED";
    }
  } else if (item.item_kind === "TOOL") {
    acquisitionState = acquisitionEvent?.event_type === "TOOLS_READY" ? "READY" : "NOT_STARTED";
  } else if (item.item_kind === "EQUIPMENT") {
    acquisitionState = acquisitionEvent?.event_type === "EQUIPMENT_READY" ? "READY" : "NOT_STARTED";
  }
  const preparationState = preparationEvent?.resulting_readiness_state || "NOT_STARTED";
  const readyForWorkStart = !item.required_for_work_start || (
    item.item_kind === "PREPARATION_TASK"
      ? preparationState === "READY"
      : acquisitionState === "READY" && preparationState !== "BLOCKED"
  );
  return { acquisitionState, preparationState, readyForWorkStart, purchase };
}

function aggregateState(states, precedence, fallback) {
  return precedence.find((state) => states.includes(state)) || fallback;
}

function readinessProjection(plan, rows) {
  const items = rows.items.map((item) => ({ item, ...itemReadiness(item, rows) }));
  const acquisitionStates = items.map((entry) => entry.acquisitionState);
  const itemPreparationStates = items.map((entry) => entry.preparationState);
  const planPreparation = latestEvent(rows.events, null, "PREPARATION");
  const preparationStates = [
    ...itemPreparationStates,
    ...(planPreparation ? [planPreparation.resulting_readiness_state] : []),
  ];
  const acquisitionState = aggregateState(
    acquisitionStates,
    ["BLOCKED", "CUSTOMER_ITEM_PENDING", "PARTIALLY_PURCHASED", "NOT_STARTED", "PURCHASED"],
    acquisitionStates.length ? "READY" : "NOT_REQUIRED"
  );
  const preparationState = aggregateState(
    preparationStates,
    ["BLOCKED", "IN_PROGRESS", "NOT_STARTED"],
    preparationStates.length ? "READY" : "NOT_STARTED"
  );
  const required = items.filter((entry) => entry.item.required_for_work_start);
  const workStartBlocked = plan.work_start_policy === "REQUIRED_ITEMS_READY" &&
    required.some((entry) => !entry.readyForWorkStart);
  let summary = plan.planning_state === "PLANNING" ? "Planning" : "Planned";
  if (plan.planning_state === "RETIRED") summary = "Retired";
  else if (acquisitionState === "BLOCKED" || preparationState === "BLOCKED") summary = "Blocked";
  else if (acquisitionState === "CUSTOMER_ITEM_PENDING") summary = "Customer item pending";
  else if (acquisitionState === "PARTIALLY_PURCHASED") summary = "Partially purchased";
  else if (acquisitionState === "PURCHASED") summary = "Purchased — staging pending";
  else if (!workStartBlocked && required.length > 0) summary = "Ready";
  return {
    planningState: plan.planning_state,
    acquisitionState,
    preparationState,
    customerItemPending: items.some((entry) => entry.acquisitionState === "CUSTOMER_ITEM_PENDING"),
    workStartBlocked,
    requiredItemCount: required.length,
    readyRequiredItemCount: required.filter((entry) => entry.readyForWorkStart).length,
    summary,
    items,
  };
}

function publicItem(entry, { includeBusiness = true } = {}) {
  const item = entry.item;
  const projection = {
    id: item.item_id,
    sequence: Number(item.sequence),
    kind: item.item_kind,
    description: item.description,
    quantity: Number(item.quantity),
    unit: item.unit,
    providerResponsibility: item.provider_responsibility,
    commercialTreatment: item.commercial_treatment,
    visibility: item.visibility,
    requiredForWorkStart: item.required_for_work_start === true,
    sourceLineage: item.source_lineage,
    sourceScopeItemId: item.source_scope_item_id || null,
    acquisitionState: entry.acquisitionState,
    preparationState: entry.preparationState,
    readyForWorkStart: entry.readyForWorkStart,
  };
  if (includeBusiness) {
    projection.internalEstimatedCostMinor = item.internal_estimated_cost_minor == null
      ? null
      : Number(item.internal_estimated_cost_minor);
    projection.internalCostCurrency = item.internal_cost_currency || null;
    projection.purchase = entry.purchase;
  }
  return projection;
}

function planProjection(plan, rows, gate, { customerSafe = false } = {}) {
  const readiness = readinessProjection(plan, rows);
  const visibleItems = customerSafe
    ? readiness.items.filter((entry) => entry.item.visibility === "CUSTOMER_VISIBLE")
    : readiness.items;
  const projection = {
    contractVersion: CONTRACT_VERSION,
    exists: true,
    id: plan.id,
    jobId: plan.job_id,
    relationshipId: nullableInteger(plan.relationship_id),
    source: {
      quoteId: plan.quote_id,
      issuedQuoteVersion: Number(plan.issued_quote_version),
      approvedCustomerDecisionId: plan.approved_customer_decision_id,
      quoteApprovalId: plan.quote_approval_id || null,
      approvalSource: plan.approval_source || null,
    },
    currentVersion: Number(plan.current_version),
    planningState: plan.planning_state,
    workStartPolicy: plan.work_start_policy,
    readiness: {
      planningState: readiness.planningState,
      acquisitionState: readiness.acquisitionState,
      preparationState: readiness.preparationState,
      customerItemPending: readiness.customerItemPending,
      workStartBlocked: readiness.workStartBlocked,
      requiredItemCount: readiness.requiredItemCount,
      readyRequiredItemCount: readiness.readyRequiredItemCount,
      summary: readiness.summary,
    },
    deposit: customerSafe
      ? { commitmentLocked: !gate?.allowed }
      : depositProjection(gate),
    items: visibleItems.map((entry) => publicItem(entry, { includeBusiness: !customerSafe })),
    createdAt: iso(plan.created_at),
    updatedAt: iso(plan.current_version_created_at),
  };
  if (!customerSafe) {
    projection.internalNotes = plan.internal_notes || null;
    projection.purchaseSummary = {
      recordCount: rows.purchases.length,
      correctionCount: rows.corrections.length,
      internalCostMinor: rows.purchases.reduce(
        (sum, row) => sum + Number(row.internal_cost_minor || 0), 0
      ) - rows.corrections.reduce(
        (sum, row) => sum + Number(row.reversed_internal_cost_minor || 0), 0
      ),
      currency: plan.commercial_currency,
    };
    projection.safeNextActions = safeNextActions(plan, gate, readiness);
  }
  return projection;
}

function safeNextActions(plan, gate, readiness) {
  if (plan.planning_state === "RETIRED") return [];
  const actions = ["REVISE_PLAN"];
  if (gate?.allowed) {
    actions.push("RECORD_PURCHASE", "RECORD_PREPARATION");
  } else {
    actions.push("REVIEW_DEPOSIT");
  }
  if (readiness.workStartBlocked) actions.push("RESOLVE_REQUIRED_PREPARATION");
  return actions;
}

async function projectPlanWithClient(client, plan, { customerSafe = false, lockDeposit = false } = {}) {
  const rows = await loadProjectionRows(client, plan);
  const gate = await evaluateApprovedWorkDepositGateWithClient({
    client,
    jobId: plan.job_id,
    approvedQuoteDecisionId: plan.approved_customer_decision_id,
    quoteApprovalId: plan.quote_approval_id,
    lock: lockDeposit,
  });
  return planProjection(plan, rows, gate, { customerSafe });
}

async function getWorkPreparation(input = {}) {
  const validated = validateInput(input, ["jobId"]);
  if (validated.error) return validated.error;
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId);
    const plan = await loadPlan(client, validated.jobId);
    const authorityError = plan
      ? await requirePlanCapability(client, context, plan, CAPABILITIES.READ)
      : requireCapability(context, CAPABILITIES.READ, { bootstrap: true });
    if (authorityError) return { abort: authorityError };
    if (!plan) {
      return {
        result: {
          ok: true,
          success: true,
          status: 200,
          code: "WORK_PREPARATION_NOT_MATERIALIZED",
          workPreparation: { contractVersion: CONTRACT_VERSION, exists: false, jobId: validated.jobId },
        },
      };
    }
    const projection = await projectPlanWithClient(client, plan);
    return {
      result: {
        ok: true,
        success: true,
        status: 200,
        code: "WORK_PREPARATION_FOUND",
        workPreparation: projection,
      },
    };
  });
}

async function materializeWorkPreparation(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "approvedCustomerDecisionId", "quoteApprovalId", "idempotencyKey"],
    { idempotency: true }
  );
  if (validated.error) return validated.error;
  let decisionId = input.approvedCustomerDecisionId == null ? null : normalizedUuid(input.approvedCustomerDecisionId);
  const quoteApprovalId = input.quoteApprovalId == null ? null : normalizedUuid(input.quoteApprovalId);
  if ((!decisionId && !quoteApprovalId) || (input.approvedCustomerDecisionId != null && !decisionId) ||
      (input.quoteApprovalId != null && !quoteApprovalId)) {
    return failure(400, "INVALID_APPROVED_CUSTOMER_DECISION", "An approved customer decision is required.");
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    const authorityError = requireCapability(context, CAPABILITIES.WRITE, { bootstrap: true });
    if (authorityError) return { abort: authorityError };
    const approval = await preWorkDepositServiceInternals.loadApprovedQuoteApprovalSource(client, {
      jobId:validated.jobId,approvalId:quoteApprovalId,customerDecisionId:decisionId,lock:true,
    });
    if (!approval) return {abort:failure(404,"APPROVED_WORK_PREPARATION_SOURCE_UNAVAILABLE","The exact Quote approval is unavailable.")};
    decisionId=approval.customer_decision_id;
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.MATERIALIZE,
      commandScope: decisionId ? `decision:${decisionId}` : `approval:${approval.quote_approval_id}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: hash({ jobId: validated.jobId, decisionId,
        ...(decisionId ? {} : {quoteApprovalId:approval.quote_approval_id}) }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };

    const gate = await evaluateApprovedWorkDepositGateWithClient({
      client,
      jobId: validated.jobId,
      approvedQuoteDecisionId: decisionId,
      quoteApprovalId: approval.quote_approval_id,
      lock: true,
    });
    const source = gate.source;
    if (
      !source ||
      source.customer_decision_id !== decisionId ||
      nullableInteger(source.relationship_id) !== nullableInteger(context.relationship_id) ||
      source.decision !== "APPROVED"
    ) {
      return {
        abort: failure(
          404,
          "APPROVED_WORK_PREPARATION_SOURCE_UNAVAILABLE",
          "Approved Work Preparation authority is unavailable."
        ),
      };
    }
    const existing = await loadPlanByApproval(client, validated.jobId, approval.quote_approval_id, decisionId, { lock: true });
    if (existing) {
      const result = {
        ok: true,
        success: true,
        status: 200,
        code: "WORK_PREPARATION_ALREADY_MATERIALIZED",
        workPreparation: await projectPlanWithClient(client, existing),
      };
      await completeCommand(client, idempotency.row.id, result);
      return { result };
    }

    const planId = randomUUID();
    await client.query(
      `INSERT INTO canonical_work_preparation_plans (
        id, job_id, job_request_id, relationship_id, quote_id,
        issued_quote_version, approved_customer_decision_id,
        customer_participant_id, commercial_currency, source_integrity_hash,
        created_by_professional_participant_id, created_by_role_assignment_id,
        created_command_idempotency_id,quote_approval_id,approval_source,approved_customer_decision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [planId, validated.jobId, nullableInteger(source.job_request_id), nullableInteger(source.relationship_id),
        source.quote_id, Number(source.issued_quote_version), decisionId,
        source.customer_participant_id, source.currency, source.issued_integrity_hash,
        context.professional_participant_id, context.professional_role_assignment_id,
        idempotency.row.id,source.quote_approval_id,source.approval_source,decisionId ? "APPROVED" : null]
    );
    await client.query(
      `INSERT INTO canonical_work_preparation_plan_versions (
        plan_id, version, job_id, relationship_id, planning_state,
        work_start_policy, internal_notes, recorded_by_participant_id,
        command_idempotency_id, integrity_hash
       ) VALUES ($1,1,$2,$3,'PLANNING','NONE',NULL,$4,$5,$6)`,
      [planId, validated.jobId, nullableInteger(source.relationship_id),
        context.professional_participant_id, idempotency.row.id,
        hash({ planId, version: 1, planningState: "PLANNING", workStartPolicy: "NONE" })]
    );
    await grantPlanCapabilities(client, context, planId, decisionId,source.quote_approval_id,source.approval_source);
    const plan = await loadPlan(client, validated.jobId, planId);
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "WORK_PREPARATION_MATERIALIZED",
      workPreparation: await projectPlanWithClient(client, plan),
    };
    await completeCommand(client, idempotency.row.id, result);
    return {
      result,
      afterCommit: () => validated.logger.info("Work Preparation materialized", {
        code: result.code,
        jobId: validated.jobId,
        planId,
        actorUserId: validated.actorId,
      }),
    };
  });
}

function validateRevisionItem(value, plan) {
  if (!isPlainObject(value)) return null;
  const allowed = new Set([
    "id", "sequence", "kind", "description", "quantity", "unit",
    "providerResponsibility", "commercialTreatment", "visibility",
    "requiredForWorkStart", "internalEstimatedCostMinor", "internalCostCurrency",
    "sourceLineage", "sourceScopeItemId",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const id = value.id == null ? null : normalizedUuid(value.id);
  const sequence = positiveInteger(value.sequence);
  const kind = String(value.kind || "").trim().toUpperCase();
  const description = boundedText(value.description, 1000);
  const quantity = positiveDecimal(value.quantity);
  const unit = boundedText(value.unit, 80);
  const provider = String(value.providerResponsibility || "").trim().toUpperCase();
  const commercial = String(value.commercialTreatment || "").trim().toUpperCase();
  const visibility = String(value.visibility || "BUSINESS_ONLY").trim().toUpperCase();
  const sourceLineage = String(value.sourceLineage || "").trim().toUpperCase();
  const sourceScopeItemId = value.sourceScopeItemId == null
    ? null
    : normalizedUuid(value.sourceScopeItemId);
  const internalCost = nonnegativeMinor(value.internalEstimatedCostMinor, { optional: true });
  const internalCurrency = value.internalCostCurrency == null
    ? null
    : String(value.internalCostCurrency).trim().toUpperCase();
  if (
    (value.id != null && !id) || !sequence || !ITEM_KINDS.has(kind) || !description ||
    !quantity || !unit || !PROVIDERS.has(provider) ||
    !COMMERCIAL_TREATMENTS.has(commercial) || !VISIBILITIES.has(visibility) ||
    typeof value.requiredForWorkStart !== "boolean" || !LINEAGES.has(sourceLineage) ||
    (value.sourceScopeItemId != null && !sourceScopeItemId) ||
    (value.internalEstimatedCostMinor != null && internalCost == null) ||
    (internalCurrency != null && !CURRENCY_PATTERN.test(internalCurrency)) ||
    ((internalCost == null) !== (internalCurrency == null))
  ) return null;
  if (provider === "CUSTOMER" && (
    kind !== "MATERIAL" || commercial !== "CUSTOMER_SUPPLIED" || internalCost != null
  )) return null;
  if (provider === "BUSINESS" && commercial === "CUSTOMER_SUPPLIED") return null;
  if (kind !== "MATERIAL" && (
    provider !== "BUSINESS" || commercial !== "NOT_CUSTOMER_BILLABLE"
  )) return null;
  if (sourceLineage === "ACCEPTED_SCOPE_ELABORATION" && (
    sourceScopeItemId != null ||
    !["NOT_CUSTOMER_BILLABLE", "CUSTOMER_SUPPLIED"].includes(commercial)
  )) return null;
  if (sourceLineage === "QUOTE_SCOPE_ITEM" && !sourceScopeItemId) return null;
  return {
    id,
    sequence,
    kind,
    description,
    quantity,
    unit,
    provider,
    commercial,
    visibility,
    required: value.requiredForWorkStart,
    internalCost,
    internalCurrency,
    sourceLineage,
    sourceScopeItemId,
    sourceQuoteId: plan.quote_id,
    sourceQuoteVersion: Number(plan.issued_quote_version),
  };
}

async function validateItemLineage(client, plan, item) {
  if (item.sourceLineage === "ACCEPTED_SCOPE_ELABORATION") return true;
  const result = await client.query(
    `SELECT classification, scope_semantic, material_responsibility, included_in_total
     FROM canonical_quote_scope_item_snapshots
     WHERE quote_id = $1 AND quote_version = $2
       AND scope_item_id = $3 AND job_id = $4
     LIMIT 1`,
    [plan.quote_id, Number(plan.issued_quote_version), item.sourceScopeItemId, plan.job_id]
  );
  const source = result.rows[0];
  if (!source) return false;
  if (item.kind === "MATERIAL") {
    if (source.classification !== "MATERIAL") return false;
    if (source.material_responsibility === "CUSTOMER_SUPPLIED") {
      return item.provider === "CUSTOMER" && item.commercial === "CUSTOMER_SUPPLIED";
    }
    if (
      source.material_responsibility === "PROFESSIONAL_SUPPLIED" &&
      source.included_in_total === true
    ) {
      return item.provider === "BUSINESS" && item.commercial === "INCLUDED_IN_ACCEPTED_TOTAL";
    }
    return item.provider === "BUSINESS" && item.commercial === "APPROVAL_REQUIRED";
  }
  return item.provider === "BUSINESS" && item.commercial === "NOT_CUSTOMER_BILLABLE";
}

async function reviseWorkPreparation(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "planId", "expectedVersion", "planningState", "workStartPolicy",
      "internalNotes", "items", "idempotencyKey"],
    { idempotency: true }
  );
  if (validated.error) return validated.error;
  const planId = normalizedUuid(input.planId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const planningState = String(input.planningState || "").trim().toUpperCase();
  const workStartPolicy = String(input.workStartPolicy || "").trim().toUpperCase();
  const internalNotes = input.internalNotes == null
    ? null
    : boundedText(input.internalNotes, 5000, { optional: true });
  if (
    !planId || !expectedVersion || !PLAN_STATES.has(planningState) ||
    !WORK_START_POLICIES.has(workStartPolicy) ||
    (input.internalNotes != null && internalNotes == null) ||
    !Array.isArray(input.items) || input.items.length > 200
  ) {
    return failure(400, "INVALID_WORK_PREPARATION_REVISION", "The plan revision is invalid.");
  }
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    const plan = await loadPlan(client, validated.jobId, planId, { lock: true });
    const authorityError = await requirePlanCapability(client, context, plan, CAPABILITIES.WRITE);
    if (authorityError) return { abort: authorityError };
    if (!plan) return { abort: failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.") };
    const normalizedItems = input.items.map((item) => validateRevisionItem(item, plan));
    if (
      normalizedItems.some((item) => !item) ||
      new Set(normalizedItems.map((item) => item.sequence)).size !== normalizedItems.length ||
      new Set(normalizedItems.filter((item) => item.id).map((item) => item.id)).size !==
        normalizedItems.filter((item) => item.id).length
    ) {
      return { abort: failure(400, "INVALID_WORK_PREPARATION_ITEMS", "The plan items are invalid.") };
    }
    if (
      workStartPolicy === "NONE" &&
      normalizedItems.some((item) => item.required === true)
    ) {
      return {
        abort: failure(
          409,
          "WORK_PREPARATION_POLICY_CONTRADICTION",
          "A plan with no Work-start policy cannot contain required Work-start items."
        ),
      };
    }
    const requestFingerprint = hash({
      jobId: validated.jobId,
      planId,
      expectedVersion,
      planningState,
      workStartPolicy,
      internalNotes,
      items: normalizedItems,
    });
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.REVISE,
      commandScope: `plan:${planId}:revision`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(plan.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_WORK_PREPARATION_VERSION", "The plan version is no longer current.") };
    }
    if (plan.planning_state === "RETIRED") {
      return { abort: failure(409, "WORK_PREPARATION_RETIRED", "A retired plan is read-only.") };
    }
    const existingIds = normalizedItems.filter((item) => item.id).map((item) => item.id);
    if (existingIds.length) {
      const existing = await client.query(
        `SELECT id FROM canonical_work_preparation_items
         WHERE plan_id = $1 AND job_id = $2 AND id = ANY($3::uuid[])`,
        [planId, validated.jobId, existingIds]
      );
      if (existing.rows.length !== existingIds.length) {
        return { abort: failure(404, "WORK_PREPARATION_ITEM_UNAVAILABLE", "A plan item is unavailable.") };
      }
    }
    for (const item of normalizedItems) {
      if (!(await validateItemLineage(client, plan, item))) {
        return { abort: failure(409, "WORK_PREPARATION_ITEM_LINEAGE_REJECTED", "The item does not match accepted Quote authority.") };
      }
    }
    const version = expectedVersion + 1;
    await client.query(
      `INSERT INTO canonical_work_preparation_plan_versions (
        plan_id, version, job_id, relationship_id, planning_state,
        work_start_policy, internal_notes, recorded_by_participant_id,
        command_idempotency_id, integrity_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [planId, version, validated.jobId, nullableInteger(plan.relationship_id), planningState,
        workStartPolicy, internalNotes, context.professional_participant_id,
        idempotency.row.id, requestFingerprint]
    );
    for (let index = 0; index < normalizedItems.length; index += 1) {
      const item = normalizedItems[index];
      if (!item.id) {
        item.id = randomUUID();
        const childKey = `${validated.idempotencyKey}:item:${index + 1}`;
        const child = await reserveCommand(client, {
          jobId: validated.jobId,
          participantId: context.professional_participant_id,
          commandName: COMMANDS.REVISE,
          commandScope: `plan:${planId}:item:${item.id}`,
          idempotencyKey: childKey,
          requestFingerprint: hash({ planId, itemId: item.id, version, index }),
        });
        if (child.error || child.replay) throw new Error("Work Preparation item identity reservation failed.");
        await client.query(
          `INSERT INTO canonical_work_preparation_items (
            id, plan_id, job_id, relationship_id,
            created_by_participant_id, created_command_idempotency_id
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [item.id, planId, validated.jobId, nullableInteger(plan.relationship_id),
            context.professional_participant_id, child.row.id]
        );
        await completeCommand(client, child.row.id, {
          ok: true,
          success: true,
          status: 201,
          code: "WORK_PREPARATION_ITEM_CREATED",
          itemId: item.id,
          planId,
        });
      }
      await client.query(
        `INSERT INTO canonical_work_preparation_item_snapshots (
          plan_id, plan_version, item_id, job_id, relationship_id, sequence,
          item_kind, description, quantity, unit, provider_responsibility,
          commercial_treatment, visibility, required_for_work_start,
          internal_estimated_cost_minor, internal_cost_currency, source_lineage,
          source_quote_id, source_quote_version, source_scope_item_id,
          recorded_by_participant_id, command_idempotency_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [planId, version, item.id, validated.jobId, nullableInteger(plan.relationship_id),
          item.sequence, item.kind, item.description, item.quantity, item.unit,
          item.provider, item.commercial, item.visibility, item.required,
          item.internalCost, item.internalCurrency, item.sourceLineage,
          item.sourceQuoteId, item.sourceQuoteVersion, item.sourceScopeItemId,
          context.professional_participant_id, idempotency.row.id]
      );
    }
    const revised = await loadPlan(client, validated.jobId, planId);
    const result = {
      ok: true,
      success: true,
      status: 200,
      code: "WORK_PREPARATION_REVISED",
      workPreparation: await projectPlanWithClient(client, revised),
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

async function nextEventIdentity(client, planId) {
  const result = await client.query(
    `SELECT id, event_sequence
     FROM canonical_work_preparation_events
     WHERE plan_id = $1
     ORDER BY event_sequence DESC LIMIT 1`,
    [planId]
  );
  const previous = result.rows[0] || null;
  return {
    sequence: previous ? Number(previous.event_sequence) + 1 : 1,
    previousId: previous?.id || null,
  };
}

async function insertEvent(client, {
  plan,
  planVersion = Number(plan.current_version),
  itemId = null,
  eventType,
  dimension,
  state,
  visibility = "BUSINESS_ONLY",
  customerVisibleNote = null,
  internalNote = null,
  purchaseId = null,
  correctionId = null,
  deposit,
  participantId,
  commandId,
}) {
  const identity = await nextEventIdentity(client, plan.id);
  const id = randomUUID();
  await client.query(
    `INSERT INTO canonical_work_preparation_events (
      id, plan_id, plan_version, item_id, job_id, relationship_id,
      event_sequence, previous_event_id, event_type, readiness_dimension,
      resulting_readiness_state, visibility, customer_visible_note,
      internal_note, purchase_id, purchase_correction_id, deposit_gate_type,
      deposit_obligation_id, deposit_obligation_version,
      deposit_obligation_state, deposit_currency,
      recorded_by_participant_id, command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [id, plan.id, planVersion, itemId, plan.job_id,
      nullableInteger(plan.relationship_id), identity.sequence, identity.previousId,
      eventType, dimension, state, visibility, customerVisibleNote, internalNote,
      purchaseId, correctionId, deposit.gateType, deposit.obligationId,
      deposit.obligationVersion, deposit.obligationState, deposit.currency,
      participantId, commandId]
  );
  return id;
}

async function loadCurrentItem(client, plan, itemId) {
  const result = await client.query(
    `SELECT snapshots.*
     FROM canonical_work_preparation_item_snapshots snapshots
     WHERE snapshots.plan_id = $1 AND snapshots.plan_version = $2
       AND snapshots.item_id = $3 AND snapshots.job_id = $4
     LIMIT 1`,
    [plan.id, Number(plan.current_version), itemId, plan.job_id]
  );
  return result.rows[0] || null;
}

async function recordMaterialPurchase(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "planId", "itemId", "expectedVersion", "quantity", "unit",
      "internalCostMinor", "internalCostCurrency", "vendor", "purchasedAt",
      "externalReference", "visibility", "idempotencyKey"],
    { idempotency: true }
  );
  if (validated.error) return validated.error;
  const planId = normalizedUuid(input.planId);
  const itemId = normalizedUuid(input.itemId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const quantity = positiveDecimal(input.quantity);
  const unit = boundedText(input.unit, 80);
  const internalCost = nonnegativeMinor(input.internalCostMinor, { positive: true, optional: true });
  const internalCurrency = input.internalCostCurrency == null
    ? null : String(input.internalCostCurrency).trim().toUpperCase();
  const vendor = boundedText(input.vendor, 300, { optional: true });
  const purchasedAt = isoInstant(input.purchasedAt);
  const externalReference = boundedText(input.externalReference, 500, { optional: true });
  const visibility = String(input.visibility || "BUSINESS_ONLY").trim().toUpperCase();
  if (
    !planId || !itemId || !expectedVersion || !quantity || !unit || !purchasedAt ||
    ((internalCost == null) !== (internalCurrency == null)) ||
    (internalCurrency && !CURRENCY_PATTERN.test(internalCurrency)) ||
    (input.vendor != null && vendor == null) ||
    (input.externalReference != null && externalReference == null) ||
    !VISIBILITIES.has(visibility)
  ) return failure(400, "INVALID_MATERIAL_PURCHASE", "The material purchase is invalid.");

  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    const plan = await loadPlan(client, validated.jobId, planId, { lock: true });
    const authorityError = await requirePlanCapability(client, context, plan, CAPABILITIES.PURCHASE);
    if (authorityError) return { abort: authorityError };
    if (!plan) return { abort: failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.") };
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.PURCHASE,
      commandScope: `plan:${planId}:item:${itemId}:purchase`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: hash({ planId, itemId, expectedVersion, quantity, unit,
        internalCost, internalCurrency, vendor, purchasedAt, externalReference, visibility }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(plan.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_WORK_PREPARATION_VERSION", "The plan version is no longer current.") };
    }
    if (plan.planning_state === "RETIRED") {
      return { abort: failure(409, "WORK_PREPARATION_RETIRED", "A retired plan is read-only.") };
    }
    const item = await loadCurrentItem(client, plan, itemId);
    if (!item) return { abort: failure(404, "WORK_PREPARATION_ITEM_UNAVAILABLE", "The plan item is unavailable.") };
    if (
      item.item_kind !== "MATERIAL" || item.provider_responsibility !== "BUSINESS" ||
      !["INCLUDED_IN_ACCEPTED_TOTAL", "NOT_CUSTOMER_BILLABLE"].includes(item.commercial_treatment)
    ) {
      return { abort: failure(409, "MATERIAL_PURCHASE_NOT_AUTHORIZED", "This item cannot create business purchase evidence.") };
    }
    if (internalCurrency && internalCurrency !== plan.commercial_currency) {
      return { abort: failure(409, "MATERIAL_PURCHASE_CURRENCY_MISMATCH", "The internal purchase currency is invalid.") };
    }
    const commitment = await evaluateCommitmentGate(client, plan);
    if (commitment.error) return { abort: commitment.error };
    const purchaseId = randomUUID();
    const gate = commitment.evidence;
    await client.query(
      `INSERT INTO canonical_material_purchase_records (
        id, job_id, relationship_id, plan_id, basis_plan_version, item_id,
        quantity, unit, internal_cost_minor, internal_cost_currency, vendor,
        purchased_at, external_reference, visibility, deposit_gate_type,
        deposit_obligation_id, deposit_obligation_version,
        deposit_obligation_state, deposit_currency,
        recorded_by_participant_id, command_idempotency_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [purchaseId, validated.jobId, nullableInteger(plan.relationship_id), planId,
        expectedVersion, itemId, quantity, unit, internalCost, internalCurrency,
        vendor, purchasedAt, externalReference, visibility, gate.gateType,
        gate.obligationId, gate.obligationVersion, gate.obligationState,
        gate.currency, context.professional_participant_id, idempotency.row.id]
    );
    const rows = await loadProjectionRows(client, plan);
    const net = netPurchaseForItem(itemId, rows.purchases, rows.corrections);
    const state = net.netQuantity >= Number(item.quantity) ? "PURCHASED" : "PARTIALLY_PURCHASED";
    const eventId = await insertEvent(client, {
      plan,
      itemId,
      eventType: "PURCHASE_RECORDED",
      dimension: "ACQUISITION",
      state,
      visibility,
      purchaseId,
      deposit: gate,
      participantId: context.professional_participant_id,
      commandId: idempotency.row.id,
    });
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "MATERIAL_PURCHASE_RECORDED",
      purchase: {
        id: purchaseId,
        planId,
        planVersion: expectedVersion,
        itemId,
        quantity,
        unit,
        internalCostMinor: internalCost,
        internalCostCurrency: internalCurrency,
        purchasedAt,
        visibility,
        eventId,
      },
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

async function correctMaterialPurchase(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "planId", "purchaseId", "expectedVersion", "reversedQuantity",
      "reversedInternalCostMinor", "reasonCategory", "reason", "correctedAt",
      "idempotencyKey"],
    { idempotency: true }
  );
  if (validated.error) return validated.error;
  const planId = normalizedUuid(input.planId);
  const purchaseId = normalizedUuid(input.purchaseId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const reversedQuantity = nonnegativeDecimal(input.reversedQuantity);
  const reversedCost = nonnegativeMinor(input.reversedInternalCostMinor);
  const reasonCategory = String(input.reasonCategory || "").trim().toUpperCase();
  const reason = boundedText(input.reason, 2000);
  const correctedAt = isoInstant(input.correctedAt);
  if (
    !planId || !purchaseId || !expectedVersion || reversedQuantity == null ||
    reversedCost == null || (reversedQuantity === 0 && reversedCost === 0) ||
    !CORRECTION_REASONS.has(reasonCategory) || !reason || !correctedAt
  ) return failure(400, "INVALID_MATERIAL_PURCHASE_CORRECTION", "The purchase correction is invalid.");

  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    const plan = await loadPlan(client, validated.jobId, planId, { lock: true });
    const authorityError = await requirePlanCapability(client, context, plan, CAPABILITIES.PURCHASE);
    if (authorityError) return { abort: authorityError };
    if (!plan) return { abort: failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.") };
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.CORRECT_PURCHASE,
      commandScope: `purchase:${purchaseId}:correction`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: hash({ planId, purchaseId, expectedVersion, reversedQuantity,
        reversedCost, reasonCategory, reason, correctedAt }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(plan.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_WORK_PREPARATION_VERSION", "The plan version is no longer current.") };
    }
    const purchaseResult = await client.query(
      `SELECT * FROM canonical_material_purchase_records
       WHERE id = $1 AND plan_id = $2 AND job_id = $3
       LIMIT 1 FOR UPDATE`,
      [purchaseId, planId, validated.jobId]
    );
    const purchase = purchaseResult.rows[0];
    if (!purchase) return { abort: failure(404, "MATERIAL_PURCHASE_UNAVAILABLE", "The material purchase is unavailable.") };
    const priorCorrections = await client.query(
      `SELECT COALESCE(sum(reversed_quantity), 0) AS reversed_quantity,
        COALESCE(sum(reversed_internal_cost_minor), 0) AS reversed_cost
       FROM canonical_material_purchase_corrections
       WHERE purchase_id = $1`,
      [purchaseId]
    );
    const prior = priorCorrections.rows[0];
    if (
      Number(prior.reversed_quantity) + reversedQuantity > Number(purchase.quantity) ||
      Number(prior.reversed_cost) + reversedCost > Number(purchase.internal_cost_minor || 0)
    ) {
      return {
        abort: failure(
          409,
          "MATERIAL_PURCHASE_CORRECTION_EXCEEDS_EVIDENCE",
          "The correction exceeds the remaining purchase evidence."
        ),
      };
    }
    const correctionId = randomUUID();
    await client.query(
      `INSERT INTO canonical_material_purchase_corrections (
        id, purchase_id, job_id, relationship_id, plan_id,
        basis_plan_version, item_id, reversed_quantity,
        reversed_internal_cost_minor, reason_category, reason, corrected_at,
        recorded_by_participant_id, command_idempotency_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [correctionId, purchaseId, validated.jobId, nullableInteger(plan.relationship_id),
        planId, Number(purchase.basis_plan_version), purchase.item_id,
        reversedQuantity, reversedCost, reasonCategory, reason, correctedAt,
        context.professional_participant_id, idempotency.row.id]
    );
    const rows = await loadProjectionRows(client, plan);
    const item = await loadCurrentItem(client, plan, purchase.item_id);
    const net = netPurchaseForItem(purchase.item_id, rows.purchases, rows.corrections);
    const state = net.netQuantity <= 0
      ? "NOT_STARTED"
      : net.netQuantity >= Number(item?.quantity || Infinity)
        ? "PURCHASED"
        : "PARTIALLY_PURCHASED";
    const eventId = await insertEvent(client, {
      plan,
      planVersion: Number(purchase.basis_plan_version),
      itemId: purchase.item_id,
      eventType: "PURCHASE_CORRECTED",
      dimension: "ACQUISITION",
      state,
      purchaseId,
      correctionId,
      deposit: {
        gateType: purchase.deposit_gate_type,
        obligationId: purchase.deposit_obligation_id,
        obligationVersion: purchase.deposit_obligation_version == null
          ? null
          : Number(purchase.deposit_obligation_version),
        obligationState: purchase.deposit_obligation_state,
        currency: purchase.deposit_currency,
      },
      participantId: context.professional_participant_id,
      commandId: idempotency.row.id,
    });
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "MATERIAL_PURCHASE_CORRECTED",
      correction: {
        id: correctionId,
        purchaseId,
        reversedQuantity,
        reversedInternalCostMinor: reversedCost,
        reasonCategory,
        reason,
        correctedAt,
        eventId,
      },
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

function validateEventForItem(eventType, item) {
  if (["PREPARATION_STARTED", "PREPARATION_READY", "PREPARATION_BLOCKED"].includes(eventType)) {
    return true;
  }
  if (!item) return false;
  if (["CUSTOMER_ITEM_REQUESTED", "CUSTOMER_ITEM_RECEIVED"].includes(eventType)) {
    return item.item_kind === "MATERIAL" && item.provider_responsibility === "CUSTOMER";
  }
  if (["MATERIAL_STAGED", "BUSINESS_INVENTORY_ALLOCATED"].includes(eventType)) {
    return item.item_kind === "MATERIAL" && item.provider_responsibility === "BUSINESS" &&
      ["INCLUDED_IN_ACCEPTED_TOTAL", "NOT_CUSTOMER_BILLABLE"].includes(item.commercial_treatment);
  }
  if (eventType === "TOOLS_READY") return item.item_kind === "TOOL";
  if (eventType === "EQUIPMENT_READY") return item.item_kind === "EQUIPMENT";
  return false;
}

function eventDimensionState(eventType) {
  if (eventType === "CUSTOMER_ITEM_REQUESTED") return ["ACQUISITION", "CUSTOMER_ITEM_PENDING"];
  if (["CUSTOMER_ITEM_RECEIVED", "MATERIAL_STAGED", "BUSINESS_INVENTORY_ALLOCATED",
    "TOOLS_READY", "EQUIPMENT_READY"].includes(eventType)) return ["ACQUISITION", "READY"];
  if (eventType === "PREPARATION_STARTED") return ["PREPARATION", "IN_PROGRESS"];
  if (eventType === "PREPARATION_READY") return ["PREPARATION", "READY"];
  return ["PREPARATION", "BLOCKED"];
}

async function recordPreparationEvent(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "planId", "itemId", "expectedVersion", "eventType", "visibility",
      "customerVisibleNote", "internalNote", "idempotencyKey"],
    { idempotency: true }
  );
  if (validated.error) return validated.error;
  const planId = normalizedUuid(input.planId);
  const itemId = input.itemId == null ? null : normalizedUuid(input.itemId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const eventType = String(input.eventType || "").trim().toUpperCase();
  const visibility = String(input.visibility || "BUSINESS_ONLY").trim().toUpperCase();
  const customerVisibleNote = boundedText(input.customerVisibleNote, 1000, { optional: true });
  const internalNote = boundedText(input.internalNote, 2000, { optional: true });
  if (
    !planId || !expectedVersion || !EVENT_COMMANDS[eventType] || !VISIBILITIES.has(visibility) ||
    (input.itemId != null && !itemId) ||
    (input.customerVisibleNote != null && customerVisibleNote == null) ||
    (input.internalNote != null && internalNote == null) ||
    (visibility === "CUSTOMER_VISIBLE" && !customerVisibleNote) ||
    (visibility === "BUSINESS_ONLY" && customerVisibleNote)
  ) return failure(400, "INVALID_WORK_PREPARATION_EVENT", "The preparation event is invalid.");

  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    const plan = await loadPlan(client, validated.jobId, planId, { lock: true });
    const authorityError = await requirePlanCapability(client, context, plan, CAPABILITIES.PREPARATION);
    if (authorityError) return { abort: authorityError };
    if (!plan) return { abort: failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.") };
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: EVENT_COMMANDS[eventType],
      commandScope: `plan:${planId}:event:${eventType}:${itemId || "plan"}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: hash({ planId, itemId, expectedVersion, eventType,
        visibility, customerVisibleNote, internalNote }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    if (Number(plan.current_version) !== expectedVersion) {
      return { abort: failure(409, "STALE_WORK_PREPARATION_VERSION", "The plan version is no longer current.") };
    }
    if (plan.planning_state === "RETIRED") {
      return { abort: failure(409, "WORK_PREPARATION_RETIRED", "A retired plan is read-only.") };
    }
    const item = itemId ? await loadCurrentItem(client, plan, itemId) : null;
    if (itemId && !item) {
      return { abort: failure(404, "WORK_PREPARATION_ITEM_UNAVAILABLE", "The plan item is unavailable.") };
    }
    if (!validateEventForItem(eventType, item)) {
      return { abort: failure(409, "WORK_PREPARATION_EVENT_NOT_AUTHORIZED", "The event does not match the current plan item.") };
    }
    const commitment = await evaluateCommitmentGate(client, plan);
    if (commitment.error) return { abort: commitment.error };
    const [dimension, state] = eventDimensionState(eventType);
    const eventId = await insertEvent(client, {
      plan,
      itemId,
      eventType,
      dimension,
      state,
      visibility,
      customerVisibleNote,
      internalNote,
      deposit: commitment.evidence,
      participantId: context.professional_participant_id,
      commandId: idempotency.row.id,
    });
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "WORK_PREPARATION_EVENT_RECORDED",
      event: {
        id: eventId,
        planId,
        planVersion: expectedVersion,
        itemId,
        eventType,
        readinessDimension: dimension,
        resultingReadinessState: state,
        visibility,
      },
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

async function attachEvidenceReference(input = {}) {
  const validated = validateInput(
    input,
    ["jobId", "planId", "purchaseId", "purchaseCorrectionId", "eventId",
      "evidenceType", "referenceNamespace", "referenceId", "visibility",
      "idempotencyKey"],
    { idempotency: true }
  );
  if (validated.error) return validated.error;
  const planId = normalizedUuid(input.planId);
  const purchaseId = input.purchaseId == null ? null : normalizedUuid(input.purchaseId);
  const correctionId = input.purchaseCorrectionId == null
    ? null : normalizedUuid(input.purchaseCorrectionId);
  const eventId = input.eventId == null ? null : normalizedUuid(input.eventId);
  const evidenceType = String(input.evidenceType || "").trim().toUpperCase();
  const referenceNamespace = String(input.referenceNamespace || "").trim();
  const referenceId = boundedText(input.referenceId, 500);
  const visibility = String(input.visibility || "BUSINESS_ONLY").trim().toUpperCase();
  if (
    !planId || [purchaseId, correctionId, eventId].filter(Boolean).length !== 1 ||
    !EVIDENCE_TYPES.has(evidenceType) || !REFERENCE_NAMESPACE_PATTERN.test(referenceNamespace) ||
    !referenceId || !VISIBILITIES.has(visibility)
  ) return failure(400, "INVALID_WORK_PREPARATION_EVIDENCE", "The evidence reference is invalid.");
  return runTransaction(input.pool, "SERIALIZABLE", async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId, { lock: true });
    const plan = await loadPlan(client, validated.jobId, planId, { lock: true });
    const authorityError = await requirePlanCapability(client, context, plan, CAPABILITIES.PREPARATION);
    if (authorityError) return { abort: authorityError };
    if (!plan) return { abort: failure(404, "WORK_PREPARATION_UNAVAILABLE", "Work Preparation is unavailable.") };
    const idempotency = await reserveCommand(client, {
      jobId: validated.jobId,
      participantId: context.professional_participant_id,
      commandName: COMMANDS.EVIDENCE_ATTACH,
      commandScope: `plan:${planId}:evidence:${purchaseId || correctionId || eventId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: hash({ planId, purchaseId, correctionId, eventId,
        evidenceType, referenceNamespace, referenceId, visibility }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) return { result: replayResult(idempotency.replay) };
    const evidenceId = randomUUID();
    await client.query(
      `INSERT INTO canonical_work_preparation_evidence_references (
        id, plan_id, job_id, relationship_id, purchase_id,
        purchase_correction_id, event_id, evidence_type,
        reference_namespace, reference_id, visibility,
        recorded_by_participant_id, command_idempotency_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [evidenceId, planId, validated.jobId, nullableInteger(plan.relationship_id),
        purchaseId, correctionId, eventId, evidenceType, referenceNamespace,
        referenceId, visibility, context.professional_participant_id,
        idempotency.row.id]
    );
    const result = {
      ok: true,
      success: true,
      status: 201,
      code: "WORK_PREPARATION_EVIDENCE_ATTACHED",
      evidence: { id: evidenceId, evidenceType, visibility },
    };
    await completeCommand(client, idempotency.row.id, result);
    return { result };
  });
}

async function evaluateWorkPreparationStartWithClient({
  client,
  jobId,
  approvedCustomerDecisionId = null,
  quoteApprovalId = null,
  execution = null,
  lock = false,
}) {
  const decisionId = normalizedUuid(approvedCustomerDecisionId);
  if (!decisionId && !normalizedUuid(quoteApprovalId)) {
    return {
      allowed: false,
      code: "WORK_PREPARATION_DECISION_REQUIRED",
      plan: null,
    };
  }
  const plan = await loadPlanByApproval(client, jobId, quoteApprovalId, decisionId, { lock });
  if (!plan) {
    return {
      allowed: true,
      code: "WORK_PREPARATION_START_NOT_GATED",
      plan: null,
      planId: null,
      planVersion: null,
      required: false,
      readiness: null,
    };
  }
  if (
    execution && (
      plan.quote_approval_id !== execution.quote_approval_id ||
      plan.approved_customer_decision_id !== execution.approved_customer_decision_id ||
      plan.quote_id !== execution.quote_id ||
      Number(plan.issued_quote_version) !== Number(execution.issued_quote_version) ||
      nullableInteger(plan.relationship_id) !== nullableInteger(execution.relationship_id)
    )
  ) {
    return {
      allowed: false,
      code: "WORK_PREPARATION_EXECUTION_MISMATCH",
      planId: plan.id,
      planVersion: Number(plan.current_version),
      required: true,
      readiness: null,
    };
  }
  const rows = await loadProjectionRows(client, plan);
  const readiness = readinessProjection(plan, rows);
  const required = readiness.requiredItemCount > 0;
  const invalidNonePolicy = plan.work_start_policy === "NONE" && required;
  const blocked = invalidNonePolicy || readiness.workStartBlocked;
  return blocked
    ? {
      allowed: false,
      code: invalidNonePolicy
        ? "WORK_PREPARATION_POLICY_INVALID"
        : "WORK_PREPARATION_REQUIRED_BEFORE_START",
      planId: plan.id,
      planVersion: Number(plan.current_version),
      required,
      readiness,
    }
    : {
      allowed: true,
      code: required
        ? "WORK_PREPARATION_READY_FOR_START"
        : "WORK_PREPARATION_START_NOT_GATED",
      planId: plan.id,
      planVersion: Number(plan.current_version),
      required,
      readiness,
    };
}

function workStartFailure() {
  return failure(
    409,
    "WORK_PREPARATION_REQUIRED_BEFORE_START",
    "Required materials and preparation must be ready before Work can start."
  );
}

async function loadWorkPreparationSummaryWithClient(client, jobId, { customerSafe = false } = {}) {
  const plan = await loadPlan(client, jobId);
  if (!plan) return { contractVersion: CONTRACT_VERSION, exists: false, jobId };
  return projectPlanWithClient(client, plan, { customerSafe });
}

module.exports = {
  CAPABILITIES,
  COMMANDS,
  attachEvidenceReference,
  correctMaterialPurchase,
  evaluateWorkPreparationStartWithClient,
  getWorkPreparation,
  loadWorkPreparationSummaryWithClient,
  materializeWorkPreparation,
  recordMaterialPurchase,
  recordPreparationEvent,
  reviseWorkPreparation,
  workPreparationServiceInternals: Object.freeze({
    commitmentGateFailure,
    depositEvidence,
    hash,
    itemReadiness,
    planProjection,
    readinessProjection,
    validateRevisionItem,
  }),
  workStartFailure,
};
