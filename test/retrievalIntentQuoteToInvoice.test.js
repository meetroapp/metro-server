"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseRetrievalIntent,
} = require("../server/intelligence/retrievalIntent");

for (const [message, expectedName] of [
  [
    "Create invoice from Quote Q0000049",
    "",
  ],
  [
    "Create invoice for Bob Hamel job quote number Q0000049",
    "bob hamel",
  ],
  [
    "Prepare an invoice from Quote Q-0000049",
    "",
  ],
]) {
  test(`Quote-to-Invoice resolves source Quote first: ${message}`, () => {
    const intent = parseRetrievalIntent(message);

    assert.equal(intent.type, "QUOTE");
    assert.equal(intent.kind, "INVOICE");
    assert.equal(intent.number, "Q0000049");
    assert.equal(intent.name, expectedName);
    assert.equal(intent.operational, true);
    assert.equal(intent.mixed, false);
    assert.equal(intent.requiresRecord, true);
  });
}

test("ordinary Invoice lookup remains Invoice authority", () => {
  const intent = parseRetrievalIntent(
    "What is Invoice I-0000049?"
  );

  assert.equal(intent.type, "INVOICE");
  assert.equal(intent.kind, "INVOICE");
  assert.equal(intent.number, "I0000049");
  assert.equal(intent.operational, false);
  assert.equal(intent.requiresRecord, true);
});
