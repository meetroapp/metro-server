"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const source = readFileSync(
  join(__dirname, "..", "server", "requests", "jobRequestCreateService.js"),
  "utf8"
);

test("ordinary Job Request keeps its existing default transaction and command scope", () => {
  assert.match(source, /const COMMAND_SCOPE = "ordinary";/);
  assert.match(source, /transactionClient = null/);
  assert.match(source, /transactionalAfterCreate = null/);
  assert.match(source, /const ownsTransaction = transactionClient === null/);
  assert.match(
    source,
    /if \(ownsTransaction\) \{\s*await client\.query\("BEGIN"\)/
  );
});

test("external transaction hook carries normalized request-photo cleanup candidates", () => {
  const hookPayloads = [
    ...source.matchAll(
      /await transactionalAfterCreate\(\{([\s\S]*?)\n\s*\}\);/g
    ),
  ];

  assert.equal(hookPayloads.length, 2);

  for (const [, payload] of hookPayloads) {
    assert.match(payload, /requestPhotos:\s*normalizedRequestPhotos/);
  }
});

test("external transaction hook runs before commit for create and replay", () => {
  const hookMatches = source.match(/await transactionalAfterCreate\(\{/g) || [];
  assert.equal(hookMatches.length, 2);

  const firstHook = source.indexOf("await transactionalAfterCreate({");
  const firstCommit = source.indexOf('await client.query("COMMIT")', firstHook);
  assert.ok(firstHook >= 0);
  assert.ok(firstCommit > firstHook);

  const secondHook = source.indexOf(
    "await transactionalAfterCreate({",
    firstHook + 1
  );
  const secondCommit = source.indexOf(
    'await client.query("COMMIT")',
    secondHook
  );
  assert.ok(secondHook > firstHook);
  assert.ok(secondCommit > secondHook);
});

test("caller-owned transaction client is never released by the child creator", () => {
  assert.match(
    source,
    /if \(\s*ownsTransaction &&\s*client !== pool &&\s*typeof client\.release === "function"\s*\)/
  );
});

test("existing-customer authority remains present beside the transaction extension", () => {
  assert.match(source, /resolveExistingCustomerRequestTarget/);
  assert.match(source, /establishExistingCustomerRequestConversation/);
  assert.match(source, /bootstrapExistingCustomerRequestJob/);
  assert.match(source, /request\.request_origin === "existing_customer_request"/);
});
