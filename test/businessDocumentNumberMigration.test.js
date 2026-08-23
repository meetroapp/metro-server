"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const sql = readFileSync(
  new URL("../migrations/202608230001_add_business_document_numbers.sql", `file://${__filename}`),
  "utf8"
);
test("business-document numbering migration defines explicit auditable sequence authority", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_document_number_sequences/);
  assert.match(sql, /PRIMARY KEY \(contractor_profile_id, document_type\)/);
  assert.match(sql, /document_type IN \('QUOTE', 'INVOICE'\)/);
  assert.match(sql, /number_prefix ~ '\^\[A-Z\]\{1,8\}\\?\$'/);
  assert.match(sql, /number_width SMALLINT NOT NULL/);
  assert.match(sql, /number_width BETWEEN 1 AND 12/);
  assert.match(sql, /initial_last_number BIGINT NOT NULL/);
  assert.match(sql, /last_number >= initial_last_number/);
  assert.match(sql, /999999999999/);
  assert.match(sql, /initialization_mode IN \('START_NEW', 'CONTINUE_EXISTING'\)/);
  assert.match(sql, /initialization_source = 'PROFESSIONAL_EXPLICIT'/);
  assert.match(sql, /initialized_by_user_id INTEGER NOT NULL/);
  assert.match(sql, /CONSTRAINT business_document_number_sequences_owner_fkey[\s\S]*FOREIGN KEY \(contractor_profile_id, initialized_by_user_id\)[\s\S]*REFERENCES contractor_profiles\(id, user_id\)[\s\S]*ON DELETE RESTRICT/);
  assert.match(sql, /initialized_at TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /first_allocated_at TIMESTAMPTZ/);
  assert.match(sql, /updated_at TIMESTAMPTZ NOT NULL/);
});

test("legacy numbers remain nullable with scoped partial uniqueness and database immutability", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS document_number TEXT/);
  assert.doesNotMatch(sql, /ALTER COLUMN document_number SET NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS business_document_working_drafts_number_idx[\s\S]*contractor_profile_id,[\s\S]*document_type,[\s\S]*document_number[\s\S]*WHERE document_number IS NOT NULL/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION preserve_business_document_number\(\)/);
  assert.match(sql, /CREATE TRIGGER preserve_business_document_number_trigger/);
  assert.match(sql, /BEFORE UPDATE OF document_number ON business_document_working_drafts/);
  assert.match(sql, /OLD\.document_number IS NOT NULL[\s\S]*NEW\.document_number IS DISTINCT FROM OLD\.document_number/);
  assert.match(sql, /ERRCODE = '23514'/);
});

test("numbering migration makes no historical guess or canonical lifecycle mutation", () => {
  assert.doesNotMatch(sql, /ROW_NUMBER\s*\(/i);
  assert.doesNotMatch(sql, /COUNT\s*\(/i);
  assert.doesNotMatch(sql, /UPDATE\s+business_document_working_drafts\b/i);
  assert.doesNotMatch(sql, /INSERT INTO\s+business_document_working_drafts\b/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(sql, /(?:UPDATE|INSERT INTO|ALTER TABLE)\s+(?:quotes|canonical_quotes|canonical_invoices|invoice_payments|jobs)\b/i);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|ALTER TABLE)\s+(?:quote_decisions|lifecycle_authority\w*|job_lifecycle\w*|\w*payment\w*)\b/i);
  assert.doesNotMatch(sql, /\bBG\b|business_name|contractor_profile_id\s*=\s*6/i);
});
