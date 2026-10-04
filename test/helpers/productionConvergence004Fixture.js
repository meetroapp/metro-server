"use strict";

const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const manifest = require("../../production-convergence/004/manifest");

const migrationsDirectory = join(__dirname, "..", "..", "migrations");

const SYNTHETIC_ARCHIVE_SQL = `
  CREATE TABLE legacy_orphan_message_archive (
    message_id INTEGER PRIMARY KEY,
    source_table TEXT NOT NULL DEFAULT 'messages' CHECK (source_table = 'messages'),
    source_record JSONB NOT NULL CHECK (jsonb_typeof(source_record) = 'object'),
    source_record_sha256 TEXT NOT NULL CHECK (source_record_sha256 ~ '^[0-9a-f]{64}$'),
    original_quote_request_id INTEGER,
    original_sender_id INTEGER,
    original_receiver_id INTEGER,
    original_created_at TIMESTAMP,
    quarantine_reason TEXT NOT NULL DEFAULT 'legacy_orphan_invalid_canonical_identity'
      CHECK (quarantine_reason = 'legacy_orphan_invalid_canonical_identity'),
    authority_classification TEXT NOT NULL DEFAULT 'historical_evidence_only'
      CHECK (authority_classification = 'historical_evidence_only'),
    canonical_authority_granted BOOLEAN NOT NULL DEFAULT FALSE
      CHECK (canonical_authority_granted = FALSE),
    governing_contract_id TEXT NOT NULL DEFAULT 'MC-PRODUCTION-RECONCILIATION-001'
      CHECK (governing_contract_id = 'MC-PRODUCTION-RECONCILIATION-001'),
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX legacy_orphan_message_archive_quarantined_at_idx
    ON legacy_orphan_message_archive(quarantined_at, message_id);
  CREATE FUNCTION prevent_legacy_orphan_message_archive_mutation()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'legacy_orphan_message_archive is immutable';
  END;
  $$;
  CREATE TRIGGER legacy_orphan_message_archive_immutable
    BEFORE UPDATE OR DELETE ON legacy_orphan_message_archive
    FOR EACH ROW EXECUTE FUNCTION prevent_legacy_orphan_message_archive_mutation();
`;

function prefixMigrationFiles() {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{12}.*\.sql$/.test(name))
    .sort()
    .filter((name) => name < manifest.TARGET_MIGRATIONS[0].filename);
}

async function resetSyntheticProduction(client) {
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  for (const filename of prefixMigrationFiles()) {
    await client.query(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }

  await client.query(`
    ALTER TABLE contractor_profiles
      ADD COLUMN plan_type TEXT DEFAULT 'free',
      ADD COLUMN is_verified BOOLEAN DEFAULT FALSE,
      ADD COLUMN is_featured BOOLEAN DEFAULT FALSE,
      ADD COLUMN for_hire_post_limit INTEGER DEFAULT 3
  `);
  await client.query(`
    CREATE TABLE schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      execution_target TEXT NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query(SYNTHETIC_ARCHIVE_SQL);

  for (const entry of manifest.CURRENT_PRODUCTION_LEDGER) {
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, execution_target)
       VALUES ($1, $2, $3)`,
      [entry.filename, entry.checksum, entry.executionTarget]
    );
  }

  await client.query(`
    SET session_replication_role = replica;

    INSERT INTO users
      (id, username, email, password_hash, role, account_type,
       business_name, business_category, profile_photo_url)
    SELECT id,
           'synthetic_user_' || id,
           'synthetic_' || id || '@example.invalid',
           'synthetic-password-hash',
           CASE WHEN id <= 6 THEN 'contractor' ELSE 'homeowner' END,
           CASE WHEN id <= 6 THEN 'professional' ELSE 'homeowner' END,
           CASE WHEN id <= 6 THEN 'Synthetic Business ' || id ELSE '' END,
           CASE WHEN id <= 6 THEN 'Synthetic Trade' ELSE '' END,
           ''
      FROM generate_series(1, 13) id;

    INSERT INTO contractor_profiles
      (id, user_id, business_name, category, phone, location, bio, image_url,
       plan_type, is_verified, is_featured, for_hire_post_limit)
    SELECT id, id, 'Synthetic Business ' || id, 'Synthetic Trade',
           '000-000-0000', 'Synthetic City', 'Synthetic profile', '',
           'free', FALSE, FALSE, 3
      FROM generate_series(1, 6) id;

    INSERT INTO contractor_projects
      (id, contractor_id, title, description, image_url, image_urls)
    SELECT id, id, 'Synthetic project ' || id, 'Synthetic project description',
           '', '[]'::jsonb
      FROM generate_series(1, 4) id;

    INSERT INTO posts
      (id, user_id, title, description, category, location)
    SELECT id, 7, 'Synthetic request ' || id, 'Synthetic request description',
           'Synthetic category', 'Synthetic location'
      FROM generate_series(1, 43) id;

    INSERT INTO quote_requests
      (id, contractor_id, homeowner_id, project_title, project_description, location)
    VALUES (1, 1, 7, 'Synthetic quote', 'Synthetic quote description', 'Synthetic location');

    INSERT INTO request_relationships
      (id, post_id, homeowner_id, contractor_id, professional_user_id,
       status, introduction_text)
    VALUES (1, 1, 7, 1, 1, 'pending', 'Synthetic introduction');

    INSERT INTO conversations
      (id, relationship_id, homeowner_id, contractor_id, professional_user_id, status)
    VALUES (1, 1, 7, 1, 1, 'active');

    INSERT INTO messages
      (id, quote_request_id, conversation_id, sender_id, receiver_id, message_text)
    SELECT id, NULL, 1,
           CASE WHEN id % 2 = 0 THEN 7 ELSE 1 END,
           CASE WHEN id % 2 = 0 THEN 1 ELSE 7 END,
           'Synthetic legacy message ' || id
      FROM generate_series(1, 12) id;

    INSERT INTO conversation_participant_state
      (conversation_id, user_id, participant_role)
    VALUES (1, 7, 'homeowner'), (1, 1, 'professional');

    INSERT INTO legacy_orphan_message_archive
      (message_id, source_record, source_record_sha256)
    SELECT 1000 + id,
           jsonb_build_object('syntheticArchiveId', id),
           encode(sha256(('synthetic-archive-' || id)::bytea), 'hex')
      FROM generate_series(1, 4) id;

    SET session_replication_role = origin;
  `);
}

module.exports = Object.freeze({
  resetSyntheticProduction,
});
