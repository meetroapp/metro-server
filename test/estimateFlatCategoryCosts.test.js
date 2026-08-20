"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  executeIntelligenceGateway,
} = require("../server/intelligence/intelligenceGateway");
const {
  canonicalIntelligenceEngineRegistry,
} = require("../server/intelligence/intelligenceEngineRegistry");
const {
  canonicalIntelligenceOperationRegistry,
} = require("../server/intelligence/intelligenceOperationRegistry");
const {
  buildEstimateComposeContext,
  parseEstimateComposeResult,
} = require("../server/intelligence/operations/workflowAssist");
const {
  createIntelligenceOperationRepositoryFake,
} = require("./helpers/intelligenceOperationFake");

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PARTICIPANT_ID = "22222222-2222-4222-8222-222222222222";

function contextPool() {
  return {
    async query(sql) {
      const text = String(sql);
      if (text.includes("quote_composition:job_authority")) {
        return {
          rows: [{
            job_id: JOB_ID,
            job_request_id: 14,
            lifecycle_contract_version: 2,
            title: "Closet wall repair",
            description: "Repair wall and relocate outlet.",
            request_category: "home_repair",
            service_domain: "home_services",
            service_specialty: "drywall",
            homeowner_user_id: 8,
            relationship_id: 3,
            relationship_status: "active",
            selected_professional_user_id: 65,
            actor_account_type: "professional",
            professional_participant_id: PARTICIPANT_ID,
            is_primary_professional: true,
            active_quote_capabilities: [
              "quote.create",
              "quote.read",
              "quote.scope.manage",
            ],
          }],
        };
      }
      if (text.includes("quote_composition:evaluation")) return { rows: [] };
      return { rows: [] };
    },
  };
}

function estimateInput(overrides = {}) {
  return {
    jobId: JOB_ID,
    intent: "PREPARE_QUOTE",
    professionalInstructions:
      "Purchase materials $40\nLabor $260.00\nRepair wall inside closet.",
    measurements: [],
    costInputs: [],
    professionalCategoryCosts: [
      { classification: "MATERIAL", totalCostMinor: 4000 },
      { classification: "LABOR", totalCostMinor: 26000 },
    ],
    sellingPriceMinor: null,
    retailerQuery: null,
    ...overrides,
  };
}

function providerResult(overrides = {}) {
  return {
    schemaVersion: 1,
    summary: "Private internal estimate.",
    materials: [{
      id: "suggested_materials",
      description: "Outlet box, plate, wire, and patch materials",
      quantity: 4,
      unit: "suggested items",
      wastePercent: 0,
      costInputKey: null,
      retailerReferenceId: null,
      assumption: "Confirm exact parts before purchase.",
      needsVerification: true,
    }],
    labor: [{
      id: "suggested_labor",
      description: "Repair wall and relocate outlet",
      crewCount: 2,
      hoursPerWorker: 8,
      costInputKey: null,
      assumption: "Planning suggestion only.",
    }],
    equipment: [],
    disposal: { description: "", costInputKey: null },
    contingencyPercent: 10,
    assumptions: [],
    missingInformation: [],
    suggestedSellingRange: {
      minimumMinor: 0,
      maximumMinor: 0,
      rationale: "Customer selling price requires professional confirmation.",
    },
    customerQuoteDraft: {
      scopeSummary: "Repair the wall and relocate the outlet.",
      conditions: [],
      exclusions: [],
      durationGuidance: "",
      customerWording: "Repair wall inside closet and relocate the outlet.",
    },
    warnings: [],
    ...overrides,
  };
}

async function professionalContext(overrides = {}) {
  return buildEstimateComposeContext({
    context: {},
    input: estimateInput(overrides),
    runtimeContext: {
      pool: contextPool(),
      authenticatedActor: { id: 65, role: "professional" },
    },
  });
}

test("professional flat material and labor totals are normalized as category costs", async () => {
  const context = await professionalContext();

  assert.deepEqual(context.professionalInput.professionalCategoryCosts, [
    {
      classification: "MATERIAL",
      totalCostMinor: 4000,
      provenance: "PROFESSIONAL_INPUT",
      basis: "FLAT_TOTAL",
    },
    {
      classification: "LABOR",
      totalCostMinor: 26000,
      provenance: "PROFESSIONAL_INPUT",
      basis: "FLAT_TOTAL",
    },
  ]);
});

test("flat totals produce a private $300 base without fabricated item pricing or labor authority", async () => {
  const context = await professionalContext();
  const proposal = parseEstimateComposeResult(providerResult(), {
    semanticInput: { context },
    operationId: randomUUID(),
  });

  assert.deepEqual(proposal.professionalCategoryCosts, {
    materials: {
      classification: "MATERIAL",
      amountMinor: 4000,
      provenance: "PROFESSIONAL_INPUT",
      basis: "FLAT_TOTAL",
      customerVisibleByDefault: false,
    },
    labor: {
      classification: "LABOR",
      amountMinor: 26000,
      provenance: "PROFESSIONAL_INPUT",
      basis: "FLAT_TOTAL",
      customerVisibleByDefault: false,
    },
  });
  assert.equal(proposal.materials[0].effectiveUnitCostMinor, null);
  assert.equal(proposal.materials[0].estimatedCostMinor, null);
  assert.equal(proposal.materials[0].professionalOverride, null);
  assert.equal(proposal.labor[0].estimatedCostMinor, null);
  assert.equal(proposal.labor[0].professionalOverride, null);
  assert.equal(Object.hasOwn(proposal.professionalCategoryCosts.materials, "quantity"), false);
  assert.equal(Object.hasOwn(proposal.professionalCategoryCosts.materials, "unitCostMinor"), false);
  assert.equal(Object.hasOwn(proposal.professionalCategoryCosts.labor, "hours"), false);
  assert.equal(Object.hasOwn(proposal.professionalCategoryCosts.labor, "rate"), false);
  assert.equal(Object.hasOwn(proposal.professionalCategoryCosts.labor, "crewCount"), false);
  assert.equal(proposal.internalCost.materialsMinor, 4000);
  assert.equal(proposal.internalCost.laborMinor, 26000);
  assert.equal(proposal.internalCost.baseTotalMinor, 30000);
  assert.equal(proposal.internalCost.contingencyMinor, 0);
  assert.equal(proposal.internalCost.totalMinor, 30000);
  assert.equal(proposal.internalCost.customerVisible, false);
  assert.equal(proposal.authorityClassification, "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL");
});

test("provider cannot invent or alter professional category totals", async () => {
  const context = await professionalContext();
  const first = parseEstimateComposeResult(providerResult(), {
    semanticInput: { context },
    operationId: randomUUID(),
  });
  const second = parseEstimateComposeResult(providerResult({ materials: [], labor: [] }), {
    semanticInput: { context },
    operationId: randomUUID(),
  });

  assert.deepEqual(second.professionalCategoryCosts, first.professionalCategoryCosts);
  assert.equal(second.internalCost.baseTotalMinor, 30000);
  assert.throws(
    () => parseEstimateComposeResult(providerResult({
      professionalCategoryCosts: {
        materials: { amountMinor: 999999 },
      },
    }), {
      semanticInput: { context },
      operationId: randomUUID(),
    }),
    /operation contract/i
  );
});

test("flat and itemized authority for one category fails closed instead of double counting", async () => {
  await assert.rejects(
    professionalContext({
      costInputs: [{
        key: "material_override",
        classification: "MATERIAL",
        description: "Drywall material",
        quantity: 1,
        unitCostMinor: 4000,
      }],
    }),
    /flat total.*itemized/i
  );

  await assert.rejects(
    professionalContext({ retailerQuery: "drywall material" }),
    /flat total.*retailer/i
  );
});

test("Gateway accepts the staging Quick Quote flat-total payload before one provider call", async () => {
  const providerCalls = [];
  const result = await executeIntelligenceGateway({
    pool: contextPool(),
    authenticatedActor: { id: 65, role: "professional" },
    idempotencyKey: randomUUID(),
    body: {
      operation: "estimate.compose",
      capability: "estimate.compose",
      locale: "en-US",
      context: {},
      input: estimateInput({
        professionalInstructions: [
          "Purchase materials $40",
          "Labor $260.00",
          "Repair wall inside closet",
          "Move outlet from closet to living room wall.",
          "Install new outlet plate.",
          "",
        ].join("\n"),
      }),
    },
    operationRegistry: canonicalIntelligenceOperationRegistry,
    engineRegistry: canonicalIntelligenceEngineRegistry,
    providers: {
      workflow_assistance: {
        async complete(request) {
          providerCalls.push(request);
          return providerResult();
        },
      },
    },
    repository: createIntelligenceOperationRepositoryFake(),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(providerCalls.length, 1);
  assert.equal(
    providerCalls[0].internalProfessionalContext.professionalInput.instructions,
    [
      "Purchase materials $40",
      "Labor $260.00",
      "Repair wall inside closet",
      "Move outlet from closet to living room wall.",
      "Install new outlet plate.",
    ].join("\n")
  );
  assert.equal(result.result.authorityClassification, "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL");
  assert.equal(result.result.professionalCategoryCosts.materials.amountMinor, 4000);
  assert.equal(result.result.professionalCategoryCosts.labor.amountMinor, 26000);
  assert.equal(result.result.internalCost.baseTotalMinor, 30000);
  assert.equal(result.result.internalCost.totalMinor, 30000);
  assert.equal(result.result.internalCost.customerVisible, false);
});
