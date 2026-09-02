"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  APPROVED_WORK_VISIT_AUTHORITY_SOURCE,
  CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES,
  PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES,
  activateApprovedWorkVisitAuthority,
  approvedWorkVisitServiceInternals,
} = require("../server/workflow/approvedWorkVisitService");

const source = readFileSync(
  join(__dirname, "..", "server", "workflow", "approvedWorkVisitService.js"),
  "utf8"
);

test("Approved Work Visit activation grants only the exact approved matrices", () => {
  assert.deepEqual(CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES, [
    "visit.read",
    "visit.confirm",
    "visit.change_request",
  ]);
  assert.deepEqual(PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES, [
    "visit.read",
    "visit.propose",
    "visit.reschedule",
    "visit.cancel",
    "visit.start",
    "visit.complete",
  ]);
  assert.equal(
    APPROVED_WORK_VISIT_AUTHORITY_SOURCE,
    "CANONICAL_APPROVED_WORK_VISIT_AUTHORITY"
  );
  assert.equal(PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES.includes("visit.confirm"), false);
  assert.equal(CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES.includes("visit.cancel"), false);
});

test("Approved Work authority DTO is allowlisted and hides grant internals", () => {
  const context = {
    job_id: "job",
    quote_id: "quote",
    approved_quote_decision_id: "decision",
    issued_quote_version: 4,
    customer_participant_id: "customer",
    professional_participant_id: "professional",
    future_sentinel: "must-not-leak",
  };
  const grants = [
    ...CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES.map((capability) => ({
      grantee_participant_id: "customer",
      capability,
      stored_secret: "must-not-leak",
    })),
    ...PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES.map((capability) => ({
      grantee_participant_id: "professional",
      capability,
      stored_secret: "must-not-leak",
    })),
    { grantee_participant_id: "customer", capability: "visit.complete" },
  ];
  const result = approvedWorkVisitServiceInternals.authorityProjection(
    context,
    { created_at: "2026-08-13T18:00:00.000Z" },
    grants
  );
  assert.deepEqual(Object.keys(result.authority), [
    "authoritySource",
    "jobId",
    "quoteId",
    "approvalSource",
    "quoteApprovalId",
    "approvedQuoteDecisionId",
    "issuedQuoteVersion",
    "purpose",
    "state",
    "activatedAt",
    "deposit",
    "customerCapabilities",
    "professionalCapabilities",
    "actions",
  ]);
  assert.equal(result.authority.state, "ACTIVE");
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("browser-owned Approved Work activation fields fail before database access", async () => {
  const result = await activateApprovedWorkVisitAuthority({
    pool: { query() { throw new Error("database must not be reached"); } },
    authenticatedActor: { id: 7 },
    jobId: "00000000-0000-4000-8000-000000000001",
    quoteId: "00000000-0000-4000-8000-000000000002",
    idempotencyKey: "activation-key",
    approvedQuoteDecisionId: "browser-owned",
  });
  assert.equal(result.code, "APPROVED_WORK_VISIT_AUTHORITY_FIELD_REJECTED");
});

test("activation source contains no dispatch or adjacent lifecycle mutation", () => {
  assert.match(source, /scope_type = 'approved_work'/i);
  assert.match(source, /decisions\.decision = 'APPROVED'/i);
  assert.doesNotMatch(
    source,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:canonical_quotes|canonical_quote_customer_decisions|canonical_workstreams|canonical_work_activity_versions|canonical_evaluations|canonical_evaluation_findings|canonical_recommendations|jobs|posts|workflow_events)/i
  );
  assert.doesNotMatch(
    source,
    /crew|employee|vehicle|dispatch|route optimization|geofenc|availability|FOLLOW_UP/
  );
});

test("an unsatisfied canonical deposit locks Approved Work proposal authority", () => {
  const context = {
    job_id: "job",
    quote_id: "quote",
    approved_quote_decision_id: "decision",
    issued_quote_version: 4,
    customer_participant_id: "customer",
    professional_participant_id: "professional",
  };
  const grants = [
    ...CUSTOMER_APPROVED_WORK_VISIT_CAPABILITIES.map((capability) => ({
      grantee_participant_id: "customer",
      capability,
    })),
    ...PROFESSIONAL_APPROVED_WORK_VISIT_CAPABILITIES.map((capability) => ({
      grantee_participant_id: "professional",
      capability,
    })),
  ];
  const result = approvedWorkVisitServiceInternals.authorityProjection(
    context,
    { created_at: "2026-08-13T18:00:00.000Z" },
    grants,
    {
      depositGate: {
        allowed: false,
        state: "PARTIALLY_SATISFIED",
        source: { currency: "USD" },
        obligation: {
          id: "obligation",
          latest_required_minor: 51000,
          latest_applied_minor: 20000,
          latest_remaining_minor: 31000,
          latest_version: 2,
        },
      },
    }
  );
  assert.equal(result.authority.state, "LOCKED");
  assert.equal(result.authority.actions.canProposeApprovedWorkVisit, false);
  assert.deepEqual(result.authority.deposit, {
    state: "PARTIALLY_SATISFIED",
    obligationId: "obligation",
    requiredMinor: 51000,
    appliedMinor: 20000,
    remainingMinor: 31000,
    currency: "USD",
    latestVersion: 2,
    schedulingLocked: true,
  });
});
