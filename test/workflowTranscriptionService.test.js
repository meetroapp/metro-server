"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  transcribeWorkflowAudio,
} = require("../server/intelligence/workflowTranscriptionService");
const {
  createIntelligenceOperationRepositoryFake,
} = require("./helpers/intelligenceOperationFake");

function fixture(overrides = {}) {
  const repository = createIntelligenceOperationRepositoryFake();
  const providerCalls = [];
  const provider = {
    name: "workflow_transcription",
    provider: "openai",
    model: "fixture-transcription-model",
    async transcribe(input) {
      providerCalls.push(input);
      return { transcript: "Check the shutoff valve before replacing the line." };
    },
  };
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    providerCalls,
    repository,
    run(input = {}) {
      return transcribeWorkflowAudio({
        pool: {},
        authenticatedActor: { id: 73, role: "professional" },
        idempotencyKey,
        audio: Buffer.from("governed-audio-fixture"),
        mimeType: "audio/webm;codecs=opus",
        contextLabel: "evaluation",
        locale: "en-US",
        provider,
        repository,
        ...overrides,
        ...input,
      });
    },
  };
}

test("transcription stores a non-canonical transcript and never persists raw audio", async () => {
  const state = fixture();
  const result = await state.run();

  assert.equal(result.ok, true);
  assert.equal(result.result.authorityClassification, "USER_TRANSCRIPT_NON_CANONICAL");
  assert.equal(result.result.explicitSubmitRequired, true);
  assert.equal(result.result.audioPersisted, false);
  assert.equal(result.result.provider.model, "fixture-transcription-model");
  assert.equal(state.providerCalls.length, 1);
  assert.equal(Buffer.isBuffer(state.providerCalls[0].audio), true);
  assert.equal(JSON.stringify(state.repository.calls).includes("governed-audio-fixture"), false);
  assert.equal(JSON.stringify(state.repository.calls).includes("Check the shutoff valve"), true);
});

test("same transcription key replays without a second provider call", async () => {
  const state = fixture();
  const first = await state.run();
  const replay = await state.run();

  assert.equal(first.code, "INTELLIGENCE_OPERATION_COMPLETED");
  assert.equal(replay.code, "INTELLIGENCE_OPERATION_REPLAYED");
  assert.equal(replay.result.transcript, first.result.transcript);
  assert.equal(state.providerCalls.length, 1);
});

test("transcription fails closed for unsupported input and unavailable provider", async () => {
  const state = fixture();
  const invalid = await state.run({ contextLabel: "payment" });
  const unavailable = await state.run({ provider: null, idempotencyKey: randomUUID() });

  assert.equal(invalid.code, "INTELLIGENCE_TRANSCRIPTION_INPUT_INVALID");
  assert.equal(unavailable.code, "INTELLIGENCE_PROVIDER_UNAVAILABLE");
  assert.equal(state.providerCalls.length, 0);
});
