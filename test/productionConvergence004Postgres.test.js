"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { resetSyntheticProduction } = require("./helpers/productionConvergence004Fixture");
const manifest = require("../production-convergence/004/manifest");
const {
  classifySnapshot,
  compareLedger,
  expectedPostLedger,
  extractTargetMarkers,
  loadTargetMigrations,
} = require("../production-convergence/004/assertions");
const { readSnapshot } = require("../production-convergence/004/snapshot");
const { executeConvergence } = require("../scripts/run-production-convergence-004");

const databaseUrl = process.env.CONVERGENCE_004_DATABASE_URL;

function syntheticExpected(snapshot) {
  return {
    postgresVersion: snapshot.postgresVersion,
    catalog: structuredClone(snapshot.catalog),
    preservation: structuredClone(snapshot.preservation),
  };
}

test("the exact 49-migration chain preserves production-shaped synthetic legacy data", async (context) => {
  if (!databaseUrl) return context.skip("CONVERGENCE_004_DATABASE_URL is required");
  assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: "test" });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await resetSyntheticProduction(client);
    const migrations = loadTargetMigrations();
    const markers = extractTargetMarkers(migrations);
    const before = await readSnapshot(client, markers, { postconditions: true });
    const expected = syntheticExpected(before);

    assert.equal(classifySnapshot(before), "READY");
    assert.equal(before.preservation.posts.count, 43);
    assert.equal(before.preservation.messages.count, 12);
    assert.equal(before.preservation.contractor_projects.count, 4);
    assert.equal(before.preservation.contractor_profiles.count, 6);
    assert.equal(before.preservation.legacy_orphan_message_archive.count, 4);

    const result = await executeConvergence({ client, migrations, expectedPrestate: expected });
    assert.deepEqual(result, { state: "ALREADY_APPLIED", applied: 49 });

    const after = await readSnapshot(client, markers, { postconditions: true });
    assert.equal(classifySnapshot(after), "ALREADY_APPLIED");
    assert.equal(compareLedger(after.ledger, expectedPostLedger()).exact, true);
    assert.equal(after.ledger.length, 75);
    assert.deepEqual(after.preservation, before.preservation);
    assert.deepEqual(after.ownerMembership, {
      businesses: 6,
      owners: 6,
      nonOwners: 0,
      unrelatedOwners: 0,
      duplicateOwners: 0,
    });
    assert.ok(Object.values(after.operationalCounts).every((count) => count === 0));
    assert.ok(after.ledger.some(({ filename }) => filename === manifest.ARCHIVE_MIGRATION.filename));
    assert.ok(after.ledger.some(({ filename }) => filename === manifest.TARGET_MIGRATIONS[0].filename));

    const replay = await executeConvergence({ client, migrations, expectedPrestate: expected });
    assert.deepEqual(replay, { state: "ALREADY_APPLIED", applied: 0 });

    await assert.rejects(
      client.query("UPDATE legacy_orphan_message_archive SET source_table = source_table WHERE message_id = 1001"),
      /immutable/i
    );
    await assert.rejects(
      client.query("UPDATE posts SET lifecycle_contract_version = 3 WHERE id = 1"),
      /posts_lifecycle_contract_version_check/i
    );
    await assert.rejects(
      client.query(`
        INSERT INTO business_team_memberships
          (contractor_profile_id, user_id, role, status, created_by_user_id)
        VALUES (1, 8, 'UNBOUNDED_ROLE', 'ACTIVE', 1)`),
      /business_team_memberships_role_check/i
    );
  } finally {
    client.release();
    await pool.end();
  }
});

test("a middle-chain failure restores old schema, ledger, constraints, and legacy rows", async (context) => {
  if (!databaseUrl) return context.skip("CONVERGENCE_004_DATABASE_URL is required");
  assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: "test" });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await resetSyntheticProduction(client);
    const migrations = loadTargetMigrations();
    const markers = extractTargetMarkers(migrations);
    const before = await readSnapshot(client, markers, { postconditions: true });
    const expected = syntheticExpected(before);

    await assert.rejects(
      executeConvergence({
        client,
        migrations,
        expectedPrestate: expected,
        injectFailureAt: 25,
      }),
      { code: "INJECTED_MIGRATION_FAILURE" }
    );

    const after = await readSnapshot(client, markers, { postconditions: true });
    assert.equal(classifySnapshot(after), "READY");
    assert.equal(compareLedger(after.ledger, manifest.CURRENT_PRODUCTION_LEDGER).exact, true);
    assert.equal(after.targetMarkers.present, 0);
    assert.deepEqual(after.preservation, before.preservation);
    assert.equal(await client.query("SELECT to_regclass('public.canonical_quotes') IS NULL AS absent").then((r) => r.rows[0].absent), true);
  } finally {
    client.release();
    await pool.end();
  }
});

test("legacy data incompatible with a later delivery constraint rolls back the entire chain", async (context) => {
  if (!databaseUrl) return context.skip("CONVERGENCE_004_DATABASE_URL is required");
  assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: "test" });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await resetSyntheticProduction(client);
    await client.query("UPDATE messages SET message_type = 'quote_shared' WHERE id = 1");
    const migrations = loadTargetMigrations();
    const markers = extractTargetMarkers(migrations);
    const before = await readSnapshot(client, markers, { postconditions: true });
    const expected = syntheticExpected(before);

    await assert.rejects(
      executeConvergence({ client, migrations, expectedPrestate: expected }),
      /messages_quote_delivery_shape_check/
    );

    const after = await readSnapshot(client, markers, { postconditions: true });
    assert.equal(classifySnapshot(after), "READY");
    assert.equal(compareLedger(after.ledger, manifest.CURRENT_PRODUCTION_LEDGER).exact, true);
    assert.equal(after.targetMarkers.present, 0);
    assert.deepEqual(after.preservation, before.preservation);
    assert.equal(
      await client.query("SELECT message_type FROM messages WHERE id = 1").then((r) => r.rows[0].message_type),
      "quote_shared"
    );
  } finally {
    client.release();
    await pool.end();
  }
});

test("partial target schema and Owner-backfill collision states block before mutation", async (context) => {
  if (!databaseUrl) return context.skip("CONVERGENCE_004_DATABASE_URL is required");
  assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: "test" });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await resetSyntheticProduction(client);
    await client.query(`
      CREATE TABLE business_team_memberships (
        id UUID PRIMARY KEY,
        contractor_profile_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by_user_id INTEGER NOT NULL
      );
      INSERT INTO business_team_memberships
        (id, contractor_profile_id, user_id, role, status, created_by_user_id)
      VALUES
        ('00000000-0000-4000-8000-000000000001', 1, 8, 'OWNER', 'ACTIVE', 1)
    `);
    const beforeLedger = await client.query("SELECT count(*)::int AS count FROM schema_migrations");
    await assert.rejects(
      executeConvergence({ client, migrations: loadTargetMigrations() }),
      { code: "REPLAY_STATE_BLOCKED" }
    );
    const afterLedger = await client.query("SELECT count(*)::int AS count FROM schema_migrations");
    assert.deepEqual(afterLedger.rows[0], beforeLedger.rows[0]);
    assert.equal(
      await client.query("SELECT to_regclass('public.jobs') IS NULL AS absent").then((r) => r.rows[0].absent),
      true
    );
  } finally {
    client.release();
    await pool.end();
  }
});
