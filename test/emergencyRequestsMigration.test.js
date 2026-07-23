"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationPath = join(
  __dirname,
  "../migrations/202607230001_create_emergency_requests.sql"
);

const sql = readFileSync(migrationPath, "utf8");

test(
  "Emergency foundation migration creates only the disabled canonical aggregate",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS emergency_requests/i
    );

    assert.match(
      sql,
      /homeowner_id INTEGER NOT NULL[\s\S]*REFERENCES users\(id\)[\s\S]*ON DELETE RESTRICT/i
    );

    assert.match(
      sql,
      /category TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /service_domain TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /service_specialty TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /location_text TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /status TEXT NOT NULL DEFAULT 'draft'/i
    );

    for (const status of [
      "draft",
      "ready_for_distribution",
      "active",
      "selection_pending",
      "assigned",
      "in_service",
      "resolved",
      "cancelled",
      "expired",
      "unable_to_match",
      "safety_blocked",
    ]) {
      assert.match(
        sql,
        new RegExp(`'${status}'`, "i")
      );
    }

    assert.match(
      sql,
      /CONSTRAINT emergency_requests_status_check/i
    );

    assert.match(
      sql,
      /requested_at TIMESTAMP/i
    );

    assert.match(
      sql,
      /assigned_at TIMESTAMP/i
    );

    assert.match(
      sql,
      /resolved_at TIMESTAMP/i
    );

    assert.match(
      sql,
      /cancelled_at TIMESTAMP/i
    );

    assert.match(
      sql,
      /expired_at TIMESTAMP/i
    );

    assert.match(
      sql,
      /created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP/i
    );

    assert.match(
      sql,
      /updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP/i
    );

    assert.match(
      sql,
      /emergency_requests_homeowner_idx/i
    );

    assert.match(
      sql,
      /emergency_requests_status_service_idx/i
    );

    assert.doesNotMatch(
      sql,
      /\bINSERT\s+INTO\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bUPDATE\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bDELETE\s+FROM\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bDROP\s+TABLE\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bTRUNCATE\b/i
    );
  }
);

test(
  "Emergency foundation migration does not introduce runtime routes or activation",
  () => {
    assert.doesNotMatch(
      sql,
      /\b(?:app|router)\.(?:get|post|put|patch|delete)\b/i
    );

    assert.doesNotMatch(
      sql,
      /feature[_-]?flag/i
    );

    assert.doesNotMatch(
      sql,
      /dispatch[_-]?enabled/i
    );
  }
);
