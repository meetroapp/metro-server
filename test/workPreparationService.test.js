"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  CAPABILITIES,
  COMMANDS,
  workPreparationServiceInternals,
} = require("../server/workflow/workPreparationService");

const source = readFileSync(
  join(__dirname, "..", "server", "workflow", "workPreparationService.js"),
  "utf8"
);

function item(overrides = {}) {
  return {
    item_id: "00000000-0000-4000-8000-000000000001",
    item_kind: "MATERIAL",
    provider_responsibility: "BUSINESS",
    required_for_work_start: true,
    quantity: "2.000",
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    planning_state: "PLANNED",
    work_start_policy: "REQUIRED_ITEMS_READY",
    ...overrides,
  };
}

function rows(overrides = {}) {
  return {
    items: [item()],
    purchases: [],
    corrections: [],
    events: [],
    evidence: [],
    ...overrides,
  };
}

test("runtime uses only Migration 60 static capabilities and command vocabulary", () => {
  assert.deepEqual(Object.values(CAPABILITIES).sort(), [
    "work_preparation.plan.read",
    "work_preparation.plan.write",
    "work_preparation.preparation.record",
    "work_preparation.purchase.record",
    "work_preparation.read_customer",
  ].sort());
  assert.deepEqual(new Set(Object.values(COMMANDS)), new Set([
    "work_preparation.plan.create",
    "work_preparation.plan.revise",
    "work_preparation.purchase.record",
    "work_preparation.purchase.correct",
    "work_preparation.customer_item.request",
    "work_preparation.customer_item.receive",
    "work_preparation.material.stage",
    "work_preparation.inventory.allocate",
    "work_preparation.tools.ready",
    "work_preparation.equipment.ready",
    "work_preparation.preparation.record",
    "work_preparation.evidence.attach",
  ]));
});

test("planning materialization consumes exact approved decision source without requiring deposit", () => {
  assert.match(source, /evaluateApprovedWorkDepositGateWithClient\([\s\S]*approvedQuoteDecisionId: decisionId/i);
  assert.match(source, /const source = gate\.source/i);
  assert.match(source, /source\.decision !== "APPROVED"/i);
  assert.doesNotMatch(
    source.match(/async function materializeWorkPreparation[\s\S]*?async function validateRevisionItem/)?.[0] || "",
    /commitmentGateFailure|evaluateCommitmentGate/
  );
  assert.match(source, /WORK_PREPARATION_NOT_MATERIALIZED/);
});

test("plan revision rejects policy NONE with required Work-start items before database enforcement", () => {
  assert.match(source, /workStartPolicy === "NONE"/);
  assert.match(source, /normalizedItems\.some\(\(item\) => item\.required === true\)/);
  assert.match(source, /WORK_PREPARATION_POLICY_CONTRADICTION/);
});

test("committed purchase and preparation use the accepted deposit evaluator inside transactions", () => {
  assert.match(source, /async function evaluateCommitmentGate[\s\S]*lock: true/);
  assert.match(source, /DEPOSIT_REQUIRED_BEFORE_MATERIAL_COMMITMENT/);
  assert.match(source, /deposit_obligation_id, deposit_obligation_version/);
  assert.match(source, /deposit_obligation_state, deposit_currency/);
  assert.match(source, /runTransaction\(input\.pool, "SERIALIZABLE"/);
});

test("TOTAL_ONLY elaboration is bounded to non-billable or customer-supplied planning", () => {
  const accepted = workPreparationServiceInternals.validateRevisionItem({
    sequence: 1,
    kind: "MATERIAL",
    description: "Operational fasteners",
    quantity: 1,
    unit: "lot",
    providerResponsibility: "BUSINESS",
    commercialTreatment: "NOT_CUSTOMER_BILLABLE",
    visibility: "BUSINESS_ONLY",
    requiredForWorkStart: true,
    sourceLineage: "ACCEPTED_SCOPE_ELABORATION",
  }, { quote_id: "00000000-0000-4000-8000-000000000020", issued_quote_version: 2 });
  assert.equal(accepted.commercial, "NOT_CUSTOMER_BILLABLE");
  assert.equal(accepted.sourceScopeItemId, null);
  assert.equal(workPreparationServiceInternals.validateRevisionItem({
    sequence: 1,
    kind: "MATERIAL",
    description: "Fabricated charge",
    quantity: 1,
    unit: "lot",
    providerResponsibility: "BUSINESS",
    commercialTreatment: "INCLUDED_IN_ACCEPTED_TOTAL",
    visibility: "BUSINESS_ONLY",
    requiredForWorkStart: true,
    sourceLineage: "ACCEPTED_SCOPE_ELABORATION",
  }, { quote_id: "00000000-0000-4000-8000-000000000020", issued_quote_version: 2 }), null);
});

test("purchased is distinct from staged/ready", () => {
  const purchasedRows = rows({
    purchases: [{
      id: "00000000-0000-4000-8000-000000000101",
      item_id: "00000000-0000-4000-8000-000000000001",
      quantity: "2.000",
      internal_cost_minor: "20000",
    }],
  });
  const purchased = workPreparationServiceInternals.readinessProjection(plan(), purchasedRows);
  assert.equal(purchased.acquisitionState, "PURCHASED");
  assert.equal(purchased.workStartBlocked, true);

  const staged = workPreparationServiceInternals.readinessProjection(plan(), {
    ...purchasedRows,
    events: [{
      item_id: "00000000-0000-4000-8000-000000000001",
      readiness_dimension: "ACQUISITION",
      event_type: "MATERIAL_STAGED",
      resulting_readiness_state: "READY",
    }],
  });
  assert.equal(staged.acquisitionState, "READY");
  assert.equal(staged.workStartBlocked, false);
});

test("customer required receipt and optional customer items derive independently", () => {
  const required = item({
    provider_responsibility: "CUSTOMER",
    item_id: "00000000-0000-4000-8000-000000000002",
  });
  const optional = item({
    provider_responsibility: "CUSTOMER",
    required_for_work_start: false,
    item_id: "00000000-0000-4000-8000-000000000003",
  });
  const pending = workPreparationServiceInternals.readinessProjection(plan(), rows({
    items: [required, optional],
  }));
  assert.equal(pending.customerItemPending, true);
  assert.equal(pending.workStartBlocked, true);

  const received = workPreparationServiceInternals.readinessProjection(plan(), rows({
    items: [required, optional],
    events: [{
      item_id: required.item_id,
      readiness_dimension: "ACQUISITION",
      event_type: "CUSTOMER_ITEM_RECEIVED",
      resulting_readiness_state: "READY",
    }],
  }));
  assert.equal(received.workStartBlocked, false);
  assert.equal(received.items[0].purchase.recordCount, 0);
});

test("inventory, tools, and equipment readiness do not fabricate purchases", () => {
  const inventory = workPreparationServiceInternals.itemReadiness(item(), rows({
    events: [{
      item_id: "00000000-0000-4000-8000-000000000001",
      readiness_dimension: "ACQUISITION",
      event_type: "BUSINESS_INVENTORY_ALLOCATED",
      resulting_readiness_state: "READY",
    }],
  }));
  assert.equal(inventory.acquisitionState, "READY");
  assert.equal(inventory.purchase.recordCount, 0);

  for (const [kind, eventType] of [["TOOL", "TOOLS_READY"], ["EQUIPMENT", "EQUIPMENT_READY"]]) {
    const readiness = workPreparationServiceInternals.itemReadiness(
      item({ item_kind: kind }),
      rows({ events: [{
        item_id: "00000000-0000-4000-8000-000000000001",
        readiness_dimension: "ACQUISITION",
        event_type: eventType,
        resulting_readiness_state: "READY",
      }] })
    );
    assert.equal(readiness.acquisitionState, "READY");
    assert.equal(readiness.purchase.recordCount, 0);
  }
});

test("business projection contains internal cost while customer-safe projection strips it", () => {
  const basePlan = {
    ...plan(),
    job_id: "00000000-0000-4000-8000-000000000030",
    relationship_id: 1,
    quote_id: "00000000-0000-4000-8000-000000000040",
    issued_quote_version: 1,
    approved_customer_decision_id: "00000000-0000-4000-8000-000000000050",
    current_version: 1,
    commercial_currency: "USD",
  };
  const itemRow = {
    ...item(),
    sequence: 1,
    description: "Private sourcing",
    unit: "each",
    commercial_treatment: "NOT_CUSTOMER_BILLABLE",
    visibility: "CUSTOMER_VISIBLE",
    source_lineage: "ACCEPTED_SCOPE_ELABORATION",
    source_scope_item_id: null,
    internal_estimated_cost_minor: "9000",
    internal_cost_currency: "USD",
  };
  const projectionRows = rows({
    items: [itemRow],
    purchases: [{
      id: "00000000-0000-4000-8000-000000000060",
      item_id: itemRow.item_id,
      quantity: "1.000",
      internal_cost_minor: "9000",
      vendor: "Private Vendor",
    }],
  });
  const business = workPreparationServiceInternals.planProjection(
    basePlan,
    projectionRows,
    { allowed: true, state: "NOT_REQUIRED" }
  );
  const customer = workPreparationServiceInternals.planProjection(
    basePlan,
    projectionRows,
    { allowed: true, state: "NOT_REQUIRED" },
    { customerSafe: true }
  );
  assert.equal(business.items[0].internalEstimatedCostMinor, 9000);
  assert.equal(business.purchaseSummary.internalCostMinor, 9000);
  assert.equal("internalEstimatedCostMinor" in customer.items[0], false);
  assert.equal("purchaseSummary" in customer, false);
  assert.deepEqual(customer.deposit, { commitmentLocked: false });
  assert.doesNotMatch(JSON.stringify(customer), /Private Vendor|internalNotes|idempotency/i);
});

test("runtime never mutates Quote, Invoice, payment, scheduling, or legacy Materials authority", () => {
  assert.doesNotMatch(
    source,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:canonical_quotes|canonical_quote_versions|canonical_quote_scope|canonical_invoices|canonical_invoice|canonical_pre_work_deposit|canonical_pre_work_payment|canonical_visits|canonical_visit_versions|canonical_work_activit|jobs|posts)/i
  );
  assert.doesNotMatch(source, /localStorage|legacy material/i);
});
