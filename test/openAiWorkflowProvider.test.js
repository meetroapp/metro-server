"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyProviderFailure,
  createOpenAiTranscriptionProvider,
  createOpenAiWorkflowProvider,
  createWorkflowProviderConfiguration,
} = require("../server/intelligence/openAiWorkflowProvider");

function response({ ok = true, status = 200, payload = {}, requestId = "req_fixture" } = {}) {
  return {
    ok,
    status,
    headers: { get(name) { return name === "x-request-id" ? requestId : null; } },
    async json() { return payload; },
  };
}

test("workflow provider configuration is server-owned and exposes only safe metadata", () => {
  const absent = createWorkflowProviderConfiguration({});
  const configured = createWorkflowProviderConfiguration({
    OPENAI_API_KEY: "fixture-secret",
    OPENAI_WORKFLOW_ASSISTANCE_MODEL: "fixture-workflow-model",
    OPENAI_TRANSCRIPTION_MODEL: "fixture-transcription-model",
  }, { fetchImpl: async () => response() });

  assert.equal(absent.configured, false);
  assert.deepEqual(absent.providers, {});
  assert.equal(configured.configured, true);
  assert.deepEqual(Object.keys(configured.providers).sort(), [
    "job_request",
    "quote_composition",
    "workflow_assistance",
  ]);
  assert.deepEqual(configured.metadata, {
    configured: true,
    provider: "openai",
    workflowModel: "fixture-workflow-model",
    transcriptionModel: "fixture-transcription-model",
  });
  assert.equal(JSON.stringify(configured.metadata).includes("fixture-secret"), false);
});

test("workflow provider sends governed JSON through the Responses API without embedding the key", async () => {
  const calls = [];
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "fixture-model",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ payload: { output_text: '{"schemaVersion":1,"summary":"Review this suggestion."}' } });
    },
  });
  const result = await provider.complete({
    operation: "invoice.assist",
    canonicalInvoiceContext: { jobId: "fixture" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-secret");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "fixture-model");
  assert.equal(body.store, false);
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  assert.equal(body.input.includes("fixture-secret"), false);
  assert.equal(body.instructions.includes("advisory"), true);
  assert.equal(body.instructions.includes("assistant_suggested or assistant_inferred"), false);
  assert.deepEqual(result, { schemaVersion: 1, summary: "Review this suggestion." });
});

test("explicit Evaluation photo analysis sends authorized canonical media as Responses input_image content", async () => {
  const calls = [];
  const mediaId = "meetro/users/65/request-photos/selected";
  const mediaUrl = "https://res.cloudinary.com/meetro/image/upload/selected.jpg";
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "gpt-5.4-mini",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ payload: { output_text: '{"schemaVersion":1}' } });
    },
  });

  await provider.complete({
    operation: "evaluation.assist",
    canonicalJobContext: {
      intent: "ANALYZE_PHOTOS",
      requestPhotos: [{ id: mediaId, mediaType: "IMAGE" }],
    },
    authorizedImageInputs: [{ mediaId, imageUrl: mediaUrl }],
  });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.store, false);
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  assert.equal(Array.isArray(body.input), true);
  assert.equal(body.input[0].role, "user");
  assert.equal(body.input[0].content[0].type, "input_text");
  assert.equal(body.input[0].content[0].text.includes(mediaUrl), false);
  assert.deepEqual(body.input[0].content.slice(1), [{
    type: "input_image",
    image_url: mediaUrl,
    detail: "auto",
  }]);
});

test("Evaluation metadata and non-photo intents never become image transport", async () => {
  const calls = [];
  const mediaUrl = "https://res.cloudinary.com/meetro/image/upload/metadata-only.jpg";
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ payload: { output_text: '{"schemaVersion":1}' } });
    },
  });

  await provider.complete({
    operation: "evaluation.assist",
    canonicalJobContext: {
      intent: "DESCRIBE_CONDITION",
      requestPhotos: [{ id: "metadata-only", secureUrl: mediaUrl }],
    },
    authorizedImageInputs: [{ mediaId: "metadata-only", imageUrl: mediaUrl }],
  });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(typeof body.input, "string");
  assert.equal(body.input.includes("input_image"), false);
  assert.equal(body.input.includes("authorizedImageInputs"), false);
});

test("Evaluation image transport rejects foreign URLs, mismatched identities, and more than five images", async () => {
  let calls = 0;
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    fetchImpl: async () => {
      calls += 1;
      return response({ payload: { output_text: '{"schemaVersion":1}' } });
    },
  });
  const request = {
    operation: "evaluation.assist",
    canonicalJobContext: {
      intent: "ANALYZE_PHOTOS",
      requestPhotos: [{ id: "canonical-photo" }],
    },
  };

  await assert.rejects(
    provider.complete({
      ...request,
      authorizedImageInputs: [{ mediaId: "canonical-photo", imageUrl: "https://attacker.example/photo.jpg" }],
    }),
    (error) => error.code === "provider_request_invalid"
  );
  await assert.rejects(
    provider.complete({
      ...request,
      authorizedImageInputs: [{
        mediaId: "other-job-photo",
        imageUrl: "https://res.cloudinary.com/meetro/image/upload/other.jpg",
      }],
    }),
    (error) => error.code === "provider_request_invalid"
  );
  await assert.rejects(
    provider.complete({
      ...request,
      canonicalJobContext: {
        ...request.canonicalJobContext,
        requestPhotos: Array.from({ length: 6 }, (_, index) => ({ id: `photo-${index}` })),
      },
      authorizedImageInputs: Array.from({ length: 6 }, (_, index) => ({
        mediaId: `photo-${index}`,
        imageUrl: `https://res.cloudinary.com/meetro/image/upload/photo-${index}.jpg`,
      })),
    }),
    (error) => error.code === "provider_request_invalid"
  );
  assert.equal(calls, 0);
});

test("standalone Quick Quote photo assistance sends only authorized governed image inputs", async () => {
  const calls = [];
  const mediaId =
    "meetro/businesses/71/quote-drafts/photo-one";
  const mediaUrl =
    "https://res.cloudinary.com/meetro/image/upload/meetro/businesses/71/quote-drafts/photo-one.jpg";

  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "gpt-5.4-mini",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        payload: {
          output_text: '{"schemaVersion":1}',
        },
      });
    },
  });

  await provider.complete({
    operation: "quick_quote.photo_assist",
    quickQuoteDraftContext: {
      intent: "ANALYZE_PHOTOS",
      prompt: "",
      photos: [
        {
          id: mediaId,
          mediaType: "IMAGE",
          format: "jpg",
          version: 7,
        },
      ],
    },
    authorizedImageInputs: [
      {
        mediaId,
        imageUrl: mediaUrl,
      },
    ],
  });

  const body =
    JSON.parse(calls[0].options.body);

  assert.equal(
    Array.isArray(body.input),
    true
  );

  assert.equal(
    body.input[0].content[0].type,
    "input_text"
  );

  assert.equal(
    body.input[0].content[0].text.includes(
      mediaUrl
    ),
    false
  );

  assert.deepEqual(
    body.input[0].content.slice(1),
    [
      {
        type: "input_image",
        image_url: mediaUrl,
        detail: "auto",
      },
    ]
  );

  let foreignCalls = 0;

  const guardedProvider =
    createOpenAiWorkflowProvider({
      apiKey: "fixture-secret",
      fetchImpl: async () => {
        foreignCalls += 1;
        return response({
          payload: {
            output_text: '{"schemaVersion":1}',
          },
        });
      },
    });

  await assert.rejects(
    guardedProvider.complete({
      operation: "quick_quote.photo_assist",
      quickQuoteDraftContext: {
        intent: "ANALYZE_PHOTOS",
        photos: [{ id: mediaId }],
      },
      authorizedImageInputs: [
        {
          mediaId: "foreign-photo",
          imageUrl: mediaUrl,
        },
      ],
    }),
    (error) =>
      error.code ===
      "provider_request_invalid"
  );

  assert.equal(foreignCalls, 0);
});

test("Job Request provider instructions use the exact governed parser vocabulary", async () => {
  const calls = [];
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "fixture-model",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        payload: {
          output_text: JSON.stringify({
            schemaVersion: 1,
            summary: "Review this suggestion.",
            draftPatch: { fields: [] },
            clarifications: [],
            warnings: [],
          }),
        },
      });
    },
  });

  await provider.complete({ operation: "job_request.interpret" });
  const instructions = JSON.parse(calls[0].options.body).instructions;
  assert.match(instructions, /assistant_suggested or assistant_inferred/);
  assert.match(instructions, /assistant_suggested or approximate or uncertain/);
  assert.doesNotMatch(instructions, /AI_SUGGESTED or INFERRED/);
  assert.doesNotMatch(instructions, /KNOWN or UNCERTAIN or NEEDS_CLARIFICATION/);
});

test("Estimate provider uses strict Structured Outputs for its governed result contract", async () => {
  const calls = [];
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "fixture-model",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        payload: {
          output_text: JSON.stringify({
            schemaVersion: 1,
            summary: "Verify measurements and prices.",
            materials: [],
            labor: [],
            equipment: [],
            disposal: { description: "", costInputKey: null },
            contingencyPercent: 0,
            assumptions: [],
            missingInformation: [],
            suggestedSellingRange: { minimumMinor: 0, maximumMinor: 0, rationale: "Pricing is unverified." },
            customerQuoteDraft: {
              scopeSummary: "Draft scope.",
              conditions: [],
              exclusions: [],
              durationGuidance: "",
              customerWording: "Draft wording.",
            },
            warnings: [],
          }),
        },
      });
    },
  });

  await provider.complete({
    operation: "estimate.compose",
    internalProfessionalContext: {
      professionalInput: {
        costInputs: [
          { key: "material.valid", classification: "MATERIAL" },
          { key: "labor.valid", classification: "LABOR" },
        ],
      },
      retailerReferences: [{ id: "retailer.valid" }],
    },
  });
  const format = JSON.parse(calls[0].options.body).text.format;
  const estimateInput = JSON.parse(calls[0].options.body).input;
  assert.equal(format.type, "json_schema");
  assert.equal(format.name, "meetro_estimate_compose");
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.deepEqual(format.schema.required, [
    "schemaVersion", "summary", "materials", "labor", "equipment", "disposal",
    "contingencyPercent", "assumptions", "missingInformation", "suggestedSellingRange",
    "customerQuoteDraft", "warnings",
  ]);
  assert.equal(format.schema.properties.materials.items.additionalProperties, false);
  assert.deepEqual(format.schema.properties.materials.items.properties.costInputKey.enum, [null, "material.valid"]);
  assert.deepEqual(format.schema.properties.materials.items.properties.retailerReferenceId.enum, [null, "retailer.valid"]);
  assert.deepEqual(format.schema.properties.labor.items.properties.costInputKey.enum, [null, "labor.valid"]);
  assert.deepEqual(format.schema.properties.equipment.items.properties.costInputKey.enum, [null]);
  assert.deepEqual(format.schema.properties.disposal.properties.costInputKey.enum, [null]);
  assert.equal(format.schema.properties.materials.items.properties.quantity.exclusiveMinimum, 0);
  assert.equal(format.schema.properties.contingencyPercent.maximum, 50);
  assert.equal(typeof estimateInput, "string");
  assert.equal(estimateInput.includes("input_image"), false);
});

test("provider failures are reduced to safe governed classifications", async () => {
  assert.equal(classifyProviderFailure(401, {}), "provider_authentication_failed");
  assert.equal(classifyProviderFailure(429, { error: { code: "insufficient_quota" } }), "provider_quota_exhausted");
  assert.equal(classifyProviderFailure(403, {}), "provider_access_denied");
  assert.equal(classifyProviderFailure(404, {}), "provider_model_unavailable");
  assert.equal(classifyProviderFailure(400, { error: { code: "billing_hard_limit_reached" } }), "provider_billing_required");
  assert.equal(classifyProviderFailure(400, { error: { type: "invalid_request_error" } }), "provider_request_invalid");
  assert.equal(classifyProviderFailure(500, {}), "provider_upstream_failure");

  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    fetchImpl: async () => response({ ok: false, status: 429, payload: { error: { code: "insufficient_quota", message: "private detail" } } }),
  });
  await assert.rejects(
    provider.complete({ operation: "evaluation.assist" }),
    (error) => error.code === "provider_quota_exhausted" && !error.message.includes("private detail")
  );
});

test("provider diagnostics log only safe upstream metadata", async () => {
  const events = [];
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "fixture-model",
    logger: { error(event, metadata) { events.push({ event, metadata }); } },
    fetchImpl: async () => response({
      ok: false,
      status: 400,
      requestId: "req_safe_fixture",
      payload: {
        error: {
          type: "invalid_request_error",
          code: "unsupported_parameter",
          param: "text.format",
          message: "Bearer fixture-secret rejected sk-private-value",
        },
      },
    }),
  });

  await assert.rejects(
    provider.complete({ operation: "evaluation.assist", privateContext: "customer detail" }),
    (error) => error.code === "provider_request_invalid"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "intelligence.provider.upstream_failure");
  assert.deepEqual(events[0].metadata, {
    httpStatus: 400,
    errorType: "invalid_request_error",
    errorCode: "unsupported_parameter",
    errorParam: "text.format",
    errorMessage: "Bearer [redacted] rejected [redacted]",
    requestId: "req_safe_fixture",
    model: "fixture-model",
    endpointFamily: "responses",
  });
  assert.equal(JSON.stringify(events).includes("customer detail"), false);
  assert.equal(JSON.stringify(events).includes("fixture-secret"), false);
});

test("multimodal provider failures do not log image URLs or raw image request content", async () => {
  const events = [];
  const mediaId = "meetro/users/65/request-photos/private-fixture";
  const mediaUrl = "https://res.cloudinary.com/meetro/image/upload/private-fixture.jpg";
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "gpt-5.4-mini",
    logger: { error(event, metadata) { events.push({ event, metadata }); } },
    fetchImpl: async () => response({
      ok: false,
      status: 400,
      requestId: "req_multimodal_safe",
      payload: { error: { type: "invalid_request_error", code: "invalid_image" } },
    }),
  });

  await assert.rejects(provider.complete({
    operation: "evaluation.assist",
    canonicalJobContext: {
      intent: "ANALYZE_PHOTOS",
      requestPhotos: [{ id: mediaId }],
    },
    authorizedImageInputs: [{ mediaId, imageUrl: mediaUrl }],
  }));

  const logged = JSON.stringify(events);
  assert.equal(logged.includes(mediaUrl), false);
  assert.equal(logged.includes(mediaId), false);
  assert.equal(logged.includes("input_image"), false);
  assert.equal(logged.includes("fixture-secret"), false);
  assert.equal(events[0].metadata.requestId, "req_multimodal_safe");
});

test("minimal provider smoke uses the governed adapter without storage", async () => {
  const calls = [];
  const events = [];
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "fixture-model",
    logger: { info(event, metadata) { events.push({ event, metadata }); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ payload: { output_text: "OK" }, requestId: "req_smoke_fixture" });
    },
  });

  assert.deepEqual(await provider.smoke(), {
    ok: true,
    model: "fixture-model",
    endpointFamily: "responses",
    requestId: "req_smoke_fixture",
    store: false,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "fixture-model");
  assert.equal(body.store, false);
  assert.equal(body.input, "Reply with the word OK.");
  assert.equal(body.text, undefined);
  assert.equal(events[0].event, "intelligence.provider.smoke_completed");
});

test("transcription provider sends audio as multipart and returns transcript only", async () => {
  const calls = [];
  const provider = createOpenAiTranscriptionProvider({
    apiKey: "fixture-secret",
    model: "fixture-transcription-model",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ payload: { text: "  inspect the drain line  " } });
    },
  });
  const result = await provider.transcribe({
    audio: Buffer.from("fixture-audio"),
    mimeType: "audio/webm",
    locale: "en-US",
  });

  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-secret");
  assert.equal(calls[0].options.headers["Content-Type"], undefined);
  assert.equal(calls[0].options.body instanceof FormData, true);
  assert.deepEqual(result, { transcript: "inspect the drain line" });
});

test("workflow provider returns out-of-band privacy-safe metadata with completed result", async () => {
  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    model: "fixture-model",
    fetchImpl: async () => response({
      payload: {
        output_text: JSON.stringify({
          schemaVersion: 1,
          summary: "Review this suggestion.",
          materials: [],
          labor: [],
          equipment: [],
          disposal: { description: "", costInputKey: null },
          contingencyPercent: 0,
          assumptions: [],
          missingInformation: [],
          suggestedSellingRange: { minimumMinor: 0, maximumMinor: 0, rationale: "Pricing is unverified." },
          customerQuoteDraft: {
            scopeSummary: "Draft scope.",
            conditions: [],
            exclusions: [],
            durationGuidance: "",
            customerWording: "Draft wording.",
          },
          warnings: [],
        }),
      },
      requestId: "req_workflow_provider_metadata",
    }),
  });

  const result = await provider.complete({
    operation: "estimate.compose",
    internalProfessionalContext: {
      professionalInput: { costInputs: [] },
      retailerReferences: [],
    },
  });

  const descriptor = Object.getOwnPropertyDescriptor(result, "__providerMetadata");
  assert.ok(descriptor && descriptor.enumerable === false);
  assert.equal(result.__providerMetadata.providerRequestId, "req_workflow_provider_metadata");
  assert.equal(result.__providerMetadata.configuredModel, "fixture-model");
});
