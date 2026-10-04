"use strict";

const { createHash, randomUUID } = require("node:crypto");

const {
  cloneBoundedJson,
  isPlainObject,
  normalizeIdempotencyKey,
} = require("./intelligenceGatewayContracts");
const {
  UUID_PATTERN,
  loadAuthorizedJob,
} = require("./quoteCompositionContext");

const ACTIONS = new Set(["ACCEPTED", "EDITED", "REJECTED"]);
const ELEMENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;

function response(ok, status, code, message, extra = {}) {
  return { ok, status, code, message, ...extra };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

function fingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function findProposalElement(proposal, elementId) {
  for (const key of [
    "scopeSections",
    "proposedScopeItems",
    "materials",
    "exclusions",
    "assumptions",
    "separateProposals",
    "commercialMissingInformation",
    "workflowConditions",
  ]) {
    const found = Array.isArray(proposal[key])
      ? proposal[key].find((item) => item?.id === elementId)
      : null;
    if (found) return { collection: key, element: found };
  }
  return null;
}

function validateFeedbackInput(input) {
  if (!isPlainObject(input)) {
    return { error: response(false, 400, "QUOTE_COMPOSITION_FEEDBACK_INVALID", "The feedback is invalid.") };
  }
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    "proposalId",
    "elementId",
    "action",
    "editedValue",
    "reasonCategory",
    "idempotencyKey",
    "logger",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: response(false, 400, "QUOTE_COMPOSITION_FEEDBACK_FIELDS_REJECTED", "Server-owned feedback fields cannot be supplied.") };
  }
  const actor = input.authenticatedActor;
  const actorAccountType = String(actor?.accountType || "").trim().toLowerCase();
  const actorRole = String(actor?.role || "").trim().toLowerCase();
  const proposalId = typeof input.proposalId === "string" && UUID_PATTERN.test(input.proposalId)
    ? input.proposalId.toLowerCase()
    : null;
  const elementId = typeof input.elementId === "string"
    ? input.elementId.trim().toLowerCase()
    : "";
  const action = String(input.action || "").trim().toUpperCase();
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const reasonCategory = input.reasonCategory == null
    ? null
    : String(input.reasonCategory).trim().toUpperCase();
  if (
    !Number.isInteger(actor?.id) || actor.id <= 0 ||
    !(actorAccountType === "professional" || (actorRole && actorRole !== "homeowner")) ||
    !proposalId || !ELEMENT_ID_PATTERN.test(elementId) || !ACTIONS.has(action) ||
    !idempotencyKey || (reasonCategory !== null && !REASON_PATTERN.test(reasonCategory)) ||
    ((action === "EDITED") !== (input.editedValue !== undefined))
  ) {
    return { error: response(false, 400, "QUOTE_COMPOSITION_FEEDBACK_INVALID", "The feedback is invalid.") };
  }
  let editedValue = null;
  if (action === "EDITED") {
    if (!isPlainObject(input.editedValue)) {
      return { error: response(false, 400, "QUOTE_COMPOSITION_FEEDBACK_INVALID", "Edited feedback requires a structured value.") };
    }
    try {
      editedValue = cloneBoundedJson(input.editedValue, {
        maxBytes: 8192,
        maxDepth: 6,
        maxKeys: 50,
        maxArrayLength: 20,
        maxStringLength: 2000,
      });
    } catch {
      return { error: response(false, 400, "QUOTE_COMPOSITION_FEEDBACK_INVALID", "The edited value is not permitted.") };
    }
  }
  return {
    actor,
    proposalId,
    elementId,
    action,
    editedValue,
    reasonCategory,
    idempotencyKey,
  };
}

async function withTransaction(pool, work) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("A database pool is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    if (result.abort) {
      await client.query("ROLLBACK");
      return result.abort;
    }
    await client.query("COMMIT");
    result.afterCommit?.();
    return result.result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function feedbackProjection(row) {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    jobId: row.job_id,
    professionalParticipantId: row.professional_participant_id,
    elementId: row.proposal_element_id,
    action: row.action,
    editedValue: row.edited_value,
    canonicalSourceReferences: row.canonical_source_references || [],
    reasonCategory: row.reason_category,
    learningContext: row.learning_context,
    createdAt: row.created_at,
  };
}

async function recordQuoteCompositionFeedback(input = {}) {
  const validated = validateFeedbackInput(input);
  if (validated.error) return validated.error;
  const logger = input.logger && typeof input.logger.info === "function"
    ? input.logger
    : null;

  return withTransaction(input.pool, async (client) => {
    const operation = (await client.query(
      `/* quote_composition_feedback:proposal */
       SELECT id, actor_user_id, result_payload
       FROM intelligence_operation_idempotency
       WHERE id = $1 AND actor_user_id = $2
         AND operation = 'quote.compose' AND status = 'completed'
       LIMIT 1 FOR SHARE`,
      [validated.proposalId, validated.actor.id]
    )).rows[0];
    const proposal = operation?.result_payload;
    if (
      !proposal ||
      proposal.proposalId !== validated.proposalId ||
      proposal.authorityClassification !== "ADVISORY_NON_CANONICAL"
    ) {
      return { abort: response(false, 404, "QUOTE_COMPOSITION_PROPOSAL_UNAVAILABLE", "The proposal is unavailable.") };
    }
    let job;
    try {
      job = await loadAuthorizedJob(client, proposal.jobId, validated.actor.id);
    } catch (error) {
      if (error?.code === "intelligence_job_unavailable") {
        return { abort: response(false, 404, "QUOTE_COMPOSITION_PROPOSAL_UNAVAILABLE", "The proposal is unavailable.") };
      }
      return { abort: response(false, 403, "QUOTE_COMPOSITION_REVIEW_AUTHORITY_REQUIRED", "Professional Quote authority is required.") };
    }
    if (
      job.professional_participant_id !== proposal.generatedFor?.professionalParticipantId
    ) {
      return { abort: response(false, 403, "QUOTE_COMPOSITION_REVIEW_AUTHORITY_REQUIRED", "Professional Quote authority is required.") };
    }
    const located = findProposalElement(proposal, validated.elementId);
    if (!located) {
      return { abort: response(false, 404, "QUOTE_COMPOSITION_ELEMENT_UNAVAILABLE", "The proposal element is unavailable.") };
    }
    const sourceReferences = located.element.sourceReferences || [];
    const learningContext = {
      industry: proposal.learningContext?.industry || null,
      businessType: proposal.learningContext?.businessType || null,
      serviceType: proposal.learningContext?.serviceType || null,
      context: "quote_composition",
      business: proposal.learningContext?.business || null,
      professional: job.professional_participant_id,
      job: proposal.jobId,
      learnedPatternIsCanonicalRule: false,
    };
    const requestFingerprint = fingerprint({
      proposalId: validated.proposalId,
      elementId: validated.elementId,
      action: validated.action,
      editedValue: validated.editedValue,
      reasonCategory: validated.reasonCategory,
      sourceReferences,
    });
    const inserted = await client.query(
      `/* quote_composition_feedback:insert */
       INSERT INTO intelligence_quote_composition_feedback (
         id, operation_id, proposal_id, job_id,
         professional_user_id, professional_participant_id,
         proposal_element_id, action, edited_value,
         canonical_source_references, reason_category, learning_context,
         idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $2, $3, $4, $5, $6, $7, $8::jsonb,
         $9::jsonb, $10, $11::jsonb, $12, $13
       )
       ON CONFLICT (
         professional_user_id, proposal_id, proposal_element_id, idempotency_key
       ) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        validated.proposalId,
        proposal.jobId,
        validated.actor.id,
        job.professional_participant_id,
        validated.elementId,
        validated.action,
        validated.editedValue == null ? null : JSON.stringify(validated.editedValue),
        JSON.stringify(sourceReferences),
        validated.reasonCategory,
        JSON.stringify(learningContext),
        validated.idempotencyKey,
        requestFingerprint,
      ]
    );
    let row = inserted.rows[0];
    let replayed = false;
    if (!row) {
      row = (await client.query(
        `/* quote_composition_feedback:replay */
         SELECT * FROM intelligence_quote_composition_feedback
         WHERE professional_user_id = $1 AND proposal_id = $2
           AND proposal_element_id = $3 AND idempotency_key = $4
         LIMIT 1 FOR SHARE`,
        [validated.actor.id, validated.proposalId, validated.elementId, validated.idempotencyKey]
      )).rows[0];
      if (!row || row.request_fingerprint !== requestFingerprint) {
        return { abort: response(false, 409, "QUOTE_COMPOSITION_FEEDBACK_CONFLICT", "The feedback key was already used for different input.") };
      }
      replayed = true;
    }
    const result = response(true, replayed ? 200 : 201, replayed
      ? "QUOTE_COMPOSITION_FEEDBACK_REPLAYED"
      : "QUOTE_COMPOSITION_FEEDBACK_RECORDED", "Professional advisory feedback was recorded.", {
      feedback: feedbackProjection(row),
      replayed,
      canonicalMutationPerformed: false,
    });
    return {
      result,
      afterCommit: () => logger?.info("intelligence.quote_composition.feedback_recorded", {
        operation: "quote.compose",
        proposalId: validated.proposalId,
        jobId: proposal.jobId,
        elementId: validated.elementId,
        action: validated.action,
        replayed,
      }),
    };
  });
}

module.exports = {
  ACTIONS,
  findProposalElement,
  recordQuoteCompositionFeedback,
  validateFeedbackInput,
};
