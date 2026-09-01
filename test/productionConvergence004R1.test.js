"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const baseManifest = require("../production-convergence/004/manifest");
const manifest = require("../production-convergence/004-r1/manifest");
const {
  assertOwnerBackfillEligibility,
  assertPostflightSnapshot,
  assertPreflightSnapshot,
  classifySnapshot,
  expectedPostLedger,
  inspectAuthorization,
  loadTargetMigrations,
  validateManifest,
} = require("../production-convergence/004-r1/assertions");
const {
  ownerEligibilityFingerprint,
} = require("../production-convergence/004-r1/fingerprints");
const {
  executeConvergence,
  parseMode,
  run,
} = require("../scripts/run-production-convergence-004-r1");

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
    CERTIFIED_BACKUP_REFERENCE: "certified-backup-reference",
    CERTIFIED_BACKUP_SHA256: "a".repeat(64),
    RESTORE_CERTIFICATION_REFERENCE: "restore-certification-reference",
    MAINTENANCE_BRIDGE_PROOF_PATH: "/tmp/meetro-maintenance-proof.json",
    MAINTENANCE_BRIDGE_PROOF_SHA256: "b".repeat(64),
    EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111",
    CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    CONFIRM_PRODUCTION_CONVERGENCE: "EXECUTE_MC_PRODUCTION_CONVERGENCE_004_R1",
  };
}

function preSnapshot() {
  return {
    postgresVersion: "18.6 (synthetic)",
    ledger: manifest.CURRENT_PRODUCTION_LEDGER.map((entry) => ({ ...entry })),
    archiveLedger: { ...manifest.ARCHIVE_MIGRATION },
    catalog: structuredClone(manifest.PRODUCTION_PRESTATE.catalog),
    preservation: structuredClone(manifest.PRODUCTION_PRESTATE.preservation),
    ownerBackfillEligibility: structuredClone(manifest.OWNER_BACKFILL_ELIGIBILITY),
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
    ownerMembership: structuredClone(manifest.EXPECTED_POST_OWNER_MEMBERSHIP),
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

test("004-r1 manifest freezes 49 positions with the truthful Team variant at 43", () => {
  assert.equal(validateManifest(), true);
  assert.equal(manifest.TARGET_MIGRATIONS.length, 49);
  assert.equal(expectedPostLedger().length, 75);
  assert.equal(manifest.TARGET_MIGRATIONS[42].filename, manifest.VARIANT_FILENAME);
  assert.equal(manifest.TARGET_MIGRATIONS[42].checksum, manifest.VARIANT_CHECKSUM);
  assert.equal(manifest.TARGET_MIGRATIONS.some(({ filename }) => filename === manifest.CANONICAL_TEAM_FILENAME), false);
  assert.equal(expectedPostLedger().some(({ filename }) => filename === manifest.VARIANT_FILENAME), true);
  assert.equal(expectedPostLedger().some(({ filename }) => filename === manifest.CANONICAL_TEAM_FILENAME), false);
});

test("variant DDL is exact canonical migration-43 DDL with only the governed principal join", () => {
  const original = readFileSync(join(__dirname, "..", "migrations", manifest.CANONICAL_TEAM_FILENAME), "utf8");
  const variant = readFileSync(join(__dirname, "..", "production-convergence", "004-r1", "sql", manifest.VARIANT_FILENAME), "utf8");
  assert.equal(
    variant,
    original.replace(
      "FROM contractor_profiles profiles\nON CONFLICT",
      "FROM contractor_profiles profiles\nJOIN users ON users.id = profiles.user_id\nON CONFLICT"
    )
  );
  assert.match(variant, /JOIN users ON users\.id = profiles\.user_id/);
});

test("approved four-eligible two-orphan fingerprint is deterministic and READY", () => {
  const rows = [
    { contractorProfileId: 6, userId: 65, userPresent: true },
    { contractorProfileId: 1, userId: 8, userPresent: false },
    { contractorProfileId: 4, userId: 61, userPresent: true },
    { contractorProfileId: 3, userId: 41, userPresent: false },
    { contractorProfileId: 2, userId: 40, userPresent: true },
    { contractorProfileId: 5, userId: 63, userPresent: true },
  ];
  assert.equal(ownerEligibilityFingerprint(rows), manifest.OWNER_BACKFILL_ELIGIBILITY.eligibilityFingerprint);
  assert.equal(assertPreflightSnapshot(preSnapshot()), "READY");
});

test("six eligible profiles can be represented only by an explicit matching eligibility contract", () => {
  const snapshot = preSnapshot();
  snapshot.ownerBackfillEligibility = {
    profileCount: 6,
    eligibleProfileCount: 6,
    ineligibleProfileCount: 0,
    eligibilityFingerprint: "b".repeat(64),
  };
  assert.equal(assertOwnerBackfillEligibility(snapshot, snapshot.ownerBackfillEligibility), true);
  assert.throws(() => assertPreflightSnapshot(snapshot), { code: "OWNER_BACKFILL_ELIGIBILITY_BLOCKED" });
});

test("third orphan, missing eligible user, count drift, identity drift, and fingerprint drift block", () => {
  const mutations = [
    (s) => { s.ownerBackfillEligibility.eligibleProfileCount = 3; s.ownerBackfillEligibility.ineligibleProfileCount = 3; },
    (s) => { s.ownerBackfillEligibility.eligibleProfileCount = 3; },
    (s) => { s.ownerBackfillEligibility.profileCount = 7; },
    (s) => { s.ownerBackfillEligibility.eligibilityFingerprint = "c".repeat(64); },
    (s) => { s.ownerBackfillEligibility.ineligibleProfileCount = 1; },
  ];
  for (const mutate of mutations) {
    const snapshot = preSnapshot();
    mutate(snapshot);
    assert.throws(() => assertPreflightSnapshot(snapshot), { code: "OWNER_BACKFILL_ELIGIBILITY_BLOCKED" });
  }
});

test("original migration 43, wrong variant, extra target, and wrong order block", () => {
  const cases = [
    baseManifest.TARGET_MIGRATIONS.map((entry) => ({ ...entry })),
    manifest.TARGET_MIGRATIONS.map((entry) => entry.order === 43 ? { ...entry, filename: "202608300005_wrong_variant.sql" } : { ...entry }),
    [...manifest.TARGET_MIGRATIONS.map((entry) => ({ ...entry })), { ...manifest.TARGET_MIGRATIONS.at(-1), order: 50, filename: "202609010001_extra.sql" }],
    manifest.TARGET_MIGRATIONS.map((entry, index) => index === 0 ? { ...entry, order: 2 } : index === 1 ? { ...entry, order: 1 } : { ...entry }),
  ];
  for (const target of cases) {
    assert.throws(() => validateManifest(target), { code: "MANIFEST_INVALID" });
  }
});

test("missing and checksum-drifted variant SQL block before database access", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "meetro-004-r1-"));
  try {
    assert.throws(
      () => loadTargetMigrations({ variantDirectory: directory }),
      { code: "TARGET_MIGRATION_MISSING" }
    );
    writeFileSync(join(directory, manifest.VARIANT_FILENAME), "-- drift\n");
    assert.throws(
      () => loadTargetMigrations({ variantDirectory: directory }),
      { code: "TARGET_MIGRATION_CHECKSUM_DRIFT" }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all 49 assets load by exact manifest identity and remain transaction compatible", () => {
  const migrations = loadTargetMigrations();
  assert.equal(migrations.length, 49);
  assert.equal(migrations[42].filename, manifest.VARIANT_FILENAME);
  assert.ok(migrations.every(({ sql }) => !/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql)));
});

test("runner has no default execution and describe safely exposes the selected contract", async () => {
  assert.equal(parseMode([]), null);
  assert.equal(parseMode(["--describe", "--execute"]), null);
  const blocked = [];
  assert.equal(await run({ argv: [], env: {}, output: (line) => blocked.push(line) }), 2);
  assert.match(blocked[0], /"status":"BLOCKED"/);
  const output = [];
  assert.equal(await run({ argv: ["--describe"], env: {}, output: (line) => output.push(line) }), 0);
  assert.match(output[0], /"targetMigrationCount":49/);
  assert.match(output[0], /ownerBackfillEligibility/);
  assert.match(output[0], new RegExp(manifest.VARIANT_FILENAME));
  assert.doesNotMatch(output[0], /DATABASE_URL|password|token/i);
});

test("execution authorization independently requires every production proof", () => {
  const required = [
    "NODE_ENV", "RAILWAY_PROJECT_ID", "RAILWAY_PROJECT_NAME",
    "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_SERVICE_ID",
    "RAILWAY_SERVICE_NAME", "EXPECTED_PRESTATE_SERVER_SHA",
    "EXPECTED_PRESTATE_IMAGE_DIGEST", "EXPECTED_PRODUCTION_DEPLOYMENT_ID",
    "CONFIRM_PRODUCTION_TARGET", "PRODUCTION_CONVERGENCE_ID",
    "CERTIFIED_BACKUP_REFERENCE", "CERTIFIED_BACKUP_SHA256",
    "RESTORE_CERTIFICATION_REFERENCE", "MAINTENANCE_BRIDGE_PROOF_PATH",
    "MAINTENANCE_BRIDGE_PROOF_SHA256", "EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST",
    "CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID", "CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST",
    "CONFIRM_PRODUCTION_CONVERGENCE",
  ];
  assert.equal(inspectAuthorization(validEnvironment(), { execute: true }).authorized, true);
  for (const key of required) {
    const env = validEnvironment();
    delete env[key];
    assert.equal(inspectAuthorization(env, { execute: true }).authorized, false, key);
  }
});

test("READY, truthful ALREADY_APPLIED, and partial BLOCKED states are exact", () => {
  assert.equal(classifySnapshot(preSnapshot()), "READY");
  assert.equal(classifySnapshot(postSnapshot()), "ALREADY_APPLIED");
  const partial = preSnapshot();
  partial.ledger.push(expectedPostLedger().at(-1));
  assert.equal(classifySnapshot(partial), "BLOCKED");
});

test("postflight enforces truthful ledger, preserved data, bounded Owners, and zero authority", () => {
  assert.equal(assertPostflightSnapshot(postSnapshot()), "ALREADY_APPLIED");
  const mutations = [
    (s) => { s.ledger.pop(); },
    (s) => { s.ownerMembership.owners = 5; },
    (s) => { s.ownerMembership.businessesWithoutMembership = 1; },
    (s) => { s.ownerMembership.nonOwners = 1; },
    (s) => { s.ownerMembership.unrelatedOwners = 1; },
    (s) => { s.operationalCounts.jobs = 1; },
    (s) => { s.preservation.messages.identitySha256 = "d".repeat(64); },
  ];
  for (const mutate of mutations) {
    const snapshot = postSnapshot();
    mutate(snapshot);
    assert.throws(() => assertPostflightSnapshot(snapshot), { code: "POSTFLIGHT_BLOCKED" });
  }
});

test("transaction failures roll back and complete success replays with zero mutation", async () => {
  const migrations = loadTargetMigrations();
  const failedClient = mockClient();
  await assert.rejects(
    executeConvergence({
      client: failedClient,
      migrations,
      injectFailureAt: 43,
      readSnapshotFn: async () => preSnapshot(),
    }),
    { code: "INJECTED_MIGRATION_FAILURE" }
  );
  assert.ok(failedClient.queries.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!failedClient.queries.some(({ sql }) => sql === "COMMIT"));

  const client = mockClient();
  const snapshots = [preSnapshot(), preSnapshot(), postSnapshot()];
  const result = await executeConvergence({
    client,
    migrations,
    readSnapshotFn: async () => snapshots.shift(),
  });
  assert.deepEqual(result, { state: "ALREADY_APPLIED", applied: 49 });
  assert.equal(client.queries.filter(({ sql }) => sql.includes("INSERT INTO schema_migrations")).length, 49);
  assert.equal(client.queries.find(({ sql, values }) =>
    sql.includes("INSERT INTO schema_migrations") && values?.[0] === manifest.VARIANT_FILENAME
  )?.values[2], manifest.EXECUTION_TARGET);

  const replayClient = mockClient();
  const replay = await executeConvergence({
    client: replayClient,
    migrations,
    readSnapshotFn: async () => postSnapshot(),
  });
  assert.deepEqual(replay, { state: "ALREADY_APPLIED", applied: 0 });
  assert.ok(!replayClient.queries.some(({ sql }) => sql === "BEGIN"));
});

test("004-r1 source contains no credentials, dumps, PII, or archived content", () => {
  const source = [
    "manifest.js", "fingerprints.js", "snapshot.js", "assertions.js",
  ].map((filename) => readFileSync(join(__dirname, "..", "production-convergence", "004-r1", filename), "utf8"))
    .concat(readFileSync(join(__dirname, "..", "scripts", "run-production-convergence-004-r1.js"), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i);
  assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(source, /\.dump\b|dotenv\.config|message_text\s*[:=]\s*["'][^"']+/i);
});
