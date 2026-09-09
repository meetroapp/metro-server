# Ask Meetro conversational Companion contract

Candidate starts at exact remote server staging `574f3f99e9290ca4f959ffc26e13d771e503400d`, verified with `git ls-remote` on 2026-09-09. Implementation is isolated at `/private/tmp/meetro-ask-capability-server-574f3f9`. Protected server/wrapper checkouts are untouched.

## Request and result

The newly server-owned operation and capability are both `companion.converse`. It uses the existing authenticated `POST /api/companion/ask`, with an existing UUID `Idempotency-Key` header.

```json
{
  "operation": "companion.converse",
  "capability": "companion.converse",
  "locale": "en-US",
  "context": {},
  "input": {
    "message": "Why might this outlet have no power?",
    "history": []
  }
}
```

`input.message`: non-empty string, maximum 5,000 characters. `history`: at most eight `{role,text}` turns; roles user/assistant only, at most 2,000 characters per turn and 8,000 total. History is untrusted discussion, never payment/completion/approval evidence. Unknown input/context keys are rejected. No attachment transport, model/provider selection or caller-supplied record facts.

Optional `context.record` is exactly `{type,id}` or `{type:"VISIT",id,jobId}`. Numeric string IDs are required for JOB_REQUEST/CONVERSATION and UUIDs for other kinds. One exact record per request limits disclosure and avoids unrelated context aggregation. An unavailable or unauthorized pointer rejects before provider invocation; it is not silently replaced with a fabricated record or broad query.

The gateway's ordinary successful envelope contains this server-normalized result:

```json
{
  "schemaVersion": 1,
  "text": "Provider-generated conversational text",
  "authorityClassification": "CONVERSATIONAL_NON_CANONICAL",
  "directMutationAllowed": false
}
```

The provider returns exactly `{schemaVersion:1,text}`; text must be non-empty and at most 8,000 characters. Additional action/route/permission/patch properties are rejected. Authority metadata is added by the server, not accepted from the provider. The client validates the exact result shape and renders text using React text nodes. Text is never parsed as an action or navigation instruction.

## Existing governed operations

The six pre-existing operation/capability identifiers, verified against `server/intelligence/intelligenceOperationRegistry.js`, remain `job_request.interpret`, `quote.compose`, `quick_quote.photo_assist`, `evaluation.assist`, `estimate.compose`, and `invoice.assist`. Their operation implementations are unchanged; `companion.converse` is a seventh, text-only capability.

## Authorized reads

- JOB: existing professional canonical live-state reader; homeowners use the existing customer-owned Job/issued-Quote projection, without private professional state.
- DOCUMENT_DRAFT: existing owner-only working document read (Quote, Invoice or Deposit Request).
- QUOTE: existing professional Quote read or customer issued-and-delivered Quote read, preserving capability gates.
- INVOICE: existing professional/customer Invoice readers.
- EVALUATION: existing professional authorized Evaluation reader.
- VISIT: existing exact Job/Visit reader and visit-read capabilities.
- CUSTOMER_RELATIONSHIP: existing professional-owned relationship and activity readers.
- CONVERSATION: existing participant authorization before bounded message listing. At most the first 12 messages are supplied, explicitly labeled as an excerpt, not a complete/latest history.
- JOB_REQUEST: exact `posts.id` plus `posts.user_id`, matching the existing owned-request route. Discovery/matching does not grant private request context.

Returned objects are reduced through a descriptive field allowlist, depth/array/string bounds and a shared text budget. Email, phone, media URLs, internal costs, permissions, action controls and arbitrary service fields are not forwarded. Missing/omitted context is explicitly not proof of absence. Unsupported records fail closed; no new role or team permission is introduced.

## Provider, persistence and usage

The existing operation registry selects `workflow_assistance`; the existing orchestrator builds the server-owned provider request and validates the result. The existing OpenAI Responses adapter and configuration are reused, with `store:false`, strict JSON text schema and a 2,500 output-token ceiling for this operation. Existing workflow operations keep their previous request/response behavior and capability gates.

No provider credentials or SDK were added to the client. No key or server environment was changed. Provider tests use synthetic credentials and intercepted fixture responses; no live provider was invoked by this implementation task.

The existing gateway authentication, actor-scoped idempotency reservation/fingerprint/replay, provider timeout/abort and optional usage-finalizer integration apply. Provider execution is bounded by the existing default 15-second timeout and 30-second maximum. Successful results are persisted in the existing Intelligence operation ledger for replay; this is operational bookkeeping, not a canonical Job/document/payment mutation. No new session table or migration is needed. Unknown transport outcome retries reuse the same client key; a confirmed failed operation allows a new key on the next explicit retry.

Usage is finalized once when configured; otherwise the existing truthful `not_configured`/`stub` state remains. Existing integration points permit later entitlement/metering/rate policy without introducing pricing or a new testing lockout. This task does not implement a new billing or abuse-limiting system.

## Release gate

Not pushed or deployed. Automated fixture tests and an isolated native build do not prove provider quality or physical microphone behavior. Physical iPhone/iPad core QA against an approved running candidate is required before the separate iPhone non-Home header access change. No production configuration or database was used.
