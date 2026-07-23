"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationPath = join(
  __dirname,
  "../migrations/202607230003_create_emergency_safety_assessments.sql"
);

const sql = readFileSync(migrationPath, "utf8");

test(
  "Emergency safety migration creates one normalized assessment per request",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS emergency_request_safety_assessments/i
    );

    assert.match(
      sql,
      /emergency_request_id INTEGER NOT NULL[\s\S]*REFERENCES emergency_requests\(id\)[\s\S]*ON DELETE RESTRICT/i
    );

    assert.match(
      sql,
      /CONSTRAINT emergency_request_safety_assessments_one_per_request[\s\S]*UNIQUE\s*\(\s*emergency_request_id\s*\)/i
    );
  }
);

test(
  "Emergency safety migration requires the complete structured assessment",
  () => {
    for (const field of [
      "immediate_danger",
      "medical_emergency",
      "fire_or_smoke",
      "gas_odor_or_suspected_leak",
      "active_crime_or_threat",
      "electrical_immediate_hazard",
      "structural_collapse_risk",
      "flooding_or_water_damage",
      "occupants_unable_to_exit",
      "emergency_services_contacted",
      "safe_to_remain_at_location",
    ]) {
      assert.match(
        sql,
        new RegExp(`${field} BOOLEAN NOT NULL`, "i")
      );
    }

    assert.match(
      sql,
      /additional_safety_context TEXT NOT NULL DEFAULT ''/i
    );

    assert.match(
      sql,
      /char_length\(additional_safety_context\)\s*<=\s*2000/i
    );
  }
);

test(
  "Emergency safety disposition is constrained to governed server outcomes",
  () => {
    assert.match(
      sql,
      /disposition TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /CONSTRAINT emergency_request_safety_assessments_disposition_check/i
    );

    for (const disposition of [
      "continue",
      "contact_emergency_services",
      "leave_location",
      "manual_review",
    ]) {
      assert.match(
        sql,
        new RegExp(`'${disposition}'`, "i")
      );
    }

    assert.doesNotMatch(
      sql,
      /client[_-]?supplied[_-]?disposition/i
    );
  }
);

test(
  "Emergency safety migration creates deterministic review lookup support",
  () => {
    assert.match(
      sql,
      /emergency_request_safety_assessments_disposition_idx/i
    );

    assert.match(
      sql,
      /ON emergency_request_safety_assessments\s*\(\s*disposition\s*,\s*updated_at DESC\s*\)/i
    );
  }
);

test(
  "Emergency safety migration is additive and runner compatible",
  () => {
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(sql, /\bUPDATE\b/i);
    assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
    assert.doesNotMatch(sql, /\bBEGIN\s*;/i);
    assert.doesNotMatch(sql, /\bCOMMIT\s*;/i);
    assert.doesNotMatch(sql, /\bROLLBACK\s*;/i);
  }
);

test(
  "Emergency safety migration introduces no runtime authority or activation",
  () => {
    assert.doesNotMatch(
      sql,
      /\b(?:app|router)\.(?:get|post|put|patch|delete)\b/i
    );

    assert.doesNotMatch(
      sql,
      /\b(?:notify|dispatch|assign|candidate|conversation|message)\b/i
    );

    assert.doesNotMatch(
      sql,
      /feature[_-]?flag/i
    );
  }
);

test(
  "migration inventory registers the safety migration after its dependencies",
  () => {
    const readme = readFileSync(
      join(__dirname, "../migrations/README.md"),
      "utf8"
    );

    const aggregateIndex = readme.indexOf(
      "202607230001_create_emergency_requests.sql"
    );

    const relationshipIndex = readme.indexOf(
      "202607230002_add_emergency_relationship_source.sql"
    );

    const safetyIndex = readme.indexOf(
      "202607230003_create_emergency_safety_assessments.sql"
    );

    assert.notEqual(aggregateIndex, -1);
    assert.notEqual(relationshipIndex, -1);
    assert.notEqual(safetyIndex, -1);

    assert.ok(aggregateIndex < relationshipIndex);
    assert.ok(relationshipIndex < safetyIndex);
  }
);
