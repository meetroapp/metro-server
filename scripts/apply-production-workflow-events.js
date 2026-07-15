#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  inspectWorkflowEventsSchema,
} = require("./workflow-events-schema");

const MIGRATION_FILENAME = "202607140002_create_workflow_events.sql";
const EXPECTED_CHECKSUM =
  "c67a83e775116a13c36ee2cf95cf66d3a43e069b03eb32b61aa15ca13bc3b7cb";
const CONFIRMATION_FLAG = "--confirm-production-workflow-events";
const EXECUTION_FLAG = "--execute";
const FINAL_CONFIRMATION_FLAG = "--confirm-additive-workflow-events-table";
const MIGRATION_ARG = `--migration=${MIGRATION_FILENAME}`;
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_FILENAME);
const AUDIT_TARGET = "production-governed-additive";
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
  if (env.ALLOW_PRODUCTION_WORKFLOW_EVENTS_MIGRATION !== "true") {
    reasons.push("Explicit production workflow-event migration authorization is required.");
  }
  if (env.CONFIRM_PRODUCTION_WORKFLOW_EVENTS !== "production") {
    reasons.push("Production workflow-event confirmation is required.");
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
  const executableSource = source.replace(/ON\s+DELETE\s+CASCADE/gi, "");
  if (/\b(DROP|DELETE|TRUNCATE|ALTER|UPDATE|INSERT)\b/i.test(executableSource)) {
    const error = new Error("Destructive or mutating SQL is forbidden.");
    error.code = "DESTRUCTIVE_SQL_FORBIDDEN";
    throw error;
  }
  const statements = source
    .split(";")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (
    statements.length !== 2 ||
    !/^CREATE TABLE IF NOT EXISTS workflow_events \(/i.test(statements[0]) ||
    !/^CREATE INDEX IF NOT EXISTS workflow_events_quote_request_id_created_at_idx ON workflow_events\(quote_request_id, created_at ASC\)$/i.test(
      statements[1]
    )
  ) {
    const error = new Error("Migration scope does not match workflow-event storage.");
    error.code = "MIGRATION_SCOPE_MISMATCH";
    throw error;
  }
  return true;
}

function loadMigration(filePath = MIGRATION_PATH) {
  const sql = fs.readFileSync(filePath, "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  if (path.basename(filePath) !== MIGRATION_FILENAME) {
    const error = new Error("Unexpected migration filename.");
    error.code = "MIGRATION_FILENAME_MISMATCH";
    throw error;
  }
  if (checksum !== EXPECTED_CHECKSUM) {
    const error = new Error("Migration checksum does not match the reviewed file.");
    error.code = "MIGRATION_CHECKSUM_MISMATCH";
    throw error;
  }
  validateMigrationSql(sql);
  return { filename: MIGRATION_FILENAME, checksum, sql };
}

async function getUnrelatedSchemaFingerprint(client) {
  const result = await client.query(`
    SELECT md5(COALESCE(string_agg(item, '|' ORDER BY item), '')) AS fingerprint
    FROM (
      SELECT table_name || ':' || column_name || ':' || data_type || ':' || is_nullable AS item
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT IN ('workflow_events', 'schema_migrations')
    ) inventory
  `);
  return String(result.rows[0]?.fingerprint || "");
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

async function applyProductionWorkflowEvents(client, migration) {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const before = await inspectWorkflowEventsSchema(client);
    const unrelatedBefore = await getUnrelatedSchemaFingerprint(client);
    const existingLedger = await getLedgerRecord(client);
    if (existingLedger && existingLedger.checksum !== migration.checksum) {
      const error = new Error("Recorded migration checksum does not match.");
      error.code = "MIGRATION_CHECKSUM_MISMATCH";
      throw error;
    }
    if (existingLedger && !before.exists) {
      const error = new Error("Ledger and schema state do not agree.");
      error.code = "MIGRATION_AUDIT_FAILED";
      throw error;
    }

    let applied = false;
    if (!before.exists) {
      await client.query(migration.sql);
      applied = true;
    }

    const after = await inspectWorkflowEventsSchema(client);
    const unrelatedAfter = await getUnrelatedSchemaFingerprint(client);
    if (
      !after.valid ||
      after.rowCount !== before.rowCount ||
      unrelatedAfter !== unrelatedBefore
    ) {
      const error = new Error("Post-migration verification failed.");
      error.code = "POST_MIGRATION_VERIFICATION_FAILED";
      throw error;
    }

    await client.query(LEDGER_SQL);
    await client.query(
      `
      INSERT INTO schema_migrations (filename, checksum, execution_target)
      VALUES ($1, $2, $3)
      ON CONFLICT (filename) DO NOTHING
      `,
      [migration.filename, migration.checksum, AUDIT_TARGET]
    );
    const recorded = await getLedgerRecord(client);
    if (!recorded || recorded.checksum !== migration.checksum) {
      const error = new Error("Migration audit record verification failed.");
      error.code = "MIGRATION_AUDIT_FAILED";
      throw error;
    }

    await client.query("COMMIT");
    return {
      applied,
      filename: migration.filename,
      checksum: migration.checksum,
      schemaValid: after.valid,
      rowCountBefore: before.rowCount,
      rowCountAfter: after.rowCount,
      unrelatedSchemaUnchanged: unrelatedAfter === unrelatedBefore,
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
    "MIGRATION_FILENAME_MISMATCH",
    "MIGRATION_CHECKSUM_MISMATCH",
    "DESTRUCTIVE_SQL_FORBIDDEN",
    "MIGRATION_SCOPE_MISMATCH",
    "WORKFLOW_EVENTS_PREREQUISITE_MISSING",
    "WORKFLOW_EVENTS_RELATION_CONFLICT",
    "WORKFLOW_EVENTS_SCHEMA_CONFLICT",
    "POST_MIGRATION_VERIFICATION_FAILED",
    "MIGRATION_AUDIT_FAILED",
  ]);
  return {
    status: "failed",
    errorCode: safeCodes.has(error?.code)
      ? error.code
      : "PRODUCTION_MIGRATION_FAILED",
  };
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
    const schema = await inspectWorkflowEventsSchema(pool);
    const ledger = await getLedgerRecord(pool);
    console.log(
      JSON.stringify({
        status: "precheck_passed",
        action: authorization.action,
        target: authorization.target,
        migration: { filename: migration.filename, checksum: migration.checksum },
        schema,
        ledgerPresent: Boolean(ledger),
      })
    );
    if (authorization.action !== "execute") return 0;

    console.log(
      JSON.stringify({
        status: "final_confirmation_accepted",
        operation: "create workflow-event storage and record only this migration",
      })
    );
    const client = await pool.connect();
    let result;
    try {
      result = await applyProductionWorkflowEvents(client, migration);
    } finally {
      client.release();
    }
    console.log(JSON.stringify({ status: "success", ...result }));
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
  CONFIRMATION_FLAG,
  EXECUTION_FLAG,
  EXPECTED_CHECKSUM,
  FINAL_CONFIRMATION_FLAG,
  MIGRATION_ARG,
  MIGRATION_FILENAME,
  applyProductionWorkflowEvents,
  getLedgerRecord,
  getSanitizedTarget,
  getUnrelatedSchemaFingerprint,
  inspectAuthorization,
  loadMigration,
  main,
  toSafeError,
  validateMigrationSql,
};
