"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  ORDINARY_EVALUATION_CAPABILITY,
  createOrdinaryJobEvaluation,
  validateOrdinaryCompletionContent,
  validateOrdinaryEvaluationContent,
  validateEvaluationContent,
} = require("../server/authorization/evaluationService");

function content(overrides = {}) {
  return validateEvaluationContent({
    observations: "Inspected the appliance and drain connection.",
    measurements: [],
    findings: [],
    diagnosisSummary: "",
    limitations: "",
    scopeRecommendations: [],
    relevantConditions: [],
    supportingMediaReferences: [],
    internalNotes: "",
    ...overrides,
  }).content;
}

test("ordinary Evaluation uses one explicit lifecycle capability", () => {
  assert.equal(ORDINARY_EVALUATION_CAPABILITY, "evaluation.perform");
});

test("ordinary Evaluation content cannot create Finding or Recommendation authority", () => {
  assert.equal(validateOrdinaryEvaluationContent(content()), null);
  assert.equal(
    validateOrdinaryEvaluationContent(content({
      findings: [{ summary: "Browser finding", severity: "low" }],
    })).code,
    "ORDINARY_EVALUATION_DOWNSTREAM_AUTHORITY_UNAVAILABLE"
  );
  assert.equal(
    validateOrdinaryEvaluationContent(content({
      scopeRecommendations: ["Issue a quote"],
    })).code,
    "ORDINARY_EVALUATION_DOWNSTREAM_AUTHORITY_UNAVAILABLE"
  );
});

test("ordinary confirmation requires observations without requiring deferred domains", () => {
  assert.equal(validateOrdinaryCompletionContent(content()), null);
  assert.equal(
    validateOrdinaryCompletionContent(content({ observations: "" })).code,
    "EVALUATION_INCOMPLETE"
  );
});

test("invalid ordinary commands fail before database access", async () => {
  let touched = false;
  const pool = {
    async connect() {
      touched = true;
      throw new Error("database should not be reached");
    },
  };
  const result = await createOrdinaryJobEvaluation({
    pool,
    authenticatedActor: { id: 8 },
    jobId: "not-a-job",
    content: content(),
    expectedVersion: 0,
    idempotencyKey: "ordinary-invalid-job",
  });
  assert.equal(result.code, "INVALID_JOB_ID");
  assert.equal(touched, false);
});

test("ordinary Evaluation service has no first-class Finding, Quote, Workstream, or Recommendation writes", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "authorization", "evaluationService.js"),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /INSERT INTO\s+(?:canonical_evaluation_findings|canonical_evaluation_finding_versions|canonical_finding_concern_links|canonical_quotes|workstreams|recommendations)/i
  );
});
