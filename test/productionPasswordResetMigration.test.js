"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = require("../scripts/apply-production-password-reset");

const SAFE_ENV = Object.freeze({
  DATABASE_URL: "postgresql://postgres.railway.internal/railway",
  MIGRATION_TARGET: "production",
  CONFIRM_MIGRATION_TARGET: "production",
  ALLOW_PRODUCTION_PASSWORD_RESET_MIGRATION: "true",
  CONFIRM_PRODUCTION_PASSWORD_RESET: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
});
const SAFE_ARGS = Object.freeze([
  migration.CONFIRMATION_FLAG,
  migration.MIGRATION_ARG,
]);

const VALID_COLUMNS = [
  ["id", "bigint", "NO", "nextval('password_reset_tokens_id_seq'::regclass)", null],
  ["user_id", "integer", "NO", null, null],
  ["token_hash", "character", "NO", null, 64],
  ["expires_at", "timestamp with time zone", "NO", null, null],
  ["used_at", "timestamp with time zone", "YES", null, null],
  ["revoked_at", "timestamp with time zone", "YES", null, null],
  ["created_at", "timestamp with time zone", "NO", "now()", null],
].map(([column_name, data_type, is_nullable, column_default, character_maximum_length]) => ({
  column_name,
  data_type,
  is_nullable,
  column_default,
  character_maximum_length,
}));

const VALID_CONSTRAINTS = [
  { contype: "p", definition: "PRIMARY KEY (id)" },
  { contype: "u", definition: "UNIQUE (token_hash)" },
  { contype: "f", definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE" },
  { contype: "c", definition: "CHECK ((expires_at > created_at))" },
];
const VALID_INDEXES = [
  {
    indexname: "idx_password_reset_tokens_user_id",
    indexdef: "CREATE INDEX idx_password_reset_tokens_user_id ON public.password_reset_tokens USING btree (user_id)",
  },
  {
    indexname: "idx_password_reset_tokens_expires_at",
    indexdef: "CREATE INDEX idx_password_reset_tokens_expires_at ON public.password_reset_tokens USING btree (expires_at)",
  },
];

function createFakeClient({
  tableExists = false,
  conflictingRelation = false,
  ledger = null,
  failCreate = false,
  unrelatedFingerprint = "stable",
} = {}) {
  const calls = [];
  let exists = tableExists;
  let currentLedger = ledger;
  return {
    calls,
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (normalized.startsWith("SET LOCAL")) return { rows: [] };
      if (normalized.includes("to_regclass('public.users')") && normalized.includes("table_exists")) {
        return {
          rows: [{
            users_exists: true,
            table_exists: exists,
            sequence_exists: exists || conflictingRelation,
            user_index_exists: exists,
            expiry_index_exists: exists,
          }],
        };
      }
      if (normalized.includes("information_schema.columns") && normalized.includes("password_reset_tokens")) {
        return { rows: exists ? VALID_COLUMNS : [] };
      }
      if (normalized.includes("FROM pg_constraint")) {
        return { rows: exists ? VALID_CONSTRAINTS : [] };
      }
      if (normalized.includes("FROM pg_indexes")) {
        return { rows: exists ? VALID_INDEXES : [] };
      }
      if (normalized === "SELECT COUNT(*)::bigint AS count FROM password_reset_tokens") {
        return { rows: [{ count: "0" }] };
      }
      if (normalized.includes("AS fingerprint")) {
        return { rows: [{ fingerprint: unrelatedFingerprint }] };
      }
      if (normalized.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_exists: Boolean(currentLedger) }] };
      }
      if (normalized.startsWith("SELECT filename, checksum, execution_target")) {
        return { rows: currentLedger?.filename ? [currentLedger] : [] };
      }
      if (normalized.includes("CREATE TABLE IF NOT EXISTS password_reset_tokens")) {
        if (failCreate) throw new Error("simulated database failure");
        exists = true;
        return { rows: [] };
      }
      if (normalized.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        currentLedger ||= { pending: true };
        return { rows: [] };
      }
      if (normalized.startsWith("INSERT INTO schema_migrations")) {
        currentLedger = {
          filename: values[0],
          checksum: values[1],
          execution_target: values[2],
        };
        return { rows: [] };
      }
      throw new Error(`Unexpected fake query: ${normalized}`);
    },
  };
}

test("production password-reset migration imports without executing", () => {
  assert.equal(typeof migration.main, "function");
  assert.equal(
    Object.hasOwn(process.env, "ALLOW_PRODUCTION_PASSWORD_RESET_MIGRATION"),
    false
  );
});

test("authorization fails closed and rejects staging or unknown targets", () => {
  assert.equal(migration.inspectAuthorization({ env: {}, args: [] }).authorized, false);
  assert.equal(migration.inspectAuthorization({ env: SAFE_ENV, args: [] }).authorized, false);
  for (const target of ["staging", "unknown"]) {
    const result = migration.inspectAuthorization({
      env: { ...SAFE_ENV, MIGRATION_TARGET: target, RAILWAY_ENVIRONMENT_NAME: target },
      args: SAFE_ARGS,
    });
    assert.equal(result.authorized, false);
  }
});

test("exact migration and final execution confirmations are required", () => {
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

test("reviewed checksum and additive SQL scope are pinned", () => {
  const reviewed = migration.loadMigration();
  assert.equal(reviewed.checksum, migration.EXPECTED_CHECKSUM);
  assert.match(reviewed.sql, /CREATE TABLE IF NOT EXISTS password_reset_tokens/i);
  assert.doesNotMatch(
    reviewed.sql.replace(/ON\s+DELETE\s+CASCADE/gi, ""),
    /\b(?:DROP|DELETE|TRUNCATE|ALTER|UPDATE|INSERT)\b/i
  );
});

test("checksum drift and expanded SQL scope fail closed", () => {
  const tempPath = path.join(process.env.TMPDIR || "/tmp", migration.MIGRATION_FILENAME);
  fs.writeFileSync(tempPath, "CREATE TABLE password_reset_tokens (id bigint);\n");
  assert.throws(() => migration.loadMigration(tempPath), {
    code: "MIGRATION_CHECKSUM_MISMATCH",
  });
  assert.throws(
    () => migration.validateMigrationSql("CREATE TABLE password_reset_tokens (id bigint); DROP TABLE users;"),
    { code: "DESTRUCTIVE_SQL_FORBIDDEN" }
  );
  fs.unlinkSync(tempPath);
});

test("schema preflight accepts absence and rejects conflicting relations", async () => {
  assert.deepEqual(await migration.inspectPasswordResetSchema(createFakeClient()), {
    exists: false,
    valid: false,
    rowCount: 0,
  });
  await assert.rejects(
    migration.inspectPasswordResetSchema(createFakeClient({ conflictingRelation: true })),
    { code: "PASSWORD_RESET_RELATION_CONFLICT" }
  );
});

test("execution creates only the reviewed schema, records one ledger row, and preserves unrelated schema", async () => {
  const client = createFakeClient();
  const result = await migration.applyProductionPasswordReset(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, true);
  assert.equal(result.schemaValid, true);
  assert.equal(result.unrelatedSchemaUnchanged, true);
  assert.equal(result.auditTarget, "production-governed-additive");
  assert.equal(
    client.calls.filter((call) =>
      call.sql.includes("CREATE TABLE IF NOT EXISTS password_reset_tokens")
    ).length,
    1
  );
  assert.equal(
    client.calls.filter((call) => call.sql.startsWith("INSERT INTO schema_migrations")).length,
    1
  );
});

test("second governed execution is idempotent and does not rerun migration SQL", async () => {
  const reviewed = migration.loadMigration();
  const client = createFakeClient({
    tableExists: true,
    ledger: {
      filename: reviewed.filename,
      checksum: reviewed.checksum,
      execution_target: "production-governed-additive",
    },
  });
  const result = await migration.applyProductionPasswordReset(client, reviewed);
  assert.equal(result.applied, false);
  assert.equal(
    client.calls.some((call) =>
      call.sql.startsWith("CREATE TABLE IF NOT EXISTS password_reset_tokens")
    ),
    false
  );
});

test("execution failure rolls back and safe errors omit credentials", async () => {
  const client = createFakeClient({ failCreate: true });
  await assert.rejects(
    migration.applyProductionPasswordReset(client, migration.loadMigration())
  );
  assert.equal(client.calls.some((call) => call.sql === "ROLLBACK"), true);
  const safe = migration.toSafeError(
    new Error("sensitive database detail")
  );
  assert.deepEqual(safe, {
    status: "failed",
    errorCode: "PRODUCTION_MIGRATION_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(safe), /sensitive|postgresql:\/\//i);
});

test("normal npm test never invokes the production migration", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  assert.doesNotMatch(packageJson.scripts.test, /apply-production-password-reset/);
});
