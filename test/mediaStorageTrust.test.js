"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const repoRoot = join(__dirname, "..");
const serverSource = readFileSync(join(repoRoot, "index.js"), "utf8");
const packageJson = require("../package.json");
const verifierSource = readFileSync(
  join(repoRoot, "scripts", "verify-staging-trust.js"),
  "utf8"
);
const { MEDIA_TRUST } = require("../scripts/verify-staging-trust");

test("backend has no production-ready media upload or storage route", () => {
  const dependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  for (const dependency of ["multer", "busboy", "formidable"] ) {
    assert.equal(Object.hasOwn(dependencies, dependency), false);
  }
  assert.doesNotMatch(serverSource, /app\.(post|put|patch)\(["']\/media/);
  assert.doesNotMatch(serverSource, /express\.static\(["']uploads/);
  assert.doesNotMatch(serverSource, /writeFile(Sync)?\(/);
});

test("media trust remains explicitly deferred for Friends and Family", () => {
  assert.equal(MEDIA_TRUST.status, "DEFERRED_NOT_SUPPORTED");
  assert.match(MEDIA_TRUST.reason, /No production-ready backend media upload/);
  assert.match(MEDIA_TRUST.releaseNote, /deferred for Friends & Family/);
  assert.notEqual(MEDIA_TRUST.status, "PASS");
});

test("verifier does not create fake media records or infer storage trust from URL fields", () => {
  assert.doesNotMatch(verifierSource, /endpoint:\s*["']\/media/);
  assert.doesNotMatch(verifierSource, /fake media|upload succeeded/i);
  assert.match(verifierSource, /URL-reference fields are not authoritative media storage/);
});

test("deferred media status stays separate from ownership checks", () => {
  assert.match(verifierSource, /mediaTrust: \{ \.\.\.MEDIA_TRUST \}/);
  assert.doesNotMatch(verifierSource, /MEDIA_TRUST[^\n]*totals\.failed/);
  assert.match(verifierSource, /account_b_cannot_read_a_messages/);
  assert.match(verifierSource, /account_b_cannot_mutate_a_project/);
});
