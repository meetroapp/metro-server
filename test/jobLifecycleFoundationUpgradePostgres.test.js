"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.JOB_LIFECYCLE_UPGRADE_DATABASE_URL;
const migrationNames = new Set([
  "202608090001_create_job_lifecycle_concern_foundation.sql",
  "202608090002_create_job_participant_authority_foundation.sql",
]);

test(
  "disposable PostgreSQL upgrades representative 26-migration schema without fabricating history",
  { skip: !databaseUrl },
  async () => {
    const target = assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    });
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const client = await pool.connect();
    const allMigrations = getMigrationFiles();
    const priorMigrations = allMigrations.filter(
      (migration) =>
        migration.filename <
        "202608090001_create_job_lifecycle_concern_foundation.sql"
    );
    const sliceMigrations = allMigrations.filter(
      (migration) => migrationNames.has(migration.filename)
    );
    const targetMetadata = {
      target: "local-test",
      database: target,
    };

    try {
      assert.equal(priorMigrations.length, 26);
      assert.equal(sliceMigrations.length, 2);
      const prior = await runMigrationCollection(
        client,
        priorMigrations,
        targetMetadata
      );
      assert.equal(prior.success, true);
      assert.equal(prior.applied.length, 26);

      const user = await client.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ('Legacy Owner', $1, 'test-only-hash', 'homeowner', 'homeowner')
        RETURNING id
        `,
        [`legacy-upgrade-${randomUUID()}@example.test`]
      );
      const legacyPost = await client.query(
        `
        INSERT INTO posts
        (user_id, title, description, category, location, status, unit_number, access_notes)
        VALUES ($1, 'Existing request', 'Existing description', 'handyman',
          'Existing area', 'open', '', '')
        RETURNING id
        `,
        [user.rows[0].id]
      );

      const startedAt = process.hrtime.bigint();
      const slice = await runMigrationCollection(
        client,
        sliceMigrations,
        targetMetadata
      );
      const elapsedMilliseconds = Number(
        (process.hrtime.bigint() - startedAt) / 1_000_000n
      );
      assert.equal(slice.success, true);
      assert.deepEqual(slice.applied, [...migrationNames]);

      const preserved = await client.query(
        `
        SELECT id, title, description, lifecycle_contract_version
        FROM posts
        WHERE id = $1
        `,
        [legacyPost.rows[0].id]
      );
      assert.equal(preserved.rows[0].title, "Existing request");
      assert.equal(preserved.rows[0].description, "Existing description");
      assert.equal(Number(preserved.rows[0].lifecycle_contract_version), 1);

      const fabricated = await client.query(
        `
        SELECT
          (SELECT count(*) FROM jobs)::integer AS jobs,
          (SELECT count(*) FROM reported_concerns)::integer AS concerns,
          (SELECT count(*) FROM relationship_participants)::integer AS participants
        `
      );
      assert.deepEqual(fabricated.rows[0], {
        jobs: 0,
        concerns: 0,
        participants: 0,
      });

      const schema = await client.query(
        `
        SELECT
          to_regclass('public.jobs') IS NOT NULL AS jobs,
          to_regclass('public.reported_concerns') IS NOT NULL AS concerns,
          to_regclass('public.concern_clarifications') IS NOT NULL AS clarifications,
          to_regclass('public.relationship_participants') IS NOT NULL AS participants,
          to_regclass('public.lifecycle_authority_grants') IS NOT NULL AS grants
        `
      );
      assert.deepEqual(schema.rows[0], {
        jobs: true,
        concerns: true,
        clarifications: true,
        participants: true,
        grants: true,
      });

      const replay = await runMigrationCollection(
        client,
        sliceMigrations,
        targetMetadata
      );
      assert.equal(replay.success, true);
      assert.equal(replay.skipped.length, 2);

      assert.ok(elapsedMilliseconds < 10_000);
    } finally {
      client.release();
      await pool.end();
    }
  }
);
