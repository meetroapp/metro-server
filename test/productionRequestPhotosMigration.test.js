"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = require("../scripts/apply-production-request-photos");

const SAFE_ENV = Object.freeze({
  DATABASE_URL: "postgresql://redacted@postgres.railway.internal/railway",
  MIGRATION_TARGET: "production",
  CONFIRM_MIGRATION_TARGET: "production",
  CONFIRM_PRODUCTION_DATABASE: "production",
  ALLOW_PRODUCTION_REQUEST_PHOTOS_MIGRATION: "true",
  CONFIRM_PRODUCTION_REQUEST_PHOTOS: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
});
const SAFE_ARGS = Object.freeze([
  migration.CONFIRMATION_FLAG,
  migration.MIGRATION_ARG,
]);
const VALID_COLUMN = Object.freeze({
  data_type: "jsonb",
  is_nullable: "NO",
  column_default: "'[]'::jsonb",
});

function createClient({
  columnExists = false,
  ledger = null,
  failAlter = false,
  postCount = 4,
  unrelatedFingerprint = "stable",
} = {}) {
  const calls = [];
  let column = columnExists ? { ...VALID_COLUMN } : null;
  let currentLedger = ledger;
  return {
    calls,
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: source, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(source) || source.startsWith("SET LOCAL")) {
        return { rows: [] };
      }
      if (source.includes("to_regclass('public.posts')")) {
        return { rows: [{ table_exists: true }] };
      }
      if (source.includes("information_schema.columns") && source.includes("request_photos")) {
        return { rows: column ? [column] : [] };
      }
      if (source === "SELECT COUNT(*)::bigint AS count FROM posts") {
        return { rows: [{ count: String(postCount) }] };
      }
      if (source.includes("jsonb_typeof(request_photos)")) {
        return { rows: [{ invalid_count: "0" }] };
      }
      if (source.includes("AS fingerprint")) {
        return { rows: [{ fingerprint: unrelatedFingerprint }] };
      }
      if (source.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_exists: Boolean(currentLedger) }] };
      }
      if (source.startsWith("SELECT filename, checksum, execution_target")) {
        return { rows: currentLedger?.filename ? [currentLedger] : [] };
      }
      if (source.includes("ALTER TABLE posts")) {
        if (failAlter) throw new Error("private database detail");
        column = { ...VALID_COLUMN };
        return { rows: [] };
      }
      if (source.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        return { rows: [] };
      }
      if (source.startsWith("INSERT INTO schema_migrations")) {
        currentLedger = {
          filename: values[0],
          checksum: values[1],
          execution_target: values[2],
        };
        return { rows: [] };
      }
      throw new Error(`Unexpected migration query: ${source}`);
    },
  };
}

test("production request-photo migration imports without executing", () => {
  assert.equal(typeof migration.main, "function");
  assert.equal(
    Object.hasOwn(process.env, "ALLOW_PRODUCTION_REQUEST_PHOTOS_MIGRATION"),
    false
  );
});

test("authorization requires exact production evidence and four execution gates", () => {
  assert.equal(migration.inspectAuthorization({ env: {}, args: [] }).authorized, false);
  assert.equal(
    migration.inspectAuthorization({
      env: { ...SAFE_ENV, RAILWAY_ENVIRONMENT_NAME: "staging" },
      args: SAFE_ARGS,
    }).authorized,
    false
  );
  assert.equal(
    migration.inspectAuthorization({
      env: { ...SAFE_ENV, CONFIRM_PRODUCTION_DATABASE: "" },
      args: SAFE_ARGS,
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

test("reviewed migration checksum and one-column scope are pinned", () => {
  const reviewed = migration.loadMigration();
  assert.equal(reviewed.checksum, migration.EXPECTED_CHECKSUM);
  assert.match(reviewed.sql, /ADD COLUMN IF NOT EXISTS request_photos JSONB/i);
  assert.throws(
    () => migration.validateMigrationSql(
      "ALTER TABLE posts ADD COLUMN request_photos JSONB; DROP TABLE posts;"
    ),
    { code: "MIGRATION_SCOPE_MISMATCH" }
  );

  const temporaryPath = path.join(
    process.env.TMPDIR || "/tmp",
    migration.MIGRATION_FILENAME
  );
  fs.writeFileSync(temporaryPath, "ALTER TABLE posts ADD COLUMN unsafe TEXT;\n");
  assert.throws(() => migration.loadMigration(temporaryPath), {
    code: "MIGRATION_CHECKSUM_MISMATCH",
  });
  fs.unlinkSync(temporaryPath);
});

test("execution adds one valid column, preserves posts, and records one ledger row", async () => {
  const client = createClient();
  const result = await migration.applyProductionRequestPhotos(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, true);
  assert.equal(result.postCountBefore, 4);
  assert.equal(result.postCountAfter, 4);
  assert.equal(result.columnValid, true);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.unrelatedSchemaUnchanged, true);
  assert.equal(result.auditTarget, migration.AUDIT_TARGET);
  assert.equal(
    client.calls.filter((call) => call.sql.includes("ALTER TABLE posts")).length,
    1
  );
  assert.equal(
    client.calls.filter((call) => call.sql.startsWith("INSERT INTO schema_migrations")).length,
    1
  );
});

test("second governed execution is idempotent", async () => {
  const client = createClient({
    columnExists: true,
    ledger: {
      filename: migration.MIGRATION_FILENAME,
      checksum: migration.EXPECTED_CHECKSUM,
      execution_target: migration.AUDIT_TARGET,
    },
  });
  const result = await migration.applyProductionRequestPhotos(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, false);
  assert.equal(
    client.calls.some((call) => call.sql.includes("ALTER TABLE posts")),
    false
  );
});

test("orphaned schema or ledger state fails closed", async () => {
  await assert.rejects(
    migration.applyProductionRequestPhotos(
      createClient({ columnExists: true }),
      migration.loadMigration()
    ),
    { code: "MIGRATION_AUDIT_FAILED" }
  );
  await assert.rejects(
    migration.applyProductionRequestPhotos(
      createClient({
        ledger: {
          filename: migration.MIGRATION_FILENAME,
          checksum: migration.EXPECTED_CHECKSUM,
          execution_target: migration.AUDIT_TARGET,
        },
      }),
      migration.loadMigration()
    ),
    { code: "MIGRATION_AUDIT_FAILED" }
  );
});

test("execution failure rolls back and safe errors omit private details", async () => {
  const client = createClient({ failAlter: true });
  await assert.rejects(
    migration.applyProductionRequestPhotos(client, migration.loadMigration()),
    /private database detail/
  );
  assert.equal(client.calls.some((call) => call.sql === "ROLLBACK"), true);
  const safe = migration.toSafeError(new Error("postgresql://secret@host/database"));
  assert.deepEqual(safe, {
    status: "failed",
    errorCode: "PRODUCTION_MIGRATION_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(safe), /secret|postgresql:\/\//i);
});
