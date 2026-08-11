"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  recordQuoteCompositionFeedback,
  validateFeedbackInput,
} = require("../server/intelligence/quoteCompositionReviewService");

const proposalId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const participantId = "33333333-3333-4333-8333-333333333333";
const findingId = "44444444-4444-4444-8444-444444444444";

function proposal() {
  return {
    proposalId,
    jobId,
    authorityClassification: "ADVISORY_NON_CANONICAL",
    generatedFor: { professionalParticipantId: participantId },
    proposedScopeItems: [{
      id: "repair_scope",
      sourceReferences: [{ type: "FINDING", id: findingId, version: 2 }],
    }],
    learningContext: {
      industry: "home_services",
      businessType: null,
      serviceType: "drywall",
      business: null,
    },
  };
}

function poolFixture() {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      calls.push({ text, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
      if (text.includes("quote_composition_feedback:proposal")) {
        return { rows: [{ id: proposalId, actor_user_id: 65, result_payload: proposal() }] };
      }
      if (text.includes("quote_composition:job_authority")) {
        return { rows: [{
          job_id: jobId,
          job_request_id: 14,
          lifecycle_contract_version: 2,
          relationship_status: "active",
          selected_professional_user_id: 65,
          actor_account_type: "professional",
          professional_participant_id: participantId,
          is_primary_professional: true,
          active_quote_capabilities: ["quote.create", "quote.scope.manage"],
        }] };
      }
      if (text.includes("quote_composition_feedback:insert")) {
        return { rows: [{
          id: randomUUID(),
          proposal_id: proposalId,
          job_id: jobId,
          professional_participant_id: participantId,
          proposal_element_id: "repair_scope",
          action: "ACCEPTED",
          edited_value: null,
          canonical_source_references: [{ type: "FINDING", id: findingId, version: 2 }],
          reason_category: "SCOPE_CONFIRMED",
          learning_context: JSON.parse(values[10]),
          created_at: "2026-08-10T00:00:00.000Z",
        }] };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    release() {},
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("feedback validation allows only professional Accept/Edit/Reject advisory evidence", () => {
  const base = {
    authenticatedActor: { id: 65, role: "professional" },
    proposalId,
    elementId: "repair_scope",
    action: "ACCEPTED",
    idempotencyKey: randomUUID(),
  };
  assert.equal(validateFeedbackInput(base).action, "ACCEPTED");
  assert.equal(validateFeedbackInput({
    ...base,
    authenticatedActor: { id: 65, role: "drywall", accountType: "professional" },
  }).action, "ACCEPTED");
  assert.equal(validateFeedbackInput({ ...base, action: "EDITED" }).error.code, "QUOTE_COMPOSITION_FEEDBACK_INVALID");
  assert.equal(validateFeedbackInput({ ...base, authenticatedActor: { id: 8, role: "homeowner" } }).error.code, "QUOTE_COMPOSITION_FEEDBACK_INVALID");
  assert.equal(validateFeedbackInput({ ...base, action: "APPROVED" }).error.code, "QUOTE_COMPOSITION_FEEDBACK_INVALID");
});

test("recorded feedback derives source and learning metadata without canonical mutation", async () => {
  const fixture = poolFixture();
  const result = await recordQuoteCompositionFeedback({
    pool: fixture.pool,
    authenticatedActor: { id: 65, role: "professional" },
    proposalId,
    elementId: "repair_scope",
    action: "ACCEPTED",
    reasonCategory: "SCOPE_CONFIRMED",
    idempotencyKey: randomUUID(),
  });
  assert.equal(result.code, "QUOTE_COMPOSITION_FEEDBACK_RECORDED");
  assert.equal(result.feedback.action, "ACCEPTED");
  assert.deepEqual(result.feedback.canonicalSourceReferences, [
    { type: "FINDING", id: findingId, version: 2 },
  ]);
  assert.equal(result.feedback.learningContext.learnedPatternIsCanonicalRule, false);
  assert.equal(result.canonicalMutationPerformed, false);
  const sql = fixture.calls.map(({ text }) => text).join("\n");
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:canonical_quotes|canonical_quote_issuances|canonical_quote_customer_decisions|canonical_evaluation_finding_versions|canonical_workstream_versions)/i);
});
