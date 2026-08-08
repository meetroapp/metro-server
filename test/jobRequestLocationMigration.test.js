"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const migrationFilename =
  "202608070003_add_job_request_service_location.sql";
const migrationPath = join(__dirname, "..", "migrations", migrationFilename);
const migrationSql = readFileSync(migrationPath, "utf8");
const databaseUrl = process.env.JOB_REQUEST_LOCATION_DATABASE_URL;

test("service-location migration is additive, replay-safe, and legacy conservative", () => {
  for (const column of [
    "location_intake_mode",
    "location_normalization_status",
    "service_address_line1",
    "service_city",
    "service_region",
    "service_postal_code",
    "service_country_code",
    "discovery_area_label",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i")
    );
  }

  assert.match(
    migrationSql,
    /DEFAULT 'legacy_unclassified'/i
  );
  assert.match(
    migrationSql,
    /location_intake_mode IN \('exact_on_file', 'address_after_selection'\)/i
  );
  assert.match(
    migrationSql,
    /location_normalization_status IN \('normalized', 'legacy_unclassified'\)/i
  );
  assert.match(
    migrationSql,
    /location_intake_mode = 'address_after_selection'[\s\S]*service_address_line1 IS NULL[\s\S]*btrim\(unit_number\) = ''/i
  );
  assert.match(
    migrationSql,
    /discovery_area_label = service_city \|\| ', ' \|\| service_region/i
  );
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS idx_posts_open_normalized_service_locality/i
  );
  assert.doesNotMatch(
    migrationSql,
    /\b(?:DROP|DELETE|TRUNCATE|UPDATE\s+posts|INSERT\s+INTO\s+posts)\b/i
  );
  assert.doesNotMatch(migrationSql, /\b(?:latitude|longitude|geography|geometry)\b/i);
});

test("migration inventory records the structured location foundation", () => {
  const readme = readFileSync(join(__dirname, "..", "migrations", "README.md"), "utf8");
  assert.match(readme, new RegExp(migrationFilename.replaceAll(".", "\\.")));
  assert.match(readme, /legacy_unclassified/);
  assert.match(readme, /does not parse legacy addresses/i);
});

test(
  "PostgreSQL certifies legacy, exact, address-later, constraints, indexes, and replay",
  { skip: !databaseUrl },
  async () => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const email = `job-request-location-${randomUUID()}@example.test`;
    let userId;

    try {
      await pool.query(migrationSql);
      await pool.query(migrationSql);

      const user = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ($1, $2, $3, 'homeowner', 'homeowner')
        RETURNING id
        `,
        ["location-certification", email, "test-only-hash"]
      );
      userId = user.rows[0].id;

      const legacy = await pool.query(
        `
        INSERT INTO posts (user_id, title, location, unit_number, access_notes)
        VALUES ($1, 'Legacy request', 'Do not parse this free-form value', '', '')
        RETURNING *
        `,
        [userId]
      );
      assert.equal(legacy.rows[0].location, "Do not parse this free-form value");
      assert.equal(
        legacy.rows[0].location_normalization_status,
        "legacy_unclassified"
      );
      assert.equal(legacy.rows[0].location_intake_mode, null);
      assert.equal(legacy.rows[0].service_address_line1, null);
      assert.equal(legacy.rows[0].service_city, null);

      const exact = await pool.query(
        `
        INSERT INTO posts (
          user_id, title, location, unit_number, access_notes,
          location_intake_mode, location_normalization_status,
          service_address_line1, service_city, service_region,
          service_postal_code, service_country_code, discovery_area_label
        )
        VALUES (
          $1, 'Exact request', '123 Palm Ave, Cape Coral, FL 33904', '', '',
          'exact_on_file', 'normalized', '123 Palm Ave', 'Cape Coral', 'FL',
          '33904', 'US', 'Cape Coral, FL'
        )
        RETURNING *
        `,
        [userId]
      );
      assert.equal(exact.rows[0].service_address_line1, "123 Palm Ave");

      const later = await pool.query(
        `
        INSERT INTO posts (
          user_id, title, location, unit_number, access_notes,
          location_intake_mode, location_normalization_status,
          service_address_line1, service_city, service_region,
          service_postal_code, service_country_code, discovery_area_label
        )
        VALUES (
          $1, 'Address later', 'Cape Coral, FL 33904', '', '',
          'address_after_selection', 'normalized', NULL, 'Cape Coral', 'FL',
          '33904', 'US', 'Cape Coral, FL'
        )
        RETURNING *
        `,
        [userId]
      );
      assert.equal(later.rows[0].service_address_line1, null);

      await assert.rejects(
        pool.query(
          `
          INSERT INTO posts (
            user_id, title, unit_number, access_notes,
            location_intake_mode, location_normalization_status,
            service_city, service_region, service_postal_code,
            service_country_code, discovery_area_label
          )
          VALUES (
            $1, 'Missing exact street', '', '', 'exact_on_file', 'normalized',
            'Cape Coral', 'FL', '33904', 'US', 'Cape Coral, FL'
          )
          `,
          [userId]
        ),
        /posts_service_location_shape_check/i
      );
      await assert.rejects(
        pool.query(
          `
          INSERT INTO posts (
            user_id, title, unit_number, access_notes,
            location_intake_mode, location_normalization_status,
            service_address_line1, service_city, service_region,
            service_postal_code, service_country_code, discovery_area_label
          )
          VALUES (
            $1, 'Address later with street', '', '',
            'address_after_selection', 'normalized', '123 Palm Ave',
            'Cape Coral', 'FL', '33904', 'US', 'Cape Coral, FL'
          )
          `,
          [userId]
        ),
        /posts_service_location_shape_check/i
      );

      const columns = await pool.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'posts'
          AND column_name = ANY($1::text[])
        `,
        [[
          "location_intake_mode",
          "location_normalization_status",
          "service_address_line1",
          "service_city",
          "service_region",
          "service_postal_code",
          "service_country_code",
          "discovery_area_label",
        ]]
      );
      assert.equal(columns.rows.length, 8);

      const index = await pool.query(
        `
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_posts_open_normalized_service_locality'
        `
      );
      assert.equal(index.rows.length, 1);
    } finally {
      if (userId) {
        await pool.query("DELETE FROM posts WHERE user_id = $1", [userId]);
        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      }
      await pool.end();
    }
  }
);
