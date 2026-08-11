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
  buildConfirmedCompositionPayload,
  parseQuoteComposeResult,
} = require("../server/intelligence/operations/quoteCompose");
const {
  assembleQuoteCompositionContext,
  sourceContextFingerprint,
} = require("../server/intelligence/quoteCompositionContext");
const {
  createIntelligenceOperationRepositoryFake,
} = require("./helpers/intelligenceOperationFake");

const IDS = Object.freeze({
  job: "11111111-1111-4111-8111-111111111111",
  participant: "22222222-2222-4222-8222-222222222222",
  concern: "33333333-3333-4333-8333-333333333333",
  evaluation: "44444444-4444-4444-8444-444444444444",
  finding: "55555555-5555-4555-8555-555555555555",
  workstream: "66666666-6666-4666-8666-666666666666",
  activityTemporary: "77777777-7777-4777-8777-777777777777",
  activityDone: "88888888-8888-4888-8888-888888888888",
  obligation: "99999999-9999-4999-8999-999999999999",
  recommendation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  alternative: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  constraint: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

const ref = (type, id, version = 1) => ({ type, id, version });

function professionalInput({ drywall = false, incremental = "" } = {}) {
  return {
    instructions: {
      text: drywall ? `Repair two drywall areas. ${incremental}`.trim() : "Compose the selected property work.",
      provenance: "PROFESSIONAL_INPUT",
      sourceReferences: [ref("PROFESSIONAL_INPUT", "instructions")],
    },
    pricingInputs: drywall
      ? [
          { key: "drywall_labor", classification: "LABOR_SERVICE", amountMinor: 65000, quantity: 1, status: "PRICE_CONFIRMED_BY_PROFESSIONAL", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "pricing:drywall_labor")] },
          { key: "second_area", classification: "LABOR_SERVICE", amountMinor: 0, quantity: 1, status: "PRICE_CONFIRMED_BY_PROFESSIONAL", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "pricing:second_area")] },
        ]
      : [
          { key: "materials", classification: "MATERIAL", amountMinor: 24000, quantity: 1, status: "PRICE_CONFIRMED_BY_PROFESSIONAL", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "pricing:materials")] },
          { key: "labor", classification: "LABOR_SERVICE", amountMinor: 68000, quantity: 1, status: "PRICE_CONFIRMED_BY_PROFESSIONAL", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "pricing:labor")] },
          { key: "temporary", classification: "LABOR_SERVICE", amountMinor: 0, quantity: 1, status: "PRICE_CONFIRMED_BY_PROFESSIONAL", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "pricing:temporary")] },
        ],
    materialInputs: drywall
      ? [
          { key: "paint", description: "Matching paint", responsibility: "CUSTOMER_SUPPLIED", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "material:paint")] },
          { key: "repair_materials", description: "Studs, drywall, fasteners, tape, compound, texture and miscellaneous materials", responsibility: "PROFESSIONAL_SUPPLIED", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "material:repair_materials")] },
        ]
      : [],
    terms: {
      depositPercent: drywall ? 50 : null,
      availability: drywall ? "Thursday after approval and deposit" : null,
      confirmedTotalMinor: drywall ? 65000 : 92000,
      provenance: "PROFESSIONAL_INPUT",
      sourceReferences: [ref("PROFESSIONAL_INPUT", "terms")],
    },
  };
}

function operationContext({ drywall = false, incremental = "" } = {}) {
  const context = {
    mode: "ADVISORY",
    job: {
      id: IDS.job,
      requestId: 14,
      title: drywall ? "Drywall repair" : "Property maintenance",
      description: drywall ? "Repair around A/C and a bedroom patch" : "Multiple property concerns",
      requestCategory: "home_repair",
      serviceDomain: drywall ? "home_services" : "property_management",
      serviceSpecialty: drywall ? "drywall" : "property_maintenance",
      lifecycleContractVersion: 2,
    },
    generatedFor: { professionalParticipantId: IDS.participant },
    canonical: {
      reportedConcerns: [{
        id: IDS.concern,
        sequence: 1,
        originalText: drywall ? "Drywall damaged around A/C" : "A/C, disposal, lighting, fan and microwave issues",
        provenance: "CUSTOMER_REPORTED",
        sourceReferences: [ref("CONCERN", IDS.concern)],
        clarifications: [],
      }],
      evaluation: {
        id: IDS.evaluation,
        version: 2,
        status: "COMPLETED",
        serviceType: drywall ? "drywall" : "property_maintenance",
        context: "ordinary_job",
        observations: "Synthetic observations",
        diagnosisSummary: "Synthetic diagnosis",
        limitations: "",
        provenance: "CANONICAL_CONFIRMED",
        sourceReferences: [ref("EVALUATION", IDS.evaluation, 2)],
      },
      findings: [{
        id: IDS.finding,
        evaluationId: IDS.evaluation,
        version: 2,
        statement: drywall ? "Two repair areas require framing and drywall finish" : "Primary A/C requires replacement",
        confirmationState: "CONFIRMED",
        resolutionState: "OPEN",
        evidence: [],
        provenance: "CANONICAL_CONFIRMED",
        sourceReferences: [ref("FINDING", IDS.finding, 2)],
      }],
      workstreams: [{ id: IDS.workstream, sequence: 1, version: 2, title: "A/C work", state: "ACTIVE", provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("WORKSTREAM", IDS.workstream, 2)] }],
      workActivities: [
        { id: IDS.activityTemporary, workstreamId: IDS.workstream, version: 3, activityType: "STABILIZATION", statement: "Temporary A/C and disposal restoration", status: "DONE", workStatus: "DONE_TEMPORARY", temporaryIntervention: true, temporaryDetails: "Temporary only", provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("WORK_ACTIVITY", IDS.activityTemporary, 3)] },
        { id: IDS.activityDone, workstreamId: IDS.workstream, version: 2, activityType: "SERVICE", statement: "Completed permanent selected service", status: "DONE", workStatus: "DONE", temporaryIntervention: false, temporaryDetails: null, provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("WORK_ACTIVITY", IDS.activityDone, 2)] },
      ],
      workstreamObligations: [{ id: IDS.obligation, workstreamId: IDS.workstream, sourceFindingId: IDS.finding, sequence: 1, version: 1, statement: "Permanent A/C replacement remains open", status: "OPEN", provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("WORKSTREAM_OBLIGATION", IDS.obligation)] }],
      recommendations: [
        { id: IDS.recommendation, findingId: IDS.finding, evaluationId: IDS.evaluation, kind: "PRIMARY", primaryRecommendationId: null, version: 1, statement: "Replace primary A/C", status: "SEPARATE_PROPOSAL_REQUIRED", provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("RECOMMENDATION", IDS.recommendation)] },
        { id: IDS.alternative, findingId: IDS.finding, evaluationId: IDS.evaluation, kind: "ALTERNATIVE", primaryRecommendationId: IDS.recommendation, version: 1, statement: "R-22 option discussed at $350", status: "DEFERRED", provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("RECOMMENDATION", IDS.alternative)] },
      ],
      customerConstraints: [{ id: IDS.constraint, recommendationId: IDS.recommendation, findingId: IDS.finding, type: "BUDGET", statement: "Customer is budget-sensitive", provenance: "CUSTOMER_REPORTED", sourceReferences: [ref("CUSTOMER_CONSTRAINT", IDS.constraint)] }],
    },
    quoteDraft: null,
    professionalInput: professionalInput({ drywall, incremental }),
    privacy: { exactLocationIncluded: false, communicationIncluded: false, unrelatedHistoryIncluded: false },
  };
  return { ...context, sourceContextFingerprint: sourceContextFingerprint(context) };
}

function sourced(id, description, provenance, sourceReferences) {
  return { id, description, provenance, sourceReferences };
}

function propertyProviderResult() {
  return {
    schemaVersion: 1,
    summary: "Property work is organized without closing the Job or pricing separate A/C work.",
    scopeSections: [
      { id: "selected_work", title: "Selected work", provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("WORKSTREAM", IDS.workstream, 2)] },
      { id: "temporary_work", title: "Temporary work", provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("WORK_ACTIVITY", IDS.activityTemporary, 3)] },
    ],
    proposedScopeItems: [
      { id: "materials", sectionId: "selected_work", description: "Professional-supplied selected materials", classification: "MATERIAL", scopeSemantic: "MATERIAL_INCLUDED", materialResponsibility: "PROFESSIONAL_SUPPLIED", workStatus: "FUTURE_WORK", pricing: { status: "PRICE_CONFIRMED_BY_PROFESSIONAL", inputKey: "materials" }, provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "pricing:materials")] },
      { id: "labor", sectionId: "selected_work", description: "Selected labor and service", classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE", workStatus: "FUTURE_WORK", pricing: { status: "PRICE_CONFIRMED_BY_PROFESSIONAL", inputKey: "labor" }, provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "pricing:labor")] },
      { id: "temporary_ac", sectionId: "temporary_work", description: "Temporary A/C and disposal stabilization", classification: "LABOR_SERVICE", scopeSemantic: "TEMPORARY_SERVICE", materialResponsibility: "NOT_APPLICABLE", workStatus: "DONE_TEMPORARY", pricing: { status: "PRICE_CONFIRMED_BY_PROFESSIONAL", inputKey: "temporary" }, provenance: "CANONICAL_CONFIRMED", sourceReferences: [ref("WORK_ACTIVITY", IDS.activityTemporary, 3)] },
    ],
    materials: [{ id: "fan_material", description: "Fan material pending and excluded", responsibility: "EXCLUDED", provenance: "AI_SUGGESTED", sourceReferences: [] }],
    exclusions: [sourced("fan_exclusion", "Fan material is excluded pending selection", "AI_SUGGESTED", [])],
    assumptions: [],
    separateProposals: [sourced("ac_replacement", "Primary A/C replacement remains separate", "CANONICAL_CONFIRMED", [ref("RECOMMENDATION", IDS.recommendation)])],
    commercialMissingInformation: [],
    workflowConditions: [],
    warnings: [{ code: "job_remains_open", message: "Workstream state does not complete the Job." }],
    confidence: { score: 0.94, rationale: "The proposal uses confirmed lifecycle records and professional prices." },
  };
}

function drywallProviderResult() {
  return {
    schemaVersion: 1,
    summary: "Two drywall work areas with professional pricing and explicit material responsibility.",
    scopeSections: [
      { id: "ac_opening", title: "A/C opening", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "instructions")] },
      { id: "bedroom_patch", title: "Bedroom patch", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "instructions")] },
    ],
    proposedScopeItems: [
      { id: "ac_repair", sectionId: "ac_opening", description: "Frame with two 2x4 studs; install drywall; finish, sand, texture and paint labor", classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE", workStatus: "FUTURE_WORK", pricing: { status: "PRICE_CONFIRMED_BY_PROFESSIONAL", inputKey: "drywall_labor" }, provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "instructions")] },
      { id: "bedroom_repair", sectionId: "bedroom_patch", description: "Patch, finish, sand, texture match and paint labor", classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE", workStatus: "FUTURE_WORK", pricing: { status: "PRICE_CONFIRMED_BY_PROFESSIONAL", inputKey: "second_area" }, provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "instructions")] },
    ],
    materials: [
      { id: "customer_paint", description: "Matching paint", responsibility: "CUSTOMER_SUPPLIED", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "material:paint")] },
      { id: "professional_materials", description: "Studs, drywall, fasteners, tape, compound, texture and miscellaneous materials", responsibility: "PROFESSIONAL_SUPPLIED", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "material:repair_materials")] },
    ],
    exclusions: [],
    assumptions: [sourced("concealed_conditions", "Concealed conditions may require reviewed scope changes", "AI_SUGGESTED", [])],
    separateProposals: [],
    commercialMissingInformation: [],
    workflowConditions: [
      { id: "deposit_term", type: "DEPOSIT", description: "Possible 50 percent deposit", state: "ADVISORY_NOT_SATISFIED", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "terms")] },
      { id: "thursday_availability", type: "AVAILABILITY", description: "Thursday after approval and deposit", state: "CONDITIONAL_NOT_SCHEDULED", provenance: "PROFESSIONAL_INPUT", sourceReferences: [ref("PROFESSIONAL_INPUT", "terms")] },
    ],
    warnings: [],
    confidence: { score: 0.91, rationale: "Professional facts remain distinct from advisory assumptions." },
  };
}

function semantic(context) {
  return { locale: "en-US", capability: "quote.compose", input: {}, context };
}

test("canonical Intelligence registry exposes one professional advisory Quote operation", () => {
  const operation = canonicalIntelligenceOperationRegistry.get("quote.compose");
  assert.deepEqual({
    operation: operation.operation,
    capability: operation.capability,
    supportedRoles: operation.supportedRoles,
    engineIds: operation.engineIds,
    providerName: operation.providerName,
  }, {
    operation: "quote.compose",
    capability: "quote.compose",
    supportedRoles: ["professional"],
    engineIds: ["quote_composition_advisory", "quote_composition_authority_boundary"],
    providerName: "quote_composition",
  });
});

test("property-management proposal preserves $920 arithmetic and lifecycle semantics", () => {
  const proposal = parseQuoteComposeResult(propertyProviderResult(), {
    semanticInput: semantic(operationContext()),
    operationId: randomUUID(),
  });
  assert.deepEqual(proposal.pricing, {
    materialsSubtotalMinor: 24000,
    laborServiceSubtotalMinor: 68000,
    totalMinor: 92000,
    professionalConfirmedTotalMinor: 92000,
    status: "PROFESSIONALLY_CONFIRMED_INPUTS",
    advisoryDeposit: null,
  });
  assert.equal(proposal.proposedScopeItems.find(({ id }) => id === "temporary_ac").workStatus, "DONE_TEMPORARY");
  assert.equal(proposal.separateProposals[0].description.includes("A/C replacement"), true);
  assert.equal(JSON.stringify(proposal.pricing).includes("350"), false);
  assert.equal(proposal.authorityClassification, "ADVISORY_NON_CANONICAL");
  assert.equal(proposal.humanToCanonicalBoundary.directMutationAllowed, false);
});

test("drywall proposal preserves material responsibility, price, advisory deposit, and unscheduled availability", () => {
  const proposal = parseQuoteComposeResult(drywallProviderResult(), {
    semanticInput: semantic(operationContext({ drywall: true })),
    operationId: randomUUID(),
  });
  assert.equal(proposal.scopeSections.length, 2);
  assert.equal(proposal.materials.find(({ id }) => id === "customer_paint").responsibility, "CUSTOMER_SUPPLIED");
  assert.equal(proposal.materials.find(({ id }) => id === "professional_materials").responsibility, "PROFESSIONAL_SUPPLIED");
  assert.equal(proposal.pricing.totalMinor, 65000);
  assert.deepEqual(proposal.pricing.advisoryDeposit, {
    percent: 50,
    depositMinor: 32500,
    balanceMinor: 32500,
    state: "ADVISORY_NOT_SATISFIED",
  });
  assert.equal(proposal.availabilityContext.state, "CONDITIONAL_NOT_SCHEDULED");
});

test("incremental professional context changes only advisory fingerprint and remains industry-scoped", () => {
  const first = operationContext({ drywall: true, incremental: "Opening around AC needs covering." });
  const second = operationContext({ drywall: true, incremental: "Opening around AC needs covering. Requires two 2x4 studs and one drywall sheet." });
  const property = operationContext();
  assert.notEqual(first.sourceContextFingerprint, second.sourceContextFingerprint);
  assert.equal(first.canonical.findings[0].statement, second.canonical.findings[0].statement);
  assert.notEqual(second.job.serviceSpecialty, property.job.serviceSpecialty);
  assert.notEqual(second.sourceContextFingerprint, property.sourceContextFingerprint);
});

test("provider cannot invent pricing, authority, temporary completion, or foreign provenance", () => {
  const context = operationContext();
  const cases = [
    () => {
      const value = propertyProviderResult();
      value.proposedScopeItems[1].pricing = { status: "PRICE_CONFIRMED_BY_PROFESSIONAL", inputKey: "untrusted_350" };
      return value;
    },
    () => ({ ...propertyProviderResult(), quoteStatus: "ISSUED" }),
    () => {
      const value = propertyProviderResult();
      value.proposedScopeItems[2].workStatus = "DONE";
      return value;
    },
    () => {
      const value = propertyProviderResult();
      value.exclusions[0].sourceReferences = [ref("FINDING", randomUUID(), 1)];
      return value;
    },
  ];
  for (const make of cases) {
    assert.throws(
      () => parseQuoteComposeResult(make(), { semanticInput: semantic(context), operationId: randomUUID() }),
      /Provider|pricing|Temporary|reference|fields/i
    );
  }
});

test("confirmed payload includes only professional-reviewed canonical-command inputs and performs no mutation", () => {
  const proposal = parseQuoteComposeResult(drywallProviderResult(), {
    semanticInput: semantic(operationContext({ drywall: true })),
    operationId: randomUUID(),
  });
  const payload = buildConfirmedCompositionPayload(proposal, [
    { elementId: "ac_repair", action: "ACCEPTED" },
    { elementId: "bedroom_repair", action: "REJECTED" },
  ]);
  assert.equal(payload.scopeItems.length, 1);
  assert.equal(payload.scopeItems[0].unitAmountMinor, 65000);
  assert.equal(payload.directMutationPerformed, false);
  assert.equal(payload.issueAuthorized, false);
  assert.equal(payload.customerDecisionAuthorized, false);
  assert.deepEqual(payload.requiredCanonicalCommands, ["quote.draft.create", "quote.scope.add"]);
});

function contextPool({ selected = true, grants = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("quote_composition:job_authority")) {
        return { rows: [{
          job_id: IDS.job,
          job_request_id: 14,
          lifecycle_contract_version: 2,
          title: "Synthetic",
          description: "Synthetic context",
          request_category: "home_repair",
          service_domain: "home_services",
          service_specialty: "drywall",
          homeowner_user_id: 8,
          relationship_id: 3,
          relationship_status: "active",
          selected_professional_user_id: selected ? 65 : 999,
          actor_account_type: "professional",
          professional_participant_id: IDS.participant,
          is_primary_professional: true,
          active_quote_capabilities: grants ? ["quote.create", "quote.read", "quote.scope.manage"] : [],
        }] };
      }
      if (text.includes("quote_composition:evaluation")) return { rows: [] };
      return { rows: [] };
    },
  };
}

function composeInput() {
  return {
    jobId: IDS.job,
    mode: "ADVISORY",
    professionalInstructions: "Prepare reviewed scope.",
    pricingInputs: [],
    materialInputs: [],
    terms: {},
  };
}

test("server-owned context assembler excludes location/Communication and rejects wrong scope or missing grants", async () => {
  const pool = contextPool();
  const context = await assembleQuoteCompositionContext({
    context: {},
    input: composeInput(),
    runtimeContext: { pool, authenticatedActor: { id: 65, role: "professional" } },
  });
  assert.equal(context.job.id, IDS.job);
  assert.equal(context.privacy.exactLocationIncluded, false);
  assert.equal(context.privacy.communicationIncluded, false);
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("serviceAddress"), false);
  assert.equal(serialized.includes("conversation"), false);
  assert.equal(pool.calls.some((sql) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);

  for (const deniedPool of [contextPool({ selected: false }), contextPool({ grants: false })]) {
    await assert.rejects(
      assembleQuoteCompositionContext({ context: {}, input: composeInput(), runtimeContext: { pool: deniedPool, authenticatedActor: { id: 65, role: "professional" } } }),
      (error) => error.code === "intelligence_quote_authority_required"
    );
  }
});

test("canonical Gateway derives actor and Job truth before one deterministic provider call", async () => {
  const repository = createIntelligenceOperationRepositoryFake();
  const pool = contextPool();
  const providerCalls = [];
  const result = await executeIntelligenceGateway({
    pool,
    authenticatedActor: { id: 65, role: "drywall" },
    idempotencyKey: randomUUID(),
    body: {
      operation: "quote.compose",
      capability: "quote.compose",
      locale: "en-US",
      context: {},
      input: composeInput(),
    },
    operationRegistry: canonicalIntelligenceOperationRegistry,
    engineRegistry: canonicalIntelligenceEngineRegistry,
    providers: {
      quote_composition: {
        async complete(request) {
          providerCalls.push(request);
          const value = propertyProviderResult();
          value.scopeSections = [];
          value.proposedScopeItems = [];
          value.materials = [];
          value.exclusions = [];
          value.separateProposals = [];
          return value;
        },
      },
    },
    repository,
  });
  assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].canonicalJobContext.job.id, IDS.job);
  assert.equal(providerCalls[0].canonicalJobContext.privacy.exactLocationIncluded, false);
  assert.equal(result.result.authorityClassification, "ADVISORY_NON_CANONICAL");
});
