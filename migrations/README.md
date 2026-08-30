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
34. `202608110001_create_request_modification_authority_foundation.sql`
35. `202608120001_create_business_portfolio_authority_foundation.sql`
36. `202608130001_create_canonical_visit_persistence_foundation.sql`
37. `202608130002_activate_evaluation_visit_authority.sql`
38. `202608130003_activate_approved_work_visit_authority.sql`
39. `202608140001_create_canonical_quote_delivery_foundation.sql`
40. `202608150001_activate_customer_safe_efr.sql`
41. `202608150002_activate_work_plan_execution.sql`
42. `202608150003_create_job_completion_history.sql`
43. `202608150004_create_canonical_invoice_payment_foundation.sql`
44. `202608150005_create_ask_meetro_workflow_review.sql`
45. `202608180001_expand_ask_meetro_workflow_review_operations.sql`
46. `202608190001_create_quick_quote_analysis_session_foundation.sql`
47. `202608190002_expand_ask_meetro_analysis_continuation_review.sql`
48. `202608210001_create_business_document_working_drafts.sql`
49. `202608210002_create_business_document_delivery_foundation.sql`
50. `202608230001_add_business_document_numbers.sql`
51. `202608230002_add_canonical_quote_customer_terms_snapshot.sql`
52. `202608230003_create_canonical_quote_business_document_sources.sql`
53. `202608230004_create_business_contact_foundation.sql`
54. `202608230005_create_business_customer_relationship_foundation.sql`
55. `202608240001_create_customer_party_linkage_foundation.sql`
56. `202608250001_correct_evaluation_visit_authority_and_negotiation.sql`
57. `202608260001_create_evaluation_remote_provenance.sql`
58. `202608270001_add_canonical_visit_start_authority.sql`
59. `202608280001_create_pre_work_deposit_payment_authority.sql`
60. `202608280002_create_canonical_materials_work_preparation_authority.sql`
61. `202608280003_create_canonical_approved_work_execution_authority.sql`
62. `202608290001_add_invoice_line_source_authority.sql`
63. `202608290002_add_deposit_request_document_authority.sql`
64. `202608290003_add_canonical_alert_event_identity.sql`
65. `202608300001_create_professional_subscription_foundation.sql`
66. `202608300002_add_stripe_subscription_authority.sql`
67. `202608300003_add_professional_subscription_plan.sql`
68. `202608300004_create_meetro_business_trial_authority.sql`
69. `202608300005_create_business_team_membership_authority.sql`
70. `202608300006_create_business_job_assignment_authority.sql`

README and other non-SQL files are ignored. Malformed SQL migration filenames
cause discovery to fail closed.

This inventory records migration source files, not applied database state.
Migration creation and governed migration execution remain separate operations.

`202608300006_create_business_job_assignment_authority.sql` adds exact
business/Job/Team-member assignment identity, replay-safe command evidence,
append-only assigned/reassigned/unassigned events, and database-enforced
business ownership and preset-role boundaries. It creates no assignment,
Alert, message, Visit, time entry, Billing record, subscription, or provider
transaction and performs no backfill.

`202608300005_create_business_team_membership_authority.sql` adds durable
business Team memberships, preset role authority, invitation history, exact
user acceptance, and pending-seat reservation evidence. It backfills only each
existing business owner as the required OWNER seat; it creates no employee
account, invitation, subscription, provider transaction, Job assignment,
message, time entry, Billing record, or Alert.

`202608300004_create_meetro_business_trial_authority.sql` adds the one-time,
server-governed 14-day Meetro Business Trial reservation, activation, expiry,
and paid-conversion evidence. Trial identity is account-owned and independent
of Apple and Stripe provider subscriptions; the migration creates no provider
transaction, paid subscription, Job billing, Alert, or Employee/Team row and
performs no backfill.

`202608300001_create_professional_subscription_foundation.sql` adds the
business-owned professional subscription account, one effective verified Apple
subscription authority, and replay-safe provider-event identity. It creates no
subscription, transaction, entitlement, Job billing, or Alert rows and performs
no backfill.

`202608300002_add_stripe_subscription_authority.sql` extends that single
business-owned authority to verified Stripe Billing subscriptions and stores
the Stripe customer binding used for Checkout and Billing Portal. It creates
no subscription, provider transaction, entitlement, Job billing, or Alert rows
and performs no backfill.

`202608300003_add_professional_subscription_plan.sql` extends the existing
business-owned subscription authority with the 10-seat Professional monthly
plan. It changes only the allowed plan and seat-limit constraints and creates
no subscription, provider transaction, entitlement, Job billing, or Alert rows.

`202608290002_add_deposit_request_document_authority.sql` adds the distinct
`DEPOSIT_REQUEST` private working-document purpose, binds it to one exact
pre-work deposit obligation and Job, prevents Invoice-number consumption, and
allows the existing governed delivery ledger to record its deliberate sends.
It creates no request, delivery, message, payment, Invoice, or lifecycle row.

`202608290001_add_invoice_line_source_authority.sql` adds database-enforced
Invoice line source truth for exact approved Quote scope and professionally
reviewed Extra work. Existing Invoice lines retain their exact Quote lineage
and migrate as `APPROVED_QUOTE_SCOPE`; Extra work must carry no Quote source.
It also permits a draft Invoice to carry an already-received pre-work payment
without creating a duplicate Invoice payment record. It creates no Invoice,
payment, Quote, Job completion, or History row.

`202608290003_add_canonical_alert_event_identity.sql` adds nullable,
server-derived permanent event identity for lifecycle Alerts, unique per exact
recipient, plus strict Job, Visit, Quote, and Invoice destination vocabulary.
Existing Alert rows are not backfilled, and Communication attention-window
aggregation retains its existing active dedupe behavior.

`202608250001_correct_evaluation_visit_authority_and_negotiation.sql` adds the
Job-scoped `evaluation_visit` authority shape, immutable
`VISIT_SCHEDULE_PROPOSED` transition vocabulary, the distinct
`visit.link_evaluation` command, and an active-grant lookup index. It creates no
grants or business rows, performs no legacy backfill, and preserves the single
canonical Visit engine for Conversation coordination, Work Center / Schedule
operations, and Dashboard attention projections.

`202608260001_create_evaluation_remote_provenance.sql` adds immutable,
exact-version remote/no-Visit Evaluation provenance with exact Job,
professional-participant, and completed-command references. Database guards
bind role and grant authority to the exact completion-command timestamp, while
a minimal internal Evaluation claim serializes physical and remote provenance
through one unique key under both read-committed and snapshot isolation. It
creates no provenance, claims, or other business rows, performs no backfill,
and does not infer authority from absent Visit history.

`202608270001_add_canonical_visit_start_authority.sql` adds the canonical
`STARTED` Visit state, immutable `started_at` evidence, `visit.start` command
vocabulary, the `VISIT_STARTED` event, and bounded schedule-variance
acknowledgment evidence. It expands the existing append-only Visit aggregate,
creates no grants or business rows, performs no backfill, and preserves legacy
SCHEDULED-to-COMPLETED history without fabricating Visit starts. Runtime and
client Visit-start behavior remain separately governed work.

`202608280001_create_pre_work_deposit_payment_authority.sql` adds exact
accepted-Quote-scoped pre-work deposit obligations, immutable obligation
versions and events, manual-external/future-processor receipt evidence,
explicit payment allocations, append-only allocation reversals, and bounded
command-idempotency persistence. It creates no obligation, receipt, allocation,
payment, Visit, scheduling grant, Work, or Invoice row; performs no backfill;
and leaves runtime payment confirmation and scheduling enforcement as separately
governed work.

`202608280002_create_canonical_materials_work_preparation_authority.sql` adds
exact accepted-Quote-scoped Work Preparation plans and immutable versions,
stable item identities and plan-version snapshots, append-only internal
material purchase and correction evidence, ordered preparation/readiness
events, governed evidence references, bounded command idempotency, and static
future capability vocabulary. Committed evidence structurally records either
no-deposit-required authority from the accepted decision or one exact
SATISFIED Migration 59 obligation version. It creates no Job-scoped business
rows, performs no backfill, does not invent Quote detail for TOTAL_ONLY pricing,
and leaves runtime planning, purchase, preparation, Work-start, and projection
behavior as separately governed work.

`202608280003_create_canonical_approved_work_execution_authority.sql` adds an
exact approved-decision execution aggregate, append-only execution versions,
immutable Workstream bindings, explicit EXECUTION/NON_EXECUTION Activity
classification, TOTAL_ONLY-safe DECISION_WIDE scope, exact included Quote-scope
lineage, and Activity/Approved Work Visit start-evidence foundations. It also
adds a deferred consistency guard preventing future Work Preparation versions
from combining policy NONE with required Work-start items. It creates no
execution business rows or grants, performs no backfill, and legacy Workstreams
and Activities remain unbound and unclassified.

`202608210001_create_business_document_working_drafts.sql` adds private,
noncanonical Quote/Invoice working drafts, independently governed media role and
customer visibility, optimistic versions, and exact create/update idempotency.
It creates no canonical Quote, Invoice, Job, delivery, approval, Payment,
completion, or lifecycle record and does not make saved media customer-visible.

`202608210002_create_business_document_delivery_foundation.sql` adds
noncanonical, version-bound business-document delivery evidence for Email and
governed Meetro Message channels. It does not issue, accept, pay, or close a
canonical Quote, Invoice, or Job.

`202608230001_add_business_document_numbers.sql` adds explicitly initialized,
auditable, immutable, business-scoped Quote and Invoice number sequences.
Legacy working drafts remain nullable and receive no guessed historical number;
the numbers remain separate from internal IDs and draft/lifecycle status. The
migration grants no issuance, approval, payment, or Job lifecycle authority.

`202608230002_add_canonical_quote_customer_terms_snapshot.sql` adds a strict,
normalized customer-facing terms snapshot to immutable canonical Quote versions.
Legacy v1 integrity hashes remain unchanged; terms-bearing versions use integrity
v2, and the existing issuance and sole APPROVED/DECLINED customer-decision chain
continues to bind to the exact resulting hash.

`202608230003_create_canonical_quote_business_document_sources.sql` adds an
append-only one-to-one provenance bridge from one exact saved, numbered working
Quote version to one canonical Draft Quote. The inherited number is never
allocated again, private workspace state is excluded, and the bridge creates no
issuance, customer decision, payment, scheduling, or Job lifecycle authority.

`202608230004_create_business_contact_foundation.sql` adds durable, private,
business-owned PERSON and ORGANIZATION Contact identities, owner-scoped duplicate
candidates, optimistic versioning, idempotent mutations, archival lifecycle, and
append-only multi-role classification history. Contact data and roles grant no
Meetro account, relationship, Conversation, Job, Quote, payment, scheduling, or
lifecycle authority; future verified account linking can reference the stable
Contact UUID without rewriting Contact history.

`202608230005_create_business_customer_relationship_foundation.sql` adds one
durable business-owned Customer Relationship per Business Contact, with exact
idempotent establishment and owner-scoped reads. Contact identity remains joined
from the Contact authority; no Meetro account, marketplace request, Conversation,
Job, Quote, Invoice, payment, scheduling, or lifecycle authority is created.

`202608240001_create_customer_party_linkage_foundation.sql` adds explicit,
owner-consistent foreign-key linkage from mutable business-document drafts and
immutable canonical Jobs, Quotes, and Invoices to an existing durable Contact
and Customer Relationship. It performs no identity matching or backfill, copies
no Contact data into historical document snapshots, and grants no commercial,
communication, payment, scheduling, or lifecycle authority.

`202608150001_activate_customer_safe_efr.sql` adds explicit, conservative
customer visibility to append-only Finding and Recommendation versions and
registers bounded version-edit commands. Existing EFR records remain
professional-only and no customer grant, Quote, decision, Workstream, or Job
state is changed.

`202608150002_activate_work_plan_execution.sql` adds conservative customer
visibility to append-only Work Activity versions and registers the bounded
Work Activity update command. Existing Activities remain professional-only;
the migration creates no Workstream, Activity, Quote, Job, Invoice, Payment,
or completion business record.

`202608150003_create_job_completion_history.sql` adds append-only operational
Job completion evidence and an exact, idempotent completion-command ledger.
It creates no completion business record, changes no Quote or Visit truth,
and introduces no Invoice, Payment, Portfolio, or financial settlement state.

`202608150004_create_canonical_invoice_payment_foundation.sql` adds versioned
Invoice authority, immutable approved-scope line snapshots, exact Conversation
issuance evidence, append-only offline Payment evidence, and durable command
idempotency. It creates no Invoice, Payment, message, alert, Job, Quote, Visit,
or Work Plan business record and introduces no payment-processor authority.

`202608150005_create_ask_meetro_workflow_review.sql` adds append-only human
review evidence for bounded Ask Meetro proposals. It stores accepted, edited,
and rejected decisions without granting Evaluation, Finding, Recommendation,
Quote, Invoice, Payment, Job, or Portfolio authority and creates no business
record by itself.

`202608180001_expand_ask_meetro_workflow_review_operations.sql` expands only
the append-only Ask Meetro review-event operation allowlist to include governed
standalone Quick Quote photo assistance. It creates no Quote, Job, Request,
customer-visible media, pricing, lifecycle, Payment, or other business record
and grants no canonical mutation authority.

`202608190001_create_quick_quote_analysis_session_foundation.sql` adds durable
private Quick Quote Job Analysis session identity, exact authenticated-user
ownership, immutable evidence versions and fingerprints, ordered private turns,
and bounded command idempotency. Session deletion remains available for a later
explicit governed discard so private draft evidence and conversation history can
be permanently removed. It creates no Job, Quote, Request, Conversation,
customer-visible record, pricing, lifecycle, Invoice, Payment, publication, or
provider-continuation authority.

`202608190002_expand_ask_meetro_analysis_continuation_review.sql` expands
only the append-only Ask Meetro workflow-review operation allowlist to
include governed private `quick_quote.analysis.continue` proposals. It
stores explicit ACCEPTED, EDITED, or REJECTED professional decisions and
grants no Quote, Job, Request, Conversation, customer-visible content,
pricing, lifecycle, Invoice, Payment, Visit, publication, or canonical
mutation authority.

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

`202608110001_create_request_modification_authority_foundation.sql` adds an
optimistic modification version to ordinary requests and an append-only,
request/concern/Job-scoped photo attachment evidence ledger. It creates no
Agreement Revision, Change Order, Supplemental Quote, production migration,
or automatic lifecycle transition authority.

`202608120001_create_business_portfolio_authority_foundation.sql` adds nullable
legacy-preserving publication authority, deterministic per-contractor display
order, future-insert Draft defaults, server-owned feature/privacy/version
foundations, and an append-only publication-transition ledger. It does not
classify existing projects, publish Portfolio content, create lifecycle HTTP
commands, change governed media, or create frontend authority.

`202608130001_create_canonical_visit_persistence_foundation.sql` adds immutable
Job-child Visit identities, append-only scheduling versions and typed events,
future command-idempotency persistence, exact approved-Quote decision evidence,
same-Job Evaluation and Workstream links, and bounded Visit capability
definitions. It creates no Visit business rows, grants no capability, infers no
historical schedule, exposes no route, and does not transition Evaluation,
Quote, Workstream, Activity, Job, Invoice, or completion authority.

`202608130002_activate_evaluation_visit_authority.sql` adds an Evaluation-only
lifecycle grant scope and immutable activation evidence. It creates no grants,
activations, Visits, or adjacent-domain business rows. Explicit professional
activation remains required for the exact same-Job Evaluation subject.

`202608130003_activate_approved_work_visit_authority.sql` adds an exact
approved-Quote-decision lifecycle grant scope and immutable Approved Work Visit
activation evidence. It creates no grants, activations, Visits, or adjacent
business rows. Quote approval remains scope authority; explicit professional
activation governs only the timing and attendance capability.

`202608140001_create_canonical_quote_delivery_foundation.sql` adds exact
canonical Quote and Job references plus bounded delivery-idempotency evidence
to structured Conversation messages. It preserves ordinary text messages and
creates no Quote status, customer decision, Visit, scheduling, or external-share
authority.

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
