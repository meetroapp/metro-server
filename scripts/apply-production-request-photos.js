#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILENAME = "202607190002_add_post_request_photos.sql";
const EXPECTED_CHECKSUM =
  "bacbb50f6f4127fe035b11a35face48b662669c0ce22909bedfd14a3e739bfa0";
const CONFIRMATION_FLAG = "--confirm-production-request-photos";
const EXECUTION_FLAG = "--execute";
const FINAL_CONFIRMATION_FLAG = "--confirm-additive-post-request-photos";
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
  if (env.CONFIRM_PRODUCTION_DATABASE !== "production") {
    reasons.push("The production database target must be explicitly confirmed.");
  }
  if (env.ALLOW_PRODUCTION_REQUEST_PHOTOS_MIGRATION !== "true") {
    reasons.push("Explicit production request-photo migration authorization is required.");
  }
  if (env.CONFIRM_PRODUCTION_REQUEST_PHOTOS !== "production") {
    reasons.push("Production request-photo confirmation is required.");
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
  const statement = String(sql || "")
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
  if (
    !/^ALTER TABLE posts ADD COLUMN IF NOT EXISTS request_photos JSONB NOT NULL DEFAULT '\[\]'::jsonb$/i.test(
      statement
    )
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

function isCorrectColumn(column) {
  const defaultValue = String(column?.column_default || "").replace(/[()\s]/g, "");
  return (
    column?.data_type === "jsonb" &&
    column?.is_nullable === "NO" &&
    defaultValue === "'[]'::jsonb"
  );
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
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'posts'
      AND column_name = 'request_photos'
  `);
  const column = columns.rows[0] || null;
  if (column && !isCorrectColumn(column)) {
    const error = new Error("Request-photo column conflict.");
    error.code = "REQUEST_PHOTOS_COLUMN_CONFLICT";
    throw error;
  }
  const count = await client.query("SELECT COUNT(*)::bigint AS count FROM posts");
  let invalidCount = 0;
  if (column) {
    const invalid = await client.query(`
      SELECT COUNT(*) FILTER (
        WHERE request_photos IS NULL
           OR jsonb_typeof(request_photos) <> 'array'
      )::bigint AS invalid_count
      FROM posts
    `);
    invalidCount = Number(invalid.rows[0]?.invalid_count || 0);
  }
  return {
    tableExists: true,
    columnExists: Boolean(column),
    columnValid: isCorrectColumn(column),
    postCount: Number(count.rows[0]?.count || 0),
    invalidCount,
  };
}

async function getUnrelatedSchemaFingerprint(client) {
  const result = await client.query(`
    SELECT md5(COALESCE(string_agg(item, '|' ORDER BY item), '')) AS fingerprint
    FROM (
      SELECT table_name || ':' || column_name || ':' || data_type || ':' || is_nullable AS item
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name <> 'schema_migrations'
        AND NOT (table_name = 'posts' AND column_name = 'request_photos')
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

async function applyProductionRequestPhotos(client, migration) {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const before = await inspectSchema(client);
    const unrelatedBefore = await getUnrelatedSchemaFingerprint(client);
    const existingLedger = await getLedgerRecord(client);
    if (existingLedger && existingLedger.checksum !== migration.checksum) {
      const error = new Error("Recorded migration checksum does not match.");
      error.code = "MIGRATION_CHECKSUM_MISMATCH";
      throw error;
    }
    if (before.columnExists !== Boolean(existingLedger)) {
      const error = new Error("Ledger and schema state do not agree.");
      error.code = "MIGRATION_AUDIT_FAILED";
      throw error;
    }

    let applied = false;
    if (!before.columnExists) {
      await client.query(migration.sql);
      applied = true;
    }

    const after = await inspectSchema(client);
    const unrelatedAfter = await getUnrelatedSchemaFingerprint(client);
    if (
      !after.columnValid ||
      after.invalidCount !== 0 ||
      after.postCount !== before.postCount ||
      unrelatedAfter !== unrelatedBefore
    ) {
      const error = new Error("Post-migration verification failed.");
      error.code = "POST_MIGRATION_VERIFICATION_FAILED";
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
      columnValid: after.columnValid,
      invalidCount: after.invalidCount,
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
    "MIGRATION_SCOPE_MISMATCH",
    "MIGRATION_FILENAME_MISMATCH",
    "MIGRATION_CHECKSUM_MISMATCH",
    "POSTS_TABLE_MISSING",
    "REQUEST_PHOTOS_COLUMN_CONFLICT",
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
    const schema = await inspectSchema(pool);
    const ledger = await getLedgerRecord(pool);
    console.log(JSON.stringify({
      status: "precheck_passed",
      action: authorization.action,
      target: authorization.target,
      migration: { filename: migration.filename, checksum: migration.checksum },
      schema,
      ledgerPresent: Boolean(ledger),
    }));
    if (authorization.action !== "execute") return 0;

    const client = await pool.connect();
    try {
      const result = await applyProductionRequestPhotos(client, migration);
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
  applyProductionRequestPhotos,
  getLedgerRecord,
  getSanitizedTarget,
  getUnrelatedSchemaFingerprint,
  inspectAuthorization,
  inspectSchema,
  isCorrectColumn,
  loadMigration,
  main,
  toSafeError,
  validateMigrationSql,
};
