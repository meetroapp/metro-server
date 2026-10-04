"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { resetSyntheticProduction } = require("./helpers/productionConvergence004Fixture");
const manifest = require("../production-convergence/004-r1/manifest");
const {
  classifySnapshot,
  compareLedger,
  expectedPostLedger,
  extractTargetMarkers,
  loadTargetMigrations,
} = require("../production-convergence/004-r1/assertions");
const { readSnapshot } = require("../production-convergence/004-r1/snapshot");
const { executeConvergence } = require("../scripts/run-production-convergence-004-r1");

const databaseUrl = process.env.CONVERGENCE_004_R1_DATABASE_URL;

function syntheticExpected(snapshot) {
  return {
    postgresVersion: snapshot.postgresVersion,
    catalog: structuredClone(snapshot.catalog),
    preservation: structuredClone(snapshot.preservation),
    ownerBackfillEligibility: structuredClone(snapshot.ownerBackfillEligibility),
  };
}

async function resetFourPrincipalTwoOrphanProduction(client) {
  await resetSyntheticProduction(client);
  await client.query(`
    SET session_replication_role = replica;
    DELETE FROM users WHERE id IN (5, 6);
    SET session_replication_role = origin;
  `);
}

test("the Path-B chain preserves six profiles while granting Owner only to four principals", async (context) => {
  if (!databaseUrl) return context.skip("CONVERGENCE_004_R1_DATABASE_URL is required");
  assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: "test" });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await resetFourPrincipalTwoOrphanProduction(client);
    const migrations = loadTargetMigrations();
    const markers = extractTargetMarkers(migrations);
    const before = await readSnapshot(client, markers, { postconditions: true });
    const expected = syntheticExpected(before);

    assert.equal(classifySnapshot(before), "READY");
    assert.deepEqual(
      {
        profileCount: before.ownerBackfillEligibility.profileCount,
        eligibleProfileCount: before.ownerBackfillEligibility.eligibleProfileCount,
        ineligibleProfileCount: before.ownerBackfillEligibility.ineligibleProfileCount,
      },
      { profileCount: 6, eligibleProfileCount: 4, ineligibleProfileCount: 2 }
    );
    assert.equal(before.preservation.contractor_profiles.count, 6);
    assert.equal(before.preservation.contractor_projects.count, 4);
    assert.equal(before.preservation.posts.count, 43);
    assert.equal(before.preservation.messages.count, 12);
    assert.equal(before.preservation.legacy_orphan_message_archive.count, 4);

    const result = await executeConvergence({ client, migrations, expectedPrestate: expected });
    assert.deepEqual(result, { state: "ALREADY_APPLIED", applied: 49 });

    const after = await readSnapshot(client, markers, { postconditions: true });
    assert.equal(classifySnapshot(after), "ALREADY_APPLIED");
    assert.equal(compareLedger(after.ledger, expectedPostLedger()).exact, true);
    assert.equal(after.ledger.length, 75);
    assert.deepEqual(after.preservation, before.preservation);
    assert.deepEqual(after.ownerBackfillEligibility, before.ownerBackfillEligibility);
    assert.deepEqual(after.ownerMembership, manifest.EXPECTED_POST_OWNER_MEMBERSHIP);
    assert.ok(Object.values(after.operationalCounts).every((count) => count === 0));

    const teamRows = await client.query(`
      SELECT profiles.id AS profile_id,
             profiles.user_id,
             (users.id IS NOT NULL) AS user_present,
             count(memberships.id)::int AS membership_count,
             count(memberships.id) FILTER (
               WHERE memberships.role = 'OWNER' AND memberships.status = 'ACTIVE'
             )::int AS owner_count
        FROM contractor_profiles profiles
        LEFT JOIN users ON users.id = profiles.user_id
        LEFT JOIN business_team_memberships memberships
          ON memberships.contractor_profile_id = profiles.id
       GROUP BY profiles.id, profiles.user_id, users.id
       ORDER BY profiles.id
    `);
    assert.deepEqual(
      teamRows.rows.map((row) => ({
        profileId: Number(row.profile_id),
        userPresent: row.user_present,
        membershipCount: Number(row.membership_count),
        ownerCount: Number(row.owner_count),
      })),
      [
        { profileId: 1, userPresent: true, membershipCount: 1, ownerCount: 1 },
        { profileId: 2, userPresent: true, membershipCount: 1, ownerCount: 1 },
        { profileId: 3, userPresent: true, membershipCount: 1, ownerCount: 1 },
        { profileId: 4, userPresent: true, membershipCount: 1, ownerCount: 1 },
        { profileId: 5, userPresent: false, membershipCount: 0, ownerCount: 0 },
        { profileId: 6, userPresent: false, membershipCount: 0, ownerCount: 0 },
      ]
    );

    const replay = await executeConvergence({ client, migrations, expectedPrestate: expected });
    assert.deepEqual(replay, { state: "ALREADY_APPLIED", applied: 0 });

    await assert.rejects(
      client.query("UPDATE legacy_orphan_message_archive SET source_table = source_table WHERE message_id = 1001"),
      /immutable/i
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

test("a third orphan blocks before BEGIN and leaves the 26-row production ledger untouched", async (context) => {
  if (!databaseUrl) return context.skip("CONVERGENCE_004_R1_DATABASE_URL is required");
  assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: "test" });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await resetFourPrincipalTwoOrphanProduction(client);
    const migrations = loadTargetMigrations();
    const markers = extractTargetMarkers(migrations);
    const approved = syntheticExpected(await readSnapshot(client, markers, { postconditions: true }));
    await client.query(`
      SET session_replication_role = replica;
      DELETE FROM users WHERE id = 4;
      SET session_replication_role = origin;
    `);

    await assert.rejects(
      executeConvergence({ client, migrations, expectedPrestate: approved }),
      { code: "OWNER_BACKFILL_ELIGIBILITY_BLOCKED" }
    );

    const after = await readSnapshot(client, markers, { postconditions: true });
    assert.equal(after.ledger.length, 26);
    assert.equal(after.targetMarkers.present, 0);
    assert.equal(after.ownerBackfillEligibility.ineligibleProfileCount, 3);
    assert.equal(
      await client.query("SELECT to_regclass('public.business_team_memberships') IS NULL AS absent")
        .then((result) => result.rows[0].absent),
      true
    );
  } finally {
    client.release();
    await pool.end();
  }
});
