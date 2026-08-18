"use strict";

const { createHash } = require("node:crypto");
const { isPlainObject } = require("../intelligenceGatewayContracts");
const {
  normalizeQuoteDraftPhotoCollection,
} = require("../../media/quoteDraftPhoto");
const {
  findOwnedContractorProfileId,
} = require("../../media/uploadSignature");

const ELEMENT_ID = /^[a-z][a-z0-9_.:-]{0,159}$/;
const CLASSIFICATIONS = new Set([
  "OBSERVED",
  "NEEDS_VERIFICATION",
  "AI_SUGGESTED",
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

function exact(
  value,
  required,
  optional = [],
  errorFactory = resultError
) {
  if (!isPlainObject(value)) {
    throw errorFactory("Expected a plain object.");
  }

  const allowed = new Set([...required, ...optional]);

  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw errorFactory(
      "Object fields do not match the operation contract."
    );
  }

  return value;
}

function text(
  value,
  maximum,
  {
    required = true,
    errorFactory = resultError,
  } = {}
) {
  if (value == null && !required) return "";

  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > maximum ||
    (required && !value)
  ) {
    throw errorFactory("Text does not match the operation bounds.");
  }

  return value;
}

function nullableText(value, maximum) {
  if (value == null || value === "") return null;

  return text(value, maximum, {
    errorFactory: contextError,
  });
}

function elementId(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  if (!ELEMENT_ID.test(normalized)) {
    throw resultError("Proposal element identity is invalid.");
  }

  return normalized;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function sourceReference(photo) {
  return {
    type: "QUOTE_DRAFT_PHOTO",
    id: photo.public_id,
    version: 1,
  };
}

async function buildQuickQuotePhotoAssistContext({
  context,
  input,
  runtimeContext,
}) {
  exact(context, [], [], contextError);
  exact(input, ["prompt", "photos"], [], contextError);

  const actor = runtimeContext?.authenticatedActor;

  if (
    !actor ||
    actor.role !== "professional" ||
    !Number.isInteger(Number(actor.id)) ||
    Number(actor.id) <= 0
  ) {
    throw operationError(
      "intelligence_quick_quote_media_authority_required",
      "Professional Quick Quote media authority is required."
    );
  }

  if (
    !Array.isArray(input.photos) ||
    input.photos.length < 1 ||
    input.photos.length > 5
  ) {
    throw contextError(
      "Quick Quote photo analysis requires between one and five governed photos."
    );
  }

  const contractorProfileId =
    await findOwnedContractorProfileId(
      runtimeContext?.pool,
      Number(actor.id)
    );

  if (!contractorProfileId) {
    throw operationError(
      "intelligence_quick_quote_media_authority_required",
      "Professional Quick Quote media authority is required."
    );
  }

  let normalizedPhotos;

  try {
    normalizedPhotos = normalizeQuoteDraftPhotoCollection(
      input.photos,
      {
        env: runtimeContext?.env || process.env,
        contractorProfileId,
      }
    );
  } catch {
    throw contextError(
      "Quick Quote photo media is outside the governed draft context."
    );
  }

  const photos = normalizedPhotos.map((photo) => ({
    id: photo.public_id,
    secureUrl: photo.secure_url,
    mediaType: "IMAGE",
    format: photo.format,
    width: photo.width,
    height: photo.height,
    version: photo.version,
    sourceReferences: [sourceReference(photo)],
  }));

  const safeFingerprintContext = {
    mode: "ADVISORY",
    intent: "ANALYZE_PHOTOS",
    prompt: nullableText(input.prompt, 4000),
    photos: photos.map(({ secureUrl, ...photo }) => photo),
    generatedFor: {
      professionalUserId: Number(actor.id),
    },
  };

  return {
    ...safeFingerprintContext,
    photos,
    sourceContextFingerprint:
      fingerprint(safeFingerprintContext),
  };
}

function normalizeSourceReferences(values, context) {
  if (!Array.isArray(values) || values.length > 12) {
    throw resultError("Source references are invalid.");
  }

  const allowed = new Set(
    context.photos
      .flatMap((photo) => photo.sourceReferences)
      .map(
        (item) =>
          `${item.type}:${item.id}:${item.version}`
      )
  );

  return values.map((value) => {
    exact(value, ["type", "id", "version"]);

    const normalized = {
      type: text(value.type, 40),
      id: text(value.id, 500),
      version: Number(value.version),
    };

    if (
      !Number.isInteger(normalized.version) ||
      normalized.version < 1 ||
      !allowed.has(
        `${normalized.type}:${normalized.id}:${normalized.version}`
      )
    ) {
      throw resultError(
        "A source reference is outside the authorized Quick Quote photo context."
      );
    }

    return normalized;
  });
}

function normalizeAssistanceItem(
  value,
  context,
  expectedClassification
) {
  exact(value, [
    "id",
    "text",
    "classification",
    "sourceReferences",
  ]);

  const classification =
    String(value.classification || "")
      .trim()
      .toUpperCase();

  if (
    !CLASSIFICATIONS.has(classification) ||
    classification !== expectedClassification
  ) {
    throw resultError(
      "Quick Quote photo assistance classification is invalid."
    );
  }

  const sourceReferences =
    normalizeSourceReferences(
      value.sourceReferences,
      context
    );

  if (
    classification === "OBSERVED" &&
    sourceReferences.length === 0
  ) {
    throw resultError(
      "Observed photo content requires exact source evidence."
    );
  }

  return {
    id: elementId(value.id),
    text: text(value.text, 3000),
    classification,
    sourceReferences,
  };
}

function parseQuickQuotePhotoAssistResult(
  providerResult,
  {
    semanticInput,
    operationId,
  }
) {
  const payload =
    typeof providerResult === "string"
      ? (() => {
          try {
            return JSON.parse(providerResult);
          } catch {
            throw resultError(
              "Provider output is not valid JSON."
            );
          }
        })()
      : providerResult;

  exact(payload, [
    "schemaVersion",
    "summary",
    "observed",
    "needsVerification",
    "repairSuggestions",
    "materialSuggestions",
    "photoAnalysis",
    "warnings",
  ]);

  if (payload.schemaVersion !== 1) {
    throw resultError(
      "Unsupported Quick Quote photo assistance version."
    );
  }

  for (const key of [
    "observed",
    "needsVerification",
    "repairSuggestions",
    "materialSuggestions",
    "warnings",
  ]) {
    if (
      !Array.isArray(payload[key]) ||
      payload[key].length > 40
    ) {
      throw resultError(
        "Quick Quote photo assistance exceeds collection bounds."
      );
    }
  }

  exact(
    payload.photoAnalysis,
    ["analyzedReferenceIds", "limitations"]
  );

  if (
    !Array.isArray(
      payload.photoAnalysis.analyzedReferenceIds
    ) ||
    !Array.isArray(payload.photoAnalysis.limitations) ||
    payload.photoAnalysis.analyzedReferenceIds.length > 5 ||
    payload.photoAnalysis.limitations.length > 20
  ) {
    throw resultError(
      "Quick Quote photo analysis metadata is invalid."
    );
  }

  const context = semanticInput.context;
  const photoIds = new Set(
    context.photos.map((photo) => photo.id)
  );

  const analyzedReferenceIds =
    payload.photoAnalysis.analyzedReferenceIds.map(
      (value) => {
        const id = text(value, 500);

        if (!photoIds.has(id)) {
          throw resultError(
            "Photo analysis referenced unauthorized Quick Quote media."
          );
        }

        return id;
      }
    );

  if (
    new Set(analyzedReferenceIds).size !==
    analyzedReferenceIds.length
  ) {
    throw resultError(
      "Photo analysis references must be unique."
    );
  }

  return {
    schemaVersion: 1,
    proposalId: operationId,
    authorityClassification:
      "ADVISORY_NON_CANONICAL",
    sourceContextFingerprint:
      context.sourceContextFingerprint,
    summary: text(payload.summary, 1200),

    observed: payload.observed.map((item) =>
      normalizeAssistanceItem(
        item,
        context,
        "OBSERVED"
      )
    ),

    needsVerification:
      payload.needsVerification.map((item) =>
        normalizeAssistanceItem(
          item,
          context,
          "NEEDS_VERIFICATION"
        )
      ),

    repairSuggestions:
      payload.repairSuggestions.map((item) =>
        normalizeAssistanceItem(
          item,
          context,
          "AI_SUGGESTED"
        )
      ),

    materialSuggestions:
      payload.materialSuggestions.map((item) =>
        normalizeAssistanceItem(
          item,
          context,
          "AI_SUGGESTED"
        )
      ),

    photoAnalysis: {
      supported: context.photos.length > 0,
      analyzedReferenceIds,
      limitations:
        payload.photoAnalysis.limitations.map(
          (item) => text(item, 500)
        ),
      imageMeasurementsAreEstimates: true,
    },

    warnings:
      payload.warnings.map((item) =>
        text(item, 500)
      ),

    reviewContract: {
      actions: [
        "ACCEPTED",
        "EDITED",
        "REJECTED",
      ],
      explicitHumanDecisionRequired: true,
    },

    humanToCanonicalBoundary: {
      directMutationAllowed: false,
      workingDraftApplicationRequiresReview: true,
      prohibitedCanonicalCommands: [
        "quote.create",
        "quote.issue",
        "quote.send",
        "request.create",
        "job.create",
      ],
    },

    learningContext: {
      context: "quick_quote_photo_assistance",
      learnedPatternIsCanonicalRule: false,
    },
  };
}

function buildQuickQuotePhotoAssistProviderRequest({
  semanticInput,
  engineContext,
}) {
  const context = semanticInput.context;

  const photos = context.photos.map(
    ({ secureUrl, ...photo }) => photo
  );

  return {
    schemaVersion: 1,
    operation: "quick_quote.photo_assist",
    capability: "quick_quote.photo_assist",
    locale: semanticInput.locale,

    quickQuoteDraftContext: {
      mode: context.mode,
      intent: context.intent,
      prompt: context.prompt,
      photos,
      sourceContextFingerprint:
        context.sourceContextFingerprint,
    },

    authorizedImageInputs:
      context.photos.map((photo) => ({
        mediaId: photo.id,
        imageUrl: photo.secureUrl,
      })),

    operationContext: engineContext,

    instructions: {
      authority: "proposal_only",
      output: "strict_structured_json",
      requirements: [
        "describe_only_visible_conditions_as_observed",
        "separate_observation_from_possible_cause",
        "preserve_uncertainty_for_concealed_conditions",
        "suggest_repairs_for_professional_review_only",
        "suggest_material_categories_without_prices",
        "treat_image_measurements_as_estimates_without_calibration",
        "preserve_exact_photo_source_references",
      ],
      prohibitedActions: [
        "create_or_issue_quote",
        "create_job_or_request",
        "assert_hidden_condition_as_fact",
        "claim_exact_product_match_without_evidence",
        "set_price_or_markup",
        "attach_photo_to_customer_quote",
      ],
    },
  };
}

const quickQuotePhotoAssistEngines = Object.freeze([
  Object.freeze({
    id: "quick_quote_photo_advisory_boundary",

    async collectContext() {
      return {
        mutationAllowed: false,
        commercialMutationAllowed: false,
        customerVisibleByDefault: false,
        observedVsAssumptionRequired: true,
        mediaType: "image",
      };
    },
  }),
]);

const quickQuotePhotoAssistOperationDefinition =
  Object.freeze({
    operation: "quick_quote.photo_assist",
    capability: "quick_quote.photo_assist",
    supportedRoles: Object.freeze([
      "professional",
    ]),
    roleAuthorization: "context_builder",
    engineIds: Object.freeze([
      "quick_quote_photo_advisory_boundary",
    ]),
    providerName: "workflow_assistance",
    buildContext:
      buildQuickQuotePhotoAssistContext,
    buildProviderRequest:
      buildQuickQuotePhotoAssistProviderRequest,
    parseResult:
      parseQuickQuotePhotoAssistResult,
  });

module.exports = {
  buildQuickQuotePhotoAssistContext,
  buildQuickQuotePhotoAssistProviderRequest,
  parseQuickQuotePhotoAssistResult,
  quickQuotePhotoAssistEngines,
  quickQuotePhotoAssistOperationDefinition,
};
