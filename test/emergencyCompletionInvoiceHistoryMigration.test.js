"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const read = name => readFileSync(join(__dirname, "..", "migrations", name), "utf8");
const sql = read("202609190004_generalize_emergency_completion_invoice_history.sql");
const previous = read("202609160015_generalize_invoice_job_origins.sql");
const body = (text, name) => text.slice(text.indexOf(name), text.indexOf("$$;", text.indexOf(name)) + 3);

test("104 keeps certified migrations 101, 102, 103 byte-for-byte frozen", () => {
  for (const [name, hash] of [
    ["202609190001_create_emergency_job_foundation.sql", "4f68f95499f006761445db7001b646deb9379f580cc6ff5bbc9b41b17e416f55"],
    ["202609190002_generalize_emergency_job_evaluation_quote.sql", "0644836aca0bc7ca34856b4cd77f8d65de4b3fd5712fa6044902aa74489a6d84"],
    ["202609190003_generalize_emergency_pre_work_authority.sql", "2706a13c9fe418383b67d7e1d56cea4ab181b81c11d2e1feff9003bc2f1fbf8a"],
  ]) assert.equal(createHash("sha256").update(read(name)).digest("hex"), hash);
});
test("104 adds no tables, business-row writes, grant expansion or FK changes", () => {
  assert.doesNotMatch(sql, /\b(?:CREATE TABLE|DROP TABLE|INSERT INTO|DELETE FROM|UPDATE\s+(?:jobs|canonical_\w+|emergency_requests)|GRANT)\b/i);
  assert.doesNotMatch(sql, /DROP CONSTRAINT\s+\w*(?:fk|fkey)\b/i);
  assert.match(sql, /CHECK \(workstream_count >= 0\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON canonical_job_completion_records/);
});
test("104 validates historical completion and preserves positive counts for four prior origins", () => {
  const guard = body(sql, "assert_canonical_job_completion_origin()");
  for (const origin of ["ordinary_request_selection", "existing_customer_request", "business_document", "business_customer"]) assert.ok(guard.includes(origin));
  assert.match(guard, /NEW.workstream_count <> 0/);
  assert.match(guard, /NEW.workstream_count <= 0/);
  const historical = sql.slice(sql.indexOf("-- Historical validation"), sql.indexOf("assert_canonical_invoice_job_origin()"));
  for (const part of [guard, historical, body(sql, "assert_canonical_invoice_job_origin()")]) {
    for (const predicate of ["emergency_job.lifecycle_contract_version = 2", "emergency_job.job_request_id IS NULL",
      "emergency_job.source_request_selection_id IS NULL", "emergency_job.source_emergency_request_id IS NOT NULL",
      "relationship.id = emergency_job.source_request_relationship_id", "relationship.emergency_request_id = emergency.id",
      "relationship.post_id IS NULL", "relationship.homeowner_id = emergency.homeowner_id",
      "profile.user_id = relationship.professional_user_id", "professional.source_evidence_type = 'emergency_selection'",
      "customer.source_evidence_type = 'emergency_selection'", "emergency_job.originating_business_document_id IS NULL",
      "emergency_job.business_contact_id IS NULL", "emergency_job.business_customer_relationship_id IS NULL",
      "emergency_job.source_business_customer_job_id IS NULL"]) assert.ok(part.includes(predicate), predicate);
  }
  assert.match(historical, /Historical canonical Job completion origin mismatch/);
});
test("104 preserves all four prior Invoice branches exactly", () => {
  const before = body(previous, "assert_canonical_invoice_job_origin()");
  const after = body(sql, "assert_canonical_invoice_job_origin()");
  assert.equal(after.slice(0, after.indexOf("  ELSIF job.source_type = 'emergency_request'")),
    before.slice(0, before.indexOf("  ELSE\n")));
  assert.match(after, /professional.id = NEW.issuer_participant_id/);
  assert.match(after, /NEW.relationship_id IS DISTINCT FROM job.source_request_relationship_id/);
});
test("104 adds only Emergency Meetro approval mapping, preserving exact approval identity checks", () => {
  assert.equal(body(sql, "assert_business_invoice_line_approval()").replace("'existing_customer_request',\n    'emergency_request'", "'existing_customer_request'"),
    body(previous, "assert_business_invoice_line_approval()"));
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION\s+assert_external_invoice_issuance_origin/);
});
