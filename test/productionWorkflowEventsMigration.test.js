"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = require("../scripts/apply-production-workflow-events");
const {
  inspectWorkflowEventsSchema,
} = require("../scripts/workflow-events-schema");
const { runMigrationFile } = require("../scripts/run-migrations");

const SAFE_ENV = Object.freeze({
  DATABASE_URL: "postgresql://postgres.railway.internal/railway",
  MIGRATION_TARGET: "production",
  CONFIRM_MIGRATION_TARGET: "production",
  ALLOW_PRODUCTION_WORKFLOW_EVENTS_MIGRATION: "true",
  CONFIRM_PRODUCTION_WORKFLOW_EVENTS: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
});
const SAFE_ARGS = Object.freeze([
  migration.CONFIRMATION_FLAG,
  migration.MIGRATION_ARG,
]);

const VALID_COLUMNS = [
  ["id", "integer", "NO", "nextval('workflow_events_id_seq'::regclass)"],
  ["quote_request_id", "integer", "NO", null],
  ["user_id", "integer", "NO", null],
  ["workflow_type", "text", "NO", null],
  ["workflow_status", "text", "YES", null],
  ["workflow_payload", "jsonb", "YES", "'{}'::jsonb"],
  ["event_label", "text", "YES", null],
  ["created_at", "timestamp without time zone", "YES", "CURRENT_TIMESTAMP"],
].map(([column_name, data_type, is_nullable, column_default]) => ({
  column_name,
  data_type,
  is_nullable,
  column_default,
}));
const VALID_CONSTRAINTS = [
  { contype: "p", definition: "PRIMARY KEY (id)" },
  {
    contype: "f",
    definition:
      "FOREIGN KEY (quote_request_id) REFERENCES quote_requests(id) ON DELETE CASCADE",
  },
  {
    contype: "f",
    definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
  },
];
const VALID_INDEXES = [{
  indexname: "workflow_events_quote_request_id_created_at_idx",
  indexdef:
    "CREATE INDEX workflow_events_quote_request_id_created_at_idx ON public.workflow_events USING btree (quote_request_id, created_at)",
}];

function createClient({
  tableExists = false,
  conflictingRelation = false,
  incompatible = false,
  ledger = null,
  failCreate = false,
  rowCount = 0,
} = {}) {
  const calls = [];
  let exists = tableExists;
  let currentLedger = ledger;
  return {
    calls,
    async query(sql, values) {
      const source = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: source, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(source)) return { rows: [] };
      if (source.startsWith("SET LOCAL")) return { rows: [] };
      if (source.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (
        source.includes("to_regclass('public.users')") &&
        source.includes("quote_requests_exists")
      ) {
        return { rows: [{
          users_exists: true,
          quote_requests_exists: true,
          table_exists: exists,
          sequence_exists: exists || conflictingRelation,
          index_exists: exists,
        }] };
      }
      if (source.includes("information_schema.columns") && source.includes("workflow_events")) {
        return { rows: exists ? (incompatible ? VALID_COLUMNS.slice(0, -1) : VALID_COLUMNS) : [] };
      }
      if (source.includes("FROM pg_constraint")) {
        return { rows: exists ? VALID_CONSTRAINTS : [] };
      }
      if (source.includes("FROM pg_indexes")) {
        return { rows: exists ? VALID_INDEXES : [] };
      }
      if (source === "SELECT COUNT(*)::bigint AS count FROM workflow_events") {
        return { rows: [{ count: String(rowCount) }] };
      }
      if (source.includes("AS fingerprint")) return { rows: [{ fingerprint: "stable" }] };
      if (source.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_exists: Boolean(currentLedger) }] };
      }
      if (source.startsWith("SELECT filename, checksum, execution_target")) {
        return { rows: currentLedger?.filename ? [currentLedger] : [] };
      }
      if (source.includes("FROM schema_migrations") && source.includes("WHERE filename = $1")) {
        return { rows: currentLedger?.filename ? [currentLedger] : [] };
      }
      if (source.includes("CREATE TABLE IF NOT EXISTS workflow_events")) {
        if (failCreate) throw new Error("simulated database failure");
        exists = true;
        return { rows: [] };
      }
      if (source.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        currentLedger ||= { pending: true };
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
      throw new Error(`Unexpected query: ${source}`);
    },
  };
}

test("production workflow-event migration imports without executing", () => {
  assert.equal(typeof migration.main, "function");
  assert.equal(
    Object.hasOwn(process.env, "ALLOW_PRODUCTION_WORKFLOW_EVENTS_MIGRATION"),
    false
  );
});

test("authorization requires production evidence and rejects staging", () => {
  assert.equal(migration.inspectAuthorization({ env: {}, args: [] }).authorized, false);
  assert.equal(migration.inspectAuthorization({ env: SAFE_ENV, args: [] }).authorized, false);
  assert.equal(
    migration.inspectAuthorization({
      env: {
        ...SAFE_ENV,
        MIGRATION_TARGET: "staging",
        RAILWAY_ENVIRONMENT_NAME: "staging",
      },
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

test("reviewed migration checksum and additive SQL scope are pinned", () => {
  const reviewed = migration.loadMigration();
  assert.equal(reviewed.checksum, migration.EXPECTED_CHECKSUM);
  assert.equal(
    crypto.createHash("sha256").update(reviewed.sql).digest("hex"),
    migration.EXPECTED_CHECKSUM
  );
  assert.match(reviewed.sql, /CREATE TABLE IF NOT EXISTS workflow_events/i);
  assert.match(reviewed.sql, /workflow_events_quote_request_id_created_at_idx/i);
  assert.doesNotMatch(
    reviewed.sql.replace(/ON\s+DELETE\s+CASCADE/gi, ""),
    /\b(?:DROP|DELETE|TRUNCATE|ALTER|UPDATE|INSERT)\b/i
  );
});

test("checksum drift and expanded SQL fail closed", () => {
  const temporaryPath = path.join(
    process.env.TMPDIR || "/tmp",
    migration.MIGRATION_FILENAME
  );
  fs.writeFileSync(temporaryPath, "CREATE TABLE workflow_events (id integer);\n");
  assert.throws(() => migration.loadMigration(temporaryPath), {
    code: "MIGRATION_CHECKSUM_MISMATCH",
  });
  fs.unlinkSync(temporaryPath);
  assert.throws(
    () => migration.validateMigrationSql(
      "CREATE TABLE workflow_events (id integer); DROP TABLE users;"
    ),
    { code: "DESTRUCTIVE_SQL_FORBIDDEN" }
  );
});

test("schema inspection accepts absence and rejects conflicts", async () => {
  assert.deepEqual(await inspectWorkflowEventsSchema(createClient()), {
    exists: false,
    valid: false,
    rowCount: 0,
  });
  await assert.rejects(
    inspectWorkflowEventsSchema(createClient({ conflictingRelation: true })),
    { code: "WORKFLOW_EVENTS_RELATION_CONFLICT" }
  );
  await assert.rejects(
    inspectWorkflowEventsSchema(createClient({ tableExists: true, incompatible: true })),
    { code: "WORKFLOW_EVENTS_SCHEMA_CONFLICT" }
  );
});

test("execution creates only canonical schema and records one migration", async () => {
  const client = createClient();
  const result = await migration.applyProductionWorkflowEvents(
    client,
    migration.loadMigration()
  );
  assert.equal(result.applied, true);
  assert.equal(result.schemaValid, true);
  assert.equal(result.rowCountBefore, 0);
  assert.equal(result.rowCountAfter, 0);
  assert.equal(result.unrelatedSchemaUnchanged, true);
  assert.equal(result.auditTarget, "production-governed-additive");
  assert.equal(
    client.calls.filter((call) =>
      call.sql.includes("CREATE TABLE IF NOT EXISTS workflow_events")
    ).length,
    1
  );
  assert.equal(
    client.calls.filter((call) =>
      call.sql.startsWith("INSERT INTO schema_migrations")
    ).length,
    1
  );
});

test("governed staging runner validates schema before recording the migration", async () => {
  const client = createClient();
  const reviewed = migration.loadMigration();
  assert.equal(await runMigrationFile(client, reviewed, "staging"), "applied");
  assert.equal(
    client.calls.findIndex((call) => call.sql.includes("FROM pg_constraint")) <
      client.calls.findIndex((call) =>
        call.sql.startsWith("INSERT INTO schema_migrations")
      ),
    true
  );

  const incompatibleClient = createClient({ tableExists: true, incompatible: true });
  await assert.rejects(
    runMigrationFile(incompatibleClient, reviewed, "staging"),
    { code: "WORKFLOW_EVENTS_SCHEMA_CONFLICT" }
  );
  assert.equal(
    incompatibleClient.calls.some((call) => call.sql === "ROLLBACK"),
    true
  );
});

test("second governed execution preserves rows and does not rerun migration SQL", async () => {
  const reviewed = migration.loadMigration();
  const client = createClient({
    tableExists: true,
    rowCount: 7,
    ledger: {
      filename: reviewed.filename,
      checksum: reviewed.checksum,
      execution_target: "production-governed-additive",
    },
  });
  const result = await migration.applyProductionWorkflowEvents(client, reviewed);
  assert.equal(result.applied, false);
  assert.equal(result.rowCountBefore, 7);
  assert.equal(result.rowCountAfter, 7);
  assert.equal(
    client.calls.some((call) =>
      call.sql.startsWith("CREATE TABLE IF NOT EXISTS workflow_events")
    ),
    false
  );
});

test("execution failure rolls back and safe errors omit private details", async () => {
  const client = createClient({ failCreate: true });
  await assert.rejects(
    migration.applyProductionWorkflowEvents(client, migration.loadMigration())
  );
  assert.equal(client.calls.some((call) => call.sql === "ROLLBACK"), true);
  const safe = migration.toSafeError(
    new Error("postgresql://user:secret@private/database")
  );
  assert.deepEqual(safe, {
    status: "failed",
    errorCode: "PRODUCTION_MIGRATION_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(safe), /secret|postgresql:|private/i);
});

test("normal test command never invokes production workflow migration", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  assert.doesNotMatch(packageJson.scripts.test, /apply-production-workflow-events/);
});
