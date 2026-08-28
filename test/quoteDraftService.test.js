"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const service = require("../server/authorization/quoteDraftService");

function item(overrides = {}) {
  return {
    classification: "MATERIAL",
    scopeSemantic: "MATERIAL_INCLUDED",
    materialResponsibility: "PROFESSIONAL_SUPPLIED",
    description: "Replacement material",
    quantity: 1,
    unitAmountMinor: 12000,
    source: { type: "MANUAL_PROFESSIONAL" },
    ...overrides,
  };
}

test("Quote exposes only bounded Draft, issue, customer decision, and revision capabilities", () => {
  assert.deepEqual(Object.values(service.QUOTE_CAPABILITIES), [
    "quote.create", "quote.read", "quote.scope.manage", "quote.issue",
    "quote.read_customer", "quote.approve", "quote.decline", "quote.revise",
  ]);
  assert.deepEqual(Object.values(service.QUOTE_STATUS), ["DRAFT", "ISSUED"]);
  assert.deepEqual(service.QUOTE_DECISIONS, ["APPROVED", "DECLINED"]);
  assert.deepEqual(service.QUOTE_LINEAGE_TYPES, ["REVISED_QUOTE", "SUPPLEMENTAL_QUOTE"]);
});

test("Scope validation rejects client-owned totals and invalid commercial semantics", () => {
  assert.equal(service.validateScopeItem({ ...item(), lineTotalMinor: 12000 }).error.code, "QUOTE_AUTHORITY_FIELD_REJECTED");
  assert.equal(service.validateScopeItem(item({
    scopeSemantic: "MATERIAL_INCLUDED",
    materialResponsibility: "CUSTOMER_SUPPLIED",
  })).error.code, "INVALID_QUOTE_SCOPE_ITEM");
  assert.equal(service.validateScopeItem(item({
    source: { type: "RECOMMENDATION", recommendationId: "bad", version: 1 },
  })).error.code, "INVALID_QUOTE_SCOPE_ITEM");
});

test("server arithmetic proves 24000 materials plus 68000 labor equals 92000", () => {
  const material = service.validateScopeItem(item({ quantity: 2 })).item;
  const labor = service.validateScopeItem(item({
    classification: "LABOR_SERVICE",
    scopeSemantic: "FUTURE_WORK",
    materialResponsibility: "NOT_APPLICABLE",
    unitAmountMinor: 68000,
  })).item;
  const fan = service.validateScopeItem(item({
    scopeSemantic: "MATERIAL_EXCLUDED",
    materialResponsibility: "PENDING_SELECTION",
    unitAmountMinor: 35000,
  })).item;
  const ac = service.validateScopeItem(item({
    classification: "LABOR_SERVICE",
    scopeSemantic: "SEPARATE_PROPOSAL",
    materialResponsibility: "NOT_APPLICABLE",
    unitAmountMinor: 500000,
  })).item;
  const totals = service.calculateTotals([material, labor, fan, ac]);
  assert.deepEqual(totals, {
    materialsSubtotalMinor: 24000,
    laborServiceSubtotalMinor: 68000,
    totalMinor: 92000,
  });
});

test("Recommendation text is descriptive input and never parsed for pricing", () => {
  const source = readFileSync(join(__dirname, "..", "server", "authorization", "quoteDraftService.js"), "utf8");
  assert.doesNotMatch(source, /parseFloat|parseInt|currency.*statement|statement.*(?:amount|price|minor)/i);
  assert.doesNotMatch(source, /job\.complete|procurement\.|payment\.|invoice\./i);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:jobs|canonical_workstreams|canonical_evaluation_finding_versions|canonical_recommendation_versions)\b/i);
});

test("professional-direct Quote drafts remain truthful and do not fabricate Evaluation evidence", () => {
  const createSource = service.createDraftQuote.toString();
  const scope = service.validateScopeItem(item()).item;
  assert.deepEqual(scope.source, { type: "MANUAL_PROFESSIONAL" });
  assert.doesNotMatch(createSource, /requireSavedEvaluation/);
  assert.doesNotMatch(
    createSource,
    /INSERT INTO canonical_evaluations|INSERT INTO canonical_evaluation_versions/
  );
  assert.match(createSource, /requireQuoteAuthority/);
});

test("customer decisions and revisions reject client-owned authority evidence", async () => {
  const pool = { query() { throw new Error("database should not be reached"); } };
  const common = {
    pool,
    authenticatedActor: { id: 7 },
    quoteId: "00000000-0000-4000-8000-000000000001",
    expectedIssuedVersion: 1,
    idempotencyKey: "decision-key",
  };
  assert.equal((await service.approveIssuedQuote({ ...common, decidedAt: "2026-08-10T00:00:00Z" })).code, "QUOTE_AUTHORITY_FIELD_REJECTED");
  assert.equal((await service.declineIssuedQuote({ ...common, customerParticipantId: "fabricated" })).code, "QUOTE_AUTHORITY_FIELD_REJECTED");
  assert.equal((await service.createDerivedDraftQuote({
    ...common,
    parentQuoteId: common.quoteId,
    lineageType: "REVISED_QUOTE",
    reasonCategory: "PRICING_CHANGE",
    copiedApproval: true,
  })).code, "QUOTE_AUTHORITY_FIELD_REJECTED");
});

test("issue rejects client-owned totals and timestamps before database access", async () => {
  const pool = { query() { throw new Error("database should not be reached"); } };
  const base = {
    pool,
    authenticatedActor: { id: 7 },
    quoteId: "00000000-0000-4000-8000-000000000001",
    expectedVersion: 1,
    idempotencyKey: "issue-key",
  };
  assert.equal((await service.issueQuote({ ...base, totalMinor: 92000 })).code, "QUOTE_AUTHORITY_FIELD_REJECTED");
  assert.equal((await service.issueQuote({ ...base, issuedAt: "2026-08-10T00:00:00Z" })).code, "QUOTE_AUTHORITY_FIELD_REJECTED");
  assert.equal((await service.issueQuote({ ...base, conditions: ["client condition"] })).code, "QUOTE_AUTHORITY_FIELD_REJECTED");
});

test("Quote issuance requires exactly one finalized physical or remote Evaluation branch", async () => {
  const context = {
    job_id: "00000000-0000-4000-8000-000000000001",
    job_request_id: 22,
    relationship_id: 344,
    actor_user_id: 24,
    actor_participant_id: "20000000-0000-4000-8000-000000000001",
  };
  const calls = [];
  const allowed = await service.quoteDraftServiceInternals.requireSavedEvaluation({
    client: {
      async query(sql, values) {
        calls.push({ sql, values });
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000001",
            status: "completed",
            evaluation_version: 2,
          }],
        };
      },
    },
    context,
    logger: { warn() {} },
  });
  assert.equal(allowed, null);
  assert.deepEqual(calls[0].values, [
    344,
    24,
    22,
    "authorization_engine",
    context.job_id,
    context.actor_participant_id,
  ]);
  assert.match(calls[0].sql, /aggregates\.ordinary_request_id = \$3/);
  assert.match(calls[0].sql, /aggregates\.relationship_id = \$1/);
  assert.match(calls[0].sql, /evaluations\.professional_user_id = \$2/);
  assert.match(calls[0].sql, /versions\.version = aggregates\.current_version/);
  assert.match(calls[0].sql, /evaluations\.status = 'completed'/);
  assert.match(calls[0].sql, /completed_visit\.state = 'COMPLETED'/);
  assert.match(calls[0].sql, /canonical_visit_evaluation_links/);
  assert.match(calls[0].sql, /canonical_evaluation_remote_provenance/);
  assert.match(calls[0].sql, /completion_command\.command_name = 'evaluation\.complete'/);
  assert.match(calls[0].sql, /remote\.id IS NULL/);
  assert.match(calls[0].sql, /visit_links\.evaluation_id IS NULL/);

  const warnings = [];
  const blocked = await service.quoteDraftServiceInternals.requireSavedEvaluation({
    client: { async query() { return { rows: [] }; } },
    context,
    logger: { warn(message, evidence) { warnings.push({ message, evidence }); } },
  });
  assert.deepEqual(blocked, {
    ok: false,
    status: 409,
    code: "QUOTE_EVALUATION_REQUIRED",
    message: "A completed Evaluation with a confirmed on-site visit or remote assessment is required before the Quote can be issued.",
  });
  assert.equal(warnings[0].evidence.jobId, context.job_id);
});

test("the canonical issue command invokes the saved-Evaluation gate and customer acceptance stays account-type neutral", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "authorization", "quoteDraftService.js"),
    "utf8"
  );
  assert.match(
    source,
    /async function issueQuote[\s\S]*requireQuoteAuthority[\s\S]*requireSavedEvaluation[\s\S]*loadActiveQuoteGrant/
  );
  assert.doesNotMatch(
    service.quoteDraftServiceInternals.customerQuoteDetailProjection.toString(),
    /assessmentBasis|assessment_basis|remote_assessment/i
  );
  assert.doesNotMatch(source, /account_type\s*=\s*['\"]homeowner['\"]/i);
  assert.match(source, /roles\.role = 'CUSTOMER_REPRESENTATIVE'/);
});
