"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  findElement,
  recordWorkflowReview,
} = require("../server/intelligence/workflowReviewService");

const CAPE_CORAL_PATHS = Object.freeze([
  "job.title",
  "job.description",
  "location.city",
  "timing.availability",
  "service.specialty",
  "location.affectedArea",
  "details.expectations",
  "details.additionalNotes",
]);

function reviewPool({ proposalId, elementIds = CAPE_CORAL_PATHS }) {
  const proposal = {
    draftPatch: {
      fields: elementIds.map((path) => ({
        path,
        value: "Accepted value",
        provenance: "assistant_suggested",
        requiresConfirmation: true,
      })),
    },
  };
  const calls = [];
  const reviews = [];
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
        const storedElementId = values[4];
        if (!/^[a-z][a-z0-9_.:-]{0,159}$/.test(storedElementId)) {
          const error = new Error(
            "violates check constraint intelligence_workflow_review_events_proposal_element_id_check"
          );
          error.code = "23514";
          throw error;
        }
        const existing = reviews.find((row) =>
          row.actor_user_id === values[3] &&
          row.operation_id === values[1] &&
          row.proposal_element_id === storedElementId &&
          row.idempotency_key === values[11]
        );
        if (existing) return { rows: [] };
        const row = {
          id: randomUUID(),
          operation_id: proposalId,
          operation_type: "job_request.interpret",
          actor_user_id: values[3],
          proposal_element_id: storedElementId,
          action: values[5],
          edited_value: null,
          reason_category: null,
          idempotency_key: values[11],
          request_fingerprint: values[12],
          created_at: "2026-08-25T12:00:00.000Z",
        };
        reviews.push(row);
        return {
          rows: [row],
        };
      }
      if (String(sql).includes("intelligence_workflow_review:replay")) {
        return {
          rows: reviews.filter((row) =>
            row.actor_user_id === values[0] &&
            row.operation_id === values[1] &&
            row.proposal_element_id === values[2] &&
            row.idempotency_key === values[3]
          ).slice(0, 1),
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  return {
    calls,
    reviews,
    connect: async () => client,
  };
}

test("the exact Cape Coral proposal records all eight operation-bound review elements", async () => {
  const proposalId = randomUUID();
  const pool = reviewPool({ proposalId });
  const keys = Object.fromEntries(CAPE_CORAL_PATHS.map((path) => [path, randomUUID()]));

  const results = await Promise.all(CAPE_CORAL_PATHS.map((elementId) =>
    recordWorkflowReview({
      pool,
      authenticatedActor: { id: 7 },
      proposalId,
      elementId,
      action: "ACCEPTED",
      idempotencyKey: keys[elementId],
    })
  ));

  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(
    results.map((result) => result.review.elementId),
    CAPE_CORAL_PATHS
  );
  assert.equal(pool.reviews.length, 8);
  assert.deepEqual(
    pool.reviews.map((row) => row.proposal_element_id),
    CAPE_CORAL_PATHS.map((path) => path.toLowerCase())
  );
});

test("partial ACCEPTED review persistence is retry-safe for the exact Cape Coral proposal", async () => {
  const proposalId = randomUUID();
  const pool = reviewPool({ proposalId });
  const keys = Object.fromEntries(CAPE_CORAL_PATHS.map((path) => [path, randomUUID()]));
  const previouslyRecorded = CAPE_CORAL_PATHS.filter((path) =>
    !["location.affectedArea", "details.additionalNotes"].includes(path)
  );
  const review = (elementId) => recordWorkflowReview({
        pool,
        authenticatedActor: { id: 7 },
        proposalId,
        elementId,
        action: "ACCEPTED",
        idempotencyKey: keys[elementId],
      });

  await Promise.all(previouslyRecorded.map(review));
  const retried = await Promise.all(CAPE_CORAL_PATHS.map(review));

  assert.equal(pool.reviews.length, 8);
  assert.equal(retried.filter((result) => result.replayed).length, 6);
  assert.equal(retried.filter((result) => !result.replayed).length, 2);
  assert.deepEqual(
    retried.map((result) => result.review.elementId),
    CAPE_CORAL_PATHS
  );
});

test("Job Request review rejects a forged or case-altered unproposed path", async () => {
  const proposalId = randomUUID();
  const pool = reviewPool({ proposalId });
  for (const elementId of ["location.affectedarea", "details.privateNotes"]) {
    const result = await recordWorkflowReview({
      pool,
      authenticatedActor: { id: 7 },
      proposalId,
      elementId,
      action: "ACCEPTED",
      idempotencyKey: randomUUID(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "INTELLIGENCE_REVIEW_ELEMENT_UNAVAILABLE");
  }
  assert.equal(pool.reviews.length, 0);
});

test("non-Request workflow element lookup remains case-insensitive", () => {
  const element = { id: "customer_notes", text: "Thank you." };
  assert.equal(
    findElement({ customerNotes: element }, "invoice.assist", "CUSTOMER_NOTES"),
    element
  );
});
