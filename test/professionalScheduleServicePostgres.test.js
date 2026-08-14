"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getProfessionalSchedule } = require("../server/workflow/professionalScheduleService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.PROFESSIONAL_SCHEDULE_DATABASE_URL;

test(
  "disposable PostgreSQL validates the professional Schedule queries against governed schema",
  { skip: !databaseUrl },
  async () => {
    const target = assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      const migrated = await runMigrationCollection(pool, getMigrationFiles(), {
        target: "local-test",
        database: target,
      });
      assert.equal(migrated.success, true);

      const active = await getProfessionalSchedule({
        pool,
        authenticatedActor: { id: 999999 },
        view: "active",
        limit: 25,
      });
      assert.equal(active.code, "PROFESSIONAL_SCHEDULE_LOADED");
      assert.deepEqual(active.schedule.opportunities, []);
      assert.deepEqual(active.schedule.visits, []);
      assert.deepEqual(active.schedule.summary, {
        readyToSchedule: 0,
        waitingOnCustomer: 0,
        changeRequested: 0,
        upcoming: 0,
      });

      const history = await getProfessionalSchedule({
        pool,
        authenticatedActor: { id: 999999 },
        view: "history",
        limit: 25,
      });
      assert.equal(history.code, "PROFESSIONAL_SCHEDULE_LOADED");
      assert.deepEqual(history.schedule.visits, []);
    } finally {
      await pool.end();
    }
  }
);
