"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  executeIntelligenceGateway,
} = require("../server/intelligence/intelligenceGateway");
const {
  canonicalIntelligenceEngineRegistry,
} = require("../server/intelligence/intelligenceEngineRegistry");
const {
  canonicalIntelligenceOperationRegistry,
} = require("../server/intelligence/intelligenceOperationRegistry");
const {
  JOB_REQUEST_INTERPRET_PATCH_PATHS,
  parseJobRequestInterpretResult,
} = require("../server/intelligence/operations/jobRequestInterpret");
const {
  createIntelligenceOperationRepositoryFake,
} = require("./helpers/intelligenceOperationFake");

function requestBody({ text = "The cabinet under my sink is swollen from a leak.", draft = {} } = {}) {
  return {
    operation: "job_request.interpret",
    capability: "job_request.interpret",
    locale: "en-US",
    context: {
      draft: {
        version: 1,
        job: { title: "", description: "" },
        service: {
          category: "",
          requestCategory: "",
          domain: "",
          specialty: "",
        },
        location: {
          affectedArea: "kitchen",
          city: "Cape Coral",
          region: "",
          postalCode: "",
        },
        timing: { urgency: "", desiredTiming: "", availability: "" },
        details: { measurements: "", expectations: "", additionalNotes: "" },
        fieldState: [],
        photosAttached: true,
        ...draft,
      },
    },
    input: { text },
  };
}

function patch(overrides = {}) {
  return {
    path: "job.title",
    value: "Repair water-damaged sink cabinet",
    provenance: "assistant_suggested",
    confidence: 0.86,
    uncertainty: "assistant_suggested",
    requiresConfirmation: true,
    rationale: "The homeowner described cabinet damage near a leak.",
    ...overrides,
  };
}

function providerResult(overrides = {}) {
  return {
    schemaVersion: 1,
    summary: "The request may involve a plumbing leak and cabinet damage.",
    draftPatch: { fields: [patch()] },
    clarifications: [{
      question: "Has the leak already been repaired?",
      fieldPath: "details.additionalNotes",
    }],
    warnings: [{
      code: "inspection_may_be_needed",
      message: "A professional may need to inspect the damage.",
    }],
    ...overrides,
  };
}

function fixture({ complete } = {}) {
  const repository = createIntelligenceOperationRepositoryFake();
  const providerCalls = [];
  const usageCalls = [];
  const providers = {
    job_request: {
      name: "job_request",
      async complete(request) {
        providerCalls.push(request);
        return complete ? complete(request) : providerResult();
      },
    },
  };
  return {
    repository,
    providerCalls,
    usageCalls,
    run(overrides = {}) {
      return executeIntelligenceGateway({
        pool: { name: "repository-fake" },
        authenticatedActor: { id: 91, role: "homeowner" },
        idempotencyKey: randomUUID(),
        body: requestBody(),
        operationRegistry: canonicalIntelligenceOperationRegistry,
        engineRegistry: canonicalIntelligenceEngineRegistry,
        providers,
        repository,
        usageFinalizer: async (identity) => {
          usageCalls.push(identity);
          return { classification: "fixture" };
        },
        ...overrides,
      });
    },
  };
}

test("canonical registration retains the bounded homeowner operation and fixed engines", () => {
  const operations = canonicalIntelligenceOperationRegistry.list();
  assert.deepEqual(
    operations.map(({ operation }) => operation).sort(),
    [
      "estimate.compose",
      "evaluation.assist",
      "invoice.assist",
      "job_request.interpret",
      "quick_quote.photo_assist",
      "quote.compose",
    ]
  );
  assert.deepEqual(operations.find(({ operation }) => operation === "job_request.interpret"), {
    operation: "job_request.interpret",
    capability: "job_request.interpret",
    supportedRoles: ["homeowner"],
    engineIds: ["job_request_capability", "job_request_validation"],
    providerName: "job_request",
  });
  assert.equal(canonicalIntelligenceOperationRegistry.get("ask_meetro"), null);
  assert.equal(canonicalIntelligenceOperationRegistry.get("test.echo"), null);
});

test("authentication, role, capability, and browser actor spoofing fail before execution", async () => {
  const current = fixture();
  const unauthenticated = await current.run({ authenticatedActor: null });
  const ineligible = await current.run({
    authenticatedActor: { id: 91, role: "professional" },
  });
  const wrongCapability = await current.run({
    body: { ...requestBody(), capability: "job_request.create" },
  });
  const spoofed = await current.run({
    body: { ...requestBody(), actor: { id: 999, role: "homeowner" } },
  });

  assert.equal(unauthenticated.code, "INTELLIGENCE_AUTHENTICATION_REQUIRED");
  assert.equal(ineligible.code, "INTELLIGENCE_CAPABILITY_FORBIDDEN");
  assert.equal(wrongCapability.code, "INTELLIGENCE_CAPABILITY_FORBIDDEN");
  assert.equal(spoofed.code, "INTELLIGENCE_REQUEST_FIELDS_UNSUPPORTED");
  assert.equal(current.providerCalls.length, 0);
  assert.equal(current.repository.calls.length, 0);
});

test("eligible homeowner receives a validated proposal through the canonical Gateway", async () => {
  const current = fixture();
  const result = await current.run();

  assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(result.operation, "job_request.interpret");
  assert.equal(result.result.validation.status, "accepted");
  assert.equal(result.result.validation.patchCount, 1);
  assert.deepEqual(result.usage, { state: "finalized", classification: "fixture" });
  assert.equal(current.providerCalls.length, 1);
  assert.equal(current.usageCalls.length, 1);
});

test("provider request contains only bounded text, draft state, and server-selected engines", async () => {
  const current = fixture();
  await current.run();
  const request = current.providerCalls[0];
  const serialized = JSON.stringify(request);

  assert.equal(request.operation, "job_request.interpret");
  assert.equal(request.homeownerText, "The cabinet under my sink is swollen from a leak.");
  assert.equal(request.currentDraft.location.affectedArea, "kitchen");
  assert.equal(request.currentDraft.location.city, "Cape Coral");
  assert.equal(request.currentDraft.photosAttached, true);
  assert.deepEqual(Object.keys(request.operationContext).sort(), ["capability", "validation"]);
  assert.equal(request.operationContext.capability.mediaAllowed, false);
  for (const prohibited of [
    "localDraftId", "serviceAddress", "unitNumber", "accessNotes", "previewUrl",
    "file", "submission", "postId", "relationshipId", "conversationId", "payment",
    "authorization", "localStorage", "providerName", "model", "memory",
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test("strict context rejects whole-draft, address, media, and authority additions before reservation", async () => {
  const current = fixture();
  const cases = [
    { localDraftId: "draft-private" },
    { serviceAddress: "101 Private Street" },
    { accessNotes: "Gate code 1234" },
    { photos: [{ previewUrl: "https://example.test/private.jpg" }] },
    { submission: { intentKey: randomUUID() } },
  ];

  for (const addition of cases) {
    const result = await current.run({
      body: requestBody({ draft: addition }),
    });
    assert.equal(result.code, "INTELLIGENCE_CONTEXT_INVALID");
  }
  assert.equal(current.providerCalls.length, 0);
  assert.equal(current.repository.calls.length, 0);
});

test("legacy clients may omit general locality while exact address remains excluded", async () => {
  const current = fixture();
  const result = await current.run({
    body: requestBody({
      draft: { location: { affectedArea: "front entry" } },
    }),
  });

  assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.deepEqual(current.providerCalls[0].currentDraft.location, {
    affectedArea: "front entry",
    city: "",
    region: "",
    postalCode: "",
  });
});

test("first completion, replay, and conflict execute and finalize exactly once", async () => {
  const current = fixture();
  const idempotencyKey = randomUUID();
  const first = await current.run({ idempotencyKey });
  const replay = await current.run({ idempotencyKey });
  const conflict = await current.run({
    idempotencyKey,
    body: requestBody({ text: "Now water is actively leaking." }),
  });

  assert.equal(first.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(replay.code, "INTELLIGENCE_OPERATION_REPLAYED");
  assert.equal(conflict.code, "INTELLIGENCE_OPERATION_CONFLICT");
  assert.deepEqual(replay.result, first.result);
  assert.equal(current.providerCalls.length, 1);
  assert.equal(current.usageCalls.length, 1);
});

test("concurrent duplicate returns in-progress while one provider owner completes", async () => {
  let release;
  let started;
  const providerStarted = new Promise((resolve) => { started = resolve; });
  const providerGate = new Promise((resolve) => { release = resolve; });
  const current = fixture({
    async complete() {
      started();
      await providerGate;
      return providerResult();
    },
  });
  const idempotencyKey = randomUUID();
  const owner = current.run({ idempotencyKey });
  await providerStarted;
  const duplicate = await current.run({ idempotencyKey });
  release();
  const completed = await owner;

  assert.equal(duplicate.code, "INTELLIGENCE_OPERATION_IN_PROGRESS");
  assert.equal(completed.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(current.providerCalls.length, 1);
  assert.equal(current.usageCalls.length, 1);
});

test("parser accepts strict JSON and constrains proposal provenance and confirmation", () => {
  const parsed = parseJobRequestInterpretResult(JSON.stringify(providerResult()));
  assert.equal(parsed.draftPatch.fields[0].provenance, "assistant_suggested");
  assert.equal(parsed.draftPatch.fields[0].requiresConfirmation, true);
  assert.equal(parsed.validation.taxonomy, "validated");
});

test("parser removes follow-ups for fields already present or proposed", () => {
  const parsed = parseJobRequestInterpretResult(
    providerResult({
      draftPatch: {
        fields: [
          patch({ path: "location.city", value: "Cape Coral" }),
          patch({ path: "timing.availability", value: "Available this week" }),
        ],
      },
      clarifications: [
        { question: "Which city?", fieldPath: "location.city" },
        { question: "Which area is affected?", fieldPath: "location.affectedArea" },
        { question: "Is there anything else to add?" },
      ],
    }),
    {
      semanticInput: {
        context: {
          draft: {
            location: { affectedArea: "front entry" },
          },
        },
      },
    }
  );

  assert.deepEqual(parsed.clarifications, [
    { question: "Is there anything else to add?" },
  ]);
});

test("one homeowner message can propose existing request fields without invented commercial facts", async () => {
  const homeownerText =
    "I need someone to repair a cracked section of the wall by my front entry in Cape Coral. It is separating and temporarily braced. I would like someone to inspect it and repair or rebuild the damaged area. I am available this week and I can add photos.";
  const proposedFields = [
    patch({ path: "job.title", value: "Repair cracked wall by front entry" }),
    patch({ path: "location.affectedArea", value: "front entry wall" }),
    patch({ path: "location.city", value: "Cape Coral" }),
    patch({ path: "timing.availability", value: "Available this week" }),
    patch({
      path: "details.additionalNotes",
      value: "The section is separating and temporarily braced. The homeowner can add photos.",
    }),
  ];
  const current = fixture({
    complete(request) {
      assert.equal(request.homeownerText, homeownerText);
      assert.ok(request.instructions.allowedPatchPaths.includes("location.city"));
      assert.ok(
        request.instructions.requirements.includes(
          "extract_all_homeowner_supplied_facts_before_clarifying"
        )
      );
      return providerResult({
        summary: "Review the project facts supplied by the homeowner.",
        draftPatch: { fields: proposedFields },
        clarifications: [
          { question: "What region and postal code should be used?", fieldPath: "location.region" },
        ],
        warnings: [],
      });
    },
  });

  const result = await current.run({
    authenticatedActor: {
      id: 91,
      role: "customer",
      accountType: "homeowner",
    },
    body: requestBody({ text: homeownerText }),
  });
  const serialized = JSON.stringify(result.result);

  assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.deepEqual(
    result.result.draftPatch.fields.map(({ path }) => path),
    [
      "job.title",
      "location.affectedArea",
      "location.city",
      "timing.availability",
      "details.additionalNotes",
    ]
  );
  assert.equal(result.result.clarifications.length, 1);
  assert.equal(/price|materials|diagnosis|permit|payment/i.test(serialized), false);
  assert.equal(current.providerCalls.length, 1);
});

test("parser fails closed for malformed, unknown, oversized, or unsafe provider output", () => {
  const invalidResults = [
    "{not-json",
    [],
    providerResult({ summary: "x".repeat(601) }),
    providerResult({ draftPatch: { fields: [patch({ path: "submission.status" })] } }),
    providerResult({ draftPatch: { fields: Array.from({ length: 17 }, (_, index) => patch({ path: JOB_REQUEST_INTERPRET_PATCH_PATHS[index % 16] })) } }),
    providerResult({ draftPatch: { fields: [patch({ value: "x".repeat(161) })] } }),
    providerResult({ draftPatch: { fields: [patch({ provenance: "user_entered" })] } }),
    providerResult({ draftPatch: { fields: [patch({ confidence: -0.1 })] } }),
    providerResult({ draftPatch: { fields: [patch({ confidence: 1.1 })] } }),
    providerResult({ draftPatch: { fields: [patch({ confidence: Number.NaN })] } }),
    providerResult({ draftPatch: { fields: [patch({ confidence: "0.9" })] } }),
    providerResult({ draftPatch: { fields: [patch({ uncertainty: "known" })] } }),
    providerResult({ draftPatch: { fields: [{ ...patch(), confirmed: true }] } }),
    providerResult({ draftPatch: { fields: [patch({ requiresConfirmation: false })] } }),
  ];
  for (const result of invalidResults) {
    assert.throws(
      () => parseJobRequestInterpretResult(result),
      (error) => error.code === "malformed_operation_result"
    );
  }
});

test("supported taxonomy is normalized and annotated without another provider call", async () => {
  const current = fixture({
    complete() {
      return providerResult({
        draftPatch: {
          fields: [
            patch({ path: "service.category", value: "plumbing" }),
            patch({ path: "service.requestCategory", value: "plumbing" }),
            patch({ path: "service.domain", value: "home_services" }),
            patch({ path: "service.specialty", value: "plumbing_repairs" }),
          ],
        },
      });
    },
  });
  const result = await current.run();
  const fields = result.result.draftPatch.fields;

  assert.equal(result.result.validation.status, "accepted");
  assert.deepEqual(fields.map(({ value }) => value), [
    "plumbing", "plumbing", "home_services", "plumbing_repairs",
  ]);
  assert.ok(fields.every(({ taxonomy }) => taxonomy.validated === true));
  assert.equal(current.providerCalls.length, 1);
});

test("unsupported service classification is dropped while unrelated proposals survive", async () => {
  const current = fixture({
    complete() {
      return providerResult({
        draftPatch: {
          fields: [
            patch(),
            patch({ path: "service.domain", value: "invented_domain" }),
            patch({ path: "service.specialty", value: "dragon_repair" }),
          ],
        },
        clarifications: [],
        warnings: [],
      });
    },
  });
  const result = await current.run();

  assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.deepEqual(result.result.draftPatch.fields.map(({ path }) => path), ["job.title"]);
  assert.equal(result.result.validation.status, "accepted_with_warnings");
  assert.equal(result.result.warnings[0].code, "unsupported_service_classification");
  assert.equal(result.result.clarifications[0].fieldPath, "service.specialty");
  assert.equal(current.providerCalls.length, 1);
});

test("taxonomy rejection always reserves one bounded warning and clarification slot", () => {
  const parsed = parseJobRequestInterpretResult(
    providerResult({
      draftPatch: {
        fields: [
          patch({ path: "service.domain", value: "invented_domain" }),
          patch({ path: "service.specialty", value: "invented_service" }),
        ],
      },
      clarifications: [
        { question: "Question one?", fieldPath: "job.title" },
        { question: "Question two?", fieldPath: "job.description" },
        { question: "Question three?", fieldPath: "timing.urgency" },
      ],
      warnings: Array.from({ length: 5 }, (_, index) => ({
        code: `provider_warning_${index}`,
        message: `Provider warning ${index}.`,
      })),
    }),
    { semanticInput: { context: { draft: { service: {} } } } }
  );
  assert.equal(parsed.warnings.length, 5);
  assert.ok(parsed.warnings.some(({ code }) => code === "unsupported_service_classification"));
  assert.equal(parsed.clarifications.length, 3);
  assert.ok(parsed.clarifications.some(({ fieldPath }) => fieldPath === "service.specialty"));
});

test("provider and malformed-result failures have no second call or successful patch", async () => {
  const providerFailure = fixture({ complete() { throw new Error("private provider detail"); } });
  const malformed = fixture({ complete() { return { summary: "unsafe" }; } });
  const failed = await providerFailure.run();
  const rejected = await malformed.run();

  assert.equal(failed.code, "INTELLIGENCE_PROVIDER_FAILURE");
  assert.equal(rejected.code, "INTELLIGENCE_RESULT_REJECTED");
  assert.equal(providerFailure.providerCalls.length, 1);
  assert.equal(malformed.providerCalls.length, 1);
  assert.equal(providerFailure.usageCalls.length, 0);
  assert.equal(malformed.usageCalls.length, 0);
  assert.equal(Object.hasOwn(failed, "result"), false);
  assert.equal(Object.hasOwn(rejected, "result"), false);
});

test("interpretation operation has no canonical create or domain mutation dependency", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "intelligence", "operations", "jobRequestInterpret.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /\/posts|createJobRequest|jobRequestCreate|INSERT\s+INTO|UPDATE\s+posts/i);
  assert.doesNotMatch(
    source,
    /relationships|conversations|professionalResponse|evaluations|quotes|invoices|payments/i
  );
});
