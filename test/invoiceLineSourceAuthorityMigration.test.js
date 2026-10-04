"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const sql = readFileSync(join(
  __dirname,
  "..",
  "migrations",
  "202608290001_add_invoice_line_source_authority.sql"
), "utf8");

test("Migration 62 backfills historical Invoice lines as approved Quote scope", () => {
  assert.match(sql, /SET source_type = 'APPROVED_QUOTE_SCOPE'\s+WHERE source_type IS NULL/i);
  assert.match(sql, /ALTER COLUMN source_type SET NOT NULL/i);
  assert.doesNotMatch(sql, /UPDATE\s+(?:canonical_quotes|canonical_quote_versions|canonical_quote_customer_decisions)\b/i);
});

test("Migration 62 enforces the two truthful Invoice line source shapes", () => {
  assert.match(sql, /source_type IN \('APPROVED_QUOTE_SCOPE', 'EXTRA_WORK'\)/i);
  assert.match(sql, /source_type = 'APPROVED_QUOTE_SCOPE'[\s\S]*source_quote_id IS NOT NULL[\s\S]*source_quote_version IS NOT NULL[\s\S]*source_scope_item_id IS NOT NULL/i);
  assert.match(sql, /source_type = 'EXTRA_WORK'[\s\S]*source_quote_id IS NULL[\s\S]*source_quote_version IS NULL[\s\S]*source_scope_item_id IS NULL/i);
});

test("Migration 62 permits received pre-work money on a still-reviewable draft", () => {
  assert.match(sql, /DROP CONSTRAINT canonical_invoice_version_status_check/i);
  assert.match(sql, /status = 'DRAFT'/i);
  assert.match(sql, /status = 'PARTIALLY_PAID' AND paid_minor > 0 AND balance_minor > 0/i);
});
