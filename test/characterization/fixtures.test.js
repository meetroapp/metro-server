"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildContractorProfile } = require("../fixtures/contractorProfiles");
const { buildContractorProject } = require("../fixtures/contractorProjects");
const { buildMessage } = require("../fixtures/messages");
const { buildPost } = require("../fixtures/posts");
const { buildQuoteRequest } = require("../fixtures/quoteRequests");
const { buildReview } = require("../fixtures/reviews");
const { buildUser } = require("../fixtures/users");
const {
  createSeedShape,
  validateSanitizedFixture,
} = require("../helpers/fixtureValidation");

const fixtures = [
  buildUser(),
  buildPost(),
  buildQuoteRequest(),
  buildMessage(),
  buildContractorProfile(),
  buildContractorProject(),
  buildReview(),
];

test("all representative fixtures are sanitized", () => {
  for (const fixture of fixtures) {
    assert.deepEqual(validateSanitizedFixture(fixture), {
      valid: true,
      blockers: [],
    });
  }
});

test("fixture validation rejects production emails and secret-like values", () => {
  assert.equal(
    validateSanitizedFixture(buildUser({ email: "person@company.com" })).valid,
    false
  );
  assert.equal(
    validateSanitizedFixture({ id: 1, token: "not-allowed" }).valid,
    false
  );
  assert.equal(
    validateSanitizedFixture({
      id: 1,
      source: "postgresql://host.up.railway.app/database",
    }).valid,
    false
  );
});

test("post fixtures preserve both legacy image fields", () => {
  const post = buildPost();

  assert.ok(Object.hasOwn(post, "mage_url"));
  assert.ok(Object.hasOwn(post, "image_url"));
});

test("message fixtures preserve embedded workflow fields", () => {
  const message = buildMessage();

  assert.ok(Object.hasOwn(message, "workflow_type"));
  assert.ok(Object.hasOwn(message, "workflow_status"));
  assert.ok(Object.hasOwn(message, "workflow_payload"));
});

test("fixtures preserve current source and portfolio identity shapes", () => {
  assert.ok(Object.hasOwn(buildQuoteRequest(), "id"));
  assert.ok(Object.hasOwn(buildQuoteRequest(), "homeowner_id"));
  assert.ok(Object.hasOwn(buildContractorProject(), "id"));
  assert.ok(Object.hasOwn(buildContractorProject(), "contractor_id"));
});

test("seed shapes are inert metadata and reject unsafe fixtures", () => {
  const seedShape = createSeedShape("users", buildUser());

  assert.deepEqual(seedShape, {
    table: "users",
    record: buildUser(),
  });
  assert.equal(Object.isFrozen(seedShape), true);
  assert.throws(
    () => createSeedShape("users", { email: "real@example.com" }),
    /Unsafe fixture/
  );
});


test("message fixtures preserve legacy and canonical conversation identities", () => {
  const legacyMessage = buildMessage();

  assert.equal(legacyMessage.quote_request_id, 3001);
  assert.equal(legacyMessage.conversation_id, null);

  const canonicalMessage = buildMessage({
    conversation_id: 7001,
  });

  assert.equal(canonicalMessage.quote_request_id, 3001);
  assert.equal(canonicalMessage.conversation_id, 7001);
});
