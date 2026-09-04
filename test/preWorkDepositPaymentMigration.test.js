"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationsDirectory = join(__dirname, "..", "migrations");
const migration58Name =
  "202608270001_add_canonical_visit_start_authority.sql";
const migration59Name =
  "202608280001_create_pre_work_deposit_payment_authority.sql";
const migration60Name =
  "202608280002_create_canonical_materials_work_preparation_authority.sql";
const sql = readFileSync(join(migrationsDirectory, migration59Name), "utf8");

test("migration 59 remains frozen between Visit Start and Materials authority", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations[74]?.filename || migrations[74]), "202608310001_create_business_job_customer_message_authority.sql");
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202609040001_add_evaluation_revision_authority.sql");
  assert.deepEqual(
    migrations.slice(57, 60).map(({ filename }) => filename),
    [migration58Name, migration59Name, migration60Name]
  );
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test("migration 59 creates only the bounded pre-work financial foundation", () => {
  for (const table of [
    "canonical_pre_work_deposit_obligations",
    "canonical_pre_work_deposit_versions",
    "canonical_pre_work_payment_receipts",
    "canonical_pre_work_payment_allocations",
    "canonical_pre_work_payment_allocation_reversals",
    "canonical_pre_work_deposit_events",
    "canonical_pre_work_payment_command_idempotency",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }
  assert.doesNotMatch(
    sql,
    /^\s*(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+)/im
  );
  assert.doesNotMatch(
    sql,
    /INSERT INTO (?:canonical_pre_work_|canonical_visits|canonical_visit_versions|canonical_visit_events|canonical_invoices|canonical_invoice_payments|lifecycle_authority_grants)/i
  );
});

test("deposit identity is bound to the exact approved Quote decision and version", () => {
  assert.match(sql, /customer_decision TEXT NOT NULL DEFAULT 'APPROVED'/i);
  assert.match(sql, /CHECK \(customer_decision = 'APPROVED'\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*customer_decision_id,[\s\S]*quote_id,[\s\S]*issued_quote_version,[\s\S]*job_id,[\s\S]*relationship_id,[\s\S]*customer_decision,[\s\S]*source_integrity_hash,[\s\S]*customer_participant_id[\s\S]*REFERENCES canonical_quote_customer_decisions/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(quote_id, issued_quote_version, job_id\)[\s\S]*REFERENCES canonical_quote_versions\(quote_id, version, job_id\)/i
  );
  assert.match(sql, /customer_decision_id UUID NOT NULL UNIQUE/i);
  assert.match(sql, /obligation_type = 'PRE_WORK_DEPOSIT'/i);
});

test("deposit rules and immutable versions preserve exact financial invariants", () => {
  assert.match(sql, /deposit_rule_type IN \('PERCENT', 'FIXED'\)/i);
  assert.match(sql, /deposit_percent_basis_points BETWEEN 1 AND 10000/i);
  assert.match(sql, /deposit_fixed_minor = required_minor/i);
  assert.match(sql, /required_minor > 0 AND required_minor <= quote_total_minor/i);
  assert.match(sql, /required_minor = applied_minor \+ remaining_minor/i);
  for (const state of [
    "DUE",
    "PARTIALLY_SATISFIED",
    "SATISFIED",
    "SUPERSEDED",
    "VOIDED",
  ]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }
});

test("receipt methods remain extensible while evidence provenance is bounded", () => {
  assert.match(sql, /evidence_source IN \('MANUAL_EXTERNAL', 'PROCESSOR'\)/i);
  assert.match(sql, /normalized_method ~ '\^\[A-Z\]\[A-Z0-9_\]\{0,63\}\$'/i);
  assert.match(sql, /display_method TEXT/i);
  assert.doesNotMatch(
    sql,
    /normalized_method IN \('CASH'|method IN \('CASH', 'CHECK'/i
  );
  assert.match(
    sql,
    /evidence_source = 'MANUAL_EXTERNAL'[\s\S]*recorded_by_participant_id IS NOT NULL/i
  );
  assert.match(
    sql,
    /evidence_source = 'PROCESSOR'[\s\S]*external_reference IS NOT NULL/i
  );
});

test("only explicit exact-scope allocations and append-only reversals affect deposits", () => {
  assert.match(
    sql,
    /FOREIGN KEY \(receipt_id, job_id, relationship_id, currency\)[\s\S]*REFERENCES canonical_pre_work_payment_receipts/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(obligation_id, job_id, relationship_id, currency\)[\s\S]*REFERENCES canonical_pre_work_deposit_obligations/i
  );
  assert.match(sql, /reversal_effect IN \('DEALLOCATE', 'RECEIPT_REVERSAL'\)/i);
  assert.match(sql, /reason_category IN \('REFUND', 'REVERSAL', 'CORRECTION', 'CHARGEBACK'\)/i);
  assert.match(sql, /'canonical_pre_work_payment_allocation_reversals'/i);
  assert.match(sql, /table_name \|\| '_append_only'/i);
});

test("idempotency supports participant and future processor principals", () => {
  assert.match(sql, /actor_type IN \('PARTICIPANT', 'PROCESSOR'\)/i);
  assert.match(sql, /canonical_pre_work_payment_command_participant_key/i);
  assert.match(sql, /canonical_pre_work_payment_command_processor_key/i);
  assert.match(sql, /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  for (const command of [
    "deposit.materialize",
    "deposit.payment.record",
    "deposit.payment.allocate",
    "deposit.payment.reverse",
  ]) {
    assert.match(sql, new RegExp(`'${command.replace(".", "\\.")}'`));
  }
});

test("migration 59 reuses canonical append-only protection and leaves adjacent schemas untouched", () => {
  assert.match(sql, /prevent_lifecycle_append_only_mutation\(\)/i);
  assert.doesNotMatch(sql, /ALTER TABLE canonical_(?:quotes|quote_versions|invoices|invoice_payments|visits|visit_versions|visit_events)/i);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS canonical_invoice/i);
  assert.doesNotMatch(sql, /INSERT INTO lifecycle_capabilities/i);
});

test("README records migration 59 as schema-only financial authority", () => {
  const readme = readFileSync(join(migrationsDirectory, "README.md"), "utf8");
  assert.match(
    readme,
    /59\. `202608280001_create_pre_work_deposit_payment_authority\.sql`/
  );
  assert.match(readme, /manual-external\/future-processor receipt evidence/i);
  assert.match(readme, /performs no backfill/i);
});
