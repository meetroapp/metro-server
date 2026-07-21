"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  BASELINE_MIGRATION_FILENAME,
  BASELINE_NOT_NULL_COLUMNS,
  BASELINE_SCHEMA_REQUIREMENTS,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  assertSafeMigrationExecutionTarget,
  getMigrationFiles,
  inspectMigrationExecutionTarget,
  isRailwayPrivateDatabaseHost,
  isRailwayRuntime,
  redactDatabaseUrl,
  runMigrationCollection,
  validateBaselineSchemaRows,
} = require("../scripts/run-migrations");

const repositoryRoot = join(__dirname, "..");
const migrationsDirectory = join(repositoryRoot, "migrations");
const baselinePath = join(migrationsDirectory, BASELINE_MIGRATION_FILENAME);
const baselineSql = readFileSync(baselinePath, "utf8");
const tokenVersionMigrationFilename =
  "202607130001_add_user_token_version.sql";
const requestPhotosMigrationFilename =
  "202607190002_add_post_request_photos.sql";
const requestLifecycleMigrationFilename =
  "202607200001_add_post_request_lifecycle.sql";
const messageConversationIdentityMigrationFilename =
  "202607210001_add_message_conversation_identity.sql";
const packageJson = require("../package.json");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

function migration(filename, sql) {
  return { filename, sql, checksum: checksum(sql) };
}

function completeBaselineSchemaRows() {
  return Object.entries(BASELINE_SCHEMA_REQUIREMENTS).flatMap(
    ([tableName, columns]) =>
      Object.entries(columns).map(([columnName, dataType]) => ({
        table_name: tableName,
        column_name: columnName,
        data_type: dataType,
        is_nullable: BASELINE_NOT_NULL_COLUMNS.has(`${tableName}.${columnName}`)
          ? "NO"
          : "YES",
      }))
  );
}

function createFakeClient({ applied = [], schemaRows, failOnSql } = {}) {
  const ledger = new Map(applied.map((row) => [row.filename, { ...row }]));
  const calls = [];

  return {
    calls,
    ledger,
    async query(text, values = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, values });

      if (failOnSql && sql.includes(failOnSql)) {
        throw new Error("database detail that must not escape");
      }
      if (sql.includes("FROM schema_migrations") && sql.includes("WHERE filename = $1")) {
        const row = ledger.get(values[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        ledger.set(values[0], {
          filename: values[0],
          checksum: values[1],
          execution_target: values[2],
        });
        return { rows: [] };
      }
      if (sql.includes("FROM information_schema.columns")) {
        return { rows: schemaRows || [] };
      }
      return { rows: [] };
    },
  };
}

function localTestTarget() {
  return {
    target: "local-test",
    database: { host: "127.0.0.1", database: "meetro_test_migrations" },
  };
}

test("migration runner refuses missing or unconfirmed targets", () => {
  const missing = inspectMigrationExecutionTarget({});
  assert.equal(missing.safe, false);
  assert.ok(missing.reasons.includes("DATABASE_URL is required."));
  assert.ok(missing.reasons.includes("MIGRATION_TARGET is required."));

  const unconfirmed = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@containers.railway.internal/railway",
    MIGRATION_TARGET: "staging",
    ALLOW_STAGING_MIGRATIONS: "true",
    CONFIRM_STAGING_DATABASE: "staging",
  });
  assert.equal(unconfirmed.safe, false);
  assert.ok(
    unconfirmed.reasons.includes(
      "CONFIRM_MIGRATION_TARGET must match MIGRATION_TARGET."
    )
  );
});

test("migration runner rejects production, production-like, and arbitrary targets", () => {
  const production = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@db.example.test/meetro_production",
    MIGRATION_TARGET: "production",
    CONFIRM_MIGRATION_TARGET: "production",
  });
  assert.equal(production.safe, false);
  assert.ok(
    production.reasons.includes(
      "Production migrations are not allowed by this runner."
    )
  );
  assert.ok(
    production.reasons.includes("Production-like database targets are not allowed.")
  );

  const disguisedProduction = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@db.example.test/meetro_prod",
    MIGRATION_TARGET: "staging",
    CONFIRM_MIGRATION_TARGET: "staging",
    ALLOW_STAGING_MIGRATIONS: "true",
    CONFIRM_STAGING_DATABASE: "staging",
    CONFIRM_PUBLIC_STAGING_DATABASE_URL: "true",
  });
  assert.equal(disguisedProduction.safe, false);
  assert.ok(
    disguisedProduction.reasons.includes(
      "Production-like database targets are not allowed."
    )
  );

  const arbitrary = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://localhost/meetro_dev",
    MIGRATION_TARGET: "development",
    CONFIRM_MIGRATION_TARGET: "development",
  });
  assert.equal(arbitrary.safe, false);
});

test("staging requires explicit confirmation and verified environment evidence", () => {
  const unsafe = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@containers.railway.internal/railway",
    MIGRATION_TARGET: "staging",
    CONFIRM_MIGRATION_TARGET: "staging",
  });
  assert.equal(unsafe.safe, false);
  assert.ok(
    unsafe.reasons.includes("ALLOW_STAGING_MIGRATIONS must be true for staging.")
  );
  assert.ok(
    unsafe.reasons.includes(
      "Staging migrations require Railway staging metadata or CONFIRM_STAGING_DATABASE=staging."
    )
  );

  const safe = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@containers.railway.internal/railway",
    MIGRATION_TARGET: "staging",
    CONFIRM_MIGRATION_TARGET: "staging",
    ALLOW_STAGING_MIGRATIONS: "true",
    CONFIRM_STAGING_DATABASE: "staging",
    RAILWAY_DEPLOYMENT_ID: "deployment-123",
  });
  assert.equal(safe.safe, true);
  assert.deepEqual(safe.database, {
    host: "containers.railway.internal",
    database: "railway",
  });
});

test("Railway private hosts require Railway runtime", () => {
  assert.equal(isRailwayPrivateDatabaseHost("postgres.railway.internal"), true);
  assert.equal(isRailwayPrivateDatabaseHost("db.proxy.rlwy.net"), false);
  assert.equal(isRailwayRuntime({ RAILWAY_DEPLOYMENT_ID: "deployment-123" }), true);

  const result = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@postgres.railway.internal/railway",
    MIGRATION_TARGET: "staging",
    CONFIRM_MIGRATION_TARGET: "staging",
    ALLOW_STAGING_MIGRATIONS: "true",
    CONFIRM_STAGING_DATABASE: "staging",
  });
  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes(
      "Railway private database hosts require execution inside Railway runtime."
    )
  );
});

test("public staging URLs require explicit local confirmation", () => {
  const unconfirmed = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@containers-us-west.railway.app/railway",
    MIGRATION_TARGET: "staging",
    CONFIRM_MIGRATION_TARGET: "staging",
    ALLOW_STAGING_MIGRATIONS: "true",
    CONFIRM_STAGING_DATABASE: "staging",
  });
  assert.equal(unconfirmed.safe, false);

  const confirmed = inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://app:secret@containers-us-west.railway.app/railway",
    MIGRATION_TARGET: "staging",
    CONFIRM_MIGRATION_TARGET: "staging",
    ALLOW_STAGING_MIGRATIONS: "true",
    CONFIRM_STAGING_DATABASE: "staging",
    CONFIRM_PUBLIC_STAGING_DATABASE_URL: "true",
  });
  assert.equal(confirmed.safe, true);
});

test("local test execution requires test mode, local host, and test-prefixed database", () => {
  const safe = inspectMigrationExecutionTarget({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://app:secret@127.0.0.1/meetro_test_schema",
    MIGRATION_TARGET: "local-test",
    CONFIRM_MIGRATION_TARGET: "local-test",
  });
  assert.equal(safe.safe, true);

  const unsafe = inspectMigrationExecutionTarget({
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://app:secret@db.example.test/meetro",
    MIGRATION_TARGET: "local-test",
    CONFIRM_MIGRATION_TARGET: "local-test",
  });
  assert.equal(unsafe.safe, false);
  assert.ok(unsafe.reasons.includes("local-test migrations require NODE_ENV=test."));
  assert.ok(unsafe.reasons.includes("local-test migrations require a local database host."));
});

test("target diagnostics and errors never expose credentials or full connection URLs", () => {
  const databaseUrl =
    "postgresql://meetro_user:super-secret-password@db.example.test/meetro_stage";
  assert.equal(
    redactDatabaseUrl(databaseUrl),
    "postgresql://db.example.test/meetro_stage"
  );

  const inspected = inspectMigrationExecutionTarget({
    DATABASE_URL: databaseUrl,
    MIGRATION_TARGET: "staging",
  });
  assert.equal(JSON.stringify(inspected).includes("super-secret-password"), false);
  assert.equal(JSON.stringify(inspected).includes("meetro_user"), false);

  assert.throws(
    () => assertSafeMigrationExecutionTarget({ DATABASE_URL: databaseUrl }),
    (error) =>
      !error.message.includes(databaseUrl) &&
      !error.message.includes("super-secret-password")
  );
});

test("migration discovery is deterministic, timestamped, and checksum-stable", () => {
  const first = getMigrationFiles(migrationsDirectory);
  const second = getMigrationFiles(migrationsDirectory);
  const filenames = first.map(({ filename }) => filename);

  assert.ok(filenames.includes(BASELINE_MIGRATION_FILENAME));
  assert.ok(filenames.includes(tokenVersionMigrationFilename));
  assert.ok(
    filenames.includes(
      messageConversationIdentityMigrationFilename
    )
  );
  assert.deepEqual(filenames, [...filenames].sort());
  assert.ok(filenames.indexOf(BASELINE_MIGRATION_FILENAME) < filenames.indexOf(tokenVersionMigrationFilename));
  assert.deepEqual(
    first.map(({ checksum: value }) => value),
    second.map(({ checksum: value }) => value)
  );
  assert.ok(first.every(({ checksum: value }) => /^[a-f0-9]{64}$/.test(value)));
});

test("discovery ignores non-SQL files and rejects malformed SQL names", () => {
  const directory = mkdtempSync(join(tmpdir(), "meetro-migrations-"));
  try {
    writeFileSync(join(directory, "README.md"), "ignored");
    writeFileSync(join(directory, "202607010001_valid.sql"), "SELECT 1;");
    assert.deepEqual(
      getMigrationFiles(directory).map(({ filename }) => filename),
      ["202607010001_valid.sql"]
    );

    writeFileSync(join(directory, "invalid-name.sql"), "SELECT 2;");
    assert.throws(() => getMigrationFiles(directory), /Malformed migration filename/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovery rejects duplicate timestamp prefixes", () => {
  const directory = mkdtempSync(join(tmpdir(), "meetro-migrations-"));
  try {
    writeFileSync(join(directory, "202607010001_first.sql"), "SELECT 1;");
    writeFileSync(join(directory, "202607010001_second.sql"), "SELECT 2;");
    assert.throws(() => getMigrationFiles(directory), /Duplicate migration timestamp/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema migration ledger is guarded and records checksum history", () => {
  assert.match(SCHEMA_MIGRATIONS_TABLE_SQL, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.match(SCHEMA_MIGRATIONS_TABLE_SQL, /filename TEXT NOT NULL UNIQUE/);
  assert.match(SCHEMA_MIGRATIONS_TABLE_SQL, /checksum TEXT NOT NULL/);
  assert.match(SCHEMA_MIGRATIONS_TABLE_SQL, /applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP/);
});

test("new migrations execute and record inside one transaction", async () => {
  const client = createFakeClient();
  const item = migration("202607140001_safe_change.sql", "SELECT 1;");
  const summary = await runMigrationCollection(client, [item], localTestTarget());
  const calls = client.calls.map(({ sql }) => sql);

  assert.deepEqual(summary, {
    success: true,
    target: "local-test",
    database: { host: "127.0.0.1", database: "meetro_test_migrations" },
    applied: [item.filename],
    skipped: [],
    failed: [],
  });
  assert.equal(calls[0], "BEGIN");
  assert.ok(calls.indexOf(item.sql) < calls.findIndex((sql) => sql.startsWith("INSERT INTO schema_migrations")));
  assert.ok(calls.findIndex((sql) => sql.startsWith("INSERT INTO schema_migrations")) < calls.indexOf("COMMIT"));
  assert.equal(client.ledger.get(item.filename).checksum, item.checksum);
});

test("matching applied migrations are skipped and checksum drift fails closed", async () => {
  const item = migration("202607140001_safe_change.sql", "SELECT 1;");
  const matchingClient = createFakeClient({
    applied: [{ filename: item.filename, checksum: item.checksum }],
  });
  const skipped = await runMigrationCollection(
    matchingClient,
    [item],
    localTestTarget()
  );
  assert.deepEqual(skipped.skipped, [item.filename]);
  assert.equal(matchingClient.calls.some(({ sql }) => sql === item.sql), false);

  const driftClient = createFakeClient({
    applied: [{ filename: item.filename, checksum: "different-checksum" }],
  });
  const drift = await runMigrationCollection(
    driftClient,
    [item],
    localTestTarget()
  );
  assert.equal(drift.success, false);
  assert.equal(drift.errorCode, "MIGRATION_CHECKSUM_MISMATCH");
  assert.deepEqual(drift.failed, [item.filename]);
  assert.equal(driftClient.calls.at(-1).sql, "ROLLBACK");
});

test("failed migrations roll back, are not recorded, and stop later migrations", async () => {
  const first = migration("202607140001_broken.sql", "BROKEN SQL;");
  const second = migration("202607140002_later.sql", "SELECT 2;");
  const client = createFakeClient({ failOnSql: "BROKEN SQL" });
  const summary = await runMigrationCollection(
    client,
    [first, second],
    localTestTarget()
  );

  assert.equal(summary.success, false);
  assert.equal(summary.errorCode, "MIGRATION_FAILED");
  assert.deepEqual(summary.failed, [first.filename]);
  assert.equal(client.ledger.size, 0);
  assert.equal(client.calls.some(({ sql }) => sql === second.sql), false);
  assert.equal(client.calls.at(-1).sql, "ROLLBACK");
  assert.equal(JSON.stringify(summary).includes("database detail"), false);
});

test("baseline schema requirements accept complete post-DDL metadata", async () => {
  const rows = completeBaselineSchemaRows();
  assert.deepEqual(validateBaselineSchemaRows(rows), { valid: true, issues: [] });

  const baseline = migration(BASELINE_MIGRATION_FILENAME, baselineSql);
  const client = createFakeClient({ schemaRows: rows });
  const summary = await runMigrationCollection(
    client,
    [baseline],
    localTestTarget()
  );
  assert.equal(summary.success, true);
  const calls = client.calls.map(({ sql }) => sql);
  assert.ok(calls.indexOf(normalizeSql(baselineSql)) < calls.findIndex((sql) => sql.includes("FROM information_schema.columns")));
  assert.ok(calls.findIndex((sql) => sql.includes("FROM information_schema.columns")) < calls.findIndex((sql) => sql.startsWith("INSERT INTO schema_migrations")));
});

test("partial or incompatible baseline schemas require manual review", async () => {
  const rows = completeBaselineSchemaRows().filter(
    (row) => !(row.table_name === "users" && row.column_name === "email")
  );
  const baseline = migration(BASELINE_MIGRATION_FILENAME, baselineSql);
  const client = createFakeClient({ schemaRows: rows });
  const summary = await runMigrationCollection(
    client,
    [baseline],
    localTestTarget()
  );

  assert.equal(summary.success, false);
  assert.equal(summary.errorCode, "BASELINE_SCHEMA_MISMATCH");
  assert.equal(client.ledger.has(BASELINE_MIGRATION_FILENAME), false);
  assert.equal(client.calls.at(-1).sql, "ROLLBACK");

  const wrongType = completeBaselineSchemaRows();
  wrongType.find(
    (row) => row.table_name === "messages" && row.column_name === "workflow_payload"
  ).data_type = "text";
  const validation = validateBaselineSchemaRows(wrongType);
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.includes("Incompatible type for messages.workflow_payload."));

  const nullableRequiredColumn = completeBaselineSchemaRows();
  nullableRequiredColumn.find(
    (row) => row.table_name === "users" && row.column_name === "password_hash"
  ).is_nullable = "YES";
  const nullableValidation = validateBaselineSchemaRows(nullableRequiredColumn);
  assert.equal(nullableValidation.valid, false);
  assert.ok(
    nullableValidation.issues.includes(
      "Required column users.password_hash must be NOT NULL."
    )
  );
});

test("baseline remains additive and contains no destructive reset commands", () => {
  assert.doesNotMatch(
    baselineSql,
    /\b(?:DROP\s+TABLE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\b/i
  );
  assert.match(baselineSql, /CREATE TABLE IF NOT EXISTS users/);
  for (const tableName of Object.keys(BASELINE_SCHEMA_REQUIREMENTS).filter(
    (name) => name !== "schema_migrations"
  )) {
    assert.match(baselineSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}`));
  }
});

test("token-version migration follows baseline and changes only users.token_version", () => {
  const migrations = getMigrationFiles(migrationsDirectory);
  const tokenVersion = migrations.find(
    ({ filename }) => filename === tokenVersionMigrationFilename
  );
  assert.ok(tokenVersion);
  assert.match(tokenVersion.sql, /ALTER TABLE users/i);
  assert.match(
    tokenVersion.sql,
    /ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0/i
  );
  assert.equal((tokenVersion.sql.match(/ALTER TABLE/gi) || []).length, 1);
  assert.doesNotMatch(
    tokenVersion.sql,
    /password_hash|\b(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT|CREATE TABLE)\b/i
  );
});

test("request-photo migration is additive and changes only posts.request_photos", () => {
  const migrations = getMigrationFiles(migrationsDirectory);
  const requestPhotos = migrations.find(
    ({ filename }) => filename === requestPhotosMigrationFilename
  );
  assert.ok(requestPhotos);
  assert.match(requestPhotos.sql, /ALTER TABLE posts/i);
  assert.match(
    requestPhotos.sql,
    /ADD COLUMN IF NOT EXISTS request_photos JSONB NOT NULL DEFAULT '\[\]'::jsonb/i
  );
  assert.equal((requestPhotos.sql.match(/ALTER TABLE/gi) || []).length, 1);
  assert.doesNotMatch(
    requestPhotos.sql,
    /\b(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT|CREATE TABLE)\b/i
  );
});

test("request lifecycle migration is additive, constrained, and scoped to posts", () => {
  const migrations = getMigrationFiles(migrationsDirectory);
  const lifecycle = migrations.find(
    ({ filename }) => filename === requestLifecycleMigrationFilename
  );
  assert.ok(lifecycle);
  assert.match(lifecycle.sql, /ALTER TABLE posts/i);
  assert.match(lifecycle.sql, /ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'/i);
  assert.match(lifecycle.sql, /CHECK \(status IN \('open', 'cancelled'\)\)/i);
  assert.match(lifecycle.sql, /CREATE INDEX IF NOT EXISTS idx_posts_open_service_projection/i);
  assert.doesNotMatch(lifecycle.sql, /\b(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b/i);
});

test("README and package scripts match governed execution boundaries", () => {
  const readme = readFileSync(join(migrationsDirectory, "README.md"), "utf8");
  assert.match(readme, /migrate:test/);
  assert.match(readme, /migrate:staging/);
  assert.match(readme, /Production is not an allowed target/);
  assert.match(readme, /checksum drift fails/i);
  assert.match(readme, /ROLLBACK/);
  assert.match(readme, /baseline schema parity/i);
  assert.match(readme, /do not connect to or mutate remote databases/);

  assert.equal(packageJson.scripts["migrate:test"].includes("local-test"), true);
  assert.equal(packageJson.scripts["migrate:staging"], "MIGRATION_TARGET=staging node scripts/run-migrations.js");
  assert.equal(packageJson.scripts["test:migrations"], "node --test test/migrationRunner.test.js");
  assert.equal(
    Object.keys(packageJson.scripts).some((name) => /production/i.test(name)),
    false
  );
  assert.equal(packageJson.scripts.test.includes("migrat"), false);
});



test("message conversation identity migration is additive, nullable, and conversation scoped", () => {
  const migrations = getMigrationFiles(migrationsDirectory);
  const identityMigration = migrations.find(
    ({ filename }) =>
      filename ===
      messageConversationIdentityMigrationFilename
  );

  assert.ok(identityMigration);

  assert.match(
    identityMigration.sql,
    /ALTER TABLE messages/i
  );

  assert.match(
    identityMigration.sql,
    /ADD COLUMN IF NOT EXISTS conversation_id INTEGER/i
  );

  assert.match(
    identityMigration.sql,
    /REFERENCES conversations\(id\)\s+ON DELETE RESTRICT/i
  );

  assert.match(
    identityMigration.sql,
    /CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_id_idx/i
  );

  assert.match(
    identityMigration.sql,
    /ON messages\s*\(\s*conversation_id\s*,\s*created_at ASC\s*,\s*id ASC\s*\)/i
  );

  assert.doesNotMatch(
    identityMigration.sql,
    /conversation_id INTEGER NOT NULL/i
  );

  assert.doesNotMatch(
    identityMigration.sql,
    /\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)\b/i
  );

  assert.doesNotMatch(
    identityMigration.sql,
    /\bDELETE\s+FROM\b/i
  );

  assert.doesNotMatch(
    identityMigration.sql,
    /\bTRUNCATE\b/i
  );

  assert.doesNotMatch(
    identityMigration.sql,
    /\bUPDATE\s+messages\b/i
  );

  assert.doesNotMatch(
    identityMigration.sql,
    /\bINSERT\s+INTO\s+messages\b/i
  );
});

test("application startup does not execute migrations", () => {
  const indexSource = readFileSync(join(repositoryRoot, "index.js"), "utf8");
  assert.doesNotMatch(indexSource, /run-migrations|runMigrations|schema_migrations/);
});
