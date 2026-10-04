"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const filename =
  "202608110001_create_request_modification_authority_foundation.sql";
const sql = readFileSync(join(root, "migrations", filename), "utf8");

test("request modification migration precedes Portfolio authority and remains additive", () => {
  const migrations = readdirSync(join(root, "migrations"))
    .filter((item) => item.endsWith(".sql"))
    .sort();
  const readme = readFileSync(join(root, "migrations", "README.md"), "utf8");

  const index = migrations.indexOf(filename);
  assert.equal(
    migrations[index + 1],
    "202608120001_create_business_portfolio_authority_foundation.sql"
  );
  assert.match(readme, new RegExp(filename.replaceAll(".", "\\.")));
  assert.doesNotMatch(sql, /\b(?:TRUNCATE|DELETE\s+FROM|DROP\s+TABLE)\b/i);
});

test("request version and photo evidence are constrained independently", () => {
  assert.match(
    sql,
    /ADD COLUMN IF NOT EXISTS modification_version INTEGER NOT NULL DEFAULT 1/i
  );
  assert.match(sql, /CHECK \(modification_version >= 1\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS request_photo_attachment_events/i);
  assert.match(sql, /FOREIGN KEY \(concern_id, request_id\)[\s\S]*REFERENCES reported_concerns\(id, job_request_id\)/i);
  assert.match(sql, /FOREIGN KEY \(job_id, request_id\)[\s\S]*REFERENCES jobs\(id, job_request_id\)/i);
  assert.match(sql, /public_id TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /UNIQUE \(actor_user_id, request_id, idempotency_key\)/i);
  assert.match(
    sql,
    /request_photo_attachment_events_append_only[\s\S]*BEFORE UPDATE OR DELETE/i
  );
});

test("migration creates no deferred contractual command authority", () => {
  assert.doesNotMatch(
    sql,
    /agreement_revision|change_order|supplemental_quote|lifecycle_capabilities/i
  );
});
