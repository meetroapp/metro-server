"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationFilename =
  "202609210001_add_emergency_available_now_direct_select_authority.sql";

const sql = readFileSync(
  join(__dirname, "..", "migrations", migrationFilename),
  "utf8"
);

test("105 adds explicit Emergency-only relationship provenance", () => {
  assert.match(
    sql,
    /ADD COLUMN IF NOT EXISTS emergency_authority_source TEXT/i
  );

  assert.match(
    sql,
    /emergency_authority_source = 'professional_response'/i
  );

  assert.match(
    sql,
    /emergency_authority_source =\s*'available_now_direct_select'/i
  );
});

test("105 truthfully backfills only pre-existing Emergency relationships", () => {
  assert.match(
    sql,
    /UPDATE request_relationships\s+SET emergency_authority_source = 'professional_response'\s+WHERE emergency_request_id IS NOT NULL\s+AND emergency_authority_source IS NULL/i
  );

  assert.doesNotMatch(
    sql,
    /UPDATE\s+(?:emergency_requests|conversations|jobs|contractor_profiles)/i
  );
});

test("105 permits NULL responded_at only for direct-selected Emergency authority", () => {
  assert.match(
    sql,
    /ALTER COLUMN responded_at DROP NOT NULL/i
  );

  assert.match(
    sql,
    /emergency_request_id IS NULL\s+AND emergency_authority_source IS NULL\s+AND responded_at IS NOT NULL/i
  );

  assert.match(
    sql,
    /emergency_authority_source = 'professional_response'\s+AND responded_at IS NOT NULL/i
  );

  assert.match(
    sql,
    /emergency_authority_source =\s*'available_now_direct_select'\s+AND responded_at IS NULL\s+AND status IN \('active', 'closed'\)/i
  );
});

test("105 preserves compatibility with the pre-105 Emergency response runtime", () => {
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION\s+normalize_emergency_relationship_authority_source/i
  );

  assert.match(
    sql,
    /NEW\.emergency_request_id IS NOT NULL[\s\S]*NEW\.emergency_authority_source IS NULL[\s\S]*NEW\.responded_at IS NOT NULL[\s\S]*NEW\.emergency_authority_source := 'professional_response'/i
  );

  assert.match(
    sql,
    /BEFORE INSERT ON request_relationships/i
  );
});

test("105 does not create parallel Emergency lifecycle authority", () => {
  assert.doesNotMatch(
    sql,
    /CREATE TABLE|INSERT INTO|DELETE FROM|TRUNCATE/i
  );

  assert.doesNotMatch(
    sql,
    /ALTER TABLE\s+(?:emergency_requests|conversations|jobs|contractor_profiles)/i
  );

  assert.doesNotMatch(
    sql,
    /ordinary_authority_source\s*=|professional_response_id\s*=/i
  );
});

test("105 leaves transaction control to the governed migration runner", () => {
  assert.doesNotMatch(
    sql,
    /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im
  );
});

test("105 is not added to the frozen production Emergency runner or inspector", () => {
  const runner = readFileSync(
    join(
      __dirname,
      "..",
      "scripts",
      "run-production-emergency-migrations.js"
    ),
    "utf8"
  );

  const inspector = readFileSync(
    join(
      __dirname,
      "..",
      "scripts",
      "inspect-production-emergency-migrations.js"
    ),
    "utf8"
  );

  assert.doesNotMatch(
    runner,
    new RegExp(migrationFilename.replaceAll(".", "[.]"))
  );

  assert.doesNotMatch(
    inspector,
    new RegExp(migrationFilename.replaceAll(".", "[.]"))
  );
});

test("105 is registered as the governed repository latest migration", () => {
  const readme = readFileSync(
    join(__dirname, "..", "migrations", "README.md"),
    "utf8"
  );

  assert.match(
    readme,
    new RegExp(migrationFilename.replaceAll(".", "[.]"))
  );
});

test("105 flushes deployed deferred relationship triggers before later table DDL", () => {
  const backfill =
    sql.indexOf("UPDATE request_relationships");

  const flush =
    sql.indexOf("SET CONSTRAINTS ALL IMMEDIATE");

  const laterAlter =
    sql.indexOf(
      "ALTER TABLE request_relationships\n  ALTER COLUMN responded_at DROP NOT NULL"
    );

  assert.ok(backfill >= 0);
  assert.ok(flush > backfill);
  assert.ok(laterAlter > flush);

  assert.match(
    sql,
    /UPDATE request_relationships[\s\S]*SET CONSTRAINTS ALL IMMEDIATE;[\s\S]*ALTER TABLE request_relationships\s+ALTER COLUMN responded_at DROP NOT NULL/i
  );
});
