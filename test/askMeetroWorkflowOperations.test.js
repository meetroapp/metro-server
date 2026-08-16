"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  buildEvaluationAssistContext,
  estimateComposeOperationDefinition,
  evaluationAssistOperationDefinition,
  invoiceAssistOperationDefinition,
  parseEstimateComposeResult,
  parseEvaluationAssistResult,
  parseInvoiceAssistResult,
} = require("../server/intelligence/operations/workflowAssist");
const evaluationService = require("../server/authorization/evaluationService");

function source(type, id, version = 1) {
  return { type, id, version };
}

function evaluationAssistInput(overrides = {}) {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    evaluationId: "22222222-2222-4222-8222-222222222222",
    intent: "ANALYZE_PHOTOS",
    photoReferenceIds: ["meetro/users/65/request-photos/selected"],
    professionalInput: { observations: null, measurements: [], notes: null },
    ...overrides,
  };
}

function evaluationAssistRuntime(requestPhotos) {
  return {
    authenticatedActor: { id: 65, role: "professional" },
    pool: {
      async query(sql, values) {
        assert.match(sql, /intelligence_evaluation_assist:job/);
        assert.deepEqual(values, ["11111111-1111-4111-8111-111111111111", 65]);
        return {
          rows: [{
            id: values[0],
            job_request_id: 14,
            source_request_relationship_id: 18,
            title: "Exact governed request",
            description: "Authorized Evaluation context.",
            service_domain: "home_services",
            service_specialty: "masonry",
            request_photos: requestPhotos,
          }],
        };
      },
    },
  };
}

function authorizeEvaluationContext(t) {
  t.mock.method(evaluationService, "listEvaluationsForJob", async () => ({
    ok: true,
    evaluations: [{
      evaluation: {
        id: "22222222-2222-4222-8222-222222222222",
        status: "DRAFT",
        content: {},
      },
      aggregate: { version: 2 },
    }],
  }));
}

test("professional workflow assistance delegates service-role authorization to governed context builders", () => {
  for (const definition of [
    evaluationAssistOperationDefinition,
    estimateComposeOperationDefinition,
    invoiceAssistOperationDefinition,
  ]) {
    assert.equal(definition.roleAuthorization, "context_builder");
    assert.deepEqual(definition.supportedRoles, ["professional"]);
  }
});

test("Evaluation photo analysis resolves exact selected canonical media after Job authorization", async (t) => {
  authorizeEvaluationContext(t);
  const selected = {
    public_id: "meetro/users/65/request-photos/selected",
    secure_url: "https://res.cloudinary.com/meetro/image/upload/selected.jpg",
    format: "jpg",
    width: 1200,
    height: 900,
  };
  const unrelated = {
    public_id: "meetro/users/65/request-photos/unrelated",
    secure_url: "https://res.cloudinary.com/meetro/image/upload/unrelated.jpg",
  };
  const context = await buildEvaluationAssistContext({
    context: {},
    input: evaluationAssistInput(),
    runtimeContext: evaluationAssistRuntime([unrelated, selected]),
  });
  const providerRequest = evaluationAssistOperationDefinition.buildProviderRequest({
    semanticInput: { locale: "en-US", context },
    engineContext: { evaluation_advisory_boundary: { mutationAllowed: false } },
  });

  assert.deepEqual(context.requestPhotos.map((photo) => photo.id), [selected.public_id]);
  assert.equal(context.requestPhotos[0].secureUrl, selected.secure_url);
  assert.equal(JSON.stringify(providerRequest.canonicalJobContext).includes(selected.secure_url), false);
  assert.equal(JSON.stringify(providerRequest).includes(unrelated.secure_url), false);
  assert.deepEqual(providerRequest.authorizedImageInputs, [{
    mediaId: selected.public_id,
    imageUrl: selected.secure_url,
  }]);
});

test("Evaluation photo analysis rejects foreign, excessive, or caller-supplied media authority", async (t) => {
  authorizeEvaluationContext(t);
  const authorized = [{
    public_id: "meetro/users/65/request-photos/selected",
    secure_url: "https://res.cloudinary.com/meetro/image/upload/selected.jpg",
  }];
  const runtimeContext = evaluationAssistRuntime(authorized);

  await assert.rejects(
    buildEvaluationAssistContext({
      context: {},
      input: evaluationAssistInput({ photoReferenceIds: ["other-job/photo"] }),
      runtimeContext,
    }),
    (error) => error.code === "intelligence_context_invalid"
  );
  await assert.rejects(
    buildEvaluationAssistContext({
      context: {},
      input: evaluationAssistInput({
        photoReferenceIds: Array.from({ length: 6 }, (_, index) => `photo-${index}`),
      }),
      runtimeContext,
    }),
    (error) => error.code === "intelligence_context_invalid"
  );
  await assert.rejects(
    buildEvaluationAssistContext({
      context: {},
      input: evaluationAssistInput({ imageUrl: "https://attacker.example/private.jpg" }),
      runtimeContext,
    }),
    (error) => error.code === "intelligence_context_invalid"
  );
});

test("non-photo Evaluation assistance cannot select or transport image media", async (t) => {
  authorizeEvaluationContext(t);
  const runtimeContext = evaluationAssistRuntime([{
    public_id: "meetro/users/65/request-photos/selected",
    secure_url: "https://res.cloudinary.com/meetro/image/upload/selected.jpg",
  }]);
  await assert.rejects(
    buildEvaluationAssistContext({
      context: {},
      input: evaluationAssistInput({ intent: "DESCRIBE_CONDITION" }),
      runtimeContext,
    }),
    (error) => error.code === "intelligence_context_invalid"
  );

  const input = evaluationAssistInput({ intent: "DESCRIBE_CONDITION" });
  delete input.photoReferenceIds;
  const context = await buildEvaluationAssistContext({ context: {}, input, runtimeContext });
  const providerRequest = evaluationAssistOperationDefinition.buildProviderRequest({
    semanticInput: { locale: "en-US", context },
    engineContext: {},
  });
  assert.deepEqual(context.requestPhotos, []);
  assert.deepEqual(providerRequest.authorizedImageInputs, []);
});

test("Evaluation assistance separates observed, professional input, and unverified assumptions", () => {
  const jobId = randomUUID();
  const evaluationId = randomUUID();
  const operationId = randomUUID();
  const photoId = "meetro/users/65/request-photos/knee-wall";
  const context = {
    mode: "ADVISORY",
    job: {
      id: jobId,
      requestId: 14,
      relationshipId: 18,
      title: "Repair damaged knee wall",
      description: "Significant cracking and separation.",
      serviceDomain: "home_services",
      serviceSpecialty: "masonry",
      sourceReferences: [source("JOB_REQUEST", "14")],
    },
    evaluation: {
      id: evaluationId,
      version: 2,
      status: "DRAFT",
      content: {},
      sourceReferences: [source("EVALUATION", evaluationId, 2)],
    },
    requestPhotos: [{
      id: photoId,
      secureUrl: "https://res.cloudinary.com/meetro/image/upload/knee-wall.jpg",
      mediaType: "IMAGE",
      format: "jpg",
      width: 1200,
      height: 900,
      sourceReferences: [source("REQUEST_PHOTO", photoId)],
    }],
    professionalInput: {
      observations: "Approximately 5-6 ft affected.",
      measurements: ["Affected length: approximately 5-6 ft"],
      notes: null,
    },
    intent: "ANALYZE_PHOTOS",
    generatedFor: { professionalUserId: 65 },
    sourceContextFingerprint: "a".repeat(64),
  };
  const result = parseEvaluationAssistResult({
    schemaVersion: 1,
    summary: "Review the visible wall separation and verify concealed construction after access.",
    observed: [{
      id: "visible_separation",
      text: "Visible cracking and separation are present in the photographed masonry.",
      classification: "OBSERVED",
      sourceReferences: [source("REQUEST_PHOTO", photoId)],
    }],
    professionalInput: [{
      id: "affected_length",
      text: "The professional estimates approximately 5-6 ft is affected.",
      classification: "PROFESSIONAL_INPUT",
      sourceReferences: [source("EVALUATION", evaluationId, 2)],
    }],
    needsVerification: [{
      id: "footing_condition",
      text: "Footing depth and reinforcement condition need verification after access.",
      classification: "NEEDS_VERIFICATION",
      sourceReferences: [],
    }],
    inspectionSuggestions: [{
      id: "check_support",
      text: "Confirm temporary support remains stable before demolition.",
      classification: "AI_SUGGESTED",
      sourceReferences: [],
    }],
    measurementSuggestions: [{
      id: "measure_height",
      text: "Record wall height and thickness with professional measurements.",
      classification: "AI_SUGGESTED",
      sourceReferences: [],
    }],
    evaluationDraft: {
      observations: "Visible cracking and separation; approximately 5-6 ft affected per professional input.",
      diagnosisSummary: "Damaged masonry section requires scoped repair after concealed conditions are verified.",
      limitations: "Footing and reinforcement are concealed.",
    },
    findingDrafts: [{
      id: "damaged_masonry",
      text: "The accessible knee-wall section shows significant cracking and separation.",
      classification: "AI_SUGGESTED",
      sourceReferences: [source("REQUEST_PHOTO", photoId)],
    }],
    recommendationDrafts: [{
      id: "rebuild_section",
      text: "Review removal and reconstruction of the damaged section after footing verification.",
      classification: "AI_SUGGESTED",
      sourceReferences: [],
    }],
    photoAnalysis: {
      analyzedReferenceIds: [photoId],
      limitations: ["Image scale does not establish hidden dimensions."],
    },
    warnings: [],
  }, { semanticInput: { context }, operationId });

  assert.equal(result.proposalId, operationId);
  assert.equal(result.observed[0].classification, "OBSERVED");
  assert.equal(result.professionalInput[0].classification, "PROFESSIONAL_INPUT");
  assert.equal(result.needsVerification[0].classification, "NEEDS_VERIFICATION");
  assert.equal(result.photoAnalysis.imageMeasurementsAreEstimates, true);
  assert.equal(result.humanToCanonicalBoundary.directMutationAllowed, false);
  assert.ok(!result.humanToCanonicalBoundary.prohibitedCanonicalCommands.includes("evaluation.update"));
});

test("internal knee-wall Estimate Draft preserves override precedence and customer privacy", () => {
  const jobId = randomUUID();
  const operationId = randomUUID();
  const context = {
    mode: "INTERNAL_ESTIMATE_DRAFT",
    job: { id: jobId },
    canonical: {},
    professionalInput: {
      instructions: "Keep customer wording generic and say two-tone.",
      measurements: [{ id: "affected_length", label: "Affected length", value: 6, unit: "ft", source: "PROFESSIONAL_INPUT" }],
      costInputs: [
        { key: "concrete_override", classification: "MATERIAL", description: "Concrete materials", quantity: 1, unitCostMinor: 50000, provenance: "PROFESSIONAL_OVERRIDE" },
        { key: "crew_rate", classification: "LABOR", description: "Two-person crew hourly cost", quantity: 1, unitCostMinor: 6000, provenance: "PROFESSIONAL_OVERRIDE" },
      ],
      sellingPriceMinor: 265000,
    },
    retailerReferences: [{
      id: "hd_concrete_80lb",
      retailer: "HOME_DEPOT",
      productName: "80 lb concrete mix",
      productUrl: "https://www.homedepot.com/p/example/100000001",
      storeContext: "Cape Coral, FL",
      retrievedAt: new Date().toISOString(),
      unitLabel: "bag",
      packSize: "80 lb",
      listedPriceMinor: 697,
      currency: "USD",
      availability: "UNKNOWN",
      sourceMethod: "GOVERNED_PROVIDER_REFERENCE",
      priceClassification: "REFERENCE_NOT_GUARANTEED",
      customerVisibleByDefault: false,
    }],
    retailerPolicy: {
      retailer: "HOME_DEPOT",
      referenceOnly: true,
      guaranteedCost: false,
      customerVisibleByDefault: false,
      directScrapingImplemented: false,
    },
    intent: "PREPARE_QUOTE",
    generatedFor: { professionalParticipantId: randomUUID() },
    sourceContextFingerprint: "b".repeat(64),
  };
  const result = parseEstimateComposeResult({
    schemaVersion: 1,
    summary: "Internal draft for rebuilding the damaged knee-wall section.",
    materials: [{
      id: "concrete_mix",
      description: "Concrete mix for footing reconstruction as required",
      quantity: 8,
      unit: "bag",
      wastePercent: 10,
      costInputKey: "concrete_override",
      retailerReferenceId: "hd_concrete_80lb",
      assumption: "Quantity depends on verified footing dimensions.",
      needsVerification: true,
    }],
    labor: [{
      id: "masonry_crew",
      description: "Two-person masonry crew",
      crewCount: 2,
      hoursPerWorker: 16,
      costInputKey: "crew_rate",
      assumption: "Two work days excluding cure time.",
    }],
    equipment: [],
    disposal: { description: "Protection and disposal", costInputKey: null },
    contingencyPercent: 10,
    assumptions: [{ id: "footing_access", text: "Footing scope requires verification after demolition." }],
    missingInformation: ["Verify footing depth and reinforcement condition."],
    suggestedSellingRange: { minimumMinor: 240000, maximumMinor: 285000, rationale: "Advisory range based on accepted inputs." },
    customerQuoteDraft: {
      scopeSummary: "Remove and rebuild the damaged knee-wall section as required after verification.",
      conditions: ["Footing reconstruction is limited to conditions verified after access."],
      exclusions: ["Concealed conditions outside the affected section are excluded."],
      durationGuidance: "Approximately two work days plus cure time.",
      customerWording: "Restore stucco and repaint the wall in the existing two-tone scheme.",
    },
    warnings: [],
  }, { semanticInput: { context }, operationId });

  assert.equal(result.materials[0].priceProvenance, "PROFESSIONAL_OVERRIDE");
  assert.equal(result.materials[0].effectiveUnitCostMinor, 50000);
  assert.equal(result.materials[0].retailerReference.listedPriceMinor, 697);
  assert.equal(result.professionalSellingPriceMinor, 265000);
  assert.equal(result.internalCost.customerVisible, false);
  assert.equal(result.retailerReferences[0].customerVisibleByDefault, false);
  assert.match(result.customerQuoteDraft.customerWording, /two-tone/);
  assert.doesNotMatch(JSON.stringify(result.customerQuoteDraft), /50000|Home Depot|homedepot/i);
  assert.equal(result.humanToCanonicalBoundary.directMutationAllowed, false);
});

test("Invoice assistant copies server financial truth and can only draft wording", () => {
  const jobId = randomUUID();
  const invoiceId = randomUUID();
  const context = {
    mode: "ADVISORY",
    jobId,
    invoice: {
      invoiceId,
      invoiceNumber: "INV-000001",
      job: { title: "Knee wall repair", service: "Masonry" },
      status: "PARTIALLY_PAID",
      currency: "USD",
      lineItems: [],
      totalMinor: 265000,
      paidMinor: 50000,
      balanceMinor: 215000,
      due: { mode: "DUE_ON_RECEIPT", date: null },
      customerNotes: null,
      terms: null,
      payments: [{ amountMinor: 50000, currency: "USD", receivedDate: "2026-08-15", method: "CHECK", customerReference: null }],
    },
    readyJob: null,
    intent: "EXPLAIN_BALANCE",
    professionalInstructions: "Add a concise thank-you note.",
    generatedFor: { professionalUserId: 65 },
    sourceContextFingerprint: "c".repeat(64),
  };
  const result = parseInvoiceAssistResult({
    schemaVersion: 1,
    summary: "Draft wording for professional review.",
    lineDescriptions: [{ id: "completed_repair", text: "Completed knee-wall repair and finish restoration." }],
    customerNotes: "Thank you for choosing our team.",
    terms: "Payment is due on receipt.",
    dueDateWording: "Due on receipt",
    balanceExplanation: "The recorded check is reflected in the remaining amount shown by Meetro.",
    warnings: [],
  }, { semanticInput: { context }, operationId: randomUUID() });

  assert.deepEqual(result.canonicalFinancialTruth, {
    status: "PARTIALLY_PAID", currency: "USD", totalMinor: 265000,
    paidMinor: 50000, balanceMinor: 215000,
  });
  assert.equal(result.humanToCanonicalBoundary.directMutationAllowed, false);
  assert.ok(result.humanToCanonicalBoundary.prohibitedCanonicalCommands.includes("payment.record"));
});

test("Invoice assistant rejects provider-owned financial totals", () => {
  assert.throws(() => parseInvoiceAssistResult({
    schemaVersion: 1,
    summary: "Unsafe",
    lineDescriptions: [],
    customerNotes: "",
    terms: "",
    dueDateWording: "",
    balanceExplanation: "",
    warnings: [],
    balanceMinor: 1,
  }, { semanticInput: { context: {} }, operationId: randomUUID() }), (error) => {
    assert.match(error.message, /operation contract/);
    assert.match(error.diagnosticCode, /^[a-f0-9]{16}$/);
    assert.equal(error.message.includes(error.diagnosticCode), false);
    return true;
  });
});

test("Estimate parser emits bounded diagnostics for malformed provider output", () => {
  const jobId = randomUUID();
  const operationId = randomUUID();
  const context = {
    mode: "INTERNAL_ESTIMATE_DRAFT",
    job: { id: jobId },
    professionalInput: {
      instructions: "Keep customer-facing content generic.",
      measurements: [{ id: "length", label: "Length", value: 5, unit: "ft", source: "PROFESSIONAL_INPUT" }],
      costInputs: [],
      sellingPriceMinor: null,
    },
    retailerReferences: [],
    retailerPolicy: {
      retailer: "HOME_DEPOT",
      referenceOnly: true,
      guaranteedCost: false,
      customerVisibleByDefault: false,
      directScrapingImplemented: false,
    },
    intent: "PREPARE_QUOTE",
    generatedFor: { professionalParticipantId: randomUUID() },
    sourceContextFingerprint: "d".repeat(64),
  };

  let error;
  try {
    parseEstimateComposeResult({
      schemaVersion: 1,
      summary: "Estimate summary",
      materials: [],
      labor: [],
      equipment: [],
      disposal: { description: "", costInputKey: null },
      contingencyPercent: 0,
      assumptions: [],
      missingInformation: [],
      suggestedSellingRange: { minimumMinor: 12000, maximumMinor: 13000, rationale: "Range for advisory estimate." },
      customerQuoteDraft: {
        scopeSummary: "Replace damaged section.",
        conditions: ["Access required."],
        exclusions: ["Interior finishes excluded."],
        durationGuidance: "One-day response window.",
        customerWording: "Rework and restore the affected area.",
      },
      warnings: [],
      unexpected: "legacy-field",
    }, {
      semanticInput: { context },
      operationId,
      providerMetadata: {
        providerRequestId: "req_fixture_qa",
        configuredModel: "gpt-5.4-mini",
      },
    });
    assert.fail("estimate parser must reject malformed provider output");
  } catch (value) {
    error = value;
  }

  assert.equal(error?.code, "malformed_operation_result");
  assert.equal(error?.parserDiagnostics?.operation, "estimate.compose");
  assert.equal(error?.parserDiagnostics?.parserStage, "payload_shape");
  assert.equal(error?.parserDiagnostics?.validationBranch, "extra_fields");
  assert.equal(error?.parserDiagnostics?.providerRequestId, "req_fixture_qa");
  assert.equal(error?.parserDiagnostics?.configuredModel, "gpt-5.4-mini");
  assert.equal(error?.parserDiagnostics?.schemaVersion, 1);
  assert.equal(error?.parserDiagnostics?.extraFields[0], "unexpected");
  assert.equal(Array.isArray(error?.parserDiagnostics?.missingFields), true);
  assert.equal(typeof error?.parserDiagnostics?.structuralFingerprint, "string");
});
