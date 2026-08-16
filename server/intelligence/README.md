# Intelligence Runtime Authority

This directory is the canonical deployable Meetro Intelligence Gateway runtime.

The authenticated `POST /api/companion/ask` route derives identity from backend
authentication, authorizes a code-owned operation and capability, reserves the
operation through durable PostgreSQL idempotency, and only then invokes the
operation's server-selected engines and provider adapter.

Every registered operation must provide an explicit server-owned context
builder, provider-request builder, and result parser. There is no generic
fallback that forwards arbitrary caller input to a provider.

The production registry contains only separately governed product operations.
`job_request.interpret` prepares a homeowner-controlled draft;
`evaluation.assist`, `estimate.compose`, and `invoice.assist` return bounded
workflow proposals; and `quote.compose` reads authorized canonical Job truth
for professional review. Tests use deterministic fake providers; no test
operation is exported by the production registry.

`quote.compose` cannot invoke Quote, customer-decision, payment, scheduling, or
lifecycle mutation commands. Professional feedback is advisory evidence, and
confirmed composition output must still pass through the existing canonical
`quote.draft.create` and `quote.scope.add` commands.

Workflow proposal results are durable in the operation ledger. Human
accept/edit/reject decisions are separate append-only evidence with
`learnedPatternIsCanonicalRule: false`; neither record grants lifecycle,
commercial, financial, payment, or publication authority. Runtime providers
are dependency-injected through `app.locals.intelligenceProviders`. Retailer
references use a separate injected adapter and strict provenance validation;
there is no retailer scraper or provider secret in source.

Staging can configure the governed OpenAI adapter with server-only
`OPENAI_API_KEY`, plus optional server-owned
`OPENAI_WORKFLOW_ASSISTANCE_MODEL` and `OPENAI_TRANSCRIPTION_MODEL` overrides.
The default model identities are recorded by the provider configuration and
are available through the authenticated, no-store
`GET /api/intelligence/provider-status` route. Job Request, Evaluation,
Estimating, Quote, and Invoice operations share that one provider boundary;
the browser never selects a provider or model.

Voice input uses authenticated `POST /api/intelligence/transcriptions` with a
bounded supported audio type and operation idempotency key. Durable replay
stores the audio fingerprint, MIME type, byte count, provider/model identity,
and non-canonical transcript. Raw audio is sent to the configured
transcription provider for that request only and is never persisted. A
transcript always requires user review and an explicit subsequent Ask Meetro
submission.

Usage finalization remains optional. When no adapter is configured, completed
operations truthfully persist and return `not_configured` / `stub` usage state.

The similarly named frontend `server/intelligence` directory is retained only
as compatibility reference. It cannot register a route and is not a production
runtime authority. Future product callers communicate with this backend over
the authenticated HTTP contract.
