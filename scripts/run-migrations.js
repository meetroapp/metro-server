#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const {
  inspectWorkflowEventsSchema,
} = require("./workflow-events-schema");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const BASELINE_MIGRATION_FILENAME =
  "202607050001_initial_schema_baseline.sql";
const WORKFLOW_EVENTS_MIGRATION_FILENAME =
  "202607140002_create_workflow_events.sql";
const MIGRATION_FILENAME_PATTERN = /^\d{12}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const ALLOWED_TARGETS = new Set(["local-test", "staging"]);
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TEST_DATABASE_PREFIX = "meetro_test_";
const RAILWAY_PRIVATE_HOST_MARKERS = [".railway.internal", "railway.internal"];
const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    execution_target TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

const BASELINE_SCHEMA_REQUIREMENTS = Object.freeze({
  users: Object.freeze({
    id: "integer",
    username: "text",
    email: "text",
    password_hash: "text",
    role: "text",
    account_type: "text",
    business_name: "text",
    business_category: "text",
    profile_photo_url: "text",
    created_at: "timestamp without time zone",
  }),
  posts: Object.freeze({
    id: "integer",
    user_id: "integer",
    title: "text",
    description: "text",
    category: "text",
    location: "text",
    image_url: "text",
    mage_url: "text",
    created_at: "timestamp without time zone",
  }),
  contractor_profiles: Object.freeze({
    id: "integer",
    user_id: "integer",
    business_name: "text",
    category: "text",
    phone: "text",
    location: "text",
    bio: "text",
    image_url: "text",
    created_at: "timestamp without time zone",
  }),
  quote_requests: Object.freeze({
    id: "integer",
    contractor_id: "integer",
    homeowner_id: "integer",
    project_title: "text",
    project_description: "text",
    location: "text",
    created_at: "timestamp without time zone",
  }),
  messages: Object.freeze({
    id: "integer",
    quote_request_id: "integer",
    sender_id: "integer",
    receiver_id: "integer",
    message_text: "text",
    image_url: "text",
    message_type: "text",
    workflow_type: "text",
    workflow_status: "text",
    workflow_payload: "jsonb",
    created_at: "timestamp without time zone",
  }),
  workflow_events: Object.freeze({
    id: "integer",
    quote_request_id: "integer",
    user_id: "integer",
    workflow_type: "text",
    workflow_status: "text",
    workflow_payload: "jsonb",
    event_label: "text",
    created_at: "timestamp without time zone",
  }),
  reviews: Object.freeze({
    id: "integer",
    contractor_id: "integer",
    reviewer_id: "integer",
    rating: "integer",
    review_text: "text",
    created_at: "timestamp without time zone",
  }),
  contractor_projects: Object.freeze({
    id: "integer",
    contractor_id: "integer",
    title: "text",
    description: "text",
    image_url: "text",
    image_urls: "jsonb",
    created_at: "timestamp without time zone",
  }),
  schema_migrations: Object.freeze({
    id: "integer",
    filename: "text",
    checksum: "text",
    execution_target: "text",
    applied_at: "timestamp without time zone",
  }),
});
const BASELINE_NOT_NULL_COLUMNS = new Set([
  "users.id",
  "users.username",
  "users.email",
  "users.password_hash",
  "users.role",
  "users.account_type",
  "users.business_name",
  "users.business_category",
  "users.profile_photo_url",
  "posts.id",
  "posts.user_id",
  "contractor_profiles.id",
  "contractor_profiles.user_id",
  "quote_requests.id",
  "quote_requests.contractor_id",
  "quote_requests.homeowner_id",
  "messages.id",
  "messages.quote_request_id",
  "messages.sender_id",
  "messages.message_text",
  "messages.message_type",
  "workflow_events.id",
  "workflow_events.quote_request_id",
  "workflow_events.user_id",
  "workflow_events.workflow_type",
  "reviews.id",
  "reviews.contractor_id",
  "reviews.reviewer_id",
  "contractor_projects.id",
  "contractor_projects.contractor_id",
  "schema_migrations.id",
  "schema_migrations.filename",
  "schema_migrations.checksum",
  "schema_migrations.execution_target",
]);

function parseDatabaseUrl(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    return {
      ok: true,
      protocol: parsed.protocol,
      host: parsed.hostname,
      database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
    };
  } catch {
    return { ok: false, protocol: "", host: "", database: "" };
  }
}

function redactDatabaseUrl(databaseUrl) {
  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed.ok) return "[invalid database url]";
  return `${parsed.protocol}//${parsed.host}/${parsed.database}`;
}

function hasStagingEnvironmentEvidence(env) {
  const environmentText = [
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_ENVIRONMENT,
    env.RAILWAY_SERVICE_NAME,
    env.CONFIRM_STAGING_DATABASE,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return environmentText.includes("staging");
}

function hasProductionMarker(parsedDatabase, env) {
  const source = [
    parsedDatabase.ok ? parsedDatabase.host : "",
    parsedDatabase.ok ? parsedDatabase.database : "",
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_ENVIRONMENT,
    env.CONFIRM_STAGING_DATABASE,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /(^|[^a-z])(prod|production)([^a-z]|$)/.test(source);
}

function isRailwayPrivateDatabaseHost(host = "") {
  const normalizedHost = String(host).toLowerCase();
  return RAILWAY_PRIVATE_HOST_MARKERS.some((marker) =>
    normalizedHost.endsWith(marker)
  );
}

function isRailwayRuntime(env) {
  return Boolean(
    env.RAILWAY_DEPLOYMENT_ID ||
      env.RAILWAY_DEPLOYMENT_INSTANCE_ID ||
      env.RAILWAY_REPLICA_ID
  );
}

function inspectMigrationExecutionTarget(env = process.env) {
  const reasons = [];
  const target = String(env.MIGRATION_TARGET || "").trim();
  const databaseUrl = env.DATABASE_URL;
  const parsedDatabase = parseDatabaseUrl(databaseUrl);

  if (!databaseUrl) {
    reasons.push("DATABASE_URL is required.");
  } else if (!parsedDatabase.ok) {
    reasons.push("DATABASE_URL must be a valid PostgreSQL URL.");
  } else if (!["postgres:", "postgresql:"].includes(parsedDatabase.protocol)) {
    reasons.push("DATABASE_URL must use PostgreSQL.");
  }

  if (!target) {
    reasons.push("MIGRATION_TARGET is required.");
  } else if (target === "production") {
    reasons.push("Production migrations are not allowed by this runner.");
  } else if (!ALLOWED_TARGETS.has(target)) {
    reasons.push(
      `MIGRATION_TARGET must be one of: ${[...ALLOWED_TARGETS].join(", ")}.`
    );
  }

  if (env.CONFIRM_MIGRATION_TARGET !== target) {
    reasons.push("CONFIRM_MIGRATION_TARGET must match MIGRATION_TARGET.");
  }

  if (hasProductionMarker(parsedDatabase, env)) {
    reasons.push("Production-like database targets are not allowed.");
  }

  if (target === "local-test") {
    if (env.NODE_ENV !== "test") {
      reasons.push("local-test migrations require NODE_ENV=test.");
    }
    if (parsedDatabase.ok && !LOCAL_DATABASE_HOSTS.has(parsedDatabase.host)) {
      reasons.push("local-test migrations require a local database host.");
    }
    if (
      parsedDatabase.ok &&
      !parsedDatabase.database.startsWith(TEST_DATABASE_PREFIX)
    ) {
      reasons.push(
        `local-test database name must start with ${TEST_DATABASE_PREFIX}.`
      );
    }
  }

  if (target === "staging") {
    if (env.ALLOW_STAGING_MIGRATIONS !== "true") {
      reasons.push("ALLOW_STAGING_MIGRATIONS must be true for staging.");
    }
    if (!hasStagingEnvironmentEvidence(env)) {
      reasons.push(
        "Staging migrations require Railway staging metadata or CONFIRM_STAGING_DATABASE=staging."
      );
    }
    if (
      parsedDatabase.ok &&
      isRailwayPrivateDatabaseHost(parsedDatabase.host) &&
      !isRailwayRuntime(env)
    ) {
      reasons.push(
        "Railway private database hosts require execution inside Railway runtime."
      );
    }
    if (
      parsedDatabase.ok &&
      !isRailwayPrivateDatabaseHost(parsedDatabase.host) &&
      !isRailwayRuntime(env) &&
      env.CONFIRM_PUBLIC_STAGING_DATABASE_URL !== "true"
    ) {
      reasons.push(
        "Local staging migrations with a public database URL require CONFIRM_PUBLIC_STAGING_DATABASE_URL=true."
      );
    }
  }

  return {
    safe: reasons.length === 0,
    reasons,
    target,
    database: parsedDatabase.ok
      ? { host: parsedDatabase.host, database: parsedDatabase.database }
      : null,
    redactedDatabaseUrl: redactDatabaseUrl(databaseUrl),
  };
}

function assertSafeMigrationExecutionTarget(env = process.env) {
  const result = inspectMigrationExecutionTarget(env);
  if (!result.safe) {
    throw new Error(`Unsafe migration target: ${result.reasons.join(" ")}`);
  }
  return result;
}

function getMigrationFiles(migrationsDir = MIGRATIONS_DIR) {
  const sqlFilenames = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.toLowerCase().endsWith(".sql"));
  const malformed = sqlFilenames.filter(
    (filename) => !MIGRATION_FILENAME_PATTERN.test(filename)
  );

  if (malformed.length > 0) {
    throw new Error(`Malformed migration filename: ${malformed.sort()[0]}`);
  }

  const sortedFilenames = [...sqlFilenames].sort();
  const timestamps = new Set();
  for (const filename of sortedFilenames) {
    const timestamp = filename.slice(0, 12);
    if (timestamps.has(timestamp)) {
      throw new Error(`Duplicate migration timestamp: ${timestamp}`);
    }
    timestamps.add(timestamp);
  }

  return sortedFilenames.map((filename) => {
    const filePath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(filePath, "utf8");
    return {
      filename,
      filePath,
      sql,
      checksum: crypto.createHash("sha256").update(sql).digest("hex"),
    };
  });
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(SCHEMA_MIGRATIONS_TABLE_SQL);
}

async function getAppliedMigration(client, filename) {
  const result = await client.query(
    `
    SELECT filename, checksum, execution_target, applied_at
    FROM schema_migrations
    WHERE filename = $1
    `,
    [filename]
  );
  return result.rows[0] || null;
}

function validateBaselineSchemaRows(rows) {
  const actual = new Map();
  for (const row of rows || []) {
    actual.set(`${row.table_name}.${row.column_name}`, row);
  }

  const issues = [];
  for (const [tableName, columns] of Object.entries(BASELINE_SCHEMA_REQUIREMENTS)) {
    for (const [columnName, dataType] of Object.entries(columns)) {
      const key = `${tableName}.${columnName}`;
      if (!actual.has(key)) {
        issues.push(`Missing required column ${key}.`);
      } else if (actual.get(key).data_type !== dataType) {
        issues.push(`Incompatible type for ${key}.`);
      } else if (
        BASELINE_NOT_NULL_COLUMNS.has(key) &&
        actual.get(key).is_nullable !== "NO"
      ) {
        issues.push(`Required column ${key} must be NOT NULL.`);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

async function assertBaselineSchemaParity(client) {
  const tableNames = Object.keys(BASELINE_SCHEMA_REQUIREMENTS);
  const result = await client.query(
    `
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    `,
    [tableNames]
  );
  const validation = validateBaselineSchemaRows(result.rows);
  if (!validation.valid) {
    const error = new Error(
      `Baseline schema requires manual review: ${validation.issues.join(" ")}`
    );
    error.code = "BASELINE_SCHEMA_MISMATCH";
    throw error;
  }
  return validation;
}

function toSafeMigrationError(error, filename) {
  if (
    error?.code === "MIGRATION_CHECKSUM_MISMATCH" ||
    error?.code === "BASELINE_SCHEMA_MISMATCH" ||
    error?.code === "WORKFLOW_EVENTS_PREREQUISITE_MISSING" ||
    error?.code === "WORKFLOW_EVENTS_RELATION_CONFLICT" ||
    error?.code === "WORKFLOW_EVENTS_SCHEMA_CONFLICT"
  ) {
    return error;
  }
  const safeError = new Error(`Migration failed: ${filename}`);
  safeError.code = "MIGRATION_FAILED";
  return safeError;
}

async function runMigrationFile(client, migration, target) {
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock(481005040)");
    await ensureSchemaMigrationsTable(client);
    const applied = await getAppliedMigration(client, migration.filename);

    if (applied) {
      if (applied.checksum !== migration.checksum) {
        const mismatch = new Error(
          `Applied migration checksum mismatch: ${migration.filename}`
        );
        mismatch.code = "MIGRATION_CHECKSUM_MISMATCH";
        throw mismatch;
      }
      await client.query("COMMIT");
      return "skipped";
    }

    await client.query(migration.sql);
    if (migration.filename === BASELINE_MIGRATION_FILENAME) {
      await assertBaselineSchemaParity(client);
    }
    if (migration.filename === WORKFLOW_EVENTS_MIGRATION_FILENAME) {
      await inspectWorkflowEventsSchema(client);
    }
    await client.query(
      `
      INSERT INTO schema_migrations (filename, checksum, execution_target)
      VALUES ($1, $2, $3)
      `,
      [migration.filename, migration.checksum, target]
    );
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original migration failure remains authoritative.
      }
    }
    throw toSafeMigrationError(error, migration.filename);
  }
}

async function runMigrationCollection(client, migrations, targetMetadata) {
  const summary = {
    success: true,
    target: targetMetadata.target,
    database: targetMetadata.database,
    applied: [],
    skipped: [],
    failed: [],
  };

  for (const migration of migrations) {
    try {
      const status = await runMigrationFile(
        client,
        migration,
        targetMetadata.target
      );
      summary[status].push(migration.filename);
    } catch (error) {
      summary.success = false;
      summary.failed.push(migration.filename);
      summary.errorCode = error.code || "MIGRATION_FAILED";
      break;
    }
  }

  return summary;
}

async function runMigrations(env = process.env) {
  const target = assertSafeMigrationExecutionTarget(env);
  const migrations = getMigrationFiles();
  if (migrations.length === 0) throw new Error("No SQL migrations found.");

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    return await runMigrationCollection(client, migrations, target);
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  try {
    const target = assertSafeMigrationExecutionTarget(process.env);
    console.log("Running governed Meetro migrations.");
    console.log(`Target: ${target.target}`);
    console.log(`Database: ${target.database.host}/${target.database.database}`);
    const result = await runMigrations(process.env);

    console.log(`Applied migrations: ${result.applied.length}`);
    console.log(`Skipped migrations: ${result.skipped.length}`);
    console.log(`Failed migrations: ${result.failed.length}`);
    if (!result.success) process.exitCode = 1;
  } catch {
    console.error("Migration runner failed safely.");
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ALLOWED_TARGETS,
  BASELINE_MIGRATION_FILENAME,
  BASELINE_NOT_NULL_COLUMNS,
  BASELINE_SCHEMA_REQUIREMENTS,
  MIGRATIONS_DIR,
  MIGRATION_FILENAME_PATTERN,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  WORKFLOW_EVENTS_MIGRATION_FILENAME,
  assertBaselineSchemaParity,
  assertSafeMigrationExecutionTarget,
  ensureSchemaMigrationsTable,
  getAppliedMigration,
  getMigrationFiles,
  hasProductionMarker,
  hasStagingEnvironmentEvidence,
  inspectMigrationExecutionTarget,
  isRailwayPrivateDatabaseHost,
  isRailwayRuntime,
  parseDatabaseUrl,
  redactDatabaseUrl,
  runMigrationCollection,
  runMigrationFile,
  runMigrations,
  validateBaselineSchemaRows,
};
