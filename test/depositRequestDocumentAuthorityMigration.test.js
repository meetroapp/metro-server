"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const sql = readFileSync(join(
  __dirname,
  "..",
  "migrations",
  "202608290002_add_deposit_request_document_authority.sql"
), "utf8");

test("Migration 63 adds only an exact Deposit Request requirement binding", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS payment_requirement_id UUID/i);
  assert.match(sql, /FOREIGN KEY \(payment_requirement_id, job_id\)[\s\S]*canonical_pre_work_deposit_obligations\(id, job_id\)/i);
  assert.match(sql, /document_type = 'DEPOSIT_REQUEST'[\s\S]*payment_requirement_id IS NOT NULL[\s\S]*document_number IS NULL/i);
  assert.match(sql, /WHERE document_type = 'DEPOSIT_REQUEST'/i);
  assert.doesNotMatch(sql, /INSERT INTO\s+(?:canonical_pre_work_deposit|business_document_delivery_events|messages|canonical_invoices)/i);
});

test("Migration 63 preserves Quote and Invoice identity while extending governed delivery", () => {
  assert.match(sql, /document_type IN \('QUOTE', 'INVOICE', 'DEPOSIT_REQUEST'\)/i);
  assert.match(sql, /document_type IN \('QUOTE', 'INVOICE'\)[\s\S]*payment_requirement_id IS NULL/i);
  assert.match(sql, /ALTER TABLE business_document_delivery_events[\s\S]*'DEPOSIT_REQUEST'/i);
});
