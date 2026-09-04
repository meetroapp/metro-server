"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migration = readFileSync(
  join(
    __dirname,
    "..",
    "migrations",
    "202609040001_add_evaluation_revision_authority.sql"
  ),
  "utf8"
);

test("Evaluation revision migration adds explicit command and evidence vocabulary", () => {
  assert.match(migration, /'evaluation\.revise'/);
  assert.match(migration, /'evaluation_revised'/);

  assert.match(
    migration,
    /commercial_command_idempotency_command_name_check/
  );
  assert.match(
    migration,
    /commercial_authority_evidence_evidence_type_check/
  );
  assert.match(
    migration,
    /commercial_authority_evidence_source_command_check/
  );
});

test("Evaluation revision migration does not rewrite lifecycle or commercial records", () => {
  assert.doesNotMatch(
    migration,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:canonical_evaluations|canonical_evaluation_versions|jobs|posts|request_relationships|canonical_quotes|canonical_invoices|canonical_visits|pre_work_deposit|payment)/i
  );

  assert.doesNotMatch(
    migration,
    /\b(?:DROP\s+TABLE|TRUNCATE)\b/i
  );
});

test("Evaluation revision migration preserves existing Evaluation status vocabulary", () => {
  assert.doesNotMatch(
    migration,
    /ALTER\s+TABLE\s+canonical_evaluations/i
  );

  assert.doesNotMatch(
    migration,
    /ALTER\s+TABLE\s+canonical_evaluation_versions/i
  );
});
