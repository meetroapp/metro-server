"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName = "202608150004_create_canonical_invoice_payment_foundation.sql";
const sql = readFileSync(join(__dirname, "..", "migrations", migrationName), "utf8");

test("migration 43 is the additive Invoice and offline Payment foundation", () => {
  const migrations = getMigrationFiles();
  assert.equal(migrations.length, 50);
  assert.equal(migrations[42].filename, migrationName);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
});
test("Invoice truth is versioned and exact-Job scoped", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_invoices/i);
  assert.match(sql, /job_id UUID NOT NULL UNIQUE/i);
  assert.match(sql, /REFERENCES jobs\(id, job_request_id, source_request_relationship_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_invoice_versions/i);
  assert.match(sql, /status IN \('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID'\)/i);
  assert.match(sql, /total_minor = paid_minor \+ balance_minor/i);
  assert.match(sql, /canonical_invoice_versions_append_only/i);
});

test("Invoice lines preserve approved Quote lineage without tax invention", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_invoice_line_item_snapshots/i);
  assert.match(sql, /lineage_label IN \('ORIGINAL', 'REVISED', 'ADDITIONAL'\)/i);
  assert.match(sql, /REFERENCES canonical_quote_scope_item_snapshots/i);
  assert.match(sql, /total_minor BIGINT NOT NULL CHECK \(total_minor = subtotal_minor\)/i);
  assert.doesNotMatch(sql, /tax_(?:rate|amount)|discount_(?:rate|amount)/i);
});

test("Payment evidence is append-only, offline, and balance bounded", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_invoice_payments/i);
  assert.match(sql, /method IN \('CASH', 'CHECK', 'BANK_TRANSFER', 'OTHER'\)/i);
  assert.match(sql, /canonical_invoice_payments_append_only/i);
  assert.doesNotMatch(sql, /stripe|paypal|card_token|bank_account_token/i);
});

test("Invoice delivery is a separate exact Conversation message authority", () => {
  assert.match(sql, /message_type = 'invoice_shared'/i);
  assert.match(sql, /workflow_type = 'INVOICE_SHARED'/i);
  assert.match(sql, /FOREIGN KEY \(invoice_id, job_id\)[\s\S]*REFERENCES canonical_invoices\(id, job_id\)/i);
  assert.match(sql, /ON messages\(sender_id, invoice_id, invoice_delivery_idempotency_key\)/i);
});
