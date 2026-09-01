"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationName = "202608230004_create_business_contact_foundation.sql";
const migrationsDirectory = join(__dirname, "..", "migrations");
const sql = readFileSync(join(migrationsDirectory, migrationName), "utf8");
const serviceSource = readFileSync(
  join(__dirname, "..", "server", "contacts", "businessContactService.js"),
  "utf8"
);

test("business Contact foundation is the 53rd additive migration", () => {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608310001_create_business_job_customer_message_authority.sql");
  assert.equal(migrations.at(-24), "202608230003_create_canonical_quote_business_document_sources.sql");
  assert.equal(migrations.at(-23), migrationName);
});

test("Contact identity is a stable business-owned UUID with explicit party and lifecycle state", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_contacts/);
  assert.match(sql, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  assert.match(sql, /party_type TEXT NOT NULL CHECK \(party_type IN \('PERSON', 'ORGANIZATION'\)\)/);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'ACTIVE'[\s\S]*'ACTIVE', 'ARCHIVED'/);
  assert.match(sql, /version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/);
  assert.match(sql, /FOREIGN KEY \(contractor_profile_id, created_by_user_id\)[\s\S]*REFERENCES contractor_profiles\(id, user_id\)[\s\S]*ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE \(id, contractor_profile_id\)/);
});

test("Contact information and business-private note are bounded and independently stored", () => {
  for (const column of [
    "display_name", "company_name", "email", "phone", "address_text",
    "service_area_text", "private_note",
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`));
  assert.match(sql, /email_normalized TEXT GENERATED ALWAYS AS/);
  assert.match(sql, /phone_normalized TEXT GENERATED ALWAYS AS/);
  assert.match(sql, /private_note[\s\S]*8000/);
  assert.match(sql, /Business-private note; never automatically projected into customer-facing documents/);
});

test("duplicate detection is owner-scoped candidate indexing and not automatic merge or global uniqueness", () => {
  assert.match(sql, /business_contacts_owner_email_candidate_idx[\s\S]*contractor_profile_id, email_normalized/);
  assert.match(sql, /business_contacts_owner_phone_candidate_idx[\s\S]*contractor_profile_id, phone_normalized/);
  assert.doesNotMatch(sql, /UNIQUE[^;]*(?:email_normalized|phone_normalized)/i);
  assert.doesNotMatch(sql, /\bMERGE\b/i);
});

test("Contact roles are multi-valued classifications with durable governed end history", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_contact_roles/);
  for (const role of [
    "CUSTOMER", "PROFESSIONAL_VENDOR", "EMPLOYEE", "TENANT", "PROPERTY_MANAGER",
  ]) assert.match(sql, new RegExp(`'${role}'`));
  assert.match(sql, /business_contact_roles_one_active_role_idx[\s\S]*business_contact_id, role[\s\S]*WHERE ended_at IS NULL/);
  assert.match(sql, /business_contact_roles_contact_owner_fkey[\s\S]*FOREIGN KEY \(business_contact_id, contractor_profile_id\)/);
  assert.match(sql, /assigned_at TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /ended_at TIMESTAMPTZ NULL/);
  assert.match(sql, /append-only except for one governed end transition/);
});

test("Contact mutations use exact idempotency and optimistic version safeguards", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS business_contact_commands/);
  assert.match(sql, /operation IN \('CREATE', 'UPDATE', 'ASSIGN_ROLE', 'END_ROLE', 'ARCHIVE'\)/);
  assert.match(sql, /idempotency_key UUID NOT NULL/);
  assert.match(sql, /request_hash TEXT NOT NULL CHECK \(request_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /UNIQUE \(actor_user_id, operation, idempotency_key\)/);
  assert.match(sql, /Business Contact updates require the next version/);
});

test("archive and role history preserve Contact identity instead of deleting it", () => {
  assert.match(sql, /business_contacts_history_guard/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON business_contacts/);
  assert.match(sql, /Business Contact identity is archived, not deleted/);
  assert.match(sql, /Business Contact identity and ownership are immutable/);
  assert.match(sql, /business_contact_roles_history_guard/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON business_contact_roles/);
});

test("migration creates no user, relationship, Job, Quote, payment, scheduling, or lifecycle authority", () => {
  assert.doesNotMatch(sql, /INSERT INTO\s+users/i);
  assert.doesNotMatch(sql, /(?:ALTER|INSERT INTO|UPDATE|DELETE FROM)\s+(?:request_relationships|request_selections|relationship_participants|jobs|canonical_quotes|canonical_quote_customer_decisions|canonical_invoices|payments|canonical_visits|properties|moments|customer_relationships)/i);
  assert.doesNotMatch(sql, /meetro_(?:conversation_registry|contacts_)/i);
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|TRUNCATE)\b/im);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(sql, /No Meetro user, participant, Conversation, Job, Quote, payment, scheduling, or lifecycle authority is implied/);
});

test("runtime Contact service writes only the Contact foundation and exposes no account-link field", () => {
  for (const table of ["business_contacts", "business_contact_roles", "business_contact_commands"]) {
    assert.match(serviceSource, new RegExp(`(?:INSERT INTO|UPDATE|DELETE FROM) ${table}`));
  }
  assert.doesNotMatch(
    serviceSource,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:users|request_relationships|request_selections|relationship_participants|jobs|canonical_quotes|canonical_quote_customer_decisions|canonical_invoices|payments|canonical_visits|properties|moments|customer_relationships)/i
  );
  assert.doesNotMatch(serviceSource, /(?:linkedUserId|linked_user_id|meetroUserId|meetro_user_id)/);
});
