"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationsDirectory = join(__dirname, "..", "migrations");
const migration59Name =
  "202608280001_create_pre_work_deposit_payment_authority.sql";
const migration60Name =
  "202608280002_create_canonical_materials_work_preparation_authority.sql";
const migration61Name =
  "202608280003_create_canonical_approved_work_execution_authority.sql";
const sql = readFileSync(join(migrationsDirectory, migration60Name), "utf8");

test("migration 60 follows frozen Migration 59 and is locally inventoried", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations[74]?.filename || migrations[74]), "202608310001_create_business_job_customer_message_authority.sql");
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202609020007_create_payment_reminder_evidence.sql");
  assert.deepEqual(
    migrations.slice(58, 61).map(({ filename }) => filename),
    [migration59Name, migration60Name, migration61Name]
  );
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test("migration 60 creates exactly the accepted Work Preparation aggregate tables", () => {
  for (const table of [
    "canonical_work_preparation_command_idempotency",
    "canonical_work_preparation_plans",
    "canonical_work_preparation_plan_versions",
    "canonical_work_preparation_items",
    "canonical_work_preparation_item_snapshots",
    "canonical_material_purchase_records",
    "canonical_material_purchase_corrections",
    "canonical_work_preparation_events",
    "canonical_work_preparation_evidence_references",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }
  assert.doesNotMatch(
    sql,
    /^\s*(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+)/im
  );
  assert.doesNotMatch(
    sql,
    /INSERT INTO (?:canonical_work_preparation_|canonical_material_|canonical_pre_work_|canonical_quote|canonical_invoice|canonical_visit|jobs|lifecycle_authority_grants)/i
  );
});

test("plan identity binds exact Job, Relationship, issued Quote, and APPROVED decision", () => {
  assert.match(sql, /approved_customer_decision TEXT NOT NULL DEFAULT 'APPROVED'/i);
  assert.match(sql, /CHECK \(approved_customer_decision = 'APPROVED'\)/i);
  assert.match(sql, /approved_customer_decision_id UUID NOT NULL UNIQUE/i);
  assert.match(
    sql,
    /FOREIGN KEY \(approved_customer_decision_id, quote_id, issued_quote_version, job_id,[\s\S]*relationship_id, approved_customer_decision, source_integrity_hash, customer_participant_id\)[\s\S]*REFERENCES canonical_quote_customer_decisions/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(quote_id, issued_quote_version, job_id, commercial_currency, source_integrity_hash\)[\s\S]*REFERENCES canonical_quote_versions/i
  );
  assert.match(sql, /created_by_role = 'PRIMARY_PROFESSIONAL'/i);
});

test("plans use immutable versions, stable items, and explicit Work-start policy", () => {
  assert.match(sql, /planning_state IN \('PLANNING', 'PLANNED', 'RETIRED'\)/i);
  assert.match(sql, /work_start_policy IN \('NONE', 'REQUIRED_ITEMS_READY'\)/i);
  assert.match(sql, /required_for_work_start BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /enforce_work_preparation_plan_version_sequence/i);
  assert.match(sql, /work preparation plan versions must be contiguous/i);
  assert.doesNotMatch(sql, /purchased\s+BOOLEAN/i);
});

test("item snapshots constrain kind, responsibility, commercial treatment, and privacy", () => {
  for (const value of ["MATERIAL", "TOOL", "EQUIPMENT", "PREPARATION_TASK"]) {
    assert.match(sql, new RegExp(`'${value}'`));
  }
  for (const value of [
    "INCLUDED_IN_ACCEPTED_TOTAL",
    "SEPARATELY_ACCEPTED",
    "CUSTOMER_SUPPLIED",
    "ALLOWANCE",
    "APPROVAL_REQUIRED",
    "NOT_CUSTOMER_BILLABLE",
  ]) {
    assert.match(sql, new RegExp(`'${value}'`));
  }
  assert.match(sql, /provider_responsibility IN \('BUSINESS', 'CUSTOMER'\)/i);
  assert.match(sql, /visibility TEXT NOT NULL DEFAULT 'BUSINESS_ONLY'/i);
  assert.match(sql, /internal_estimated_cost_minor/i);
  assert.match(sql, /internal_cost_currency/i);
});

test("Quote-sourced and TOTAL_ONLY-safe operational elaboration have distinct lineage", () => {
  assert.match(sql, /source_lineage IN \('QUOTE_SCOPE_ITEM', 'ACCEPTED_SCOPE_ELABORATION'\)/i);
  assert.match(
    sql,
    /source_lineage = 'QUOTE_SCOPE_ITEM'[\s\S]*source_scope_item_id IS NOT NULL/i
  );
  assert.match(
    sql,
    /source_lineage = 'ACCEPTED_SCOPE_ELABORATION'[\s\S]*source_scope_item_id IS NULL[\s\S]*commercial_treatment IN \('NOT_CUSTOMER_BILLABLE', 'CUSTOMER_SUPPLIED'\)/i
  );
  assert.match(
    sql,
    /REFERENCES canonical_quote_scope_item_snapshots\(quote_id, quote_version, scope_item_id, job_id\)/i
  );
});

test("purchase evidence consumes exact plan items and Migration 59 deposit authority", () => {
  assert.match(sql, /deposit_gate_type IN \('NO_DEPOSIT_REQUIRED', 'SATISFIED'\)/i);
  assert.match(sql, /deposit_obligation_state = 'SATISFIED'/i);
  assert.match(
    sql,
    /REFERENCES canonical_pre_work_deposit_versions\(obligation_id, version, job_id, relationship_id, currency\)/i
  );
  assert.match(sql, /canonical_material_purchase_cost_shape_check/i);
  assert.match(sql, /enforce_canonical_material_purchase_item/i);
  assert.doesNotMatch(sql, /ALTER TABLE canonical_pre_work_deposit/i);
});

test("append-only corrections cannot exceed original purchase evidence", () => {
  assert.match(sql, /canonical_material_purchase_corrections/i);
  assert.match(sql, /reversed_quantity > 0 OR reversed_internal_cost_minor > 0/i);
  assert.match(sql, /enforce_canonical_material_purchase_correction_limit/i);
  assert.match(sql, /correction exceeds original evidence/i);
});

test("ordered events preserve distinct acquisition and preparation evidence", () => {
  for (const value of [
    "PURCHASE_RECORDED",
    "CUSTOMER_ITEM_RECEIVED",
    "MATERIAL_STAGED",
    "BUSINESS_INVENTORY_ALLOCATED",
    "TOOLS_READY",
    "EQUIPMENT_READY",
    "PREPARATION_READY",
    "PREPARATION_BLOCKED",
  ]) {
    assert.match(sql, new RegExp(`'${value}'`));
  }
  assert.match(sql, /readiness_dimension IN \('ACQUISITION', 'PREPARATION'\)/i);
  assert.match(sql, /enforce_work_preparation_event_sequence/i);
  assert.match(sql, /work preparation events must be contiguous and exact/i);
});

test("evidence references reuse governed identities and remain business-only by default", () => {
  assert.match(sql, /reference_namespace TEXT NOT NULL/i);
  assert.match(sql, /reference_id TEXT NOT NULL/i);
  assert.match(sql, /PURCHASE_RECEIPT/i);
  assert.match(sql, /VENDOR_INVOICE/i);
  assert.match(sql, /CHECK \(num_nonnulls\(purchase_id, purchase_correction_id, event_id\) = 1\)/i);
  assert.match(sql, /UNIQUE \(plan_id, evidence_type, reference_namespace, reference_id\)/i);
  assert.doesNotMatch(sql, /business_document_draft_media/i);
});

test("commands, capabilities, and history use bounded existing authority patterns", () => {
  assert.match(sql, /canonical_work_preparation_command_replay_key/i);
  assert.match(sql, /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  for (const capability of [
    "work_preparation.plan.read",
    "work_preparation.plan.write",
    "work_preparation.purchase.record",
    "work_preparation.preparation.record",
    "work_preparation.read_customer",
  ]) {
    assert.match(sql, new RegExp(capability.replaceAll(".", "\\.")));
  }
  assert.match(sql, /prevent_lifecycle_append_only_mutation\(\)/i);
  assert.doesNotMatch(sql, /INSERT INTO lifecycle_authority_grants/i);
});

test("README records Migration 60 as schema-only Work Preparation authority", () => {
  const readme = readFileSync(join(migrationsDirectory, "README.md"), "utf8");
  assert.match(readme, /60\. `202608280002_create_canonical_materials_work_preparation_authority\.sql`/);
  assert.match(readme, /creates no Job-scoped business\s+rows/i);
  assert.match(readme, /does not invent Quote detail for TOTAL_ONLY pricing/i);
});
