"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName = "202608150005_create_ask_meetro_workflow_review.sql";
const sql = readFileSync(join(__dirname, "..", "migrations", migrationName), "utf8");

test("migration 44 is additive, replay-safe, append-only review evidence", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300005_create_business_team_membership_authority.sql");

  const migrationIndex =
    migrations.findIndex(
      (migration) =>
        migration.filename === migrationName
    );

  assert.ok(
    migrationIndex >= 0,
    "migration 44 must remain inventoried"
  );

  assert.equal(
    migrations[migrationIndex + 1]?.filename,
    "202608180001_expand_ask_meetro_workflow_review_operations.sql"
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS intelligence_workflow_review_events/i);
  assert.match(sql, /action IN \('ACCEPTED', 'EDITED', 'REJECTED'\)/i);
  assert.match(sql, /prevent_lifecycle_append_only_mutation/i);
  assert.doesNotMatch(sql, /(?:^|\n)\s*(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE)\b/im);
});

test("migration 44 grants no Quote, lifecycle, Payment, or Portfolio authority", () => {
  assert.doesNotMatch(sql, /INSERT INTO lifecycle_(?:capabilities|authority_grants)/i);
  assert.doesNotMatch(sql, /canonical_quotes|canonical_invoice_payments|portfolio_/i);
  assert.match(sql, /learnedPatternIsCanonicalRule remains false/i);
});
