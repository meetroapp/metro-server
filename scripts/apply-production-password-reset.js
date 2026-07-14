#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILENAME = "202607130002_create_password_reset_tokens.sql";
const EXPECTED_CHECKSUM =
  "55b87fc1f171a526a852dd6596b4ac6e03e6a0383ec96cbee2b21f61e41121ac";
const CONFIRMATION_FLAG = "--confirm-production-password-reset";
const EXECUTION_FLAG = "--execute";
const FINAL_CONFIRMATION_FLAG = "--confirm-additive-password-reset-table";
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

const EXPECTED_COLUMNS = Object.freeze({
  id: { dataType: "bigint", nullable: "NO", defaultPattern: /^nextval\(/ },
  user_id: { dataType: "integer", nullable: "NO" },
  token_hash: { dataType: "character", nullable: "NO", maxLength: 64 },
  expires_at: { dataType: "timestamp with time zone", nullable: "NO" },
  used_at: { dataType: "timestamp with time zone", nullable: "YES" },
  revoked_at: { dataType: "timestamp with time zone", nullable: "YES" },
  created_at: {
    dataType: "timestamp with time zone",
    nullable: "NO",
    defaultPattern: /now\(\)/i,
  },
});

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
  if (env.ALLOW_PRODUCTION_PASSWORD_RESET_MIGRATION !== "true") {
    reasons.push("Explicit production migration authorization is required.");
  }
  if (env.CONFIRM_PRODUCTION_PASSWORD_RESET !== "production") {
    reasons.push("Production password-reset confirmation is required.");
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
    throw Object.assign(new Error("Destructive or mutating SQL is forbidden."), {
      code: "DESTRUCTIVE_SQL_FORBIDDEN",
    });
  }
  const statements = source
    .split(";")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (
    statements.length !== 3 ||
    !/^CREATE TABLE IF NOT EXISTS password_reset_tokens \(/i.test(statements[0]) ||
    !/^CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens\(user_id\)$/i.test(statements[1]) ||
    !/^CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens\(expires_at\)$/i.test(statements[2])
  ) {
    throw Object.assign(new Error("Migration scope does not match password reset storage."), {
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

function validateColumns(rows) {
  const byName = new Map(rows.map((row) => [row.column_name, row]));
  if (byName.size !== Object.keys(EXPECTED_COLUMNS).length) return false;
  return Object.entries(EXPECTED_COLUMNS).every(([name, expected]) => {
    const row = byName.get(name);
    if (!row) return false;
    if (row.data_type !== expected.dataType || row.is_nullable !== expected.nullable) {
      return false;
    }
    if (expected.maxLength && Number(row.character_maximum_length) !== expected.maxLength) {
      return false;
    }
    if (expected.defaultPattern && !expected.defaultPattern.test(String(row.column_default || ""))) {
      return false;
    }
    return true;
  });
}

function validateConstraints(rows) {
  const source = rows.map((row) => `${row.contype}:${row.definition}`).join("\n");
  return (
    /p:PRIMARY KEY \(id\)/i.test(source) &&
    /u:UNIQUE \(token_hash\)/i.test(source) &&
    /f:FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i.test(source) &&
    /c:CHECK \(\(expires_at > created_at\)\)/i.test(source)
  );
}

function validateIndexes(rows) {
  const indexes = new Map(rows.map((row) => [row.indexname, row.indexdef]));
  return (
    /\(user_id\)/i.test(indexes.get("idx_password_reset_tokens_user_id") || "") &&
    /\(expires_at\)/i.test(indexes.get("idx_password_reset_tokens_expires_at") || "")
  );
}

async function inspectPasswordResetSchema(client) {
  const relationResult = await client.query(`
    SELECT
      to_regclass('public.users') IS NOT NULL AS users_exists,
      to_regclass('public.password_reset_tokens') IS NOT NULL AS table_exists,
      to_regclass('public.password_reset_tokens_id_seq') IS NOT NULL AS sequence_exists,
      to_regclass('public.idx_password_reset_tokens_user_id') IS NOT NULL AS user_index_exists,
      to_regclass('public.idx_password_reset_tokens_expires_at') IS NOT NULL AS expiry_index_exists
  `);
  const relations = relationResult.rows[0] || {};
  if (!relations.users_exists) {
    throw Object.assign(new Error("The users table is missing."), {
      code: "USERS_TABLE_MISSING",
    });
  }
  if (!relations.table_exists) {
    if (relations.sequence_exists || relations.user_index_exists || relations.expiry_index_exists) {
      throw Object.assign(new Error("Conflicting password-reset relations exist."), {
        code: "PASSWORD_RESET_RELATION_CONFLICT",
      });
    }
    return { exists: false, valid: false, rowCount: 0 };
  }

  const columns = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'password_reset_tokens'
    ORDER BY ordinal_position
  `);
  const constraints = await client.query(`
    SELECT c.contype, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    WHERE c.conrelid = 'public.password_reset_tokens'::regclass
    ORDER BY c.contype, c.conname
  `);
  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'password_reset_tokens'
    ORDER BY indexname
  `);
  const count = await client.query(
    "SELECT COUNT(*)::bigint AS count FROM password_reset_tokens"
  );
  const valid =
    Boolean(relations.sequence_exists) &&
    validateColumns(columns.rows) &&
    validateConstraints(constraints.rows) &&
    validateIndexes(indexes.rows);
  if (!valid) {
    throw Object.assign(new Error("Existing password-reset schema is incompatible."), {
      code: "PASSWORD_RESET_SCHEMA_CONFLICT",
    });
  }
  return {
    exists: true,
    valid: true,
    rowCount: Number(count.rows[0]?.count || 0),
    columnCount: columns.rows.length,
    requiredConstraintCount: 4,
    requiredIndexCount: 2,
    sequenceValid: true,
  };
}

async function getUnrelatedSchemaFingerprint(client) {
  const result = await client.query(`
    SELECT md5(COALESCE(string_agg(item, '|' ORDER BY item), '')) AS fingerprint
    FROM (
      SELECT table_name || ':' || column_name || ':' || data_type || ':' || is_nullable AS item
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT IN ('password_reset_tokens', 'schema_migrations')
    ) inventory
  `);
  return String(result.rows[0]?.fingerprint || "");
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
  if (record.rows.length > 1) {
    throw Object.assign(new Error("Duplicate migration ledger records exist."), {
      code: "MIGRATION_AUDIT_FAILED",
    });
  }
  return record.rows[0] || null;
}

async function applyProductionPasswordReset(client, migration) {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const before = await inspectPasswordResetSchema(client);
    const unrelatedBefore = await getUnrelatedSchemaFingerprint(client);
    const existingLedger = await getLedgerRecord(client);
    if (existingLedger && existingLedger.checksum !== migration.checksum) {
      throw Object.assign(new Error("Recorded migration checksum does not match."), {
        code: "MIGRATION_CHECKSUM_MISMATCH",
      });
    }
    if (existingLedger && !before.exists) {
      throw Object.assign(new Error("Ledger and schema state do not agree."), {
        code: "MIGRATION_AUDIT_FAILED",
      });
    }

    let applied = false;
    if (!before.exists) {
      await client.query(migration.sql);
      applied = true;
    }

    const after = await inspectPasswordResetSchema(client);
    const unrelatedAfter = await getUnrelatedSchemaFingerprint(client);
    if (!after.valid || after.rowCount !== before.rowCount || unrelatedAfter !== unrelatedBefore) {
      throw Object.assign(new Error("Post-migration verification failed."), {
        code: "POST_MIGRATION_VERIFICATION_FAILED",
      });
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
      throw Object.assign(new Error("Migration audit record verification failed."), {
        code: "MIGRATION_AUDIT_FAILED",
      });
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
    "USERS_TABLE_MISSING",
    "PASSWORD_RESET_RELATION_CONFLICT",
    "PASSWORD_RESET_SCHEMA_CONFLICT",
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
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const schema = await inspectPasswordResetSchema(pool);
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
        operation: "create password-reset token storage and record only this migration",
      })
    );
    const client = await pool.connect();
    let result;
    try {
      result = await applyProductionPasswordReset(client, migration);
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
  applyProductionPasswordReset,
  getLedgerRecord,
  getSanitizedTarget,
  getUnrelatedSchemaFingerprint,
  inspectAuthorization,
  inspectPasswordResetSchema,
  loadMigration,
  main,
  toSafeError,
  validateColumns,
  validateConstraints,
  validateIndexes,
  validateMigrationSql,
};
