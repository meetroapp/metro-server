"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  cloneBoundedJson,
  isPlainObject,
  normalizeIdempotencyKey,
} = require("./intelligenceGatewayContracts");

const OPERATIONS = new Set([
  "job_request.interpret",
  "evaluation.assist",
  "estimate.compose",
  "invoice.assist",
]);
const ACTIONS = new Set(["ACCEPTED", "EDITED", "REJECTED"]);
const ELEMENT_ID = /^[a-z][a-z0-9_.:-]{0,159}$/;

function response(ok, status, code, message, extra = {}) {
  return { ok, status, code, message, ...extra };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeActor(actor) {
  const id = Number(actor?.id);
  return Number.isInteger(id) && id > 0 ? { id } : null;
}

function normalizeElementId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ELEMENT_ID.test(normalized) ? normalized : null;
}

function findElement(proposal, operation, elementId) {
  if (operation === "job_request.interpret") {
    return (proposal?.draftPatch?.fields || []).find((item) => item.path === elementId) || null;
  }
  const pending = [proposal];
  const visited = new Set();
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (!Array.isArray(value) && String(value.id || "").toLowerCase() === elementId) return value;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return null;
}

function normalizeInput(input = {}) {
  const actor = normalizeActor(input.authenticatedActor);
  const proposalId = typeof input.proposalId === "string" ? input.proposalId.trim().toLowerCase() : "";
  const elementId = normalizeElementId(input.elementId);
  const action = typeof input.action === "string" ? input.action.trim().toUpperCase() : "";
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const reasonCategory = input.reasonCategory == null || input.reasonCategory === ""
    ? null
    : String(input.reasonCategory).trim().toUpperCase();
  if (!actor) return { error: response(false, 401, "INTELLIGENCE_REVIEW_AUTHENTICATION_REQUIRED", "Authentication required.") };
  if (!/^[0-9a-f-]{36}$/.test(proposalId) || !elementId || !ACTIONS.has(action) || !idempotencyKey) {
    return { error: response(false, 400, "INTELLIGENCE_REVIEW_INVALID", "A valid review decision is required.") };
  }
  if (reasonCategory && !/^[A-Z][A-Z0-9_]{2,79}$/.test(reasonCategory)) {
    return { error: response(false, 400, "INTELLIGENCE_REVIEW_INVALID", "A valid review reason is required.") };
  }
  if ((action === "EDITED") !== Object.hasOwn(input, "editedValue")) {
    return { error: response(false, 400, "INTELLIGENCE_REVIEW_INVALID", "Edited review requires the reviewed value.") };
  }
  let editedValue = null;
  if (action === "EDITED") {
    try {
      editedValue = cloneBoundedJson(input.editedValue, {
        maxBytes: 16384,
        maxStringLength: 8000,
        maxKeys: 200,
        maxArrayLength: 50,
      });
    } catch {
      return { error: response(false, 400, "INTELLIGENCE_REVIEW_INVALID", "The edited review value is invalid.") };
    }
  }
  if (!input.pool || typeof input.pool.connect !== "function") {
    throw new TypeError("A database pool is required.");
  }
  return { actor, proposalId, elementId, action, editedValue, reasonCategory, idempotencyKey };
}

function reviewProjection(row) {
  return {
    reviewId: row.id,
    proposalId: row.operation_id,
    operation: row.operation_type,
    elementId: row.proposal_element_id,
    action: row.action,
    editedValue: row.edited_value || null,
    reasonCategory: row.reason_category || null,
    createdAt: new Date(row.created_at).toISOString(),
    learnedPatternIsCanonicalRule: false,
  };
}

async function recordWorkflowReview(input = {}) {
  const validated = normalizeInput(input);
  if (validated.error) return validated.error;
  const client = await input.pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const operationRow = (await client.query(
      `/* intelligence_workflow_review:proposal */
       SELECT id, actor_user_id, operation, result_payload
       FROM intelligence_operation_idempotency
       WHERE id = $1 AND actor_user_id = $2 AND status = 'completed'
       LIMIT 1 FOR SHARE`,
      [validated.proposalId, validated.actor.id]
    )).rows[0];
    if (!operationRow || !OPERATIONS.has(operationRow.operation)) {
      await client.query("ROLLBACK");
      started = false;
      return response(false, 404, "INTELLIGENCE_REVIEW_PROPOSAL_UNAVAILABLE", "The proposal is unavailable.");
    }
    const element = findElement(operationRow.result_payload, operationRow.operation, validated.elementId);
    if (!element) {
      await client.query("ROLLBACK");
      started = false;
      return response(false, 404, "INTELLIGENCE_REVIEW_ELEMENT_UNAVAILABLE", "The proposal item is unavailable.");
    }
    const proposal = operationRow.result_payload;
    const recordContext = Object.fromEntries([
      ["jobId", proposal.jobId],
      ["evaluationId", proposal.evaluationId],
      ["invoiceId", proposal.invoiceId],
    ].filter(([, value]) => value != null));
    const sourceReferences = Array.isArray(element.sourceReferences) ? element.sourceReferences : [];
    const learningContext = {
      ...(isPlainObject(proposal.learningContext) ? proposal.learningContext : {}),
      operation: operationRow.operation,
      learnedPatternIsCanonicalRule: false,
    };
    const requestFingerprint = fingerprint({
      proposalId: validated.proposalId,
      elementId: validated.elementId,
      action: validated.action,
      editedValue: validated.editedValue,
      reasonCategory: validated.reasonCategory,
      recordContext,
      sourceReferences,
    });
    const inserted = await client.query(
      `/* intelligence_workflow_review:insert */
       INSERT INTO intelligence_workflow_review_events (
         id, operation_id, operation_type, actor_user_id, proposal_element_id,
         action, edited_value, record_context, canonical_source_references,
         reason_category, learning_context, idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
         $10, $11::jsonb, $12, $13
       )
       ON CONFLICT (actor_user_id, operation_id, proposal_element_id, idempotency_key)
       DO NOTHING RETURNING *`,
      [
        randomUUID(), validated.proposalId, operationRow.operation, validated.actor.id,
        validated.elementId, validated.action,
        validated.editedValue == null ? null : JSON.stringify(validated.editedValue),
        JSON.stringify(recordContext), JSON.stringify(sourceReferences), validated.reasonCategory,
        JSON.stringify(learningContext), validated.idempotencyKey, requestFingerprint,
      ]
    );
    let row = inserted.rows[0];
    let replayed = false;
    if (!row) {
      row = (await client.query(
        `/* intelligence_workflow_review:replay */
         SELECT * FROM intelligence_workflow_review_events
         WHERE actor_user_id = $1 AND operation_id = $2
           AND proposal_element_id = $3 AND idempotency_key = $4
         LIMIT 1 FOR SHARE`,
        [validated.actor.id, validated.proposalId, validated.elementId, validated.idempotencyKey]
      )).rows[0];
      if (!row || row.request_fingerprint !== requestFingerprint) {
        await client.query("ROLLBACK");
        started = false;
        return response(false, 409, "INTELLIGENCE_REVIEW_CONFLICT", "The review key was already used for different input.");
      }
      replayed = true;
    }
    await client.query("COMMIT");
    started = false;
    input.logger?.info?.("intelligence.workflow.review_recorded", {
      operation: operationRow.operation,
      proposalId: validated.proposalId,
      elementId: validated.elementId,
      action: validated.action,
      replayed,
    });
    return response(true, replayed ? 200 : 201, replayed
      ? "INTELLIGENCE_REVIEW_REPLAYED"
      : "INTELLIGENCE_REVIEW_RECORDED", "The review decision was recorded.", {
      review: reviewProjection(row),
      replayed,
      canonicalMutationPerformed: false,
    });
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ACTIONS,
  findElement,
  recordWorkflowReview,
};
