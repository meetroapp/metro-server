"use strict";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_WORKFLOW_MODEL = "gpt-5.4-mini";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const RESPONSES_ENDPOINT_FAMILY = "responses";
const QUICK_QUOTE_ANALYSIS_IMAGE_TRANSFORMATION =
  "c_limit,w_1600,h_1600,q_auto:good";

const OUTPUT_CONTRACTS = Object.freeze({
  "job_request.interpret": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","draftPatch":{"fields":[{"path":"allowed path from request","value":"string","provenance":"assistant_suggested or assistant_inferred","confidence":0.0,"uncertainty":"assistant_suggested or approximate or uncertain","requiresConfirmation":true,"rationale":"optional string"}]},"clarifications":[{"question":"string","fieldPath":"optional allowed path"}],"warnings":[{"code":"lowercase_code","message":"string"}]}`,
  "quick_quote.photo_assist": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","observed":[assistanceItem],"needsVerification":[assistanceItem],"repairSuggestions":[assistanceItem],"materialSuggestions":[assistanceItem],"photoAnalysis":{"analyzedReferenceIds":["authorized photo id"],"limitations":["string"]},"warnings":["string"]}
where assistanceItem is exactly {"id":"lowercase_stable_id","text":"string","classification":"OBSERVED or NEEDS_VERIFICATION or AI_SUGGESTED","sourceReferences":[{"type":"QUOTE_DRAFT_PHOTO","id":"authorized photo id","version":1}]}. OBSERVED items require exact authorized photo sourceReferences. Repair and material suggestions are advisory only. Do not provide prices, markup, retailer claims, customer attachment decisions, or hidden-condition certainty. Use empty arrays when evidence is absent.`,
  "quick_quote.analysis.continue": `Return exactly this JSON object shape:
{"schemaVersion":1,"assistantMessage":"string","summary":"string","questionsForProfessional":[{"id":"stable_id","text":"string"}],"observed":[assistanceItem],"needsVerification":[assistanceItem],"repairSuggestions":[assistanceItem],"materialSuggestions":[assistanceItem],"photoAnalysis":{"analyzedReferenceIds":["authorized photo id"],"limitations":["string"]},"warnings":["string"]}
where assistanceItem is exactly {"id":"lowercase_stable_id","text":"string","classification":"OBSERVED or NEEDS_VERIFICATION or AI_SUGGESTED","sourceReferences":[{"type":"QUOTE_DRAFT_PHOTO","id":"authorized photo id","version":1}]}. Copy the exact authorized photo version from request context. OBSERVED items require exact authorized photo sourceReferences. Treat only reviewedContext.trustedElements as accepted prior proposal context. Never treat unreviewed prior proposal content as accepted truth. Never restore rejectedElementIds as trusted content. Return advisory analysis only; do not create or issue a Quote, schedule work, issue an Invoice, record Payment, or claim customer-visible authority. Use empty arrays when evidence is absent.`,
  "evaluation.assist": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","observed":[assistanceItem],"professionalInput":[assistanceItem],"needsVerification":[assistanceItem],"inspectionSuggestions":[assistanceItem],"measurementSuggestions":[assistanceItem],"evaluationDraft":{"observations":"string","diagnosisSummary":"string","limitations":"string"},"findingDrafts":[assistanceItem],"recommendationDrafts":[assistanceItem],"photoAnalysis":{"analyzedReferenceIds":["authorized photo id"],"limitations":["string"]},"warnings":["string"]}
where assistanceItem is exactly {"id":"lowercase_stable_id","text":"string","classification":"OBSERVED or PROFESSIONAL_INPUT or NEEDS_VERIFICATION or AI_SUGGESTED","sourceReferences":[{"type":"authorized type","id":"authorized id","version":1}]}. OBSERVED and PROFESSIONAL_INPUT items require exact authorized sourceReferences. Use empty arrays when evidence is absent.`,
  "estimate.compose": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","materials":[{"id":"stable_id","description":"string","quantity":1,"unit":"string","wastePercent":0,"costInputKey":null,"retailerReferenceId":null,"assumption":"string","needsVerification":true}],"labor":[{"id":"stable_id","description":"string","crewCount":1,"hoursPerWorker":1,"costInputKey":null,"assumption":"string"}],"equipment":[{"id":"stable_id","description":"string","costInputKey":null}],"disposal":{"description":"string","costInputKey":null},"contingencyPercent":0,"assumptions":[{"id":"stable_id","text":"string"}],"missingInformation":["string"],"suggestedSellingRange":{"minimumMinor":0,"maximumMinor":0,"rationale":"string"},"customerQuoteDraft":{"scopeSummary":"string","conditions":["string"],"exclusions":["string"],"durationGuidance":"string","customerWording":"string"},"warnings":["string"]}
Only use costInputKey and retailerReferenceId values present in the request. Never expose internal costs or retailer references in customerQuoteDraft.`,
  "quote.compose": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","scopeSections":[{"id":"stable_id","title":"string","provenance":"authorized provenance","sourceReferences":[]}],"proposedScopeItems":[{"id":"stable_id","sectionId":"existing section id","description":"string","classification":"MATERIAL or LABOR_SERVICE","scopeSemantic":"COMPLETED_BILLABLE_SERVICE or TEMPORARY_SERVICE or FUTURE_WORK or MATERIAL_INCLUDED or MATERIAL_EXCLUDED or CUSTOMER_SUPPLIED_MATERIAL or SEPARATE_PROPOSAL","materialResponsibility":"PROFESSIONAL_SUPPLIED or CUSTOMER_SUPPLIED or EXCLUDED or PENDING_SELECTION or NOT_APPLICABLE","workStatus":"DONE or DONE_TEMPORARY or OPEN or DEFERRED or FUTURE_WORK or SEPARATE_PROPOSAL","pricing":{"status":"PRICE_CONFIRMED_BY_PROFESSIONAL or PRICE_MISSING or PRICE_ADVISORY_ONLY","inputKey":null},"provenance":"authorized provenance","sourceReferences":[]}],"materials":[{"id":"stable_id","description":"string","responsibility":"PROFESSIONAL_SUPPLIED or CUSTOMER_SUPPLIED or EXCLUDED or PENDING_SELECTION or NOT_APPLICABLE","provenance":"authorized provenance","sourceReferences":[]}],"exclusions":[sourcedElement],"assumptions":[sourcedElement],"separateProposals":[sourcedElement],"commercialMissingInformation":[{"id":"stable_id","code":"UPPERCASE_CODE","description":"string","provenance":"authorized provenance","sourceReferences":[],"elementId":null}],"workflowConditions":[{"id":"stable_id","type":"DEPOSIT or AVAILABILITY or OTHER","description":"string","state":"ADVISORY_NOT_SATISFIED or CONDITIONAL_NOT_SCHEDULED or REQUIRES_PROFESSIONAL_CONFIRMATION","provenance":"authorized provenance","sourceReferences":[]}],"warnings":[{"code":"lowercase_code","message":"string"}],"confidence":{"score":0.0,"rationale":"string"}}
where authorized provenance is CANONICAL_CONFIRMED, PROFESSIONAL_INPUT, CUSTOMER_REPORTED, MEDIA_OBSERVED, AI_SUGGESTED, or MISSING_INFORMATION and sourcedElement is exactly {"id":"stable_id","description":"string","provenance":"authorized provenance","sourceReferences":[]}. Copy non-AI provenance and source references exactly from authorized request context. Use only professional pricing inputs as PRICE_CONFIRMED_BY_PROFESSIONAL.`,
  "invoice.assist": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","lineDescriptions":[{"id":"stable_id","text":"string"}],"customerNotes":"string","terms":"string","dueDateWording":"string","balanceExplanation":"string","warnings":["string"]}
Draft wording only. Never calculate, alter, or assert payment, total, paid, balance, or status authority.`,
});


function quickQuoteAnalysisAssistanceItemSchema(
  classification,
  {
    requireSourceReference = false,
  } = {}
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "text",
      "classification",
      "sourceReferences",
    ],
    properties: {
      id: {
        type: "string",
        pattern: "^[a-z][a-z0-9_.:-]{0,159}$",
      },
      text: {
        type: "string",
        minLength: 1,
        maxLength: 3000,
      },
      classification: {
        type: "string",
        const: classification,
      },
      sourceReferences: {
        type: "array",
        minItems:
          requireSourceReference
            ? 1
            : 0,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "id",
            "version",
          ],
          properties: {
            type: {
              type: "string",
              const: "QUOTE_DRAFT_PHOTO",
            },
            id: {
              type: "string",
              minLength: 1,
              maxLength: 500,
            },
            version: {
              type: "integer",
              minimum: 1,
            },
          },
        },
      },
    },
  };
}

const QUICK_QUOTE_ANALYSIS_CONTINUE_OUTPUT_SCHEMA =
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "assistantMessage",
      "summary",
      "questionsForProfessional",
      "observed",
      "needsVerification",
      "repairSuggestions",
      "materialSuggestions",
      "photoAnalysis",
      "warnings",
    ],
    properties: {
      schemaVersion: {
        type: "integer",
        const: 1,
      },
      assistantMessage: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 1200,
      },
      questionsForProfessional: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "text",
          ],
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_.:-]{0,159}$",
            },
            text: {
              type: "string",
              minLength: 1,
              maxLength: 1200,
            },
          },
        },
      },
      observed: {
        type: "array",
        maxItems: 40,
        items:
          quickQuoteAnalysisAssistanceItemSchema(
            "OBSERVED",
            {
              requireSourceReference:
                true,
            }
          ),
      },
      needsVerification: {
        type: "array",
        maxItems: 40,
        items:
          quickQuoteAnalysisAssistanceItemSchema(
            "NEEDS_VERIFICATION"
          ),
      },
      repairSuggestions: {
        type: "array",
        maxItems: 40,
        items:
          quickQuoteAnalysisAssistanceItemSchema(
            "AI_SUGGESTED"
          ),
      },
      materialSuggestions: {
        type: "array",
        maxItems: 40,
        items:
          quickQuoteAnalysisAssistanceItemSchema(
            "AI_SUGGESTED"
          ),
      },
      photoAnalysis: {
        type: "object",
        additionalProperties: false,
        required: [
          "analyzedReferenceIds",
          "limitations",
        ],
        properties: {
          analyzedReferenceIds: {
            type: "array",
            maxItems: 5,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 500,
            },
          },
          limitations: {
            type: "array",
            maxItems: 20,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 500,
            },
          },
        },
      },
      warnings: {
        type: "array",
        maxItems: 40,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 500,
        },
      },
    },
  });

function quickQuoteAnalysisContinueOutputSchema(request) {
  const context =
    request?.quickQuoteAnalysisContext ||
    {};

  const authorizedPhotos =
    (
      Array.isArray(
        context.photos
      )
        ? context.photos
        : []
    )
      .map(
        (photo) => {
          const id =
            typeof photo?.id ===
            "string"
              ? photo.id.trim()
              : "";

          const version =
            Number(
              photo?.version
            );

          if (
            !id ||
            !Number.isInteger(
              version
            ) ||
            version < 1
          ) {
            return null;
          }

          return {
            type:
              "QUOTE_DRAFT_PHOTO",
            id,
            version,
          };
        }
      )
      .filter(Boolean);

  const uniqueAuthorizedPhotos =
    [
      ...new Map(
        authorizedPhotos.map(
          (photo) => [
            `${photo.type}:${photo.id}:${photo.version}`,
            photo,
          ]
        )
      ).values(),
    ];

  const authorizedPhotoIds =
    [
      ...new Set(
        uniqueAuthorizedPhotos.map(
          (photo) =>
            photo.id
        )
      ),
    ];

  const schema =
    structuredClone(
      QUICK_QUOTE_ANALYSIS_CONTINUE_OUTPUT_SCHEMA
    );

  const analyzedReferenceIds =
    schema
      .properties
      .photoAnalysis
      .properties
      .analyzedReferenceIds;

  analyzedReferenceIds.maxItems =
    Math.min(
      5,
      authorizedPhotoIds.length
    );

  if (
    authorizedPhotoIds.length > 0
  ) {
    analyzedReferenceIds.items = {
      type: "string",
      enum:
        authorizedPhotoIds,
    };
  }

  const assistanceCollections = [
    "observed",
    "needsVerification",
    "repairSuggestions",
    "materialSuggestions",
  ];

  if (
    uniqueAuthorizedPhotos.length ===
    0
  ) {
    schema
      .properties
      .observed
      .maxItems = 0;

    for (
      const collection of
        assistanceCollections
          .filter(
            (name) =>
              name !==
              "observed"
          )
    ) {
      schema
        .properties[collection]
        .items
        .properties
        .sourceReferences
        .maxItems = 0;
    }

    return schema;
  }

  const exactReferenceSchemas =
    uniqueAuthorizedPhotos.map(
      (photo) => ({
        type: "object",
        additionalProperties:
          false,
        required: [
          "type",
          "id",
          "version",
        ],
        properties: {
          type: {
            type: "string",
            const:
              "QUOTE_DRAFT_PHOTO",
          },
          id: {
            type: "string",
            const:
              photo.id,
          },
          version: {
            type: "integer",
            const:
              photo.version,
          },
        },
      })
    );

  const exactReferenceSchema =
    exactReferenceSchemas.length ===
      1
      ? exactReferenceSchemas[0]
      : {
          anyOf:
            exactReferenceSchemas,
        };

  for (
    const collection of
      assistanceCollections
  ) {
    schema
      .properties[collection]
      .items
      .properties
      .sourceReferences
      .items =
        structuredClone(
          exactReferenceSchema
        );
  }

  return schema;
}

const QUOTE_COMPOSE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
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
  ],
  properties: {
    schemaVersion: {
      type: "integer",
      const: 1,
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 1200,
    },
    scopeSections: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "provenance",
          "sourceReferences",
        ],
        properties: {
          id: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,79}$",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
          provenance: {
            type: "string",
            enum: [
              "CANONICAL_CONFIRMED",
              "PROFESSIONAL_INPUT",
              "CUSTOMER_REPORTED",
              "MEDIA_OBSERVED",
              "AI_SUGGESTED",
              "MISSING_INFORMATION",
            ],
          },
          sourceReferences: {
            type: "array",
            maxItems: 12,
            items: {},
          },
        },
      },
    },
    proposedScopeItems: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
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
        ],
        properties: {
          id: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,79}$",
          },
          sectionId: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,79}$",
          },
          description: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
          },
          classification: {
            type: "string",
            enum: [
              "MATERIAL",
              "LABOR_SERVICE",
            ],
          },
          scopeSemantic: {
            type: "string",
            enum: [
              "COMPLETED_BILLABLE_SERVICE",
              "TEMPORARY_SERVICE",
              "FUTURE_WORK",
              "MATERIAL_INCLUDED",
              "MATERIAL_EXCLUDED",
              "CUSTOMER_SUPPLIED_MATERIAL",
              "SEPARATE_PROPOSAL",
            ],
          },
          materialResponsibility: {
            type: "string",
            enum: [
              "PROFESSIONAL_SUPPLIED",
              "CUSTOMER_SUPPLIED",
              "EXCLUDED",
              "PENDING_SELECTION",
              "NOT_APPLICABLE",
            ],
          },
          workStatus: {
            type: "string",
            enum: [
              "DONE",
              "DONE_TEMPORARY",
              "OPEN",
              "DEFERRED",
              "FUTURE_WORK",
              "SEPARATE_PROPOSAL",
            ],
          },
          pricing: {
            type: "object",
            additionalProperties: false,
            required: [
              "status",
              "inputKey",
            ],
            properties: {
              status: {
                type: "string",
                enum: [
                  "PRICE_CONFIRMED_BY_PROFESSIONAL",
                  "PRICE_MISSING",
                  "PRICE_ADVISORY_ONLY",
                ],
              },
              inputKey: {
                type: [
                  "string",
                  "null",
                ],
              },
            },
          },
          provenance: {
            type: "string",
            enum: [
              "CANONICAL_CONFIRMED",
              "PROFESSIONAL_INPUT",
              "CUSTOMER_REPORTED",
              "MEDIA_OBSERVED",
              "AI_SUGGESTED",
              "MISSING_INFORMATION",
            ],
          },
          sourceReferences: {
            type: "array",
            maxItems: 12,
            items: {},
          },
        },
      },
    },
    materials: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "description",
          "responsibility",
          "provenance",
          "sourceReferences",
        ],
        properties: {
          id: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,79}$",
          },
          description: {
            type: "string",
            minLength: 1,
            maxLength: 500,
          },
          responsibility: {
            type: "string",
            enum: [
              "PROFESSIONAL_SUPPLIED",
              "CUSTOMER_SUPPLIED",
              "EXCLUDED",
              "PENDING_SELECTION",
              "NOT_APPLICABLE",
            ],
          },
          provenance: {
            type: "string",
            enum: [
              "CANONICAL_CONFIRMED",
              "PROFESSIONAL_INPUT",
              "CUSTOMER_REPORTED",
              "MEDIA_OBSERVED",
              "AI_SUGGESTED",
              "MISSING_INFORMATION",
            ],
          },
          sourceReferences: {
            type: "array",
            maxItems: 12,
            items: {},
          },
        },
      },
    },
    exclusions: {
      type: "array",
      maxItems: 80,
      items: {},
    },
    assumptions: {
      type: "array",
      maxItems: 80,
      items: {},
    },
    separateProposals: {
      type: "array",
      maxItems: 80,
      items: {},
    },
    commercialMissingInformation: {
      type: "array",
      maxItems: 80,
      items: {},
    },
    workflowConditions: {
      type: "array",
      maxItems: 80,
      items: {},
    },
    warnings: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "code",
          "message",
        ],
        properties: {
          code: {
            type: "string",
            pattern: "^[a-z][a-z0-9_]{2,79}$",
          },
          message: {
            type: "string",
            minLength: 1,
            maxLength: 500,
          },
        },
      },
    },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: [
        "score",
        "rationale",
      ],
      properties: {
        score: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        rationale: {
          type: "string",
          minLength: 1,
          maxLength: 500,
        },
      },
    },
  },
});

const ESTIMATE_COMPOSE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "summary", "materials", "labor", "equipment", "disposal",
    "contingencyPercent", "assumptions", "missingInformation", "suggestedSellingRange",
    "customerQuoteDraft", "warnings",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    summary: { type: "string" },
    materials: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "description", "quantity", "unit", "wastePercent", "costInputKey",
          "retailerReferenceId", "assumption", "needsVerification",
        ],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_.:-]{0,159}$" },
          description: { type: "string", minLength: 1, maxLength: 500 },
          quantity: { type: "number", exclusiveMinimum: 0, maximum: 1000000 },
          unit: { type: "string", minLength: 1, maxLength: 80 },
          wastePercent: { type: "number", minimum: 0, maximum: 100 },
          costInputKey: { type: ["string", "null"] },
          retailerReferenceId: { type: ["string", "null"] },
          assumption: { type: "string" },
          needsVerification: { type: "boolean" },
        },
      },
    },
    labor: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "crewCount", "hoursPerWorker", "costInputKey", "assumption"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_.:-]{0,159}$" },
          description: { type: "string", minLength: 1, maxLength: 500 },
          crewCount: { type: "number", exclusiveMinimum: 0, maximum: 1000000 },
          hoursPerWorker: { type: "number", exclusiveMinimum: 0, maximum: 1000000 },
          costInputKey: { type: ["string", "null"] },
          assumption: { type: "string" },
        },
      },
    },
    equipment: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "costInputKey"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_.:-]{0,159}$" },
          description: { type: "string", minLength: 1, maxLength: 500 },
          costInputKey: { type: ["string", "null"] },
        },
      },
    },
    disposal: {
      type: "object",
      additionalProperties: false,
      required: ["description", "costInputKey"],
      properties: {
        description: { type: "string" },
        costInputKey: { type: ["string", "null"] },
      },
    },
    contingencyPercent: { type: "number", minimum: 0, maximum: 50 },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_.:-]{0,159}$" },
          text: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
    missingInformation: { type: "array", items: { type: "string" } },
    suggestedSellingRange: {
      type: "object",
      additionalProperties: false,
      required: ["minimumMinor", "maximumMinor", "rationale"],
      properties: {
        minimumMinor: { type: "integer", minimum: 0 },
        maximumMinor: { type: "integer", minimum: 0 },
        rationale: { type: "string" },
      },
    },
    customerQuoteDraft: {
      type: "object",
      additionalProperties: false,
      required: ["scopeSummary", "conditions", "exclusions", "durationGuidance", "customerWording"],
      properties: {
        scopeSummary: { type: "string" },
        conditions: { type: "array", items: { type: "string" } },
        exclusions: { type: "array", items: { type: "string" } },
        durationGuidance: { type: "string" },
        customerWording: { type: "string" },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
});

function governedIdentifierEnum(values, classification = null) {
  const identifiers = (Array.isArray(values) ? values : [])
    .filter((item) => !classification || item?.classification === classification)
    .map((item) => item?.key || item?.id)
    .filter((value) => typeof value === "string" && value);
  return { enum: [null, ...new Set(identifiers)] };
}

function estimateComposeOutputSchema(request) {
  const context = request?.internalProfessionalContext || {};
  const costInputs = context?.professionalInput?.costInputs;
  const retailerReferences = context?.retailerReferences;
  const schema = structuredClone(ESTIMATE_COMPOSE_OUTPUT_SCHEMA);
  const materialProperties = schema.properties.materials.items.properties;
  const laborProperties = schema.properties.labor.items.properties;
  const equipmentProperties = schema.properties.equipment.items.properties;
  materialProperties.costInputKey = governedIdentifierEnum(costInputs, "MATERIAL");
  materialProperties.retailerReferenceId = governedIdentifierEnum(retailerReferences);
  laborProperties.costInputKey = governedIdentifierEnum(costInputs, "LABOR");
  equipmentProperties.costInputKey = governedIdentifierEnum(costInputs, "EQUIPMENT");
  schema.properties.disposal.properties.costInputKey = governedIdentifierEnum(costInputs, "DISPOSAL");
  return schema;
}

const QUOTE_COMPOSE_REFERENCE_TYPES =
  new Set([
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

const QUOTE_COMPOSE_PROVENANCE =
  [
    "CANONICAL_CONFIRMED",
    "PROFESSIONAL_INPUT",
    "CUSTOMER_REPORTED",
    "MEDIA_OBSERVED",
    "AI_SUGGESTED",
    "MISSING_INFORMATION",
  ];

function quoteComposeAuthorizedReferences(
  request
) {
  const references = [];
  const visited =
    new Set();

  const visit = (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      visited.has(value)
    ) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (
      Array.isArray(
        value.sourceReferences
      )
    ) {
      for (
        const reference of
          value.sourceReferences
      ) {
        const type =
          typeof reference?.type ===
          "string"
            ? reference.type
                .trim()
                .toUpperCase()
            : "";

        const id =
          typeof reference?.id ===
          "string"
            ? reference.id.trim()
            : "";

        const version =
          Number(
            reference?.version
          );

        if (
          QUOTE_COMPOSE_REFERENCE_TYPES
            .has(type) &&
          id &&
          id.length <= 200 &&
          Number.isInteger(
            version
          ) &&
          version >= 1
        ) {
          references.push({
            type,
            id,
            version,
          });
        }
      }
    }

    Object.values(value)
      .forEach(visit);
  };

  visit(
    request?.canonicalJobContext ||
      {}
  );

  return [
    ...new Map(
      references.map(
        (reference) => [
          `${reference.type}:${reference.id}:${reference.version}`,
          reference,
        ]
      )
    ).values(),
  ];
}

function quoteComposeExactReferenceSchema(
  reference
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "type",
      "id",
      "version",
    ],
    properties: {
      type: {
        type: "string",
        const:
          reference.type,
      },
      id: {
        type: "string",
        const:
          reference.id,
      },
      version: {
        type: "integer",
        const:
          reference.version,
      },
    },
  };
}

function quoteComposeSourceReferencesSchema(
  references
) {
  if (
    references.length === 0
  ) {
    return {
      type: "array",
      maxItems: 0,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "id",
          "version",
        ],
        properties: {
          type: {
            type: "string",
          },
          id: {
            type: "string",
          },
          version: {
            type: "integer",
            minimum: 1,
          },
        },
      },
    };
  }

  return {
    type: "array",
    maxItems:
      Math.min(
        12,
        references.length
      ),
    items: {
      anyOf:
        references.map(
          quoteComposeExactReferenceSchema
        ),
    },
  };
}

function quoteComposeSourcedElementSchema(
  sourceReferences,
  {
    maximumDescription = 2000,
  } = {}
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "description",
      "provenance",
      "sourceReferences",
    ],
    properties: {
      id: {
        type: "string",
        pattern:
          "^[a-z][a-z0-9_-]{0,79}$",
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength:
          maximumDescription,
      },
      provenance: {
        type: "string",
        enum:
          QUOTE_COMPOSE_PROVENANCE,
      },
      sourceReferences:
        structuredClone(
          sourceReferences
        ),
    },
  };
}

function quoteComposeOutputSchema(
  request
) {
  const context =
    request?.canonicalJobContext ||
    {};

  const schema =
    structuredClone(
      QUOTE_COMPOSE_OUTPUT_SCHEMA
    );

  const references =
    quoteComposeAuthorizedReferences(
      request
    );

  const sourceReferences =
    quoteComposeSourceReferencesSchema(
      references
    );

  const pricingInputs =
    Array.isArray(
      context?.professionalInput
        ?.pricingInputs
    )
      ? context
          .professionalInput
          .pricingInputs
      : [];

  const pricingKeys =
    [
      ...new Set(
        pricingInputs
          .map(
            (item) =>
              typeof item?.key ===
              "string"
                ? item.key
                    .trim()
                    .toLowerCase()
                : ""
          )
          .filter(Boolean)
      ),
    ];

  /*
   * Preserve the general object shape for contract
   * visibility while adding an anyOf that couples
   * confirmed status to exact professional keys.
   */
  const pricing =
    schema.properties
      .proposedScopeItems
      .items
      .properties
      .pricing;

  pricing.anyOf = [];

  if (
    pricingKeys.length > 0
  ) {
    pricing.anyOf.push({
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "inputKey",
      ],
      properties: {
        status: {
          type: "string",
          const:
            "PRICE_CONFIRMED_BY_PROFESSIONAL",
        },
        inputKey: {
          type: "string",
          enum:
            pricingKeys,
        },
      },
    });
  }

  for (
    const status of [
      "PRICE_MISSING",
      "PRICE_ADVISORY_ONLY",
    ]
  ) {
    pricing.anyOf.push({
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "inputKey",
      ],
      properties: {
        status: {
          type: "string",
          const: status,
        },
        inputKey: {
          enum: [null],
        },
      },
    });
  }

  /*
   * Every source-bearing provider element uses the
   * exact same server-authorized reference catalog.
   */
  for (
    const itemSchema of [
      schema.properties
        .scopeSections.items,
      schema.properties
        .proposedScopeItems.items,
      schema.properties
        .materials.items,
    ]
  ) {
    itemSchema.properties
      .sourceReferences =
      structuredClone(
        sourceReferences
      );
  }

  schema.properties
    .exclusions.items =
    quoteComposeSourcedElementSchema(
      sourceReferences
    );

  schema.properties
    .assumptions.items =
    quoteComposeSourcedElementSchema(
      sourceReferences
    );

  schema.properties
    .separateProposals.items =
    quoteComposeSourcedElementSchema(
      sourceReferences
    );

  schema.properties
    .commercialMissingInformation
    .items = {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "code",
        "description",
        "provenance",
        "sourceReferences",
        "elementId",
      ],
      properties: {
        id: {
          type: "string",
          pattern:
            "^[a-z][a-z0-9_-]{0,79}$",
        },
        code: {
          type: "string",
          pattern:
            "^[A-Z][A-Z0-9_]{2,79}$",
        },
        description: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
        },
        provenance: {
          type: "string",
          enum:
            QUOTE_COMPOSE_PROVENANCE,
        },
        sourceReferences:
          structuredClone(
            sourceReferences
          ),
        elementId: {
          type: [
            "string",
            "null",
          ],
          pattern:
            "^[a-z][a-z0-9_-]{0,79}$",
        },
      },
    };

  schema.properties
    .workflowConditions
    .items = {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "type",
        "description",
        "state",
        "provenance",
        "sourceReferences",
      ],
      properties: {
        id: {
          type: "string",
          pattern:
            "^[a-z][a-z0-9_-]{0,79}$",
        },
        type: {
          type: "string",
          enum: [
            "DEPOSIT",
            "AVAILABILITY",
            "OTHER",
          ],
        },
        description: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
        },
        state: {
          type: "string",
          enum: [
            "ADVISORY_NOT_SATISFIED",
            "CONDITIONAL_NOT_SCHEDULED",
            "REQUIRES_PROFESSIONAL_CONFIRMATION",
          ],
        },
        provenance: {
          type: "string",
          enum:
            QUOTE_COMPOSE_PROVENANCE,
        },
        sourceReferences:
          structuredClone(
            sourceReferences
          ),
      },
    };

  return schema;
}

function workflowResponseFormat(request) {
  if (
    request?.operation ===
    "quick_quote.analysis.continue"
  ) {
    return {
      type: "json_schema",
      name:
        "meetro_quick_quote_analysis_continue",
      strict: true,
      schema:
        quickQuoteAnalysisContinueOutputSchema(
          request
        ),
    };
  }

  if (request?.operation === "estimate.compose") {
    return {
      type: "json_schema",
      name: "meetro_estimate_compose",
      strict: true,
      schema: estimateComposeOutputSchema(request),
    };
  }

  if (request?.operation === "quote.compose") {
    return {
      type: "json_schema",
      name: "meetro_quote_compose",
      strict: true,
      schema:
        quoteComposeOutputSchema(
          request
        ),
    };
  }

  return { type: "json_object" };
}

function providerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function boundedDiagnosticText(value, maximum = 160) {
  if (value == null) return null;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(["'])(.{65,}?)\1/g, "$1[redacted]$1")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function responseRequestId(response) {
  return boundedDiagnosticText(response?.headers?.get?.("x-request-id"), 160);
}

function safeProviderDiagnostics({ response, payload = {}, model, error } = {}) {
  return Object.freeze({
    httpStatus: Number.isInteger(response?.status) ? response.status : null,
    errorType: boundedDiagnosticText(payload?.error?.type),
    errorCode: boundedDiagnosticText(payload?.error?.code),
    errorParam: boundedDiagnosticText(payload?.error?.param),
    errorMessage: boundedDiagnosticText(payload?.error?.message || error?.message, 400),
    requestId: responseRequestId(response),
    model: boundedDiagnosticText(model),
    endpointFamily: RESPONSES_ENDPOINT_FAMILY,
  });
}

function logProviderDiagnostic(logger, level, event, metadata) {
  if (logger && typeof logger[level] === "function") {
    logger[level](event, metadata);
  }
}

function classifyProviderFailure(status, payload = {}) {
  const code = String(payload?.error?.code || "").trim().toLowerCase();
  const type = String(payload?.error?.type || "").trim().toLowerCase();
  if (status === 401) return "provider_authentication_failed";
  if (code.includes("billing") || type.includes("billing")) return "provider_billing_required";
  if (code === "insufficient_quota" || type === "insufficient_quota") return "provider_quota_exhausted";
  if (status === 429) return "provider_rate_limited";
  if (status === 403) return "provider_access_denied";
  if (status === 404 || code.includes("model") || type.includes("model")) {
    return "provider_model_unavailable";
  }
  if (status === 400) return "provider_request_invalid";
  if (status >= 500) return "provider_upstream_failure";
  return "provider_failure";
}

async function readSafeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function responseOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return "";
}

function safeProviderResultMetadata({ response, model }) {
  const providerRequestId = responseRequestId(response);
  return Object.freeze({
    providerRequestId: typeof providerRequestId === "string" ? providerRequestId : null,
    configuredModel: typeof model === "string" ? model : null,
  });
}

function attachProviderMetadata(payload, metadata) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return Object.defineProperty(payload, "__providerMetadata", {
    value: metadata || null,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

function workflowInstructions(request) {
  const contract = OUTPUT_CONTRACTS[request?.operation];
  if (!contract) {
    throw providerError("provider_model_unavailable", "The workflow operation is not configured.");
  }
  return [
    "You are Meetro's governed workflow assistance provider.",
    "Return one JSON object only. Do not use markdown.",
    "Treat every output as advisory and non-canonical.",
    "Never claim that a Quote was issued or sent, a customer decided, work was scheduled or completed, an Invoice was issued, a Payment was recorded, or Portfolio content was published.",
    "Never invent source references, prices, measurements, or professional observations.",
    "Preserve uncertainty and use empty arrays or missing-information fields when evidence is absent.",
    contract,
  ].join("\n");
}

function governedCloudinaryImageUrl(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "res.cloudinary.com" ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function governedQuickQuoteAnalysisImageUrl(
  value,
  canonicalPhoto
) {
  const candidate =
    governedCloudinaryImageUrl(value);

  const mediaId =
    typeof canonicalPhoto?.id === "string"
      ? canonicalPhoto.id.trim()
      : "";

  const version =
    Number(canonicalPhoto?.version);

  const format =
    typeof canonicalPhoto?.format === "string"
      ? canonicalPhoto.format.trim().toLowerCase()
      : "";

  if (
    !candidate ||
    !mediaId ||
    !Number.isInteger(version) ||
    version < 1 ||
    !["jpg", "jpeg", "png", "webp"].includes(format)
  ) {
    return null;
  }

  const parsed = new URL(candidate);
  const uploadMarker = "/image/upload/";
  const uploadIndex =
    parsed.pathname.indexOf(uploadMarker);
  const versionMarker =
    `v${version}/`;
  const versionIndex =
    parsed.pathname.indexOf(
      versionMarker,
      uploadIndex + uploadMarker.length
    );

  if (
    uploadIndex < 0 ||
    versionIndex < 0
  ) {
    return null;
  }

  let assetPath;

  try {
    assetPath = decodeURIComponent(
      parsed.pathname.slice(
        versionIndex + versionMarker.length
      )
    );
  } catch {
    return null;
  }

  const allowedAssetPaths =
    format === "jpeg"
      ? new Set([
          `${mediaId}.jpeg`,
          `${mediaId}.jpg`,
        ])
      : new Set([
          `${mediaId}.${format}`,
        ]);

  if (!allowedAssetPaths.has(assetPath)) {
    return null;
  }

  parsed.pathname =
    `${parsed.pathname.slice(
      0,
      uploadIndex + uploadMarker.length
    )}${QUICK_QUOTE_ANALYSIS_IMAGE_TRANSFORMATION}/` +
    `${parsed.pathname.slice(versionIndex)}`;

  return parsed.href;
}

function workflowProviderInput(request) {
  const imageInputs = Array.isArray(request?.authorizedImageInputs)
    ? request.authorizedImageInputs
    : [];

  const evaluationPhotoAnalysisRequested =
    request?.operation === "evaluation.assist" &&
    request?.canonicalJobContext?.intent === "ANALYZE_PHOTOS";

  const quickQuotePhotoAnalysisRequested =
    request?.operation === "quick_quote.photo_assist" &&
    request?.quickQuoteDraftContext?.intent === "ANALYZE_PHOTOS";

  const quickQuoteAnalysisContinuationRequested =
    request?.operation === "quick_quote.analysis.continue" &&
    Array.isArray(
      request?.quickQuoteAnalysisContext?.photos
    ) &&
    request.quickQuoteAnalysisContext.photos.length > 0;

  const photoAnalysisRequested =
    evaluationPhotoAnalysisRequested ||
    quickQuotePhotoAnalysisRequested ||
    quickQuoteAnalysisContinuationRequested;

  const textRequest = { ...(request || {}) };
  delete textRequest.authorizedImageInputs;

  if (!photoAnalysisRequested) {
    return JSON.stringify(textRequest);
  }

  if (imageInputs.length < 1 || imageInputs.length > 5) {
    throw providerError(
      "provider_request_invalid",
      "Governed photo analysis requires between one and five authorized images."
    );
  }

  const canonicalPhotos =
    evaluationPhotoAnalysisRequested
      ? request?.canonicalJobContext?.requestPhotos
      : quickQuoteAnalysisContinuationRequested
        ? request?.quickQuoteAnalysisContext?.photos
        : request?.quickQuoteDraftContext?.photos;

  const canonicalMediaIds = new Set(
    (Array.isArray(canonicalPhotos)
      ? canonicalPhotos
      : [])
      .map((photo) =>
        typeof photo?.id === "string"
          ? photo.id.trim()
          : ""
      )
      .filter(Boolean)
  );

  const canonicalPhotosById = new Map(
    (Array.isArray(canonicalPhotos)
      ? canonicalPhotos
      : [])
      .filter(
        (photo) =>
          typeof photo?.id === "string" &&
          photo.id.trim()
      )
      .map((photo) => [
        photo.id.trim(),
        photo,
      ])
  );

  const content = [
    {
      type: "input_text",
      text: JSON.stringify(textRequest),
    },
  ];

  for (const image of imageInputs) {
    const mediaId =
      typeof image?.mediaId === "string"
        ? image.mediaId.trim()
        : "";

    const canonicalPhoto =
      canonicalPhotosById.get(mediaId);

    const imageUrl =
      quickQuoteAnalysisContinuationRequested
        ? governedQuickQuoteAnalysisImageUrl(
            image?.imageUrl,
            canonicalPhoto
          )
        : governedCloudinaryImageUrl(
            image?.imageUrl
          );

    if (
      !mediaId ||
      !canonicalMediaIds.has(mediaId) ||
      !imageUrl
    ) {
      throw providerError(
        "provider_request_invalid",
        "Governed photo analysis media is invalid."
      );
    }

    content.push({
      type: "input_image",
      image_url: imageUrl,
      detail: "auto",
    });
  }

  return [{ role: "user", content }];
}

function createOpenAiWorkflowProvider({
  apiKey,
  model = DEFAULT_WORKFLOW_MODEL,
  fetchImpl = globalThis.fetch,
  logger = null,
} = {}) {
  const normalizedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (!normalizedKey || !normalizedModel || typeof fetchImpl !== "function") {
    return null;
  }

  async function createResponse(
    body,
    {
      signal,
    } = {}
  ) {
    let response;
    try {
      response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${normalizedKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: normalizedModel,
          store: false,
          ...body,
        }),
        ...(signal
          ? { signal }
          : {}),
      });
    } catch (error) {
      if (
        signal?.aborted &&
        signal.reason?.code ===
          "provider_timeout"
      ) {
        throw signal.reason;
      }

      logProviderDiagnostic(
        logger,
        "error",
        "intelligence.provider.transport_failure",
        safeProviderDiagnostics({ model: normalizedModel, error })
      );
      throw providerError("provider_transport_failure", "The governed workflow provider could not be reached.");
    }

    const payload = await readSafeJson(response);
    if (!response.ok) {
      logProviderDiagnostic(
        logger,
        "error",
        "intelligence.provider.upstream_failure",
        safeProviderDiagnostics({ response, payload, model: normalizedModel })
      );
      throw providerError(
        classifyProviderFailure(response.status, payload),
        "The governed workflow provider rejected the request."
      );
    }
    return { response, payload };
  }

  return Object.freeze({
    name: "workflow_assistance",
    provider: "openai",
    model: normalizedModel,
    async complete(
      request,
      {
        signal,
      } = {}
    ) {
      const { response, payload } = await createResponse({
        instructions: workflowInstructions(request),
        input: workflowProviderInput(request),
        text: { format: workflowResponseFormat(request) },
      }, { signal });
      const output = responseOutputText(payload);
      if (!output) {
        logProviderDiagnostic(
          logger,
          "error",
          "intelligence.provider.response_parse_failure",
          {
            ...safeProviderDiagnostics({ response, model: normalizedModel }),
            parserCode: "empty_output",
          }
        );
        throw providerError("malformed_operation_result", "The provider returned no output.");
      }
      try {
        const parsed = JSON.parse(output);
        return attachProviderMetadata(
          parsed,
          safeProviderResultMetadata({ response, model: normalizedModel })
        );
      } catch {
        logProviderDiagnostic(
          logger,
          "error",
          "intelligence.provider.response_parse_failure",
          {
            ...safeProviderDiagnostics({ response, model: normalizedModel }),
            parserCode: "invalid_json",
          }
        );
        throw providerError("malformed_operation_result", "The provider output was not valid JSON.");
      }
    },
    async smoke() {
      const { response, payload } = await createResponse({
        instructions: "Return exactly the word OK.",
        input: "Reply with the word OK.",
      });
      const output = responseOutputText(payload).trim();
      if (output !== "OK") {
        logProviderDiagnostic(
          logger,
          "error",
          "intelligence.provider.response_parse_failure",
          {
            ...safeProviderDiagnostics({ response, model: normalizedModel }),
            parserCode: "smoke_output_mismatch",
          }
        );
        throw providerError("malformed_operation_result", "The provider smoke response was invalid.");
      }
      const result = {
        ok: true,
        model: normalizedModel,
        endpointFamily: RESPONSES_ENDPOINT_FAMILY,
        requestId: responseRequestId(response),
        store: false,
      };
      logProviderDiagnostic(logger, "info", "intelligence.provider.smoke_completed", result);
      return result;
    },
  });
}

function createOpenAiTranscriptionProvider({
  apiKey,
  model = DEFAULT_TRANSCRIPTION_MODEL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (!normalizedKey || !normalizedModel || typeof fetchImpl !== "function" ||
      typeof FormData !== "function" || typeof Blob !== "function") {
    return null;
  }

  return Object.freeze({
    name: "workflow_transcription",
    provider: "openai",
    model: normalizedModel,
    async transcribe({ audio, mimeType, locale }) {
      const extension = mimeType.includes("mp4") ? "m4a"
        : mimeType.includes("mpeg") ? "mp3"
          : mimeType.includes("wav") ? "wav"
            : "webm";
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mimeType }), `ask-meetro.${extension}`);
      form.append("model", normalizedModel);
      form.append("response_format", "json");
      if (locale) form.append("language", String(locale).split(/[-_]/)[0]);
      const response = await fetchImpl(OPENAI_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${normalizedKey}` },
        body: form,
      });
      const payload = await readSafeJson(response);
      if (!response.ok) {
        throw providerError(
          classifyProviderFailure(response.status, payload),
          "The governed transcription provider rejected the request."
        );
      }
      const transcript = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!transcript) throw providerError("malformed_operation_result", "The provider returned no transcript.");
      return { transcript };
    },
  });
}

function createWorkflowProviderConfiguration(env = process.env, dependencies = {}) {
  const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  const workflowModel = env.OPENAI_WORKFLOW_ASSISTANCE_MODEL || DEFAULT_WORKFLOW_MODEL;
  const transcriptionModel = env.OPENAI_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL;
  const workflowProvider = createOpenAiWorkflowProvider({
    apiKey,
    model: workflowModel,
    fetchImpl: dependencies.fetchImpl,
    logger: dependencies.logger,
  });
  const transcriptionProvider = createOpenAiTranscriptionProvider({
    apiKey,
    model: transcriptionModel,
    fetchImpl: dependencies.fetchImpl,
  });
  const alias = (name) => workflowProvider ? Object.freeze({ ...workflowProvider, name }) : null;
  return Object.freeze({
    configured: Boolean(workflowProvider && transcriptionProvider),
    metadata: Object.freeze({
      configured: Boolean(workflowProvider && transcriptionProvider),
      provider: workflowProvider?.provider || null,
      workflowModel: workflowProvider?.model || null,
      transcriptionModel: transcriptionProvider?.model || null,
    }),
    providers: workflowProvider ? Object.freeze({
      job_request: alias("job_request"),
      quote_composition: alias("quote_composition"),
      workflow_assistance: workflowProvider,
    }) : Object.freeze({}),
    transcriptionProvider,
  });
}

module.exports = {
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_WORKFLOW_MODEL,
  classifyProviderFailure,
  createOpenAiTranscriptionProvider,
  createOpenAiWorkflowProvider,
  createWorkflowProviderConfiguration,
  responseOutputText,
  safeProviderDiagnostics,
};
