"use strict";

const {
  SUPPORTED_REQUEST_DOMAINS,
  getRequestServiceDomain,
  isSupportedRequestService,
  normalizeRequestServiceId,
} = require("../../requests/serviceCompatibility");
const { isPlainObject } = require("../intelligenceGatewayContracts");

const JOB_REQUEST_INTERPRET_OPERATION = "job_request.interpret";
const JOB_REQUEST_INTERPRET_CAPABILITY = "job_request.interpret";
const JOB_REQUEST_INTERPRET_PROVIDER = "job_request";
const JOB_REQUEST_INTERPRET_ENGINE_IDS = Object.freeze([
  "job_request_capability",
  "job_request_validation",
]);
const JOB_REQUEST_INTERPRET_PATCH_PATHS = Object.freeze([
  "job.title",
  "job.description",
  "service.category",
  "service.requestCategory",
  "service.domain",
  "service.specialty",
  "location.affectedArea",
  "location.city",
  "location.region",
  "location.postalCode",
  "timing.urgency",
  "timing.desiredTiming",
  "timing.availability",
  "details.measurements",
  "details.expectations",
  "details.additionalNotes",
]);
const PATCH_PATHS = new Set(JOB_REQUEST_INTERPRET_PATCH_PATHS);
const SERVICE_PATCH_PATHS = new Set([
  "service.category",
  "service.requestCategory",
  "service.domain",
  "service.specialty",
]);
const CURRENT_PROVENANCE = new Set([
  "user_entered",
  "assistant_suggested",
  "assistant_inferred",
  "system_derived",
  "legacy_migrated",
]);
const CURRENT_UNCERTAINTY = new Set([
  "known",
  "approximate",
  "uncertain",
  "assistant_suggested",
]);
const PROPOSED_PROVENANCE = new Set([
  "assistant_suggested",
  "assistant_inferred",
]);
const PROPOSED_UNCERTAINTY = new Set([
  "assistant_suggested",
  "approximate",
  "uncertain",
]);
const PATCH_VALUE_LIMITS = Object.freeze({
  "job.title": 160,
  "job.description": 4000,
  "service.category": 120,
  "service.requestCategory": 120,
  "service.domain": 80,
  "service.specialty": 120,
  "location.affectedArea": 200,
  "location.city": 120,
  "location.region": 120,
  "location.postalCode": 32,
  "timing.urgency": 120,
  "timing.desiredTiming": 300,
  "timing.availability": 500,
  "details.measurements": 1000,
  "details.expectations": 2000,
  "details.additionalNotes": 2000,
});
const MAX_HOMEOWNER_TEXT_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 600;
const MAX_RATIONALE_LENGTH = 300;
const MAX_CLARIFICATIONS = 3;
const MAX_WARNINGS = 5;
const MAX_QUESTION_LENGTH = 300;
const MAX_WARNING_LENGTH = 300;
const WARNING_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

function operationError(message, code) {
  return Object.assign(new Error(message), { code });
}

function contextError(message) {
  return operationError(message, "intelligence_context_invalid");
}

function resultError(message) {
  return operationError(message, "malformed_operation_result");
}

function assertExactKeys(value, required, optional = [], errorFactory = resultError) {
  if (!isPlainObject(value)) throw errorFactory("Expected a plain object.");
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw errorFactory("Object fields do not match the operation schema.");
  }
  return value;
}

function boundedText(value, maxLength, errorFactory, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || value !== value.trim() || value.length > maxLength) {
    throw errorFactory("Text does not match the operation bounds.");
  }
  if (!allowEmpty && !value) throw errorFactory("Required text is missing.");
  return value;
}

function normalizeContextGroup(value, keys) {
  assertExactKeys(value, keys.map(({ name }) => name), [], contextError);
  return Object.fromEntries(
    keys.map((key) => {
      const path = key.path;
      return [key.name, boundedText(value[key.name], PATCH_VALUE_LIMITS[path], contextError)];
    })
  );
}

function normalizeLocationContext(value) {
  assertExactKeys(
    value,
    ["affectedArea"],
    ["city", "region", "postalCode"],
    contextError
  );
  return {
    affectedArea: boundedText(
      value.affectedArea,
      PATCH_VALUE_LIMITS["location.affectedArea"],
      contextError
    ),
    city: boundedText(
      value.city || "",
      PATCH_VALUE_LIMITS["location.city"],
      contextError
    ),
    region: boundedText(
      value.region || "",
      PATCH_VALUE_LIMITS["location.region"],
      contextError
    ),
    postalCode: boundedText(
      value.postalCode || "",
      PATCH_VALUE_LIMITS["location.postalCode"],
      contextError
    ),
  };
}

function normalizeJobRequestDraftContext(context, input) {
  assertExactKeys(input, ["text"], [], contextError);
  boundedText(input.text, MAX_HOMEOWNER_TEXT_LENGTH, contextError, { allowEmpty: false });
  assertExactKeys(context, ["draft"], [], contextError);
  const draft = assertExactKeys(
    context.draft,
    [
      "version",
      "job",
      "service",
      "location",
      "timing",
      "details",
      "fieldState",
      "photosAttached",
    ],
    [],
    contextError
  );
  if (draft.version !== 1 || typeof draft.photosAttached !== "boolean") {
    throw contextError("Unsupported Job Request draft context.");
  }

  const fieldState = draft.fieldState;
  if (!Array.isArray(fieldState) || fieldState.length > JOB_REQUEST_INTERPRET_PATCH_PATHS.length) {
    throw contextError("Invalid Job Request field state.");
  }
  const seenPaths = new Set();
  const normalizedFieldState = fieldState.map((field) => {
    assertExactKeys(
      field,
      ["path", "provenance", "confirmed", "uncertainty"],
      [],
      contextError
    );
    if (
      !PATCH_PATHS.has(field.path) ||
      seenPaths.has(field.path) ||
      !CURRENT_PROVENANCE.has(field.provenance) ||
      typeof field.confirmed !== "boolean" ||
      !CURRENT_UNCERTAINTY.has(field.uncertainty)
    ) {
      throw contextError("Invalid Job Request field state.");
    }
    seenPaths.add(field.path);
    return {
      path: field.path,
      provenance: field.provenance,
      confirmed: field.confirmed,
      uncertainty: field.uncertainty,
    };
  });

  return {
    version: 1,
    job: normalizeContextGroup(draft.job, [
      { name: "title", path: "job.title" },
      { name: "description", path: "job.description" },
    ]),
    service: normalizeContextGroup(draft.service, [
      { name: "category", path: "service.category" },
      { name: "requestCategory", path: "service.requestCategory" },
      { name: "domain", path: "service.domain" },
      { name: "specialty", path: "service.specialty" },
    ]),
    location: normalizeLocationContext(draft.location),
    timing: normalizeContextGroup(draft.timing, [
      { name: "urgency", path: "timing.urgency" },
      { name: "desiredTiming", path: "timing.desiredTiming" },
      { name: "availability", path: "timing.availability" },
    ]),
    details: normalizeContextGroup(draft.details, [
      { name: "measurements", path: "details.measurements" },
      { name: "expectations", path: "details.expectations" },
      { name: "additionalNotes", path: "details.additionalNotes" },
    ]),
    fieldState: normalizedFieldState,
    photosAttached: draft.photosAttached,
  };
}

function buildJobRequestInterpretContext({ context, input }) {
  return { draft: normalizeJobRequestDraftContext(context, input) };
}

function buildJobRequestInterpretProviderRequest({ semanticInput, engineContext }) {
  return {
    schemaVersion: 1,
    operation: JOB_REQUEST_INTERPRET_OPERATION,
    capability: JOB_REQUEST_INTERPRET_CAPABILITY,
    locale: semanticInput.locale,
    homeownerText: semanticInput.input.text,
    currentDraft: semanticInput.context.draft,
    operationContext: {
      capability: engineContext.job_request_capability,
      validation: engineContext.job_request_validation,
    },
    instructions: {
      authority: "proposal_only",
      output: "structured_json",
      allowedPatchPaths: [...JOB_REQUEST_INTERPRET_PATCH_PATHS],
      allowedProvenance: [...PROPOSED_PROVENANCE],
      allowedUncertainty: [...PROPOSED_UNCERTAINTY],
      requirements: [
        "preserve_uncertainty",
        "require_homeowner_confirmation",
        "avoid_professional_diagnosis",
        "ask_bounded_clarifications",
        "extract_all_homeowner_supplied_facts_before_clarifying",
        "do_not_ask_for_information_already_supplied_or_present",
        "do_not_infer_unsupplied_location_details",
        "do_not_invent_price_diagnosis_repair_method_or_materials",
      ],
      prohibitedActions: [
        "submit_job_request",
        "select_professional",
        "create_domain_state",
        "interpret_media",
        "estimate_price",
      ],
    },
  };
}

function parseProviderPayload(providerResult) {
  if (typeof providerResult === "string") {
    try {
      return JSON.parse(providerResult);
    } catch {
      throw resultError("Provider output is not valid JSON.");
    }
  }
  return providerResult;
}

function normalizePatch(field) {
  assertExactKeys(
    field,
    [
      "path",
      "value",
      "provenance",
      "confidence",
      "uncertainty",
      "requiresConfirmation",
    ],
    ["rationale"]
  );
  if (!PATCH_PATHS.has(field.path)) throw resultError("Unsupported draft patch path.");
  const value = boundedText(
    field.value,
    PATCH_VALUE_LIMITS[field.path],
    resultError,
    { allowEmpty: false }
  );
  if (!PROPOSED_PROVENANCE.has(field.provenance)) {
    throw resultError("Unsupported proposal provenance.");
  }
  if (!Number.isFinite(field.confidence) || field.confidence < 0 || field.confidence > 1) {
    throw resultError("Invalid proposal confidence.");
  }
  if (!PROPOSED_UNCERTAINTY.has(field.uncertainty)) {
    throw resultError("Unsupported proposal uncertainty.");
  }
  if (field.requiresConfirmation !== true) {
    throw resultError("Provider proposals must require confirmation.");
  }
  const normalized = {
    path: field.path,
    value,
    provenance: field.provenance,
    confidence: field.confidence,
    uncertainty: field.uncertainty,
    requiresConfirmation: true,
  };
  if (Object.hasOwn(field, "rationale")) {
    normalized.rationale = boundedText(field.rationale, MAX_RATIONALE_LENGTH, resultError);
  }
  return normalized;
}

function normalizeClarification(value) {
  assertExactKeys(value, ["question"], ["fieldPath"]);
  const clarification = {
    question: boundedText(value.question, MAX_QUESTION_LENGTH, resultError, { allowEmpty: false }),
  };
  if (Object.hasOwn(value, "fieldPath")) {
    if (!PATCH_PATHS.has(value.fieldPath)) {
      throw resultError("Unsupported clarification field path.");
    }
    clarification.fieldPath = value.fieldPath;
  }
  return clarification;
}

function normalizeWarning(value) {
  assertExactKeys(value, ["code", "message"]);
  if (typeof value.code !== "string" || !WARNING_CODE_PATTERN.test(value.code)) {
    throw resultError("Invalid warning code.");
  }
  return {
    code: value.code,
    message: boundedText(value.message, MAX_WARNING_LENGTH, resultError, { allowEmpty: false }),
  };
}

function draftValueAtPath(draft, path) {
  return String(path || "")
    .split(".")
    .reduce((cursor, key) => cursor?.[key], draft);
}

function removeRedundantClarifications(clarifications, patches, currentDraft = {}) {
  const proposedPaths = new Set(patches.map(({ path }) => path));
  return clarifications.filter((clarification) => {
    if (!clarification.fieldPath) return true;
    if (proposedPaths.has(clarification.fieldPath)) return false;
    return !String(draftValueAtPath(currentDraft, clarification.fieldPath) || "").trim();
  });
}

function validateServicePatches(patches, currentService = {}) {
  const servicePatches = patches.filter((patch) => SERVICE_PATCH_PATHS.has(patch.path));
  if (!servicePatches.length) return { patches, taxonomyRejected: false };

  const proposed = Object.fromEntries(
    servicePatches.map((patch) => [patch.path.slice("service.".length), patch.value])
  );
  const specialty = normalizeRequestServiceId(
    proposed.specialty || String(currentService.specialty || "")
  );
  const domain = String(proposed.domain || currentService.domain || "").trim().toLowerCase();
  const additionalIdentifiers = ["category", "requestCategory"]
    .filter((key) => Object.hasOwn(proposed, key))
    .map((key) => normalizeRequestServiceId(proposed[key]));
  const specialtyDomain = getRequestServiceDomain(specialty);
  const identifiersValid = additionalIdentifiers.every(
    (identifier) =>
      isSupportedRequestService(identifier) &&
      getRequestServiceDomain(identifier) === specialtyDomain
  );
  const valid = Boolean(
    specialty &&
    isSupportedRequestService(specialty) &&
    specialtyDomain &&
    identifiersValid &&
    (!domain || (SUPPORTED_REQUEST_DOMAINS.includes(domain) && domain === specialtyDomain))
  );

  if (!valid) {
    return {
      patches: patches.filter((patch) => !SERVICE_PATCH_PATHS.has(patch.path)),
      taxonomyRejected: true,
    };
  }

  const normalizedPatches = patches.map((patch) => {
    if (!SERVICE_PATCH_PATHS.has(patch.path)) return patch;
    const isDomain = patch.path === "service.domain";
    return {
      ...patch,
      value: isDomain ? patch.value.toLowerCase() : normalizeRequestServiceId(patch.value),
      taxonomy: {
        validated: true,
        vocabulary: isDomain ? "request_domain" : "request_service",
      },
    };
  });
  return { patches: normalizedPatches, taxonomyRejected: false };
}

function parseJobRequestInterpretResult(providerResult, { semanticInput } = {}) {
  const payload = parseProviderPayload(providerResult);
  assertExactKeys(
    payload,
    ["schemaVersion", "summary", "draftPatch", "clarifications", "warnings"]
  );
  if (payload.schemaVersion !== 1) throw resultError("Unsupported provider result version.");
  const summary = boundedText(payload.summary, MAX_SUMMARY_LENGTH, resultError, {
    allowEmpty: false,
  });
  assertExactKeys(payload.draftPatch, ["fields"]);
  if (
    !Array.isArray(payload.draftPatch.fields) ||
    payload.draftPatch.fields.length > JOB_REQUEST_INTERPRET_PATCH_PATHS.length ||
    !Array.isArray(payload.clarifications) ||
    payload.clarifications.length > MAX_CLARIFICATIONS ||
    !Array.isArray(payload.warnings) ||
    payload.warnings.length > MAX_WARNINGS
  ) {
    throw resultError("Provider result arrays exceed operation bounds.");
  }
  const patches = payload.draftPatch.fields.map(normalizePatch);
  if (new Set(patches.map(({ path }) => path)).size !== patches.length) {
    throw resultError("Duplicate draft patch path.");
  }
  const clarifications = removeRedundantClarifications(
    payload.clarifications.map(normalizeClarification),
    patches,
    semanticInput?.context?.draft || {}
  );
  const warnings = payload.warnings.map(normalizeWarning);
  const taxonomy = validateServicePatches(
    patches,
    semanticInput?.context?.draft?.service || {}
  );

  if (taxonomy.taxonomyRejected) {
    const taxonomyWarning = {
      code: "unsupported_service_classification",
      message: "The suggested service classification is not supported and was not applied.",
    };
    if (!warnings.some(({ code }) => code === taxonomyWarning.code)) {
      if (warnings.length === MAX_WARNINGS) warnings[MAX_WARNINGS - 1] = taxonomyWarning;
      else warnings.push(taxonomyWarning);
    }
    const taxonomyClarification = {
      question: "Which supported service best matches the work you need?",
      fieldPath: "service.specialty",
    };
    if (!clarifications.some(({ fieldPath }) => fieldPath === "service.specialty")) {
      if (clarifications.length === MAX_CLARIFICATIONS) {
        clarifications[MAX_CLARIFICATIONS - 1] = taxonomyClarification;
      } else {
        clarifications.push(taxonomyClarification);
      }
    }
  }

  return {
    schemaVersion: 1,
    summary,
    draftPatch: { fields: taxonomy.patches },
    clarifications,
    warnings,
    validation: {
      status: taxonomy.taxonomyRejected ? "accepted_with_warnings" : "accepted",
      taxonomy: "validated",
      patchCount: taxonomy.patches.length,
      clarificationCount: clarifications.length,
      warningCount: warnings.length,
    },
  };
}

const jobRequestInterpretEngines = Object.freeze([
  Object.freeze({
    id: "job_request_capability",
    async collectContext() {
      return {
        mode: "preparatory",
        mutationAllowed: false,
        mediaAllowed: false,
      };
    },
  }),
  Object.freeze({
    id: "job_request_validation",
    async collectContext() {
      return {
        schemaVersion: 1,
        taxonomy: "request_service",
        patchWhitelistEnforced: true,
      };
    },
  }),
]);

const jobRequestInterpretOperationDefinition = Object.freeze({
  operation: JOB_REQUEST_INTERPRET_OPERATION,
  capability: JOB_REQUEST_INTERPRET_CAPABILITY,
  supportedRoles: Object.freeze(["homeowner", "professional"]),
  roleAuthorization: "request_service",
  engineIds: JOB_REQUEST_INTERPRET_ENGINE_IDS,
  providerName: JOB_REQUEST_INTERPRET_PROVIDER,
  buildContext: buildJobRequestInterpretContext,
  buildProviderRequest: buildJobRequestInterpretProviderRequest,
  parseResult: parseJobRequestInterpretResult,
});

module.exports = {
  JOB_REQUEST_INTERPRET_CAPABILITY,
  JOB_REQUEST_INTERPRET_ENGINE_IDS,
  JOB_REQUEST_INTERPRET_OPERATION,
  JOB_REQUEST_INTERPRET_PATCH_PATHS,
  JOB_REQUEST_INTERPRET_PROVIDER,
  buildJobRequestInterpretContext,
  buildJobRequestInterpretProviderRequest,
  jobRequestInterpretEngines,
  jobRequestInterpretOperationDefinition,
  parseJobRequestInterpretResult,
};
