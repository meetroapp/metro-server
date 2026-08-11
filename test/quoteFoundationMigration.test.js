"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const migrationName = "202608100003_create_canonical_quote_scope_foundation.sql";
const sql = readFileSync(join(root, "migrations", migrationName), "utf8");
const readme = readFileSync(join(root, "migrations", "README.md"), "utf8");

test("Slice 005 is one additive migration after Recommendation foundation", () => {
  const migrations = readdirSync(join(root, "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal(migrations.length, 33);
  assert.equal(migrations.at(-3), "202608100002_create_recommendation_hierarchy_foundation.sql");
  assert.equal(migrations.at(-2), migrationName);
  assert.equal(migrations.at(-1), "202608100004_create_quote_composition_feedback.sql");
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(
    sql,
    /\b(?:INSERT INTO|UPDATE)\s+(?:jobs|posts|reported_concerns|canonical_evaluations|canonical_evaluation_findings|canonical_workstreams|canonical_recommendations|quote_requests)\b/i
  );
  assert.match(readme, new RegExp(migrationName));
});

test("Quote identity, immutable versions, and snapshots preserve exact Job scope", () => {
  for (const table of [
    "canonical_quotes",
    "canonical_quote_versions",
    "canonical_quote_scope_items",
    "canonical_quote_scope_item_snapshots",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }
  assert.match(sql, /FOREIGN KEY \(job_id, job_request_id, relationship_id\)[\s\S]*REFERENCES jobs\(id, job_request_id, source_request_relationship_id\)/i);
  assert.match(sql, /PRIMARY KEY \(quote_id, version\)/i);
  assert.match(sql, /integrity_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /prevent_canonical_quote_history_mutation/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
});

test("scope semantics, source versions, and integer arithmetic are constrained", () => {
  for (const value of [
    "COMPLETED_BILLABLE_SERVICE", "TEMPORARY_SERVICE", "FUTURE_WORK",
    "MATERIAL_INCLUDED", "MATERIAL_EXCLUDED", "CUSTOMER_SUPPLIED_MATERIAL",
    "SEPARATE_PROPOSAL", "PROFESSIONAL_SUPPLIED", "CUSTOMER_SUPPLIED",
    "PENDING_SELECTION", "MANUAL_PROFESSIONAL",
  ]) assert.match(sql, new RegExp(`'${value}'`));
  assert.match(sql, /line_total_minor = unit_amount_minor \* quantity/i);
  assert.match(sql, /total_minor\s*=\s*materials_subtotal_minor \+ labor_service_subtotal_minor/i);
  assert.match(sql, /source_recommendation_id, source_version, job_id/i);
  assert.match(sql, /source_activity_id,[\s\S]*source_version,[\s\S]*source_workstream_id,[\s\S]*job_id/i);
});

test("Quote authority is bounded to Draft, issue, customer decision, and revision", () => {
  for (const capability of [
    "quote.create", "quote.read", "quote.scope.manage", "quote.issue",
    "quote.read_customer", "quote.approve", "quote.decline", "quote.revise",
  ]) {
    assert.match(sql, new RegExp(`'${capability.replaceAll(".", "\\.")}'`));
  }
  assert.doesNotMatch(sql, /\b(?:procurement|payment_schedule|tax_rate|discount|invoice)\b/i);
});

test("issuance freezes exact version, actor, grant, evidence, time, and hash", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_quote_issuances/i);
  for (const field of [
    "quote_version", "issuer_participant_id", "authority_grant_id",
    "commercial_evidence_id", "idempotency_id", "issued_at",
    "source_snapshot_integrity_hash",
  ]) assert.match(sql, new RegExp(field));
  assert.match(sql, /issued canonical Quote identity is immutable/i);
  assert.match(sql, /'canonical_quote_issuances'/i);
});

test("customer decisions are immutable and derived Quotes retain explicit lineage", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_quote_customer_decisions/i);
  for (const field of [
    "issued_quote_version", "customer_participant_id", "authority_grant_id",
    "decision", "idempotency_id", "issued_integrity_hash", "decided_at",
  ]) assert.match(sql, new RegExp(field));
  assert.match(sql, /decision IN \('APPROVED', 'DECLINED'\)/i);
  assert.match(sql, /'canonical_quote_customer_decisions'/i);
  assert.match(sql, /parent_quote_id/i);
  assert.match(sql, /lineage_type IN \('REVISED_QUOTE', 'SUPPLEMENTAL_QUOTE'\)/i);
  assert.match(sql, /'SUPPLEMENTAL_WORK'/i);
});
