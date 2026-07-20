"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = require("../scripts/apply-production-request-lifecycle");

const SAFE_ENV = Object.freeze({
  DATABASE_URL: "postgresql://redacted@postgres.railway.internal/railway",
  MIGRATION_TARGET: "production",
  CONFIRM_MIGRATION_TARGET: "production",
  CONFIRM_PRODUCTION_DATABASE: "production",
  ALLOW_PRODUCTION_REQUEST_LIFECYCLE_MIGRATION: "true",
  CONFIRM_PRODUCTION_REQUEST_LIFECYCLE: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
});
const SAFE_ARGS = Object.freeze([
  migration.CONFIRMATION_FLAG,
  migration.MIGRATION_ARG,
]);
const VALID_COLUMNS = [
  ["request_category", "text", "YES", null],
  ["service_domain", "text", "YES", null],
  ["service_specialty", "text", "YES", null],
  ["unit_number", "text", "NO", "''::text"],
  ["access_notes", "text", "NO", "''::text"],
  ["status", "text", "NO", "'open'::text"],
  ["updated_at", "timestamp without time zone", "NO", "CURRENT_TIMESTAMP"],
  ["cancelled_at", "timestamp without time zone", "YES", null],
].map(([column_name, data_type, is_nullable, column_default]) => ({
  column_name,
  data_type,
  is_nullable,
  column_default,
}));
const VALID_CONSTRAINT = Object.freeze({
  contype: "c",
  definition: "CHECK ((status = ANY (ARRAY['open'::text, 'cancelled'::text])))",
});
const VALID_INDEX = Object.freeze({
  indexdef:
    "CREATE INDEX idx_posts_open_service_projection ON public.posts USING btree (status, service_domain, service_specialty, created_at DESC)",
  indisvalid: true,
  indisready: true,
});

function createClient({
  lifecycleExists = false,
  partialSchema = false,
  ledger = null,
  failMigration = false,
  postCount = 35,
  unrelatedFingerprintChanges = false,
} = {}) {
  const calls = [];
  let lifecycle = lifecycleExists;
  let currentLedger = ledger;
  let inventoryReads = 0;
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
      if (source.startsWith("SELECT item FROM")) {
        inventoryReads += 1;
        const rows = [{ item: "column:posts:id:integer:NO" }];
        if (unrelatedFingerprintChanges && inventoryReads > 1) {
          rows.push({ item: "constraint:posts:unexpected:CHECK (unsafe)" });
        }
        return { rows };
      }
      if (source.includes("information_schema.columns") && source.includes("column_name = ANY")) {
        return { rows: lifecycle ? VALID_COLUMNS : partialSchema ? VALID_COLUMNS.slice(0, 1) : [] };
      }
      if (source.includes("FROM pg_constraint") && source.includes("conname = $1")) {
        return { rows: lifecycle ? [VALID_CONSTRAINT] : [] };
      }
      if (source.includes("FROM pg_indexes") && source.includes("indexname = $1")) {
        return { rows: lifecycle ? [VALID_INDEX] : [] };
      }
      if (source === "SELECT COUNT(*)::bigint AS count FROM posts") {
        return { rows: [{ count: String(postCount) }] };
      }
      if (source.includes("status NOT IN ('open', 'cancelled')")) {
        return { rows: [{ total_count: String(postCount), invalid_count: "0", null_count: "0" }] };
      }
      if (source.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_exists: Boolean(currentLedger) }] };
      }
      if (source.startsWith("SELECT filename, checksum, execution_target")) {
        return { rows: currentLedger?.filename ? [currentLedger] : [] };
      }
      if (source.includes("ALTER TABLE posts") && source.includes("request_category")) {
        if (failMigration) throw new Error("private database detail");
        lifecycle = true;
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

test("production request-lifecycle migration imports without executing", () => {
  assert.equal(typeof migration.main, "function");
  assert.equal(
    Object.hasOwn(process.env, "ALLOW_PRODUCTION_REQUEST_LIFECYCLE_MIGRATION"),
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

test("reviewed migration checksum and additive lifecycle scope are pinned", () => {
  const reviewed = migration.loadMigration();
  assert.equal(reviewed.checksum, migration.EXPECTED_CHECKSUM);
  assert.equal(
    crypto.createHash("sha256").update(reviewed.sql).digest("hex"),
    migration.EXPECTED_CHECKSUM
  );
  assert.match(reviewed.sql, /ADD COLUMN IF NOT EXISTS request_category TEXT/i);
  assert.match(reviewed.sql, /posts_request_status_check/i);
  assert.match(reviewed.sql, /idx_posts_open_service_projection/i);
  assert.throws(
    () => migration.validateMigrationSql(
      "ALTER TABLE posts ADD COLUMN status TEXT; DROP TABLE posts;"
    ),
    { code: "DESTRUCTIVE_SQL_FORBIDDEN" }
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

test("precheck accepts absence and rejects partial lifecycle schema", async () => {
  const absent = await migration.inspectSchema(createClient());
  assert.equal(absent.lifecycleExists, false);
  await assert.rejects(
    migration.inspectSchema(createClient({ partialSchema: true })),
    { code: "REQUEST_LIFECYCLE_SCHEMA_CONFLICT" }
  );
});

test("execution adds valid lifecycle objects, preserves posts, and records one ledger row", async () => {
  const client = createClient();
  const result = await migration.applyProductionRequestLifecycle(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, true);
  assert.equal(result.postCountBefore, 35);
  assert.equal(result.postCountAfter, 35);
  assert.equal(result.lifecycleValid, true);
  assert.equal(result.invalidStatusCount, 0);
  assert.equal(result.constraintPresent, true);
  assert.equal(result.indexPresent, true);
  assert.deepEqual(result.columnsPresent, [...migration.TARGET_COLUMNS].sort());
  assert.equal(result.unrelatedSchemaUnchanged, true);
  assert.equal(result.auditTarget, migration.AUDIT_TARGET);
  assert.equal(
    client.calls.filter((call) =>
      call.sql.includes("ALTER TABLE posts") && call.sql.includes("request_category")
    ).length,
    1
  );
  assert.equal(
    client.calls.filter((call) => call.sql.startsWith("INSERT INTO schema_migrations")).length,
    1
  );
  const fingerprintCall = client.calls.find((call) => call.sql.startsWith("SELECT item FROM"));
  assert.deepEqual(fingerprintCall.values[1], migration.TARGET_CONSTRAINTS);
  assert.equal(
    migration.TARGET_CONSTRAINTS.includes("posts_updated_at_not_null"),
    true
  );
});

test("diagnostics identify an unrelated-schema fingerprint mismatch exactly", async () => {
  const client = createClient({ unrelatedFingerprintChanges: true });
  await assert.rejects(
    async () => {
      try {
        await migration.applyProductionRequestLifecycle(client, migration.loadMigration());
      } catch (error) {
        const failed = error.diagnostics.filter((item) => !item.passed);
        assert.equal(failed.length, 1);
        assert.equal(failed[0].invariant, "unrelated_schema_fingerprint_preserved");
        assert.deepEqual(failed[0].differences, {
          added: ["constraint:posts:unexpected:CHECK (unsafe)"],
          removed: [],
        });
        assert.doesNotMatch(JSON.stringify(migration.toSafeError(error)), /password|token|postgresql:/i);
        throw error;
      }
    },
    { code: "POST_MIGRATION_VERIFICATION_FAILED" }
  );
  assert.equal(client.calls.some((call) => call.sql === "ROLLBACK"), true);
});

test("PostgreSQL 18 lifecycle NOT NULL constraints are authorized objects", () => {
  assert.deepEqual(migration.TARGET_CONSTRAINTS, [
    "posts_request_status_check",
    "posts_access_notes_not_null",
    "posts_status_not_null",
    "posts_unit_number_not_null",
    "posts_updated_at_not_null",
  ]);
});

test("second governed execution is idempotent", async () => {
  const client = createClient({
    lifecycleExists: true,
    ledger: {
      filename: migration.MIGRATION_FILENAME,
      checksum: migration.EXPECTED_CHECKSUM,
      execution_target: migration.AUDIT_TARGET,
    },
  });
  const result = await migration.applyProductionRequestLifecycle(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, false);
  assert.equal(
    client.calls.some((call) =>
      call.sql.includes("ALTER TABLE posts") && call.sql.includes("request_category")
    ),
    false
  );
});

test("orphaned schema or ledger state fails closed", async () => {
  await assert.rejects(
    migration.applyProductionRequestLifecycle(
      createClient({ lifecycleExists: true }),
      migration.loadMigration()
    ),
    { code: "MIGRATION_AUDIT_FAILED" }
  );
  await assert.rejects(
    migration.applyProductionRequestLifecycle(
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
  const client = createClient({ failMigration: true });
  await assert.rejects(
    migration.applyProductionRequestLifecycle(client, migration.loadMigration()),
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

test("normal test command never invokes production request-lifecycle migration", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  assert.doesNotMatch(packageJson.scripts.test, /apply-production-request-lifecycle/);
});
