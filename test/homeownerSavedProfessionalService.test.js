"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "server",
    "relationships",
    "homeownerSavedProfessionalService.js"
  ),
  "utf8"
);

test("Save resolves exact contractor profile identity server-side", () => {
  assert.match(
    source,
    /FROM contractor_profiles/
  );

  assert.match(
    source,
    /WHERE id = \$1/
  );

  assert.doesNotMatch(
    source,
    /email_normalized/
  );

  assert.doesNotMatch(
    source,
    /phone_normalized/
  );
});

test("Save and Remove use authenticated homeowner identity and idempotency", () => {
  assert.match(
    source,
    /positiveInteger\(authenticatedActor\?\.id\)/
  );

  assert.match(
    source,
    /homeowner_saved_professional_commands/
  );

  assert.match(
    source,
    /idempotency_key/
  );

  assert.match(
    source,
    /request_hash/
  );

  assert.match(
    source,
    /SAVED_PROFESSIONAL_IDEMPOTENCY_CONFLICT/
  );

  assert.match(
    source,
    /SAVED_PROFESSIONAL_COMMAND_IN_PROGRESS/
  );
});

test("Save creates or restores bookmark state without relationship authority", () => {
  assert.match(
    source,
    /INSERT INTO homeowner_saved_professionals/
  );

  assert.match(
    source,
    /status = 'SAVED'/
  );

  assert.match(
    source,
    /status = 'REMOVED'/
  );

  assert.match(
    source,
    /version = version \+ 1/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO request_relationships/i
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO professional_responses/i
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO request_selections/i
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO conversations/i
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO jobs/i
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO meetro_customer_business_relationships/i
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO lifecycle_authority_grants/i
  );
});

test("Remove preserves history instead of deleting bookmark records", () => {
  assert.match(
    source,
    /HOMEOWNER_PROFESSIONAL_REMOVED/
  );

  assert.match(
    source,
    /removed_at = CURRENT_TIMESTAMP/
  );

  assert.doesNotMatch(
    source,
    /DELETE FROM homeowner_saved_professionals/i
  );
});
