"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
  EVALUATION_VISIT_AUTHORITY_SOURCE,
  PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
  activateEvaluationVisitAuthority,
  evaluationVisitServiceInternals,
} = require("../server/workflow/evaluationVisitService");

const source = readFileSync(
  join(__dirname, "..", "server", "workflow", "evaluationVisitService.js"),
  "utf8"
);

test("Evaluation Visit activation grants the exact approved role matrices", () => {
  assert.deepEqual(CUSTOMER_EVALUATION_VISIT_CAPABILITIES, [
    "visit.read",
    "visit.confirm",
    "visit.change_request",
  ]);
  assert.deepEqual(PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES, [
    "visit.read",
    "visit.propose",
    "visit.reschedule",
    "visit.cancel",
    "visit.complete",
  ]);
  assert.equal(EVALUATION_VISIT_AUTHORITY_SOURCE,
    "CANONICAL_EVALUATION_VISIT_AUTHORITY");
  assert.equal(PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES.includes("visit.confirm"), false);
  assert.equal(CUSTOMER_EVALUATION_VISIT_CAPABILITIES.includes("visit.cancel"), false);
});

test("authority projection is allowlisted and cannot fabricate unavailable grants", () => {
  const context = {
    job_id: "job",
    evaluation_id: "evaluation",
    evaluation_status: "draft",
    customer_participant_id: "customer",
    professional_participant_id: "professional",
    future_sentinel: "must-not-leak",
  };
  const grants = [
    ...CUSTOMER_EVALUATION_VISIT_CAPABILITIES.map((capability) => ({
      grantee_participant_id: "customer",
      capability,
      stored_secret: "must-not-leak",
    })),
    ...PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES.map((capability) => ({
      grantee_participant_id: "professional",
      capability,
      stored_secret: "must-not-leak",
    })),
    { grantee_participant_id: "customer", capability: "visit.complete" },
  ];
  const result = evaluationVisitServiceInternals.authorityProjection(
    context,
    { created_at: "2026-08-13T12:00:00.000Z" },
    grants
  );
  assert.deepEqual(Object.keys(result.authority), [
    "authoritySource",
    "jobId",
    "evaluationId",
    "purpose",
    "state",
    "activatedAt",
    "customerCapabilities",
    "professionalCapabilities",
    "actions",
  ]);
  assert.equal(result.authority.state, "ACTIVE");
  assert.deepEqual(
    result.authority.customerCapabilities,
    CUSTOMER_EVALUATION_VISIT_CAPABILITIES
  );
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("browser-owned activation authority fields fail before database access", async () => {
  const result = await activateEvaluationVisitAuthority({
    pool: { query() { throw new Error("database must not be reached"); } },
    authenticatedActor: { id: 7 },
    jobId: "00000000-0000-4000-8000-000000000001",
    evaluationId: "00000000-0000-4000-8000-000000000002",
    idempotencyKey: "activation-key",
    capabilities: ["visit.complete"],
  });
  assert.equal(result.code, "EVALUATION_VISIT_AUTHORITY_FIELD_REJECTED");
});

test("activation source cannot mutate adjacent lifecycle aggregates", () => {
  assert.doesNotMatch(
    source,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:canonical_evaluations|canonical_evaluation_versions|canonical_evaluation_findings|canonical_recommendations|canonical_quotes|canonical_workstreams|canonical_work_activity_versions|jobs|posts|workflow_events)/i
  );
  assert.doesNotMatch(source, /(?:APPROVED_WORK|FOLLOW_UP|invoice\.|job\.complete)/i);
  assert.match(source, /scope_type = 'evaluation'/i);
  assert.match(source, /scope_evaluation_id = \$2/i);
});
