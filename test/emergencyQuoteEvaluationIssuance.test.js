"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const service = fs.readFileSync(
  require.resolve("../server/authorization/quoteDraftService"),
  "utf8"
);

const migration = fs.readFileSync(
  new URL(
    "../migrations/202609230001_link_quote_issuance_evaluation.sql",
    `file://${__filename}`
  ),
  "utf8"
);

test("Emergency Quote issuance requests the exact completed Evaluation evidence", () => {
  assert.match(
    service,
    /requireEmergencyJobEvaluation\(\{[\s\S]*?returnEvidence:\s*true/
  );

  assert.match(
    service,
    /emergencyEvaluationEvidence\s*=\s*evaluationRequirement/
  );
});

test("issued Quote persists exact Evaluation id and version", () => {
  assert.match(
    service,
    /INSERT INTO canonical_quote_issuances[\s\S]*?evaluation_id,\s*evaluation_version/
  );

  assert.match(
    service,
    /emergencyEvaluationEvidence\?\.id\s*\|\|\s*null/
  );

  assert.match(
    service,
    /emergencyEvaluationEvidence\?\.evaluation_version/
  );
});

test("Evaluation provenance migration is version-linked and Job-linked", () => {
  assert.match(
    migration,
    /FOREIGN KEY\s*\(\s*evaluation_id,\s*evaluation_version\s*\)[\s\S]*?REFERENCES canonical_evaluation_versions\s*\(\s*evaluation_id,\s*version\s*\)/i
  );

  assert.match(
    migration,
    /FOREIGN KEY\s*\(\s*evaluation_id,\s*job_id\s*\)[\s\S]*?REFERENCES canonical_evaluation_job_subjects\s*\(\s*evaluation_id,\s*job_id\s*\)/i
  );
});

test("Evaluation provenance is a reference, not duplicated narrative text", () => {
  assert.doesNotMatch(
    migration,
    /observations|diagnosis_summary|recommendation_text/i
  );
});
