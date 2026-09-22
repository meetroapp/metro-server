"use strict";

const { isPlainObject } = require("../intelligenceGatewayContracts");

const EMERGENCY_REQUEST_INTERPRET_OPERATION = "emergency_request.interpret";
const EMERGENCY_REQUEST_INTERPRET_CAPABILITY = "emergency_request.interpret";
const EMERGENCY_REQUEST_INTERPRET_PROVIDER = "emergency_request";
const EMERGENCY_REQUEST_INTERPRET_ENGINE_IDS = Object.freeze([
  "emergency_request_capability",
  "emergency_request_validation",
]);
const EMERGENCY_REQUEST_INTERPRET_PATCH_PATHS = Object.freeze([
  "description",
  "service.specialty",
  "location.city",
  "location.region",
  "location.postalCode",
]);
const EMERGENCY_SPECIALTIES = Object.freeze([
  "emergency_plumbing",
  "emergency_electrical_service",
  "roof_leak_repair",
  "emergency_lockout",
  "handyman",
]);

const EMERGENCY_REQUEST_INTERPRET_STAGES = Object.freeze([
  "describe",
  "location",
]);

const STAGES = new Set(
  EMERGENCY_REQUEST_INTERPRET_STAGES
);

const STAGE_PATCH_PATHS = Object.freeze({
  describe: Object.freeze([
    "description",
    "service.specialty",
  ]),
  location: Object.freeze([
    "location.city",
    "location.region",
    "location.postalCode",
  ]),
});

const PATCH_PATHS = new Set(EMERGENCY_REQUEST_INTERPRET_PATCH_PATHS);
const SPECIALTIES = new Set(EMERGENCY_SPECIALTIES);
const PROVENANCE = new Set(["assistant_suggested", "assistant_inferred"]);
const UNCERTAINTY = new Set([
  "assistant_suggested",
  "approximate",
  "uncertain",
]);
const VALUE_LIMITS = Object.freeze({
  description: 4000,
  "service.specialty": 120,
  "location.city": 120,
  "location.region": 120,
  "location.postalCode": 32,
});
const MAX_TEXT_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 600;
const MAX_RATIONALE_LENGTH = 300;
const MAX_CLARIFICATIONS = 3;
const MAX_WARNINGS = 5;
const MAX_QUESTION_LENGTH = 300;
const MAX_WARNING_LENGTH = 300;
const WARNING_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const STREET_ADDRESS_PATTERN =
  /\b\d{1,6}\s+[a-z0-9][^,\n]{0,80}\b(?:street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|boulevard|blvd\.?|court|ct\.?|highway|hwy\.?|place|pl\.?|parkway|pkwy\.?|circle|cir\.?|terrace|ter\.?|trail|trl\.?|way|route|rt\.?)\b/i;

const PRIVATE_DETAIL_PATTERNS = Object.freeze([
  /\b(?:street|service|home|full|exact)\s+address\b/i,
  /\bunit\s+#?(?:\d+[a-z]?|[a-z])\b/i,
  /\b(?:unit|apartment|apt\.?|suite)\s+(?:number|#)\b/i,
  /\b(?:apartment|apt\.?|suite)\s+#?[a-z0-9-]{1,12}\b/i,
  /\b(?:gate|door|access|entry)\s*(?:code|pin)\b/i,
  /\baccess\s+instructions?\b/i,
  /\b(?:phone|telephone|mobile)\s+number\b/i,
  /\bemail\s+(?:address|contact)\b/i,
  /\bcontact\s+(?:information|info|details)\b/i,
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,
  /(?:^|[^\d])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/,
]);

const DESCRIBE_LOCATION_QUESTION_PATTERN =
  /\b(?:city|zip(?:\s+code)?|postal(?:\s+code)?|service\s+area|general\s+area)\b/i;

const PROVIDER_CONTACT_REQUEST_PATTERN =
  /\b(?:phone|telephone|email)\b|\bmobile\s+(?:number|phone|contact)\b|\bcontact\s+(?:details?|information|info|number)\b|\b(?:reach|contact)\s+(?:you|the\s+homeowner)\b/i;

function operationError(message, code) {
  return Object.assign(new Error(message), { code });
}

function contextError(message) {
  return operationError(message, "intelligence_context_invalid");
}

function resultError(message) {
  return operationError(message, "malformed_operation_result");
}

function containsPrivateDetail(value) {
  const text = String(value || "");
  return (
    STREET_ADDRESS_PATTERN.test(text) ||
    PRIVATE_DETAIL_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function rejectPrivateDetail(value, errorFactory = resultError) {
  if (containsPrivateDetail(value)) {
    throw errorFactory(
      "Emergency intake must not contain private location or contact details."
    );
  }
}

function rejectProviderPrivateDetail(value) {
  rejectPrivateDetail(value);
  if (PROVIDER_CONTACT_REQUEST_PATTERN.test(String(value || ""))) {
    throw resultError(
      "Emergency intake output must not request private contact details."
    );
  }
}

function assertExactKeys(value, required, optional = [], errorFactory = resultError) {
  if (!isPlainObject(value)) throw errorFactory("Expected a plain object.");
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

function boundedText(value, maximum, errorFactory, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || value !== value.trim() || value.length > maximum) {
    throw errorFactory("Text does not match the operation bounds.");
  }
  if (!allowEmpty && !value) throw errorFactory("Required text is missing.");
  return value;
}

function normalizeEmergencyIntakeContext(context, input) {
  assertExactKeys(input, ["text"], [], contextError);

  const homeownerText = boundedText(
    input.text,
    MAX_TEXT_LENGTH,
    contextError,
    { allowEmpty: false }
  );

  rejectPrivateDetail(homeownerText, contextError);

  assertExactKeys(
    context,
    ["intake", "stage"],
    [],
    contextError
  );

  const stage = boundedText(
    context.stage,
    32,
    contextError,
    { allowEmpty: false }
  );

  if (!STAGES.has(stage)) {
    throw contextError(
      "Unsupported Emergency intake stage."
    );
  }

  const intake = assertExactKeys(
    context.intake,
    ["description", "service", "location"],
    [],
    contextError
  );

  const service = assertExactKeys(
    intake.service,
    ["specialty"],
    [],
    contextError
  );

  const location = assertExactKeys(
    intake.location,
    ["city", "region", "postalCode"],
    [],
    contextError
  );

  const specialty = boundedText(
    service.specialty,
    VALUE_LIMITS["service.specialty"],
    contextError
  );

  if (specialty && !SPECIALTIES.has(specialty)) {
    throw contextError(
      "Unsupported Emergency specialty."
    );
  }

  const description = boundedText(
    intake.description,
    VALUE_LIMITS.description,
    contextError
  );

  const city = boundedText(
    location.city,
    VALUE_LIMITS["location.city"],
    contextError
  );

  const region = boundedText(
    location.region,
    VALUE_LIMITS["location.region"],
    contextError
  );

  const postalCode = boundedText(
    location.postalCode,
    VALUE_LIMITS["location.postalCode"],
    contextError
  );

  for (const value of [
    description,
    city,
    region,
    postalCode,
  ]) {
    rejectPrivateDetail(value, contextError);
  }

  return {
    stage,
    intake: {
      description,
      service: { specialty },
      location: {
        city,
        region,
        postalCode,
      },
    },
  };
}

function buildEmergencyRequestInterpretContext({
  context,
  input,
}) {
  return normalizeEmergencyIntakeContext(
    context,
    input
  );
}

function buildEmergencyRequestInterpretProviderRequest({
  semanticInput,
  engineContext,
}) {
  const intakeStage =
    semanticInput.context.stage;

  const allowedPatchPaths =
    STAGE_PATCH_PATHS[intakeStage];

  return {
    schemaVersion: 1,
    operation:
      EMERGENCY_REQUEST_INTERPRET_OPERATION,
    capability:
      EMERGENCY_REQUEST_INTERPRET_CAPABILITY,
    locale: semanticInput.locale,
    homeownerText: semanticInput.input.text,
    intakeStage,
    currentIntake:
      semanticInput.context.intake,
    operationContext: {
      capability:
        engineContext.emergency_request_capability,
      validation:
        engineContext.emergency_request_validation,
    },
    instructions: {
      authority: "proposal_only",
      output: "structured_json",
      intakeStage,
      allowedPatchPaths: [
        ...allowedPatchPaths,
      ],
      allowedProvenance: [...PROVENANCE],
      allowedUncertainty: [...UNCERTAINTY],
      requirements: [
        "preserve_uncertainty",
        "require_homeowner_confirmation",
        "follow_emergency_intake_stage_exactly",
        "describe_stage_only_proposes_description_and_service_specialty",
        "describe_stage_never_requests_or_proposes_location",
        "location_stage_only_proposes_city_region_and_postal_code",
        "location_stage_never_requests_exact_street_unit_gate_or_access_information",
        "never_answer_safety_check_questions_for_the_homeowner",
        "never_select_a_professional",
      ],
      prohibitedActions: [
        "create_emergency_request",
        "prepare_emergency_request",
        "save_safety_assessment",
        "select_professional",
        "create_relationship",
        "create_conversation",
        "create_job",
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

function normalizePatch(field, allowedPatchPaths = PATCH_PATHS) {
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
  if (!allowedPatchPaths.has(field.path)) throw resultError("Unsupported Emergency patch path.");
  const value = boundedText(field.value, VALUE_LIMITS[field.path], resultError, {
    allowEmpty: false,
  });
  rejectPrivateDetail(value);
  if (field.path === "service.specialty" && !SPECIALTIES.has(value)) {
    throw resultError("Unsupported Emergency specialty proposal.");
  }
  if (!PROVENANCE.has(field.provenance)) {
    throw resultError("Unsupported proposal provenance.");
  }
  if (!Number.isFinite(field.confidence) || field.confidence < 0 || field.confidence > 1) {
    throw resultError("Invalid proposal confidence.");
  }
  if (!UNCERTAINTY.has(field.uncertainty)) {
    throw resultError("Unsupported proposal uncertainty.");
  }
  if (field.requiresConfirmation !== true) {
    throw resultError("Emergency proposals must require confirmation.");
  }
  const normalized = {
    path: field.path,
    value,
    provenance: field.provenance,
    confidence: field.confidence,
    uncertainty: field.uncertainty,
    requiresConfirmation: true,
  };
  if (field.rationale != null) {
    const rationale = boundedText(field.rationale, MAX_RATIONALE_LENGTH, resultError);
    rejectProviderPrivateDetail(rationale);
    normalized.rationale = rationale;
  }
  return normalized;
}

function normalizeClarification(
  value,
  {
    stage,
    allowedPatchPaths,
  }
) {
  assertExactKeys(
    value,
    ["question"],
    ["fieldPath"]
  );

  const question = boundedText(
    value.question,
    MAX_QUESTION_LENGTH,
    resultError,
    { allowEmpty: false }
  );

  rejectProviderPrivateDetail(question);

  if (
    stage === "describe" &&
    DESCRIBE_LOCATION_QUESTION_PATTERN.test(question)
  ) {
    throw resultError(
      "Describe-stage clarification must not request location."
    );
  }

  if (value.fieldPath == null) {
    if (stage === "location") {
      throw resultError(
        "Location clarification must target a general-area field."
      );
    }

    return { question };
  }

  if (!allowedPatchPaths.has(value.fieldPath)) {
    throw resultError(
      "Unsupported Emergency clarification path."
    );
  }

  return {
    question,
    fieldPath: value.fieldPath,
  };
}

function normalizeWarning(value) {
  assertExactKeys(value, ["code", "message"]);
  if (typeof value.code !== "string" || !WARNING_CODE_PATTERN.test(value.code)) {
    throw resultError("Invalid Emergency warning code.");
  }
  const message = boundedText(value.message, MAX_WARNING_LENGTH, resultError, {
    allowEmpty: false,
  });
  rejectProviderPrivateDetail(message);
  return { code: value.code, message };
}

function parseEmergencyRequestInterpretResult(
  providerResult,
  { semanticInput } = {}
) {
  const stage =
    semanticInput?.context?.stage;

  if (!STAGES.has(stage)) {
    throw resultError(
      "Emergency intake stage is unavailable."
    );
  }

  const allowedPatchPaths =
    new Set(
      STAGE_PATCH_PATHS[stage]
    );

  const payload =
    parseProviderPayload(providerResult);

  assertExactKeys(
    payload,
    [
      "schemaVersion",
      "summary",
      "draftPatch",
      "clarifications",
      "warnings",
    ]
  );

  if (payload.schemaVersion !== 1) {
    throw resultError(
      "Unsupported provider result version."
    );
  }

  const summary = boundedText(
    payload.summary,
    MAX_SUMMARY_LENGTH,
    resultError,
    { allowEmpty: false }
  );

  rejectProviderPrivateDetail(summary);

  assertExactKeys(
    payload.draftPatch,
    ["fields"]
  );

  if (
    !Array.isArray(
      payload.draftPatch.fields
    ) ||
    payload.draftPatch.fields.length >
      allowedPatchPaths.size ||
    !Array.isArray(
      payload.clarifications
    ) ||
    payload.clarifications.length >
      MAX_CLARIFICATIONS ||
    !Array.isArray(payload.warnings) ||
    payload.warnings.length >
      MAX_WARNINGS
  ) {
    throw resultError(
      "Emergency provider result arrays exceed operation bounds."
    );
  }

  const fields =
    payload.draftPatch.fields.map(
      (field) =>
        normalizePatch(
          field,
          allowedPatchPaths
        )
    );

  if (
    new Set(
      fields.map(({ path }) => path)
    ).size !== fields.length
  ) {
    throw resultError(
      "Duplicate Emergency patch path."
    );
  }

  const clarifications =
    payload.clarifications.map(
      (value) =>
        normalizeClarification(
          value,
          {
            stage,
            allowedPatchPaths,
          }
        )
    );

  const warnings =
    payload.warnings.map(
      normalizeWarning
    );

  return {
    schemaVersion: 1,
    summary,
    draftPatch: { fields },
    clarifications,
    warnings,
    validation: {
      status: "accepted",
      taxonomy: "emergency_service",
      patchCount: fields.length,
      clarificationCount:
        clarifications.length,
      warningCount: warnings.length,
    },
  };
}

const emergencyRequestInterpretEngines = Object.freeze([
  Object.freeze({
    id: "emergency_request_capability",
    async collectContext() {
      return {
        mode: "preparatory",
        proposalOnly: true,
        mutationAllowed: false,
        safetyAssessmentAllowed: false,
        professionalSelectionAllowed: false,
      };
    },
  }),
  Object.freeze({
    id: "emergency_request_validation",
    async collectContext() {
      return {
        schemaVersion: 1,
        taxonomy: "emergency_service",
        canonicalEmergencySpecialties: EMERGENCY_SPECIALTIES.join(","),
        patchWhitelistEnforced: true,
        stageScopedPatchWhitelistEnforced: true,
        generalAreaOnly: true,
        intakeStages: EMERGENCY_REQUEST_INTERPRET_STAGES.join(","),
      };
    },
  }),
]);

const emergencyRequestInterpretOperationDefinition = Object.freeze({
  operation: EMERGENCY_REQUEST_INTERPRET_OPERATION,
  capability: EMERGENCY_REQUEST_INTERPRET_CAPABILITY,
  supportedRoles: Object.freeze(["homeowner", "professional"]),
  roleAuthorization: "registry",
  engineIds: EMERGENCY_REQUEST_INTERPRET_ENGINE_IDS,
  providerName: EMERGENCY_REQUEST_INTERPRET_PROVIDER,
  buildContext: buildEmergencyRequestInterpretContext,
  buildProviderRequest: buildEmergencyRequestInterpretProviderRequest,
  parseResult: parseEmergencyRequestInterpretResult,
});

module.exports = {
  EMERGENCY_REQUEST_INTERPRET_CAPABILITY,
  EMERGENCY_REQUEST_INTERPRET_ENGINE_IDS,
  EMERGENCY_REQUEST_INTERPRET_OPERATION,
  EMERGENCY_REQUEST_INTERPRET_PATCH_PATHS,
  EMERGENCY_REQUEST_INTERPRET_PROVIDER,
  EMERGENCY_REQUEST_INTERPRET_STAGES,
  EMERGENCY_SPECIALTIES,
  buildEmergencyRequestInterpretContext,
  buildEmergencyRequestInterpretProviderRequest,
  emergencyRequestInterpretEngines,
  emergencyRequestInterpretOperationDefinition,
  parseEmergencyRequestInterpretResult,
};
