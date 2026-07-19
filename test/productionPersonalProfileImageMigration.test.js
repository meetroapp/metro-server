"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const migration = require("../scripts/apply-production-personal-profile-image");

function authorizedEnv() {
  return {
    DATABASE_URL: "postgresql://redacted@production.internal/meetro_production",
    MIGRATION_TARGET: "production",
    CONFIRM_MIGRATION_TARGET: "production",
    ALLOW_PRODUCTION_PERSONAL_PROFILE_MEDIA_MIGRATION: "true",
    CONFIRM_PRODUCTION_PERSONAL_PROFILE_MEDIA: "production",
    RAILWAY_ENVIRONMENT_NAME: "production",
  };
}

function requiredArgs(execute = false) {
  const args = [
    "--confirm-production-personal-profile-media",
    `--migration=${migration.MIGRATION_FILENAME}`,
  ];
  if (execute) {
    args.push("--execute", "--confirm-additive-user-profile-photo-details");
  }
  return args;
}

function createClient({ columnExists = false, failMigration = false } = {}) {
  const calls = [];
  let column = columnExists;
  let ledger = null;
  return {
    calls,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ||
          sql.startsWith("SET LOCAL") || sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        return { rows: [] };
      }
      if (sql.includes("to_regclass('public.users')")) return { rows: [{ table_exists: true }] };
      if (sql.includes("information_schema.columns")) {
        return {
          rows: column
            ? [{ data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" }]
            : [],
        };
      }
      if (sql === "SELECT COUNT(*)::bigint AS count FROM users") {
        return { rows: [{ count: "4" }] };
      }
      if (sql.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_exists: Boolean(ledger) }] };
      }
      if (sql.startsWith("SELECT filename, checksum, execution_target FROM schema_migrations")) {
        return { rows: ledger ? [ledger] : [] };
      }
      if (sql.includes("ALTER TABLE users")) {
        if (failMigration) throw new Error("private connection detail");
        column = true;
        return { rows: [] };
      }
      if (sql.includes("jsonb_typeof(profile_photo_details)")) {
        return { rows: [{ invalid_count: "0" }] };
      }
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        ledger = {
          filename: values[0],
          checksum: values[1],
          execution_target: "production-governed-additive",
        };
        return { rows: [] };
      }
      throw new Error(`Unexpected migration query: ${sql}`);
    },
  };
}

test("production authorization requires exact target and dual execution confirmation", () => {
  assert.equal(migration.inspectAuthorization({ env: {}, args: [] }).authorized, false);
  assert.equal(
    migration.inspectAuthorization({
      env: { ...authorizedEnv(), RAILWAY_ENVIRONMENT_NAME: "staging" },
      args: requiredArgs(),
    }).authorized,
    false
  );
  assert.equal(
    migration.inspectAuthorization({
      env: authorizedEnv(),
      args: requiredArgs(true),
    }).authorized,
    true
  );
});

test("reviewed migration checksum and single-column scope are pinned", () => {
  const reviewed = migration.loadMigration();
  assert.equal(reviewed.checksum, migration.EXPECTED_CHECKSUM);
  assert.match(reviewed.sql, /ADD COLUMN IF NOT EXISTS profile_photo_details JSONB/i);
  assert.throws(
    () => migration.validateMigrationSql(
      "ALTER TABLE users ADD COLUMN profile_photo_details JSONB; DROP TABLE users;"
    )
  );

  const file = path.join(os.tmpdir(), "202607190001_add_user_profile_photo_details.sql");
  fs.writeFileSync(file, "ALTER TABLE users ADD COLUMN unsafe TEXT;\n");
  assert.throws(() => migration.loadMigration(file));
  fs.rmSync(file, { force: true });
});

test("migration applies once, preserves user count, and records checksum", async () => {
  const client = createClient();
  const result = await migration.applyMigration(client, migration.loadMigration());
  assert.equal(result.applied, true);
  assert.equal(result.userCountBefore, 4);
  assert.equal(result.userCountAfter, 4);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.checksum, migration.EXPECTED_CHECKSUM);
  assert.equal(client.calls.filter((call) => call.sql.includes("ALTER TABLE users")).length, 1);
});

test("second governed execution is idempotent", async () => {
  const client = createClient({ columnExists: true });
  const result = await migration.applyMigration(client, migration.loadMigration());
  assert.equal(result.applied, false);
  assert.equal(client.calls.some((call) => call.sql.includes("ALTER TABLE users")), false);
});

test("migration failure rolls back and safe errors expose no database details", async () => {
  const client = createClient({ failMigration: true });
  await assert.rejects(
    migration.applyMigration(client, migration.loadMigration()),
    /private connection detail/
  );
  assert.equal(client.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.deepEqual(migration.toSafeError(new Error("postgresql://secret")), {
    status: "failed",
    errorCode: "PRODUCTION_MIGRATION_FAILED",
  });
});
