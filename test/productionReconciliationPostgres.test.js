"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { Client } = require("pg");

const manifest = require("../scripts/production-reconciliation-manifest");
const runner = require("../scripts/run-production-reconciliation");

const REPOSITORY_ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "migrations");
const POSTGRES_BINARIES = [
  "initdb",
  "pg_ctl",
  "createdb",
  "dropdb",
  "pg_dump",
  "pg_restore",
].every((name) => {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0;
});

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function startPostgres() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetro-reconciliation-pg-"));
  const port = await availablePort();
  run("initdb", [
    "-D",
    directory,
    "--auth=trust",
    "--username=postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  run("pg_ctl", [
    "-D",
    directory,
    "-l",
    path.join(directory, "postgres.log"),
    "-o",
    `-F -p ${port} -h 127.0.0.1`,
    "-w",
    "start",
  ]);
  return {
    directory,
    port,
    stop() {
      spawnSync("pg_ctl", ["-D", directory, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
      });
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function databaseUrl(port, database) {
  return `postgresql://postgres@127.0.0.1:${port}/${database}`;
}

async function createDatabase(port, database) {
  run("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", database]);
  const client = new Client({ connectionString: databaseUrl(port, database) });
  await client.connect();
  return client;
}

async function establishProductionLikePrestate(client) {
  await client.query(
    fs.readFileSync(
      path.join(MIGRATIONS_DIRECTORY, "202607050001_initial_schema_baseline.sql"),
      "utf8"
    )
  );
  await client.query(`
    CREATE TABLE schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      execution_target TEXT NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const migration of manifest.EXPECTED_RECORDED_MIGRATIONS) {
    await client.query(
      fs.readFileSync(path.join(MIGRATIONS_DIRECTORY, migration.filename), "utf8")
    );
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum, execution_target) VALUES ($1, $2, 'disposable-production-boundary')",
      [migration.filename, migration.checksum]
    );
  }

  await client.query(`
    ALTER TABLE messages
      DROP CONSTRAINT IF EXISTS messages_quote_request_id_fkey,
      DROP CONSTRAINT IF EXISTS messages_sender_id_fkey,
      DROP CONSTRAINT IF EXISTS messages_receiver_id_fkey,
      ALTER COLUMN quote_request_id DROP NOT NULL,
      ALTER COLUMN sender_id DROP NOT NULL
  `);

  await client.query(`
    INSERT INTO users
      (id, username, email, password_hash, role, account_type,
       business_name, business_category, profile_photo_url)
    VALUES
      (40, 'professional-40', 'professional40@example.test', 'hash',
       'Handyman', 'professional', 'Example Pro', 'Home Repair', ''),
      (41, 'homeowner-41', 'homeowner41@example.test', 'hash',
       'homeowner', 'homeowner', '', '', '')
  `);
  await client.query(`
    INSERT INTO contractor_profiles (id, user_id, business_name, category)
    VALUES (1, 40, 'Example Pro', 'Home Repair')
  `);
  await client.query(`
    INSERT INTO posts (id, user_id, title, description, location, category)
    VALUES (1, 41, 'Synthetic request', 'Disposable certification',
      'Example City', 'Home Repair')
  `);
  await client.query(`
    INSERT INTO request_relationships
      (id, post_id, homeowner_id, contractor_id, professional_user_id)
    VALUES (1, 1, 41, 1, 40)
  `);
  await client.query(`
    INSERT INTO conversations
      (id, relationship_id, homeowner_id, contractor_id, professional_user_id)
    VALUES (1, 1, 41, 1, 40)
  `);
  await client.query(`
    INSERT INTO messages
      (id, quote_request_id, sender_id, receiver_id, message_text,
       image_url, message_type, workflow_type, workflow_status,
       workflow_payload, created_at)
    VALUES
      (8, NULL, 40, 2, 'alpha', NULL, 'text', NULL, 'sending', '{}'::jsonb,
       '2026-05-12 01:45:35.552856'),
      (9, NULL, 40, NULL, 'synthetic receiverless', NULL, 'text', NULL,
       'sending', '{}'::jsonb, '2026-05-12 01:45:35.552856'),
      (10, NULL, 40, 2, 'synthetic orphan row', NULL, 'text', NULL,
       'sending', '{}'::jsonb, '2026-05-12 01:45:35.552856'),
      (11, 26, 40, 2, 'synthetic dangling row', NULL, 'text', NULL,
       'sending', '{}'::jsonb, '2026-05-12 01:45:35.552856')
  `);
}

async function reviewedMessages(client) {
  const placeholder = [8, 9, 10, 11].map((id) => ({ id, sha256: "" }));
  const inspected = await runner.inspectOrphanRows(client, placeholder);
  return inspected.rows.map(({ id, sha256 }) => ({ id, sha256 }));
}

function targetFor(database) {
  return { ...manifest.EXPECTED_TARGET, databaseName: database };
}

function envFor(database) {
  const target = manifest.EXPECTED_TARGET;
  return {
    NODE_ENV: "production",
    RAILWAY_PROJECT_ID: target.projectId,
    RAILWAY_PROJECT_NAME: target.projectName,
    RAILWAY_ENVIRONMENT_ID: target.environmentId,
    RAILWAY_ENVIRONMENT_NAME: target.environmentName,
    RAILWAY_SERVICE_ID: target.databaseServiceId,
    RAILWAY_SERVICE_NAME: target.databaseServiceName,
    DATABASE_URL: `postgresql://runner:secret@example.proxy.rlwy.net/${database}`,
    CONFIRM_PRODUCTION_TARGET: `profound-magic/production/Postgres/${database}`,
    CONFIRM_PRODUCTION_RECONCILIATION: "YES",
    CONFIRM_ORPHAN_POLICY: "PRESERVE_AND_QUARANTINE",
    CONFIRM_PRODUCTION_RECONCILIATION_CHAIN: runner.CHAIN_CONFIRMATION,
    CONFIRM_PRODUCTION_MUTATION: "EXECUTE",
  };
}

const verifiedBackup = async () => ({
  verified: true,
  code: "BACKUP_VERIFIED",
  backup: {
    id: "disposable-backup",
    createdAt: "2026-08-09T01:00:00.000Z",
    volumeInstanceId: manifest.EXPECTED_TARGET.volumeInstanceId,
  },
  autoDeployEnabled: false,
});

test(
  "logical pg_dump restore certification validates counts, schema, and cleanup",
  { skip: !POSTGRES_BINARIES, timeout: 120000 },
  async () => {
    const postgres = await startPostgres();
    const backupDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "meetro-logical-backup-test-")
    );
    try {
      fs.chmodSync(backupDirectory, 0o700);
      const sourceClient = await createDatabase(postgres.port, "logical_backup_source");
      await establishProductionLikePrestate(sourceClient);
      const reviewed = await reviewedMessages(sourceClient);
      const migrations = runner.loadApprovedMigrations();
      const expected = await runner.inspectLogicalRestoreState(
        sourceClient,
        migrations,
        reviewed
      );
      const certification = {
        sourcePostgresMajor: 18,
        counts: expected.counts,
        tables: expected.tables,
        catalog: expected.catalog,
      };
      const backupPath = path.join(backupDirectory, "synthetic-production.dump");
      run("pg_dump", [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--file=${backupPath}`,
        databaseUrl(postgres.port, "logical_backup_source"),
      ]);
      fs.chmodSync(backupPath, 0o600);

      const verified = await runner.certifyLogicalBackupRestore({
        backupPath,
        target: targetFor("logical_backup_source"),
        certification,
        migrations,
        reviewedMessages: reviewed,
      });
      assert.equal(verified.verified, true, JSON.stringify(verified));
      assert.match(verified.databaseName, /^meetro_test_/);
      assert.equal(Object.values(verified.cleanup).every(Boolean), true);

      const countMismatch = await runner.certifyLogicalBackupRestore({
        backupPath,
        target: targetFor("logical_backup_source"),
        certification: {
          ...certification,
          counts: { ...certification.counts, messages: certification.counts.messages + 1 },
        },
        migrations,
        reviewedMessages: reviewed,
      });
      assert.equal(countMismatch.code, "LOGICAL_BACKUP_RESTORE_COUNT_MISMATCH");
      assert.equal(Object.values(countMismatch.cleanup).every(Boolean), true);

      const schemaMismatch = await runner.certifyLogicalBackupRestore({
        backupPath,
        target: targetFor("logical_backup_source"),
        certification: {
          ...certification,
          catalog: {
            ...certification.catalog,
            columns: { ...certification.catalog.columns, sha256: "0".repeat(64) },
          },
        },
        migrations,
        reviewedMessages: reviewed,
      });
      assert.equal(schemaMismatch.code, "LOGICAL_BACKUP_RESTORE_SCHEMA_MISMATCH");
      assert.equal(Object.values(schemaMismatch.cleanup).every(Boolean), true);
      await sourceClient.end();
    } finally {
      fs.rmSync(backupDirectory, { recursive: true, force: true });
      postgres.stop();
    }
  }
);

test(
  "disposable PostgreSQL certifies atomic quarantine, convergence, replay, and rollback",
  { skip: !POSTGRES_BINARIES, timeout: 120000 },
  async () => {
    const postgres = await startPostgres();
    try {
      const successClient = await createDatabase(postgres.port, "reconcile_success");
      await establishProductionLikePrestate(successClient);
      const reviewed = await reviewedMessages(successClient);

      const applied = await runner.runProductionReconciliation({
        client: successClient,
        env: envFor("reconcile_success"),
        execute: true,
        reviewedMessages: reviewed,
        target: targetFor("reconcile_success"),
        verifyBackupProof: verifiedBackup,
      });
      assert.equal(applied.success, true, JSON.stringify(applied));
      assert.equal(applied.decision, "APPLIED_AND_VERIFIED");
      assert.deepEqual(applied.execution.quarantine.deletedIds, [8, 9, 10, 11]);

      const archive = await successClient.query(`
        SELECT message_id, source_record_sha256, canonical_authority_granted,
          authority_classification
        FROM legacy_orphan_message_archive
        ORDER BY message_id
      `);
      assert.deepEqual(archive.rows.map(({ message_id }) => message_id), [8, 9, 10, 11]);
      assert.equal(
        archive.rows.every((row) =>
          row.canonical_authority_granted === false &&
          row.authority_classification === "historical_evidence_only" &&
          reviewed.some(
            (expected) =>
              expected.id === row.message_id &&
              expected.sha256 === row.source_record_sha256
          )
        ),
        true
      );
      assert.equal(
        Number((await successClient.query("SELECT count(*) FROM messages WHERE id BETWEEN 8 AND 11")).rows[0].count),
        0
      );
      assert.equal(
        Number((await successClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count),
        26
      );
      assert.equal(
        Number((await successClient.query("SELECT count(*) FROM schema_migrations WHERE filename = '202607050001_initial_schema_baseline.sql'")).rows[0].count),
        0
      );
      assert.equal(
        (await successClient.query("SELECT to_regclass('public.alerts') IS NOT NULL AS present")).rows[0].present,
        true
      );
      assert.equal(
        (await successClient.query("SELECT to_regclass('public.request_selections') IS NOT NULL AS present")).rows[0].present,
        true
      );
      await assert.rejects(
        successClient.query(
          "UPDATE legacy_orphan_message_archive SET quarantine_reason = quarantine_reason WHERE message_id = 8"
        ),
        /immutable/
      );

      const replay = await runner.runProductionReconciliation({
        client: successClient,
        env: envFor("reconcile_success"),
        execute: true,
        reviewedMessages: reviewed,
        target: targetFor("reconcile_success"),
        verifyBackupProof: verifiedBackup,
      });
      assert.equal(replay.success, true, JSON.stringify(replay));
      assert.equal(replay.decision, "ALREADY_APPLIED");
      assert.equal(replay.mutationStarted, false);
      await successClient.end();

      const rollbackClient = await createDatabase(postgres.port, "reconcile_rollback");
      await establishProductionLikePrestate(rollbackClient);
      const rollbackReviewed = await reviewedMessages(rollbackClient);
      const migrations = runner.loadApprovedMigrations().map((migration) => ({ ...migration }));
      migrations[2].sql = "THIS IS NOT VALID SQL";

      await assert.rejects(
        runner.executeReconciliation(rollbackClient, migrations, rollbackReviewed)
      );
      assert.equal(
        (await rollbackClient.query("SELECT to_regclass('public.legacy_orphan_message_archive') IS NULL AS absent")).rows[0].absent,
        true
      );
      assert.equal(
        Number((await rollbackClient.query("SELECT count(*) FROM messages WHERE id BETWEEN 8 AND 11")).rows[0].count),
        4
      );
      assert.equal(
        Number((await rollbackClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count),
        14
      );

      await rollbackClient.query("UPDATE messages SET workflow_status = 'changed' WHERE id = 8");
      const changed = await runner.runProductionReconciliation({
        client: rollbackClient,
        env: envFor("reconcile_rollback"),
        execute: false,
        reviewedMessages: rollbackReviewed,
        target: targetFor("reconcile_rollback"),
        verifyBackupProof: verifiedBackup,
      });
      assert.equal(changed.code, "PRODUCTION_PRESTATE_DRIFT");
      assert.equal(changed.mutationStarted, false);
      await rollbackClient.end();

      const dryRunClient = await createDatabase(postgres.port, "reconcile_dry_run");
      await establishProductionLikePrestate(dryRunClient);
      const dryRunReviewed = await reviewedMessages(dryRunClient);
      const dryRun = await runner.runProductionReconciliation({
        client: dryRunClient,
        env: envFor("reconcile_dry_run"),
        execute: false,
        reviewedMessages: dryRunReviewed,
        target: targetFor("reconcile_dry_run"),
        verifyBackupProof: verifiedBackup,
      });
      assert.equal(dryRun.decision, "READY", JSON.stringify(dryRun));
      assert.equal(dryRun.mutationStarted, false);
      assert.equal(
        Number((await dryRunClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count),
        14
      );
      assert.equal(
        Number((await dryRunClient.query("SELECT count(*) FROM messages")).rows[0].count),
        4
      );
      assert.equal(
        (await dryRunClient.query("SELECT to_regclass('public.legacy_orphan_message_archive') IS NULL AS absent")).rows[0].absent,
        true
      );
      await dryRunClient.end();

      const ledgerClient = await createDatabase(postgres.port, "reconcile_ledger_drift");
      await establishProductionLikePrestate(ledgerClient);
      const ledgerReviewed = await reviewedMessages(ledgerClient);
      await ledgerClient.query(
        "UPDATE schema_migrations SET checksum = 'drift' WHERE filename = $1",
        [manifest.EXPECTED_RECORDED_MIGRATIONS[0].filename]
      );
      const ledgerDrift = await runner.runProductionReconciliation({
        client: ledgerClient,
        env: envFor("reconcile_ledger_drift"),
        execute: false,
        reviewedMessages: ledgerReviewed,
        target: targetFor("reconcile_ledger_drift"),
        verifyBackupProof: verifiedBackup,
      });
      assert.equal(ledgerDrift.code, "PRODUCTION_PRESTATE_DRIFT");
      assert.equal(ledgerDrift.state.ledger.preflight.exact, false);
      assert.equal(ledgerDrift.mutationStarted, false);
      await ledgerClient.end();

      const partialClient = await createDatabase(postgres.port, "reconcile_partial_schema");
      await establishProductionLikePrestate(partialClient);
      const partialReviewed = await reviewedMessages(partialClient);
      await partialClient.query(runner.loadApprovedMigrations()[0].sql);
      const partial = await runner.runProductionReconciliation({
        client: partialClient,
        env: envFor("reconcile_partial_schema"),
        execute: false,
        reviewedMessages: partialReviewed,
        target: targetFor("reconcile_partial_schema"),
        verifyBackupProof: verifiedBackup,
      });
      assert.equal(partial.code, "PRODUCTION_PRESTATE_DRIFT");
      assert.ok(partial.state.schema.existingMarkerCount > 0);
      assert.equal(partial.mutationStarted, false);
      await partialClient.end();
    } finally {
      postgres.stop();
    }
  }
);
