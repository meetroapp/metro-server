"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");

const { getMigrationFiles } = require("../scripts/run-migrations");
const {
  serializeOwnedPortfolioProject,
  serializePublicPortfolioProject,
} = require("../server/media/businessPortfolio");
const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const migrationFilename =
  "202608120001_create_business_portfolio_authority_foundation.sql";
const repositoryRoot = join(__dirname, "..");
const migrationPath = join(repositoryRoot, "migrations", migrationFilename);
const migrationSql = readFileSync(migrationPath, "utf8");
const migrationReadme = readFileSync(
  join(repositoryRoot, "migrations", "README.md"),
  "utf8"
);
const databaseUrl = process.env.BUSINESS_PORTFOLIO_AUTHORITY_DATABASE_URL;

test("Portfolio authority migration is additive, ordered, and ledger-safe", () => {
  const migrations = getMigrationFiles();
  const filenames = migrations.map(({ filename }) => filename);

  assert.equal(filenames.length, 58);
  assert.ok(filenames.includes(migrationFilename));
  assert.equal(
    filenames.filter((filename) => filename.startsWith("202608120001_")).length,
    1
  );
  assert.match(migrationReadme, new RegExp(migrationFilename.replaceAll(".", "\\.")));
  assert.doesNotMatch(migrationSql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(
    migrationSql,
    /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i
  );
});

test("authority columns preserve legacy NULL state before future DRAFT default", () => {
  for (const column of [
    "publication_state TEXT",
    "display_order INTEGER",
    "is_featured BOOLEAN NOT NULL DEFAULT FALSE",
    "privacy_confirmation_version TEXT",
    "privacy_content_digest TEXT",
    "privacy_confirmed_at TIMESTAMPTZ",
    "privacy_confirmed_by_user_id INTEGER",
    "published_at TIMESTAMPTZ",
    "archived_at TIMESTAMPTZ",
    "featured_at TIMESTAMPTZ",
    "updated_at TIMESTAMPTZ",
    "version INTEGER NOT NULL DEFAULT 1",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i")
    );
  }

  const backfillPosition = migrationSql.indexOf("WITH deterministic_project_order");
  const defaultPosition = migrationSql.indexOf(
    "ALTER COLUMN publication_state SET DEFAULT 'DRAFT'"
  );
  assert.ok(backfillPosition > 0);
  assert.ok(defaultPosition > backfillPosition);
  assert.doesNotMatch(
    migrationSql,
    /UPDATE\s+contractor_projects[\s\S]*?SET\s+publication_state/i
  );
  assert.doesNotMatch(
    migrationSql,
    /SET\s+(?:title|description|image_url|image_urls)\s*=/i
  );
});

test("deterministic order and feature authority remain separate", () => {
  assert.match(
    migrationSql,
    /ROW_NUMBER\(\) OVER \(\s*PARTITION BY contractor_id\s*ORDER BY created_at ASC, id ASC\s*\) - 1/i
  );
  assert.match(
    migrationSql,
    /CHECK \(display_order IS NULL OR display_order >= 0\)/i
  );
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS contractor_projects_contractor_display_order_uidx[\s\S]*contractor_id, display_order[\s\S]*WHERE display_order IS NOT NULL/i
  );
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS contractor_projects_one_featured_published_uidx[\s\S]*ON contractor_projects\(contractor_id\)[\s\S]*WHERE is_featured = TRUE AND publication_state = 'PUBLISHED'/i
  );
  assert.match(
    migrationSql,
    /is_featured = TRUE[\s\S]*publication_state = 'PUBLISHED'[\s\S]*featured_at >= published_at/i
  );
});

test("lifecycle, privacy, actor, and version constraints are explicit", () => {
  for (const state of ["DRAFT", "PUBLISHED", "ARCHIVED"]) {
    assert.match(migrationSql, new RegExp(`'${state}'`));
  }
  assert.match(migrationSql, /CHECK \(version >= 1\)/i);
  assert.match(
    migrationSql,
    /privacy_confirmed_by_user_id INTEGER[\s\S]*REFERENCES users\(id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(migrationSql, /privacy_content_digest ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(
    migrationSql,
    /publication_state = 'PUBLISHED'[\s\S]*published_at IS NOT NULL[\s\S]*archived_at IS NULL/i
  );
  assert.match(
    migrationSql,
    /publication_state = 'ARCHIVED'[\s\S]*published_at IS NULL OR archived_at >= published_at/i
  );
  assert.match(
    migrationSql,
    /publication_state IN \('PUBLISHED', 'ARCHIVED'\)[\s\S]*privacy_confirmation_version IS NOT NULL[\s\S]*privacy_confirmed_by_user_id IS NOT NULL/i
  );
});

test("publication audit is owner-scoped, transition-constrained, and append-only", () => {
  assert.match(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS contractor_project_publication_events/i
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY \(project_id, contractor_id\)[\s\S]*REFERENCES contractor_projects\(id, contractor_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    migrationSql,
    /actor_user_id INTEGER NOT NULL[\s\S]*REFERENCES users\(id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    migrationSql,
    /from_state IS NULL AND to_state = 'DRAFT'[\s\S]*from_state = 'DRAFT' AND to_state = 'PUBLISHED'[\s\S]*from_state = 'PUBLISHED' AND to_state = 'ARCHIVED'/i
  );
  assert.match(
    migrationSql,
    /UNIQUE \(project_id, project_version\)/i
  );
  assert.match(
    migrationSql,
    /CREATE TRIGGER contractor_project_publication_events_append_only[\s\S]*BEFORE UPDATE OR DELETE ON contractor_project_publication_events/i
  );
  assert.match(
    migrationSql,
    /RAISE EXCEPTION[\s\S]*USING ERRCODE = '55000'/i
  );
  assert.doesNotMatch(
    migrationSql,
    /INSERT\s+INTO\s+contractor_project_publication_events/i
  );
});

test("B-1 public and B-3 owner serializers remain explicit allowlists", () => {
  const databaseRow = {
    id: 501,
    contractor_id: 91,
    title: "Governed project",
    description: "Approved current-schema content",
    image_url: "https://legacy.example.test/project.png",
    image_urls: ["https://legacy.example.test/project.png"],
    created_at: "2026-08-12T00:00:00.000Z",
    publication_state: "PUBLISHED",
    display_order: 0,
    is_featured: true,
    privacy_confirmation_version: "MC-U1-03-PRIVACY-1",
    privacy_content_digest: "a".repeat(64),
    privacy_confirmed_at: "2026-08-12T00:00:00.000Z",
    privacy_confirmed_by_user_id: 7,
    published_at: "2026-08-12T00:01:00.000Z",
    archived_at: null,
    featured_at: "2026-08-12T00:02:00.000Z",
    updated_at: "2026-08-12T00:02:00.000Z",
    version: 3,
    future_sentinel_column: "must-not-leak",
  };

  const publicProject = serializePublicPortfolioProject(databaseRow);
  const ownerProject = serializeOwnedPortfolioProject(databaseRow);

  assert.deepEqual(Object.keys(publicProject), [
    "id",
    "contractor_id",
    "title",
    "description",
    "image_url",
    "image_urls",
    "created_at",
  ]);
  assert.deepEqual(Object.keys(ownerProject), [
    "id",
    "contractor_id",
    "title",
    "description",
    "image_url",
    "image_urls",
    "created_at",
    "portfolio_media",
    "publication_state",
    "migration_review_required",
    "display_order",
    "is_featured",
    "privacy_confirmation",
    "published_at",
    "archived_at",
    "featured_at",
    "updated_at",
    "version",
    "actions",
  ]);
  for (const privateField of [
    "future_sentinel_column",
    "privacy_content_digest",
    "publication_state",
    "privacy_confirmation_version",
    "privacy_confirmed_by_user_id",
  ]) {
    assert.equal(Object.hasOwn(publicProject, privateField), false);
  }
  for (const privateField of [
    "future_sentinel_column",
    "privacy_confirmation_version",
    "privacy_content_digest",
    "privacy_confirmed_by_user_id",
  ]) {
    assert.equal(Object.hasOwn(ownerProject, privateField), false);
  }
});

async function expectDatabaseRejection(client, statement, values, expectedCode) {
  const savepoint = `portfolio_authority_${randomUUID().replaceAll("-", "")}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await assert.rejects(
      client.query(statement, values),
      (error) => error?.code === expectedCode
    );
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

test(
  "disposable PostgreSQL preserves five legacy rows and enforces authority foundations",
  { skip: !databaseUrl },
  async () => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const client = await pool.connect();
    const schemaName = `portfolio_authority_${randomUUID().replaceAll("-", "")}`;
    const digest = "a".repeat(64);
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET LOCAL search_path TO ${schemaName}, public`);
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE contractor_profiles (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE contractor_projects (
          id SERIAL PRIMARY KEY,
          contractor_id INTEGER NOT NULL
            REFERENCES contractor_profiles(id) ON DELETE CASCADE,
          title TEXT,
          description TEXT,
          image_url TEXT,
          image_urls JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.query(`
        INSERT INTO users (id) VALUES (1), (2), (3);
        INSERT INTO contractor_profiles (id, user_id)
        VALUES (10, 1), (11, 2), (12, 3);
        INSERT INTO contractor_projects (
          id, contractor_id, title, description, image_url, image_urls, created_at
        ) VALUES
          (101, 10, 'Later A', 'Keep A', 'https://example.test/a.png', '["https://example.test/a.png"]', '2026-07-02T00:00:00Z'),
          (102, 10, 'Earlier A', 'Keep B', '', '[]', '2026-07-01T00:00:00Z'),
          (103, 11, 'Later B', 'Keep C', '', '[]', '2026-07-03T00:00:00Z'),
          (104, 11, 'Earlier B', 'Keep D', 'https://example.test/d.png', '["https://example.test/d.png"]', '2026-07-01T00:00:00Z'),
          (105, 12, 'Only C', 'Keep E', '', '[]', '2026-07-04T00:00:00Z');
      `);

      const before = await client.query(`
        SELECT id, title, description, image_url, image_urls, created_at
        FROM contractor_projects
        ORDER BY id ASC
      `);

      await client.query(migrationSql);
      await client.query(migrationSql);

      const legacy = await client.query(`
        SELECT id, publication_state, display_order, is_featured, version,
               updated_at
        FROM contractor_projects
        ORDER BY id ASC
      `);
      assert.deepEqual(
        legacy.rows.map((row) => ({
          id: row.id,
          publicationState: row.publication_state,
          displayOrder: row.display_order,
          isFeatured: row.is_featured,
          version: row.version,
          updatedAt: row.updated_at,
        })),
        [
          { id: 101, publicationState: null, displayOrder: 1, isFeatured: false, version: 1, updatedAt: null },
          { id: 102, publicationState: null, displayOrder: 0, isFeatured: false, version: 1, updatedAt: null },
          { id: 103, publicationState: null, displayOrder: 1, isFeatured: false, version: 1, updatedAt: null },
          { id: 104, publicationState: null, displayOrder: 0, isFeatured: false, version: 1, updatedAt: null },
          { id: 105, publicationState: null, displayOrder: 0, isFeatured: false, version: 1, updatedAt: null },
        ]
      );

      const after = await client.query(`
        SELECT id, title, description, image_url, image_urls, created_at
        FROM contractor_projects
        ORDER BY id ASC
      `);
      assert.deepEqual(after.rows, before.rows);

      const inserted = await client.query(`
        INSERT INTO contractor_projects (contractor_id, title, image_urls)
        VALUES (12, 'Future draft', '[]')
        RETURNING publication_state, display_order, is_featured, version, updated_at
      `);
      assert.equal(inserted.rows[0].publication_state, "DRAFT");
      assert.equal(inserted.rows[0].display_order, null);
      assert.equal(inserted.rows[0].is_featured, false);
      assert.equal(inserted.rows[0].version, 1);
      assert.ok(inserted.rows[0].updated_at instanceof Date);

      await expectDatabaseRejection(
        client,
        "UPDATE contractor_projects SET publication_state = 'VISIBLE' WHERE id = 105",
        [],
        "23514"
      );
      await expectDatabaseRejection(
        client,
        "UPDATE contractor_projects SET display_order = -1 WHERE id = 105",
        [],
        "23514"
      );
      await expectDatabaseRejection(
        client,
        "UPDATE contractor_projects SET version = 0 WHERE id = 105",
        [],
        "23514"
      );
      await expectDatabaseRejection(
        client,
        `UPDATE contractor_projects
         SET privacy_confirmation_version = 'MC-U1-03-PRIVACY-1',
             privacy_content_digest = $1,
             privacy_confirmed_at = CURRENT_TIMESTAMP,
             privacy_confirmed_by_user_id = 999999
         WHERE id = 105`,
        [digest],
        "23503"
      );
      await expectDatabaseRejection(
        client,
        `UPDATE contractor_projects
         SET publication_state = 'PUBLISHED', published_at = CURRENT_TIMESTAMP
         WHERE id = 101`,
        [],
        "23514"
      );

      await client.query(
        `UPDATE contractor_projects
         SET publication_state = 'PUBLISHED',
             privacy_confirmation_version = 'MC-U1-03-PRIVACY-1',
             privacy_content_digest = $1,
             privacy_confirmed_at = '2026-08-12T00:00:00Z',
             privacy_confirmed_by_user_id = 1,
             published_at = '2026-08-12T00:01:00Z',
             is_featured = TRUE,
             featured_at = '2026-08-12T00:02:00Z',
             version = 2
         WHERE id = 102`,
        [digest]
      );
      await expectDatabaseRejection(
        client,
        `UPDATE contractor_projects
         SET publication_state = 'PUBLISHED',
             privacy_confirmation_version = 'MC-U1-03-PRIVACY-1',
             privacy_content_digest = $1,
             privacy_confirmed_at = '2026-08-12T00:00:00Z',
             privacy_confirmed_by_user_id = 1,
             published_at = '2026-08-12T00:01:00Z',
             is_featured = TRUE,
             featured_at = '2026-08-12T00:02:00Z',
             version = 2
         WHERE id = 101`,
        [digest],
        "23505"
      );

      const event = await client.query(
        `INSERT INTO contractor_project_publication_events (
           project_id, contractor_id, actor_user_id, project_version,
           from_state, to_state, privacy_confirmation_version,
           privacy_content_digest, transitioned_at
         ) VALUES (
           102, 10, 1, 2, 'DRAFT', 'PUBLISHED',
           'MC-U1-03-PRIVACY-1', $1, '2026-08-12T00:01:00Z'
         ) RETURNING id`,
        [digest]
      );
      await expectDatabaseRejection(
        client,
        "UPDATE contractor_project_publication_events SET actor_user_id = 2 WHERE id = $1",
        [event.rows[0].id],
        "55000"
      );
      await expectDatabaseRejection(
        client,
        "DELETE FROM contractor_project_publication_events WHERE id = $1",
        [event.rows[0].id],
        "55000"
      );

      const indexes = await client.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1
           AND indexname IN (
             'contractor_projects_contractor_display_order_uidx',
             'contractor_projects_one_featured_published_uidx',
             'contractor_projects_public_order_idx',
             'contractor_project_publication_event_order_idx'
           )
         ORDER BY indexname`,
        [schemaName]
      );
      assert.equal(indexes.rows.length, 4);

      await client.query("ROLLBACK");
      transactionOpen = false;
      const cleanup = await pool.query(
        "SELECT to_regnamespace($1) IS NULL AS schema_absent",
        [schemaName]
      );
      assert.equal(cleanup.rows[0].schema_absent, true);
    } finally {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The transaction may already be closed by the successful proof.
        }
      }
      client.release();
      await pool.end();
    }
  }
);
