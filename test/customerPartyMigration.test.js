"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationName =
  "202608240001_create_customer_party_linkage_foundation.sql";
const migrationsDirectory = join(__dirname, "..", "migrations");
const sql = readFileSync(join(migrationsDirectory, migrationName), "utf8");

test("customer-party linkage remains the 55th additive migration", () => {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal(migrations.length, 56);
  assert.equal(
    migrations.at(-3),
    "202608230005_create_business_customer_relationship_foundation.sql"
  );
  assert.equal(migrations.at(-2), migrationName);
  assert.equal(
    migrations.at(-1),
    "202608250001_correct_evaluation_visit_authority_and_negotiation.sql"
  );
});

test("working documents receive nullable owner-consistent Contact and Relationship references", () => {
  assert.match(sql, /ALTER TABLE business_document_working_drafts[\s\S]*ADD COLUMN IF NOT EXISTS business_contact_id UUID[\s\S]*ADD COLUMN IF NOT EXISTS business_customer_relationship_id UUID/);
  assert.match(sql, /business_document_working_drafts_customer_party_shape_check[\s\S]*business_contact_id IS NULL[\s\S]*business_customer_relationship_id IS NULL[\s\S]*business_contact_id IS NOT NULL[\s\S]*business_customer_relationship_id IS NOT NULL/);
  assert.match(sql, /business_document_working_drafts_contact_owner_fkey[\s\S]*FOREIGN KEY \(business_contact_id, contractor_profile_id\)[\s\S]*REFERENCES business_contacts\(id, contractor_profile_id\)/);
  assert.match(sql, /business_document_working_drafts_relationship_party_fkey[\s\S]*FOREIGN KEY \([\s\S]*business_customer_relationship_id,[\s\S]*contractor_profile_id,[\s\S]*business_contact_id[\s\S]*REFERENCES business_customer_relationships\([\s\S]*id,[\s\S]*contractor_profile_id,[\s\S]*business_contact_id/);
});

test("canonical Job, Quote, and Invoice links are entity-specific and referentially safe", () => {
  for (const table of [
    "job_customer_parties",
    "canonical_quote_customer_parties",
    "canonical_invoice_customer_parties",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(sql, new RegExp(`${table}[\\s\\S]*business_contact_id UUID NOT NULL`));
    assert.match(sql, new RegExp(`${table}[\\s\\S]*business_customer_relationship_id UUID NOT NULL`));
    assert.match(sql, new RegExp(`${table}[\\s\\S]*REFERENCES business_contacts\\(id, contractor_profile_id\\)`));
    assert.match(sql, new RegExp(`${table}[\\s\\S]*REFERENCES business_customer_relationships\\([\\s\\S]*id,[\\s\\S]*contractor_profile_id,[\\s\\S]*business_contact_id`));
  }
  assert.match(sql, /job_id UUID PRIMARY KEY REFERENCES jobs\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /canonical_quote_customer_parties_quote_fkey[\s\S]*FOREIGN KEY \(quote_id, job_id\)[\s\S]*REFERENCES canonical_quotes\(id, job_id\)/);
  assert.match(sql, /canonical_invoice_customer_parties_invoice_fkey[\s\S]*FOREIGN KEY \(invoice_id, job_id\)[\s\S]*REFERENCES canonical_invoices\(id, job_id\)/);
  assert.doesNotMatch(sql, /entity_type\s+TEXT[\s\S]*entity_id/i);
});

test("Job linkage is explicit, idempotent, business-owned, and append-only", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS job_customer_party_commands/);
  assert.match(sql, /operation TEXT NOT NULL CHECK \(operation = 'LINK'\)/);
  assert.match(sql, /UNIQUE \(actor_user_id, operation, idempotency_key\)/);
  assert.match(sql, /request_hash TEXT NOT NULL CHECK \(request_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /assert_customer_party_job_business_owner[\s\S]*request_relationships\.contractor_id = NEW\.contractor_profile_id/);
  for (const table of [
    "job_customer_parties",
    "canonical_quote_customer_parties",
    "canonical_invoice_customer_parties",
  ]) {
    assert.match(sql, new RegExp(`${table}_append_only[\\s\\S]*BEFORE UPDATE OR DELETE ON ${table}`));
  }
});

test("Invoice provenance is constrained to its Job or a same-Job canonical Quote", () => {
  assert.match(sql, /source_type TEXT NOT NULL CHECK \(source_type IN \('JOB', 'CANONICAL_QUOTE'\)\)/);
  assert.match(sql, /canonical_invoice_customer_parties_source_quote_fkey[\s\S]*FOREIGN KEY \(source_quote_id, job_id\)[\s\S]*REFERENCES canonical_quotes\(id, job_id\)/);
  assert.match(sql, /source_type = 'JOB' AND source_quote_id IS NULL/);
  assert.match(sql, /source_type = 'CANONICAL_QUOTE' AND source_quote_id IS NOT NULL/);
});

test("migration performs no identity inference, data backfill, or authority mutation", () => {
  assert.doesNotMatch(sql, /\b(email|phone|customer_name)\b\s*=/i);
  assert.doesNotMatch(sql, /INSERT INTO\s+(business_contacts|business_customer_relationships|users|request_relationships|conversations|canonical_quotes|canonical_invoices|payments|visits)\b/i);
  assert.doesNotMatch(sql, /UPDATE\s+(business_contacts|business_customer_relationships|request_relationships|canonical_quotes|canonical_invoices|jobs)\b/i);
  assert.doesNotMatch(sql, /DELETE FROM\s+(business_contacts|business_customer_relationships|request_relationships|canonical_quotes|canonical_invoices|jobs)\b/i);
});
