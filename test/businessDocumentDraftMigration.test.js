"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const sql = readFileSync(new URL("../migrations/202608210001_create_business_document_working_drafts.sql", `file://${__filename}`), "utf8");

test("working-draft migration is additive, noncanonical, versioned, and idempotent", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_document_working_drafts/);
  assert.match(sql, /draft_status TEXT NOT NULL DEFAULT 'WORKING_DRAFT'/);
  assert.match(sql, /version INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql, /business_document_draft_commands/);
  assert.match(sql, /UNIQUE \(actor_user_id, operation, idempotency_key\)/);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(sql, /contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles\(id\)/);
  assert.match(sql, /created_by_user_id INTEGER NOT NULL REFERENCES users\(id\)/);
  assert.match(sql, /actor_user_id INTEGER NOT NULL REFERENCES users\(id\)/);
  assert.doesNotMatch(sql, /(?:contractor_profile_id|created_by_user_id|uploaded_by_user_id|actor_user_id) BIGINT/);
  assert.doesNotMatch(sql, /UPDATE\s+(quotes|canonical_quotes|invoice_payments|jobs)\b/i);
  assert.doesNotMatch(sql, /INSERT INTO\s+(quotes|canonical_quotes|invoice_payments|jobs)\b/i);
});

test("photo role and customer visibility are independent governed columns", () => {
  const roleColumn = sql.match(/role TEXT NOT NULL DEFAULT 'UNCLASSIFIED'\s+CHECK \(role IN \(([^)]+)\)\)/)?.[0] || "";
  const visibilityColumn = sql.match(/visibility TEXT NOT NULL DEFAULT 'PRIVATE_INTERNAL'\s+CHECK \(visibility IN \(([^)]+)\)\)/)?.[0] || "";
  assert.match(roleColumn, /'BEFORE', 'AFTER'/);
  assert.doesNotMatch(roleColumn, /CUSTOMER_VISIBLE/);
  assert.match(visibilityColumn, /'PRIVATE_INTERNAL', 'CUSTOMER_VISIBLE'/);
  assert.doesNotMatch(visibilityColumn, /BEFORE|AFTER/);
});
