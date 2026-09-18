"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  "202609160001_create_meetro_customer_business_relationship_foundation.sql"
);

const sql = fs.readFileSync(migrationPath, "utf8");

test("creates an exact durable homeowner-professional Meetro relationship", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS meetro_customer_business_relationships/
  );

  for (const field of [
    "homeowner_user_id",
    "contractor_profile_id",
    "professional_user_id",
    "established_from_request_selection_id",
  ]) {
    assert.match(sql, new RegExp(`\\b${field}\\b`));
  }

  assert.match(
    sql,
    /UNIQUE\s*\(\s*homeowner_user_id,\s*contractor_profile_id\s*\)/s
  );

  assert.match(
    sql,
    /FOREIGN KEY\s*\(\s*contractor_profile_id,\s*professional_user_id\s*\)[\s\S]*REFERENCES contractor_profiles\s*\(\s*id,\s*user_id\s*\)/s
  );

  assert.doesNotMatch(sql, /\bbusiness_contact_id\b/);
  assert.doesNotMatch(sql, /\bbusiness_customer_relationship_id\b/);
  assert.doesNotMatch(sql, /\bjob_customer_parties\b/);
});

test("requires exact canonical Request Selection provenance", () => {
  assert.match(sql, /FROM request_selections selections/);

  assert.match(
    sql,
    /selections\.id\s*=\s*NEW\.established_from_request_selection_id/s
  );

  assert.match(
    sql,
    /selections\.selected_by_user_id\s*=\s*NEW\.homeowner_user_id/s
  );

  assert.match(
    sql,
    /selections\.contractor_id\s*=\s*NEW\.contractor_profile_id/s
  );

  assert.match(
    sql,
    /selections\.professional_user_id\s*=\s*NEW\.professional_user_id/s
  );

  assert.doesNotMatch(sql, /JOIN\s+jobs\b/i);
  assert.doesNotMatch(sql, /\bjob_customer_parties\b/);
});

test("historical selection remains valid relationship provenance", () => {
  assert.doesNotMatch(
    sql,
    /selections\.ended_at\s+IS\s+NULL/i
  );

  assert.doesNotMatch(
    sql,
    /selections\.ended_at\s+IS\s+NOT\s+NULL/i
  );
});

test("historical Request Selections backfill durable relationships deterministically", () => {
  assert.match(
    sql,
    /WITH establishing_selections AS/
  );

  assert.match(
    sql,
    /SELECT DISTINCT ON\s*\(\s*selections\.selected_by_user_id,\s*selections\.contractor_id\s*\)/s
  );

  assert.match(
    sql,
    /ORDER BY\s*selections\.selected_by_user_id,\s*selections\.contractor_id,\s*selections\.selected_at ASC,\s*selections\.id ASC/s
  );

  assert.match(
    sql,
    /INSERT INTO meetro_customer_business_relationships\s*\(\s*homeowner_user_id,\s*contractor_profile_id,\s*professional_user_id,\s*established_from_request_selection_id\s*\)/s
  );

  assert.match(
    sql,
    /ON CONFLICT ON CONSTRAINT\s*meetro_customer_business_relationships_homeowner_business_key\s*DO NOTHING/s
  );
});

test("historical projection fails closed on homeowner-business professional identity ambiguity", () => {
  assert.match(
    sql,
    /HAVING COUNT\(DISTINCT selections\.professional_user_id\) > 1/
  );

  assert.match(
    sql,
    /Historical Request Selection identity conflict prevents Meetro relationship projection/
  );

  assert.match(
    sql,
    /Existing Meetro relationship conflicts with canonical Request Selection identity/
  );
});

test("historical backfill includes ended selections and requires no Job", () => {
  assert.doesNotMatch(
    sql,
    /establishing_selections[\s\S]*ended_at\s+IS\s+NULL/i
  );

  assert.doesNotMatch(
    sql,
    /establishing_selections[\s\S]*JOIN\s+jobs\b/i
  );
});

test("does not fabricate marketplace, business-contact, or lifecycle authority", () => {
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+request_relationships/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+professional_responses/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+request_selections/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+conversations/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+jobs/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+business_contacts/i);

  assert.doesNotMatch(
    sql,
    /ALTER\s+TABLE\s+business_contacts[\s\S]*ADD\s+COLUMN[\s\S]*user_id/i
  );
});

test("relationship identity is immutable", () => {
  assert.match(
    sql,
    /BEFORE UPDATE OR DELETE ON meetro_customer_business_relationships/
  );

  assert.match(
    sql,
    /Meetro Customer Relationship identity is immutable/
  );
});
