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
  EMERGENCY_REQUEST_INTERPRET_PATCH_PATHS,
  EMERGENCY_SPECIALTIES,
  parseEmergencyRequestInterpretResult,
} = require("../server/intelligence/operations/emergencyRequestInterpret");
const {
  createIntelligenceOperationRepositoryFake,
} = require("./helpers/intelligenceOperationFake");

function requestBody(overrides = {}) {
  return {
    operation: "emergency_request.interpret",
    capability: "emergency_request.interpret",
    locale: "en-US",
    context: {
      stage: overrides.stage || "describe",
      intake: {
        description: "",
        service: { specialty: "" },
        location: { city: "", region: "", postalCode: "" },
        ...(overrides.intake || {}),
      },
    },
    input: { text: overrides.text || "Water is coming through my ceiling after the rain." },
  };
}

function patch(overrides = {}) {
  return {
    path: "service.specialty",
    value: "roof_leak_repair",
    provenance: "assistant_suggested",
    confidence: 0.93,
    uncertainty: "assistant_suggested",
    requiresConfirmation: true,
    rationale: "Rain-related ceiling water reasonably supports the roof leak service.",
    ...overrides,
  };
}

function providerResult(overrides = {}) {
  return {
    schemaVersion: 1,
    summary: "This sounds like a Roof Leak Repair emergency.",
    draftPatch: {
      fields: [
        patch(),
        patch({
          path: "description",
          value: "Water is coming through the ceiling after the rain.",
        }),
      ],
    },
    clarifications: [],
    warnings: [],
    ...overrides,
  };
}

function parseEmergencyResult(
  value,
  stage = "describe"
) {
  return parseEmergencyRequestInterpretResult(
    value,
    {
      semanticInput: {
        context: { stage },
      },
    }
  );
}

function fixture({ complete } = {}) {
  const repository = createIntelligenceOperationRepositoryFake();
  const providerCalls = [];
  const providers = {
    emergency_request: {
      name: "emergency_request",
      async complete(request) {
        providerCalls.push(request);
        return complete ? complete(request) : providerResult();
      },
    },
  };
  return {
    repository,
    providerCalls,
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
        usageFinalizer: async () => ({ classification: "fixture" }),
        ...overrides,
      });
    },
  };
}

test("Emergency interpretation is registered as its own proposal-only capability", () => {
  assert.deepEqual(
    canonicalIntelligenceOperationRegistry.list().find(
      ({ operation }) => operation === "emergency_request.interpret"
    ),
    {
      operation: "emergency_request.interpret",
      capability: "emergency_request.interpret",
      supportedRoles: ["homeowner", "professional"],
      engineIds: ["emergency_request_capability", "emergency_request_validation"],
      providerName: "emergency_request",
    }
  );
  assert.deepEqual(EMERGENCY_REQUEST_INTERPRET_PATCH_PATHS, [
    "description",
    "service.specialty",
    "location.city",
    "location.region",
    "location.postalCode",
  ]);
});

test("all and only the five canonical Emergency specialties are accepted", () => {
  assert.deepEqual(EMERGENCY_SPECIALTIES, [
    "emergency_plumbing",
    "emergency_electrical_service",
    "roof_leak_repair",
    "emergency_lockout",
    "handyman",
  ]);
  for (const specialty of EMERGENCY_SPECIALTIES) {
    const parsed = parseEmergencyResult(providerResult({
      draftPatch: { fields: [patch({ value: specialty })] },
      clarifications: [],
    }));
    assert.equal(parsed.draftPatch.fields[0].value, specialty);
  }
  assert.throws(
    () => parseEmergencyResult(providerResult({
      draftPatch: { fields: [patch({ value: "locksmith" })] },
    })),
    (error) => error.code === "malformed_operation_result"
  );
});

test("ambiguous specialty remains unselected and returns one bounded clarification", () => {
  const parsed = parseEmergencyResult(providerResult({
    draftPatch: { fields: [] },
    clarifications: [{
      question: "Is the urgent issue a lockout or an electrical problem?",
      fieldPath: "service.specialty",
    }],
  }));
  assert.deepEqual(parsed.draftPatch.fields, []);
  assert.equal(parsed.clarifications.length, 1);
  assert.equal(parsed.clarifications[0].fieldPath, "service.specialty");
});

test("Emergency interpretation stages cannot skip the Find Help consent boundary", () => {
  assert.throws(
    () =>
      parseEmergencyResult(
        providerResult({
          draftPatch: {
            fields: [
              patch({
                path: "location.city",
                value: "Cape Coral",
              }),
            ],
          },
        }),
        "describe"
      ),
    (error) =>
      error.code ===
      "malformed_operation_result"
  );

  assert.throws(
    () =>
      parseEmergencyResult(
        providerResult({
          draftPatch: {
            fields: [
              patch({
                path: "service.specialty",
                value: "roof_leak_repair",
              }),
            ],
          },
        }),
        "location"
      ),
    (error) =>
      error.code ===
      "malformed_operation_result"
  );

  assert.throws(
    () =>
      parseEmergencyResult(
        providerResult({
          draftPatch: { fields: [] },
          clarifications: [{
            question:
              "What city or ZIP code should I use?",
          }],
        }),
        "describe"
      ),
    (error) =>
      error.code ===
      "malformed_operation_result"
  );

  assert.throws(
    () =>
      parseEmergencyResult(
        providerResult({
          draftPatch: { fields: [] },
          clarifications: [{
            question:
              "What is your exact street address or unit number?",
            fieldPath:
              "location.city",
          }],
        }),
        "location"
      ),
    (error) =>
      error.code ===
      "malformed_operation_result"
  );

  const location = parseEmergencyResult(
    providerResult({
      summary:
        "I have the general service area.",
      draftPatch: {
        fields: [
          patch({
            path: "location.city",
            value: "Cape Coral",
          }),
          patch({
            path: "location.region",
            value: "FL",
          }),
          patch({
            path: "location.postalCode",
            value: "33990",
          }),
        ],
      },
      clarifications: [],
    }),
    "location"
  );

  assert.deepEqual(
    location.draftPatch.fields.map(
      ({ path, value }) => ({
        path,
        value,
      })
    ),
    [
      {
        path: "location.city",
        value: "Cape Coral",
      },
      {
        path: "location.region",
        value: "FL",
      },
      {
        path: "location.postalCode",
        value: "33990",
      },
    ]
  );
});

test("location normalizes U.S. region names to postal abbreviations without changing other regions", () => {
  const florida = parseEmergencyResult(
    providerResult({
      summary:
        "I have the general service area.",
      draftPatch: {
        fields: [
          patch({
            path: "location.city",
            value: "Cape Coral",
          }),
          patch({
            path: "location.region",
            value: "Florida",
            provenance:
              "assistant_inferred",
            uncertainty:
              "approximate",
            rationale:
              "Cape Coral and ZIP 33990 identify Florida.",
          }),
          patch({
            path:
              "location.postalCode",
            value: "33990",
          }),
        ],
      },
      clarifications: [],
    }),
    "location"
  );

  assert.deepEqual(
    florida.draftPatch.fields.map(
      ({ path, value }) => ({
        path,
        value,
      })
    ),
    [
      {
        path: "location.city",
        value: "Cape Coral",
      },
      {
        path: "location.region",
        value: "FL",
      },
      {
        path: "location.postalCode",
        value: "33990",
      },
    ]
  );

  const international =
    parseEmergencyResult(
      providerResult({
        summary:
          "I have the general service area.",
        draftPatch: {
          fields: [
            patch({
              path:
                "location.region",
              value: "Ontario",
            }),
          ],
        },
        clarifications: [],
      }),
      "location"
    );

  assert.equal(
    international.draftPatch
      .fields[0].value,
    "Ontario"
  );
});

test("location clarification accepts null fieldPath under the governed general-area schema", () => {
  const parsed = parseEmergencyResult(
    providerResult({
      summary: "I need one more general-area detail.",
      draftPatch: { fields: [] },
      clarifications: [{
        question: "What city or ZIP code should I use?",
        fieldPath: null,
      }],
    }),
    "location"
  );

  assert.deepEqual(
    parsed.draftPatch.fields,
    []
  );

  assert.deepEqual(
    parsed.clarifications,
    [{
      question:
        "What city or ZIP code should I use?",
    }]
  );
});

test("private pre-selection details and authority fields fail closed", async () => {
  for (const altered of [
    { summary: "Help is needed at 123 Main Street." },
    { summary: "Email homeowner@example.com for details." },
    { summary: "Please provide your phone." },
    { clarifications: [{ question: "What is your email?" }] },
    { draftPatch: { fields: [patch({ path: "location.street", value: "123 Main Street" })] } },
    { draftPatch: { fields: [patch({ path: "location.city", value: "123 Main Street" })] } },
    { draftPatch: { fields: [patch({ path: "description", value: "Gate code 1234." })] } },
    { draftPatch: { fields: [patch({ rationale: "Call 239-555-1212." })] } },
    { warnings: [{ code: "private_detail", message: "Unit 4B needs access." }] },
    { draftPatch: { fields: [patch({ path: "safety.immediateDanger", value: "true" })] } },
    { draftPatch: { fields: [patch({ path: "professional.id", value: "15" })] } },
  ]) {
    assert.throws(
      () => parseEmergencyResult(providerResult(altered)),
      (error) => error.code === "malformed_operation_result"
    );
  }

  const current = fixture();

  for (const text of [
    "Water is entering at 123 Main Street in Cape Coral 33990.",
    "I am in unit 2.",
    "I am in unit B.",
    "The gate code is 1234.",
    "My email is homeowner@example.com.",
    "Call me at 239-555-1212.",
    "Call me at 2395551212.",
  ]) {
    const privateInput = await current.run({
      body: requestBody({ text }),
    });

    assert.equal(
      privateInput.code,
      "INTELLIGENCE_CONTEXT_INVALID"
    );
  }

  for (const addition of [
    { streetAddress: "123 Main Street" },
    {
      location: {
        city: "123 Main Street",
        region: "FL",
        postalCode: "33990",
      },
    },
    { unitNumber: "4B" },
    { accessNotes: "Gate code 1234" },
    { safetyAssessment: { immediateDanger: false } },
    { professionalId: 15 },
  ]) {
    const result = await current.run({
      body: requestBody({ intake: addition }),
    });
    assert.equal(result.code, "INTELLIGENCE_CONTEXT_INVALID");
  }
  assert.equal(current.providerCalls.length, 0);
  assert.equal(current.repository.calls.length, 0);
});

test("homeowner and professional actors receive the same non-mutating proposal", async () => {
  for (const actor of [
    { id: 91, role: "homeowner" },
    { id: 92, role: "professional" },
  ]) {
    const current = fixture();
    const result = await current.run({ authenticatedActor: actor });
    assert.equal(result.code, "INTELLIGENCE_OPERATION_COMPLETED");
    assert.equal(result.operation, "emergency_request.interpret");
    assert.equal(result.result.validation.taxonomy, "emergency_service");
    assert.equal(current.providerCalls.length, 1);
    const providerRequest = current.providerCalls[0];
    assert.equal(providerRequest.operationContext.capability.mutationAllowed, false);
    assert.equal(providerRequest.operationContext.capability.safetyAssessmentAllowed, false);
    assert.equal(providerRequest.operationContext.capability.professionalSelectionAllowed, false);
  }
});

test("provider input is bounded and contains no Emergency lifecycle authority", async () => {
  const current = fixture();
  await current.run();
  const request = current.providerCalls[0];
  assert.equal(request.operation, "emergency_request.interpret");
  assert.equal(request.intakeStage, "describe");
  assert.deepEqual(
    request.instructions.allowedPatchPaths,
    ["description", "service.specialty"]
  );
  assert.deepEqual(Object.keys(request.currentIntake), ["description", "location", "service"]);
  assert.equal(
    request.operationContext.validation.canonicalEmergencySpecialties,
    EMERGENCY_SPECIALTIES.join(",")
  );
  assert.equal(
    request.operationContext.validation.stageScopedPatchWhitelistEnforced,
    true
  );
  const serialized = JSON.stringify(request);
  for (const forbidden of [
    "requestId",
    "streetAddress",
    "unitNumber",
    "accessNotes",
    "professionalId",
    "relationshipId",
    "conversationId",
    "jobId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("location stage sends only general-area authority to the provider", async () => {
  const current = fixture({
    complete(request) {
      assert.equal(
        request.intakeStage,
        "location"
      );
      assert.deepEqual(
        request.instructions.allowedPatchPaths,
        [
          "location.city",
          "location.region",
          "location.postalCode",
        ]
      );

      return providerResult({
        summary:
          "I have the general service area.",
        draftPatch: {
          fields: [
            patch({
              path: "location.city",
              value: "Cape Coral",
            }),
            patch({
              path: "location.region",
              value: "FL",
            }),
            patch({
              path: "location.postalCode",
              value: "33990",
            }),
          ],
        },
        clarifications: [],
      });
    },
  });

  const result = await current.run({
    body: requestBody({
      stage: "location",
      text: "Cape Coral 33990",
      intake: {
        description:
          "Water is coming through my ceiling after the rain.",
        service: {
          specialty:
            "roof_leak_repair",
        },
        location: {
          city: "",
          region: "",
          postalCode: "",
        },
      },
    }),
  });

  assert.equal(
    result.code,
    "INTELLIGENCE_OPERATION_COMPLETED"
  );

  assert.deepEqual(
    result.result.draftPatch.fields.map(
      ({ path }) => path
    ),
    [
      "location.city",
      "location.region",
      "location.postalCode",
    ]
  );
});

test("malformed provider responses fail before they can become proposals", () => {
  for (const value of [
    "not json",
    {},
    { ...providerResult(), action: "create_emergency_request" },
    providerResult({ draftPatch: { fields: [patch({ requiresConfirmation: false })] } }),
    providerResult({ draftPatch: { fields: [patch(), patch()] } }),
  ]) {
    assert.throws(
      () => parseEmergencyResult(value),
      (error) => error.code === "malformed_operation_result"
    );
  }
});

test("the Emergency operation module contains no domain mutation or database path", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "intelligence", "operations", "emergencyRequestInterpret.js"),
    "utf8"
  );
  for (const forbidden of [
    "pool.query",
    "INSERT INTO",
    "UPDATE emergency",
    "createEmergencyRequest",
    "prepareEmergencyRequest",
    "saveEmergencySafetyAssessment",
    "selectProfessional",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
