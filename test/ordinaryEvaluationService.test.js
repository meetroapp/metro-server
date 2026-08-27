"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  EVALUATION_COMPLETION_MODES,
  ORDINARY_EVALUATION_CAPABILITY,
  REMOTE_ASSESSMENT_METHODS,
  createOrdinaryJobEvaluation,
  validateCompletionContract,
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

test("remote completion contract requires explicit bounded professional assessment details", () => {
  for (const assessmentMethod of REMOTE_ASSESSMENT_METHODS) {
    assert.deepEqual(
      validateCompletionContract({
        completionMode: EVALUATION_COMPLETION_MODES.REMOTE,
        assessmentMethod,
        assessmentBasis: "  Professional reviewed the available evidence.  ",
      }),
      {
        completionMode: "REMOTE",
        assessmentMethod,
        assessmentBasis: "Professional reviewed the available evidence.",
      }
    );
  }
  assert.equal(
    validateCompletionContract({ completionMode: "REMOTE" }).error.code,
    "REMOTE_EVALUATION_METHOD_REQUIRED"
  );
  assert.equal(
    validateCompletionContract({
      completionMode: "REMOTE",
      assessmentMethod: "IN_PERSON",
      assessmentBasis: "Invalid method.",
    }).error.code,
    "INVALID_REMOTE_EVALUATION_METHOD"
  );
  for (const assessmentBasis of [null, "", "   "]) {
    assert.equal(
      validateCompletionContract({
        completionMode: "REMOTE",
        assessmentMethod: "PHONE",
        assessmentBasis,
      }).error.code,
      "REMOTE_EVALUATION_BASIS_REQUIRED"
    );
  }
  assert.equal(
    validateCompletionContract({
      completionMode: "REMOTE",
      assessmentMethod: "PHONE",
      assessmentBasis: "x".repeat(2001),
    }).error.code,
    "INVALID_REMOTE_EVALUATION_BASIS"
  );
  assert.equal(
    validateCompletionContract({ completionMode: "REMOTE_LIKE" }).error.code,
    "INVALID_EVALUATION_COMPLETION_MODE"
  );
  assert.equal(
    validateCompletionContract({
      assessmentMethod: "PHONE",
      assessmentBasis: "Do not infer remote mode.",
    }).error.code,
    "REMOTE_EVALUATION_DETAILS_NOT_ALLOWED"
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
