"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  "202608290003_add_canonical_alert_event_identity.sql"
);

test("migration 64 adds nullable permanent recipient-event identity and exact B1 destinations", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /ADD COLUMN IF NOT EXISTS canonical_event_key TEXT/);
  assert.match(sql, /canonical_event_key IS NULL/);
  assert.match(sql, /UNIQUE INDEX IF NOT EXISTS alerts_recipient_event_identity_uidx/);
  assert.match(sql, /ON alerts \(recipient_user_id, canonical_event_key\)/);
  assert.match(sql, /WHERE canonical_event_key IS NOT NULL/);
  for (const destination of ["job", "visit", "quote", "invoice"]) {
    assert.match(sql, new RegExp(`'${destination}'`));
  }
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)\b/i);
});
