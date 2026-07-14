#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILENAME = "202607140001_add_contractor_profile_details.sql";
const EXPECTED_CHECKSUM = "08bca06f249b042eef8c342a79c8d51b27528daaa2b76c1e6f11f5b5d414e716";
const CONFIRMATION_FLAG = "--confirm-production-business-profile";
const EXECUTION_FLAG = "--execute";
const FINAL_CONFIRMATION_FLAG = "--confirm-additive-contractor-profile-details";
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
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  const environment = String(
    env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || ""
  ).trim();
  const executionRequested = args.includes(EXECUTION_FLAG);

  if (!parsed.valid) reasons.push("A valid PostgreSQL DATABASE_URL is required.");
  if (env.MIGRATION_TARGET !== "production") reasons.push("MIGRATION_TARGET must be production.");
  if (env.CONFIRM_MIGRATION_TARGET !== "production") {
    reasons.push("CONFIRM_MIGRATION_TARGET must be production.");
  }
  if (env.ALLOW_PRODUCTION_BUSINESS_PROFILE_MIGRATION !== "true") {
    reasons.push("Explicit production migration authorization is required.");
  }
  if (env.CONFIRM_PRODUCTION_BUSINESS_PROFILE !== "production") {
    reasons.push("Production Business Profile confirmation is required.");
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
  const statements = String(sql || "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    statements.length !== 1 ||
    !/^ALTER\s+TABLE\s+contractor_profiles\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+profile_details\s+JSONB\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::jsonb$/i.test(
      statements[0].replace(/\s+/g, " ")
    )
  ) {
    throw Object.assign(new Error("Migration must only add contractor_profiles.profile_details."), {
      code: "MIGRATION_SCOPE_MISMATCH",
    });
  }
  return true;
}

function loadMigration(filePath = MIGRATION_PATH) {
  const sql = fs.readFileSync(filePath, "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  if (path.basename(filePath) !== MIGRATION_FILENAME) {
    throw Object.assign(new Error("Unexpected migration filename."), {
      code: "MIGRATION_FILENAME_MISMATCH",
    });
  }
  if (checksum !== EXPECTED_CHECKSUM) {
    throw Object.assign(new Error("Migration checksum does not match the reviewed file."), {
      code: "MIGRATION_CHECKSUM_MISMATCH",
    });
  }
  validateMigrationSql(sql);
  return { filename: MIGRATION_FILENAME, checksum, sql };
}

function isCorrectColumn(column) {
  const defaultValue = String(column?.column_default || "").replace(/[()\s]/g, "");
  return column?.data_type === "jsonb" && column?.is_nullable === "NO" && defaultValue === "'{}'::jsonb";
}

async function inspectProductionSchema(client) {
  const table = await client.query(
    "SELECT to_regclass('public.contractor_profiles') IS NOT NULL AS table_exists"
  );
  if (!table.rows[0]?.table_exists) {
    throw Object.assign(new Error("The contractor_profiles table is missing."), {
      code: "CONTRACTOR_PROFILES_TABLE_MISSING",
    });
  }
  const columns = await client.query(`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'contractor_profiles'
      AND column_name = 'profile_details'
  `);
  const column = columns.rows[0] || null;
  if (column && !isCorrectColumn(column)) {
    throw Object.assign(new Error("profile_details has an incompatible definition."), {
      code: "PROFILE_DETAILS_CONFLICT",
    });
  }
  const count = await client.query("SELECT COUNT(*)::bigint AS count FROM contractor_profiles");
  return {
    tableExists: true,
    profileDetailsExists: Boolean(column),
    profileDetailsValid: isCorrectColumn(column),
    profileCount: Number(count.rows[0]?.count || 0),
  };
}

async function getLedgerRecord(client) {
  const table = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_exists"
  );
  if (!table.rows[0]?.ledger_exists) return null;
  const record = await client.query(
    "SELECT filename, checksum, execution_target FROM schema_migrations WHERE filename = $1",
    [MIGRATION_FILENAME]
  );
  return record.rows[0] || null;
}

async function applyProductionBusinessProfileDetails(client, migration) {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const before = await inspectProductionSchema(client);
    const existing = await getLedgerRecord(client);
    if (existing && existing.checksum !== migration.checksum) {
      throw Object.assign(new Error("Recorded migration checksum does not match."), {
        code: "MIGRATION_CHECKSUM_MISMATCH",
      });
    }

    let applied = false;
    if (!before.profileDetailsExists) {
      await client.query(migration.sql);
      applied = true;
    }
    const after = await inspectProductionSchema(client);
    const values = await client.query(`
      SELECT COUNT(*) FILTER (
        WHERE profile_details IS NULL OR jsonb_typeof(profile_details) <> 'object'
      )::bigint AS invalid_count
      FROM contractor_profiles
    `);
    const invalidCount = Number(values.rows[0]?.invalid_count || 0);
    if (!after.profileDetailsValid || after.profileCount !== before.profileCount || invalidCount !== 0) {
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
      throw Object.assign(new Error("Migration audit record verification failed."), {
        code: "MIGRATION_AUDIT_FAILED",
      });
    }
    await client.query("COMMIT");
    return {
      applied,
      filename: migration.filename,
      checksum: migration.checksum,
      profileCountBefore: before.profileCount,
      profileCountAfter: after.profileCount,
      profileDetailsValid: after.profileDetailsValid,
      invalidCount,
      auditTarget: recorded.execution_target,
    };
  } catch (error) {
    if (began) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
    }
    throw error;
  }
}

function toSafeError(error) {
  const safeCodes = new Set([
    "MIGRATION_FILENAME_MISMATCH",
    "MIGRATION_CHECKSUM_MISMATCH",
    "MIGRATION_SCOPE_MISMATCH",
    "CONTRACTOR_PROFILES_TABLE_MISSING",
    "PROFILE_DETAILS_CONFLICT",
    "POST_MIGRATION_VERIFICATION_FAILED",
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
  const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const schema = await inspectProductionSchema(pool);
    console.log(JSON.stringify({
      status: "precheck_passed",
      action: authorization.action,
      target: authorization.target,
      migration: { filename: migration.filename, checksum: migration.checksum },
      schema,
    }));
    if (authorization.action !== "execute") return 0;
    const result = await applyProductionBusinessProfileDetails(pool, migration);
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
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  CONFIRMATION_FLAG,
  EXECUTION_FLAG,
  EXPECTED_CHECKSUM,
  FINAL_CONFIRMATION_FLAG,
  MIGRATION_ARG,
  MIGRATION_FILENAME,
  applyProductionBusinessProfileDetails,
  getSanitizedTarget,
  inspectAuthorization,
  inspectProductionSchema,
  isCorrectColumn,
  loadMigration,
  main,
  toSafeError,
  validateMigrationSql,
};
