#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILENAME = "202607200001_add_post_request_lifecycle.sql";
const EXPECTED_CHECKSUM =
  "805381ae15c586de9a0795e27fde589f07ea74ab998694a74dfd1127386cd8cb";
const CONFIRMATION_FLAG = "--confirm-production-request-lifecycle";
const EXECUTION_FLAG = "--execute";
const FINAL_CONFIRMATION_FLAG = "--confirm-additive-request-lifecycle";
const MIGRATION_ARG = `--migration=${MIGRATION_FILENAME}`;
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_FILENAME);
const AUDIT_TARGET = "production-governed-additive";
const TARGET_COLUMNS = Object.freeze([
  "request_category",
  "service_domain",
  "service_specialty",
  "unit_number",
  "access_notes",
  "status",
  "updated_at",
  "cancelled_at",
]);
const TARGET_CONSTRAINT = "posts_request_status_check";
const TARGET_CONSTRAINTS = Object.freeze([
  TARGET_CONSTRAINT,
  "posts_access_notes_not_null",
  "posts_status_not_null",
  "posts_unit_number_not_null",
  "posts_updated_at_not_null",
]);
const TARGET_INDEX = "idx_posts_open_service_projection";
const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    execution_target TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

function parseDatabaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return {
      valid: ["postgres:", "postgresql:"].includes(url.protocol),
      host: url.hostname,
      database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    };
  } catch {
    return { valid: false, host: "", database: "" };
  }
}

function getSanitizedTarget(databaseUrl) {
  const parsed = parseDatabaseUrl(databaseUrl);
  return parsed.valid
    ? { host: parsed.host, database: parsed.database }
    : { host: "unknown", database: "unknown" };
}

function inspectAuthorization({ env = process.env, args = process.argv.slice(2) } = {}) {
  const reasons = [];
  const environment = String(
    env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || ""
  ).trim();
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  const executionRequested = args.includes(EXECUTION_FLAG);

  if (!parsed.valid) reasons.push("A valid PostgreSQL DATABASE_URL is required.");
  if (env.MIGRATION_TARGET !== "production") {
    reasons.push("MIGRATION_TARGET must be production.");
  }
  if (env.CONFIRM_MIGRATION_TARGET !== "production") {
    reasons.push("CONFIRM_MIGRATION_TARGET must be production.");
  }
  if (env.CONFIRM_PRODUCTION_DATABASE !== "production") {
    reasons.push("The production database target must be explicitly confirmed.");
  }
  if (env.ALLOW_PRODUCTION_REQUEST_LIFECYCLE_MIGRATION !== "true") {
    reasons.push("Explicit production request-lifecycle migration authorization is required.");
  }
  if (env.CONFIRM_PRODUCTION_REQUEST_LIFECYCLE !== "production") {
    reasons.push("Production request-lifecycle confirmation is required.");
  }
  if (!args.includes(CONFIRMATION_FLAG)) reasons.push("CLI confirmation is required.");
  if (!args.includes(MIGRATION_ARG)) reasons.push("The exact migration filename is required.");
  if (!/production/i.test(environment)) {
    reasons.push("Verified production environment metadata is required.");
  }
  if (/staging/i.test(`${environment} ${parsed.host} ${parsed.database}`)) {
    reasons.push("Staging targets are forbidden.");
  }
  if (executionRequested && !args.includes(FINAL_CONFIRMATION_FLAG)) {
    reasons.push("Final additive-migration confirmation is required.");
  }

  return {
    authorized: reasons.length === 0,
    reasons,
    action: executionRequested ? "execute" : "precheck",
    target: getSanitizedTarget(env.DATABASE_URL),
  };
}

function validateMigrationSql(sql) {
  const source = String(sql || "").replace(/--[^\n]*/g, "");
  if (/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i.test(source)) {
    const error = new Error("Destructive or data-mutating SQL is forbidden.");
    error.code = "DESTRUCTIVE_SQL_FORBIDDEN";
    throw error;
  }
  const normalized = source.replace(/\s+/g, " ").trim();
  const required = [
    "ALTER TABLE posts",
    "ADD COLUMN IF NOT EXISTS request_category TEXT",
    "ADD COLUMN IF NOT EXISTS service_domain TEXT",
    "ADD COLUMN IF NOT EXISTS service_specialty TEXT",
    "ADD COLUMN IF NOT EXISTS unit_number TEXT NOT NULL DEFAULT ''",
    "ADD COLUMN IF NOT EXISTS access_notes TEXT NOT NULL DEFAULT ''",
    "ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'",
    "ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP",
    "ADD CONSTRAINT posts_request_status_check CHECK (status IN ('open', 'cancelled'))",
    "CREATE INDEX IF NOT EXISTS idx_posts_open_service_projection ON posts (status, service_domain, service_specialty, created_at DESC)",
  ];
  if (
    required.some((fragment) => !normalized.includes(fragment)) ||
    (normalized.match(/\bALTER TABLE posts\b/g) || []).length !== 2 ||
    (normalized.match(/\bCREATE INDEX IF NOT EXISTS\b/g) || []).length !== 1
  ) {
    const error = new Error("Migration scope mismatch.");
    error.code = "MIGRATION_SCOPE_MISMATCH";
    throw error;
  }
  return true;
}

function loadMigration(filePath = MIGRATION_PATH) {
  const sql = fs.readFileSync(filePath, "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  if (path.basename(filePath) !== MIGRATION_FILENAME) {
    const error = new Error("Migration filename mismatch.");
    error.code = "MIGRATION_FILENAME_MISMATCH";
    throw error;
  }
  if (checksum !== EXPECTED_CHECKSUM) {
    const error = new Error("Migration checksum mismatch.");
    error.code = "MIGRATION_CHECKSUM_MISMATCH";
    throw error;
  }
  validateMigrationSql(sql);
  return { filename: MIGRATION_FILENAME, checksum, sql };
}

function normalizedDefault(value) {
  return String(value || "").replace(/[()\s]/g, "").toLowerCase();
}

async function inspectSchema(client) {
  const table = await client.query(
    "SELECT to_regclass('public.posts') IS NOT NULL AS table_exists"
  );
  if (!table.rows[0]?.table_exists) {
    const error = new Error("Posts table missing.");
    error.code = "POSTS_TABLE_MISSING";
    throw error;
  }
  const columns = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'posts'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [TARGET_COLUMNS]);
  const constraint = await client.query(`
    SELECT contype, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.posts'::regclass
      AND conname = $1
  `, [TARGET_CONSTRAINT]);
  const index = await client.query(`
    SELECT indexes.indexdef, catalog.indisvalid, catalog.indisready
    FROM pg_indexes indexes
    JOIN pg_class relation ON relation.relname = indexes.indexname
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      AND namespace.nspname = indexes.schemaname
    JOIN pg_index catalog ON catalog.indexrelid = relation.oid
    WHERE indexes.schemaname = 'public'
      AND indexes.tablename = 'posts'
      AND indexes.indexname = $1
  `, [TARGET_INDEX]);
  const byName = new Map(columns.rows.map((column) => [column.column_name, column]));
  const nullableTextValid = ["request_category", "service_domain", "service_specialty"]
    .every((name) => byName.get(name)?.data_type === "text" && byName.get(name)?.is_nullable === "YES");
  const privateTextValid = ["unit_number", "access_notes"].every((name) => {
    const column = byName.get(name);
    return column?.data_type === "text" && column?.is_nullable === "NO" &&
      normalizedDefault(column.column_default) === "''::text";
  });
  const status = byName.get("status");
  const updatedAt = byName.get("updated_at");
  const cancelledAt = byName.get("cancelled_at");
  const constraintDefinition = String(constraint.rows[0]?.definition || "").toLowerCase();
  const indexDefinition = String(index.rows[0]?.indexdef || "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const complete =
    columns.rows.length === TARGET_COLUMNS.length &&
    nullableTextValid &&
    privateTextValid &&
    status?.data_type === "text" &&
    status?.is_nullable === "NO" &&
    normalizedDefault(status.column_default) === "'open'::text" &&
    updatedAt?.data_type === "timestamp without time zone" &&
    updatedAt?.is_nullable === "NO" &&
    normalizedDefault(updatedAt.column_default) === "current_timestamp" &&
    cancelledAt?.data_type === "timestamp without time zone" &&
    cancelledAt?.is_nullable === "YES" &&
    constraint.rows.length === 1 &&
    constraint.rows[0]?.contype === "c" &&
    ["status", "open", "cancelled"].every((value) => constraintDefinition.includes(value)) &&
    index.rows.length === 1 &&
    index.rows[0]?.indisvalid === true &&
    index.rows[0]?.indisready === true &&
    indexDefinition.includes(" on public.posts ") &&
    indexDefinition.includes("(status, service_domain, service_specialty, created_at desc)");
  const objectCount = columns.rows.length + constraint.rows.length + index.rows.length;
  if (objectCount > 0 && !complete) {
    const error = new Error("Request lifecycle schema is partial or incompatible.");
    error.code = "REQUEST_LIFECYCLE_SCHEMA_CONFLICT";
    throw error;
  }
  const count = await client.query("SELECT COUNT(*)::bigint AS count FROM posts");
  let invalidStatusCount = 0;
  let statusSummary = { totalCount: 0, invalidCount: 0, nullCount: 0 };
  if (complete) {
    const invalid = await client.query(`
      SELECT COUNT(*)::bigint AS total_count,
        COUNT(*) FILTER (
        WHERE status IS NULL OR status NOT IN ('open', 'cancelled')
        )::bigint AS invalid_count,
        COUNT(*) FILTER (WHERE status IS NULL)::bigint AS null_count
      FROM posts
    `);
    invalidStatusCount = Number(invalid.rows[0]?.invalid_count || 0);
    statusSummary = {
      totalCount: Number(invalid.rows[0]?.total_count || 0),
      invalidCount: invalidStatusCount,
      nullCount: Number(invalid.rows[0]?.null_count || 0),
    };
  }
  return {
    tableExists: true,
    lifecycleExists: complete,
    lifecycleValid: complete,
    postCount: Number(count.rows[0]?.count || 0),
    invalidStatusCount,
    statusSummary,
    columnsPresent: columns.rows.map((column) => column.column_name).sort(),
    columnInventory: columns.rows.map((column) => ({
      name: column.column_name,
      dataType: column.data_type,
      nullable: column.is_nullable,
      defaultValue: column.column_default,
    })),
    constraintPresent: constraint.rows.length === 1,
    constraintDefinition: constraint.rows[0]?.definition || null,
    indexPresent: index.rows.length === 1,
    indexDefinition: index.rows[0]?.indexdef || null,
    indexValid: index.rows[0]?.indisvalid === true,
    indexReady: index.rows[0]?.indisready === true,
  };
}

async function getUnrelatedSchemaFingerprint(client) {
  const snapshot = await getUnrelatedSchemaSnapshot(client);
  return snapshot.fingerprint;
}

function fingerprintInventory(inventory) {
  return crypto.createHash("sha256").update(inventory.join("|")).digest("hex");
}

function diffInventory(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((item) => !beforeSet.has(item)),
    removed: before.filter((item) => !afterSet.has(item)),
  };
}

async function getUnrelatedSchemaSnapshot(client) {
  const result = await client.query(`
    SELECT item
    FROM (
      SELECT 'column:' || table_name || ':' || column_name || ':' || data_type || ':' || is_nullable AS item
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name <> 'schema_migrations'
        AND NOT (table_name = 'posts' AND column_name = ANY($1::text[]))
      UNION ALL
      SELECT 'constraint:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND NOT (
          conrelid = 'public.posts'::regclass
          AND conname = ANY($2::text[])
        )
      UNION ALL
      SELECT 'index:' || tablename || ':' || indexname || ':' || indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname <> $3
    ) inventory
    ORDER BY item
  `, [TARGET_COLUMNS, TARGET_CONSTRAINTS, TARGET_INDEX]);
  const inventory = result.rows.map((row) => String(row.item));
  return { inventory, fingerprint: fingerprintInventory(inventory) };
}

function buildVerificationDiagnostics({ before, after, unrelatedBefore, unrelatedAfter }) {
  const differences = diffInventory(unrelatedBefore.inventory, unrelatedAfter.inventory);
  return [
    {
      invariant: "lifecycle_object_inventory",
      expected: true,
      actual: after.lifecycleValid,
      passed: after.lifecycleValid === true,
      method: "information_schema.columns, pg_constraint, pg_indexes, pg_index",
      visibility: "inside_migration_transaction",
    },
    {
      invariant: "existing_post_count_preserved",
      expected: before.postCount,
      actual: after.postCount,
      passed: after.postCount === before.postCount,
      method: "SELECT COUNT(*) FROM posts",
      visibility: "inside_migration_transaction",
    },
    {
      invariant: "invalid_lifecycle_status_count",
      expected: 0,
      actual: after.invalidStatusCount,
      passed: after.invalidStatusCount === 0,
      method: "status null-or-not-in-open-cancelled aggregate",
      visibility: "inside_migration_transaction",
    },
    {
      invariant: "unrelated_schema_fingerprint_preserved",
      expected: unrelatedBefore.fingerprint,
      actual: unrelatedAfter.fingerprint,
      passed: unrelatedAfter.fingerprint === unrelatedBefore.fingerprint,
      method: "ordered public column, constraint, and index inventory",
      visibility: "inside_migration_transaction",
      differences,
    },
  ];
}

async function getLedgerRecord(client) {
  const table = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_exists"
  );
  if (!table.rows[0]?.ledger_exists) return null;
  const result = await client.query(
    "SELECT filename, checksum, execution_target FROM schema_migrations WHERE filename = $1",
    [MIGRATION_FILENAME]
  );
  if (result.rows.length > 1) {
    const error = new Error("Duplicate migration ledger records exist.");
    error.code = "MIGRATION_AUDIT_FAILED";
    throw error;
  }
  return result.rows[0] || null;
}

async function applyProductionRequestLifecycle(client, migration) {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const before = await inspectSchema(client);
    const unrelatedBefore = await getUnrelatedSchemaSnapshot(client);
    const existingLedger = await getLedgerRecord(client);
    if (existingLedger && existingLedger.checksum !== migration.checksum) {
      const error = new Error("Recorded migration checksum does not match.");
      error.code = "MIGRATION_CHECKSUM_MISMATCH";
      throw error;
    }
    if (before.lifecycleExists !== Boolean(existingLedger)) {
      const error = new Error("Ledger and schema state do not agree.");
      error.code = "MIGRATION_AUDIT_FAILED";
      throw error;
    }

    let applied = false;
    if (!before.lifecycleExists) {
      await client.query(migration.sql);
      applied = true;
    }

    const after = await inspectSchema(client);
    const unrelatedAfter = await getUnrelatedSchemaSnapshot(client);
    const verification = buildVerificationDiagnostics({
      before,
      after,
      unrelatedBefore,
      unrelatedAfter,
    });
    if (verification.some((invariant) => !invariant.passed)) {
      const error = new Error("Post-migration verification failed.");
      error.code = "POST_MIGRATION_VERIFICATION_FAILED";
      error.diagnostics = verification;
      throw error;
    }

    await client.query(LEDGER_SQL);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, execution_target)
       VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO NOTHING`,
      [migration.filename, migration.checksum, AUDIT_TARGET]
    );
    const recorded = await getLedgerRecord(client);
    if (
      !recorded ||
      recorded.checksum !== migration.checksum ||
      recorded.execution_target !== AUDIT_TARGET
    ) {
      const error = new Error("Migration audit failed.");
      error.code = "MIGRATION_AUDIT_FAILED";
      throw error;
    }

    await client.query("COMMIT");
    return {
      applied,
      filename: migration.filename,
      checksum: migration.checksum,
      postCountBefore: before.postCount,
      postCountAfter: after.postCount,
      lifecycleValid: after.lifecycleValid,
      invalidStatusCount: after.invalidStatusCount,
      columnsPresent: after.columnsPresent,
      constraintPresent: after.constraintPresent,
      indexPresent: after.indexPresent,
      unrelatedSchemaUnchanged:
        unrelatedAfter.fingerprint === unrelatedBefore.fingerprint,
      verification,
      auditTarget: recorded.execution_target,
    };
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original safe failure.
      }
    }
    throw error;
  }
}

function toSafeError(error) {
  const safeCodes = new Set([
    "MIGRATION_SCOPE_MISMATCH",
    "MIGRATION_FILENAME_MISMATCH",
    "MIGRATION_CHECKSUM_MISMATCH",
    "DESTRUCTIVE_SQL_FORBIDDEN",
    "POSTS_TABLE_MISSING",
    "REQUEST_LIFECYCLE_SCHEMA_CONFLICT",
    "POST_MIGRATION_VERIFICATION_FAILED",
    "MIGRATION_AUDIT_FAILED",
  ]);
  const result = {
    status: "failed",
    errorCode: safeCodes.has(error?.code)
      ? error.code
      : "PRODUCTION_MIGRATION_FAILED",
  };
  if (Array.isArray(error?.diagnostics)) result.diagnostics = error.diagnostics;
  return result;
}

async function main({ env = process.env, args = process.argv.slice(2) } = {}) {
  const authorization = inspectAuthorization({ env, args });
  if (!authorization.authorized) {
    console.error(JSON.stringify({ status: "blocked", reasons: authorization.reasons }));
    return 1;
  }

  const migration = loadMigration();
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const schema = await inspectSchema(pool);
    const ledger = await getLedgerRecord(pool);
    console.log(JSON.stringify({
      status: "precheck_passed",
      action: authorization.action,
      target: authorization.target,
      migration: { filename: migration.filename, checksum: migration.checksum },
      additive: true,
      schema,
      ledgerPresent: Boolean(ledger),
    }));
    if (authorization.action !== "execute") return 0;

    const client = await pool.connect();
    try {
      const result = await applyProductionRequestLifecycle(client, migration);
      console.log(JSON.stringify({ status: "success", ...result }));
    } finally {
      client.release();
    }
    return 0;
  } catch (error) {
    console.error(JSON.stringify(toSafeError(error)));
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  AUDIT_TARGET,
  CONFIRMATION_FLAG,
  EXECUTION_FLAG,
  EXPECTED_CHECKSUM,
  FINAL_CONFIRMATION_FLAG,
  MIGRATION_ARG,
  MIGRATION_FILENAME,
  TARGET_COLUMNS,
  TARGET_CONSTRAINTS,
  applyProductionRequestLifecycle,
  buildVerificationDiagnostics,
  diffInventory,
  fingerprintInventory,
  getLedgerRecord,
  getSanitizedTarget,
  getUnrelatedSchemaFingerprint,
  getUnrelatedSchemaSnapshot,
  inspectAuthorization,
  inspectSchema,
  loadMigration,
  main,
  toSafeError,
  validateMigrationSql,
};
