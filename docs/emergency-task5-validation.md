# Emergency Task 5B validation

Implemented and validated locally on 2026-09-19. Uncommitted; stop point requested by the user.

- Authorized worktree: `/private/tmp/meetro-server-emergency-completion-invoice-history-20260919`
- Authorized branch: `feature/emergency-completion-invoice-history-20260919`
- Unchanged certified base/HEAD: `e7025e15200f7a218957c306ef99b5528a073100`
- Exactly one new migration: `migrations/202609190004_generalize_emergency_completion_invoice_history.sql`
- All 103 prior migration files compared byte-for-byte with HEAD: unchanged.

## Delivered behavior

Emergency Complete uses the canonical completion writer and homeowner `work.completed` alert inside the existing dispatch transaction. The canonical record has zero Workstreams/work items, exact Emergency provenance, completed Evaluation evidence, and effective issued Meetro Quote approval evidence. Dispatch and canonical completion share one completion instant. Repeat Complete is idempotent; older completed Emergencies reconcile only with exact work-start and commercial evidence. The public success codes remain `EMERGENCY_COMPLETED` and `EMERGENCY_ALREADY_COMPLETED`.

An explicit Emergency Completion Review reports zero Workstreams without `NO_APPROVED_WORK`. The existing canonical Invoice engine accepts Emergency completion and exact approved Quote scope, preserves deposit carry-forward, delivers through the exact active Emergency Conversation, keeps customer drafts unavailable, and rejects external issuance. The professional Invoice workspace and professional/homeowner history resolve the same Job through PAID. The active Request Relationship remains durable. No posts, request selections, Visits, Workstreams, Schedule requirements, parallel lifecycle tables, or new authority grants are introduced.

The real PostgreSQL certification demonstrates 10000 Quote total → 5000 deposit received → Invoice total 10000 / paid 5000 / balance 5000 → Meetro issue PARTIALLY_PAID → final 5000 payment → PAID / paid 10000 / balance 0. A separate case records 2000 then 3000 as two append-only final Invoice payments. Both histories and Invoice-by-Job reads remain available.

Migration 104 changes the completion count constraint and validates every historical completion origin without backfilling business rows. Four previous completion origins retain positive Workstream requirements. The four previous Invoice branches remain identical, approved-scope approval identity checks remain intact, and external issuance remains limited to business_document/business_customer.

## Validation results

| Run | Total | Pass | Fail | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Focused migration/dispatch/completion/Invoice/governance tests | 67 | 67 | 0 | 0 |
| Dedicated Task 5 PostgreSQL | 19 | 19 | 0 | 0 |
| Full server suite with Task 5 PostgreSQL enabled | 2884 | 2809 | 0 | 75 |

The full-suite skips are optional database tests whose separate database environment variables were not enabled. Task 5 PostgreSQL was enabled and did not skip. Expected injected alert failure logging in the atomicity test is not a test failure.

Focused command:

```sh
node --test test/emergencyCompletionInvoiceHistoryMigration.test.js test/emergencyDispatchService.test.js test/jobCompletionService.test.js test/invoicePaymentService.test.js test/businessCustomerInvoiceAuthorityRuntime.test.js test/migrationInventoryGovernance.test.js test/emergencyPreWorkAuthorityMigration.test.js
```

Dedicated command:

```sh
NODE_ENV=test EMERGENCY_TASK5_DATABASE_URL=postgresql://127.0.0.1:55440/meetro_test_emergency_task5 node --test test/emergencyTask5Postgres.test.js
```

Full command:

```sh
NODE_ENV=test EMERGENCY_TASK5_DATABASE_URL=postgresql://127.0.0.1:55440/meetro_test_emergency_task5 npm test
```

PostgreSQL tests use an isolated local test database with an outer ROLLBACK and service transactions mapped to savepoints. Rejected identities, absent Evaluation/approval/work-start evidence, unapproved newer issued Quote evidence, outsider/homeowner professional commands, three injected transaction failures, malformed migration origins, historical reconciliation, unchanged grants, all four prior Invoice origins, and preserved non-Emergency completion counts are covered. The newer-issued-Quote case uses a temporary source-shaped SQL fixture because Emergency Quote revision creation is outside Task 5.

Migration reapplication against populated test lifecycle data preserves every public table's row-content digest, creates no tables, and leaves the external issuance function definition unchanged. After the suite, independent verification found **zero retained public tables**. The test database was dropped, the local PostgreSQL server stopped, and its dedicated cluster directory removed.

Logs:

- `/private/tmp/emergency-task5-focused.log`
- `/private/tmp/emergency-task5-pg-test.log`
- `/private/tmp/emergency-task5-full.log`

`git diff --check`: PASS (exit 0).

## SHA-256

| Migration | SHA-256 |
| --- | --- |
| 202609190001_create_emergency_job_foundation.sql | `4f68f95499f006761445db7001b646deb9379f580cc6ff5bbc9b41b17e416f55` |
| 202609190002_generalize_emergency_job_evaluation_quote.sql | `0644836aca0bc7ca34856b4cd77f8d65de4b3fd5712fa6044902aa74489a6d84` |
| 202609190003_generalize_emergency_pre_work_authority.sql | `2706a13c9fe418383b67d7e1d56cea4ab181b81c11d2e1feff9003bc2f1fbf8a` |
| 202609190004_generalize_emergency_completion_invoice_history.sql | `d5e4df95299ae55f2b6bd46c47a91e9c1f828f11404d03d932a12f021cda29a3` |

## Exact file manifest and git status

All paths below are relative to the authorized worktree shown above. `M` means modified; `??` means added/untracked. This is the complete `git status --short` output, including this report. Existing migration test changes only update their latest filename/count assertions; dispatch success coverage that now needs canonical evidence runs in the dedicated PostgreSQL suite.

```text
 M migrations/README.md
 M server/authorization/quoteDraftService.js
 M server/emergency/emergencyCommercialContext.js
 M server/emergency/emergencyDispatchService.js
 M server/finance/invoicePaymentService.js
 M server/workflow/jobCompletionService.js
 M test/approvedWorkVisitActivationMigration.test.js
 M test/askMeetroWorkflowMigration.test.js
 M test/businessContactMigration.test.js
 M test/businessCustomerRelationshipMigration.test.js
 M test/businessPortfolioAuthorityMigration.test.js
 M test/customerPartyMigration.test.js
 M test/efrActivationMigration.test.js
 M test/emergencyDispatchService.test.js
 M test/evaluationVisitActivationMigration.test.js
 M test/evaluationVisitAuthorityNegotiationMigration.test.js
 M test/invoicePaymentMigration.test.js
 M test/jobCompletionMigration.test.js
 M test/migrationInventoryGovernance.test.js
 M test/preWorkDepositPaymentMigration.test.js
 M test/quickQuoteAnalysisContinuationReviewMigration.test.js
 M test/quickQuotePhotoAssistReviewMigration.test.js
 M test/quoteBusinessDocumentBridgeMigration.test.js
 M test/quoteCompositionFeedbackMigration.test.js
 M test/quoteCustomerTermsMigration.test.js
 M test/quoteDeliveryMigration.test.js
 M test/quoteFoundationMigration.test.js
 M test/recommendationFoundationMigration.test.js
 M test/visitFoundationMigration.test.js
 M test/visitStartAuthorityMigration.test.js
 M test/workPlanActivationMigration.test.js
 M test/workstreamFoundationMigration.test.js
?? docs/emergency-task5-validation.md
?? migrations/202609190004_generalize_emergency_completion_invoice_history.sql
?? test/emergencyCompletionInvoiceHistoryMigration.test.js
?? test/emergencyTask5Postgres.test.js
?? test/helpers/emergencyLifecycleFixture.js
```

## Boundaries

NO COMMIT. NO PUSH. NO DEPLOY. NO REBASE. NO RAILWAY OR STAGING DB ACCESS. NO PRODUCTION CHANGE. PROTECTED CHECKOUT UNTOUCHED. No production branch created. Work remains only in the authorized Task 5B worktree and branch at the unchanged certified base.
