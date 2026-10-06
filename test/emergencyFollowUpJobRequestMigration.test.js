"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName =
  "202609270001_create_emergency_follow_up_job_request_authority.sql";
const previousMigration =
  "202609230001_link_quote_issuance_evaluation.sql";

const sql = readFileSync(
  join(__dirname, "..", "migrations", migrationName),
  "utf8"
);

test(
  "Emergency follow-up authority is additive after the certified 106-migration staging boundary",
  () => {
    const migrations = getMigrationFiles();

    assert.equal(migrations.length, 111);
    assert.equal(migrations[105]?.filename, previousMigration);
    assert.equal(migrations[106]?.filename, migrationName);
    assert.equal(
      migrations.at(-1)?.filename,
      "202610060001_create_business_provider_connection_authority.sql"
    );

    assert.doesNotMatch(
      sql,
      /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im
    );
    assert.doesNotMatch(
      sql,
      /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE)\b/i
    );
    assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\w+|COPY\s+\w+)\b/im);
  }
);

test(
  "follow-up authority links one completed Emergency to a distinct homeowner-owned ordinary Job Request",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS emergency_follow_up_job_requests/i
    );
    assert.match(
      sql,
      /relation_type\s+TEXT[\s\S]*EMERGENCY_FOLLOW_UP/i
    );
    assert.match(sql, /emergency_job_id\s+UUID\s+NOT NULL/i);
    assert.match(sql, /emergency_request_id\s+INTEGER\s+NOT NULL/i);
    assert.match(sql, /homeowner_user_id\s+INTEGER\s+NOT NULL/i);
    assert.match(sql, /follow_up_job_request_id\s+INTEGER\s+NOT NULL/i);
    assert.match(sql, /job_request_create_command_id\s+UUID\s+NOT NULL/i);

    assert.match(
      sql,
      /FOREIGN KEY \(emergency_job_id, emergency_request_id, homeowner_user_id\)[\s\S]*REFERENCES jobs\(id, source_emergency_request_id, created_by_user_id\)/i
    );
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+emergency_requests_follow_up_owner_identity_uidx\s+ON emergency_requests\(id,\s*homeowner_id\)/i
    );
    assert.match(
      sql,
      /FOREIGN KEY \(emergency_request_id, homeowner_user_id\)[\s\S]*REFERENCES emergency_requests\(id, homeowner_id\)/i
    );
    assert.match(
      sql,
      /FOREIGN KEY \(follow_up_job_request_id, homeowner_user_id\)[\s\S]*REFERENCES posts\(id, user_id\)/i
    );
    assert.match(
      sql,
      /FOREIGN KEY \(job_request_create_command_id, homeowner_user_id, follow_up_job_request_id\)[\s\S]*REFERENCES job_request_create_command_idempotency\(id, actor_user_id, post_id\)/i
    );

    assert.match(sql, /jobs\.source_type = 'emergency_request'/i);
    assert.match(sql, /jobs\.job_request_id IS NULL/i);
    assert.match(
      sql,
      /ON jobs\(id,\s*source_emergency_request_id,\s*created_by_user_id\)/i
    );
    assert.match(
      sql,
      /jobs\.source_emergency_request_id = NEW\.emergency_request_id/i
    );
    assert.doesNotMatch(
      sql,
      /(^|[^A-Za-z0-9_])jobs\.emergency_request_id/i
    );
    assert.match(sql, /emergency_requests\.status = 'completed'/i);
    assert.match(sql, /emergency_requests\.completed_at IS NOT NULL/i);
    assert.match(sql, /posts\.lifecycle_contract_version = 2/i);
    assert.match(sql, /posts\.cancelled_at IS NULL/i);
    assert.match(sql, /commands\.command_name = 'job_request\.create'/i);
    assert.match(sql, /commands\.command_scope = 'ordinary'/i);
    assert.match(sql, /commands\.completed_at IS NOT NULL/i);
  }
);

test(
  "follow-up linkage is immutable and does not convert either canonical source",
  () => {
    assert.match(
      sql,
      /BEFORE INSERT ON emergency_follow_up_job_requests[\s\S]*assert_emergency_follow_up_job_request_authority/i
    );
    assert.match(
      sql,
      /BEFORE UPDATE OR DELETE ON emergency_follow_up_job_requests[\s\S]*guard_emergency_follow_up_job_request_history/i
    );
    assert.match(sql, /ERRCODE = '23514'/i);
    assert.match(sql, /ERRCODE = '55000'/i);

    assert.doesNotMatch(
      sql,
      /\bUPDATE\s+(?:jobs|posts|emergency_requests)\b/i
    );
    assert.doesNotMatch(
      sql,
      /\bDELETE\s+FROM\s+(?:jobs|posts|emergency_requests)\b/i
    );
    assert.doesNotMatch(
      sql,
      /\bINSERT\s+INTO\s+(?:jobs|posts|emergency_requests)\b/i
    );

    assert.doesNotMatch(sql, /\bfollow_up_job_id\b/i);
    assert.match(
      sql,
      /Any later canonical Job is resolved through the existing ordinary request selection lifecycle/i
    );
  }
);
