"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyProviderFailure,
  createOpenAiTranscriptionProvider,
  createOpenAiWorkflowProvider,
  createWorkflowProviderConfiguration,
} = require("../server/intelligence/openAiWorkflowProvider");

function response({ ok = true, status = 200, payload = {} } = {}) {
  return { ok, status, async json() { return payload; } };
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
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  assert.equal(body.input.includes("fixture-secret"), false);
  assert.equal(body.instructions.includes("advisory"), true);
  assert.deepEqual(result, { schemaVersion: 1, summary: "Review this suggestion." });
});

test("provider failures are reduced to safe governed classifications", async () => {
  assert.equal(classifyProviderFailure(401, {}), "provider_authentication_failed");
  assert.equal(classifyProviderFailure(429, { error: { code: "insufficient_quota" } }), "provider_quota_exhausted");
  assert.equal(classifyProviderFailure(403, {}), "provider_access_denied");
  assert.equal(classifyProviderFailure(404, {}), "provider_model_unavailable");
  assert.equal(classifyProviderFailure(400, { error: { code: "billing_hard_limit_reached" } }), "provider_billing_required");

  const provider = createOpenAiWorkflowProvider({
    apiKey: "fixture-secret",
    fetchImpl: async () => response({ ok: false, status: 429, payload: { error: { code: "insufficient_quota", message: "private detail" } } }),
  });
  await assert.rejects(
    provider.complete({ operation: "evaluation.assist" }),
    (error) => error.code === "provider_quota_exhausted" && !error.message.includes("private detail")
  );
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
