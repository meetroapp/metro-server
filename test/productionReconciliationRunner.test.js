"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manifest = require("../scripts/production-reconciliation-manifest");
const runner = require("../scripts/run-production-reconciliation");

const REPOSITORY_ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "migrations");

function authorizedEnv(overrides = {}) {
  const target = manifest.EXPECTED_TARGET;
  return {
    NODE_ENV: "production",
    RAILWAY_PROJECT_ID: target.projectId,
    RAILWAY_PROJECT_NAME: target.projectName,
    RAILWAY_ENVIRONMENT_ID: target.environmentId,
    RAILWAY_ENVIRONMENT_NAME: target.environmentName,
    RAILWAY_SERVICE_ID: target.databaseServiceId,
    RAILWAY_SERVICE_NAME: target.databaseServiceName,
    DATABASE_URL: "postgresql://user:secret@example.proxy.rlwy.net/railway",
    CONFIRM_PRODUCTION_TARGET: "profound-magic/production/Postgres/railway",
    CONFIRM_PRODUCTION_RECONCILIATION: "YES",
    CONFIRM_ORPHAN_POLICY: "PRESERVE_AND_QUARANTINE",
    CONFIRM_PRODUCTION_RECONCILIATION_CHAIN: runner.CHAIN_CONFIRMATION,
    CONFIRM_PRODUCTION_MUTATION: "EXECUTE",
    PRODUCTION_BACKUP_TYPE: runner.BACKUP_PROOF_TYPES.RAILWAY_MANAGED,
    ...overrides,
  };
}

const LOGICAL_BACKUP_TIME = "2026-08-09T01:42:32.000Z";

function logicalArchiveList({
  database = "railway",
  format = "CUSTOM",
  sourceVersion = "18.4",
  dumpToolVersion = "18.4",
} = {}) {
  return `;
; Archive created at 2026-08-08 21:42:23 EDT
;     dbname: ${database}
;     TOC Entries: 139
;     Compression: gzip
;     Dump Version: 1.16-0
;     Format: ${format}
;     Dumped from database version: ${sourceVersion}
;     Dumped by pg_dump version: ${dumpToolVersion}
;
`;
}

function logicalSpawn({ list = logicalArchiveList(), listStatus = 0, restoreVersion = "18.4" } = {}) {
  return (command, args) => {
    if (command !== "pg_restore") return { status: 1, stdout: "", stderr: "" };
    if (args.includes("--list")) {
      return { status: listStatus, stdout: listStatus === 0 ? list : "", stderr: "" };
    }
    if (args.includes("--version")) {
      return { status: 0, stdout: `pg_restore (PostgreSQL) ${restoreVersion}\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
}

function createLogicalArchive() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meetro-logical-proof-"));
  const archivePath = path.join(directory, "production.dump");
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(archivePath, "synthetic custom archive", { mode: 0o600 });
  const timestamp = new Date(LOGICAL_BACKUP_TIME);
  fs.utimesSync(archivePath, timestamp, timestamp);
  return {
    directory,
    archivePath,
    sha256: runner.sha256("synthetic custom archive"),
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function logicalEnv(archive, overrides = {}) {
  const target = manifest.EXPECTED_TARGET;
  return {
    PRODUCTION_BACKUP_TYPE: runner.BACKUP_PROOF_TYPES.LOGICAL_PG_DUMP,
    PRODUCTION_BACKUP_PATH: archive.archivePath,
    PRODUCTION_BACKUP_SHA256: archive.sha256,
    PRODUCTION_BACKUP_CREATED_AT: LOGICAL_BACKUP_TIME,
    PRODUCTION_BACKUP_DATABASE: target.databaseName,
    PRODUCTION_BACKUP_PROJECT_ID: target.projectId,
    PRODUCTION_BACKUP_ENVIRONMENT_ID: target.environmentId,
    PRODUCTION_BACKUP_POSTGRES_SERVICE_ID: target.databaseServiceId,
    PRODUCTION_BACKUP_VOLUME_ID: target.volumeId,
    PRODUCTION_BACKUP_VOLUME_INSTANCE_ID: target.volumeInstanceId,
    RAILWAY_API_TOKEN: "not-printed",
    ...overrides,
  };
}

function verifiedLogicalRestore(overrides = {}) {
  return async () => ({
    verified: true,
    code: "LOGICAL_BACKUP_RESTORE_VERIFIED",
    databaseName: "meetro_test_verified",
    cleanup: {
      databaseDropped: true,
      serverStopped: true,
      temporaryFilesRemoved: true,
    },
    certification: { prestateClassification: "EXPECTED_PRESTATE" },
    ...overrides,
  });
}

function backupResponse({
  backupId = "backup-1",
  createdAt = "2026-08-09T01:00:00.000Z",
  expiresAt = "2026-08-10T01:00:00.000Z",
  autoDeployEnabled = false,
} = {}) {
  return async () => ({
    ok: true,
    json: async () => ({
      data: {
        autoDeploy: {
          enabled: autoDeployEnabled,
          canEnable: true,
          reason: null,
        },
        backups: [
          {
            id: backupId,
            createdAt,
            expiresAt,
            referencedMB: 100,
            usedMB: 100,
            volumeInstanceSizeMB: 500,
          },
        ],
      },
    }),
  });
}

test("pins the exact orphan set and migration order without baseline", () => {
  assert.deepEqual(
    manifest.REVIEWED_ORPHAN_MESSAGES.map(({ id }) => id),
    [8, 9, 10, 11]
  );
  for (const message of manifest.REVIEWED_ORPHAN_MESSAGES) {
    assert.match(message.sha256, /^[0-9a-f]{64}$/);
  }

  const migrations = runner.loadApprovedMigrations();
  assert.equal(migrations.length, 12);
  assert.equal(
    migrations[0].filename,
    "202608090001_create_legacy_orphan_message_archive.sql"
  );
  assert.equal(
    migrations[1].filename,
    "202607210001_add_message_conversation_identity.sql"
  );
  assert.equal(
    migrations.at(-1).filename,
    "202608070003_add_job_request_service_location.sql"
  );
  assert.equal(
    migrations.some(({ filename }) => filename.includes("initial_schema_baseline")),
    false
  );
});

test("refuses wrong production identity and missing execution confirmations", () => {
  assert.equal(runner.authorizeTarget(authorizedEnv(), { execute: true }).authorized, true);

  const wrongEnvironment = runner.authorizeTarget(
    authorizedEnv({ RAILWAY_ENVIRONMENT_NAME: "staging" }),
    { execute: true }
  );
  assert.equal(wrongEnvironment.authorized, false);
  assert.ok(wrongEnvironment.reasons.includes("RAILWAY_ENVIRONMENT_NAME_MISMATCH"));

  const missingConfirmation = runner.authorizeTarget(
    authorizedEnv({ CONFIRM_PRODUCTION_MUTATION: "" }),
    { execute: true }
  );
  assert.equal(missingConfirmation.authorized, false);
  assert.ok(missingConfirmation.reasons.includes("CONFIRM_PRODUCTION_MUTATION_MISMATCH"));
});

test("requires an explicit supported backup proof type", async () => {
  const missing = await runner.verifyBackupProof({});
  assert.equal(missing.code, "BACKUP_PROOF_TYPE_REQUIRED");

  const unsupported = await runner.verifyBackupProof({
    PRODUCTION_BACKUP_TYPE: "implicit-or-unknown",
  });
  assert.equal(unsupported.code, "BACKUP_PROOF_TYPE_UNSUPPORTED");
});

test("requires a Railway-verified recent backup and disabled auto-deploy", async () => {
  const now = new Date("2026-08-09T02:00:00.000Z");
  const missing = await runner.verifyBackupProof(
    { PRODUCTION_BACKUP_TYPE: runner.BACKUP_PROOF_TYPES.RAILWAY_MANAGED },
    { now }
  );
  assert.equal(missing.code, "BACKUP_PROOF_REQUIRED");

  const env = {
    PRODUCTION_BACKUP_TYPE: runner.BACKUP_PROOF_TYPES.RAILWAY_MANAGED,
    RAILWAY_API_TOKEN: "not-printed",
    PRODUCTION_BACKUP_ID: "backup-1",
    PRODUCTION_BACKUP_CREATED_AT: "2026-08-09T01:00:00.000Z",
  };
  const verified = await runner.verifyBackupProof(env, {
    now,
    fetchImpl: backupResponse(),
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.backup.volumeInstanceId, manifest.EXPECTED_TARGET.volumeInstanceId);

  const stale = await runner.verifyBackupProof(
    { ...env, PRODUCTION_BACKUP_CREATED_AT: "2026-08-07T01:00:00.000Z" },
    {
      now,
      fetchImpl: backupResponse({
        createdAt: "2026-08-07T01:00:00.000Z",
        expiresAt: "2026-08-10T01:00:00.000Z",
      }),
    }
  );
  assert.equal(stale.code, "BACKUP_NOT_RECENT");

  const autoDeploy = await runner.verifyBackupProof(env, {
    now,
    fetchImpl: backupResponse({ autoDeployEnabled: true }),
  });
  assert.equal(autoDeploy.code, "PRODUCTION_AUTO_DEPLOY_ENABLED");
});

test("accepts an exact logical pg_dump proof without Railway fallback", async () => {
  const archive = createLogicalArchive();
  try {
    const verified = await runner.verifyBackupProof(logicalEnv(archive), {
      now: new Date("2026-08-09T02:00:00.000Z"),
      spawnSyncImpl: logicalSpawn(),
      fetchImpl: backupResponse(),
      certifyLogicalBackupRestore: verifiedLogicalRestore(),
    });
    assert.equal(verified.verified, true, JSON.stringify(verified));
    assert.equal(verified.backup.type, runner.BACKUP_PROOF_TYPES.LOGICAL_PG_DUMP);
    assert.equal(verified.backup.sha256, archive.sha256);
    assert.equal(verified.backup.volumeId, manifest.EXPECTED_TARGET.volumeId);
    assert.equal("id" in verified.backup, false);
  } finally {
    archive.cleanup();
  }
});

test("logical proof rejects relative and repository-contained paths", async () => {
  const archive = createLogicalArchive();
  try {
    const relative = await runner.validateLogicalBackupArchive(
      logicalEnv(archive, { PRODUCTION_BACKUP_PATH: "production.dump" })
    );
    assert.equal(relative.code, "BACKUP_PATH_NOT_ABSOLUTE");

    const repository = await runner.validateLogicalBackupArchive(
      logicalEnv(archive, { PRODUCTION_BACKUP_PATH: __filename })
    );
    assert.equal(repository.code, "BACKUP_PATH_INSIDE_REPOSITORY");
  } finally {
    archive.cleanup();
  }
});

test("logical proof rejects symlinks and insecure directory or file modes", async () => {
  const archive = createLogicalArchive();
  const symlinkPath = path.join(archive.directory, "linked.dump");
  fs.symlinkSync(archive.archivePath, symlinkPath);
  try {
    const symlink = await runner.validateLogicalBackupArchive(
      logicalEnv(archive, { PRODUCTION_BACKUP_PATH: symlinkPath })
    );
    assert.equal(symlink.code, "BACKUP_PATH_SYMLINK");

    fs.chmodSync(archive.archivePath, 0o644);
    const insecureFile = await runner.validateLogicalBackupArchive(logicalEnv(archive));
    assert.equal(insecureFile.code, "BACKUP_FILE_PERMISSIONS_INSECURE");

    fs.chmodSync(archive.archivePath, 0o600);
    fs.chmodSync(archive.directory, 0o755);
    const insecureDirectory = await runner.validateLogicalBackupArchive(logicalEnv(archive));
    assert.equal(insecureDirectory.code, "BACKUP_DIRECTORY_PERMISSIONS_INSECURE");
  } finally {
    archive.cleanup();
  }
});

test("logical proof rejects checksum, timestamp, and freshness failures", async () => {
  const archive = createLogicalArchive();
  try {
    const wrongChecksum = await runner.validateLogicalBackupArchive(
      logicalEnv(archive, { PRODUCTION_BACKUP_SHA256: "0".repeat(64) })
    );
    assert.equal(wrongChecksum.code, "BACKUP_SHA256_MISMATCH");

    const missingChecksum = await runner.validateLogicalBackupArchive(
      logicalEnv(archive, { PRODUCTION_BACKUP_SHA256: "" })
    );
    assert.equal(missingChecksum.code, "LOGICAL_BACKUP_PROOF_REQUIRED");

    const wrongTimestamp = await runner.validateLogicalBackupArchive(
      logicalEnv(archive, { PRODUCTION_BACKUP_CREATED_AT: "2026-08-09T01:42:30.000Z" })
    );
    assert.equal(wrongTimestamp.code, "BACKUP_TIMESTAMP_MISMATCH");

    const stale = await runner.validateLogicalBackupArchive(logicalEnv(archive), {
      now: new Date("2026-08-10T01:42:33.000Z"),
    });
    assert.equal(stale.code, "BACKUP_NOT_RECENT");
  } finally {
    archive.cleanup();
  }
});

test("logical proof pins every production backup identity", async () => {
  const archive = createLogicalArchive();
  const cases = [
    ["PRODUCTION_BACKUP_DATABASE", "wrong", "BACKUP_DATABASE_MISMATCH"],
    ["PRODUCTION_BACKUP_PROJECT_ID", "wrong", "BACKUP_PROJECT_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_ENVIRONMENT_ID", "wrong", "BACKUP_ENVIRONMENT_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_POSTGRES_SERVICE_ID", "wrong", "BACKUP_SERVICE_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_VOLUME_ID", "wrong", "BACKUP_VOLUME_ID_MISMATCH"],
    ["PRODUCTION_BACKUP_VOLUME_INSTANCE_ID", "wrong", "BACKUP_VOLUME_INSTANCE_ID_MISMATCH"],
  ];
  try {
    for (const [name, value, code] of cases) {
      const result = await runner.validateLogicalBackupArchive(
        logicalEnv(archive, { [name]: value })
      );
      assert.equal(result.code, code, name);
    }
  } finally {
    archive.cleanup();
  }
});

test("logical proof rejects corrupt, wrong-format, wrong-database, and incompatible archives", async () => {
  const archive = createLogicalArchive();
  const now = new Date("2026-08-09T02:00:00.000Z");
  try {
    const unreadable = await runner.validateLogicalBackupArchive(logicalEnv(archive), {
      now,
      spawnSyncImpl: logicalSpawn({ listStatus: 1 }),
    });
    assert.equal(unreadable.code, "BACKUP_ARCHIVE_UNREADABLE");

    const format = await runner.validateLogicalBackupArchive(logicalEnv(archive), {
      now,
      spawnSyncImpl: logicalSpawn({ list: logicalArchiveList({ format: "TAR" }) }),
    });
    assert.equal(format.code, "BACKUP_ARCHIVE_FORMAT_INVALID");

    const database = await runner.validateLogicalBackupArchive(logicalEnv(archive), {
      now,
      spawnSyncImpl: logicalSpawn({ list: logicalArchiveList({ database: "staging" }) }),
    });
    assert.equal(database.code, "BACKUP_DATABASE_MISMATCH");

    const version = await runner.validateLogicalBackupArchive(logicalEnv(archive), {
      now,
      spawnSyncImpl: logicalSpawn({ restoreVersion: "17.9" }),
    });
    assert.equal(version.code, "BACKUP_TOOL_VERSION_INCOMPATIBLE");
  } finally {
    archive.cleanup();
  }
});

test("logical restore failure and incomplete cleanup block proof", async () => {
  const archive = createLogicalArchive();
  const options = {
    now: new Date("2026-08-09T02:00:00.000Z"),
    spawnSyncImpl: logicalSpawn(),
    fetchImpl: backupResponse(),
  };
  try {
    const restoreFailure = await runner.verifyBackupProof(logicalEnv(archive), {
      ...options,
      certifyLogicalBackupRestore: async () => ({
        verified: false,
        code: "LOGICAL_BACKUP_RESTORE_FAILED",
        cleanup: {
          databaseDropped: true,
          serverStopped: true,
          temporaryFilesRemoved: true,
        },
      }),
    });
    assert.equal(restoreFailure.code, "LOGICAL_BACKUP_RESTORE_FAILED");

    const cleanupFailure = await runner.verifyBackupProof(logicalEnv(archive), {
      ...options,
      certifyLogicalBackupRestore: verifiedLogicalRestore({
        cleanup: {
          databaseDropped: true,
          serverStopped: false,
          temporaryFilesRemoved: true,
        },
      }),
    });
    assert.equal(cleanupFailure.code, "LOGICAL_BACKUP_RESTORE_CLEANUP_FAILED");

    const changedDuringRestore = await runner.verifyBackupProof(logicalEnv(archive), {
      ...options,
      certifyLogicalBackupRestore: async () => {
        fs.appendFileSync(archive.archivePath, "changed");
        return verifiedLogicalRestore()();
      },
    });
    assert.equal(
      changedDuringRestore.code,
      "BACKUP_ARCHIVE_CHANGED_DURING_CERTIFICATION"
    );
  } finally {
    archive.cleanup();
  }
});

test("logical proof cannot use Railway fields as an implicit fallback", async () => {
  const result = await runner.verifyBackupProof({
    PRODUCTION_BACKUP_TYPE: runner.BACKUP_PROOF_TYPES.LOGICAL_PG_DUMP,
    RAILWAY_API_TOKEN: "not-printed",
    PRODUCTION_BACKUP_ID: "backup-1",
    PRODUCTION_BACKUP_CREATED_AT: LOGICAL_BACKUP_TIME,
  });
  assert.equal(result.code, "LOGICAL_BACKUP_PROOF_REQUIRED");
});

test("logical proof rejects enabled production auto-deploy", async () => {
  const archive = createLogicalArchive();
  try {
    const result = await runner.verifyBackupProof(logicalEnv(archive), {
      now: new Date("2026-08-09T02:00:00.000Z"),
      spawnSyncImpl: logicalSpawn(),
      fetchImpl: backupResponse({ autoDeployEnabled: true }),
      certifyLogicalBackupRestore: verifiedLogicalRestore(),
    });
    assert.equal(result.code, "PRODUCTION_AUTO_DEPLOY_ENABLED");
  } finally {
    archive.cleanup();
  }
});

test("refuses baseline inclusion, unapproved migrations, and checksum drift", () => {
  assert.throws(
    () =>
      runner.loadApprovedMigrations({
        approvedMigrations: [
          {
            filename: "202607050001_initial_schema_baseline.sql",
            checksum: "unused",
          },
        ],
      }),
    (error) => error.code === "BASELINE_MIGRATION_PROHIBITED"
  );

  assert.throws(
    () =>
      runner.loadApprovedMigrations({
        approvedMigrations: [
          {
            filename: "202607130001_add_user_token_version.sql",
            checksum: "0".repeat(64),
          },
        ],
      }),
    (error) => error.code === "MIGRATION_CHECKSUM_DRIFT"
  );

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "meetro-reconcile-"));
  try {
    for (const migration of manifest.APPROVED_MIGRATIONS) {
      fs.copyFileSync(
        path.join(MIGRATIONS_DIRECTORY, migration.filename),
        path.join(temporaryDirectory, migration.filename)
      );
    }
    fs.appendFileSync(
      path.join(temporaryDirectory, manifest.APPROVED_MIGRATIONS[1].filename),
      "\n-- drift\n"
    );
    assert.throws(
      () =>
        runner.loadApprovedMigrations({
          migrationsDirectory: fs.realpathSync(temporaryDirectory),
        }),
      (error) => error.code === "MIGRATION_CHECKSUM_DRIFT"
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("ledger comparison rejects extras, missing entries, and checksum drift", () => {
  const rows = manifest.EXPECTED_RECORDED_MIGRATIONS.map((entry) => ({ ...entry }));
  assert.equal(runner.compareLedger(rows, []).exact, true);
  assert.equal(
    runner.compareLedger([...rows, { filename: "unexpected.sql", checksum: "x" }], []).exact,
    false
  );
  assert.equal(runner.compareLedger(rows.slice(1), []).exact, false);
  assert.equal(
    runner.compareLedger([{ ...rows[0], checksum: "x" }, ...rows.slice(1)], []).exact,
    false
  );
});

test("runner blocks before database access when target or backup proof fails", async () => {
  const wrongTarget = await runner.runProductionReconciliation({
    env: authorizedEnv({ RAILWAY_PROJECT_ID: "wrong" }),
  });
  assert.equal(wrongTarget.code, "TARGET_NOT_AUTHORIZED");
  assert.equal(wrongTarget.mutationStarted, false);

  const noBackup = await runner.runProductionReconciliation({
    env: authorizedEnv(),
    verifyBackupProof: async () => ({
      verified: false,
      code: "BACKUP_PROOF_REQUIRED",
    }),
  });
  assert.equal(noBackup.code, "BACKUP_PROOF_REQUIRED");
  assert.equal(noBackup.mutationStarted, false);

  const noExecuteAuthority = await runner.runProductionReconciliation({
    env: authorizedEnv({ CONFIRM_PRODUCTION_MUTATION: "" }),
    execute: true,
    verifyBackupProof: async () => ({ verified: true }),
  });
  assert.equal(noExecuteAuthority.code, "TARGET_NOT_AUTHORIZED");
  assert.equal(noExecuteAuthority.mutationStarted, false);
});
