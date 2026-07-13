"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = require("../scripts/apply-production-token-version");

const SAFE_ENV = Object.freeze({
  DATABASE_URL: "postgresql://user:secret@postgres.railway.internal/railway",
  MIGRATION_TARGET: "production",
  CONFIRM_MIGRATION_TARGET: "production",
  ALLOW_PRODUCTION_TOKEN_VERSION_MIGRATION: "true",
  CONFIRM_PRODUCTION_TOKEN_VERSION: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
});
const SAFE_ARGS = Object.freeze([
  migration.CONFIRMATION_FLAG,
  migration.MIGRATION_ARG,
]);

function createFakeClient({
  usersExists = true,
  column = null,
  userCount = 4,
  failAlter = false,
  ledger = null,
} = {}) {
  const calls = [];
  let currentColumn = column;
  let currentLedger = ledger;
  return {
    calls,
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [] };
      }
      if (normalized.startsWith("SET LOCAL")) return { rows: [] };
      if (normalized.includes("to_regclass('public.users')")) {
        return { rows: [{ users_exists: usersExists }] };
      }
      if (normalized.includes("information_schema.columns")) {
        return { rows: currentColumn ? [currentColumn] : [] };
      }
      if (normalized === "SELECT COUNT(*)::bigint AS count FROM users") {
        return { rows: [{ count: String(userCount) }] };
      }
      if (normalized.includes("ALTER TABLE users")) {
        if (failAlter) throw new Error("simulated failure");
        currentColumn = {
          data_type: "integer",
          is_nullable: "NO",
          column_default: "0",
        };
        return { rows: [] };
      }
      if (normalized.includes("null_count") && normalized.includes("nonzero_count")) {
        return { rows: [{ null_count: "0", nonzero_count: "0" }] };
      }
      if (normalized.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_exists: Boolean(currentLedger) }] };
      }
      if (normalized.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        currentLedger ||= { pending: true };
        return { rows: [] };
      }
      if (normalized.startsWith("INSERT INTO schema_migrations")) {
        currentLedger = {
          filename: values[0],
          checksum: values[1],
          execution_target: "production-emergency-additive",
        };
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT filename, checksum, execution_target")) {
        return { rows: currentLedger?.filename ? [currentLedger] : [] };
      }
      throw new Error(`Unexpected fake query: ${normalized}`);
    },
  };
}

test("production migration module imports without executing", () => {
  assert.equal(typeof migration.main, "function");
  assert.equal(Object.hasOwn(process.env, "ALLOW_PRODUCTION_TOKEN_VERSION_MIGRATION"), false);
});

test("authorization fails closed without dual environment and CLI confirmation", () => {
  assert.equal(migration.inspectAuthorization({ env: {}, args: [] }).authorized, false);
  assert.equal(
    migration.inspectAuthorization({ env: SAFE_ENV, args: [] }).authorized,
    false
  );
});

test("staging and unknown targets are rejected", () => {
  for (const target of ["staging", "unknown"]) {
    const result = migration.inspectAuthorization({
      env: { ...SAFE_ENV, MIGRATION_TARGET: target, RAILWAY_ENVIRONMENT_NAME: target },
      args: SAFE_ARGS,
    });
    assert.equal(result.authorized, false);
  }
});

test("the exact migration filename and final execution confirmation are required", () => {
  assert.equal(
    migration.inspectAuthorization({
      env: SAFE_ENV,
      args: [migration.CONFIRMATION_FLAG, "--migration=wrong.sql"],
    }).authorized,
    false
  );
  assert.equal(
    migration.inspectAuthorization({
      env: SAFE_ENV,
      args: [...SAFE_ARGS, migration.EXECUTION_FLAG],
    }).authorized,
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

test("reviewed migration checksum and narrow SQL scope are pinned", () => {
  const reviewed = migration.loadMigration();
  assert.equal(reviewed.filename, migration.MIGRATION_FILENAME);
  assert.equal(reviewed.checksum, migration.EXPECTED_CHECKSUM);
  assert.doesNotMatch(reviewed.sql, /\b(DROP|DELETE|TRUNCATE)\b/i);
  assert.match(reviewed.sql, /ALTER TABLE users/i);
  assert.match(reviewed.sql, /ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0/i);
});

test("wrong checksum and expanded SQL scope fail", () => {
  const tempPath = path.join(
    process.env.TMPDIR || "/tmp",
    migration.MIGRATION_FILENAME
  );
  fs.writeFileSync(tempPath, "ALTER TABLE users ADD COLUMN unsafe text;\n");
  assert.throws(() => migration.loadMigration(tempPath), {
    code: "MIGRATION_CHECKSUM_MISMATCH",
  });
  assert.throws(
    () => migration.validateMigrationSql("ALTER TABLE users ADD COLUMN token_version integer; DROP TABLE users;"),
    { code: "DESTRUCTIVE_SQL_FORBIDDEN" }
  );
  fs.unlinkSync(tempPath);
});

test("schema inspection rejects missing users and conflicting token_version", async () => {
  await assert.rejects(
    migration.inspectProductionSchema(createFakeClient({ usersExists: false })),
    { code: "USERS_TABLE_MISSING" }
  );
  await assert.rejects(
    migration.inspectProductionSchema(
      createFakeClient({
        column: { data_type: "text", is_nullable: "YES", column_default: null },
      })
    ),
    { code: "TOKEN_VERSION_CONFLICT" }
  );
});

test("additive execution verifies users, records only token migration, and preserves count", async () => {
  const client = createFakeClient();
  const result = await migration.applyProductionTokenVersion(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, true);
  assert.equal(result.userCountBefore, 4);
  assert.equal(result.userCountAfter, 4);
  assert.equal(result.baselineRecorded, false);
  assert.equal(result.auditTarget, "production-emergency-additive");
  assert.equal(client.calls.filter((call) => /ALTER TABLE users/.test(call.sql)).length, 1);
  assert.equal(
    client.calls.some((call) =>
      /202607050001_initial_schema_baseline/.test(JSON.stringify(call.values || []))
    ),
    false
  );
});

test("an existing correct column safely skips and preserves legitimate versions", async () => {
  const client = createFakeClient({
    column: { data_type: "integer", is_nullable: "NO", column_default: "0" },
  });
  const result = await migration.applyProductionTokenVersion(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, false);
  assert.equal(client.calls.some((call) => /ALTER TABLE users/.test(call.sql)), false);
});

test("failures roll back and safe errors omit database credentials", async () => {
  const client = createFakeClient({ failAlter: true });
  await assert.rejects(
    migration.applyProductionTokenVersion(client, migration.loadMigration())
  );
  assert.equal(client.calls.some((call) => call.sql === "ROLLBACK"), true);
  const safe = migration.toSafeError(
    new Error("postgresql://user:secret@host/database")
  );
  assert.deepEqual(safe, {
    status: "failed",
    errorCode: "PRODUCTION_MIGRATION_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(safe), /secret|postgresql:\/\//i);
});

test("sanitized targets never include credentials", () => {
  const target = migration.getSanitizedTarget(SAFE_ENV.DATABASE_URL);
  assert.deepEqual(target, {
    host: "postgres.railway.internal",
    database: "railway",
  });
  assert.doesNotMatch(JSON.stringify(target), /user|secret|@/i);
});

test("normal npm test never invokes the production migration", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  assert.doesNotMatch(packageJson.scripts.test, /apply-production-token-version/);
});
