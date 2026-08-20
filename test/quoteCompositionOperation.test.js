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

function solutionReadyGatewayPool({
  proposalId,
  proposalJobId = IDS.job,
  proposalAvailable = true,
} = {}) {
  const calls = [];
  const proposal = {
    schemaVersion: 1,
    proposalId,
    authorityClassification: "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL",
    jobId: proposalJobId,
    sourceContextFingerprint: "f".repeat(64),
    materials: [],
    labor: [],
    equipment: [],
    assumptions: [],
    internalCost: { customerVisible: false },
    suggestedSellingRange: { authorityClassification: "ADVISORY" },
    professionalSellingPriceMinor: null,
    customerQuoteDraft: { id: "customer_quote_draft" },
    reviewContract: { explicitProfessionalDecisionRequired: true },
    humanToCanonicalBoundary: { directMutationAllowed: false },
  };

  async function query(sql, params = []) {
    const text = String(sql);
    calls.push(text);

    if (/^(?:BEGIN|COMMIT|ROLLBACK)/i.test(text.trim())) {
      return { rows: [] };
    }
    if (text.includes("estimate_solution_ready:proposal")) {
      return { rows: proposalAvailable ? [{ result_payload: proposal }] : [] };
    }
    if (text.includes("estimate_solution_ready:reviews")) {
      return { rows: [] };
    }
    if (text.includes("quote_composition:job_authority")) {
      return { rows: [{
        job_id: params[0],
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
        selected_professional_user_id: 65,
        actor_account_type: "professional",
        professional_participant_id: IDS.participant,
        is_primary_professional: true,
        active_quote_capabilities: ["quote.create", "quote.read", "quote.scope.manage"],
      }] };
    }
    return { rows: [] };
  }

  return {
    calls,
    query,
    async connect() {
      return { query, release() {} };
    },
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

test("reviewed Estimate lineage remains noncanonical and unpriced scope cannot become a canonical Quote candidate", () => {
  const initial =
    operationContext({
      drywall: true,
    });

  const {
    sourceContextFingerprint:
      _oldFingerprint,
    ...base
  } = initial;

  const estimateReference =
    ref(
      "ESTIMATE_REVIEW",
      "30000000-0000-4000-8000-000000001001:repair_labor",
      1
    );

  const context = {
    ...base,

    professionalInput: {
      ...base.professionalInput,

      /*
       * No customer Quote price has been confirmed.
       * Reviewed Estimate costs must not substitute.
       */
      pricingInputs: [],

      terms: {
        ...base.professionalInput
          .terms,
        depositPercent: null,
        availability: null,
        confirmedTotalMinor: null,
      },
    },

    reviewedEstimate: {
      schemaVersion: 1,
      proposalId:
        "30000000-0000-4000-8000-000000001001",

      authorityClassification:
        "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL",

      pricingAuthority:
        "PROFESSIONAL_INPUT_ONLY",

      reviewedScope: {
        materials: [],
        labor: [
          {
            id:
              "repair_labor",
            description:
              "Repair wall and relocate outlet",
            provenance:
              "AI_SUGGESTED",
            sourceReferences: [
              estimateReference,
            ],
          },
        ],
        assumptions: [],
        customerQuoteDraft: null,
      },

      canonicalMutationPerformed:
        false,
    },
  };

  context.sourceContextFingerprint =
    sourceContextFingerprint(
      context
    );

  const providerResult = {
    schemaVersion: 1,
    summary:
      "Reviewed Estimate scope requires professional Quote pricing.",

    scopeSections: [
      {
        id:
          "reviewed_estimate_scope",
        title:
          "Reviewed work",
        provenance:
          "AI_SUGGESTED",
        sourceReferences: [
          estimateReference,
        ],
      },
    ],

    proposedScopeItems: [
      {
        id:
          "reviewed_estimate_labor",
        sectionId:
          "reviewed_estimate_scope",
        description:
          "Repair wall and relocate outlet",
        classification:
          "LABOR_SERVICE",
        scopeSemantic:
          "FUTURE_WORK",
        materialResponsibility:
          "NOT_APPLICABLE",
        workStatus:
          "FUTURE_WORK",

        pricing: {
          status:
            "PRICE_MISSING",
          inputKey: null,
        },

        provenance:
          "AI_SUGGESTED",

        sourceReferences: [
          estimateReference,
        ],
      },
    ],

    materials: [],
    exclusions: [],
    assumptions: [],
    separateProposals: [],
    commercialMissingInformation: [],
    workflowConditions: [],
    warnings: [],

    confidence: {
      score: 0.9,
      rationale:
        "Reviewed scope is available but professional Quote pricing is still required.",
    },
  };

  const proposal =
    parseQuoteComposeResult(
      providerResult,
      {
        semanticInput:
          semantic(context),
        operationId:
          randomUUID(),
      }
    );

  const item =
    proposal
      .proposedScopeItems[0];

  assert.equal(
    item.sourceReferences[0]
      .type,
    "ESTIMATE_REVIEW"
  );

  assert.equal(
    item.pricing.status,
    "PRICE_MISSING"
  );

  assert.equal(
    item.pricing.inputKey,
    null
  );

  assert.equal(
    item.canonicalCandidate,
    null
  );

  assert.equal(
    proposal.pricing.totalMinor,
    0
  );

  assert.equal(
    proposal.pricing
      .professionalConfirmedTotalMinor,
    null
  );

  assert.equal(
    proposal.pricing.status,
    "INCOMPLETE"
  );

  assert.equal(
    proposal
      .commercialMissingInformation
      .some(
        ({ code }) =>
          code ===
          "PROFESSIONAL_PRICE_MISSING"
      ),
    true
  );

  /*
   * Accepting advisory Quote wording cannot make an
   * unpriced reviewed-Estimate item canonical.
   */
  assert.throws(
    () =>
      buildConfirmedCompositionPayload(
        proposal,
        [
          {
            elementId:
              "reviewed_estimate_labor",
            action:
              "ACCEPTED",
          },
        ]
      ),
    /canonical-command compatible/i
  );
});

test("canonical Gateway performs Solution Ready handoff from estimateProposalId without promoting Estimate pricing", async () => {
  const estimateProposalId =
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  const estimateProposal = {
    schemaVersion: 1,
    proposalId:
      estimateProposalId,
    authorityClassification:
      "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL",
    jobId:
      IDS.job,
    sourceContextFingerprint:
      "e".repeat(64),
    summary:
      "Private Internal Estimate.",

    materials: [
      {
        id:
          "wall_material",
        description:
          "Drywall and finishing material",
        quantity: 1,
        unit: "lot",
        wastePercent: 0,
        professionalOverride: null,

        retailerReference: {
          id:
            "private_retailer_reference",
          retailer:
            "HOME_DEPOT",
          listedPriceMinor:
            4000,
          customerVisibleByDefault:
            false,
        },

        effectiveUnitCostMinor:
          4000,
        estimatedCostMinor:
          4000,
        priceProvenance:
          "RETAILER_REFERENCE",
        assumption: "",
        needsVerification:
          false,
        customerVisibleByDefault:
          false,
      },
    ],

    labor: [
      {
        id:
          "repair_labor",
        description:
          "Repair wall and relocate outlet",
        crewCount: 1,
        hoursPerWorker: 4,

        professionalOverride: {
          key:
            "private_labor_cost",
          classification:
            "LABOR",
          description:
            "Internal labor",
          quantity: 1,
          unitCostMinor:
            26000,
          provenance:
            "PROFESSIONAL_OVERRIDE",
        },

        estimatedCostMinor:
          104000,
        assumption:
          "Existing wiring remains serviceable.",
        needsProfessionalAcceptance:
          true,
        customerVisibleByDefault:
          false,
      },
    ],

    equipment: [],

    disposal: {
      description: "",
      professionalOverride: null,
      estimatedCostMinor: null,
      customerVisibleByDefault:
        false,
    },

    contingency: {
      percent: 0,
      amountMinor: 0,
    },

    internalCost: {
      currency:
        "USD",
      materialsMinor:
        4000,
      laborMinor:
        104000,
      equipmentMinor: 0,
      disposalMinor: 0,
      contingencyMinor: 0,
      totalMinor:
        108000,
      customerVisible:
        false,
    },

    suggestedSellingRange: {
      minimumMinor:
        35000,
      maximumMinor:
        45000,
      rationale:
        "AI advisory range.",
      authorityClassification:
        "ADVISORY",
    },

    professionalSellingPriceMinor:
      42000,

    assumptions: [],
    missingInformation: [],
    retailerReferences: [],

    customerQuoteDraft: {
      id:
        "customer_quote_draft",
      scopeSummary:
        "Repair wall and relocate outlet.",
      conditions: [],
      exclusions: [],
      durationGuidance:
        "Approximately one working day.",
      customerWording:
        "Repair the wall, relocate the outlet, and install a new outlet plate.",
    },

    warnings: [],

    reviewContract: {
      actions: [
        "ACCEPTED",
        "EDITED",
        "REJECTED",
      ],
      explicitProfessionalDecisionRequired:
        true,
    },

    humanToCanonicalBoundary: {
      directMutationAllowed:
        false,
      requiredCanonicalCommands: [
        "quote.draft.create",
        "quote.scope.add",
      ],
      prohibitedCanonicalCommands: [
        "quote.issue",
        "quote.customer.approve",
        "quote.customer.decline",
      ],
    },
  };

  const estimateReviews = [
    {
      id:
        randomUUID(),
      proposal_element_id:
        "wall_material",
      action:
        "ACCEPTED",
      edited_value: null,
      created_at:
        new Date(
          "2026-08-20T10:00:00Z"
        ),
    },
    {
      id:
        randomUUID(),
      proposal_element_id:
        "repair_labor",
      action:
        "ACCEPTED",
      edited_value: null,
      created_at:
        new Date(
          "2026-08-20T10:00:01Z"
        ),
    },
    {
      id:
        randomUUID(),
      proposal_element_id:
        "customer_quote_draft",
      action:
        "ACCEPTED",
      edited_value: null,
      created_at:
        new Date(
          "2026-08-20T10:00:02Z"
        ),
    },
  ];

  const basePool =
    contextPool();

  const sqlCalls =
    [];

  async function query(
    sql,
    params
  ) {
    const text =
      String(sql);

    sqlCalls.push(text);

    if (
      /^(?:BEGIN|COMMIT|ROLLBACK)/i
        .test(
          text.trim()
        )
    ) {
      return {
        rows: [],
      };
    }

    if (
      text.includes(
        "estimate_solution_ready:proposal"
      )
    ) {
      assert.deepEqual(
        params,
        [
          estimateProposalId,
          65,
        ]
      );

      return {
        rows: [
          {
            result_payload:
              estimateProposal,
          },
        ],
      };
    }

    if (
      text.includes(
        "estimate_solution_ready:reviews"
      )
    ) {
      assert.deepEqual(
        params,
        [
          estimateProposalId,
          65,
        ]
      );

      return {
        rows:
          estimateReviews,
      };
    }

    return basePool.query(
      sql,
      params
    );
  }

  const pool = {
    query,

    async connect() {
      return {
        query,

        release() {},
      };
    },
  };

  const repository =
    createIntelligenceOperationRepositoryFake();

  const providerCalls =
    [];

  const result =
    await executeIntelligenceGateway({
      pool,

      authenticatedActor: {
        id: 65,
        role:
          "professional",
      },

      idempotencyKey:
        randomUUID(),

      body: {
        operation:
          "quote.compose",

        capability:
          "quote.compose",

        locale:
          "en-US",

        context: {},

        input: {
          jobId:
            IDS.job,

          mode:
            "ADVISORY",

          /*
           * This is the only Estimate handoff value
           * supplied by the caller.
           */
          estimateProposalId,

          professionalInstructions:
            "Prepare the reviewed solution for Quote review.",

          /*
           * No customer Quote pricing is confirmed.
           */
          pricingInputs: [],
          materialInputs: [],
          terms: {},
        },
      },

      operationRegistry:
        canonicalIntelligenceOperationRegistry,

      engineRegistry:
        canonicalIntelligenceEngineRegistry,

      providers: {
        quote_composition: {
          async complete(
            request
          ) {
            providerCalls.push(
              request
            );

            const reviewed =
              request
                .canonicalJobContext
                .reviewedEstimate;

            assert.ok(
              reviewed
            );

            assert.equal(
              reviewed
                .authorityClassification,
              "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL"
            );

            assert.equal(
              reviewed
                .pricingAuthority,
              "PROFESSIONAL_INPUT_ONLY"
            );

            assert.deepEqual(
              request
                .canonicalJobContext
                .professionalInput
                .pricingInputs,
              []
            );

            const serialized =
              JSON.stringify(
                reviewed
              );

            assert.doesNotMatch(
              serialized,
              /internalCost/
            );

            assert.doesNotMatch(
              serialized,
              /suggestedSellingRange/
            );

            assert.doesNotMatch(
              serialized,
              /professionalSellingPriceMinor/
            );

            assert.doesNotMatch(
              serialized,
              /retailerReference/
            );

            assert.doesNotMatch(
              serialized,
              /effectiveUnitCostMinor/
            );

            assert.doesNotMatch(
              serialized,
              /estimatedCostMinor/
            );

            assert.doesNotMatch(
              serialized,
              /professionalOverride/
            );

            assert.doesNotMatch(
              serialized,
              /private_retailer_reference/
            );

            assert.doesNotMatch(
              serialized,
              /private_labor_cost/
            );

            const reference =
              reviewed
                .reviewedScope
                .labor[0]
                .sourceReferences[0];

            assert.equal(
              reference.type,
              "ESTIMATE_REVIEW"
            );

            return {
              schemaVersion: 1,

              summary:
                "Reviewed solution requires professional Quote pricing.",

              scopeSections: [
                {
                  id:
                    "reviewed_solution",
                  title:
                    "Reviewed solution",
                  provenance:
                    "AI_SUGGESTED",
                  sourceReferences: [
                    reference,
                  ],
                },
              ],

              proposedScopeItems: [
                {
                  id:
                    "reviewed_repair_labor",
                  sectionId:
                    "reviewed_solution",
                  description:
                    reviewed
                      .reviewedScope
                      .labor[0]
                      .description,

                  classification:
                    "LABOR_SERVICE",

                  scopeSemantic:
                    "FUTURE_WORK",

                  materialResponsibility:
                    "NOT_APPLICABLE",

                  workStatus:
                    "FUTURE_WORK",

                  pricing: {
                    status:
                      "PRICE_MISSING",
                    inputKey:
                      null,
                  },

                  provenance:
                    "AI_SUGGESTED",

                  sourceReferences: [
                    reference,
                  ],
                },
              ],

              materials: [],
              exclusions: [],
              assumptions: [],
              separateProposals: [],
              commercialMissingInformation: [],
              workflowConditions: [],
              warnings: [],

              confidence: {
                score: 0.9,
                rationale:
                  "Reviewed scope is available but professional Quote pricing remains required.",
              },
            };
          },
        },
      },

      repository,
    });

  assert.equal(
    result.code,
    "INTELLIGENCE_OPERATION_COMPLETED"
  );

  assert.equal(
    providerCalls.length,
    1
  );

  assert.equal(
    sqlCalls.some(
      (sql) =>
        sql.includes(
          "estimate_solution_ready:proposal"
        )
    ),
    true
  );

  assert.equal(
    sqlCalls.some(
      (sql) =>
        sql.includes(
          "estimate_solution_ready:reviews"
        )
    ),
    true
  );

  assert.equal(
    result.result
      .authorityClassification,
    "ADVISORY_NON_CANONICAL"
  );

  assert.equal(
    result.result
      .proposedScopeItems[0]
      .sourceReferences[0]
      .type,
    "ESTIMATE_REVIEW"
  );

  assert.equal(
    result.result
      .proposedScopeItems[0]
      .pricing.status,
    "PRICE_MISSING"
  );

  assert.equal(
    result.result
      .proposedScopeItems[0]
      .canonicalCandidate,
    null
  );

  assert.equal(
    result.result
      .pricing.totalMinor,
    0
  );

  assert.equal(
    result.result
      .pricing
      .professionalConfirmedTotalMinor,
    null
  );

  assert.equal(
    result.result
      .pricing.status,
    "INCOMPLETE"
  );

  assert.equal(
    result.result
      .commercialMissingInformation
      .some(
        ({ code }) =>
          code ===
          "PROFESSIONAL_PRICE_MISSING"
      ),
    true
  );

  assert.equal(
    result.result
      .humanToCanonicalBoundary
      .directMutationAllowed,
    false
  );
});

test("Gateway fails governed when Solution Ready Estimate identity is invalid", async () => {
  const repository =
    createIntelligenceOperationRepositoryFake();

  const pool =
    contextPool();

  let providerInvocations = 0;

  const result =
    await executeIntelligenceGateway({
      pool,

      authenticatedActor: {
        id: 65,
        role: "professional",
      },

      idempotencyKey:
        randomUUID(),

      body: {
        operation:
          "quote.compose",

        capability:
          "quote.compose",

        locale:
          "en-US",

        context: {},

        input: {
          jobId:
            IDS.job,

          mode:
            "ADVISORY",

          estimateProposalId:
            "not-a-valid-estimate-id",

          professionalInstructions:
            "Prepare reviewed scope.",

          pricingInputs: [],
          materialInputs: [],
          terms: {},
        },
      },

      providers: {
        quote_composition: {
          async complete() {
            providerInvocations += 1;
            return propertyProviderResult();
          },
        },
      },

      repository,
    });

  assert.equal(
    result.ok,
    false
  );

  assert.equal(
    result.status,
    400
  );

  assert.equal(
    result.code,
    "INTELLIGENCE_ESTIMATE_SOLUTION_READY_INVALID"
  );

  assert.equal(
    providerInvocations,
    0
  );
});

test("Gateway fails governed when the actor-owned Solution Ready Estimate is unavailable", async () => {
  const estimateProposalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const repository = createIntelligenceOperationRepositoryFake();
  const pool = solutionReadyGatewayPool({
    proposalId: estimateProposalId,
    proposalAvailable: false,
  });
  let providerInvocations = 0;

  const result = await executeIntelligenceGateway({
    pool,
    authenticatedActor: { id: 65, role: "professional" },
    idempotencyKey: randomUUID(),
    body: {
      operation: "quote.compose",
      capability: "quote.compose",
      locale: "en-US",
      context: {},
      input: {
        ...composeInput(),
        estimateProposalId,
      },
    },
    providers: {
      quote_composition: {
        async complete() {
          providerInvocations += 1;
          return propertyProviderResult();
        },
      },
    },
    repository,
  });

  assert.deepEqual(
    { ok: result.ok, status: result.status, code: result.code },
    {
      ok: false,
      status: 404,
      code: "INTELLIGENCE_ESTIMATE_SOLUTION_READY_UNAVAILABLE",
    }
  );
  assert.equal(providerInvocations, 0);
});

test("Gateway fails governed when the Solution Ready Estimate belongs to another Job", async () => {
  const estimateProposalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const pool = solutionReadyGatewayPool({
    proposalId: estimateProposalId,
    proposalJobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  let providerInvocations = 0;

  const result = await executeIntelligenceGateway({
    pool,
    authenticatedActor: { id: 65, role: "professional" },
    idempotencyKey: randomUUID(),
    body: {
      operation: "quote.compose",
      capability: "quote.compose",
      locale: "en-US",
      context: {},
      input: {
        ...composeInput(),
        estimateProposalId,
      },
    },
    providers: {
      quote_composition: {
        async complete() {
          providerInvocations += 1;
          return propertyProviderResult();
        },
      },
    },
    repository: createIntelligenceOperationRepositoryFake(),
  });

  assert.deepEqual(
    { ok: result.ok, status: result.status, code: result.code },
    {
      ok: false,
      status: 409,
      code: "INTELLIGENCE_ESTIMATE_SOLUTION_READY_JOB_MISMATCH",
    }
  );
  assert.equal(providerInvocations, 0);
});

test("Gateway preserves governed Quote authority failure before Solution Ready composition", async () => {
  const estimateProposalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let providerInvocations = 0;

  const result = await executeIntelligenceGateway({
    pool: contextPool({ grants: false }),
    authenticatedActor: { id: 65, role: "professional" },
    idempotencyKey: randomUUID(),
    body: {
      operation: "quote.compose",
      capability: "quote.compose",
      locale: "en-US",
      context: {},
      input: {
        ...composeInput(),
        estimateProposalId,
      },
    },
    providers: {
      quote_composition: {
        async complete() {
          providerInvocations += 1;
          return propertyProviderResult();
        },
      },
    },
    repository: createIntelligenceOperationRepositoryFake(),
  });

  assert.deepEqual(
    { ok: result.ok, status: result.status, code: result.code },
    {
      ok: false,
      status: 403,
      code: "INTELLIGENCE_QUOTE_AUTHORITY_REQUIRED",
    }
  );
  assert.equal(providerInvocations, 0);
});
