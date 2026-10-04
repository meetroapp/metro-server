"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getCustomerEfr } = require("../server/authorization/customerEfrService");

const JOB_ID = "00000000-0000-4000-8000-000000000001";

function poolForProjection() {
  let read = 0;
  return {
    async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
      read += 1;
      if (read === 1) {
        return { rows: [{
          job_id: JOB_ID,
          job_request_id: 14,
          relationship_id: 340,
          relationship_status: "active",
          actor_participant_id: "participant-1",
          actor_is_customer_representative: true,
          can_read_job_participants: true,
        }] };
      }
      if (read === 2) {
        return { rows: [{
          id: "evaluation-1",
          status: "completed",
          completed_at: "2026-08-15T12:00:00.000Z",
          created_at: "2026-08-15T10:00:00.000Z",
          updated_at: "2026-08-15T12:00:00.000Z",
          internal_notes: "sentinel-internal-notes",
        }] };
      }
      if (read === 3) {
        return { rows: [{
          id: "finding-1",
          statement: "Drainage requires attention.",
          resolution_state: "OPEN",
          created_at: "2026-08-15T12:10:00.000Z",
          updated_at: "2026-08-15T12:10:00.000Z",
          integrity_hash: "sentinel-hash",
          customer_visible: true,
        }] };
      }
      return { rows: [{
        id: "recommendation-1",
        finding_id: "finding-1",
        statement: "Replace the failed drainage component.",
        status: "ACTIVE",
        created_at: "2026-08-15T12:20:00.000Z",
        updated_at: "2026-08-15T12:20:00.000Z",
        internal_cost: 99,
        margin: 0.5,
        idempotency_key: "sentinel-key",
      }] };
    },
  };
}

test("customer EFR projection allowlists concise business-safe truth", async () => {
  const result = await getCustomerEfr({
    pool: poolForProjection(),
    authenticatedActor: { id: 8 },
    jobId: JOB_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.projectAssessment.evaluation.status, "COMPLETE");
  assert.equal(result.projectAssessment.findings[0].state, "NEEDS_ATTENTION");
  assert.equal(result.projectAssessment.recommendations[0].state, "RECOMMENDED");
  const serialized = JSON.stringify(result.projectAssessment);
  assert.doesNotMatch(serialized, /sentinel|internal|margin|hash|idempotency|customerVisible|version/i);
});

test("customer EFR source requires explicit visibility and confirmed Finding truth", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "authorization", "customerEfrService.js"),
    "utf8"
  );
  assert.match(source, /current\.confirmation_state = 'CONFIRMED'/i);
  assert.equal((source.match(/current\.customer_visible = TRUE/gi) || []).length, 2);
  assert.match(source, /roles\.role = 'CUSTOMER_REPRESENTATIVE'/i);
  assert.match(source, /grants\.capability = 'participant\.read'/i);
  assert.doesNotMatch(source, /SELECT \*/i);
});
