"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  buildQuickQuotePhotoAssistContext,
  parseQuickQuotePhotoAssistResult,
  quickQuotePhotoAssistOperationDefinition,
} = require(
  "../server/intelligence/operations/quickQuotePhotoAssist"
);

const {
  canonicalIntelligenceOperationRegistry,
} = require(
  "../server/intelligence/intelligenceOperationRegistry"
);

const {
  canonicalIntelligenceEngineRegistry,
} = require(
  "../server/intelligence/intelligenceEngineRegistry"
);

const MEDIA_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "fixture-cloud",
  CLOUDINARY_API_KEY: "fixture-key",
  CLOUDINARY_API_SECRET: "fixture-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro",
});

function governedPhoto({
  owner = 71,
  suffix = "photo-one",
  version = 7,
} = {}) {
  const publicId =
    `meetro/businesses/${owner}/quote-drafts/${suffix}`;

  return {
    secure_url:
      `https://res.cloudinary.com/fixture-cloud/image/upload/${publicId}.jpg`,
    public_id: publicId,
    resource_type: "image",
    format: "jpg",
    bytes: 125000,
    width: 1200,
    height: 900,
    version,
    uploaded_at: "2026-08-18T12:00:00.000Z",
  };
}

function runtime({
  actorId = 65,
  role = "professional",
  contractorProfileId = 71,
} = {}) {
  return {
    authenticatedActor: {
      id: actorId,
      role,
    },
    env: MEDIA_ENV,
    pool: {
      async query(sql, values) {
        assert.match(
          sql,
          /FROM contractor_profiles/
        );
        assert.deepEqual(values, [actorId]);

        return {
          rows:
            contractorProfileId == null
              ? []
              : [{ id: contractorProfileId }],
        };
      },
    },
  };
}

function input(overrides = {}) {
  return {
    prompt: "",
    photos: [governedPhoto()],
    ...overrides,
  };
}

test(
  "Quick Quote photo assistance is registered as professional advisory authority",
  async () => {
    const definition =
      canonicalIntelligenceOperationRegistry.get(
        "quick_quote.photo_assist"
      );

    assert.ok(definition);
    assert.equal(
      definition.capability,
      "quick_quote.photo_assist"
    );
    assert.deepEqual(
      definition.supportedRoles,
      ["professional"]
    );
    assert.equal(
      definition.roleAuthorization,
      "context_builder"
    );
    assert.deepEqual(
      definition.engineIds,
      ["quick_quote_photo_advisory_boundary"]
    );

    const engine =
      canonicalIntelligenceEngineRegistry.get(
        "quick_quote_photo_advisory_boundary"
      );

    assert.ok(engine);

    assert.deepEqual(
      await engine.collectContext(),
      {
        mutationAllowed: false,
        commercialMutationAllowed: false,
        customerVisibleByDefault: false,
        observedVsAssumptionRequired: true,
        mediaType: "image",
      }
    );
  }
);

test(
  "owned governed Quick Quote photos become safe multimodal provider context",
  async () => {
    const photo = governedPhoto();

    const context =
      await buildQuickQuotePhotoAssistContext({
        context: {},
        input: {
          prompt:
            "Review the visible damage and suggest repair considerations.",
          photos: [photo],
        },
        runtimeContext: runtime(),
      });

    assert.equal(context.mode, "ADVISORY");
    assert.equal(
      context.intent,
      "ANALYZE_PHOTOS"
    );
    assert.equal(context.photos.length, 1);
    assert.equal(
      context.photos[0].id,
      photo.public_id
    );
    assert.equal(
      context.photos[0].secureUrl,
      photo.secure_url
    );

    assert.equal(
      context.photos[0].version,
      photo.version
    );

    assert.deepEqual(
      context.photos[0].sourceReferences,
      [
        {
          type: "QUOTE_DRAFT_PHOTO",
          id: photo.public_id,
          version: 1,
        },
      ]
    );

    const providerRequest =
      quickQuotePhotoAssistOperationDefinition
        .buildProviderRequest({
          semanticInput: {
            locale: "en-US",
            context,
          },
          engineContext: {
            quick_quote_photo_advisory_boundary: {
              mutationAllowed: false,
            },
          },
        });

    assert.equal(
      providerRequest.operation,
      "quick_quote.photo_assist"
    );

    assert.equal(
      JSON.stringify(
        providerRequest.quickQuoteDraftContext
      ).includes(photo.secure_url),
      false
    );

    assert.equal(
      JSON.stringify(
        providerRequest.quickQuoteDraftContext
      ).includes("contractor_profile_id"),
      false
    );

    assert.deepEqual(
      providerRequest.authorizedImageInputs,
      [
        {
          mediaId: photo.public_id,
          imageUrl: photo.secure_url,
        },
      ]
    );
  }
);

test(
  "service-role professional tokens authorize Quick Quote media through exact owned business profile",
  async () => {
    const photo = governedPhoto();

    const context =
      await buildQuickQuotePhotoAssistContext({
        context: {},
        input: {
          prompt:
            "Review the visible job condition.",
          photos: [photo],
        },
        runtimeContext: runtime({
          role: "windows_doors",
        }),
      });

    assert.equal(
      context.generatedFor.professionalUserId,
      65
    );

    assert.equal(
      context.photos[0].id,
      photo.public_id
    );

    assert.equal(
      context.photos[0].secureUrl,
      photo.secure_url
    );
  }
);

test(
  "Quick Quote photo assistance fails closed for foreign media and missing business ownership",
  async () => {
    await assert.rejects(
      buildQuickQuotePhotoAssistContext({
        context: {},
        input: input({
          photos: [
            governedPhoto({
              owner: 999,
            }),
          ],
        }),
        runtimeContext: runtime(),
      }),
      (error) =>
        error.code ===
        "intelligence_context_invalid"
    );

    await assert.rejects(
      buildQuickQuotePhotoAssistContext({
        context: {},
        input: input(),
        runtimeContext: runtime({
          role: "windows_doors",
          contractorProfileId: null,
        }),
      }),
      (error) =>
        error.code ===
        "intelligence_quick_quote_media_authority_required"
    );
  }
);

test(
  "Quick Quote photo assistance requires one to five governed images and rejects caller authority fields",
  async () => {
    await assert.rejects(
      buildQuickQuotePhotoAssistContext({
        context: {},
        input: input({
          photos: [],
        }),
        runtimeContext: runtime(),
      }),
      (error) =>
        error.code ===
        "intelligence_context_invalid"
    );

    await assert.rejects(
      buildQuickQuotePhotoAssistContext({
        context: {},
        input: input({
          photos: Array.from(
            { length: 6 },
            (_, index) =>
              governedPhoto({
                suffix: `photo-${index}`,
              })
          ),
        }),
        runtimeContext: runtime(),
      }),
      (error) =>
        error.code ===
        "intelligence_context_invalid"
    );

    await assert.rejects(
      buildQuickQuotePhotoAssistContext({
        context: {},
        input: {
          ...input(),
          imageUrl:
            "https://attacker.example/private.jpg",
        },
        runtimeContext: runtime(),
      }),
      (error) =>
        error.code ===
        "intelligence_context_invalid"
    );
  }
);

test(
  "Quick Quote photo result separates observations verification and advisory repair or materials",
  async () => {
    const photo = governedPhoto();

    const context =
      await buildQuickQuotePhotoAssistContext({
        context: {},
        input: input(),
        runtimeContext: runtime(),
      });

    const source = {
      type: "QUOTE_DRAFT_PHOTO",
      id: photo.public_id,
      version: 1,
    };

    const result =
      parseQuickQuotePhotoAssistResult(
        {
          schemaVersion: 1,
          summary:
            "Visible separation should be reviewed before repair scope is finalized.",

          observed: [
            {
              id: "visible_separation",
              text:
                "Visible separation is present along the photographed wall section.",
              classification: "OBSERVED",
              sourceReferences: [source],
            },
          ],

          needsVerification: [
            {
              id: "concealed_support",
              text:
                "Concealed support and attachment conditions require field verification.",
              classification:
                "NEEDS_VERIFICATION",
              sourceReferences: [],
            },
          ],

          repairSuggestions: [
            {
              id: "review_reconstruction",
              text:
                "Review removal and reconstruction of the affected section after concealed conditions are verified.",
              classification: "AI_SUGGESTED",
              sourceReferences: [source],
            },
          ],

          materialSuggestions: [
            {
              id: "masonry_materials",
              text:
                "Consider masonry repair materials appropriate to the verified wall construction.",
              classification: "AI_SUGGESTED",
              sourceReferences: [source],
            },
          ],

          photoAnalysis: {
            analyzedReferenceIds: [
              photo.public_id,
            ],
            limitations: [
              "Image scale does not establish hidden dimensions.",
            ],
          },

          warnings: [],
        },
        {
          semanticInput: { context },
          operationId: randomUUID(),
        }
      );

    assert.equal(
      result.authorityClassification,
      "ADVISORY_NON_CANONICAL"
    );

    assert.equal(
      result.observed[0].classification,
      "OBSERVED"
    );

    assert.equal(
      result.needsVerification[0]
        .classification,
      "NEEDS_VERIFICATION"
    );

    assert.equal(
      result.repairSuggestions[0]
        .classification,
      "AI_SUGGESTED"
    );

    assert.equal(
      result.materialSuggestions[0]
        .classification,
      "AI_SUGGESTED"
    );

    assert.equal(
      result.photoAnalysis
        .imageMeasurementsAreEstimates,
      true
    );

    assert.equal(
      result.humanToCanonicalBoundary
        .directMutationAllowed,
      false
    );

    assert.equal(
      result.reviewContract
        .explicitHumanDecisionRequired,
      true
    );

    assert.equal(
      JSON.stringify(result).includes(
        "retailerReference"
      ),
      false
    );

    assert.equal(
      JSON.stringify(result).includes(
        "sellingPrice"
      ),
      false
    );
  }
);

test(
  "Quick Quote observed claims require exact photo evidence and analyzed IDs stay authorized",
  async () => {
    const context =
      await buildQuickQuotePhotoAssistContext({
        context: {},
        input: input(),
        runtimeContext: runtime(),
      });

    const base = {
      schemaVersion: 1,
      summary: "Review.",
      observed: [],
      needsVerification: [],
      repairSuggestions: [],
      materialSuggestions: [],
      photoAnalysis: {
        analyzedReferenceIds: [],
        limitations: [],
      },
      warnings: [],
    };

    assert.throws(
      () =>
        parseQuickQuotePhotoAssistResult(
          {
            ...base,
            observed: [
              {
                id: "unsupported_observation",
                text: "Unsupported observation.",
                classification: "OBSERVED",
                sourceReferences: [],
              },
            ],
          },
          {
            semanticInput: { context },
            operationId: randomUUID(),
          }
        ),
      (error) =>
        error.code ===
        "malformed_operation_result"
    );

    assert.throws(
      () =>
        parseQuickQuotePhotoAssistResult(
          {
            ...base,
            photoAnalysis: {
              analyzedReferenceIds: [
                "foreign-photo",
              ],
              limitations: [],
            },
          },
          {
            semanticInput: { context },
            operationId: randomUUID(),
          }
        ),
      (error) =>
        error.code ===
        "malformed_operation_result"
    );
  }
);
