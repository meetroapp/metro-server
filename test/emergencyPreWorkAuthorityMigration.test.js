"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const filename = "202609190003_generalize_emergency_pre_work_authority.sql";
const read = name => readFileSync(join(__dirname, "..", "migrations", name), "utf8");
const sql = read(filename);
const previous = read("202609160012_generalize_pre_work_deposit_job_origins.sql");

test("103 leaves certified migrations 101 and 102 byte-for-byte intact", () => {
  for (const [name, hash] of [
    ["202609190001_create_emergency_job_foundation.sql", "4f68f95499f006761445db7001b646deb9379f580cc6ff5bbc9b41b17e416f55"],
    ["202609190002_generalize_emergency_job_evaluation_quote.sql", "0644836aca0bc7ca34856b4cd77f8d65de4b3fd5712fa6044902aa74489a6d84"],
  ]) assert.equal(createHash("sha256").update(read(name)).digest("hex"), hash);
});
test("103 retains exact ordinary/repeat and external trigger branches", () => {
  for (const fn of ["assert_pre_work_deposit_obligation_job_origin", "assert_pre_work_payment_relationship_job_origin"]) {
    const oldBody = previous.slice(previous.indexOf(fn));
    const newBody = sql.slice(sql.indexOf(fn));
    assert.equal(newBody.slice(newBody.indexOf("  IF v_source_type IN"), newBody.indexOf("  ELSIF v_source_type = 'emergency_request'")),
      oldBody.slice(oldBody.indexOf("  IF v_source_type IN"), oldBody.indexOf("  ELSE\n    RAISE EXCEPTION")));
  }
});
test("103 uses explicit three-way source shape and authoritative exact Emergency origin guards", () => {
  const shape = sql.slice(0, sql.indexOf("-- Five-path"));
  assert.match(shape, /MEETRO_CUSTOMER'[\s\S]*job_request_id IS NOT NULL/);
  assert.match(shape, /OR\s*\(approval_source = 'MEETRO_CUSTOMER'\s*AND job_request_id IS NULL/);
  assert.match(shape, /EXTERNAL_EVIDENCE'[\s\S]*relationship_id IS NULL[\s\S]*customer_participant_id IS NULL/);
  for (const predicate of ["emergency_job.source_request_selection_id IS NULL", "emergency_job.job_request_id IS NULL",
    "emergency_job.source_emergency_request_id IS NOT NULL", "relationship.post_id IS NULL", "relationship.status = 'active'",
    "relationship.homeowner_id = emergency.homeowner_id", "profile.user_id = relationship.professional_user_id",
    "NEW.relationship_id = emergency_job.source_request_relationship_id", "NEW.approval_source IS DISTINCT FROM 'MEETRO_CUSTOMER'"]) {
    assert.ok(sql.includes(predicate), predicate);
  }
});
test("103 historical verifier recognizes all five origins and writes no data or parallel tables", () => {
  for (const origin of ["ordinary_request_selection", "existing_customer_request", "business_document", "business_customer", "emergency_request"]) {
    assert.ok(sql.includes(origin));
  }
  for (const table of ["canonical_pre_work_deposit_obligations", "canonical_pre_work_deposit_versions", "canonical_pre_work_payment_receipts", "canonical_pre_work_payment_allocations", "canonical_pre_work_payment_allocation_reversals"]) {
    assert.ok(sql.slice(sql.indexOf("-- Historical Emergency validation")).includes(table));
  }
  assert.match(sql, /Historical Emergency pre-work relationship provenance is invalid/);
  assert.doesNotMatch(sql, /\b(?:INSERT INTO|UPDATE\s+canonical|DELETE FROM|CREATE TABLE|DROP TABLE)\b/i);
  assert.doesNotMatch(sql, /DROP CONSTRAINT\s+\w*(?:fk|fkey)\b/i);
});
