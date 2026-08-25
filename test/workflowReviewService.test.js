"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  findElement,
  recordWorkflowReview,
} = require("../server/intelligence/workflowReviewService");

function reviewPool({ proposalId, elementId }) {
  const proposal = {
    draftPatch: {
      fields: [{
        path: elementId,
        value: "Accepted value",
        provenance: "assistant_suggested",
        requiresConfirmation: true,
      }],
    },
  };
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (String(sql).includes("intelligence_workflow_review:proposal")) {
        return {
          rows: [{
            id: proposalId,
            actor_user_id: 7,
            operation: "job_request.interpret",
            result_payload: proposal,
          }],
        };
      }
      if (String(sql).includes("intelligence_workflow_review:insert")) {
        return {
          rows: [{
            id: randomUUID(),
            operation_id: proposalId,
            operation_type: "job_request.interpret",
            proposal_element_id: values[4],
            action: values[5],
            edited_value: null,
            reason_category: null,
            created_at: "2026-08-25T12:00:00.000Z",
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  return {
    calls,
    connect: async () => client,
  };
}

test("Job Request review preserves exact camelCase proposal element identity", async (t) => {
  for (const elementId of [
    "location.affectedArea",
    "service.requestCategory",
    "details.additionalNotes",
  ]) {
    await t.test(elementId, async () => {
      const proposalId = randomUUID();
      const pool = reviewPool({ proposalId, elementId });
      const result = await recordWorkflowReview({
        pool,
        authenticatedActor: { id: 7 },
        proposalId,
        elementId,
        action: "ACCEPTED",
        idempotencyKey: randomUUID(),
      });

      assert.equal(result.ok, true);
      assert.equal(result.review.elementId, elementId);
      assert.equal(
        pool.calls.some(({ values }) => values.includes(elementId)),
        true
      );
    });
  }
});

test("non-Request workflow element lookup remains case-insensitive", () => {
  const element = { id: "customer_notes", text: "Thank you." };
  assert.equal(
    findElement({ customerNotes: element }, "invoice.assist", "CUSTOMER_NOTES"),
    element
  );
});
