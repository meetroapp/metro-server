# R5.5A Customer History linkage audit and repair

Implemented in `/private/tmp/meetro-r55a-server-20260913`, a fresh isolated clone checked out at staging base `8fe91ec636c15f82df48a364b9a66b7c62d33a73`. No commit was created. The R5.5 client at `/private/tmp/meetro-r55-client-20260913` was read only and remains frozen with its pre-existing changes.

**Outcome:** the current saved-customer document save defect is repaired in the candidate. A bounded reconciliation endpoint is implemented and certified locally. The known staging Job remains unlinked: reconciliation has deliberately not been executed on staging.

## 1–4. Known Job, missing linkage, cause, and data age

The staging audit used a PostgreSQL connection configured with `default_transaction_read_only=on`, a statement timeout, and a repeatable-read, read-only transaction. Railway credentials were captured in memory and were not printed. Only SELECT statements ran; the audit ended with ROLLBACK.

| Identity / evidence | Verified value |
|---|---|
| Canonical Job | `072c8736-5d97-4253-ba3e-dd1bce281a20` |
| Canonical Invoice | `93792224-2cfd-44d0-ada7-8efd5e48a5da` / `INV-937922242CFD` |
| Invoice latest version | `3` |
| Invoice truth | USD total `68000`, paid `68000`, balance `0` minor units |
| Job source type | `ordinary_request_selection` |
| Job request | `23` |
| Source selection | `9` |
| Source request relationship | `345`, active |
| Contractor profile | `7`, derived through the exact request relationship; marketplace Job's direct `contractor_profile_id` is NULL |
| Professional user | `15` |
| Marketplace homeowner / Job creator | `12` |
| Originating business document | NULL on the marketplace Job |
| Job's direct Contact / Customer Relationship columns | Both NULL |
| `job_customer_parties` | No row |
| Canonical Quote party rows | None for either Quote |
| Canonical Invoice party row | None |
| Canonical Quote customer snapshots | None |
| Exact linked Contact | `0c3c3c09-2ba8-4bd6-a001-0524984e467a` |
| Exact linked Customer Relationship | `e9bb9da5-7cc9-4c3a-b4d3-814a7a020a43`, owned by profile `7`, linked to that exact Contact |
| Source working Quote | `ccda1240-b24e-4f10-b06f-3908c6641773` / `Q-0000001` |
| Imported canonical Quote | `f08a4f3b-8a21-4da8-a6b0-4258f5a8df9b` |
| Other canonical Quote on the same Job | `f1858dc5-0c68-4296-af12-2e714ee8a42a` |
| Separate working Invoice | `b33cd4f7-8538-4e50-a70e-5a83c897c394`, with no customer-party IDs |
| Completion | `COMPLETED`, `2026-09-13T00:41:32.068Z` |

The Quote and Invoice do not have a durable business-customer party assignment of their own. Their canonical Job retains marketplace identity through request relationship `345` and homeowner `12`; that marketplace identity alone is not proof of a private business Contact.

**Timeline (UTC):**

1. Customer-party migration applied: `2026-08-24T21:54:54.602Z`.
2. Marketplace Job created: `2026-08-26T17:07:42.266Z`.
3. Working Quote version 1 saved: `2026-08-27T17:39:01.931Z`, with `customerParty: null` in its completed CREATE receipt.
4. Version 1 imported into canonical Quote `f08a4f3b-...` at `2026-08-27T21:37:29.447Z`. The immutable source mapping records the exact document, Job, business profile, version 1 and integrity hash `2c41e029e5ffb1364d1e611a5f9e41b9eb6175dcbebb02931820bf3bdc6a21db`.
5. Contact created at `2026-08-29T19:45:50.258Z`; exact Relationship created at `2026-08-29T19:45:50.893Z`.
6. Working Quote UPDATE receipt `7fa03a47-ad4b-45f8-931f-8d7234befb90`, completed at `2026-08-29T19:45:51.112Z`, records version 2 with the exact Job/profile/Contact/Relationship tuple. Versions 3, 4 and 5 retain the same tuple in their completed receipts.
7. Canonical Invoice created: `2026-08-29T23:17:33.274Z`, without a customer-party row.

**Exact cause:** marketplace Job creation correctly did not invent a private business Contact. The original Quote import also had no saved customer tuple to propagate. Later, saving an explicit Contact and Customer Relationship on the Job-linked working Quote persisted the document tuple and its command receipt, but `businessDocumentDraftService` never established `job_customer_parties`. Later canonical document creation therefore lacked that Job party, and Customer History had no exact Job linkage to read. The old Quote/Invoice history queries additionally required document-specific party rows, so repairing only the Job row would not have restored those documents without the read-only projection correction.

This is a **current creation/linking-event defect affecting existing records**, not simply a Job created before the linkage migration. The earliest completed save receipt proves when the tuple was attached; the receipt's `customerParty.linkedAt` is not used as an attachment timestamp because that projection reflects the working document's creation time.

## 5. All governed Job creation and document paths

A source search found two actual `INSERT INTO jobs` paths, both in `server/workflow/jobFoundationService.js`.

| Path | Existing authority and linkage behavior | R5.5A treatment |
|---|---|---|
| Marketplace selection | `requestSelectionService` calls `bootstrapLifecycleJob`; exact request selection/relationship and participant authority create the Job. No private Contact tuple exists, so no Job party is created. | Preserved. Later explicit saved-customer document selection now establishes the Job party. Homeowner identity never generates a Contact. |
| External/customer business-document Job | `materializeBusinessDocumentJob` validates the owning professional/profile; new Job copies the exact saved document Contact/Relationship and inserts its Job party when both exist. | Preserved. Inline customer display data without durable IDs does not fabricate a party. |
| Repeat saved-customer Job | Same business-document materializer, new document/Job, same exact owned saved tuple. | Preserved; local PostgreSQL coverage confirms separate Jobs remain in one Relationship's history. |
| Quick Quote to canonical Quote | A Job-less business document materializes through the above path. A marketplace Job-linked document reuses that Job. Canonical import copies an owned document customer tuple into the Quote party if available. | New saves establish the Job party before later import. Previously saved/imported records with missing Job party use the bounded reconciliation command. |
| Existing saved-customer working Quote / Invoice / Deposit Request | Draft create/update validate Job ownership and `loadOwnedCustomerParty`, but previously saved only document party columns. | Fixed: the successful save establishes/validates the Job party in the same transaction. Conflicting existing evidence rejects the save; save failure rolls back the Job link. |
| Canonical root or derived Quote | Uses existing canonical Job and copies a present Job party; does not create another Job. | Preserved; now receives the party established by the corrected save event. Historical Quote party evidence can support reconciliation. |
| External canonical Quote | Uses business-origin materialization, exact owned saved party when available, or the existing external customer snapshot contract. | Preserved. Snapshot display text never becomes reconciliation proof. Only exact durable IDs qualify. |
| Quote to Invoice | Uses the existing Job. `resolveInvoiceCustomerParty` checks the Job party and effective approved Quote parties, rejecting disagreement. | Preserved; no finance code changed. Invoice creation is not another Job creation path. |
| Explicit Job customer link API | Validates exact Job owner plus exact owned Contact/Relationship. Already supports governed marketplace and business-origin Jobs. | Preserved. Unique Job constraint plus reconciliation's conflict reread prevents replacement by a competing link. |
| Existing / pre-linkage Job or materializer replay | Replaying an existing materialized Job does not retroactively create missing customer authority. No separate third legacy Job insert path was found. | Bounded reconciliation derives existing proof; no blind backfill. |

Correction to the earlier R5.5 audit interpretation: `resolveBusinessDocumentOwner` already supports ordinary marketplace Jobs through the exact active request relationship, professional participant and valid primary-professional role. It is not restricted to business-origin Jobs.

## 6–10. Repair and command boundary

`ensureJobCustomerParty` serializes the save/reconciliation paths on the exact Job, resolves the authenticated business owner using the existing authority service, verifies every available candidate tuple, and verifies the exact Contact/Relationship ownership. It never updates an existing party. A competing assignment fails closed, including a concurrent explicit link detected after `ON CONFLICT DO NOTHING`.

The reconciliation endpoint is:

```http
POST /jobs/072c8736-5d97-4253-ba3e-dd1bce281a20/customer-party/reconcile
Authorization: <existing authenticated professional session>
Content-Type: application/json

{}
```

**This is documentation of the proposed command, not an executed staging request.** It will require the candidate code to be deployed under a separately authorized release before the route is available there. The authenticated owner must be the professional for the exact Job. Any supplied payload fields, including customer IDs, names, email or phone, are rejected.

Allowed server-derived proof sources:

- Existing exact Job customer-party row.
- Exact customer-party columns on a business-origin canonical Job.
- Exact canonical Quote/Invoice party records, joined back to their canonical Job.
- Exact durable IDs on a canonical Quote customer snapshot, joined back to its canonical Job.
- Completed governed document-save receipts joined by both document FK and response ID to the immutable source of a canonical Quote. Receipt Job, nested party Job, profile and actor must agree with that canonical source and owner.

Current working document tuples are checked for competing assignments, but **cannot establish proof alone**. Every tuple must agree. No text matching, marketplace-user-to-Contact inference, or missing-field guess is permitted.

The known Job's four completed UPDATE receipts qualified in the read-only staging evidence query. They all prove the same tuple, and the current working Quote agrees. The command must revalidate current evidence at execution time.

Reconciliation's only DML is `INSERT INTO job_customer_parties ... ON CONFLICT (job_id) DO NOTHING`. It writes no command ledger, Contact, Relationship, Job lifecycle, canonical Quote/Invoice, payment, deposit, Visit, or marketplace authority. Repeating a correct reconciliation returns 200 with the existing link; a new link returns 201; missing or competing proof returns 409; missing Job authority returns 403.

Customer History's read-only Quote/Invoice projection uses an exact Job party only when that document has **no explicit party row**. Explicit document parties remain authoritative. `NOT EXISTS` prevents duplicate and competing fallback; exact Job joins and the existing three-field business/customer scope remain mandatory. Payment, Deposit, Visit, work, media and financial-value queries are unchanged.

- Server production code changed: **yes**, four files.
- Client changed: **no**.
- Migration required: **no**.
- Bounded reconciliation required for this existing staging Job: **yes**, implemented but unexecuted there.

## 11. Exact file inventory

All paths below are relative to `/private/tmp/meetro-r55a-server-20260913`.

Production:

1. `server/documents/businessDocumentDraftService.js` — transactional saved-customer Job linking and conflict response.
2. `server/relationships/jobCustomerPartyReconciliationService.js` — new evidence query, ownership/conflict checks and bounded reconciliation command.
3. `server/relationships/customerParties.js` — authenticated reconcile route.
4. `server/relationships/businessCustomerRelationshipService.js` — exact Job fallback for historical Quote/Invoice projections.

Tests:

5. `test/jobCustomerPartyReconciliation.test.js` — 27 new service, HTTP, save, rollback and conflict tests.
6. `test/jobCustomerPartyReconciliationPostgres.test.js` — new local PostgreSQL certification: 14 runtime cases plus their parent test (15 reported tests).
7. `test/customerPartyRoutes.test.js` — authenticated reconcile route registration.
8. `test/customerHistoryContinuity.test.js` — updated exact Job fallback and explicit-party exclusion assertions.
9. `test/businessCustomerRelationshipActivity.test.js` — updated linkage-source and duplicate/competing fallback assertions.

Audit artifacts:

10. `scripts/audit-r55a-known-job.js` — bounded read-only staging audit; never calls reconciliation.
11. `R5_5A_CUSTOMER_HISTORY_LINKAGE_AUDIT.md` — this report.

## 12–15. Certification

| Check | Result |
|---|---|
| Focused customer-party/history/document service and route tests, including local PostgreSQL | **132 passed, 0 failed, 0 skipped** |
| New PostgreSQL runtime certification alone | **15 passed, 0 failed, 0 skipped** |
| Full server suite | **2,509 total: 2,438 passed, 0 failed, 71 skipped** |
| Full client suite | Not rerun; client untouched in R5.5A |
| Build | No server build script; client/staging build not applicable to this server-only change |
| `git diff --check` | Passed |

The 71 skipped cases are the existing environment-gated tests, chiefly separate PostgreSQL/migration runtime fixtures. Their environment variables were not enabled; no migration runners were invoked. R5.5A's PostgreSQL tests ran against a fresh local cluster and `/meetro_r55a_test`, using session-local temporary fixture tables only. They do not certify every production constraint or all unrelated database-dependent paths.

The required 16 regression concerns are covered: exact legacy proof; idempotence; no proof/name/email/phone inference; cross-business rejection; competing Relationship rejection; no marketplace Contact fabrication; external and repeat-customer continuity; completed Job retention; exact Quote and Invoice scope; unchanged payments/deposits; exact Visit/work scope. PostgreSQL tests execute the production evidence query and history projections against matching/unrelated Jobs and competing parties. They also snapshot every fixture table other than `job_customer_parties` and prove it remains unchanged through reconciliation and replay. Draft create/update tests execute the production SQL-store flow and verify success, competing identity refusal, and rollback if document save fails.

Commands used for certification:

```sh
CUSTOMER_HISTORY_RECONCILIATION_DATABASE_URL=postgresql://127.0.0.1:55455/meetro_r55a_test node --test test/jobCustomerPartyReconciliation.test.js test/jobCustomerPartyReconciliationPostgres.test.js test/customerPartyService.test.js test/customerPartyRoutes.test.js test/customerHistoryContinuity.test.js test/businessCustomerRelationshipActivity.test.js test/businessCustomerRelationshipMediaActivity.test.js test/businessCustomerRelationshipRoutes.test.js test/businessDocumentDraftService.test.js test/businessDocumentDraftRoutes.test.js
CUSTOMER_HISTORY_RECONCILIATION_DATABASE_URL=postgresql://127.0.0.1:55455/meetro_r55a_test npm test
git diff --check
```

Logs: `/private/tmp/r55a-focused-final.log`, `/private/tmp/r55a-postgres-tests.log`, `/private/tmp/r55a-full-server.log`. Read-only audit results: `/private/tmp/r55a-staging-readonly-audit.jsonl`.

## 16–19. Release and financial boundaries

- No migration executed, locally or on staging. Temporary local test fixtures are not application migrations.
- No staging data mutated. Reconciliation was not run on staging.
- No protected repository modified. No client edits. No commit, push, or deployment.
- No Contact or Customer Relationship created to repair the known Job.
- No financial amount, Invoice calculation, payment/deposit evidence, or lifecycle authority changed.
- Separate unresolved financial defect: Work Center Job History reportedly shows **$1,360.00 approved**, while the audited canonical Invoice remains **$680.00 total / $680.00 paid / $0.00 balance**. This discrepancy is documented only; its calculation was not repaired or recalculated in R5.5A.
