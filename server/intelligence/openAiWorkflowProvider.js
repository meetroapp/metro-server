"use strict";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_WORKFLOW_MODEL = "gpt-5.4-mini";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

const OUTPUT_CONTRACTS = Object.freeze({
  "job_request.interpret": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","draftPatch":{"fields":[{"path":"allowed path from request","value":"string","provenance":"AI_SUGGESTED or INFERRED","confidence":0.0,"uncertainty":"KNOWN or UNCERTAIN or NEEDS_CLARIFICATION","requiresConfirmation":true,"rationale":"optional string"}]},"clarifications":[{"question":"string","fieldPath":"optional allowed path"}],"warnings":[{"code":"lowercase_code","message":"string"}]}`,
  "evaluation.assist": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","observed":[assistanceItem],"professionalInput":[assistanceItem],"needsVerification":[assistanceItem],"inspectionSuggestions":[assistanceItem],"measurementSuggestions":[assistanceItem],"evaluationDraft":{"observations":"string","diagnosisSummary":"string","limitations":"string"},"findingDrafts":[assistanceItem],"recommendationDrafts":[assistanceItem],"photoAnalysis":{"analyzedReferenceIds":["authorized photo id"],"limitations":["string"]},"warnings":["string"]}
where assistanceItem is exactly {"id":"lowercase_stable_id","text":"string","classification":"OBSERVED or PROFESSIONAL_INPUT or NEEDS_VERIFICATION or AI_SUGGESTED","sourceReferences":[{"type":"authorized type","id":"authorized id","version":1}]}. OBSERVED and PROFESSIONAL_INPUT items require exact authorized sourceReferences. Use empty arrays when evidence is absent.`,
  "estimate.compose": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","materials":[{"id":"stable_id","description":"string","quantity":1,"unit":"string","wastePercent":0,"costInputKey":null,"retailerReferenceId":null,"assumption":"string","needsVerification":true}],"labor":[{"id":"stable_id","description":"string","crewCount":1,"hoursPerWorker":1,"costInputKey":null,"assumption":"string"}],"equipment":[{"id":"stable_id","description":"string","costInputKey":null}],"disposal":{"description":"string","costInputKey":null},"contingencyPercent":0,"assumptions":[{"id":"stable_id","text":"string"}],"missingInformation":["string"],"suggestedSellingRange":{"minimumMinor":0,"maximumMinor":0,"rationale":"string"},"customerQuoteDraft":{"scopeSummary":"string","conditions":["string"],"exclusions":["string"],"durationGuidance":"string","customerWording":"string"},"warnings":["string"]}
Only use costInputKey and retailerReferenceId values present in the request. Never expose internal costs or retailer references in customerQuoteDraft.`,
  "quote.compose": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","scopeSections":[{"id":"stable_id","title":"string","provenance":"AI_SUGGESTED","sourceReferences":[]}],"proposedScopeItems":[{"id":"stable_id","sectionId":"existing section id","description":"string","classification":"MATERIAL or LABOR_SERVICE","scopeSemantic":"PERMANENT_WORK or TEMPORARY_SERVICE or SEPARATE_PROPOSAL","materialResponsibility":"PROFESSIONAL or CUSTOMER or PENDING_SELECTION","workStatus":"PLANNED or DONE_TEMPORARY or SEPARATE_PROPOSAL","pricing":{"status":"PRICE_MISSING or PRICE_CONFIRMED_BY_PROFESSIONAL","inputKey":null},"provenance":"AI_SUGGESTED","sourceReferences":[]}],"materials":[{"id":"stable_id","description":"string","responsibility":"PROFESSIONAL or CUSTOMER or PENDING_SELECTION","provenance":"AI_SUGGESTED","sourceReferences":[]}],"exclusions":[sourcedElement],"assumptions":[sourcedElement],"separateProposals":[sourcedElement],"commercialMissingInformation":[{"id":"stable_id","code":"UPPERCASE_CODE","description":"string","provenance":"MISSING_INFORMATION","sourceReferences":[],"elementId":null}],"workflowConditions":[{"id":"stable_id","type":"DEPOSIT or AVAILABILITY or OTHER","description":"string","state":"ADVISORY_NOT_SATISFIED or CONDITIONAL_NOT_SCHEDULED or REQUIRES_PROFESSIONAL_CONFIRMATION","provenance":"AI_SUGGESTED","sourceReferences":[]}],"warnings":[{"code":"lowercase_code","message":"string"}],"confidence":{"score":0.0,"rationale":"string"}}
where sourcedElement is exactly {"id":"stable_id","description":"string","provenance":"AI_SUGGESTED or MISSING_INFORMATION","sourceReferences":[]}. Copy any non-AI provenance and source reference exactly from authorized request context.`,
  "invoice.assist": `Return exactly this JSON object shape:
{"schemaVersion":1,"summary":"string","lineDescriptions":[{"id":"stable_id","text":"string"}],"customerNotes":"string","terms":"string","dueDateWording":"string","balanceExplanation":"string","warnings":["string"]}
Draft wording only. Never calculate, alter, or assert payment, total, paid, balance, or status authority.`,
});

function providerError(code, message) {
  return Object.assign(new Error(message), { code });
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

function createOpenAiWorkflowProvider({
  apiKey,
  model = DEFAULT_WORKFLOW_MODEL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (!normalizedKey || !normalizedModel || typeof fetchImpl !== "function") {
    return null;
  }

  return Object.freeze({
    name: "workflow_assistance",
    provider: "openai",
    model: normalizedModel,
    async complete(request) {
      const response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${normalizedKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: normalizedModel,
          instructions: workflowInstructions(request),
          input: JSON.stringify(request),
          text: { format: { type: "json_object" } },
        }),
      });
      const payload = await readSafeJson(response);
      if (!response.ok) {
        throw providerError(
          classifyProviderFailure(response.status, payload),
          "The governed workflow provider rejected the request."
        );
      }
      const output = responseOutputText(payload);
      if (!output) throw providerError("malformed_operation_result", "The provider returned no output.");
      try {
        return JSON.parse(output);
      } catch {
        throw providerError("malformed_operation_result", "The provider output was not valid JSON.");
      }
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
};
