"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const sql = readFileSync(
  "migrations/202609160005_create_existing_customer_request_conversation_authority.sql",
  "utf8"
);

test("existing-customer conversations explicitly require null Request Selection", () => {
  assert.match(
    sql,
    /relationship_record\.ordinary_authority_source =\s*'existing_customer_request'/i
  );

  assert.match(
    sql,
    /IF NEW\.request_selection_id IS NOT NULL[\s\S]*Existing Customer conversation authority is incomplete/i
  );
});

test("existing-customer conversation authority derives from its new request relationship and post", () => {
  assert.match(
    sql,
    /request_record\.request_origin <>\s*'existing_customer_request'/i
  );

  assert.match(
    sql,
    /request_record\.user_id <>\s*relationship_record\.homeowner_id/i
  );

  assert.match(
    sql,
    /request_record\.target_contractor_profile_id <>\s*relationship_record\.contractor_id/i
  );

  assert.match(
    sql,
    /request_record\.target_professional_user_id <>\s*relationship_record\.professional_user_id/i
  );

  assert.match(
    sql,
    /request_record\.source_meetro_relationship_id <>\s*relationship_record\.source_meetro_relationship_id/i
  );
});

test("marketplace canonical selection authority remains intact", () => {
  assert.match(
    sql,
    /New ordinary conversations require canonical selection authority/i
  );

  assert.match(
    sql,
    /conversation_record\.request_selection_id <>\s*selection_record\.id/i
  );

  assert.match(
    sql,
    /relationship_record\.professional_response_id <>\s*selection_record\.professional_response_id/i
  );
});

test("Emergency conversations remain selection-free", () => {
  assert.match(
    sql,
    /relationship_record\.emergency_request_id IS NOT NULL[\s\S]*Emergency conversations cannot use ordinary selection authority/i
  );
});

test("migration creates no fake Professional Response Selection or Job", () => {
  assert.doesNotMatch(
    sql,
    /INSERT INTO professional_responses/i
  );

  assert.doesNotMatch(
    sql,
    /INSERT INTO request_selections/i
  );

  assert.doesNotMatch(
    sql,
    /INSERT INTO jobs/i
  );
});
