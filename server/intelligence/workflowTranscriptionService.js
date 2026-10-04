"use strict";

const { createHash } = require("node:crypto");

const {
  executeIdempotentIntelligenceOperation,
} = require("./intelligenceOperationIdempotencyService");

const TRANSCRIPTION_OPERATION = "speech.transcribe";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_LENGTH = 4000;
const ALLOWED_CONTEXTS = new Set(["job_request", "evaluation", "estimate", "invoice"]);
const ALLOWED_MIME_TYPES = new Set([
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
]);

function response(ok, status, code, message, extra = {}) {
  return { ok, status, code, message, ...extra };
}

function normalizeLocale(value) {
  const locale = typeof value === "string" ? value.trim() : "";
  return /^[a-z]{2}(?:-[a-z]{2,4})?$/i.test(locale) ? locale.slice(0, 20) : "en-US";
}

async function transcribeWorkflowAudio({
  pool,
  authenticatedActor,
  idempotencyKey,
  audio,
  mimeType,
  contextLabel,
  locale,
  provider,
  repository,
  logger = null,
} = {}) {
  const normalizedContext = String(contextLabel || "").trim().toLowerCase();
  const normalizedMimeType = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (!Buffer.isBuffer(audio) || audio.length < 1 || audio.length > MAX_AUDIO_BYTES ||
      !ALLOWED_CONTEXTS.has(normalizedContext) || !ALLOWED_MIME_TYPES.has(normalizedMimeType)) {
    return response(false, 400, "INTELLIGENCE_TRANSCRIPTION_INPUT_INVALID", "A valid voice recording is required.");
  }
  if (!provider || typeof provider.transcribe !== "function") {
    return response(false, 503, "INTELLIGENCE_PROVIDER_UNAVAILABLE", "The Intelligence provider is unavailable.");
  }

  const normalizedLocale = normalizeLocale(locale);
  const audioFingerprint = createHash("sha256").update(audio).digest("hex");
  return executeIdempotentIntelligenceOperation({
    pool,
    authenticatedActor,
    operation: TRANSCRIPTION_OPERATION,
    idempotencyKey,
    semanticInput: {
      contextLabel: normalizedContext,
      locale: normalizedLocale,
      audio: {
        fingerprint: audioFingerprint,
        mimeType: normalizedMimeType,
        byteLength: audio.length,
        rawAudioPersisted: false,
      },
    },
    repository,
    logger,
    executeProvider: async () => {
      const result = await provider.transcribe({
        audio,
        mimeType: normalizedMimeType,
        locale: normalizedLocale,
      });
      const transcript = typeof result?.transcript === "string" ? result.transcript.trim() : "";
      if (!transcript || transcript.length > MAX_TRANSCRIPT_LENGTH) {
        throw Object.assign(new Error("The transcription result is invalid."), {
          code: "malformed_operation_result",
        });
      }
      return {
        schemaVersion: 1,
        authorityClassification: "USER_TRANSCRIPT_NON_CANONICAL",
        transcript,
        locale: normalizedLocale,
        contextLabel: normalizedContext,
        audioPersisted: false,
        provider: {
          name: provider.provider || provider.name,
          model: provider.model,
        },
        explicitSubmitRequired: true,
      };
    },
  });
}

module.exports = {
  ALLOWED_CONTEXTS,
  ALLOWED_MIME_TYPES,
  MAX_AUDIO_BYTES,
  TRANSCRIPTION_OPERATION,
  transcribeWorkflowAudio,
};
