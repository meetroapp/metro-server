"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationName = "202608230005_create_business_customer_relationship_foundation.sql";
const migrationsDirectory = join(__dirname, "..", "migrations");
const sql = readFileSync(join(migrationsDirectory, migrationName), "utf8");
const serviceSource = readFileSync(
  join(__dirname, "..", "server", "relationships", "businessCustomerRelationshipService.js"),
  "utf8"
);

test("Customer Relationship foundation is the 54th additive migration", () => {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300004_create_meetro_business_trial_authority.sql");
  assert.equal(migrations.at(-16), "202608230004_create_business_contact_foundation.sql");
  assert.equal(migrations.at(-15), migrationName);
});

test("relationship identity is a stable owner-scoped UUID for exactly one Contact", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_customer_relationships/);
  assert.match(sql, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  assert.match(sql, /business_contact_id UUID NOT NULL/);
  assert.match(sql, /version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/);
  assert.match(sql, /FOREIGN KEY \(business_contact_id, contractor_profile_id\)[\s\S]*REFERENCES business_contacts\(id, contractor_profile_id\)[\s\S]*ON DELETE RESTRICT/);
  assert.match(sql, /FOREIGN KEY \(contractor_profile_id, established_by_user_id\)[\s\S]*REFERENCES contractor_profiles\(id, user_id\)[\s\S]*ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE \(contractor_profile_id, business_contact_id\)/);
  assert.match(sql, /UNIQUE \(id, contractor_profile_id\)/);
});

test("relationship row does not duplicate mutable Contact identity or CRM automation", () => {
  const relationshipTable = sql.slice(
    sql.indexOf("CREATE TABLE IF NOT EXISTS business_customer_relationships"),
    sql.indexOf("CREATE INDEX IF NOT EXISTS business_customer_relationships_owner_created_idx")
  );
  assert.doesNotMatch(
    relationshipTable,
    /display_name|company_name|email|phone|address|private_note|contact_note/i
  );
  assert.doesNotMatch(
    relationshipTable,
    /lead_stage|prospect_stage|sales_pipeline|deal_value|conversion_probability|health_score|engagement_score|next_action|automated_follow_up|last_contact|relationship_score/i
  );
});

test("explicit establishment has an owner-bound exact idempotency ledger", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_customer_relationship_commands/);
  assert.match(sql, /operation TEXT NOT NULL CHECK \(operation = 'ESTABLISH'\)/);
  assert.match(sql, /idempotency_key UUID NOT NULL/);
  assert.match(sql, /request_hash TEXT NOT NULL CHECK \(request_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /UNIQUE \(actor_user_id, operation, idempotency_key\)/);
  assert.match(sql, /business_customer_relationship_commands_contact_owner_fkey/);
  assert.match(sql, /business_customer_relationship_commands_relationship_owner_fkey/);
});

test("Customer Relationship history cannot be deleted or re-keyed", () => {
  assert.match(sql, /business_customer_relationships_history_guard/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON business_customer_relationships/);
  assert.match(sql, /Customer Relationship history cannot be deleted/);
  assert.match(sql, /Customer Relationship identity and ownership are immutable/);
  assert.match(sql, /Customer Relationship updates require the next version/);
});

test("migration is additive with no backfill or mutation of existing authority", () => {
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|TRUNCATE)\b/im);
  assert.doesNotMatch(sql, /(?:ALTER|INSERT INTO|UPDATE|DELETE FROM)\s+(?:business_contacts|business_contact_roles|users|request_relationships|request_selections|relationship_participants|conversations|jobs|canonical_quotes|canonical_quote_customer_decisions|canonical_invoices|payments|canonical_visits|workflow_events|moments)/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(sql, /No Meetro account, marketplace request, Conversation, Job, Quote, Invoice, payment, scheduling, or lifecycle authority is implied/);
});

test("runtime writes only the new Relationship aggregate and command ledger", () => {
  assert.match(serviceSource, /INSERT INTO business_customer_relationships/);
  assert.match(serviceSource, /INSERT INTO business_customer_relationship_commands/);
  assert.match(serviceSource, /UPDATE business_customer_relationship_commands/);
  assert.doesNotMatch(
    serviceSource,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:business_contacts|business_contact_roles|users|request_relationships|request_selections|relationship_participants|conversations|jobs|canonical_quotes|canonical_quote_customer_decisions|canonical_invoices|payments|canonical_visits|workflow_events|moments)/i
  );
  assert.doesNotMatch(serviceSource, /linked_user_id|linkedUserId|meetro_user_id|meetroUserId/);
});
