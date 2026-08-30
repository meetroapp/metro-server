"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const migrationName = "202608100004_create_quote_composition_feedback.sql";
const sql = readFileSync(join(root, "migrations", migrationName), "utf8");

test("migration 33 is additive, append-only, and advisory-only", () => {
  const migrations = readdirSync(join(root, "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300009_add_business_time_settings_authority.sql");
  const index = migrations.indexOf(migrationName);
  assert.equal(migrations[index - 1], "202608100003_create_canonical_quote_scope_foundation.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS intelligence_quote_composition_feedback/i);
  assert.match(sql, /action IN \('ACCEPTED', 'EDITED', 'REJECTED'\)/i);
  assert.match(sql, /proposal_id = operation_id/i);
  assert.match(sql, /prevent_lifecycle_append_only_mutation/i);
  assert.doesNotMatch(sql, /(?:^|\n)\s*(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE)\b/im);
  assert.doesNotMatch(sql, /canonical_quotes|canonical_quote_issuances|canonical_quote_customer_decisions/i);
});

test("migration 33 checksum is stable and feedback grants no lifecycle capability", () => {
  assert.match(createHash("sha256").update(sql).digest("hex"), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(sql, /INSERT INTO lifecycle_capabilities/i);
  assert.doesNotMatch(sql, /quote\.issue|quote\.approve|quote\.decline|payment|schedul/i);
});
