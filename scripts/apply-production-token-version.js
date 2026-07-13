#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILENAME = "202607130001_add_user_token_version.sql";
const EXPECTED_CHECKSUM =
  "e5aee8dc248a4964c74fc5d9ab2e0298aec8db0262eef9b32270568693111cc1";
const CONFIRMATION_FLAG = "--confirm-production-token-version";
const EXECUTION_FLAG = "--execute";
const FINAL_CONFIRMATION_FLAG = "--confirm-additive-users-token-version";
const MIGRATION_ARG = `--migration=${MIGRATION_FILENAME}`;
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_FILENAME);
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
      protocol: url.protocol,
      host: url.hostname,
      database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    };
  } catch {
    return { valid: false, protocol: "", host: "", database: "" };
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
  const target = String(env.MIGRATION_TARGET || "").trim();
  const environment = String(
    env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || ""
  ).trim();
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  const executionRequested = args.includes(EXECUTION_FLAG);

  if (!parsed.valid) reasons.push("A valid PostgreSQL DATABASE_URL is required.");
  if (target !== "production") reasons.push("MIGRATION_TARGET must be production.");
  if (env.CONFIRM_MIGRATION_TARGET !== "production") {
    reasons.push("CONFIRM_MIGRATION_TARGET must be production.");
  }
  if (env.ALLOW_PRODUCTION_TOKEN_VERSION_MIGRATION !== "true") {
    reasons.push("Explicit production migration authorization is required.");
  }
  if (env.CONFIRM_PRODUCTION_TOKEN_VERSION !== "production") {
    reasons.push("Production token-version confirmation is required.");
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

function validateMigrationSql(sql) {
  const source = String(sql || "");
  if (/\b(DROP|DELETE|TRUNCATE)\b/i.test(source)) {
    throw Object.assign(new Error("Destructive SQL is forbidden."), {
      code: "DESTRUCTIVE_SQL_FORBIDDEN",
    });
  }
  const statements = source
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    statements.length !== 1 ||
    !/^ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+token_version\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0$/i.test(
      statements[0].replace(/\s+/g, " ")
    )
  ) {
    throw Object.assign(new Error("Migration must only add users.token_version."), {
      code: "MIGRATION_SCOPE_MISMATCH",
    });
  }
  return true;
}

function isCorrectTokenVersionColumn(column) {
  if (!column) return false;
  const defaultValue = String(column.column_default || "").replace(/[()\s]/g, "");
  return (
    column.data_type === "integer" &&
    column.is_nullable === "NO" &&
    /^(0|0::integer)$/.test(defaultValue)
  );
}

async function inspectProductionSchema(client) {
  const tableResult = await client.query(
    "SELECT to_regclass('public.users') IS NOT NULL AS users_exists"
  );
  const usersExists = Boolean(tableResult.rows[0]?.users_exists);
  if (!usersExists) {
    throw Object.assign(new Error("The users table is missing."), {
      code: "USERS_TABLE_MISSING",
    });
  }

  const columnResult = await client.query(`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'token_version'
  `);
  const column = columnResult.rows[0] || null;
  if (column && !isCorrectTokenVersionColumn(column)) {
    throw Object.assign(new Error("users.token_version has an incompatible definition."), {
      code: "TOKEN_VERSION_CONFLICT",
    });
  }

  const countResult = await client.query("SELECT COUNT(*)::bigint AS count FROM users");
  return {
    usersExists,
    tokenVersionExists: Boolean(column),
    tokenVersionValid: Boolean(column && isCorrectTokenVersionColumn(column)),
    userCount: Number(countResult.rows[0]?.count || 0),
  };
}

async function getLedgerRecord(client) {
  const tableResult = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_exists"
  );
  if (!tableResult.rows[0]?.ledger_exists) return null;
  const record = await client.query(
    "SELECT filename, checksum, execution_target FROM schema_migrations WHERE filename = $1",
    [MIGRATION_FILENAME]
  );
  return record.rows[0] || null;
}

async function applyProductionTokenVersion(client, migration) {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const before = await inspectProductionSchema(client);
    const existingLedger = await getLedgerRecord(client);
    if (existingLedger && existingLedger.checksum !== migration.checksum) {
      throw Object.assign(new Error("Recorded migration checksum does not match."), {
        code: "MIGRATION_CHECKSUM_MISMATCH",
      });
    }

    let applied = false;
    if (!before.tokenVersionExists) {
      await client.query(migration.sql);
      applied = true;
    }

    const after = await inspectProductionSchema(client);
    if (!after.tokenVersionValid || after.userCount !== before.userCount) {
      throw Object.assign(new Error("Post-migration verification failed."), {
        code: "POST_MIGRATION_VERIFICATION_FAILED",
      });
    }

    const valueResult = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE token_version IS NULL)::bigint AS null_count,
        COUNT(*) FILTER (WHERE token_version <> 0)::bigint AS nonzero_count
      FROM users
    `);
    const nullCount = Number(valueResult.rows[0]?.null_count || 0);
    const nonzeroCount = Number(valueResult.rows[0]?.nonzero_count || 0);
    if (nullCount !== 0 || (applied && nonzeroCount !== 0)) {
      throw Object.assign(new Error("Existing user token-version verification failed."), {
        code: "TOKEN_VERSION_VALUE_MISMATCH",
      });
    }

    await client.query(LEDGER_SQL);
    await client.query(
      `
      INSERT INTO schema_migrations (filename, checksum, execution_target)
      VALUES ($1, $2, 'production-emergency-additive')
      ON CONFLICT (filename) DO NOTHING
      `,
      [migration.filename, migration.checksum]
    );
    const recorded = await getLedgerRecord(client);
    if (!recorded || recorded.checksum !== migration.checksum) {
      throw Object.assign(new Error("Migration audit record verification failed."), {
        code: "MIGRATION_AUDIT_FAILED",
      });
    }

    await client.query("COMMIT");
    return {
      applied,
      filename: migration.filename,
      checksum: migration.checksum,
      userCountBefore: before.userCount,
      userCountAfter: after.userCount,
      tokenVersionValid: after.tokenVersionValid,
      nullCount,
      nonzeroCount,
      baselineRecorded: false,
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
    "USERS_TABLE_MISSING",
    "TOKEN_VERSION_CONFLICT",
    "POST_MIGRATION_VERIFICATION_FAILED",
    "TOKEN_VERSION_VALUE_MISMATCH",
    "MIGRATION_AUDIT_FAILED",
  ]);
  return {
    status: "failed",
    errorCode: safeCodes.has(error?.code) ? error.code : "PRODUCTION_MIGRATION_FAILED",
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
    const schema = await inspectProductionSchema(pool);
    console.log(
      JSON.stringify({
        status: "precheck_passed",
        action: authorization.action,
        target: authorization.target,
        migration: { filename: migration.filename, checksum: migration.checksum },
        schema,
      })
    );
    if (authorization.action !== "execute") return 0;

    console.log(
      JSON.stringify({
        status: "final_confirmation_accepted",
        operation: "add users.token_version and record only this migration",
      })
    );
    const result = await applyProductionTokenVersion(pool, migration);
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
  applyProductionTokenVersion,
  getSanitizedTarget,
  inspectAuthorization,
  inspectProductionSchema,
  isCorrectTokenVersionColumn,
  loadMigration,
  main,
  toSafeError,
  validateMigrationSql,
};
