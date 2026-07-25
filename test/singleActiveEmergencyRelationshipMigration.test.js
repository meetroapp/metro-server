"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationFilename =
  "202607240001_add_single_active_emergency_relationship.sql";

const migrationPath = join(
  __dirname,
  "../migrations",
  migrationFilename
);

const sql = readFileSync(migrationPath, "utf8");

test(
  "single-active Emergency migration creates the exact partial unique index",
  () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+request_relationships_one_active_emergency/i
    );

    assert.match(
      sql,
      /ON request_relationships\s*\(\s*emergency_request_id\s*\)/i
    );

    assert.match(
      sql,
      /WHERE emergency_request_id IS NOT NULL\s+AND status = 'active'/i
    );
  }
);

test(
  "single-active Emergency migration does not constrain post-backed relationships",
  () => {
    const compact = sql.replace(/\s+/g, " ");

    assert.match(
      compact,
      /ON request_relationships\(emergency_request_id\) WHERE emergency_request_id IS NOT NULL AND status = 'active'/i
    );

    assert.doesNotMatch(
      compact,
      /ON request_relationships\(post_id\)/i
    );

    assert.doesNotMatch(
      compact,
      /WHERE post_id IS NOT NULL AND status = 'active'/i
    );
  }
);

test(
  "single-active Emergency migration fails closed without rewriting relationship data",
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
      /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bALTER\s+TABLE\b/i
    );
  }
);

test(
  "single-active Emergency migration leaves transaction control to the governed runner",
  () => {
    assert.doesNotMatch(
      sql,
      /\bBEGIN\s*;/i
    );

    assert.doesNotMatch(
      sql,
      /\bCOMMIT\s*;/i
    );

    assert.doesNotMatch(
      sql,
      /\bROLLBACK\s*;/i
    );
  }
);

test(
  "migration inventory registers single-active integrity after Emergency dependencies",
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

    const safetyAssessmentIndex = readme.indexOf(
      "202607230003_create_emergency_safety_assessments.sql"
    );

    const singleActiveIndex = readme.indexOf(migrationFilename);

    assert.notEqual(emergencyAggregateIndex, -1);
    assert.notEqual(relationshipSourceIndex, -1);
    assert.notEqual(safetyAssessmentIndex, -1);
    assert.notEqual(singleActiveIndex, -1);

    assert.ok(
      emergencyAggregateIndex < relationshipSourceIndex,
      "Emergency aggregate must precede relationship source support."
    );

    assert.ok(
      relationshipSourceIndex < safetyAssessmentIndex,
      "Emergency relationship source must precede safety assessment."
    );

    assert.ok(
      safetyAssessmentIndex < singleActiveIndex,
      "Single-active integrity must follow all existing Emergency schema dependencies."
    );
  }
);

test(
  "migration filename follows the governed timestamp convention",
  () => {
    assert.match(
      migrationFilename,
      /^\d{12}_[a-z0-9_]+\.sql$/
    );
  }
);
