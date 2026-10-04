"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const service = require("../server/authorization/recommendationService");

const UUID = "00000000-0000-4000-8000-000000000001";

test("Recommendation constants expose only bounded capabilities and states", () => {
  assert.deepEqual(Object.values(service.RECOMMENDATION_CAPABILITIES), [
    "recommendation.create",
    "recommendation.read",
    "recommendation.transition",
    "customer_constraint.record",
  ]);
  assert.equal(service.RECOMMENDATION_STATUSES.includes("ACTIVE"), true);
  assert.equal(service.RECOMMENDATION_STATUSES.includes("DEFERRED"), true);
  assert.equal(service.RECOMMENDATION_STATUSES.includes("EXCLUDED_FROM_CURRENT_QUOTE"), true);
  assert.equal(service.RECOMMENDATION_STATUSES.some((status) => /APPROVED|PAID/.test(status)), false);
  assert.deepEqual(Object.values(service.RECOMMENDATION_COMMANDS), [
    "recommendation.create",
    "recommendation.update",
    "recommendation.transition",
    "customer_constraint.record",
  ]);
});

test("Recommendation commands reject invalid lineage and server-owned scope", async () => {
  const pool = { query() { throw new Error("database should not be reached"); } };
  assert.equal((await service.createRecommendation({
    pool,
    authenticatedActor: { id: 1 },
    findingId: UUID,
    kind: "ALTERNATIVE",
    statement: "Alternative",
    idempotencyKey: "key",
  })).code, "INVALID_RECOMMENDATION_LINEAGE");
  assert.equal((await service.createRecommendation({
    pool,
    authenticatedActor: { id: 1 },
    findingId: UUID,
    jobId: UUID,
    kind: "PRIMARY",
    statement: "Primary",
    idempotencyKey: "key",
  })).code, "RECOMMENDATION_AUTHORITY_FIELD_REJECTED");
  assert.equal((await service.transitionRecommendation({
    pool,
    authenticatedActor: { id: 1 },
    recommendationId: UUID,
    expectedVersion: 1,
    targetStatus: "SUPERSEDED",
    idempotencyKey: "key",
  })).code, "INVALID_RECOMMENDATION_REPLACEMENT");
  assert.equal((await service.updateRecommendation({
    pool,
    authenticatedActor: { id: 1 },
    recommendationId: UUID,
    expectedVersion: 0,
    statement: "Updated recommendation",
    idempotencyKey: "key",
  })).code, "INVALID_RECOMMENDATION_UPDATE");
});

test("service source creates no Quote, procurement, scheduling, or Job-completion authority", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "authorization", "recommendationService.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /quote\.(?:issue|approve)|procurement\.|scheduling\.|job\.complete/i);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:jobs|canonical_workstreams|canonical_evaluation_finding_versions|canonical_quotes|quotes)\b/i);
  assert.doesNotMatch(source, /UPDATE\s+canonical_recommendation_versions/i);
  const logCalls = source.match(/logger\.(?:info|warn)\([\s\S]*?\n\s*\}\)/g) || [];
  assert.ok(logCalls.length > 0);
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\b(?:statement|decisionEvidenceNote)\b/);
  }
});
