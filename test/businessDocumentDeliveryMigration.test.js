"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const sql = readFileSync(new URL("../migrations/202608210002_create_business_document_delivery_foundation.sql", `file://${__filename}`), "utf8");

test("business-document delivery migration is additive, version-bound, and noncanonical", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_document_delivery_events/i);
  assert.match(sql, /source_document_id UUID NOT NULL/i);
  assert.match(sql, /document_version INTEGER NOT NULL CHECK \(document_version > 0\)/i);
  assert.match(sql, /channel IN \('EMAIL', 'MEETRO_MESSAGE'\)/i);
  assert.match(sql, /customer_document_snapshot JSONB NOT NULL/i);
  assert.match(sql, /UNIQUE \(actor_user_id, channel, idempotency_key\)/i);
  assert.match(sql, /ON DELETE SET NULL/i);
  assert.doesNotMatch(sql, /DROP|TRUNCATE|DELETE FROM|UPDATE canonical_|ALTER TABLE canonical_/i);
  assert.match(sql, /never issue, accept, pay, or close/i);
});
