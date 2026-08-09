#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");
const manifest = require("./production-reconciliation-manifest");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "migrations");
const BASELINE_FILENAME = "202607050001_initial_schema_baseline.sql";
const EXECUTION_TARGET = "production-governed-reconciliation-001";
const ADVISORY_LOCK_ID = 481009001;
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKUP_PROOF_TYPES = Object.freeze({
  RAILWAY_MANAGED: "railway_managed",
  LOGICAL_PG_DUMP: "logical_pg_dump",
});
const CHAIN_CONFIRMATION =
  "archive-then-202607210001-through-202608070003";

const REQUIRED_EXECUTION_CONFIRMATIONS = Object.freeze({
  CONFIRM_PRODUCTION_RECONCILIATION: "YES",
  CONFIRM_ORPHAN_POLICY: "PRESERVE_AND_QUARANTINE",
  CONFIRM_PRODUCTION_RECONCILIATION_CHAIN: CHAIN_CONFIRMATION,
  CONFIRM_PRODUCTION_MUTATION: "EXECUTE",
});

const SOURCE_RECORD_EXPRESSION = `jsonb_build_object(
  'id', id,
  'quote_request_id', quote_request_id,
  'sender_id', sender_id,
  'receiver_id', receiver_id,
  'message_text', message_text,
  'image_url', image_url,
  'message_type', message_type,
  'workflow_type', workflow_type,
  'workflow_status', workflow_status,
  'workflow_payload', workflow_payload,
  'created_at', created_at
)`;

const EXPECTED_ADDED_COLUMNS = Object.freeze({
  messages: Object.freeze(["conversation_id"]),
  commercial_authority_evidence: Object.freeze(["capability_milestone_id"]),
  request_relationships: Object.freeze([
    "professional_response_id",
    "ordinary_authority_source",
    "current_version",
    "closure_reason",
  ]),
  conversations: Object.freeze(["request_selection_id"]),
  posts: Object.freeze([
    "location_intake_mode",
    "location_normalization_status",
    "service_address_line1",
    "service_city",
    "service_region",
    "service_postal_code",
    "service_country_code",
    "discovery_area_label",
  ]),
});

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseDatabaseUrl(value) {
  try {
    const parsed = new URL(value);
    return {
      ok: ["postgres:", "postgresql:"].includes(parsed.protocol),
      database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
      host: parsed.hostname.toLowerCase(),
      protocol: parsed.protocol,
    };
  } catch {
    return { ok: false, database: "", host: "", protocol: "" };
  }
}

function databaseUrlFromEnv(env) {
  return env.DATABASE_PUBLIC_URL || env.DATABASE_URL || "";
}

function authorizeTarget(env, { execute = false, target = manifest.EXPECTED_TARGET } = {}) {
  const reasons = [];
  const checks = {
    NODE_ENV: "production",
    RAILWAY_PROJECT_ID: target.projectId,
    RAILWAY_PROJECT_NAME: target.projectName,
    RAILWAY_ENVIRONMENT_ID: target.environmentId,
    RAILWAY_ENVIRONMENT_NAME: target.environmentName,
    RAILWAY_SERVICE_ID: target.databaseServiceId,
    RAILWAY_SERVICE_NAME: target.databaseServiceName,
  };

  for (const [key, expected] of Object.entries(checks)) {
    if (env[key] !== expected) reasons.push(`${key}_MISMATCH`);
  }

  const expectedConfirmation =
    `${target.projectName}/${target.environmentName}/` +
    `${target.databaseServiceName}/${target.databaseName}`;
  if (env.CONFIRM_PRODUCTION_TARGET !== expectedConfirmation) {
    reasons.push("PRODUCTION_TARGET_CONFIRMATION_MISMATCH");
  }

  const database = parseDatabaseUrl(databaseUrlFromEnv(env));
  if (!database.ok) reasons.push("DATABASE_URL_INVALID");
  if (database.database !== target.databaseName) reasons.push("DATABASE_NAME_MISMATCH");
  if (
    database.host &&
    !database.host.endsWith(".railway.internal") &&
    !database.host.endsWith(".proxy.rlwy.net") &&
    !database.host.endsWith("proxy.rlwy.net")
  ) {
    reasons.push("DATABASE_HOST_NOT_RAILWAY");
  }

  if (execute) {
    for (const [key, expected] of Object.entries(REQUIRED_EXECUTION_CONFIRMATIONS)) {
      if (env[key] !== expected) reasons.push(`${key}_MISMATCH`);
    }
  }

  return {
    authorized: reasons.length === 0,
    reasons,
    target: {
      projectId: env.RAILWAY_PROJECT_ID || null,
      environmentId: env.RAILWAY_ENVIRONMENT_ID || null,
      serviceId: env.RAILWAY_SERVICE_ID || null,
      database: database.database || null,
      hostClassification: database.host.endsWith(".railway.internal")
        ? "railway-private"
        : database.host.includes("proxy.rlwy.net")
          ? "railway-public-proxy"
          : "unrecognized",
    },
  };
}

function loadApprovedMigrations({
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  approvedMigrations = manifest.APPROVED_MIGRATIONS,
} = {}) {
  const realDirectory = fs.realpathSync(migrationsDirectory);
  if (path.resolve(realDirectory) !== path.resolve(migrationsDirectory)) {
    throw Object.assign(new Error("Migration directory must not be a symlink."), {
      code: "MIGRATION_DIRECTORY_INVALID",
    });
  }

  return approvedMigrations.map((approved) => {
    if (!/^\d{12}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.test(approved.filename)) {
      throw Object.assign(new Error("Invalid migration filename."), {
        code: "MIGRATION_FILENAME_INVALID",
      });
    }
    if (approved.filename === BASELINE_FILENAME) {
      throw Object.assign(new Error("Baseline migration is prohibited."), {
        code: "BASELINE_MIGRATION_PROHIBITED",
      });
    }

    const filePath = path.join(migrationsDirectory, approved.filename);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw Object.assign(new Error("Migration must be a regular file."), {
        code: "MIGRATION_FILE_INVALID",
      });
    }
    if (path.dirname(fs.realpathSync(filePath)) !== realDirectory) {
      throw Object.assign(new Error("Migration escaped the approved directory."), {
        code: "MIGRATION_PATH_INVALID",
      });
    }

    const sql = fs.readFileSync(filePath, "utf8");
    const checksum = sha256(sql);
    if (checksum !== approved.checksum) {
      throw Object.assign(new Error(`Checksum drift: ${approved.filename}`), {
        code: "MIGRATION_CHECKSUM_DRIFT",
      });
    }
    return Object.freeze({ ...approved, sql });
  });
}

function extractExpectedSchemaNames(migrations) {
  const names = {
    relations: new Set(),
    constraints: new Set(),
    functions: new Set(),
    triggers: new Set(),
  };

  for (const migration of migrations) {
    const sql = migration.sql;
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi)) {
      names.relations.add(match[1]);
    }
    for (const match of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi)) {
      names.relations.add(match[1]);
    }
    for (const match of sql.matchAll(
      /\bCONSTRAINT\s+([a-z][a-z0-9_]+)\s+(?:CHECK|FOREIGN\s+KEY|UNIQUE|PRIMARY\s+KEY)/gi
    )) {
      names.constraints.add(match[1]);
    }
    for (const match of sql.matchAll(/conname\s*=\s*'([a-z0-9_]+)'/gi)) {
      names.constraints.add(match[1]);
    }
    for (const match of sql.matchAll(/CREATE\s+FUNCTION\s+([a-z0-9_]+)/gi)) {
      names.functions.add(match[1]);
    }
    for (const match of sql.matchAll(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z0-9_]+)/gi)) {
      names.triggers.add(match[1]);
    }
  }

  return Object.freeze({
    relations: Object.freeze([...names.relations].sort()),
    constraints: Object.freeze([...names.constraints].sort()),
    functions: Object.freeze([...names.functions].sort()),
    triggers: Object.freeze([...names.triggers].sort()),
  });
}

async function queryExistingSchemaNames(client, expectedNames) {
  const relations = await client.query(
    "SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname",
    [expectedNames.relations]
  );
  const constraints = await client.query(
    "SELECT conname AS name FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY($1::text[]) ORDER BY conname",
    [expectedNames.constraints]
  );
  const functions = await client.query(
    "SELECT proname AS name FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1::text[]) ORDER BY proname",
    [expectedNames.functions]
  );
  const triggers = await client.query(
    "SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[]) ORDER BY tgname",
    [expectedNames.triggers]
  );
  const columns = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name, column_name",
    [Object.keys(EXPECTED_ADDED_COLUMNS)]
  );

  const expectedColumns = new Set(
    Object.entries(EXPECTED_ADDED_COLUMNS).flatMap(([table, names]) =>
      names.map((name) => `${table}.${name}`)
    )
  );

  return {
    relations: relations.rows.map(({ name }) => name),
    constraints: constraints.rows.map(({ name }) => name),
    functions: functions.rows.map(({ name }) => name),
    triggers: triggers.rows.map(({ name }) => name),
    columns: columns.rows
      .map(({ table_name, column_name }) => `${table_name}.${column_name}`)
      .filter((name) => expectedColumns.has(name)),
  };
}

function compareLedger(rows, migrations, { complete = false } = {}) {
  const expected = [
    ...manifest.EXPECTED_RECORDED_MIGRATIONS,
    ...(complete ? migrations : []),
  ];
  const expectedMap = new Map(expected.map((entry) => [entry.filename, entry.checksum]));
  const actualMap = new Map(rows.map((entry) => [entry.filename, entry.checksum]));
  const missing = [...expectedMap].filter(([name]) => !actualMap.has(name)).map(([name]) => name);
  const extra = [...actualMap].filter(([name]) => !expectedMap.has(name)).map(([name]) => name);
  const checksumDrift = [...expectedMap]
    .filter(([name, checksum]) => actualMap.has(name) && actualMap.get(name) !== checksum)
    .map(([name]) => name);

  return {
    exact: missing.length === 0 && extra.length === 0 && checksumDrift.length === 0,
    missing,
    extra,
    checksumDrift,
  };
}

async function inspectOrphanRows(client, reviewedMessages = manifest.REVIEWED_ORPHAN_MESSAGES, { lock = false } = {}) {
  const ids = reviewedMessages.map(({ id }) => id);
  const result = await client.query(
    `SELECT id, quote_request_id, sender_id, receiver_id, created_at,
      ${SOURCE_RECORD_EXPRESSION}::text AS source_record_json
     FROM messages
     WHERE id = ANY($1::int[])
     ORDER BY id
     ${lock ? "FOR UPDATE" : ""}`,
    [ids]
  );
  const actual = result.rows.map((row) => ({
    ...row,
    sha256: sha256(row.source_record_json),
  }));
  const expectedMap = new Map(reviewedMessages.map((row) => [row.id, row.sha256]));
  const exact =
    actual.length === reviewedMessages.length &&
    actual.every((row) => expectedMap.get(row.id) === row.sha256);
  return { exact, rows: actual };
}

async function inspectReviewedEvidence(client) {
  const result = await client.query(`
    SELECT
      NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = 26) AS quote_26_absent,
      NOT EXISTS (SELECT 1 FROM users WHERE id = 2) AS user_2_absent,
      EXISTS (SELECT 1 FROM users WHERE id = 40) AS user_40_present,
      NOT EXISTS (
        SELECT 1 FROM conversations
        WHERE (homeowner_id = 40 AND professional_user_id = 2)
           OR (homeowner_id = 2 AND professional_user_id = 40)
      ) AS conversation_absent,
      NOT EXISTS (
        SELECT 1 FROM request_relationships
        WHERE (homeowner_id = 40 AND professional_user_id = 2)
           OR (homeowner_id = 2 AND professional_user_id = 40)
      ) AS relationship_absent,
      COALESCE(
        (SELECT array_agg(id ORDER BY id) FROM messages WHERE quote_request_id IS NULL),
        ARRAY[]::integer[]
      ) = ARRAY[8, 9, 10] AS identityless_set_exact,
      EXISTS (
        SELECT 1 FROM messages
        WHERE id = 9 AND receiver_id IS NULL AND quote_request_id IS NULL
      ) AS receiverless_row_exact,
      EXISTS (
        SELECT 1 FROM messages
        WHERE id = 11 AND quote_request_id = 26
      ) AS dangling_row_exact
  `);
  const evidence = result.rows[0] || {};
  return {
    exact: Object.values(evidence).every(Boolean),
    evidence,
  };
}

async function inspectDatabaseState(client, migrations, reviewedMessages) {
  const expectedNames = extractExpectedSchemaNames(migrations);
  const ledger = await client.query(
    "SELECT filename, checksum, execution_target FROM schema_migrations ORDER BY filename"
  );
  const schema = await queryExistingSchemaNames(client, expectedNames);
  const baseline = await client.query(
    "SELECT count(*)::int AS count FROM schema_migrations WHERE filename = $1",
    [BASELINE_FILENAME]
  );
  const archiveCount = await client.query(
    "SELECT CASE WHEN to_regclass('public.legacy_orphan_message_archive') IS NULL THEN 0 ELSE 1 END::int AS exists"
  );
  const orphanRows = await inspectOrphanRows(client, reviewedMessages);
  const evidence = await inspectReviewedEvidence(client);

  const preflightLedger = compareLedger(ledger.rows, migrations);
  const completeLedger = compareLedger(ledger.rows, migrations, { complete: true });
  const existingMarkerCount = Object.values(schema).reduce((sum, values) => sum + values.length, 0);
  const expectedMarkerCount =
    expectedNames.relations.length +
    expectedNames.constraints.length +
    expectedNames.functions.length +
    expectedNames.triggers.length +
    Object.values(EXPECTED_ADDED_COLUMNS).flat().length;
  const reviewedIds = reviewedMessages.map(({ id }) => id);
  const archiveRows = archiveCount.rows[0]?.exists
    ? await client.query(
        "SELECT message_id, source_record::text AS source_record_json, source_record_sha256, canonical_authority_granted FROM legacy_orphan_message_archive WHERE message_id = ANY($1::int[]) ORDER BY message_id",
        [reviewedIds]
      )
    : { rows: [] };
  const archiveExact =
    archiveRows.rows.length === reviewedMessages.length &&
    archiveRows.rows.every((row) => {
      const expected = reviewedMessages.find(({ id }) => id === row.message_id);
      return (
        expected &&
        row.source_record_sha256 === expected.sha256 &&
        sha256(row.source_record_json) === expected.sha256 &&
        row.canonical_authority_granted === false
      );
    });

  const preflightReady =
    preflightLedger.exact &&
    baseline.rows[0].count === 0 &&
    existingMarkerCount === 0 &&
    orphanRows.exact &&
    evidence.exact;
  const complete =
    completeLedger.exact &&
    baseline.rows[0].count === 0 &&
    existingMarkerCount === expectedMarkerCount &&
    orphanRows.rows.length === 0 &&
    archiveExact;

  return {
    classification: complete ? "COMPLETE" : preflightReady ? "EXPECTED_PRESTATE" : "PARTIAL_OR_DRIFTED",
    preflightReady,
    complete,
    baselineRecorded: baseline.rows[0].count !== 0,
    ledger: { preflight: preflightLedger, complete: completeLedger },
    schema: { ...schema, existingMarkerCount, expectedMarkerCount },
    orphanRows: {
      exact: orphanRows.exact,
      ids: orphanRows.rows.map(({ id }) => id),
      fingerprints: orphanRows.rows.map(({ id, sha256: fingerprint }) => ({ id, sha256: fingerprint })),
    },
    evidence,
    archiveExact,
  };
}

async function inspectDatabaseIdentity(client, target = manifest.EXPECTED_TARGET) {
  const result = await client.query(
    "SELECT current_database() AS database_name, current_user AS database_user, inet_server_addr()::text AS server_address"
  );
  const identity = result.rows[0] || {};
  return {
    exact: identity.database_name === target.databaseName,
    databaseName: identity.database_name || null,
    databaseUserPresent: Boolean(identity.database_user),
    serverAddressPresent: Boolean(identity.server_address),
  };
}

function canonicalCatalogRows(rows) {
  return rows
    .map((row) => Object.entries(row).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ))
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
}

function catalogFingerprint(rows) {
  return {
    count: rows.length,
    sha256: sha256(JSON.stringify(canonicalCatalogRows(rows))),
  };
}

async function inspectLogicalRestoreState(
  client,
  migrations,
  reviewedMessages = manifest.REVIEWED_ORPHAN_MESSAGES
) {
  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM schema_migrations) AS schema_migrations,
      (SELECT count(*)::int FROM messages) AS messages,
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM posts) AS posts,
      (SELECT count(*)::int FROM request_relationships) AS request_relationships,
      (SELECT count(*)::int FROM conversations) AS conversations
  `);
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const catalogQueries = {
    columns: `
      SELECT table_name, column_name, ordinal_position, data_type, udt_name,
        is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `,
    constraints: `
      SELECT conrelid::regclass::text AS table_name, conname, contype,
        pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
    `,
    indexes: `
      SELECT table_relation.relname AS table_name,
        index_relation.relname AS index_name,
        pg_get_indexdef(index_relation.oid) AS definition
      FROM pg_index index_record
      JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = index_record.indrelid
      WHERE table_relation.relnamespace = 'public'::regnamespace
    `,
    functions: `
      SELECT proname,
        pg_get_function_identity_arguments(oid) AS arguments,
        pg_get_functiondef(oid) AS definition
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
    `,
    triggers: `
      SELECT tgrelid::regclass::text AS table_name, tgname,
        pg_get_triggerdef(oid, true) AS definition
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid IN (
          SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace
        )
    `,
  };
  const catalog = {};
  for (const [name, query] of Object.entries(catalogQueries)) {
    catalog[name] = catalogFingerprint((await client.query(query)).rows);
  }
  const prestate = await inspectDatabaseState(client, migrations, reviewedMessages);

  return {
    counts: counts.rows[0],
    tables: tables.rows.map(({ table_name }) => table_name),
    catalog,
    prestate,
  };
}

function compareLogicalRestoreState(
  actual,
  expected = manifest.LOGICAL_BACKUP_CERTIFICATION
) {
  if (JSON.stringify(actual.counts) !== JSON.stringify(expected.counts)) {
    return { verified: false, code: "LOGICAL_BACKUP_RESTORE_COUNT_MISMATCH" };
  }
  if (JSON.stringify(actual.tables) !== JSON.stringify(expected.tables)) {
    return { verified: false, code: "LOGICAL_BACKUP_RESTORE_TABLE_MISMATCH" };
  }
  for (const name of Object.keys(expected.catalog)) {
    if (
      actual.catalog[name]?.count !== expected.catalog[name].count ||
      actual.catalog[name]?.sha256 !== expected.catalog[name].sha256
    ) {
      return {
        verified: false,
        code: "LOGICAL_BACKUP_RESTORE_SCHEMA_MISMATCH",
        marker: name,
      };
    }
  }
  if (!actual.prestate.ledger.preflight.exact) {
    return { verified: false, code: "LOGICAL_BACKUP_RESTORE_LEDGER_MISMATCH" };
  }
  if (!actual.prestate.orphanRows.exact || !actual.prestate.evidence.exact) {
    return { verified: false, code: "LOGICAL_BACKUP_RESTORE_ORPHAN_MISMATCH" };
  }
  if (
    actual.prestate.baselineRecorded ||
    actual.prestate.schema.existingMarkerCount !== 0 ||
    actual.prestate.classification !== "EXPECTED_PRESTATE"
  ) {
    return { verified: false, code: "LOGICAL_BACKUP_RESTORE_PRESTATE_MISMATCH" };
  }
  return { verified: true, code: "LOGICAL_BACKUP_RESTORE_VERIFIED" };
}

function runLocalCommand(command, args, { spawnSyncImpl = spawnSync } = {}) {
  try {
    const result = spawnSyncImpl(command, args, { encoding: "utf8" });
    return {
      ok: !result.error && result.status === 0,
      stdout: result.stdout || "",
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function runRequiredLocalCommand(command, args, code, options) {
  const result = runLocalCommand(command, args, options);
  if (!result.ok) throw Object.assign(new Error("Logical backup certification failed."), { code });
  return result.stdout;
}

async function certifyLogicalBackupRestore({
  backupPath,
  target = manifest.EXPECTED_TARGET,
  certification = manifest.LOGICAL_BACKUP_CERTIFICATION,
  migrations = loadApprovedMigrations(),
  reviewedMessages = manifest.REVIEWED_ORPHAN_MESSAGES,
  spawnSyncImpl = spawnSync,
  fsImpl = fs,
  osImpl = os,
  ClientImpl = Client,
} = {}) {
  let temporaryRoot;
  try {
    temporaryRoot = fsImpl.mkdtempSync(
      path.join(osImpl.tmpdir(), "meetro-logical-restore-")
    );
  } catch {
    return {
      verified: false,
      code: "LOGICAL_BACKUP_RESTORE_INIT_FAILED",
      databaseName: null,
      cleanup: {
        databaseDropped: true,
        serverStopped: true,
        temporaryFilesRemoved: true,
      },
    };
  }
  const clusterDirectory = path.join(temporaryRoot, "cluster");
  const socketDirectory = path.join(temporaryRoot, "socket");
  const logPath = path.join(temporaryRoot, "postgres.log");
  const port = 49152 + crypto.randomInt(10000);
  const databaseName = `meetro_test_${Date.now().toString(36)}_${crypto
    .randomBytes(3)
    .toString("hex")}`;
  const commandOptions = { spawnSyncImpl };
  const cleanup = {
    databaseDropped: true,
    serverStopped: true,
    temporaryFilesRemoved: true,
  };
  let clusterInitialized = false;
  let serverStarted = false;
  let databaseAttempted = false;
  let client;
  let outcome;

  try {
    runRequiredLocalCommand(
      "initdb",
      [
        "-D",
        clusterDirectory,
        "--auth=trust",
        "--username=postgres",
        "--no-locale",
        "--encoding=UTF8",
      ],
      "LOGICAL_BACKUP_RESTORE_INIT_FAILED",
      commandOptions
    );
    clusterInitialized = true;
    fsImpl.mkdirSync(socketDirectory, { mode: 0o700 });
    runRequiredLocalCommand(
      "pg_ctl",
      [
        "-D",
        clusterDirectory,
        "-l",
        logPath,
        "-o",
        `-F -p ${port} -c listen_addresses='' -c unix_socket_directories='${socketDirectory}'`,
        "-w",
        "start",
      ],
      "LOGICAL_BACKUP_RESTORE_START_FAILED",
      commandOptions
    );
    serverStarted = true;
    databaseAttempted = true;
    runRequiredLocalCommand(
      "createdb",
      ["-h", socketDirectory, "-p", String(port), "-U", "postgres", databaseName],
      "LOGICAL_BACKUP_RESTORE_DATABASE_FAILED",
      commandOptions
    );
    runRequiredLocalCommand(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        `--host=${socketDirectory}`,
        `--port=${port}`,
        "--username=postgres",
        `--dbname=${databaseName}`,
        backupPath,
      ],
      "LOGICAL_BACKUP_RESTORE_FAILED",
      commandOptions
    );
    client = new ClientImpl({
      host: socketDirectory,
      port,
      user: "postgres",
      database: databaseName,
    });
    await client.connect();
    const actual = await inspectLogicalRestoreState(client, migrations, reviewedMessages);
    outcome = {
      ...compareLogicalRestoreState(actual, certification),
      certification: {
        counts: actual.counts,
        tableCount: actual.tables.length,
        catalog: actual.catalog,
        prestateClassification: actual.prestate.classification,
      },
    };
  } catch (error) {
    outcome = {
      verified: false,
      code: error.code || "LOGICAL_BACKUP_RESTORE_FAILED",
    };
  } finally {
    if (client) await client.end().catch(() => {});
    if (databaseAttempted && serverStarted) {
      cleanup.databaseDropped = runLocalCommand(
        "dropdb",
        [
          "--if-exists",
          "-h",
          socketDirectory,
          "-p",
          String(port),
          "-U",
          "postgres",
          databaseName,
        ],
        commandOptions
      ).ok;
    }
    if (clusterInitialized) {
      const serverStatus = runLocalCommand(
        "pg_ctl",
        ["-D", clusterDirectory, "status"],
        commandOptions
      );
      if (serverStatus.ok) {
        cleanup.serverStopped = runLocalCommand(
          "pg_ctl",
          ["-D", clusterDirectory, "-m", "fast", "-w", "stop"],
          commandOptions
        ).ok;
      } else {
        cleanup.serverStopped = !serverStarted;
      }
    }
    try {
      fsImpl.rmSync(temporaryRoot, { recursive: true, force: true });
      cleanup.temporaryFilesRemoved = !fsImpl.existsSync(temporaryRoot);
    } catch {
      cleanup.temporaryFilesRemoved = false;
    }
  }

  if (!Object.values(cleanup).every(Boolean)) {
    outcome = {
      verified: false,
      code: "LOGICAL_BACKUP_RESTORE_CLEANUP_FAILED",
    };
  }
  return { ...outcome, databaseName, cleanup };
}

function sha256File(filePath, fsImpl = fs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsImpl.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function validateLogicalBackupArchive(
  env,
  {
    target = manifest.EXPECTED_TARGET,
    now = new Date(),
    repositoryRoot = REPOSITORY_ROOT,
    spawnSyncImpl = spawnSync,
    fsImpl = fs,
    certification = manifest.LOGICAL_BACKUP_CERTIFICATION,
  } = {}
) {
  const required = [
    "PRODUCTION_BACKUP_PATH",
    "PRODUCTION_BACKUP_SHA256",
    "PRODUCTION_BACKUP_CREATED_AT",
    "PRODUCTION_BACKUP_DATABASE",
    "PRODUCTION_BACKUP_PROJECT_ID",
    "PRODUCTION_BACKUP_ENVIRONMENT_ID",
    "PRODUCTION_BACKUP_POSTGRES_SERVICE_ID",
    "PRODUCTION_BACKUP_VOLUME_ID",
    "PRODUCTION_BACKUP_VOLUME_INSTANCE_ID",
  ];
  if (required.some((name) => !env[name])) {
    return { verified: false, code: "LOGICAL_BACKUP_PROOF_REQUIRED" };
  }
  const identityChecks = [
    ["PRODUCTION_BACKUP_DATABASE", target.databaseName, "BACKUP_DATABASE_MISMATCH"],
    ["PRODUCTION_BACKUP_PROJECT_ID", target.projectId, "BACKUP_PROJECT_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_ENVIRONMENT_ID", target.environmentId, "BACKUP_ENVIRONMENT_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_POSTGRES_SERVICE_ID", target.databaseServiceId, "BACKUP_SERVICE_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_VOLUME_ID", target.volumeId, "BACKUP_VOLUME_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_VOLUME_INSTANCE_ID", target.volumeInstanceId, "BACKUP_VOLUME_INSTANCE_ID_MISMATCH"],
  ];
  for (const [name, expected, code] of identityChecks) {
    if (env[name] !== expected) return { verified: false, code };
  }

  const suppliedPath = env.PRODUCTION_BACKUP_PATH;
  if (!path.isAbsolute(suppliedPath)) {
    return { verified: false, code: "BACKUP_PATH_NOT_ABSOLUTE" };
  }
  let fileStat;
  let realPath;
  try {
    fileStat = fsImpl.lstatSync(suppliedPath);
    if (fileStat.isSymbolicLink()) {
      return { verified: false, code: "BACKUP_PATH_SYMLINK" };
    }
    if (!fileStat.isFile()) {
      return { verified: false, code: "BACKUP_PATH_NOT_REGULAR_FILE" };
    }
    realPath = fsImpl.realpathSync(suppliedPath);
  } catch {
    return { verified: false, code: "BACKUP_FILE_NOT_FOUND" };
  }
  if (isPathInside(fsImpl.realpathSync(repositoryRoot), realPath)) {
    return { verified: false, code: "BACKUP_PATH_INSIDE_REPOSITORY" };
  }
  let directoryStat;
  try {
    directoryStat = fsImpl.statSync(path.dirname(realPath));
  } catch {
    return { verified: false, code: "BACKUP_FILE_NOT_FOUND" };
  }
  const directoryMode = directoryStat.mode & 0o777;
  if ((directoryMode & 0o077) !== 0 || (directoryMode & 0o500) !== 0o500) {
    return { verified: false, code: "BACKUP_DIRECTORY_PERMISSIONS_INSECURE" };
  }
  const fileMode = fileStat.mode & 0o777;
  if (![0o400, 0o600].includes(fileMode)) {
    return { verified: false, code: "BACKUP_FILE_PERMISSIONS_INSECURE" };
  }
  if (
    typeof process.getuid === "function" &&
    (fileStat.uid !== process.getuid() || directoryStat.uid !== process.getuid())
  ) {
    return { verified: false, code: "BACKUP_FILE_OWNER_MISMATCH" };
  }
  if (!/^[0-9a-f]{64}$/.test(env.PRODUCTION_BACKUP_SHA256)) {
    return { verified: false, code: "BACKUP_SHA256_INVALID" };
  }
  let actualSha256;
  try {
    actualSha256 = await sha256File(realPath, fsImpl);
  } catch {
    return { verified: false, code: "BACKUP_ARCHIVE_UNREADABLE" };
  }
  if (actualSha256 !== env.PRODUCTION_BACKUP_SHA256) {
    return { verified: false, code: "BACKUP_SHA256_MISMATCH" };
  }
  const createdAt = new Date(env.PRODUCTION_BACKUP_CREATED_AT);
  if (!Number.isFinite(createdAt.getTime())) {
    return { verified: false, code: "BACKUP_TIMESTAMP_INVALID" };
  }
  if (Math.abs(fileStat.mtimeMs - createdAt.getTime()) > 1000) {
    return { verified: false, code: "BACKUP_TIMESTAMP_MISMATCH" };
  }
  const age = now.getTime() - createdAt.getTime();
  if (age < 0 || age > BACKUP_MAX_AGE_MS) {
    return { verified: false, code: "BACKUP_NOT_RECENT" };
  }

  const listResult = runLocalCommand("pg_restore", ["--list", realPath], {
    spawnSyncImpl,
  });
  if (!listResult.ok) {
    return { verified: false, code: "BACKUP_ARCHIVE_UNREADABLE" };
  }
  const format = listResult.stdout.match(/^;\s+Format:\s+(.+)$/m)?.[1]?.trim();
  const databaseName = listResult.stdout.match(/^;\s+dbname:\s+(.+)$/m)?.[1]?.trim();
  const sourceVersion = listResult.stdout.match(
    /^;\s+Dumped from database version:\s+([0-9]+(?:\.[0-9]+)?)/m
  )?.[1];
  const dumpToolVersion = listResult.stdout.match(
    /^;\s+Dumped by pg_dump version:\s+([0-9]+(?:\.[0-9]+)?)/m
  )?.[1];
  if (format !== "CUSTOM") {
    return { verified: false, code: "BACKUP_ARCHIVE_FORMAT_INVALID" };
  }
  if (databaseName !== target.databaseName) {
    return { verified: false, code: "BACKUP_DATABASE_MISMATCH" };
  }
  const restoreVersionResult = runLocalCommand("pg_restore", ["--version"], {
    spawnSyncImpl,
  });
  const restoreVersion = restoreVersionResult.stdout.match(/([0-9]+(?:\.[0-9]+)?)/)?.[1];
  const sourceMajor = Number.parseInt(sourceVersion, 10);
  const dumpToolMajor = Number.parseInt(dumpToolVersion, 10);
  const restoreMajor = Number.parseInt(restoreVersion, 10);
  if (
    !restoreVersionResult.ok ||
    !Number.isInteger(sourceMajor) ||
    !Number.isInteger(dumpToolMajor) ||
    !Number.isInteger(restoreMajor) ||
    sourceMajor !== certification.sourcePostgresMajor ||
    dumpToolMajor !== sourceMajor ||
    restoreMajor < dumpToolMajor
  ) {
    return { verified: false, code: "BACKUP_TOOL_VERSION_INCOMPATIBLE" };
  }

  return {
    verified: true,
    code: "LOGICAL_BACKUP_ARCHIVE_VERIFIED",
    fileIdentity: {
      device: fileStat.dev,
      inode: fileStat.ino,
      size: fileStat.size,
      modifiedAtMs: fileStat.mtimeMs,
    },
    archive: {
      path: realPath,
      sha256: actualSha256,
      createdAt: createdAt.toISOString(),
      databaseName,
      format,
      sourceVersion,
      dumpToolVersion,
      restoreVersion,
    },
  };
}

async function railwayGraphql(query, variables, token, fetchImpl = fetch) {
  const response = await fetchImpl("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw Object.assign(new Error("Railway backup verification failed."), { code: "RAILWAY_API_FAILED" });
  const body = await response.json();
  if (body.errors?.length) throw Object.assign(new Error("Railway backup verification failed."), { code: "RAILWAY_API_FAILED" });
  return body.data;
}

async function queryAutoDeployStatus(
  token,
  target = manifest.EXPECTED_TARGET,
  fetchImpl = fetch
) {
  if (!token) return { verified: false, code: "RAILWAY_API_TOKEN_REQUIRED" };
  const data = await railwayGraphql(
    `query ProductionReconciliationAutoDeploy(
      $projectId: String!,
      $environmentId: String!,
      $serviceId: String!
    ) {
      autoDeploy: serviceInstanceAutoDeployStatus(
        projectId: $projectId,
        environmentId: $environmentId,
        serviceId: $serviceId
      ) { enabled canEnable reason }
    }`,
    {
      projectId: target.projectId,
      environmentId: target.environmentId,
      serviceId: target.backendServiceId,
    },
    token,
    fetchImpl
  );
  if (data.autoDeploy.enabled) {
    return { verified: false, code: "PRODUCTION_AUTO_DEPLOY_ENABLED" };
  }
  return { verified: true, code: "PRODUCTION_AUTO_DEPLOY_DISABLED" };
}

async function verifyRailwayManagedBackupProof(
  env,
  { target = manifest.EXPECTED_TARGET, fetchImpl = fetch, now = new Date() } = {}
) {
  const token = env.RAILWAY_API_TOKEN;
  const backupId = env.PRODUCTION_BACKUP_ID;
  const assertedCreatedAt = env.PRODUCTION_BACKUP_CREATED_AT;
  if (!token || !backupId || !assertedCreatedAt) {
    return { verified: false, code: "BACKUP_PROOF_REQUIRED" };
  }

  const data = await railwayGraphql(
    `query ProductionReconciliationBackup(
      $projectId: String!,
      $environmentId: String!,
      $serviceId: String!,
      $volumeInstanceId: String!
    ) {
      autoDeploy: serviceInstanceAutoDeployStatus(
        projectId: $projectId,
        environmentId: $environmentId,
        serviceId: $serviceId
      ) { enabled canEnable reason }
      backups: volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) {
        id createdAt expiresAt referencedMB usedMB volumeInstanceSizeMB
      }
    }`,
    {
      projectId: target.projectId,
      environmentId: target.environmentId,
      serviceId: target.backendServiceId,
      volumeInstanceId: target.volumeInstanceId,
    },
    token,
    fetchImpl
  );
  const backup = data.backups.find(({ id }) => id === backupId);
  if (!backup) return { verified: false, code: "BACKUP_NOT_FOUND" };
  if (new Date(backup.createdAt).getTime() !== new Date(assertedCreatedAt).getTime()) {
    return { verified: false, code: "BACKUP_TIMESTAMP_MISMATCH" };
  }
  const age = now.getTime() - new Date(backup.createdAt).getTime();
  if (age < 0 || age > BACKUP_MAX_AGE_MS) {
    return { verified: false, code: "BACKUP_NOT_RECENT" };
  }
  if (backup.expiresAt && new Date(backup.expiresAt) <= now) {
    return { verified: false, code: "BACKUP_EXPIRED" };
  }
  if (data.autoDeploy.enabled) {
    return { verified: false, code: "PRODUCTION_AUTO_DEPLOY_ENABLED" };
  }
  return {
    verified: true,
    code: "BACKUP_VERIFIED",
    backup: {
      type: BACKUP_PROOF_TYPES.RAILWAY_MANAGED,
      id: backup.id,
      createdAt: backup.createdAt,
      expiresAt: backup.expiresAt || null,
      volumeInstanceId: target.volumeInstanceId,
    },
    autoDeployEnabled: false,
  };
}

async function verifyLogicalPgDumpBackupProof(env, options = {}) {
  const target = options.target || manifest.EXPECTED_TARGET;
  const archive = await validateLogicalBackupArchive(env, { ...options, target });
  if (!archive.verified) return archive;

  let autoDeploy;
  try {
    autoDeploy = await queryAutoDeployStatus(
      env.RAILWAY_API_TOKEN,
      target,
      options.fetchImpl || fetch
    );
  } catch (error) {
    return { verified: false, code: error.code || "RAILWAY_API_FAILED" };
  }
  if (!autoDeploy.verified) return autoDeploy;

  const certifyRestore =
    options.certifyLogicalBackupRestore || certifyLogicalBackupRestore;
  let restore;
  try {
    restore = await certifyRestore({
      backupPath: archive.archive.path,
      target,
      certification:
        options.logicalBackupCertification || manifest.LOGICAL_BACKUP_CERTIFICATION,
      migrations: options.migrations || loadApprovedMigrations(options),
      reviewedMessages:
        options.reviewedMessages || manifest.REVIEWED_ORPHAN_MESSAGES,
    });
  } catch {
    return { verified: false, code: "LOGICAL_BACKUP_RESTORE_FAILED" };
  }
  if (!restore.verified) return restore;
  if (
    !restore.databaseName?.startsWith("meetro_test_") ||
    !restore.cleanup ||
    !Object.values(restore.cleanup).every(Boolean)
  ) {
    return { verified: false, code: "LOGICAL_BACKUP_RESTORE_CLEANUP_FAILED" };
  }
  try {
    const postRestoreStat = (options.fsImpl || fs).lstatSync(archive.archive.path);
    const postRestoreSha256 = await sha256File(
      archive.archive.path,
      options.fsImpl || fs
    );
    if (
      postRestoreStat.isSymbolicLink() ||
      !postRestoreStat.isFile() ||
      postRestoreStat.dev !== archive.fileIdentity.device ||
      postRestoreStat.ino !== archive.fileIdentity.inode ||
      postRestoreStat.size !== archive.fileIdentity.size ||
      postRestoreStat.mtimeMs !== archive.fileIdentity.modifiedAtMs ||
      postRestoreSha256 !== archive.archive.sha256
    ) {
      return {
        verified: false,
        code: "BACKUP_ARCHIVE_CHANGED_DURING_CERTIFICATION",
      };
    }
  } catch {
    return {
      verified: false,
      code: "BACKUP_ARCHIVE_CHANGED_DURING_CERTIFICATION",
    };
  }

  return {
    verified: true,
    code: "BACKUP_VERIFIED",
    backup: {
      type: BACKUP_PROOF_TYPES.LOGICAL_PG_DUMP,
      ...archive.archive,
      projectId: target.projectId,
      environmentId: target.environmentId,
      postgresServiceId: target.databaseServiceId,
      volumeId: target.volumeId,
      volumeInstanceId: target.volumeInstanceId,
      restoreCertification: restore.certification,
      cleanup: restore.cleanup,
    },
    autoDeployEnabled: false,
  };
}

async function verifyBackupProof(env, options = {}) {
  const type = env.PRODUCTION_BACKUP_TYPE;
  if (!type) return { verified: false, code: "BACKUP_PROOF_TYPE_REQUIRED" };
  if (type === BACKUP_PROOF_TYPES.RAILWAY_MANAGED) {
    return verifyRailwayManagedBackupProof(env, options);
  }
  if (type === BACKUP_PROOF_TYPES.LOGICAL_PG_DUMP) {
    return verifyLogicalPgDumpBackupProof(env, options);
  }
  return { verified: false, code: "BACKUP_PROOF_TYPE_UNSUPPORTED" };
}

async function recordMigration(client, migration) {
  await client.query(
    `INSERT INTO schema_migrations (filename, checksum, execution_target)
     VALUES ($1, $2, $3)`,
    [migration.filename, migration.checksum, EXECUTION_TARGET]
  );
}

async function quarantineReviewedMessages(client, reviewedMessages = manifest.REVIEWED_ORPHAN_MESSAGES) {
  const locked = await inspectOrphanRows(client, reviewedMessages, { lock: true });
  if (!locked.exact) throw Object.assign(new Error("Reviewed source rows changed."), { code: "ORPHAN_SOURCE_PRECONDITION_FAILED" });

  for (const row of locked.rows) {
    await client.query(
      `INSERT INTO legacy_orphan_message_archive (
        message_id, source_record, source_record_sha256,
        original_quote_request_id, original_sender_id,
        original_receiver_id, original_created_at
      ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.source_record_json,
        row.sha256,
        row.quote_request_id,
        row.sender_id,
        row.receiver_id,
        row.created_at,
      ]
    );
  }

  const ids = reviewedMessages.map(({ id }) => id);
  const archived = await client.query(
    "SELECT message_id, source_record::text AS source_record_json, source_record_sha256, canonical_authority_granted FROM legacy_orphan_message_archive WHERE message_id = ANY($1::int[]) ORDER BY message_id",
    [ids]
  );
  const verified =
    archived.rows.length === reviewedMessages.length &&
    archived.rows.every((row) => {
      const expected = reviewedMessages.find(({ id }) => id === row.message_id);
      return expected && row.source_record_sha256 === expected.sha256 && sha256(row.source_record_json) === expected.sha256 && row.canonical_authority_granted === false;
    });
  if (!verified) throw Object.assign(new Error("Archive verification failed."), { code: "ARCHIVE_VERIFICATION_FAILED" });

  const deleted = await client.query(
    "DELETE FROM messages WHERE id = ANY($1::int[]) RETURNING id",
    [ids]
  );
  const deletedIds = deleted.rows.map(({ id }) => id).sort((a, b) => a - b);
  if (deletedIds.join(",") !== [...ids].sort((a, b) => a - b).join(",")) {
    throw Object.assign(new Error("Exact-row deletion failed."), { code: "ORPHAN_DELETE_MISMATCH" });
  }
  return { archivedIds: ids, deletedIds };
}

async function executeReconciliation(client, migrations, reviewedMessages) {
  let mutationStarted = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
    const before = await inspectDatabaseState(client, migrations, reviewedMessages);
    if (!before.preflightReady) {
      throw Object.assign(new Error("Production schema is partial or drifted."), { code: "PRODUCTION_PRESTATE_DRIFT" });
    }

    mutationStarted = true;
    const [archiveMigration, ...remainingMigrations] = migrations;
    await client.query(archiveMigration.sql);
    await recordMigration(client, archiveMigration);
    const quarantine = await quarantineReviewedMessages(client, reviewedMessages);

    for (const migration of remainingMigrations) {
      await client.query(migration.sql);
      await recordMigration(client, migration);
    }

    const after = await inspectDatabaseState(client, migrations, reviewedMessages);
    if (!after.complete) {
      throw Object.assign(new Error("Post-migration verification failed."), { code: "POSTFLIGHT_FAILED" });
    }
    await client.query("COMMIT");
    return { mutationStarted, quarantine, postflight: after };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    error.mutationStarted = mutationStarted;
    throw error;
  }
}

function publicState(state) {
  return {
    classification: state.classification,
    preflightReady: state.preflightReady,
    complete: state.complete,
    baselineRecorded: state.baselineRecorded,
    ledger: state.ledger,
    schema: {
      existingMarkerCount: state.schema.existingMarkerCount,
      expectedMarkerCount: state.schema.expectedMarkerCount,
    },
    orphanRows: state.orphanRows,
    evidenceExact: state.evidence.exact,
    archiveExact: state.archiveExact,
  };
}

async function runProductionReconciliation(options = {}) {
  const env = options.env || process.env;
  const execute = options.execute === true;
  const authorization = authorizeTarget(env, { execute, target: options.target });
  if (!authorization.authorized) {
    return { success: false, decision: "BLOCKED", code: "TARGET_NOT_AUTHORIZED", mutationStarted: false, authorization };
  }

  let migrations;
  try {
    migrations = loadApprovedMigrations(options);
  } catch (error) {
    return { success: false, decision: "BLOCKED", code: error.code || "MIGRATION_MANIFEST_INVALID", mutationStarted: false };
  }

  const backup = await (options.verifyBackupProof || verifyBackupProof)(env, {
    ...options,
    migrations,
  });
  if (!backup.verified) {
    return { success: false, decision: "BLOCKED", code: backup.code, mutationStarted: false, backup };
  }

  const client = options.client || new Client({
    connectionString: databaseUrlFromEnv(env),
    ssl: parseDatabaseUrl(databaseUrlFromEnv(env)).host.endsWith(".railway.internal")
      ? undefined
      : { rejectUnauthorized: false },
  });
  const ownsClient = !options.client;
  if (ownsClient) await client.connect();

  try {
    const databaseIdentity = await inspectDatabaseIdentity(
      client,
      options.target || manifest.EXPECTED_TARGET
    );
    if (!databaseIdentity.exact) {
      return {
        success: false,
        decision: "BLOCKED",
        code: "DATABASE_IDENTITY_MISMATCH",
        mutationStarted: false,
        backup,
        databaseIdentity,
      };
    }
    const state = await inspectDatabaseState(
      client,
      migrations,
      options.reviewedMessages || manifest.REVIEWED_ORPHAN_MESSAGES
    );
    if (state.complete) {
      return { success: true, decision: "ALREADY_APPLIED", code: "PRODUCTION_RECONCILIATION_COMPLETE", mutationStarted: false, backup, state: publicState(state) };
    }
    if (!state.preflightReady) {
      return { success: false, decision: "BLOCKED", code: "PRODUCTION_PRESTATE_DRIFT", mutationStarted: false, backup, state: publicState(state) };
    }
    if (!execute) {
      return { success: true, decision: "READY", code: "PRODUCTION_RECONCILIATION_PREFLIGHT_READY", mutationStarted: false, backup, state: publicState(state), migrations: migrations.map(({ filename, checksum }) => ({ filename, checksum })) };
    }

    const execution = await executeReconciliation(
      client,
      migrations,
      options.reviewedMessages || manifest.REVIEWED_ORPHAN_MESSAGES
    );
    return { success: true, decision: "APPLIED_AND_VERIFIED", code: "PRODUCTION_RECONCILIATION_APPLIED", mutationStarted: true, backup, execution };
  } catch (error) {
    return { success: false, decision: "BLOCKED", code: error.code || "PRODUCTION_RECONCILIATION_FAILED", mutationStarted: error.mutationStarted === true };
  } finally {
    if (ownsClient) await client.end();
  }
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  const execute = args.has("--execute");
  if ([...args].some((arg) => !["--preflight", "--execute"].includes(arg))) {
    process.stdout.write(`${JSON.stringify({ success: false, decision: "BLOCKED", code: "CLI_ARGUMENT_NOT_ALLOWED", mutationStarted: false })}\n`);
    return 1;
  }
  if (args.has("--preflight") && execute) {
    process.stdout.write(`${JSON.stringify({ success: false, decision: "BLOCKED", code: "CLI_MODE_AMBIGUOUS", mutationStarted: false })}\n`);
    return 1;
  }
  const result = await runProductionReconciliation({ execute });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.success && result.decision === "READY") return 0;
  if (result.success && result.decision === "APPLIED_AND_VERIFIED") return 0;
  if (result.success && result.decision === "ALREADY_APPLIED") return 2;
  return 1;
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = Object.freeze({
  ADVISORY_LOCK_ID,
  BACKUP_MAX_AGE_MS,
  BACKUP_PROOF_TYPES,
  CHAIN_CONFIRMATION,
  EXECUTION_TARGET,
  EXPECTED_ADDED_COLUMNS,
  REQUIRED_EXECUTION_CONFIRMATIONS,
  SOURCE_RECORD_EXPRESSION,
  authorizeTarget,
  catalogFingerprint,
  certifyLogicalBackupRestore,
  compareLedger,
  compareLogicalRestoreState,
  executeReconciliation,
  extractExpectedSchemaNames,
  inspectDatabaseState,
  inspectDatabaseIdentity,
  inspectLogicalRestoreState,
  inspectOrphanRows,
  loadApprovedMigrations,
  quarantineReviewedMessages,
  runProductionReconciliation,
  sha256,
  validateLogicalBackupArchive,
  verifyBackupProof,
  verifyLogicalPgDumpBackupProof,
  verifyRailwayManagedBackupProof,
});
