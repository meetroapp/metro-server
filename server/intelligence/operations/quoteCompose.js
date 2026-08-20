"use strict";

const { validateScopeItem } = require("../../authorization/quoteDraftService");
const { isPlainObject } = require("../intelligenceGatewayContracts");
const {
  MATERIAL_RESPONSIBILITIES,
  assembleQuoteCompositionContext,
  sourceContextFingerprint,
} = require("../quoteCompositionContext");

const {
  canonicalEstimateSolutionReadyService,
} = require("../estimateSolutionReadyService");

const QUOTE_COMPOSE_OPERATION = "quote.compose";
const QUOTE_COMPOSE_CAPABILITY = "quote.compose";
const QUOTE_COMPOSE_PROVIDER = "quote_composition";
const QUOTE_COMPOSE_ENGINE_IDS = Object.freeze([
  "quote_composition_advisory",
  "quote_composition_authority_boundary",
]);
const PROVENANCE = new Set([
  "CANONICAL_CONFIRMED",
  "PROFESSIONAL_INPUT",
  "CUSTOMER_REPORTED",
  "MEDIA_OBSERVED",
  "AI_SUGGESTED",
  "MISSING_INFORMATION",
]);
const PRICING_STATUS = new Set([
  "PRICE_CONFIRMED_BY_PROFESSIONAL",
  "PRICE_MISSING",
  "PRICE_ADVISORY_ONLY",
]);
const WORK_STATUS = new Set([
  "DONE",
  "DONE_TEMPORARY",
  "OPEN",
  "DEFERRED",
  "FUTURE_WORK",
  "SEPARATE_PROPOSAL",
]);
const SCOPE_SEMANTICS = new Set([
  "COMPLETED_BILLABLE_SERVICE",
  "TEMPORARY_SERVICE",
  "FUTURE_WORK",
  "MATERIAL_INCLUDED",
  "MATERIAL_EXCLUDED",
  "CUSTOMER_SUPPLIED_MATERIAL",
  "SEPARATE_PROPOSAL",
]);
const REFERENCE_TYPES = new Set([
  "CONCERN",
  "CLARIFICATION",
  "EVALUATION",
  "FINDING",
  "WORKSTREAM",
  "WORK_ACTIVITY",
  "WORKSTREAM_OBLIGATION",
  "RECOMMENDATION",
  "CUSTOMER_CONSTRAINT",
  "QUOTE_DRAFT",
  "PROFESSIONAL_INPUT",
  "ESTIMATE_REVIEW",
]);
const PROHIBITED_AUTHORITY_VALUES = new Set([
  "ISSUED",
  "APPROVED",
  "DECLINED",
  "PAID",
  "SCHEDULED",
  "COMPLETED",
  "DEPOSIT_SATISFIED",
  "JOB_COMPLETED",
]);
const ELEMENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
const MAX_ELEMENTS = 80;

function resultError(message) {
  return Object.assign(new Error(message), { code: "malformed_operation_result" });
}

function assertExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) throw resultError("Expected a plain object.");
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw resultError("Provider fields do not match the Quote proposal schema.");
  }
}

function boundedText(value, maximum, { required = true } = {}) {
  if (typeof value !== "string" || value !== value.trim() || value.length > maximum) {
    throw resultError("Provider text exceeds Quote proposal bounds.");
  }
  if (required && !value) throw resultError("Required provider text is missing.");
  return value;
}

function elementId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ELEMENT_ID_PATTERN.test(normalized)) throw resultError("Invalid proposal element identity.");
  return normalized;
}

function parseProviderPayload(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw resultError("Provider output is not valid JSON.");
  }
}

function walkForAuthority(value) {
  if (Array.isArray(value)) {
    value.forEach(walkForAuthority);
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && PROHIBITED_AUTHORITY_VALUES.has(value.toUpperCase())) {
      throw resultError("Provider output asserted prohibited authority.");
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if ([
      "quoteissued",
      "customerapproved",
      "customerdeclined",
      "depositsatisfied",
      "paymentsatisfied",
      "scheduledat",
      "jobcompleted",
    ].includes(normalizedKey)) {
      throw resultError("Provider output contains prohibited authority fields.");
    }
    walkForAuthority(item);
  }
}

function referenceKey(value) {
  return `${value.type}:${value.id}:${Number(value.version)}`;
}

function collectReferenceCatalog(context) {
  const catalog = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.sourceReferences)) {
      for (const item of value.sourceReferences) catalog.set(referenceKey(item), item);
    }
    Object.values(value).forEach(visit);
  };
  visit(context);
  return catalog;
}

function normalizeReferences(values, catalog) {
  if (!Array.isArray(values) || values.length > 12) {
    throw resultError("Proposal source references are invalid.");
  }
  const seen = new Set();
  return values.map((value) => {
    assertExactKeys(value, ["type", "id", "version"]);
    const normalized = {
      type: String(value.type || "").trim().toUpperCase(),
      id: String(value.id || "").trim(),
      version: Number(value.version),
    };
    const key = referenceKey(normalized);
    if (
      !REFERENCE_TYPES.has(normalized.type) ||
      !normalized.id ||
      normalized.id.length > 200 ||
      !Number.isInteger(normalized.version) ||
      normalized.version < 1 ||
      seen.has(key) ||
      !catalog.has(key)
    ) {
      throw resultError("Proposal source reference is not in canonical context.");
    }
    seen.add(key);
    return normalized;
  });
}

function normalizeProvenance(value, references, context) {
  const provenance = String(value || "").trim().toUpperCase();
  if (!PROVENANCE.has(provenance)) throw resultError("Invalid proposal provenance.");
  if (!["AI_SUGGESTED", "MISSING_INFORMATION"].includes(provenance) && !references.length) {
    throw resultError("Sourced proposal content requires provenance references.");
  }
  if (provenance === "MEDIA_OBSERVED") {
    const photoFindings = new Set(
      context.canonical.findings
        .filter((finding) => finding.evidence.some((item) => item.type === "PHOTO_MEDIA"))
        .map((finding) => finding.id)
    );
    if (!references.some((item) => item.type === "FINDING" && photoFindings.has(item.id))) {
      throw resultError("Media-observed content requires canonical photo evidence.");
    }
  }
  return provenance;
}

function normalizeSourcedElement(value, catalog, context, { maxText = 2000 } = {}) {
  assertExactKeys(value, ["id", "description", "provenance", "sourceReferences"]);
  const sourceReferences = normalizeReferences(value.sourceReferences, catalog);
  return {
    id: elementId(value.id),
    description: boundedText(value.description, maxText),
    provenance: normalizeProvenance(value.provenance, sourceReferences, context),
    sourceReferences,
  };
}

function quoteSourceFor(references, context) {
  const first = references.find((item) => [
    "FINDING",
    "RECOMMENDATION",
    "WORKSTREAM",
    "WORK_ACTIVITY",
    "WORKSTREAM_OBLIGATION",
  ].includes(item.type));
  if (!first) return { type: "MANUAL_PROFESSIONAL" };
  const source = { type: first.type, version: first.version };
  if (first.type === "FINDING") source.findingId = first.id;
  if (first.type === "RECOMMENDATION") source.recommendationId = first.id;
  if (first.type === "WORKSTREAM") source.workstreamId = first.id;
  if (first.type === "WORK_ACTIVITY") {
    source.activityId = first.id;
    source.workstreamId = context.canonical.workActivities.find(({ id }) => id === first.id)?.workstreamId;
  }
  if (first.type === "WORKSTREAM_OBLIGATION") {
    source.obligationId = first.id;
    source.workstreamId = context.canonical.workstreamObligations.find(({ id }) => id === first.id)?.workstreamId;
  }
  return source.workstreamId === undefined && ["WORK_ACTIVITY", "WORKSTREAM_OBLIGATION"].includes(first.type)
    ? { type: "MANUAL_PROFESSIONAL" }
    : source;
}

function normalizeScopeItem(value, catalog, context, pricingByKey) {
  assertExactKeys(value, [
    "id",
    "sectionId",
    "description",
    "classification",
    "scopeSemantic",
    "materialResponsibility",
    "workStatus",
    "pricing",
    "provenance",
    "sourceReferences",
  ]);
  const sourceReferences = normalizeReferences(value.sourceReferences, catalog);
  const classification = String(value.classification || "").trim().toUpperCase();
  const scopeSemantic = String(value.scopeSemantic || "").trim().toUpperCase();
  const materialResponsibility = String(value.materialResponsibility || "").trim().toUpperCase();
  const workStatus = String(value.workStatus || "").trim().toUpperCase();
  if (
    !["MATERIAL", "LABOR_SERVICE"].includes(classification) ||
    !SCOPE_SEMANTICS.has(scopeSemantic) ||
    !MATERIAL_RESPONSIBILITIES.has(materialResponsibility) ||
    !WORK_STATUS.has(workStatus)
  ) {
    throw resultError("A proposed scope item has invalid semantics.");
  }
  if (workStatus === "DONE_TEMPORARY" && scopeSemantic !== "TEMPORARY_SERVICE") {
    throw resultError("Temporary work must remain explicitly temporary.");
  }
  if (scopeSemantic === "TEMPORARY_SERVICE" && workStatus !== "DONE_TEMPORARY") {
    throw resultError("Temporary service cannot be summarized as permanent completion.");
  }
  if (workStatus === "SEPARATE_PROPOSAL" && scopeSemantic !== "SEPARATE_PROPOSAL") {
    throw resultError("Separate work must remain a separate proposal.");
  }
  assertExactKeys(value.pricing, ["status", "inputKey"]);
  const pricingStatus = String(value.pricing.status || "").trim().toUpperCase();
  const inputKey = value.pricing.inputKey == null
    ? null
    : String(value.pricing.inputKey).trim().toLowerCase();
  if (!PRICING_STATUS.has(pricingStatus)) throw resultError("Invalid pricing status.");
  let pricing = { status: pricingStatus, inputKey: null, quantity: 1, unitAmountMinor: null, lineTotalMinor: null };
  if (pricingStatus === "PRICE_CONFIRMED_BY_PROFESSIONAL") {
    const professionalPrice = pricingByKey.get(inputKey);
    if (!professionalPrice || professionalPrice.classification !== classification) {
      throw resultError("Confirmed pricing must match professional input exactly.");
    }
    pricing = {
      status: pricingStatus,
      inputKey,
      quantity: professionalPrice.quantity,
      unitAmountMinor: professionalPrice.amountMinor,
      lineTotalMinor: professionalPrice.amountMinor * professionalPrice.quantity,
    };
  } else if (inputKey !== null) {
    throw resultError("Unconfirmed pricing cannot reference an authoritative input.");
  }
  const item = {
    id: elementId(value.id),
    sectionId: elementId(value.sectionId),
    description: boundedText(value.description, 1000),
    classification,
    scopeSemantic,
    materialResponsibility,
    workStatus,
    pricing,
    provenance: normalizeProvenance(value.provenance, sourceReferences, context),
    sourceReferences,
  };
  item.canonicalCandidate = pricing.status === "PRICE_CONFIRMED_BY_PROFESSIONAL"
    ? {
        classification,
        scopeSemantic,
        materialResponsibility,
        description: item.description,
        quantity: pricing.quantity,
        unitAmountMinor: pricing.unitAmountMinor,
        source: quoteSourceFor(sourceReferences, context),
      }
    : null;
  if (item.canonicalCandidate && validateScopeItem(item.canonicalCandidate).error) {
    item.canonicalCandidate = null;
  }
  return item;
}

function ensureUniqueIds(collections) {
  const seen = new Set();
  for (const collection of collections) {
    for (const item of collection) {
      if (seen.has(item.id)) throw resultError("Proposal element identities must be unique.");
      seen.add(item.id);
    }
  }
}

function totalsFor(items) {
  let materialsSubtotalMinor = 0;
  let laborServiceSubtotalMinor = 0;
  for (const item of items) {
    if (!item.canonicalCandidate) continue;
    const validated = validateScopeItem(item.canonicalCandidate);
    if (validated.error || validated.item.includedInTotal !== true) continue;
    if (item.classification === "MATERIAL") materialsSubtotalMinor += item.pricing.lineTotalMinor;
    else laborServiceSubtotalMinor += item.pricing.lineTotalMinor;
  }
  return {
    materialsSubtotalMinor,
    laborServiceSubtotalMinor,
    totalMinor: materialsSubtotalMinor + laborServiceSubtotalMinor,
  };
}

function normalizeWorkflowCondition(value, catalog, context) {
  assertExactKeys(value, ["id", "type", "description", "state", "provenance", "sourceReferences"]);
  const sourceReferences = normalizeReferences(value.sourceReferences, catalog);
  const type = String(value.type || "").trim().toUpperCase();
  const state = String(value.state || "").trim().toUpperCase();
  if (
    !["DEPOSIT", "AVAILABILITY", "OTHER"].includes(type) ||
    ![
      "ADVISORY_NOT_SATISFIED",
      "CONDITIONAL_NOT_SCHEDULED",
      "REQUIRES_PROFESSIONAL_CONFIRMATION",
    ].includes(state)
  ) {
    throw resultError("Invalid workflow condition.");
  }
  return {
    id: elementId(value.id),
    type,
    description: boundedText(value.description, 1000),
    state,
    provenance: normalizeProvenance(value.provenance, sourceReferences, context),
    sourceReferences,
  };
}

function appendServerMissingInformation(items, materials, missing, totals, context) {
  const output = [...missing];
  const codes = new Set(output.map(({ code }) => code));
  const add = (code, description, elementIdValue = null) => {
    if (codes.has(code)) return;
    codes.add(code);
    output.push({
      id: `server_${code.toLowerCase()}`,
      code,
      description,
      elementId: elementIdValue,
      provenance: "MISSING_INFORMATION",
      sourceReferences: [],
    });
  };
  const unpriced = items.find(({ pricing }) => pricing.status !== "PRICE_CONFIRMED_BY_PROFESSIONAL");
  if (unpriced) add("PROFESSIONAL_PRICE_MISSING", "Professional pricing remains unconfirmed.", unpriced.id);
  const pendingMaterial = materials.find(({ responsibility }) => responsibility === "PENDING_SELECTION");
  if (pendingMaterial) add("MATERIAL_RESPONSIBILITY_PENDING", "Material responsibility remains pending.", pendingMaterial.id);
  const confirmedTotal = context.professionalInput.terms.confirmedTotalMinor;
  if (confirmedTotal != null && confirmedTotal !== totals.totalMinor) {
    add("CONFIRMED_TOTAL_MISMATCH", "Confirmed line pricing does not equal the professional-entered total.");
  }
  if (!items.length) add("SCOPE_CONFIRMATION_REQUIRED", "Professional scope confirmation is required.");
  return output;
}

function parseQuoteComposeResult(providerResult, { semanticInput, operationId } = {}) {
  const payload = parseProviderPayload(providerResult);
  walkForAuthority(payload);
  assertExactKeys(payload, [
    "schemaVersion",
    "summary",
    "scopeSections",
    "proposedScopeItems",
    "materials",
    "exclusions",
    "assumptions",
    "separateProposals",
    "commercialMissingInformation",
    "workflowConditions",
    "warnings",
    "confidence",
  ]);
  if (payload.schemaVersion !== 1) throw resultError("Unsupported Quote proposal version.");
  const arrayKeys = [
    "scopeSections",
    "proposedScopeItems",
    "materials",
    "exclusions",
    "assumptions",
    "separateProposals",
    "commercialMissingInformation",
    "workflowConditions",
    "warnings",
  ];
  if (arrayKeys.some((key) => !Array.isArray(payload[key]) || payload[key].length > MAX_ELEMENTS)) {
    throw resultError("Quote proposal arrays exceed operation bounds.");
  }
  const context = semanticInput.context;
  const catalog = collectReferenceCatalog(context);
  const pricingByKey = new Map(
    context.professionalInput.pricingInputs.map((item) => [item.key, item])
  );
  const scopeSections = payload.scopeSections.map((value) => {
    assertExactKeys(value, ["id", "title", "provenance", "sourceReferences"]);
    const sourceReferences = normalizeReferences(value.sourceReferences, catalog);
    return {
      id: elementId(value.id),
      title: boundedText(value.title, 200),
      provenance: normalizeProvenance(value.provenance, sourceReferences, context),
      sourceReferences,
    };
  });
  const sectionIds = new Set(scopeSections.map(({ id }) => id));
  const proposedScopeItems = payload.proposedScopeItems.map((value) =>
    normalizeScopeItem(value, catalog, context, pricingByKey)
  );
  if (proposedScopeItems.some(({ sectionId }) => !sectionIds.has(sectionId))) {
    throw resultError("A scope item references an unknown section.");
  }
  const materials = payload.materials.map((value) => {
    assertExactKeys(value, ["id", "description", "responsibility", "provenance", "sourceReferences"]);
    const sourceReferences = normalizeReferences(value.sourceReferences, catalog);
    const responsibility = String(value.responsibility || "").trim().toUpperCase();
    if (!MATERIAL_RESPONSIBILITIES.has(responsibility)) {
      throw resultError("Invalid material responsibility.");
    }
    return {
      id: elementId(value.id),
      description: boundedText(value.description, 500),
      responsibility,
      provenance: normalizeProvenance(value.provenance, sourceReferences, context),
      sourceReferences,
    };
  });
  const exclusions = payload.exclusions.map((value) => normalizeSourcedElement(value, catalog, context));
  const assumptions = payload.assumptions.map((value) => normalizeSourcedElement(value, catalog, context));
  const separateProposals = payload.separateProposals.map((value) => normalizeSourcedElement(value, catalog, context));
  const missing = payload.commercialMissingInformation.map((value) => {
    assertExactKeys(value, ["id", "code", "description", "provenance", "sourceReferences"], ["elementId"]);
    const normalized = normalizeSourcedElement({
      id: value.id,
      description: value.description,
      provenance: value.provenance,
      sourceReferences: value.sourceReferences,
    }, catalog, context);
    const code = String(value.code || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(code)) throw resultError("Invalid missing-information code.");
    return { ...normalized, code, elementId: value.elementId == null ? null : elementId(value.elementId) };
  });
  const workflowConditions = payload.workflowConditions.map((value) =>
    normalizeWorkflowCondition(value, catalog, context)
  );
  const warnings = payload.warnings.map((value) => {
    assertExactKeys(value, ["code", "message"]);
    const code = String(value.code || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,79}$/.test(code)) throw resultError("Invalid warning code.");
    return { code, message: boundedText(value.message, 500) };
  });
  assertExactKeys(payload.confidence, ["score", "rationale"]);
  if (!Number.isFinite(payload.confidence.score) || payload.confidence.score < 0 || payload.confidence.score > 1) {
    throw resultError("Invalid proposal confidence.");
  }
  const confidence = {
    score: payload.confidence.score,
    rationale: boundedText(payload.confidence.rationale, 500),
  };
  ensureUniqueIds([
    scopeSections,
    proposedScopeItems,
    materials,
    exclusions,
    assumptions,
    separateProposals,
    missing,
    workflowConditions,
  ]);

  const totals = totalsFor(proposedScopeItems);
  const commercialMissingInformation = appendServerMissingInformation(
    proposedScopeItems,
    materials,
    missing,
    totals,
    context
  );
  const confirmedTotal = context.professionalInput.terms.confirmedTotalMinor;
  const professionalConfirmedTotalMinor = confirmedTotal != null && confirmedTotal === totals.totalMinor
    ? confirmedTotal
    : null;
  const depositPercent = context.professionalInput.terms.depositPercent;
  const advisoryDeposit = depositPercent != null && professionalConfirmedTotalMinor != null
    ? {
        percent: depositPercent,
        depositMinor: Math.round(professionalConfirmedTotalMinor * depositPercent / 100),
        balanceMinor: professionalConfirmedTotalMinor - Math.round(professionalConfirmedTotalMinor * depositPercent / 100),
        state: "ADVISORY_NOT_SATISFIED",
      }
    : null;
  const availability = context.professionalInput.terms.availability
    ? {
        description: context.professionalInput.terms.availability,
        state: "CONDITIONAL_NOT_SCHEDULED",
      }
    : null;

  return {
    schemaVersion: 1,
    proposalId: operationId,
    proposalVersion: 1,
    authorityClassification: "ADVISORY_NON_CANONICAL",
    jobId: context.job.id,
    generatedAt: new Date().toISOString(),
    generatedFor: {
      professionalParticipantId: context.generatedFor.professionalParticipantId,
    },
    sourceContextFingerprint: context.sourceContextFingerprint,
    summary: boundedText(payload.summary, 1200),
    scopeSections,
    proposedScopeItems,
    materials,
    exclusions,
    assumptions,
    separateProposals,
    pricing: {
      ...totals,
      professionalConfirmedTotalMinor,
      status: commercialMissingInformation.some(({ code }) => code === "PROFESSIONAL_PRICE_MISSING")
        ? "INCOMPLETE"
        : "PROFESSIONALLY_CONFIRMED_INPUTS",
      advisoryDeposit,
    },
    commercialMissingInformation,
    workflowConditions,
    availabilityContext: availability,
    warnings,
    provenance: {
      classifications: [...PROVENANCE],
      sourceReferenceCount: new Set(
        proposedScopeItems.flatMap(({ sourceReferences }) => sourceReferences.map(referenceKey))
      ).size,
    },
    confidence,
    reviewContract: {
      states: ["ACCEPTED", "EDITED", "REJECTED"],
      customerApproval: false,
      professionalConfirmationRequired: true,
    },
    humanToCanonicalBoundary: {
      directMutationAllowed: false,
      confirmedPayloadOnly: true,
      requiredCanonicalCommands: ["quote.draft.create", "quote.scope.add"],
      prohibitedCanonicalCommands: [
        "quote.issue",
        "quote.customer.approve",
        "quote.customer.decline",
      ],
    },
    observability: {
      operation: QUOTE_COMPOSE_OPERATION,
      proposalId: operationId,
      sourceContextFingerprint: context.sourceContextFingerprint,
      missingInformationCount: commercialMissingInformation.length,
      acceptedCount: 0,
      editedCount: 0,
      rejectedCount: 0,
    },
    learningContext: {
      industry: context.job.serviceDomain || null,
      businessType: null,
      serviceType: context.job.serviceSpecialty || context.canonical.evaluation?.serviceType || null,
      context: "quote_composition",
      business: null,
      professional: context.generatedFor.professionalParticipantId,
      job: context.job.id,
      learnedPatternIsCanonicalRule: false,
    },
  };
}

function buildConfirmedCompositionPayload(proposal, feedback = []) {
  if (!isPlainObject(proposal) || proposal.authorityClassification !== "ADVISORY_NON_CANONICAL") {
    throw resultError("A governed advisory proposal is required.");
  }
  if (!Array.isArray(feedback)) throw resultError("Professional feedback is required.");
  const latestByElement = new Map();
  for (const event of feedback) {
    assertExactKeys(event, ["elementId", "action"], ["editedValue"]);
    const action = String(event.action || "").trim().toUpperCase();
    if (!["ACCEPTED", "EDITED", "REJECTED"].includes(action)) {
      throw resultError("Invalid professional feedback state.");
    }
    if ((action === "EDITED") !== Object.hasOwn(event, "editedValue")) {
      throw resultError("Edited feedback requires exactly one edited value.");
    }
    latestByElement.set(elementId(event.elementId), { ...event, action });
  }
  const scopeItems = [];
  for (const item of proposal.proposedScopeItems || []) {
    const event = latestByElement.get(item.id);
    if (!event || event.action === "REJECTED") continue;
    const candidate = event.action === "EDITED" ? event.editedValue : item.canonicalCandidate;
    const validated = validateScopeItem(candidate);
    if (validated.error) throw resultError("Confirmed scope input is not canonical-command compatible.");
    scopeItems.push(validated.item);
  }
  return {
    schemaVersion: 1,
    mode: "PROFESSIONAL_CONFIRMED_INPUT",
    proposalId: proposal.proposalId,
    jobId: proposal.jobId,
    sourceContextFingerprint: proposal.sourceContextFingerprint,
    scopeItems,
    directMutationPerformed: false,
    requiredCanonicalCommands: ["quote.draft.create", "quote.scope.add"],
    issueAuthorized: false,
    customerDecisionAuthorized: false,
  };
}

function buildQuoteComposeProviderRequest({ semanticInput, engineContext }) {
  return {
    schemaVersion: 1,
    operation: QUOTE_COMPOSE_OPERATION,
    capability: QUOTE_COMPOSE_CAPABILITY,
    locale: semanticInput.locale,
    mode: "ADVISORY",
    canonicalJobContext: semanticInput.context,
    operationContext: engineContext,
    instructions: {
      output: "strict_structured_json",
      authority: "advisory_noncanonical",
      requirements: [
        "preserve_exact_source_references",
        "preserve_temporary_open_deferred_and_separate_work_semantics",
        "use_only_professional_pricing_inputs_as_confirmed_prices",
        "identify_missing_information_instead_of_fabricating",
        "keep_customer_supplied_material_separate",
      ],
      prohibitedActions: [
        "create_or_mutate_quote",
        "issue_quote",
        "approve_or_decline_quote",
        "satisfy_payment_or_deposit",
        "schedule_work",
        "resolve_finding",
        "complete_workstream_or_job",
        "treat_communication_as_authority",
        "treat_recommendation_currency_text_as_price",
        "discount_from_budget_context",
      ],
    },
  };
}

const quoteComposeEngines = Object.freeze([
  Object.freeze({
    id: "quote_composition_advisory",
    async collectContext() {
      return {
        mode: "ADVISORY",
        canonicalMutationAllowed: false,
        pricingAuthority: "professional_input_only",
      };
    },
  }),
  Object.freeze({
    id: "quote_composition_authority_boundary",
    async collectContext() {
      return {
        issueAllowed: false,
        customerDecisionAllowed: false,
        paymentAllowed: false,
        schedulingAllowed: false,
        lifecycleMutationAllowed: false,
      };
    },
  }),
]);


function quoteComposeContextError(
  code,
  message
) {
  return Object.assign(
    new Error(message),
    { code }
  );
}

function estimateReviewReference(
  proposalId,
  elementId
) {
  return {
    type: "ESTIMATE_REVIEW",
    id:
      `${proposalId}:${elementId}`,
    version: 1,
  };
}

function sanitizeReviewedEstimateForQuote(
  reviewedEstimate
) {
  if (
    !isPlainObject(
      reviewedEstimate
    ) ||
    reviewedEstimate
      .authorityClassification !==
      "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL" ||
    reviewedEstimate
      .canonicalMutationPerformed !==
      false ||
    reviewedEstimate
      .humanToCanonicalBoundary
      ?.directMutationAllowed !==
      false ||
    !isPlainObject(
      reviewedEstimate.reviewed
    )
  ) {
    return null;
  }

  const proposalId =
    String(
      reviewedEstimate.proposalId ||
        ""
    ).trim();

  if (!proposalId) {
    return null;
  }

  const safeId = (value) => {
    const normalized =
      typeof value === "string"
        ? value.trim().toLowerCase()
        : "";

    return ELEMENT_ID_PATTERN.test(
      normalized
    )
      ? normalized
      : "";
  };

  const projectDescriptionItems = (
    values,
    {
      includeMaterialDetails = false,
    } = {}
  ) => {
    if (!Array.isArray(values)) {
      return null;
    }

    const projected = [];

    for (const value of values) {
      if (!isPlainObject(value)) {
        return null;
      }

      const id =
        safeId(value.id);

      const description =
        typeof value.description ===
          "string"
          ? value.description.trim()
          : "";

      if (
        !id ||
        !description ||
        description.length > 1000
      ) {
        return null;
      }

      const item = {
        id,
        description,
        provenance:
          "AI_SUGGESTED",
        sourceReferences: [
          estimateReviewReference(
            proposalId,
            id
          ),
        ],
      };

      if (includeMaterialDetails) {
        const quantity =
          Number(value.quantity);

        if (
          Number.isFinite(
            quantity
          ) &&
          quantity > 0
        ) {
          item.quantity =
            quantity;
        }

        if (
          typeof value.unit ===
            "string" &&
          value.unit.trim()
        ) {
          item.unit =
            value.unit
              .trim()
              .slice(0, 80);
        }

        if (
          typeof value.assumption ===
            "string" &&
          value.assumption.trim()
        ) {
          item.assumption =
            value.assumption
              .trim()
              .slice(0, 500);
        }

        item.needsVerification =
          value.needsVerification ===
            true;
      } else if (
        typeof value.assumption ===
          "string" &&
        value.assumption.trim()
      ) {
        item.assumption =
          value.assumption
            .trim()
            .slice(0, 500);
      }

      projected.push(item);
    }

    return projected;
  };

  const materials =
    projectDescriptionItems(
      reviewedEstimate
        .reviewed
        .materials,
      {
        includeMaterialDetails:
          true,
      }
    );

  const labor =
    projectDescriptionItems(
      reviewedEstimate
        .reviewed
        .labor
    );

  if (
    !materials ||
    !labor
  ) {
    return null;
  }

  const assumptionsInput =
    reviewedEstimate
      .reviewed
      .assumptions;

  if (
    !Array.isArray(
      assumptionsInput
    )
  ) {
    return null;
  }

  const assumptions = [];

  for (
    const value of
      assumptionsInput
  ) {
    if (!isPlainObject(value)) {
      return null;
    }

    const id =
      safeId(value.id);

    const text =
      typeof value.text ===
        "string"
        ? value.text.trim()
        : "";

    if (
      !id ||
      !text ||
      text.length > 1000
    ) {
      return null;
    }

    assumptions.push({
      id,
      text,
      classification:
        String(
          value.classification ||
            "NEEDS_VERIFICATION"
        )
          .trim()
          .toUpperCase(),
      provenance:
        "AI_SUGGESTED",
      sourceReferences: [
        estimateReviewReference(
          proposalId,
          id
        ),
      ],
    });
  }

  let customerQuoteDraft =
    null;

  const sourceDraft =
    reviewedEstimate
      .reviewed
      .customerQuoteDraft;

  if (sourceDraft != null) {
    if (!isPlainObject(sourceDraft)) {
      return null;
    }

    const id =
      safeId(
        sourceDraft.id
      );

    if (!id) {
      return null;
    }

    const textField = (
      key,
      maximum
    ) => {
      const value =
        sourceDraft[key];

      if (
        typeof value !==
          "string"
      ) {
        return "";
      }

      return value
        .trim()
        .slice(
          0,
          maximum
        );
    };

    const stringArray = (
      key
    ) => {
      const values =
        sourceDraft[key];

      if (!Array.isArray(values)) {
        return null;
      }

      return values
        .filter(
          (value) =>
            typeof value ===
              "string"
        )
        .map(
          (value) =>
            value
              .trim()
              .slice(
                0,
                1000
              )
        );
    };

    const conditions =
      stringArray(
        "conditions"
      );

    const exclusions =
      stringArray(
        "exclusions"
      );

    if (
      !conditions ||
      !exclusions
    ) {
      return null;
    }

    customerQuoteDraft = {
      id,
      scopeSummary:
        textField(
          "scopeSummary",
          3000
        ),
      conditions,
      exclusions,
      durationGuidance:
        textField(
          "durationGuidance",
          500
        ),
      customerWording:
        textField(
          "customerWording",
          3000
        ),
      provenance:
        "AI_SUGGESTED",
      sourceReferences: [
        estimateReviewReference(
          proposalId,
          id
        ),
      ],
    };
  }

  return {
    schemaVersion: 1,
    proposalId,
    authorityClassification:
      "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL",
    sourceProposalAuthorityClassification:
      reviewedEstimate
        .sourceProposalAuthorityClassification,
    pricingAuthority:
      "PROFESSIONAL_INPUT_ONLY",
    reviewedScope: {
      materials,
      labor,
      assumptions,
      customerQuoteDraft,
    },
    reviewedElementIds:
      Array.isArray(
        reviewedEstimate
          .reviewedElementIds
      )
        ? [
            ...reviewedEstimate
              .reviewedElementIds,
          ]
        : [],
    rejectedElementIds:
      Array.isArray(
        reviewedEstimate
          .rejectedElementIds
      )
        ? [
            ...reviewedEstimate
              .rejectedElementIds,
          ]
        : [],
    unreviewedElementIds:
      Array.isArray(
        reviewedEstimate
          .unreviewedElementIds
      )
        ? [
            ...reviewedEstimate
              .unreviewedElementIds,
          ]
        : [],
    humanToCanonicalBoundary: {
      directMutationAllowed:
        false,
      quoteCompositionRequiresExplicitProfessionalAction:
        true,
    },
    canonicalMutationPerformed:
      false,
  };
}

async function buildQuoteComposeContext({
  context,
  input,
  runtimeContext,
}) {
  if (
    !isPlainObject(input)
  ) {
    return assembleQuoteCompositionContext({
      context,
      input,
      runtimeContext,
    });
  }

  const hasEstimateProposal =
    Object.hasOwn(
      input,
      "estimateProposalId"
    );

  const {
    estimateProposalId,
    ...baseInput
  } = input;

  const baseContext =
    await assembleQuoteCompositionContext({
      context,
      input:
        baseInput,
      runtimeContext,
    });

  if (!hasEstimateProposal) {
    return baseContext;
  }

  const normalizedProposalId =
    typeof estimateProposalId ===
      "string"
      ? estimateProposalId
          .trim()
          .toLowerCase()
      : "";

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(
        normalizedProposalId
      )
  ) {
    throw quoteComposeContextError(
      "intelligence_estimate_solution_ready_invalid",
      "A valid reviewed Internal Estimate is required."
    );
  }

  const service =
    runtimeContext
      ?.estimateSolutionReadyService ||
    canonicalEstimateSolutionReadyService;

  if (
    !service ||
    typeof service
      .prepareReviewedEstimate !==
      "function"
  ) {
    throw quoteComposeContextError(
      "required_engine_failure",
      "Reviewed Internal Estimate authority is unavailable."
    );
  }

  const prepared =
    await service
      .prepareReviewedEstimate({
        pool:
          runtimeContext?.pool,
        authenticatedActor:
          runtimeContext
            ?.authenticatedActor,
        proposalId:
          normalizedProposalId,
      });

  if (
    !prepared?.ok ||
    !prepared.reviewedEstimate
  ) {
    const code =
      prepared?.status === 403
        ? "intelligence_quote_authority_required"
        : prepared?.status === 404
        ? "intelligence_estimate_solution_ready_unavailable"
        : "intelligence_estimate_solution_ready_invalid";

    throw quoteComposeContextError(
      code,
      prepared?.message ||
        "The reviewed Internal Estimate is unavailable."
    );
  }

  if (
    String(
      prepared
        .reviewedEstimate
        .jobId ||
        ""
    ) !==
    String(
      baseContext.job.id
    )
  ) {
    throw quoteComposeContextError(
      "intelligence_estimate_solution_ready_job_mismatch",
      "The reviewed Internal Estimate does not belong to this Job."
    );
  }

  const reviewedEstimate =
    sanitizeReviewedEstimateForQuote(
      prepared
        .reviewedEstimate
    );

  if (!reviewedEstimate) {
    throw quoteComposeContextError(
      "intelligence_estimate_solution_ready_invalid",
      "The reviewed Internal Estimate is invalid."
    );
  }

  const {
    sourceContextFingerprint:
      _priorFingerprint,
    ...base
  } = baseContext;

  const assembled = {
    ...base,
    reviewedEstimate,
  };

  return {
    ...assembled,
    sourceContextFingerprint:
      sourceContextFingerprint(
        assembled
      ),
  };
}

const quoteComposeOperationDefinition = Object.freeze({
  operation: QUOTE_COMPOSE_OPERATION,
  capability: QUOTE_COMPOSE_CAPABILITY,
  supportedRoles: Object.freeze(["professional"]),
  engineIds: QUOTE_COMPOSE_ENGINE_IDS,
  providerName: QUOTE_COMPOSE_PROVIDER,
  roleAuthorization: "context_builder",
  buildContext: buildQuoteComposeContext,
  buildProviderRequest: buildQuoteComposeProviderRequest,
  parseResult: parseQuoteComposeResult,
});

module.exports = {
  PROVENANCE,
  QUOTE_COMPOSE_CAPABILITY,
  QUOTE_COMPOSE_ENGINE_IDS,
  QUOTE_COMPOSE_OPERATION,
  QUOTE_COMPOSE_PROVIDER,
  buildConfirmedCompositionPayload,
  buildQuoteComposeContext,
  buildQuoteComposeProviderRequest,
  parseQuoteComposeResult,
  sanitizeReviewedEstimateForQuote,
  quoteComposeEngines,
  quoteComposeOperationDefinition,
};
