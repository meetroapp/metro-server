"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationName =
  "202608230003_create_canonical_quote_business_document_sources.sql";
const sql = readFileSync(
  join(__dirname, "..", "migrations", migrationName),
  "utf8"
);

test("working-Quote bridge migration is the 52nd additive migration", () => {
  const migrations = readdirSync(join(__dirname, "..", "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300009_add_business_time_settings_authority.sql");
  assert.equal(migrations.at(-22), migrationName);
});

test("bridge provenance is one-to-one, business-owned, numbered, and hash-bound", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_quote_business_document_sources/);
  assert.match(sql, /quote_id UUID PRIMARY KEY/);
  assert.match(sql, /source_document_id UUID NOT NULL UNIQUE/);
  assert.match(sql, /source_document_version INTEGER NOT NULL[\s\S]*source_document_version > 0/);
  assert.match(sql, /document_number ~ '\^\[A-Z\]\{1,8\}-\[0-9\]\{1,12\}\$'/);
  assert.match(sql, /source_snapshot_integrity_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /UNIQUE \(contractor_profile_id, document_number\)/);
  assert.match(sql, /FOREIGN KEY \(quote_id, job_id\)[\s\S]*REFERENCES canonical_quotes\(id, job_id\)[\s\S]*ON DELETE RESTRICT/);
  assert.match(sql, /FOREIGN KEY \(contractor_profile_id, created_by_user_id\)[\s\S]*REFERENCES contractor_profiles\(id, user_id\)[\s\S]*ON DELETE RESTRICT/);
});

test("bridge provenance is append-only and survives private-draft unavailability", () => {
  assert.match(sql, /canonical_quote_business_document_sources_append_only/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON canonical_quote_business_document_sources/);
  assert.match(sql, /prevent_canonical_quote_history_mutation\(\)/);
  assert.doesNotMatch(
    sql,
    /FOREIGN KEY\s*\(source_document_id\)[\s\S]*business_document_working_drafts/i
  );
  assert.match(sql, /Deliberately not foreign-keyed/i);
});

test("bridge migration registers only the explicit Draft import command", () => {
  assert.match(sql, /quote\.draft\.import_business_document/);
  assert.doesNotMatch(sql, /quote\.customer\.(?:approve|decline)'\s*,?\s*'quote\.draft\.import_business_document/);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*(?:approval|acceptance|payment|schedule)/i);
});

test("bridge migration performs no allocation, backfill, or lifecycle mutation", () => {
  assert.doesNotMatch(sql, /business_document_number_sequences/);
  assert.doesNotMatch(sql, /UPDATE\s+business_document_working_drafts/i);
  assert.doesNotMatch(sql, /INSERT INTO\s+(?:canonical_quotes|canonical_quote_versions|canonical_quote_issuances|canonical_quote_customer_decisions|jobs)/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});
