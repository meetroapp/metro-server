"use strict";

const { createHash } = require("node:crypto");
const evaluationService = require("../../authorization/evaluationService");
const invoicePaymentService = require("../../finance/invoicePaymentService");
const { isPlainObject } = require("../intelligenceGatewayContracts");
const { assembleQuoteCompositionContext } = require("../quoteCompositionContext");
const { loadGovernedRetailerReferences } = require("../retailerReferenceContract");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELEMENT_ID = /^[a-z][a-z0-9_.:-]{0,159}$/;
const CLASSIFICATIONS = new Set(["OBSERVED", "PROFESSIONAL_INPUT", "NEEDS_VERIFICATION", "AI_SUGGESTED"]);
const EVALUATION_INTENTS = new Set([
  "DESCRIBE_CONDITION", "INSPECTION_CHECKLIST", "ANALYZE_PHOTOS",
  "MEASUREMENT_HELP", "DRAFT_FINDINGS", "DRAFT_RECOMMENDATIONS",
]);
const ESTIMATE_INTENTS = new Set([
  "ESTIMATE_MATERIALS", "CHECK_MATERIAL_PRICES", "ESTIMATE_LABOR", "PREPARE_QUOTE",
]);
const INVOICE_INTENTS = new Set([
  "CREATE_INVOICE", "REVIEW_INVOICE", "EXPLAIN_BALANCE", "DRAFT_NOTE", "DRAFT_TERMS",
]);

function operationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function contextError(message) {
  return operationError("intelligence_context_invalid", message);
}

function resultError(message) {
  return operationError("malformed_operation_result", message);
}

function exact(value, required, optional = [], errorFactory = resultError) {
  if (!isPlainObject(value)) throw errorFactory("Expected a plain object.");
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw errorFactory("Object fields do not match the operation contract.");
  }
  return value;
}

function text(value, maximum, { required = true, errorFactory = resultError } = {}) {
  if (value == null && !required) return "";
  if (typeof value !== "string" || value !== value.trim() || value.length > maximum || (required && !value)) {
    throw errorFactory("Text does not match the operation bounds.");
  }
  return value;
}

function nullableText(value, maximum, errorFactory = contextError) {
  if (value == null || value === "") return null;
  return text(value, maximum, { errorFactory });
}

function uuid(value, errorFactory = contextError) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID.test(normalized)) throw errorFactory("A valid record identity is required.");
  return normalized;
}

function elementId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ELEMENT_ID.test(normalized)) throw resultError("Proposal element identity is invalid.");
  return normalized;
}

function parsePayload(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw resultError("Provider output is not valid JSON.");
  }
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reference(type, id, version = 1) {
  return { type, id: String(id), version: Number(version) };
}

function safeRequestPhotos(value) {
  const photos = Array.isArray(value) ? value : (() => {
    try { return JSON.parse(value || "[]"); } catch { return []; }
  })();
  return photos.slice(0, 5).flatMap((photo) => {
    if (!isPlainObject(photo)) return [];
    const id = String(photo.public_id || photo.id || "").trim();
    const secureUrl = String(photo.secure_url || "").trim();
    if (!id || !secureUrl.startsWith("https://res.cloudinary.com/")) return [];
    return [{
      id,
      secureUrl,
      mediaType: "IMAGE",
      format: String(photo.format || "").trim().toLowerCase(),
      width: Number(photo.width) || null,
      height: Number(photo.height) || null,
      sourceReferences: [reference("REQUEST_PHOTO", id)],
    }];
  });
}

function normalizeProfessionalEvaluationInput(value) {
  exact(value, ["observations", "measurements", "notes"], [], contextError);
  if (!Array.isArray(value.measurements) || value.measurements.length > 30) {
    throw contextError("Professional measurements are invalid.");
  }
  return {
    observations: nullableText(value.observations, 5000),
    measurements: value.measurements.map((item) => text(item, 500, { errorFactory: contextError })),
    notes: nullableText(value.notes, 5000),
  };
}

async function buildEvaluationAssistContext({ context, input, runtimeContext }) {
  exact(context, [], [], contextError);
  exact(input, ["jobId", "evaluationId", "intent", "professionalInput"], [], contextError);
  const jobId = uuid(input.jobId);
  const evaluationId = input.evaluationId == null ? null : uuid(input.evaluationId);
  if (!EVALUATION_INTENTS.has(input.intent)) throw contextError("Evaluation assistance intent is invalid.");
  const actor = runtimeContext?.authenticatedActor;
  const pool = runtimeContext?.pool;
  const listed = await evaluationService.listEvaluationsForJob({
    pool,
    authenticatedActor: actor,
    jobId,
  });
  if (!listed?.ok) {
    throw operationError(
      listed?.status === 404 ? "intelligence_job_unavailable" : "intelligence_evaluation_authority_required",
      "Evaluation context is unavailable."
    );
  }
  const evaluation = evaluationId
    ? listed.evaluations.find((item) => item.evaluation.id === evaluationId)
    : listed.evaluations[0] || null;
  if (evaluationId && !evaluation) {
    throw operationError("intelligence_evaluation_unavailable", "Evaluation unavailable.");
  }
  const jobResult = await pool.query(
    `/* intelligence_evaluation_assist:job */
     SELECT jobs.id, jobs.job_request_id, jobs.source_request_relationship_id,
       posts.title, posts.description, posts.service_domain, posts.service_specialty,
       posts.request_photos
     FROM jobs
     INNER JOIN posts ON posts.id = jobs.job_request_id
       AND posts.lifecycle_contract_version = 2
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
       AND relationships.professional_user_id = $2
     WHERE jobs.id = $1 AND jobs.lifecycle_contract_version = 2
     LIMIT 1`,
    [jobId, actor.id]
  );
  const job = jobResult.rows[0];
  if (!job) throw operationError("intelligence_job_unavailable", "Job unavailable.");
  const professionalInput = normalizeProfessionalEvaluationInput(input.professionalInput);
  const requestPhotos = safeRequestPhotos(job.request_photos);
  const assembled = {
    mode: "ADVISORY",
    job: {
      id: job.id,
      requestId: Number(job.job_request_id),
      relationshipId: Number(job.source_request_relationship_id),
      title: job.title || "",
      description: job.description || "",
      serviceDomain: job.service_domain || null,
      serviceSpecialty: job.service_specialty || null,
      sourceReferences: [reference("JOB_REQUEST", job.job_request_id)],
    },
    evaluation: evaluation ? {
      id: evaluation.evaluation.id,
      version: Number(evaluation.aggregate.version),
      status: String(evaluation.evaluation.status).toUpperCase(),
      content: evaluation.evaluation.content,
      sourceReferences: [reference("EVALUATION", evaluation.evaluation.id, evaluation.aggregate.version)],
    } : null,
    requestPhotos,
    professionalInput,
    intent: input.intent,
    generatedFor: { professionalUserId: actor.id },
  };
  return { ...assembled, sourceContextFingerprint: fingerprint(assembled) };
}

function normalizeSourceReferences(values, context) {
  if (!Array.isArray(values) || values.length > 12) throw resultError("Source references are invalid.");
  const allowed = new Set([
    ...context.job.sourceReferences,
    ...(context.evaluation?.sourceReferences || []),
    ...context.requestPhotos.flatMap((photo) => photo.sourceReferences),
  ].map((item) => `${item.type}:${item.id}:${item.version}`));
  return values.map((value) => {
    exact(value, ["type", "id", "version"]);
    const normalized = { type: text(value.type, 40), id: text(value.id, 500), version: Number(value.version) };
    if (!Number.isInteger(normalized.version) || normalized.version < 1 ||
        !allowed.has(`${normalized.type}:${normalized.id}:${normalized.version}`)) {
      throw resultError("A source reference is outside the authorized context.");
    }
    return normalized;
  });
}

function normalizeAssistanceItem(value, context, expectedClassification = null) {
  exact(value, ["id", "text", "classification", "sourceReferences"]);
  const classification = String(value.classification || "").trim().toUpperCase();
  if (!CLASSIFICATIONS.has(classification) || (expectedClassification && classification !== expectedClassification)) {
    throw resultError("Assistance classification is invalid.");
  }
  const sourceReferences = normalizeSourceReferences(value.sourceReferences, context);
  if (["OBSERVED", "PROFESSIONAL_INPUT"].includes(classification) && !sourceReferences.length) {
    throw resultError("Observed or professional content requires exact source evidence.");
  }
  return { id: elementId(value.id), text: text(value.text, 3000), classification, sourceReferences };
}

function parseEvaluationAssistResult(providerResult, { semanticInput, operationId }) {
  const payload = parsePayload(providerResult);
  exact(payload, [
    "schemaVersion", "summary", "observed", "professionalInput", "needsVerification",
    "inspectionSuggestions", "measurementSuggestions", "evaluationDraft",
    "findingDrafts", "recommendationDrafts", "photoAnalysis", "warnings",
  ]);
  if (payload.schemaVersion !== 1) throw resultError("Unsupported Evaluation assistance version.");
  const context = semanticInput.context;
  const arrays = [
    "observed", "professionalInput", "needsVerification", "inspectionSuggestions",
    "measurementSuggestions", "findingDrafts", "recommendationDrafts", "warnings",
  ];
  if (arrays.some((key) => !Array.isArray(payload[key]) || payload[key].length > 40)) {
    throw resultError("Evaluation assistance exceeds collection bounds.");
  }
  const normalizeList = (key, classification = null) =>
    payload[key].map((item) => normalizeAssistanceItem(item, context, classification));
  exact(payload.evaluationDraft, ["observations", "diagnosisSummary", "limitations"]);
  exact(payload.photoAnalysis, ["analyzedReferenceIds", "limitations"]);
  if (!Array.isArray(payload.photoAnalysis.analyzedReferenceIds) || !Array.isArray(payload.photoAnalysis.limitations)) {
    throw resultError("Photo analysis metadata is invalid.");
  }
  const photoIds = new Set(context.requestPhotos.map((photo) => photo.id));
  const analyzedReferenceIds = payload.photoAnalysis.analyzedReferenceIds.map((id) => {
    const normalized = text(id, 500);
    if (!photoIds.has(normalized)) throw resultError("Photo analysis referenced unauthorized media.");
    return normalized;
  });
  return {
    schemaVersion: 1,
    proposalId: operationId,
    authorityClassification: "ADVISORY_NON_CANONICAL",
    jobId: context.job.id,
    evaluationId: context.evaluation?.id || null,
    sourceContextFingerprint: context.sourceContextFingerprint,
    summary: text(payload.summary, 1200),
    observed: normalizeList("observed", "OBSERVED"),
    professionalInput: normalizeList("professionalInput", "PROFESSIONAL_INPUT"),
    needsVerification: normalizeList("needsVerification", "NEEDS_VERIFICATION"),
    inspectionSuggestions: normalizeList("inspectionSuggestions", "AI_SUGGESTED"),
    measurementSuggestions: normalizeList("measurementSuggestions", "AI_SUGGESTED"),
    evaluationDraft: {
      id: "evaluation_draft",
      observations: text(payload.evaluationDraft.observations, 5000, { required: false }),
      diagnosisSummary: text(payload.evaluationDraft.diagnosisSummary, 5000, { required: false }),
      limitations: text(payload.evaluationDraft.limitations, 5000, { required: false }),
    },
    findingDrafts: normalizeList("findingDrafts", "AI_SUGGESTED"),
    recommendationDrafts: normalizeList("recommendationDrafts", "AI_SUGGESTED"),
    photoAnalysis: {
      supported: context.requestPhotos.length > 0,
      analyzedReferenceIds,
      limitations: payload.photoAnalysis.limitations.map((item) => text(item, 500)),
      imageMeasurementsAreEstimates: true,
    },
    warnings: payload.warnings.map((item) => text(item, 500)),
    reviewContract: { actions: ["ACCEPTED", "EDITED", "REJECTED"], explicitHumanDecisionRequired: true },
    humanToCanonicalBoundary: {
      directMutationAllowed: false,
      requiredCanonicalCommands: ["evaluation.update", "finding.submit", "recommendation.create"],
      prohibitedCanonicalCommands: ["evaluation.complete", "finding.confirm", "finding.resolve"],
    },
    learningContext: { context: "evaluation_assistance", job: context.job.id, learnedPatternIsCanonicalRule: false },
  };
}

function buildEvaluationAssistProviderRequest({ semanticInput, engineContext }) {
  return {
    schemaVersion: 1,
    operation: "evaluation.assist",
    capability: "evaluation.assist",
    locale: semanticInput.locale,
    canonicalJobContext: semanticInput.context,
    operationContext: engineContext,
    instructions: {
      authority: "proposal_only",
      output: "strict_structured_json",
      requirements: [
        "separate_observed_professional_input_and_needs_verification",
        "treat_image_measurements_as_estimates_without_calibration",
        "preserve_exact_source_references",
        "draft_findings_and_recommendations_for_professional_review",
      ],
      prohibitedActions: ["save_or_complete_evaluation", "confirm_or_resolve_finding", "create_recommendation"],
    },
  };
}

function normalizeCostInput(value) {
  exact(value, ["key", "classification", "description", "quantity", "unitCostMinor"], [], contextError);
  const classification = String(value.classification || "").trim().toUpperCase();
  if (!new Set(["MATERIAL", "LABOR", "EQUIPMENT", "DISPOSAL", "CONTINGENCY"]).has(classification)) {
    throw contextError("Estimate cost classification is invalid.");
  }
  const quantity = Number(value.quantity);
  const unitCostMinor = Number(value.unitCostMinor);
  if (!ELEMENT_ID.test(value.key) || !Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0) {
    throw contextError("Professional estimate cost input is invalid.");
  }
  return {
    key: value.key,
    classification,
    description: text(value.description, 500, { errorFactory: contextError }),
    quantity,
    unitCostMinor,
    provenance: "PROFESSIONAL_OVERRIDE",
  };
}

function normalizeMeasurement(value) {
  exact(value, ["id", "label", "value", "unit", "source"], [], contextError);
  const numeric = Number(value.value);
  if (!ELEMENT_ID.test(value.id) || !Number.isFinite(numeric) || numeric <= 0 || value.source !== "PROFESSIONAL_INPUT") {
    throw contextError("Professional measurement is invalid.");
  }
  return {
    id: value.id,
    label: text(value.label, 200, { errorFactory: contextError }),
    value: numeric,
    unit: text(value.unit, 80, { errorFactory: contextError }),
    source: "PROFESSIONAL_INPUT",
  };
}

async function buildEstimateComposeContext({ context, input, runtimeContext }) {
  exact(context, [], [], contextError);
  exact(input, [
    "jobId", "intent", "professionalInstructions", "measurements", "costInputs",
    "sellingPriceMinor", "retailerQuery",
  ], [], contextError);
  if (!ESTIMATE_INTENTS.has(input.intent)) throw contextError("Estimate assistance intent is invalid.");
  if (!Array.isArray(input.measurements) || input.measurements.length > 50 ||
      !Array.isArray(input.costInputs) || input.costInputs.length > 80) {
    throw contextError("Estimate input collection is invalid.");
  }
  const jobId = uuid(input.jobId);
  const canonical = await assembleQuoteCompositionContext({
    context: {},
    input: {
      jobId,
      mode: "ADVISORY",
      professionalInstructions: "",
      pricingInputs: [],
      materialInputs: [],
      terms: {},
    },
    runtimeContext,
  });
  const sellingPriceMinor = input.sellingPriceMinor == null ? null : Number(input.sellingPriceMinor);
  if (sellingPriceMinor != null && (!Number.isSafeInteger(sellingPriceMinor) || sellingPriceMinor <= 0)) {
    throw contextError("Professional selling price is invalid.");
  }
  const costInputs = input.costInputs.map(normalizeCostInput);
  if (new Set(costInputs.map((item) => item.key)).size !== costInputs.length) {
    throw contextError("Professional estimate cost keys must be unique.");
  }
  const retailerQuery = nullableText(input.retailerQuery, 500);
  const retailerReferences = retailerQuery
    ? await loadGovernedRetailerReferences({
        adapter: runtimeContext?.retailerReferenceAdapter,
        query: retailerQuery,
        context: { jobId, serviceType: canonical.job.serviceSpecialty },
      })
    : [];
  const assembled = {
    mode: "INTERNAL_ESTIMATE_DRAFT",
    job: canonical.job,
    canonical: canonical.canonical,
    professionalInput: {
      instructions: nullableText(input.professionalInstructions, 4000),
      measurements: input.measurements.map(normalizeMeasurement),
      costInputs,
      sellingPriceMinor,
    },
    retailerReferences,
    retailerPolicy: {
      retailer: "HOME_DEPOT",
      referenceOnly: true,
      guaranteedCost: false,
      customerVisibleByDefault: false,
      directScrapingImplemented: false,
    },
    intent: input.intent,
    generatedFor: canonical.generatedFor,
  };
  return { ...assembled, sourceContextFingerprint: fingerprint(assembled) };
}

function finitePositive(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000000) {
    throw resultError(`${label} is invalid.`);
  }
  return parsed;
}

function parseEstimateComposeResult(providerResult, { semanticInput, operationId }) {
  const payload = parsePayload(providerResult);
  exact(payload, [
    "schemaVersion", "summary", "materials", "labor", "equipment", "disposal",
    "contingencyPercent", "assumptions", "missingInformation", "suggestedSellingRange",
    "customerQuoteDraft", "warnings",
  ]);
  if (payload.schemaVersion !== 1) throw resultError("Unsupported Estimate Draft version.");
  const context = semanticInput.context;
  const arrays = ["materials", "labor", "equipment", "assumptions", "missingInformation", "warnings"];
  if (arrays.some((key) => !Array.isArray(payload[key]) || payload[key].length > 80)) {
    throw resultError("Estimate Draft exceeds collection bounds.");
  }
  const costInputs = new Map(context.professionalInput.costInputs.map((item) => [item.key, item]));
  const retailerReferences = new Map(context.retailerReferences.map((item) => [item.id, item]));
  let materialsCostMinor = 0;
  const materials = payload.materials.map((value) => {
    exact(value, [
      "id", "description", "quantity", "unit", "wastePercent", "costInputKey",
      "retailerReferenceId", "assumption", "needsVerification",
    ]);
    const quantity = finitePositive(value.quantity, "Material quantity");
    const wastePercent = Number(value.wastePercent);
    if (!Number.isFinite(wastePercent) || wastePercent < 0 || wastePercent > 100) {
      throw resultError("Material waste allowance is invalid.");
    }
    const cost = value.costInputKey == null ? null : costInputs.get(value.costInputKey);
    if (cost && cost.classification !== "MATERIAL") throw resultError("Material override classification is invalid.");
    const retailer = value.retailerReferenceId == null ? null : retailerReferences.get(value.retailerReferenceId);
    if (value.retailerReferenceId != null && !retailer) throw resultError("Retailer reference is outside governed context.");
    const effectiveUnitCostMinor = cost?.unitCostMinor ?? retailer?.listedPriceMinor ?? null;
    const effectiveQuantity = quantity * (1 + wastePercent / 100);
    const estimatedCostMinor = effectiveUnitCostMinor == null
      ? null
      : Math.round(effectiveUnitCostMinor * effectiveQuantity);
    if (estimatedCostMinor != null) materialsCostMinor += estimatedCostMinor;
    return {
      id: elementId(value.id),
      description: text(value.description, 500),
      quantity,
      unit: text(value.unit, 80),
      wastePercent,
      professionalOverride: cost || null,
      retailerReference: retailer || null,
      effectiveUnitCostMinor,
      estimatedCostMinor,
      priceProvenance: cost ? "PROFESSIONAL_OVERRIDE" : retailer ? "RETAILER_REFERENCE" : "PRICE_MISSING",
      assumption: text(value.assumption, 500, { required: false }),
      needsVerification: value.needsVerification === true,
      customerVisibleByDefault: false,
    };
  });
  let laborCostMinor = 0;
  const labor = payload.labor.map((value) => {
    exact(value, ["id", "description", "crewCount", "hoursPerWorker", "costInputKey", "assumption"]);
    const crewCount = finitePositive(value.crewCount, "Crew count");
    const hoursPerWorker = finitePositive(value.hoursPerWorker, "Labor hours");
    const cost = value.costInputKey == null ? null : costInputs.get(value.costInputKey);
    if (cost && cost.classification !== "LABOR") throw resultError("Labor override classification is invalid.");
    const estimatedCostMinor = cost ? Math.round(cost.unitCostMinor * crewCount * hoursPerWorker) : null;
    if (estimatedCostMinor != null) laborCostMinor += estimatedCostMinor;
    return {
      id: elementId(value.id),
      description: text(value.description, 500),
      crewCount,
      hoursPerWorker,
      professionalOverride: cost || null,
      estimatedCostMinor,
      assumption: text(value.assumption, 500),
      needsProfessionalAcceptance: true,
      customerVisibleByDefault: false,
    };
  });
  const normalizeCostSection = (values, classification) => values.map((value) => {
    exact(value, ["id", "description", "costInputKey"]);
    const cost = value.costInputKey == null ? null : costInputs.get(value.costInputKey);
    if (cost && cost.classification !== classification) throw resultError("Estimate cost classification is invalid.");
    return {
      id: elementId(value.id),
      description: text(value.description, 500),
      professionalOverride: cost || null,
      estimatedCostMinor: cost ? Math.round(cost.unitCostMinor * cost.quantity) : null,
      customerVisibleByDefault: false,
    };
  });
  const equipment = normalizeCostSection(payload.equipment, "EQUIPMENT");
  exact(payload.disposal, ["description", "costInputKey"]);
  const disposalInput = payload.disposal.costInputKey == null ? null : costInputs.get(payload.disposal.costInputKey);
  if (disposalInput && disposalInput.classification !== "DISPOSAL") throw resultError("Disposal cost classification is invalid.");
  const disposal = {
    description: text(payload.disposal.description, 500, { required: false }),
    professionalOverride: disposalInput || null,
    estimatedCostMinor: disposalInput ? Math.round(disposalInput.unitCostMinor * disposalInput.quantity) : null,
    customerVisibleByDefault: false,
  };
  const equipmentCostMinor = equipment.reduce((sum, item) => sum + (item.estimatedCostMinor || 0), 0);
  const disposalCostMinor = disposal.estimatedCostMinor || 0;
  const contingencyPercent = Number(payload.contingencyPercent);
  if (!Number.isFinite(contingencyPercent) || contingencyPercent < 0 || contingencyPercent > 50) {
    throw resultError("Estimate contingency is invalid.");
  }
  const baseCostMinor = materialsCostMinor + laborCostMinor + equipmentCostMinor + disposalCostMinor;
  const contingencyMinor = Math.round(baseCostMinor * contingencyPercent / 100);
  exact(payload.suggestedSellingRange, ["minimumMinor", "maximumMinor", "rationale"]);
  const minimumMinor = Number(payload.suggestedSellingRange.minimumMinor);
  const maximumMinor = Number(payload.suggestedSellingRange.maximumMinor);
  if (!Number.isSafeInteger(minimumMinor) || !Number.isSafeInteger(maximumMinor) ||
      minimumMinor < 0 || maximumMinor < minimumMinor) {
    throw resultError("Suggested selling range is invalid.");
  }
  exact(payload.customerQuoteDraft, ["scopeSummary", "conditions", "exclusions", "durationGuidance", "customerWording"]);
  if (!Array.isArray(payload.customerQuoteDraft.conditions) || !Array.isArray(payload.customerQuoteDraft.exclusions)) {
    throw resultError("Customer Quote Draft content is invalid.");
  }
  const customerQuoteDraft = {
    id: "customer_quote_draft",
    scopeSummary: text(payload.customerQuoteDraft.scopeSummary, 3000),
    conditions: payload.customerQuoteDraft.conditions.map((item) => text(item, 1000)),
    exclusions: payload.customerQuoteDraft.exclusions.map((item) => text(item, 1000)),
    durationGuidance: text(payload.customerQuoteDraft.durationGuidance, 500, { required: false }),
    customerWording: text(payload.customerQuoteDraft.customerWording, 3000),
  };
  const assumptions = payload.assumptions.map((item) => ({ id: elementId(item.id), text: text(item.text, 1000), classification: "NEEDS_VERIFICATION" }));
  return {
    schemaVersion: 1,
    proposalId: operationId,
    authorityClassification: "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL",
    jobId: context.job.id,
    sourceContextFingerprint: context.sourceContextFingerprint,
    summary: text(payload.summary, 1200),
    materials,
    labor,
    equipment,
    disposal,
    contingency: { percent: contingencyPercent, amountMinor: contingencyMinor },
    internalCost: {
      currency: "USD",
      materialsMinor: materialsCostMinor,
      laborMinor: laborCostMinor,
      equipmentMinor: equipmentCostMinor,
      disposalMinor: disposalCostMinor,
      contingencyMinor,
      totalMinor: baseCostMinor + contingencyMinor,
      customerVisible: false,
    },
    suggestedSellingRange: {
      minimumMinor, maximumMinor,
      rationale: text(payload.suggestedSellingRange.rationale, 1000),
      authorityClassification: "ADVISORY",
    },
    professionalSellingPriceMinor: context.professionalInput.sellingPriceMinor,
    assumptions,
    missingInformation: payload.missingInformation.map((item) => text(item, 500)),
    retailerReferences: context.retailerReferences,
    customerQuoteDraft,
    warnings: payload.warnings.map((item) => text(item, 500)),
    reviewContract: { actions: ["ACCEPTED", "EDITED", "REJECTED"], explicitProfessionalDecisionRequired: true },
    humanToCanonicalBoundary: {
      directMutationAllowed: false,
      requiredCanonicalCommands: ["quote.draft.create", "quote.scope.add"],
      prohibitedCanonicalCommands: ["quote.issue", "quote.customer.approve", "quote.customer.decline"],
    },
    learningContext: { context: "internal_estimate", job: context.job.id, learnedPatternIsCanonicalRule: false },
  };
}

function buildEstimateComposeProviderRequest({ semanticInput, engineContext }) {
  return {
    schemaVersion: 1,
    operation: "estimate.compose",
    capability: "estimate.compose",
    locale: semanticInput.locale,
    internalProfessionalContext: semanticInput.context,
    operationContext: engineContext,
    instructions: {
      authority: "internal_advisory_draft",
      output: "strict_structured_json",
      requirements: [
        "professional_measurements_outrank_visual_estimates",
        "professional_cost_overrides_outrank_retailer_references",
        "retailer_prices_are_references_not_guarantees",
        "keep_internal_cost_and_retailer_data_out_of_customer_quote_draft",
        "label_unverified_assumptions",
      ],
      prohibitedActions: ["scrape_retailer", "create_or_issue_quote", "set_customer_decision", "schedule_or_complete_job"],
    },
  };
}

async function buildInvoiceAssistContext({ context, input, runtimeContext }) {
  exact(context, [], [], contextError);
  exact(input, ["jobId", "invoiceId", "intent", "professionalInstructions"], [], contextError);
  if (!INVOICE_INTENTS.has(input.intent)) throw contextError("Invoice assistance intent is invalid.");
  const jobId = input.jobId == null ? null : uuid(input.jobId);
  const invoiceId = input.invoiceId == null ? null : uuid(input.invoiceId);
  if ((jobId == null) === (invoiceId == null)) throw contextError("Exactly one Invoice context identity is required.");
  const actor = runtimeContext?.authenticatedActor;
  const pool = runtimeContext?.pool;
  let invoice = null;
  let readyJob = null;
  if (invoiceId) {
    const loaded = await invoicePaymentService.getProfessionalInvoice({ pool, authenticatedActor: actor, invoiceId });
    if (!loaded?.ok) throw operationError("intelligence_invoice_unavailable", "Invoice unavailable.");
    invoice = loaded.invoice;
  } else {
    const loaded = await invoicePaymentService.getProfessionalJobInvoice({ pool, authenticatedActor: actor, jobId });
    if (loaded?.ok) invoice = loaded.invoice;
    else {
      const workspace = await invoicePaymentService.getProfessionalInvoiceWorkspace({ pool, authenticatedActor: actor, limit: 50 });
      readyJob = workspace?.workspace?.readyJobs?.find((item) => item.jobId === jobId) || null;
      if (!readyJob) throw operationError("intelligence_invoice_unavailable", "Invoice context unavailable.");
    }
  }
  const assembled = {
    mode: "ADVISORY",
    jobId: invoice?.jobId || readyJob.jobId,
    invoice: invoice ? {
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      job: invoice.job,
      status: invoice.status,
      currency: invoice.currency,
      lineItems: invoice.lineItems.map(({ description, quantity, unitAmountMinor, lineTotalMinor, lineageLabel }) => ({
        description, quantity, unitAmountMinor, lineTotalMinor, lineageLabel,
      })),
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      balanceMinor: invoice.balanceMinor,
      due: invoice.due,
      customerNotes: invoice.customerNotes,
      terms: invoice.terms,
      payments: invoice.payments.map(({ amountMinor, currency, receivedDate, method, customerReference }) => ({
        amountMinor, currency, receivedDate, method, customerReference,
      })),
    } : null,
    readyJob: readyJob ? {
      jobId: readyJob.jobId,
      serviceTitle: readyJob.serviceTitle,
      completedAt: readyJob.completedAt,
      completionVersion: readyJob.completionVersion,
      approvedAmount: readyJob.approvedAmount,
    } : null,
    intent: input.intent,
    professionalInstructions: nullableText(input.professionalInstructions, 4000),
    generatedFor: { professionalUserId: actor.id },
  };
  return { ...assembled, sourceContextFingerprint: fingerprint(assembled) };
}

function parseInvoiceAssistResult(providerResult, { semanticInput, operationId }) {
  const payload = parsePayload(providerResult);
  exact(payload, ["schemaVersion", "summary", "lineDescriptions", "customerNotes", "terms", "dueDateWording", "balanceExplanation", "warnings"]);
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.lineDescriptions) || !Array.isArray(payload.warnings)) {
    throw resultError("Invoice assistance result is invalid.");
  }
  const prohibitedKeys = Object.keys(payload).filter((key) => /(?:total|paid|balanceMinor|paymentStatus|paymentRecord)/i.test(key));
  if (prohibitedKeys.length) throw resultError("Provider output asserted financial authority.");
  const context = semanticInput.context;
  const financialTruth = context.invoice ? {
    status: context.invoice.status,
    currency: context.invoice.currency,
    totalMinor: context.invoice.totalMinor,
    paidMinor: context.invoice.paidMinor,
    balanceMinor: context.invoice.balanceMinor,
  } : {
    status: "NOT_CREATED",
    currency: context.readyJob.approvedAmount?.currency || null,
    totalMinor: context.readyJob.approvedAmount?.totalMinor || null,
    paidMinor: 0,
    balanceMinor: context.readyJob.approvedAmount?.totalMinor || null,
  };
  return {
    schemaVersion: 1,
    proposalId: operationId,
    authorityClassification: "ADVISORY_NON_CANONICAL",
    jobId: context.jobId,
    invoiceId: context.invoice?.invoiceId || null,
    sourceContextFingerprint: context.sourceContextFingerprint,
    summary: text(payload.summary, 1200),
    lineDescriptions: payload.lineDescriptions.map((value) => {
      exact(value, ["id", "text"]);
      return { id: elementId(value.id), text: text(value.text, 1000) };
    }),
    customerNotes: { id: "customer_notes", text: text(payload.customerNotes, 2000, { required: false }) },
    terms: { id: "invoice_terms", text: text(payload.terms, 2000, { required: false }) },
    dueDateWording: { id: "due_date_wording", text: text(payload.dueDateWording, 500, { required: false }) },
    balanceExplanation: { id: "balance_explanation", text: text(payload.balanceExplanation, 1000, { required: false }) },
    canonicalFinancialTruth: financialTruth,
    warnings: payload.warnings.map((item) => text(item, 500)),
    reviewContract: { actions: ["ACCEPTED", "EDITED", "REJECTED"], explicitProfessionalDecisionRequired: true },
    humanToCanonicalBoundary: {
      directMutationAllowed: false,
      requiredCanonicalCommands: ["invoice.create"],
      prohibitedCanonicalCommands: ["invoice.issue", "payment.record", "invoice.balance.update"],
    },
    learningContext: { context: "invoice_assistance", job: context.jobId, learnedPatternIsCanonicalRule: false },
  };
}

function buildInvoiceAssistProviderRequest({ semanticInput, engineContext }) {
  return {
    schemaVersion: 1,
    operation: "invoice.assist",
    capability: "invoice.assist",
    locale: semanticInput.locale,
    canonicalInvoiceContext: semanticInput.context,
    operationContext: engineContext,
    instructions: {
      authority: "proposal_only",
      output: "strict_structured_json",
      requirements: ["use_canonical_completed_work", "copy_financial_truth_without_recalculation", "draft_wording_only"],
      prohibitedActions: ["create_or_issue_invoice", "record_payment", "change_total_paid_balance_or_status"],
    },
  };
}

const workflowAssistEngines = Object.freeze([
  Object.freeze({ id: "evaluation_advisory_boundary", async collectContext() { return { mutationAllowed: false, observedVsAssumptionRequired: true, mediaType: "image" }; } }),
  Object.freeze({ id: "estimate_advisory_boundary", async collectContext() { return { mutationAllowed: false, internalCostCustomerVisible: false, retailerReferenceOnly: true }; } }),
  Object.freeze({ id: "invoice_advisory_boundary", async collectContext() { return { mutationAllowed: false, financialTruthServerOwned: true, paymentMutationAllowed: false }; } }),
]);

const evaluationAssistOperationDefinition = Object.freeze({
  operation: "evaluation.assist", capability: "evaluation.assist", supportedRoles: Object.freeze(["professional"]),
  roleAuthorization: "context_builder",
  engineIds: Object.freeze(["evaluation_advisory_boundary"]), providerName: "workflow_assistance",
  buildContext: buildEvaluationAssistContext, buildProviderRequest: buildEvaluationAssistProviderRequest,
  parseResult: parseEvaluationAssistResult,
});
const estimateComposeOperationDefinition = Object.freeze({
  operation: "estimate.compose", capability: "estimate.compose", supportedRoles: Object.freeze(["professional"]),
  roleAuthorization: "context_builder",
  engineIds: Object.freeze(["estimate_advisory_boundary"]), providerName: "workflow_assistance",
  buildContext: buildEstimateComposeContext, buildProviderRequest: buildEstimateComposeProviderRequest,
  parseResult: parseEstimateComposeResult,
});
const invoiceAssistOperationDefinition = Object.freeze({
  operation: "invoice.assist", capability: "invoice.assist", supportedRoles: Object.freeze(["professional"]),
  roleAuthorization: "context_builder",
  engineIds: Object.freeze(["invoice_advisory_boundary"]), providerName: "workflow_assistance",
  buildContext: buildInvoiceAssistContext, buildProviderRequest: buildInvoiceAssistProviderRequest,
  parseResult: parseInvoiceAssistResult,
});

module.exports = {
  buildEstimateComposeContext,
  buildEvaluationAssistContext,
  buildInvoiceAssistContext,
  estimateComposeOperationDefinition,
  evaluationAssistOperationDefinition,
  invoiceAssistOperationDefinition,
  parseEstimateComposeResult,
  parseEvaluationAssistResult,
  parseInvoiceAssistResult,
  workflowAssistEngines,
};
