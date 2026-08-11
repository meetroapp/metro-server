# Governed Database Migrations

This directory is the ordered source of truth for Meetro backend schema changes.
Migrations are additive, reviewed SQL files; the generic runner does not provide
a destructive reset path and supports only local-test and staging execution.

## Naming and Inventory

Migration filenames must use:

```text
YYYYMMDDHHMM_description_in_lowercase.sql
```

The runner accepts only names matching that convention, rejects duplicate
12-digit timestamp prefixes, sorts files lexically, and records a SHA-256
checksum for each file.

Current inventory:

1. `202607050001_initial_schema_baseline.sql`
2. `202607130001_add_user_token_version.sql`
3. `202607130002_create_password_reset_tokens.sql`
4. `202607140001_add_contractor_profile_details.sql`
5. `202607140002_create_workflow_events.sql`
6. `202607190001_add_user_profile_photo_details.sql`
7. `202607190002_add_post_request_photos.sql`
8. `202607200001_add_post_request_lifecycle.sql`
9. `202607200002_create_request_relationships.sql`
10. `202607200003_create_conversations.sql`
11. `202607210001_add_message_conversation_identity.sql`
12. `202607210002_allow_dual_message_identity.sql`
13. `202607230001_create_emergency_requests.sql`
14. `202607230002_add_emergency_relationship_source.sql`
15. `202607230003_create_emergency_safety_assessments.sql`
16. `202607240001_add_single_active_emergency_relationship.sql`
17. `202607250001_add_emergency_dispatch_lifecycle.sql`
18. `202608010001_create_commercial_authority_foundation.sql`
19. `202608010002_create_canonical_evaluations.sql`
20. `202608030001_create_conversation_participant_state.sql`
21. `202608030002_create_canonical_alerts.sql`
22. `202608060001_create_professional_response_foundation.sql`
23. `202608060002_create_request_selection_authority.sql`
24. `202608070001_create_job_request_create_command_idempotency.sql`
25. `202608070002_create_intelligence_operation_idempotency.sql`
26. `202608070003_add_job_request_service_location.sql`
27. `202608090001_create_job_lifecycle_concern_foundation.sql`
28. `202608090002_create_job_participant_authority_foundation.sql`
29. `202608090003_create_ordinary_evaluation_finding_foundation.sql`
30. `202608100001_create_workstream_activity_foundation.sql`
31. `202608100002_create_recommendation_hierarchy_foundation.sql`
32. `202608100003_create_canonical_quote_scope_foundation.sql`
33. `202608100004_create_quote_composition_feedback.sql`

README and other non-SQL files are ignored. Malformed SQL migration filenames
cause discovery to fail closed.

This inventory records migration source files, not applied database state.
Migration creation and governed migration execution remain separate operations.

`202608030002_create_canonical_alerts.sql` creates the additive
recipient-scoped `alerts` table for canonical backend alert persistence. It
does not import legacy browser notifications, create runtime alert producers,
or attach alerts to conversations, Emergency, workflow events, delivery
providers, badges, or frontend notification surfaces.

`202608060001_create_professional_response_foundation.sql` creates the additive
ordinary Professional Response aggregate, immutable versions, command
idempotency, evidence, reconciliation control, and reciprocal pending
relationship linkage. It does not backfill legacy relationships, create
selection authority, or require a conversation. Migration creation and runtime
implementation remain separate governed milestones.

`202608060002_create_request_selection_authority.sql` creates the additive
ordinary homeowner selection record, command idempotency, immutable evidence,
sole-selection and sole-active-relationship constraints, and exact ordinary
conversation provenance. It does not select a response, create a conversation,
reconcile legacy records, or alter Emergency authority by itself.

`202608070001_create_job_request_create_command_idempotency.sql` creates the
additive ordinary Job Request create-command idempotency table. It does not add
Job Request content columns, backfill historical posts, create relationships,
create conversations, or alter Professional Response, selection, Emergency,
Quote, Invoice, Evaluation, or workflow authority.

`202608070002_create_intelligence_operation_idempotency.sql` creates additive,
generic execution identity and bounded replay state for governed Intelligence
operations. It stores no raw operation input, creates no product operation, and
does not alter provider, credit, membership, Job Request, Relationship,
Conversation, or commercial authority.

`202608070003_add_job_request_service_location.sql` adds the private structured
service-location foundation to ordinary Job Requests. Existing free-form
locations remain untouched and are classified as `legacy_unclassified`; the
migration does not parse legacy addresses, alter professional disclosure,
create selection authority, or add geospatial data.

`202608090001_create_job_lifecycle_concern_foundation.sql` defaults every
existing and ungated request to lifecycle v1, adds selection-sourced Job
identity for explicitly activated v2 requests, and preserves fresh confirmed
Reported Concern text as append-only customer truth. It performs no legacy
concern backfill and creates no Evaluation, Workstream, Quote, or approval.

`202608090002_create_job_participant_authority_foundation.sql` separates
authenticated relationship participants, temporal role history, and explicit
scoped authority grants. Slice 001 registers only concern read/clarification
and participant-read capabilities; role names grant no commercial authority.

`202608090003_create_ordinary_evaluation_finding_foundation.sql` reuses the
canonical Evaluation aggregate and version history for ordinary lifecycle-v2
Jobs. It adds explicit Job subjects, stable Finding identities with append-only
versions, restrictive Reported Concern links, and typed evidence references.
It does not convert Emergency Evaluation JSON, fabricate Evaluation or Finding
history, activate runtime authority, or add Workstream/Recommendation schema.
Workstream linkage is implemented separately by the additive Slice 003 schema.

`202608100001_create_workstream_activity_foundation.sql` adds stable canonical
Workstream, Work Activity, and obligation identities with append-only versions.
It adds one-per-Finding same-Job Workstream assignment and append-only Finding
resolution evidence tied to the exact immutable Finding version/state. Temporary
activity, obligation, Workstream, Finding-resolution, and overall Job states
remain structurally independent. It registers only the bounded Slice 003 runtime
capabilities and durable workflow command-idempotency contract; it creates no
business rows. Resolution and completion remain explicit Job-scoped commands;
the migration adds no Job completion, Quote, Recommendation, specialist
lifecycle, or automatic state transition.
An explicitly governed DEFERRED Finding or DEFERRED/EXCLUDED obligation is
nonblocking for accepted-scope eligibility, but it does not assert technical
resolution and never completes a Workstream automatically; completion remains
a separate explicit command.

`202608100002_create_recommendation_hierarchy_foundation.sql` adds stable
Primary and Alternative Recommendation identities, append-only versions,
same-Finding hierarchy, separate customer-constraint evidence, and explicit
disposition history. It preserves legacy Evaluation recommendation JSON and
registers only bounded Job-scoped Recommendation capabilities. It creates no
Recommendation business rows, Quote, pricing, procurement, scheduling, Job
completion, Finding-resolution, or Workstream-state authority.

`202608100003_create_canonical_quote_scope_foundation.sql` adds canonical Draft
Quote identity, immutable Quote versions and scope snapshots, exact lifecycle
source references, server-owned integer-minor-unit totals, and eight bounded
professional/customer capabilities. It permits governed Draft preparation,
the explicit DRAFT-to-ISSUED transition, an append-only terminal customer
decision against the exact issued version, and explicit empty derived Drafts
with parent Quote lineage. Exact grant/evidence/idempotency links preserve the
issued commercial snapshot; approval or decline never changes its status,
scope, amount, source, or integrity hash. It creates no Quote rows,
retroactive grants, procurement, scheduling, invoicing, or payment authority.
Legacy `quote_requests` and browser Quote Builder state remain unchanged and
non-canonical.

`202608100004_create_quote_composition_feedback.sql` adds append-only
professional Accept/Edit/Reject evidence for non-canonical AI Quote Composition
Proposals already persisted by the governed Intelligence operation ledger. It
creates no proposal, Quote, issue, customer decision, payment, scheduling,
Finding-resolution, Workstream-completion, or Job-completion authority.

## Migration Ledger and Transactions

The runner creates `schema_migrations` with the migration filename, checksum,
execution target, and application timestamp. Each migration runs independently:

1. `BEGIN`
2. acquire the migration advisory lock
3. create or inspect `schema_migrations`
4. verify any existing checksum
5. execute the migration SQL
6. validate baseline schema parity when applying the baseline
7. insert the ledger record
8. `COMMIT`

Failures issue `ROLLBACK`, are not recorded, and stop later migrations. A
matching applied checksum is skipped. Checksum drift fails and is never
overwritten.

## Baseline Safety

The baseline is additive and uses guarded table/index creation. Because
`CREATE TABLE IF NOT EXISTS` cannot prove an existing table is compatible, the
runner checks PostgreSQL `information_schema` after baseline SQL and before the
ledger insert. Missing required tables, missing critical columns, or incompatible
column types fail with a manual-review requirement. The runner never drops
tables, rewrites data, or performs a reset.

## Local Test Execution

Set `DATABASE_URL` to an explicitly local database whose name starts with
`meetro_test_`, then run:

```bash
DATABASE_URL=postgresql://localhost/meetro_test_migrations npm run migrate:test
```

Local-test execution additionally requires `NODE_ENV=test`, a local host, and
matching `MIGRATION_TARGET` confirmation. Automated tests use fake clients and
temporary directories; they do not connect to or mutate remote databases.

## Guarded Staging Execution

Staging execution requires all of the following:

```text
DATABASE_URL
MIGRATION_TARGET=staging
CONFIRM_MIGRATION_TARGET=staging
ALLOW_STAGING_MIGRATIONS=true
```

It also requires verified staging environment evidence. A local run against a
public staging URL additionally requires:

```text
CONFIRM_STAGING_DATABASE=staging
CONFIRM_PUBLIC_STAGING_DATABASE_URL=true
```

The package command intentionally supplies only `MIGRATION_TARGET=staging`:

```bash
CONFIRM_MIGRATION_TARGET=staging \
ALLOW_STAGING_MIGRATIONS=true \
CONFIRM_STAGING_DATABASE=staging \
CONFIRM_PUBLIC_STAGING_DATABASE_URL=true \
DATABASE_URL='<staging URL>' \
npm run migrate:staging
```

The runner logs only target type, host, database name, and migration counts.
Credentials are removed from inspected URLs and never printed in errors.

## Production Prohibition

Production is not an allowed target for the generic migration runner, and
production-like target metadata remains rejected. Migrations are never run from
application startup, dependency installation, or the normal test command.

The dedicated Emergency production runner owns only the five Emergency
migrations listed as inventory entries 13 through 17, in that exact order.

It is not a general production runner. It requires the exact approved Railway
project, production environment, service identity, and external execution
confirmations. It must run inside the approved Railway production application
container where private database networking is available. No other migration
may use this runner. Future production migration chains require separately
reviewed, dedicated governance.

The Emergency chain requires the canonical relationship and conversation
tables created by:

```text
202607200002_create_request_relationships.sql
202607200003_create_conversations.sql
```

Those migrations are owned only by the separate dedicated production
conversation prerequisite runner in
`scripts/run-production-conversation-prerequisites.js`. That runner owns those
two pinned files in their exact order and must never execute an Emergency
migration. The Emergency runner must fail before mutation when either
prerequisite table is absent and must never apply or record either prerequisite
migration.

The prerequisite runner requires the exact approved Railway production project,
environment, service identity, migration-chain confirmation, target
confirmation, and mutation confirmation. It may execute only by direct Node
invocation inside the approved Railway production application container after a
separately reviewed execution approval. It is not registered as a package
script, and the generic runner remains production-prohibited.

Successful read-only prerequisite verification and exact ledger recording are
required before the Emergency safe-prefix resume may begin. No arbitrary
production migration chaining is authorized; future prerequisite chains require
their own reviewed governance.

After a governed prerequisite milestone, the Emergency runner may resume only
from the exact verified prefix in which
`202607230001_create_emergency_requests.sql` is applied once with its approved
checksum and schema, migrations 2 through 5 are absent, and migration 2 left no
schema residue. The runner verifies and skips migration 1, then executes
migrations 2 through 5 in order. Arbitrary, noncontiguous, drifted, incomplete,
or residue-bearing partial chains are prohibited.

No Emergency production migration retry is permitted after a failure until a
read-only investigation establishes the exact schema and ledger state and a new
explicit execution approval is issued.

## Account-Security Deployment Order

1. Commit the governed migration foundation.
2. Push the reviewed code.
3. Run the governed staging migration with explicit confirmations.
4. Verify the staging schema and migration ledger.
5. Deploy the runtime that requires `users.token_version`.
6. Verify signup, login, authenticated password change, and token invalidation.

Production migration remains unsupported by this runner. A separately reviewed
production process is required before any production schema execution.

The workflow-event migration has a dedicated, fail-closed production runner in
`scripts/apply-production-workflow-events.js`. It requires explicit production
environment evidence, the exact migration filename, and two CLI confirmations;
normal application startup and `npm test` never invoke it.
