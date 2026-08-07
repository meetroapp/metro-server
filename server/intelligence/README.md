# Intelligence Runtime Authority

This directory is the canonical deployable Meetro Intelligence Gateway runtime.

The authenticated `POST /api/companion/ask` route derives identity from backend
authentication, authorizes a code-owned operation and capability, reserves the
operation through durable PostgreSQL idempotency, and only then invokes the
operation's server-selected engines and provider adapter.

Every registered operation must provide an explicit server-owned context
builder, provider-request builder, and result parser. There is no generic
fallback that forwards arbitrary caller input to a provider.

The production operation and engine registries are intentionally empty at this
foundation milestone. Product operations, including `job_request.interpret`,
must be registered through a separately governed change. Tests inject the
neutral `test.echo` operation and fake provider; no test operation is exported
by the production registry.

Usage finalization remains optional. When no adapter is configured, completed
operations truthfully persist and return `not_configured` / `stub` usage state.

The similarly named frontend `server/intelligence` directory is retained only
as compatibility reference. It cannot register a route and is not a production
runtime authority. Future product callers communicate with this backend over
the authenticated HTTP contract.
