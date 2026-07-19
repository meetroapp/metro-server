#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILENAME = "202607190001_add_user_profile_photo_details.sql";
const EXPECTED_CHECKSUM = "3fa88d13d130efeb02e8ecf8d259e369056374e28d29b362aa4c760ed34344cd";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_FILENAME);
const REQUIRED_ARGS = Object.freeze([
  "--confirm-production-personal-profile-media",
  `--migration=${MIGRATION_FILENAME}`,
]);
const EXECUTION_ARGS = Object.freeze([
  "--execute",
  "--confirm-additive-user-profile-photo-details",
]);
const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    execution_target TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

function parseTarget(value) {
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

function inspectAuthorization({ env = process.env, args = process.argv.slice(2) } = {}) {
  const target = parseTarget(env.DATABASE_URL);
  const environment = String(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || "");
  const reasons = [];
  if (!target.valid) reasons.push("A valid PostgreSQL DATABASE_URL is required.");
  if (env.MIGRATION_TARGET !== "production" || env.CONFIRM_MIGRATION_TARGET !== "production") {
    reasons.push("The migration target must be explicitly confirmed as production.");
  }
  if (env.ALLOW_PRODUCTION_PERSONAL_PROFILE_MEDIA_MIGRATION !== "true") {
    reasons.push("Explicit production migration authorization is required.");
  }
  if (env.CONFIRM_PRODUCTION_PERSONAL_PROFILE_MEDIA !== "production") {
    reasons.push("Personal profile media production confirmation is required.");
  }
  if (!/production/i.test(environment)) reasons.push("Production environment evidence is required.");
  if (/staging/i.test(`${environment} ${target.host} ${target.database}`)) {
    reasons.push("Staging targets are forbidden.");
  }
  REQUIRED_ARGS.forEach((flag) => {
    if (!args.includes(flag)) reasons.push(`Required confirmation is missing: ${flag}`);
  });
  if (args.includes("--execute")) {
    EXECUTION_ARGS.forEach((flag) => {
      if (!args.includes(flag)) reasons.push(`Required execution confirmation is missing: ${flag}`);
    });
  }
  return {
    authorized: reasons.length === 0,
    reasons,
    action: args.includes("--execute") ? "execute" : "precheck",
    target: target.valid
      ? { host: target.host, database: target.database }
      : { host: "unknown", database: "unknown" },
  };
}

function validateMigrationSql(sql) {
  const statement = String(sql || "")
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
  if (!/^ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_details JSONB NOT NULL DEFAULT '\{\}'::jsonb$/i.test(statement)) {
    throw Object.assign(new Error("Migration scope mismatch."), {
      code: "MIGRATION_SCOPE_MISMATCH",
    });
  }
  return true;
}

function loadMigration(filePath = MIGRATION_PATH) {
  const sql = fs.readFileSync(filePath, "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  if (path.basename(filePath) !== MIGRATION_FILENAME) {
    throw Object.assign(new Error("Migration filename mismatch."), {
      code: "MIGRATION_FILENAME_MISMATCH",
    });
  }
  if (checksum !== EXPECTED_CHECKSUM) {
    throw Object.assign(new Error("Migration checksum mismatch."), {
      code: "MIGRATION_CHECKSUM_MISMATCH",
    });
  }
  validateMigrationSql(sql);
  return { filename: MIGRATION_FILENAME, checksum, sql };
}

function isCorrectColumn(column) {
  const defaultValue = String(column?.column_default || "").replace(/[()\s]/g, "");
  return column?.data_type === "jsonb" &&
    column?.is_nullable === "NO" &&
    defaultValue === "'{}'::jsonb";
}

async function inspectSchema(client) {
  const table = await client.query(
    "SELECT to_regclass('public.users') IS NOT NULL AS table_exists"
  );
  if (!table.rows[0]?.table_exists) {
    throw Object.assign(new Error("Users table missing."), { code: "USERS_TABLE_MISSING" });
  }
  const columns = await client.query(`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'profile_photo_details'
  `);
  const column = columns.rows[0] || null;
  if (column && !isCorrectColumn(column)) {
    throw Object.assign(new Error("Profile media column conflict."), {
      code: "PROFILE_PHOTO_DETAILS_CONFLICT",
    });
  }
  const count = await client.query("SELECT COUNT(*)::bigint AS count FROM users");
  return {
    tableExists: true,
    columnExists: Boolean(column),
    columnValid: isCorrectColumn(column),
    userCount: Number(count.rows[0]?.count || 0),
  };
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
  return result.rows[0] || null;
}

async function applyMigration(client, migration) {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const before = await inspectSchema(client);
    const existing = await getLedgerRecord(client);
    if (existing && existing.checksum !== migration.checksum) {
      throw Object.assign(new Error("Recorded checksum mismatch."), {
        code: "MIGRATION_CHECKSUM_MISMATCH",
      });
    }
    let applied = false;
    if (!before.columnExists) {
      await client.query(migration.sql);
      applied = true;
    }
    const after = await inspectSchema(client);
    const invalid = await client.query(`
      SELECT COUNT(*) FILTER (
        WHERE profile_photo_details IS NULL
           OR jsonb_typeof(profile_photo_details) <> 'object'
      )::bigint AS invalid_count
      FROM users
    `);
    const invalidCount = Number(invalid.rows[0]?.invalid_count || 0);
    if (!after.columnValid || after.userCount !== before.userCount || invalidCount !== 0) {
      throw Object.assign(new Error("Post-migration verification failed."), {
        code: "POST_MIGRATION_VERIFICATION_FAILED",
      });
    }
    await client.query(LEDGER_SQL);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, execution_target)
       VALUES ($1, $2, 'production-governed-additive')
       ON CONFLICT (filename) DO NOTHING`,
      [migration.filename, migration.checksum]
    );
    const recorded = await getLedgerRecord(client);
    if (!recorded || recorded.checksum !== migration.checksum) {
      throw Object.assign(new Error("Migration audit failed."), {
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
      columnValid: after.columnValid,
      invalidCount,
      auditTarget: recorded.execution_target,
    };
  } catch (error) {
    if (began) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    throw error;
  }
}

function toSafeError(error) {
  const safeCodes = new Set([
    "MIGRATION_SCOPE_MISMATCH",
    "MIGRATION_FILENAME_MISMATCH",
    "MIGRATION_CHECKSUM_MISMATCH",
    "USERS_TABLE_MISSING",
    "PROFILE_PHOTO_DETAILS_CONFLICT",
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
    console.log(JSON.stringify({
      status: "precheck_passed",
      action: authorization.action,
      target: authorization.target,
      migration: { filename: migration.filename, checksum: migration.checksum },
      schema,
    }));
    if (authorization.action !== "execute") return 0;
    const client = await pool.connect();
    try {
      const result = await applyMigration(client, migration);
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
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  EXPECTED_CHECKSUM,
  MIGRATION_FILENAME,
  applyMigration,
  inspectAuthorization,
  inspectSchema,
  isCorrectColumn,
  loadMigration,
  main,
  toSafeError,
  validateMigrationSql,
};
