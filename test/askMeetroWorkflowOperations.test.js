"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  parseEstimateComposeResult,
  parseEvaluationAssistResult,
  parseInvoiceAssistResult,
} = require("../server/intelligence/operations/workflowAssist");

function source(type, id, version = 1) {
  return { type, id, version };
}

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
  }, { semanticInput: { context: {} }, operationId: randomUUID() }), /operation contract/);
});
