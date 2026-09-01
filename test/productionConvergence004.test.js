"use strict";

const assert = require("node:assert/strict");
const {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const manifest = require("../production-convergence/004/manifest");
const {
  assertPostflightSnapshot,
  assertPreflightSnapshot,
  classifySnapshot,
  expectedPostLedger,
  extractTargetMarkers,
  inspectAuthorization,
  loadTargetMigrations,
  validateManifest,
} = require("../production-convergence/004/assertions");
const {
  executeConvergence,
  parseMode,
  run,
} = require("../scripts/run-production-convergence-004");

function validEnvironment() {
  return {
    NODE_ENV: "production",
    RAILWAY_PROJECT_ID: manifest.EXPECTED_PRODUCTION_TARGET.projectId,
    RAILWAY_PROJECT_NAME: manifest.EXPECTED_PRODUCTION_TARGET.projectName,
    RAILWAY_ENVIRONMENT_ID: manifest.EXPECTED_PRODUCTION_TARGET.environmentId,
    RAILWAY_ENVIRONMENT_NAME: "production",
    RAILWAY_SERVICE_ID: manifest.EXPECTED_PRODUCTION_TARGET.databaseServiceId,
    RAILWAY_SERVICE_NAME: "Postgres",
    EXPECTED_PRESTATE_SERVER_SHA: manifest.PRODUCTION_PRESTATE.serverSha,
    EXPECTED_PRESTATE_IMAGE_DIGEST: manifest.PRODUCTION_PRESTATE.imageDigest,
    EXPECTED_PRODUCTION_DEPLOYMENT_ID: manifest.PRODUCTION_PRESTATE.deploymentId,
    CONFIRM_PRODUCTION_TARGET: "profound-magic/production/Postgres/railway",
    PRODUCTION_CONVERGENCE_ID: manifest.CONVERGENCE_ID,
    CERTIFIED_BACKUP_REFERENCE: "backup-certification-reference",
    CERTIFIED_BACKUP_SHA256: "a".repeat(64),
    RESTORE_CERTIFICATION_REFERENCE: "restore-certification-reference",
    MAINTENANCE_TRAFFIC_PAUSE_PROOF: "maintenance-proof-reference",
    CONFIRM_PRODUCTION_CONVERGENCE: "EXECUTE_MC_PRODUCTION_CONVERGENCE_004",
  };
}

function preSnapshot() {
  return {
    postgresVersion: "18.6 (synthetic)",
    ledger: manifest.CURRENT_PRODUCTION_LEDGER.map((entry) => ({ ...entry })),
    archiveLedger: { ...manifest.ARCHIVE_MIGRATION },
    catalog: structuredClone(manifest.PRODUCTION_PRESTATE.catalog),
    preservation: structuredClone(manifest.PRODUCTION_PRESTATE.preservation),
    targetMarkers: { expected: 10, present: 0 },
    operationalCounts: {},
    ownerMembership: null,
  };
}

function postSnapshot() {
  return {
    ...preSnapshot(),
    ledger: expectedPostLedger().map((entry) => ({ ...entry })),
    targetMarkers: { expected: 10, present: 10 },
    operationalCounts: {
      jobs: 0,
      reported_concerns: 0,
      canonical_quotes: 0,
      canonical_invoices: 0,
      business_job_assignments: 0,
      business_time_sessions: 0,
      business_job_customer_messages: 0,
    },
    ownerMembership: {
      businesses: 6,
      owners: 6,
      duplicateOwners: 0,
      nonOwners: 0,
      unrelatedOwners: 0,
    },
  };
}

function mockClient() {
  const queries = [];
  return {
    queries,
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      return { rows: [] };
    },
  };
}

test("004 manifest freezes exactly 49 ordered full-filename/checksum identities", () => {
  assert.equal(validateManifest(), true);
  assert.equal(manifest.TARGET_MIGRATIONS.length, 49);
  assert.equal(manifest.CURRENT_PRODUCTION_LEDGER.length, 26);
  assert.equal(expectedPostLedger().length, 75);
  assert.equal(new Set(manifest.TARGET_MIGRATIONS.map(({ filename }) => filename)).size, 49);
});

test("production project, environment, database, and backend identities are exact", () => {
  assert.deepEqual(manifest.EXPECTED_PRODUCTION_TARGET, {
    projectId: "10d1facd-6aa6-4052-9897-803396f813c4",
    projectName: "profound-magic",
    environmentId: "3554dcb8-3f0a-4b8f-bbdf-162777ad87fa",
    environmentName: "production",
    databaseServiceId: "80a103f2-56b3-4b62-a261-51a19169de5b",
    databaseServiceName: "Postgres",
    backendServiceId: "831a310f-2cee-4c3c-8f36-52e78bbdb5bf",
    backendServiceName: "athletic-rebirth",
    databaseName: "railway",
  });
});

test("the manifest distinguishes the duplicate timestamp by full filename and checksum", () => {
  const lifecycle = manifest.TARGET_MIGRATIONS[0];
  const archive = manifest.ARCHIVE_MIGRATION;
  assert.equal(lifecycle.filename.slice(0, 12), archive.filename.slice(0, 12));
  assert.notEqual(lifecycle.filename, archive.filename);
  assert.notEqual(lifecycle.checksum, archive.checksum);
});

test("all 49 files match the frozen checksums and are transaction-compatible", () => {
  const migrations = loadTargetMigrations();
  assert.equal(migrations.length, 49);
  assert.ok(migrations.every(({ sql }) => !/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql)));
});

test("static seed and DML classifications are explicit and bounded", () => {
  const counts = Object.create(null);
  for (const migration of manifest.TARGET_MIGRATIONS) {
    counts[migration.dmlClass] = (counts[migration.dmlClass] || 0) + 1;
  }
  assert.deepEqual({ ...counts }, {
    NONE: 35,
    STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED: 10,
    LEGACY_STRUCTURAL_BACKFILL: 3,
    BUSINESS_AUTHORITY_CREATION: 1,
  });
});

test("no mode, multiple modes, and unknown arguments fail before database access", async () => {
  assert.equal(parseMode([]), null);
  assert.equal(parseMode(["--describe", "--execute"]), null);
  assert.equal(parseMode(["--execute", "extra"]), null);
  const output = [];
  assert.equal(await run({ argv: [], env: {}, output: (line) => output.push(line) }), 2);
  assert.match(output[0], /"status":"BLOCKED"/);
});

test("describe is non-mutating and requires no production credentials", async () => {
  const output = [];
  assert.equal(await run({ argv: ["--describe"], env: {}, output: (line) => output.push(line) }), 0);
  assert.match(output[0], /"targetMigrationCount":49/);
  assert.doesNotMatch(output[0], /DATABASE_URL|password|token/i);
});

test("every independent execution authorization proof fails closed when missing", () => {
  const required = [
    "NODE_ENV", "RAILWAY_PROJECT_ID", "RAILWAY_PROJECT_NAME",
    "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_SERVICE_ID",
    "RAILWAY_SERVICE_NAME", "EXPECTED_PRESTATE_SERVER_SHA",
    "EXPECTED_PRESTATE_IMAGE_DIGEST", "EXPECTED_PRODUCTION_DEPLOYMENT_ID",
    "CONFIRM_PRODUCTION_TARGET", "PRODUCTION_CONVERGENCE_ID",
    "CERTIFIED_BACKUP_REFERENCE", "CERTIFIED_BACKUP_SHA256",
    "RESTORE_CERTIFICATION_REFERENCE", "MAINTENANCE_TRAFFIC_PAUSE_PROOF",
    "CONFIRM_PRODUCTION_CONVERGENCE",
  ];
  assert.equal(inspectAuthorization(validEnvironment(), { execute: true }).authorized, true);
  for (const key of required) {
    const env = validEnvironment();
    delete env[key];
    assert.equal(inspectAuthorization(env, { execute: true }).authorized, false, key);
  }
});

test("wrong server SHA and image digest are independent authorization failures", () => {
  for (const [key, value] of [
    ["EXPECTED_PRESTATE_SERVER_SHA", "f".repeat(40)],
    ["EXPECTED_PRESTATE_IMAGE_DIGEST", `sha256:${"f".repeat(64)}`],
  ]) {
    const env = validEnvironment();
    env[key] = value;
    assert.equal(inspectAuthorization(env, { execute: true }).authorized, false);
  }
});

test("READY, ALREADY_APPLIED, and BLOCKED are the only replay states", () => {
  assert.equal(classifySnapshot(preSnapshot()), "READY");
  assert.equal(classifySnapshot(postSnapshot()), "ALREADY_APPLIED");
  const partialLedger = preSnapshot();
  partialLedger.ledger.push(expectedPostLedger().at(-1));
  assert.equal(classifySnapshot(partialLedger), "BLOCKED");
  const partialSchema = preSnapshot();
  partialSchema.targetMarkers.present = 1;
  assert.equal(classifySnapshot(partialSchema), "BLOCKED");
});

test("preflight rejects PostgreSQL, ledger, archive, catalog, and business drift", () => {
  const cases = [
    (s) => { s.postgresVersion = "17.9"; },
    (s) => { s.ledger.pop(); },
    (s) => { s.ledger[0].checksum = "f".repeat(64); },
    (s) => { s.ledger = s.ledger.filter(({ filename }) => filename !== manifest.ARCHIVE_MIGRATION.filename); },
    (s) => { s.preservation.legacy_orphan_message_archive.count -= 1; },
    (s) => { s.preservation.legacy_orphan_message_archive.identitySha256 = "f".repeat(64); },
    (s) => { s.catalog.tables.count += 1; },
    (s) => { delete s.preservation.workflow_events; },
    (s) => { s.preservation.posts.count -= 1; },
    (s) => { s.preservation.messages.identitySha256 = "f".repeat(64); },
  ];
  assert.equal(assertPreflightSnapshot(preSnapshot()), "READY");
  for (const mutate of cases) {
    const snapshot = preSnapshot();
    mutate(snapshot);
    assert.throws(() => assertPreflightSnapshot(snapshot), { code: "PREFLIGHT_BLOCKED" });
  }
});

test("missing and checksum-drifted target files block before database access", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "meetro-convergence-004-"));
  try {
    mkdirSync(directory, { recursive: true });
    for (const { filename } of manifest.TARGET_MIGRATIONS) {
      copyFileSync(
        join(__dirname, "..", "migrations", filename),
        join(directory, filename)
      );
    }

    const missing = manifest.TARGET_MIGRATIONS.at(-1).filename;
    rmSync(join(directory, missing));
    assert.throws(
      () => loadTargetMigrations({ migrationsDirectory: directory }),
      { code: "TARGET_MIGRATION_MISSING" }
    );

    copyFileSync(
      join(__dirname, "..", "migrations", missing),
      join(directory, missing)
    );
    const drifted = manifest.TARGET_MIGRATIONS[0].filename;
    writeFileSync(join(directory, drifted), "-- checksum drift\n");
    assert.throws(
      () => loadTargetMigrations({ migrationsDirectory: directory }),
      { code: "TARGET_MIGRATION_CHECKSUM_DRIFT" }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("postflight enforces ledger, archive, legacy data, zero authority, and exact Owner seats", () => {
  assert.equal(assertPostflightSnapshot(postSnapshot()), "ALREADY_APPLIED");
  const cases = [
    (s) => { s.ledger.pop(); },
    (s) => { s.archiveLedger.checksum = "f".repeat(64); },
    (s) => { s.preservation.contractor_projects.legacyRowSha256 = "f".repeat(64); },
    (s) => { s.operationalCounts.jobs = 1; },
    (s) => { s.ownerMembership.duplicateOwners = 1; },
    (s) => { s.ownerMembership.nonOwners = 1; },
    (s) => { s.ownerMembership.unrelatedOwners = 1; },
  ];
  for (const mutate of cases) {
    const snapshot = postSnapshot();
    mutate(snapshot);
    assert.throws(() => assertPostflightSnapshot(snapshot), { code: "POSTFLIGHT_BLOCKED" });
  }
});

test("manifest additions, duplicate filenames, bad order, and baseline/archive targets are rejected", () => {
  const original = manifest.TARGET_MIGRATIONS.map((entry) => ({ ...entry }));
  for (const mutate of [
    (x) => x.push({ ...x.at(-1), order: 50, filename: "202609010001_unapproved.sql" }),
    (x) => { x[1] = { ...x[0], order: 2 }; },
    (x) => { [x[0], x[1]] = [x[1], x[0]]; x[0].order = 1; x[1].order = 2; },
    (x) => { x[0].filename = manifest.BASELINE_FILENAME; },
    (x) => { x[0].filename = manifest.ARCHIVE_MIGRATION.filename; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateManifest(changed), { code: "MANIFEST_INVALID" });
  }
});

test("beginning, middle, near-end, and postcondition failures issue ROLLBACK and never COMMIT", async () => {
  const migrations = loadTargetMigrations();
  for (const failure of [1, 25, 49]) {
    const client = mockClient();
    const snapshots = [preSnapshot(), preSnapshot()];
    await assert.rejects(
      executeConvergence({
        client,
        migrations,
        injectFailureAt: failure,
        readSnapshotFn: async () => snapshots.shift(),
      }),
      { code: "INJECTED_MIGRATION_FAILURE" }
    );
    assert.ok(client.queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.ok(!client.queries.some(({ sql }) => sql === "COMMIT"));
  }
  const client = mockClient();
  const snapshots = [preSnapshot(), preSnapshot(), postSnapshot()];
  await assert.rejects(
    executeConvergence({
      client,
      migrations,
      injectPostconditionFailure: true,
      readSnapshotFn: async () => snapshots.shift(),
    }),
    { code: "POSTFLIGHT_BLOCKED" }
  );
  assert.ok(client.queries.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!client.queries.some(({ sql }) => sql === "COMMIT"));
});

test("complete success applies 49 in order and replay performs zero mutation", async () => {
  const migrations = loadTargetMigrations();
  const client = mockClient();
  const snapshots = [preSnapshot(), preSnapshot(), postSnapshot()];
  const result = await executeConvergence({
    client,
    migrations,
    readSnapshotFn: async () => snapshots.shift(),
  });
  assert.deepEqual(result, { state: "ALREADY_APPLIED", applied: 49 });
  assert.ok(client.queries.some(({ sql }) => sql === "COMMIT"));
  assert.equal(
    client.queries.filter(({ sql }) => sql.includes("INSERT INTO schema_migrations")).length,
    49
  );

  const replayClient = mockClient();
  const replay = await executeConvergence({
    client: replayClient,
    migrations,
    readSnapshotFn: async () => postSnapshot(),
  });
  assert.deepEqual(replay, { state: "ALREADY_APPLIED", applied: 0 });
  assert.ok(!replayClient.queries.some(({ sql }) => sql === "BEGIN"));
});

test("runner source contains no credentials, database URLs, dumps, or archived content", () => {
  const source = readFileSync(
    join(__dirname, "..", "scripts", "run-production-convergence-004.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i);
  assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(source, /message_text\s*[:=]\s*["'][^"']+/i);
  assert.doesNotMatch(source, /\.dump\b|dotenv\.config|readFileSync\([^)]*\.env/i);
});

test("target marker extraction is deterministic and nonempty", () => {
  const markers = extractTargetMarkers(loadTargetMigrations());
  assert.ok(markers.relations.length > 40);
  assert.ok(markers.columns.length > 10);
  assert.equal(markers.count, markers.relations.length + markers.columns.length);
});
