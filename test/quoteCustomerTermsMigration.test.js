"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const sql = readFileSync(
  new URL(
    "../migrations/202608230002_add_canonical_quote_customer_terms_snapshot.sql",
    `file://${__filename}`
  ),
  "utf8"
);

test("customer terms migration is the 51st additive migration", () => {
  const migrations = readdirSync(join(__dirname, "..", "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal(migrations.length, 58);
  assert.equal(
    migrations.at(-8),
    "202608230002_add_canonical_quote_customer_terms_snapshot.sql"
  );
});

test("migration adds one strict terms snapshot to canonical Quote versions", () => {
  assert.match(sql, /ALTER TABLE canonical_quote_versions[\s\S]*ADD COLUMN IF NOT EXISTS customer_terms_snapshot JSONB/i);
  assert.match(sql, /canonical_quote_customer_terms_snapshot_is_valid/i);
  assert.match(sql, /integrity_version IN \(1, 2\)/i);
  assert.match(sql, /integrity_version = 1 AND customer_terms_snapshot IS NULL/i);
  assert.match(sql, /integrity_version = 2[\s\S]*canonical_quote_customer_terms_snapshot_is_valid/i);
  for (const field of [
    "schemaVersion", "paymentTerms", "estimatedDuration", "customerNotes",
    "exclusions", "additionalWorkTerms", "hiddenConditionsTerms",
    "diagnosticTerms", "customerResponsibilities", "warrantyTerms",
    "cancellationTerms", "acceptanceTerms", "preauthorizedAdditionalWorkLimit",
  ]) assert.match(sql, new RegExp(`'${field}'`));
});

test("migration is additive and manufactures no history or competing authority", () => {
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\b/im);
  assert.doesNotMatch(sql, /CREATE TABLE/i);
  assert.doesNotMatch(sql, /canonical_quote_(?:approvals|acceptances)/i);
  assert.doesNotMatch(sql, /business_document_number|document_number/i);
  assert.doesNotMatch(sql, /DROP TRIGGER|DROP TABLE|DROP COLUMN/i);
  assert.doesNotMatch(sql, /(?:payment_state|lifecycle_state|schedule|issued_by_ai)/i);
});

test("migration preserves the existing append-only Quote history boundary", () => {
  assert.doesNotMatch(sql, /DISABLE TRIGGER|prevent_canonical_quote_history_mutation/i);
  assert.match(sql, /no historical|Historical v1 hashes remain/i);
});
