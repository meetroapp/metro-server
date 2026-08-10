"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  FINDING_CAPABILITIES,
  FINDING_COMMANDS,
  FINDING_EVIDENCE_TYPES,
  FINDING_RELATIONSHIPS,
  addFindingEvidenceReference,
  confirmFinding,
  submitFinding,
} = require("../server/authorization/findingService");

test("Finding authority exposes only submit and confirm capabilities", () => {
  assert.deepEqual(FINDING_CAPABILITIES, {
    SUBMIT: "finding.submit",
    CONFIRM: "finding.confirm",
  });
  assert.equal(Object.values(FINDING_CAPABILITIES).some((value) =>
    /resolve|quote|work|recommend/i.test(value)
  ), false);
});

test("Finding commands are explicit and subordinate to the Evaluation aggregate", () => {
  assert.deepEqual(Object.values(FINDING_COMMANDS).sort(), [
    "finding.concern.link",
    "finding.confirm",
    "finding.evidence.add",
    "finding.submit",
  ]);
  assert.deepEqual(FINDING_RELATIONSHIPS, [
    "EXPLAINS",
    "RELATED",
    "CONTRADICTS",
  ]);
  assert.ok(FINDING_EVIDENCE_TYPES.includes("PROFESSIONAL_OBSERVATION"));
});

test("invalid Finding inputs fail before database access", async () => {
  let touched = false;
  const pool = {
    query() { touched = true; throw new Error("database should not be reached"); },
    connect() { touched = true; throw new Error("database should not be reached"); },
  };
  const base = {
    pool,
    authenticatedActor: { id: 9 },
    idempotencyKey: "finding-command-key",
  };
  const invalidSubmit = await submitFinding({
    ...base,
    evaluationId: "not-an-evaluation",
    statement: "Finding statement",
  });
  assert.equal(invalidSubmit.code, "INVALID_EVALUATION_ID");
  const invalidEvidence = await addFindingEvidenceReference({
    ...base,
    findingId: "not-a-finding",
    evidenceType: "ARBITRARY",
    referenceNamespace: "evaluation.observation",
    referenceId: "observation-1",
  });
  assert.equal(invalidEvidence.code, "INVALID_FINDING_EVIDENCE");
  const invalidConfirmation = await confirmFinding({
    ...base,
    findingId: "not-a-finding",
    expectedVersion: 1,
  });
  assert.equal(invalidConfirmation.code, "INVALID_FINDING_CONFIRMATION");
  assert.equal(touched, false);
});

test("Finding runtime has no update-in-place, resolution, downstream, or source-domain writes", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "authorization", "findingService.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /UPDATE\s+canonical_evaluation_finding/i);
  assert.doesNotMatch(
    source,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:reported_concerns|workstreams|recommendations|canonical_quotes|quotes|workflow_events)/i
  );
  assert.doesNotMatch(source, /resolution_state\s*=\s*'RESOLVED'/i);
});
