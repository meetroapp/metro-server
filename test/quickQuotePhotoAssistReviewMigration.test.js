"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  getMigrationFiles,
} = require("../scripts/run-migrations");

const migrationName =
  "202608180001_expand_ask_meetro_workflow_review_operations.sql";

const sql = readFileSync(
  join(
    __dirname,
    "..",
    "migrations",
    migrationName
  ),
  "utf8"
);

test(
  "migration 45 expands only the governed Ask Meetro review operation allowlist",
  () => {
    const migrations = getMigrationFiles();

    assert.equal(migrations.length, 45);
    assert.equal(
      migrations.at(-1).filename,
      migrationName
    );

    assert.match(
      sql,
      /ALTER TABLE intelligence_workflow_review_events/i
    );

    assert.match(
      sql,
      /quick_quote\.photo_assist/i
    );

    assert.match(
      sql,
      /intelligence_workflow_review_events_operation_type_check/i
    );

    assert.doesNotMatch(
      sql,
      /(?:^|\n)\s*(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE)\b/im
    );

    assert.doesNotMatch(
      sql,
      /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im
    );
  }
);

test(
  "migration 45 preserves advisory-only authority",
  () => {
    assert.doesNotMatch(
      sql,
      /INSERT INTO lifecycle_(?:capabilities|authority_grants)/i
    );

    assert.doesNotMatch(
      sql,
      /canonical_quotes|canonical_invoice_payments|portfolio_/i
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO (?:jobs|posts|canonical_quotes)/i
    );

    assert.match(
      sql,
      /grants no Quote, Job, Request/i
    );
  }
);
