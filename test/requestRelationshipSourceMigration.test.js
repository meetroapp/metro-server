"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationPath = join(
  __dirname,
  "../migrations/202607230002_add_emergency_relationship_source.sql"
);

const sql = readFileSync(migrationPath, "utf8");

test(
  "relationship source migration preserves real foreign keys and exact-one-source integrity",
  () => {
    assert.match(
      sql,
      /ADD COLUMN IF NOT EXISTS emergency_request_id INTEGER[\s\S]*REFERENCES emergency_requests\(id\)[\s\S]*ON DELETE RESTRICT/i
    );

    assert.match(
      sql,
      /ALTER COLUMN post_id DROP NOT NULL/i
    );

    assert.match(
      sql,
      /DROP CONSTRAINT IF EXISTS request_relationships_unique_response/i
    );

    assert.match(
      sql,
      /request_relationships_exactly_one_source/i
    );

    assert.match(
      sql,
      /post_id IS NOT NULL[\s\S]*emergency_request_id IS NULL/i
    );

    assert.match(
      sql,
      /post_id IS NULL[\s\S]*emergency_request_id IS NOT NULL/i
    );

    assert.match(
      sql,
      /request_relationships_unique_post_response[\s\S]*ON request_relationships\(post_id, contractor_id\)[\s\S]*WHERE post_id IS NOT NULL/i
    );

    assert.match(
      sql,
      /request_relationships_unique_emergency_response[\s\S]*ON request_relationships\(emergency_request_id, contractor_id\)[\s\S]*WHERE emergency_request_id IS NOT NULL/i
    );

    assert.match(
      sql,
      /request_relationships_emergency_request_idx[\s\S]*ON request_relationships\(emergency_request_id\)/i
    );
  }
);

test(
  "relationship source migration preserves existing relationship data",
  () => {
    assert.doesNotMatch(
      sql,
      /\bINSERT\s+INTO\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bUPDATE\s+request_relationships\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bDELETE\s+FROM\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bTRUNCATE\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bDROP\s+TABLE\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bDROP\s+COLUMN\b/i
    );
  }
);

test(
  "relationship source migration rejects missing and conflicting aggregate identity",
  () => {
    const compact = sql.replace(/\s+/g, " ");

    assert.match(
      compact,
      /CHECK \( \( post_id IS NOT NULL AND emergency_request_id IS NULL \) OR \( post_id IS NULL AND emergency_request_id IS NOT NULL \) \)/i
    );
  }
);

test(
  "migration inventory registers both Emergency foundation migrations in order",
  () => {
    const readme = readFileSync(
      join(__dirname, "../migrations/README.md"),
      "utf8"
    );

    const emergencyAggregateIndex = readme.indexOf(
      "202607230001_create_emergency_requests.sql"
    );

    const relationshipSourceIndex = readme.indexOf(
      "202607230002_add_emergency_relationship_source.sql"
    );

    assert.notEqual(emergencyAggregateIndex, -1);
    assert.notEqual(relationshipSourceIndex, -1);

    assert.ok(
      emergencyAggregateIndex < relationshipSourceIndex,
      "Emergency aggregate migration must precede the relationship foreign-key migration."
    );
  }
);
