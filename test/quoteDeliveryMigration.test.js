"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName = "202608140001_create_canonical_quote_delivery_foundation.sql";
const sql = readFileSync(join(__dirname, "..", "migrations", migrationName), "utf8");

test("Quote delivery is the single additive migration after the certified baseline", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300005_create_business_team_membership_authority.sql");
  assert.ok(migrations.some((migration) => migration.filename === migrationName));
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
});

test("Quote delivery binds exact Quote and Job identity to a structured message", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS quote_id UUID/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS job_id UUID/i);
  assert.match(sql, /FOREIGN KEY \(quote_id, job_id\)[\s\S]*REFERENCES canonical_quotes\(id, job_id\)/i);
  assert.match(sql, /message_type = 'quote_shared'/i);
  assert.match(sql, /workflow_type = 'QUOTE_SHARED'/i);
  assert.match(sql, /workflow_status = 'SENT'/i);
  assert.match(sql, /conversation_id IS NOT NULL/i);
  assert.match(sql, /quote_request_id IS NULL/i);
});

test("Quote delivery idempotency is actor, Quote, and command-key scoped", () => {
  assert.match(sql, /delivery_idempotency_key TEXT/i);
  assert.match(sql, /delivery_request_fingerprint TEXT/i);
  assert.match(sql, /delivery_request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /ON messages\(sender_id, quote_id, delivery_idempotency_key\)/i);
  assert.match(sql, /WHERE message_type = 'quote_shared'/i);
});

test("ordinary message rows remain valid without Quote delivery identity", () => {
  assert.match(sql, /message_type <> 'quote_shared'[\s\S]*quote_id IS NULL[\s\S]*job_id IS NULL/i);
  assert.doesNotMatch(sql, /ALTER COLUMN (?:quote_request_id|conversation_id|message_type) SET NOT NULL/i);
});
