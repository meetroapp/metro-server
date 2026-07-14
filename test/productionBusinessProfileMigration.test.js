"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const migration = require("../scripts/apply-production-business-profile-details");

const SAFE_ENV = Object.freeze({
  DATABASE_URL: "postgresql://user:secret@postgres.railway.internal/railway",
  MIGRATION_TARGET: "production",
  CONFIRM_MIGRATION_TARGET: "production",
  ALLOW_PRODUCTION_BUSINESS_PROFILE_MIGRATION: "true",
  CONFIRM_PRODUCTION_BUSINESS_PROFILE: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
});
const SAFE_ARGS = Object.freeze([migration.CONFIRMATION_FLAG, migration.MIGRATION_ARG]);

function createClient({ column = null, count = 3, failAlter = false, ledger = null } = {}) {
  const calls = [];
  let currentColumn = column;
  let currentLedger = ledger;
  return {
    calls,
    async query(sql, values) {
      const source = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: source, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(source) || source.startsWith("SET LOCAL")) {
        return { rows: [] };
      }
      if (source.includes("to_regclass('public.contractor_profiles')")) {
        return { rows: [{ table_exists: true }] };
      }
      if (source.includes("information_schema.columns")) {
        return { rows: currentColumn ? [currentColumn] : [] };
      }
      if (source === "SELECT COUNT(*)::bigint AS count FROM contractor_profiles") {
        return { rows: [{ count: String(count) }] };
      }
      if (source.includes("ALTER TABLE contractor_profiles")) {
        if (failAlter) throw new Error("simulated database failure");
        currentColumn = {
          data_type: "jsonb",
          is_nullable: "NO",
          column_default: "'{}'::jsonb",
        };
        return { rows: [] };
      }
      if (source.includes("invalid_count")) return { rows: [{ invalid_count: "0" }] };
      if (source.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_exists: Boolean(currentLedger) }] };
      }
      if (source.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        currentLedger ||= { pending: true };
        return { rows: [] };
      }
      if (source.startsWith("INSERT INTO schema_migrations")) {
        currentLedger = {
          filename: values[0],
          checksum: values[1],
          execution_target: "production-governed-additive",
        };
        return { rows: [] };
      }
      if (source.startsWith("SELECT filename, checksum, execution_target")) {
        return { rows: currentLedger?.filename ? [currentLedger] : [] };
      }
      throw new Error(`Unexpected query: ${source}`);
    },
  };
}

test("production Business Profile migration imports without executing and fails closed", () => {
  assert.equal(typeof migration.main, "function");
  assert.equal(migration.inspectAuthorization({ env: {}, args: [] }).authorized, false);
  assert.equal(
    migration.inspectAuthorization({
      env: { ...SAFE_ENV, MIGRATION_TARGET: "staging", RAILWAY_ENVIRONMENT_NAME: "staging" },
      args: SAFE_ARGS,
    }).authorized,
    false
  );
});

test("execution requires exact filename and final confirmation", () => {
  assert.equal(
    migration.inspectAuthorization({ env: SAFE_ENV, args: [...SAFE_ARGS, migration.EXECUTION_FLAG] }).authorized,
    false
  );
  assert.equal(
    migration.inspectAuthorization({
      env: SAFE_ENV,
      args: [...SAFE_ARGS, migration.EXECUTION_FLAG, migration.FINAL_CONFIRMATION_FLAG],
    }).authorized,
    true
  );
});

test("reviewed migration checksum and one-column scope are pinned", () => {
  const reviewed = migration.loadMigration();
  assert.equal(reviewed.checksum, migration.EXPECTED_CHECKSUM);
  assert.match(reviewed.sql, /ADD COLUMN IF NOT EXISTS profile_details JSONB/i);
  assert.doesNotMatch(reviewed.sql, /DROP|DELETE|TRUNCATE/i);
});

test("execution preserves profile rows, verifies JSON objects, and records one ledger row", async () => {
  const client = createClient();
  const result = await migration.applyProductionBusinessProfileDetails(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, true);
  assert.equal(result.profileCountBefore, 3);
  assert.equal(result.profileCountAfter, 3);
  assert.equal(result.invalidCount, 0);
  assert.equal(client.calls.filter((call) => /ALTER TABLE contractor_profiles/.test(call.sql)).length, 1);
});

test("second governed execution is idempotent", async () => {
  const client = createClient({
    column: { data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" },
  });
  const result = await migration.applyProductionBusinessProfileDetails(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, false);
  assert.equal(client.calls.some((call) => /ALTER TABLE contractor_profiles/.test(call.sql)), false);
});

test("failure rolls back and error normalization hides connection details", async () => {
  const client = createClient({ failAlter: true });
  await assert.rejects(
    migration.applyProductionBusinessProfileDetails(client, migration.loadMigration())
  );
  assert.equal(client.calls.some((call) => call.sql === "ROLLBACK"), true);
  const safe = migration.toSafeError(new Error("postgresql://user:secret@host/database"));
  assert.deepEqual(safe, { status: "failed", errorCode: "PRODUCTION_MIGRATION_FAILED" });
  assert.doesNotMatch(JSON.stringify(safe), /secret|postgresql:\/\//i);
});
