# External customer commercial lifecycle — release certification

> **Post-release migration-78 remediation:** The original certification below is retained as history and is superseded for the revised source. See section 15 and `postReleaseMigration78Remediation` in the JSON certificate. Local remediation gates pass; this artifact records readiness for staging retry, not a completed staging retry.

## 1. STATUS

**PASS** — D3B1, D3B2, and D3C are complete in the local server working tree. Marketplace, EXTERNAL_CONTACT, and DOCUMENT_ONLY paths pass real PostgreSQL certification. No deployment was performed.

## 2. STARTING BASELINE

- Repository: `/Users/williammolina/meetro-server/meetro-server`
- Branch: `staging`
- HEAD: `4819151546087e495cd116d6283c74bd16f7f63d`
- Initial tree: 14 modified files, four untracked certified migrations, and the existing untracked `.DS_Store`.
- The initial diff, file copies, and hashes are preserved at `/tmp/meetro_lifecycle_20260902_baseline`.

```text
M server/authorization/quoteDraftService.js
 M server/authorization/quoteDrafts.js
 M server/documents/businessDocumentDeliveryService.js
 M server/documents/businessDocumentDraftService.js
 M server/documents/businessDocumentNumberingService.js
 M server/finance/preWorkDepositService.js
 M server/workflow/jobFoundationService.js
 M test/businessDocumentQuoteReviewIdentity.test.js
 M test/jobLifecycleFoundation.test.js
 M test/preWorkDepositPaymentPostgres.test.js
 M test/preWorkDepositRuntimePostgres.test.js
 M test/quoteBusinessDocumentBridge.test.js
 M test/quoteDraftRoutes.test.js
 M test/quoteDraftService.test.js
?? .DS_Store
?? migrations/202609020001_add_business_origin_commercial_job_foundation.sql
?? migrations/202609020002_create_quote_external_approval_authority.sql
?? migrations/202609020003_generalize_pre_work_deposit_approval_authority.sql
?? migrations/202609020004_generalize_approved_work_visit_approval_authority.sql
```

## 3. MIGRATIONS ADDED

- **80:** `202609020005_create_external_visit_schedule_confirmation.sql` — immutable business-recorded evidence binds the exact Job, common Quote approval, issued Quote version/hash, customer snapshot, proposal version/hash, and schedule. A deferred constraint requires that evidence for external SCHEDULED versions.
- **81:** `202609020006_generalize_work_preparation_execution_approval.sql` — common approval identity across 13 preparation/execution tables, strict origin shapes, generic foreign keys, and exact Visit/confirmation-bound start evidence. Historical append-only rows are retained; new children can derive common identity from a legacy root.
- Migrations 76–79 are unchanged byte for byte. The historical production convergence manifest is unchanged.
- All 18 final disposable targets have exactly 81 ledger entries with the expected filename/checksum pairs. Replay on every target: applied **0**, skipped **81**, failed **[]**.
- The historical ledger-79 copy applied only 80 and 81. The separate 37→38 upgrade fixture was then advanced by 43 migrations to ledger 81.

## 4. D3B1 RESULT

- Both external modes reach a legitimate PROPOSED Approved Work Visit through common Quote approval and a satisfied deposit. DUE and PARTIALLY_SATISFIED deposits stay blocked.
- External scheduling grants are limited to read, propose, reschedule, cancel, and dedicated external-confirmation recording. Ordinary customer grants are absent. Execution materialization separately grants start/complete.
- Marketplace retains six professional and three customer Approved Work Visit capabilities. Historical decision-only activations, grants, and Visits remain readable.
- Sequential D3B1 gate at migration 79: focused **29/29**, external **3/3**, marketplace activation/upgrade **2/2**, financial **2/2**; zero failures/skips.

## 5. D3B2 RESULT

- `POST /jobs/:jobId/visits/:visitId/external-confirmation` records canonical external evidence and moves the exact current PROPOSED version to SCHEDULED.
- Evidence methods: PHONE, EMAIL, TEXT_MESSAGE, IN_PERSON, OTHER. A reference or note and confirmation timestamp are required. The recorder is the real business professional; this is not a Meetro customer decision.
- Ordinary opposite-party confirmation remains enforced. Stale versions, wrong Job/approval/hash, invalid time, changed-payload replay, deposit reversal, and incomplete transactional writes are rejected.
- Rescheduling creates a new proposal and requires new confirmation. Projections distinguish business-recorded external evidence.
- Sequential D3B2 gate: **37 tests, 37 passed, 0 failed, 0 skipped**.

## 6. D3C RESULT

- Preparation and execution use `quoteApprovalId`; marketplace decision fields remain provenance. External request/relationship/customer-decision/customer-participant fields stay NULL.
- Required preparation, purchases, purchase corrections, staging, receipt references, and execution authority are enforced before start. Plan mutations require approval-specific grants.
- Start requires the current SCHEDULED Visit, matching external confirmation, a still-satisfied deposit, active execution, and start/execute capability. It writes canonical start evidence bound to the confirmation and exact Visit versions.
- Visit completion and replay succeed through the existing lifecycle. Live Job recognizes the external Job without a request relationship or customer decision.
- Direct database rejection cases, append-only history, wrong identity, changed-payload replay, and required-preparation/deposit reversal gates pass.

## 7. EXTERNAL_CONTACT RESULT

**PASS.** Issued Quote → external approval → satisfied deposit → scheduling activation → PROPOSED → external evidence → SCHEDULED → preparation/execution → STARTED → COMPLETED. Only the real professional is a Job participant. Customer decisions, CUSTOMER_REPRESENTATIVE assignments, fabricated users, conversations, customer grants, and customer-directed lifecycle alerts remain absent.

## 8. DOCUMENT_ONLY RESULT

**PASS.** The same complete path passes with frozen document identity and no reusable customer record requirement. The same zero-fabrication assertions pass.

## 9. MARKETPLACE REGRESSION RESULTS

Each row is from the consolidated fresh PostgreSQL gate.

| Test | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| [test/workPreparationRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/workPreparationRuntimePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/workPreparationAuthorityPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/workPreparationAuthorityPostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/approvedWorkExecutionRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkExecutionRuntimePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/approvedWorkExecutionAuthorityPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkExecutionAuthorityPostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/approvedWorkStartRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkStartRuntimePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/approvedWorkCompletionRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkCompletionRuntimePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/visitServicePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/visitServicePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/professionalScheduleServicePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/professionalScheduleServicePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/preWorkDepositRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/preWorkDepositRuntimePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/preWorkDepositPaymentPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/preWorkDepositPaymentPostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/approvedWorkVisitServicePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkVisitServicePostgres.test.js) | 2 | 2 | 0 | 0 |
| [test/visitStartRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/visitStartRuntimePostgres.test.js) | 1 | 1 | 0 | 0 |
| [test/alertB1VisitPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/alertB1VisitPostgres.test.js) | 1 | 1 | 0 | 0 |
| **Marketplace total** | **14** | **14** | **0** | **0** |

The separate historical compatibility test also passed **1/1**, preserving existing evidence and appending a common-approval preparation version to a legacy root.

## 10. FULL / FOCUSED TEST RESULTS

| Gate | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Focused lifecycle/Quote/Job tests (40 files) | 296 | 296 | 0 | 0 |
| Consolidated PostgreSQL (17 files, 18 databases) | 24 | 24 | 0 | 0 |
| Full server suite | 2255 | 2189 | 0 | 66 |

The full-suite skips are reported as skips. They include optional database/integration/staging tests without their explicit environments. The 24 selected database tests were independently executed, with zero skips; counts from separate gates should not be added together.

- Syntax: `node --check` passed for all **79** modified/new JavaScript files.
- Historical checksum/inventory tests retain the frozen prefix and now certify the exact 81-file inventory.
- Legacy Visit test fixtures now use required reconfirmation and START before completion; current authority constraints were retained.

## 11. CHANGED FILES

**73 files created or changed in this task** (including this report and its certificate):

- [docs/external-customer-commercial-lifecycle-20260902.json](/Users/williammolina/meetro-server/meetro-server/docs/external-customer-commercial-lifecycle-20260902.json)
- [docs/external-customer-commercial-lifecycle-20260902.md](/Users/williammolina/meetro-server/meetro-server/docs/external-customer-commercial-lifecycle-20260902.md)
- [migrations/202609020005_create_external_visit_schedule_confirmation.sql](/Users/williammolina/meetro-server/meetro-server/migrations/202609020005_create_external_visit_schedule_confirmation.sql)
- [migrations/202609020006_generalize_work_preparation_execution_approval.sql](/Users/williammolina/meetro-server/meetro-server/migrations/202609020006_generalize_work_preparation_execution_approval.sql)
- [migrations/README.md](/Users/williammolina/meetro-server/meetro-server/migrations/README.md)
- [server/authorization/lifecycleAuthorityService.js](/Users/williammolina/meetro-server/meetro-server/server/authorization/lifecycleAuthorityService.js)
- [server/finance/preWorkDepositService.js](/Users/williammolina/meetro-server/meetro-server/server/finance/preWorkDepositService.js)
- [server/workflow/approvedWorkExecutionService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/approvedWorkExecutionService.js)
- [server/workflow/approvedWorkExecutions.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/approvedWorkExecutions.js)
- [server/workflow/approvedWorkVisitService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/approvedWorkVisitService.js)
- [server/workflow/externalVisitConfirmationService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/externalVisitConfirmationService.js)
- [server/workflow/liveJobProjectionService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/liveJobProjectionService.js)
- [server/workflow/professionalScheduleService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/professionalScheduleService.js)
- [server/workflow/visitService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/visitService.js)
- [server/workflow/visits.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/visits.js)
- [server/workflow/workPreparation.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/workPreparation.js)
- [server/workflow/workPreparationService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/workPreparationService.js)
- [test/alertB1VisitPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/alertB1VisitPostgres.test.js)
- [test/approvedWorkCompletionRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkCompletionRuntimePostgres.test.js)
- [test/approvedWorkExecutionAuthorityMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkExecutionAuthorityMigration.test.js)
- [test/approvedWorkExecutionAuthorityPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkExecutionAuthorityPostgres.test.js)
- [test/approvedWorkExecutionRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkExecutionRuntimePostgres.test.js)
- [test/approvedWorkExecutionService.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkExecutionService.test.js)
- [test/approvedWorkStartIntegration.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkStartIntegration.test.js)
- [test/approvedWorkStartRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkStartRuntimePostgres.test.js)
- [test/approvedWorkVisitActivationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkVisitActivationMigration.test.js)
- [test/approvedWorkVisitService.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkVisitService.test.js)
- [test/approvedWorkVisitServicePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/approvedWorkVisitServicePostgres.test.js)
- [test/askMeetroWorkflowMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/askMeetroWorkflowMigration.test.js)
- [test/businessContactMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/businessContactMigration.test.js)
- [test/businessCustomerRelationshipMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/businessCustomerRelationshipMigration.test.js)
- [test/businessPortfolioAuthorityMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/businessPortfolioAuthorityMigration.test.js)
- [test/commercialLifecycleHistoryPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/commercialLifecycleHistoryPostgres.test.js)
- [test/customerPartyMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/customerPartyMigration.test.js)
- [test/efrActivationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/efrActivationMigration.test.js)
- [test/evaluationRemoteProvenanceMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/evaluationRemoteProvenanceMigration.test.js)
- [test/evaluationVisitActivationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/evaluationVisitActivationMigration.test.js)
- [test/evaluationVisitAuthorityNegotiationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/evaluationVisitAuthorityNegotiationMigration.test.js)
- [test/externalApprovedWorkExecutionPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/externalApprovedWorkExecutionPostgres.test.js)
- [test/externalApprovedWorkSchedulingPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/externalApprovedWorkSchedulingPostgres.test.js)
- [test/externalVisitConfirmationPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/externalVisitConfirmationPostgres.test.js)
- [test/helpers/externalLifecycleFixture.js](/Users/williammolina/meetro-server/meetro-server/test/helpers/externalLifecycleFixture.js)
- [test/helpers/externalLifecycleMigrationInventory.js](/Users/williammolina/meetro-server/meetro-server/test/helpers/externalLifecycleMigrationInventory.js)
- [test/helpers/visitLifecycleFixture.js](/Users/williammolina/meetro-server/meetro-server/test/helpers/visitLifecycleFixture.js)
- [test/invoicePaymentMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/invoicePaymentMigration.test.js)
- [test/jobCompletionMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/jobCompletionMigration.test.js)
- [test/liveJobProjectionService.test.js](/Users/williammolina/meetro-server/meetro-server/test/liveJobProjectionService.test.js)
- [test/migrationInventoryGovernance.test.js](/Users/williammolina/meetro-server/meetro-server/test/migrationInventoryGovernance.test.js)
- [test/ordinaryEvaluationFindingMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/ordinaryEvaluationFindingMigration.test.js)
- [test/preWorkDepositPaymentMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/preWorkDepositPaymentMigration.test.js)
- [test/preWorkDepositPaymentPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/preWorkDepositPaymentPostgres.test.js)
- [test/preWorkDepositRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/preWorkDepositRuntimePostgres.test.js)
- [test/professionalScheduleService.test.js](/Users/williammolina/meetro-server/meetro-server/test/professionalScheduleService.test.js)
- [test/professionalScheduleServicePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/professionalScheduleServicePostgres.test.js)
- [test/quickQuoteAnalysisContinuationReviewMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/quickQuoteAnalysisContinuationReviewMigration.test.js)
- [test/quickQuotePhotoAssistReviewMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/quickQuotePhotoAssistReviewMigration.test.js)
- [test/quoteBusinessDocumentBridgeMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteBusinessDocumentBridgeMigration.test.js)
- [test/quoteCompositionFeedbackMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteCompositionFeedbackMigration.test.js)
- [test/quoteCustomerTermsMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteCustomerTermsMigration.test.js)
- [test/quoteCustomerTermsSnapshot.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteCustomerTermsSnapshot.test.js)
- [test/quoteDeliveryMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteDeliveryMigration.test.js)
- [test/quoteFoundationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteFoundationMigration.test.js)
- [test/recommendationFoundationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/recommendationFoundationMigration.test.js)
- [test/visitFoundationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/visitFoundationMigration.test.js)
- [test/visitRoutes.test.js](/Users/williammolina/meetro-server/meetro-server/test/visitRoutes.test.js)
- [test/visitService.test.js](/Users/williammolina/meetro-server/meetro-server/test/visitService.test.js)
- [test/visitServicePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/visitServicePostgres.test.js)
- [test/visitStartAuthorityMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/visitStartAuthorityMigration.test.js)
- [test/workPlanActivationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/workPlanActivationMigration.test.js)
- [test/workPreparationAuthorityMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/workPreparationAuthorityMigration.test.js)
- [test/workPreparationAuthorityPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/workPreparationAuthorityPostgres.test.js)
- [test/workPreparationRuntimePostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/workPreparationRuntimePostgres.test.js)
- [test/workstreamFoundationMigration.test.js](/Users/williammolina/meetro-server/meetro-server/test/workstreamFoundationMigration.test.js)

**15 pre-existing changed/untracked files retained without further modification:**

- [migrations/202609020001_add_business_origin_commercial_job_foundation.sql](/Users/williammolina/meetro-server/meetro-server/migrations/202609020001_add_business_origin_commercial_job_foundation.sql)
- [migrations/202609020002_create_quote_external_approval_authority.sql](/Users/williammolina/meetro-server/meetro-server/migrations/202609020002_create_quote_external_approval_authority.sql)
- [migrations/202609020003_generalize_pre_work_deposit_approval_authority.sql](/Users/williammolina/meetro-server/meetro-server/migrations/202609020003_generalize_pre_work_deposit_approval_authority.sql)
- [migrations/202609020004_generalize_approved_work_visit_approval_authority.sql](/Users/williammolina/meetro-server/meetro-server/migrations/202609020004_generalize_approved_work_visit_approval_authority.sql)
- [server/authorization/quoteDraftService.js](/Users/williammolina/meetro-server/meetro-server/server/authorization/quoteDraftService.js)
- [server/authorization/quoteDrafts.js](/Users/williammolina/meetro-server/meetro-server/server/authorization/quoteDrafts.js)
- [server/documents/businessDocumentDeliveryService.js](/Users/williammolina/meetro-server/meetro-server/server/documents/businessDocumentDeliveryService.js)
- [server/documents/businessDocumentDraftService.js](/Users/williammolina/meetro-server/meetro-server/server/documents/businessDocumentDraftService.js)
- [server/documents/businessDocumentNumberingService.js](/Users/williammolina/meetro-server/meetro-server/server/documents/businessDocumentNumberingService.js)
- [server/workflow/jobFoundationService.js](/Users/williammolina/meetro-server/meetro-server/server/workflow/jobFoundationService.js)
- [test/businessDocumentQuoteReviewIdentity.test.js](/Users/williammolina/meetro-server/meetro-server/test/businessDocumentQuoteReviewIdentity.test.js)
- [test/jobLifecycleFoundation.test.js](/Users/williammolina/meetro-server/meetro-server/test/jobLifecycleFoundation.test.js)
- [test/quoteBusinessDocumentBridge.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteBusinessDocumentBridge.test.js)
- [test/quoteDraftRoutes.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteDraftRoutes.test.js)
- [test/quoteDraftService.test.js](/Users/williammolina/meetro-server/meetro-server/test/quoteDraftService.test.js)

The pre-existing finance service was extended only at the exact-approval deposit gate. The two pre-existing financial regression files retained their prior changes and received compatible fixture updates. `.DS_Store` is excluded from the edited-file list and remains untouched and unstaged.

## 12. DATABASE CERTIFICATION

All databases are disposable local PostgreSQL targets. No staging or production database was mutated.

| Database | Test | Final ledger | Replay applied / skipped / failed |
|---|---|---:|---|
| `meetro_test_lifecycle_cert_20260902_01` | `workPreparationRuntimePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_02` | `workPreparationAuthorityPostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_03` | `approvedWorkExecutionRuntimePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_04` | `approvedWorkExecutionAuthorityPostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_05` | `approvedWorkStartRuntimePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_06` | `approvedWorkCompletionRuntimePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_07` | `visitServicePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_08` | `professionalScheduleServicePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_09` | `preWorkDepositRuntimePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_10` | `preWorkDepositPaymentPostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_11` | `approvedWorkVisitServicePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_12` | `approvedWorkVisitServicePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_13` | `externalApprovedWorkSchedulingPostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_14` | `externalVisitConfirmationPostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_15` | `externalApprovedWorkExecutionPostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_16` | `visitStartRuntimePostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_17` | `alertB1VisitPostgres.test.js` | 81 | 0 / 81 / [] |
| `meetro_test_lifecycle_cert_20260902_18` | `commercialLifecycleHistoryPostgres.test.js` | 81 | 0 / 81 / [] |

The historical fixture is a fresh copy of `meetro_test_d3a_payment_regression_runtime_20260902_171602`. The source was accessed read-only. Existing activation, nine legacy scheduling grants, and Approved Work Visit retain NULL common-approval fields with explicit legacy provenance. Preparation/execution roots were seeded under the pre-81 schema in the copy; migration preserves them and their original versions.

Reproduction: provide the environment names in the JSON certificate to these tests on fresh safe local databases with `NODE_ENV=test`. Provision the Visit Start runtime database through the normal migration runner first; the historical test requires a disposable ledger-79 copy containing certified marketplace evidence.

## 13. SAFETY

- `git diff --check`: PASS.
- Branch and HEAD unchanged; index remains empty.
- `.DS_Store` SHA-256 unchanged: `066e2de7f3070c598aecb4139535ce4705616752c773df719bc71cf4e3c98350`.
- Certified migrations 76–79 retain their starting SHA-256 hashes.
- No reset, clean, stage, commit, push, deployment, remote change, production mutation, or staging database mutation.
- No Meetro client or outer server wrapper edits.

## 14. REMAINING WORK

- No remaining server lifecycle blocker.
- Separate client follow-up: expose `quoteApprovalId` in proposal/preparation/execution commands and collect external schedule evidence through the new route. Approval source is derived by the server. Activation continues to accept the existing exact Job/Quote identity, and marketplace decision fields remain supported.
- Separate UI support can use `canRecordExternalConfirmation` and `externalScheduleConfirmation`. Work start continues to supply `approvedWorkExecutionId` and `expectedExecutionVersion`.
- Payment Reminders remain the next separate feature and were not started.

Machine-readable evidence: [docs/external-customer-commercial-lifecycle-20260902.json](/Users/williammolina/meetro-server/meetro-server/docs/external-customer-commercial-lifecycle-20260902.json).

Local logs: [consolidated PostgreSQL](/tmp/meetro_consolidated_gate.log), [focused suite](/tmp/meetro_lifecycle_focused_final.log), [full suite](/tmp/meetro_lifecycle_full_suite_final.log).

## 15. POST-RELEASE MIGRATION-78 REMEDIATION CERTIFICATION

**READY_FOR_STAGING_RETRY.** Original release: `b98be2b3d297ab3f59b280b2e2b0c5e869ec3152`; staging ledger at certification: **77**. This addendum invalidates the original migration-78 checksum for the revised source while preserving the original test history above.

The original migration-78 statement at lines 32–47 attempted an `UPDATE canonical_pre_work_deposit_obligations ... FROM canonical_quote_approvals`. Read-only staging catalog inspection and SELECT/EXPLAIN proved that exactly one historical APPROVED marketplace obligation matched. Trigger `canonical_pre_work_deposit_obligations_append_only`, BEFORE UPDATE OR DELETE FOR EACH ROW, invokes `prevent_lifecycle_append_only_mutation()` and raises SQLSTATE **55000**: “Lifecycle append-only records cannot be mutated.” This is a direct historical backfill conflict, with a historical-fixture coverage gap. Fresh financial tests had applied migration 78 before seeding obligations; the old historical fixture started at ledger 79.

The correction validates exact historical approval provenance without updating the obligation. Legacy rows retain NULL common identity; new rows must carry common approval under the new-row check and origin guards. Append-only protection remains unchanged. Two runtime deposit reads resolve the exact legacy approval from customer decision, Quote/version, Job and integrity hash, so legacy status, materialization, payment and reversal continue to work. No other runtime file changes.

Migration 78 checksum:

- Prior: `42093e98ae8cd962ac19aa188153e2188efef1c01bd94773ea5564068064fcf9` — never recorded successfully on staging.
- Revised: `8c7a089876eaad046c2db00fd50d64eb13393e474f4a1b29737228426e9bda93`.
- Migrations **76–77 and 79–81 remain byte-for-byte unchanged**. Production was never targeted.

| Remediation gate | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Consolidated PostgreSQL | 25 | 25 | 0 | 0 |
| Mandatory marketplace (included above) | 14 | 14 | 0 | 0 |
| Financial runtime (included above) | 1 | 1 | 0 | 0 |
| Financial integrity (included above) | 1 | 1 | 0 | 0 |
| External lifecycle (included above) | 9 | 9 | 0 | 0 |
| Historical upgrade + fresh install (included above) | 2 | 2 | 0 | 0 |
| Focused lifecycle, inventory and history | 301 | 301 | 0 | 0 |

Both EXTERNAL_CONTACT and DOCUMENT_ONLY pass the dedicated scheduling, confirmation, execution and completion regressions, including zero fabricated customer authority assertions. Gate totals overlap and must not be added together. The full server suite was not rerun; the original **2,189 passes / 0 failures / 66 skips** remains historical only.

The synthetic ledger-77 fixture uses isolated pre-generalization application code from Git revision `4819151546087e495cd116d6283c74bd16f7f63d` to create historical marketplace evidence; only the explicit local history test requires that revision. The original update reproduces **55000**. Corrected migrations **78–81 apply four migrations with no failure**, preserving all existing columns and provenance. Before/after comparison covers one obligation, two versions, one receipt, one allocation, two deposit events, three payment commands, one customer decision, one common approval, one Quote, three Quote versions and one issuance. New nullable identity columns remain NULL on the historical obligation. New legacy-shaped inserts are rejected, and an otherwise valid UPDATE remains blocked by the original append-only trigger. Legacy reads, reversal and payment satisfaction pass after upgrade; all original rows remain preserved while new evidence is appended.

Fresh installation applies all **81** migrations. All **21** new disposable certification databases have the exact 81 filenames/checksums; every final replay reports **applied 0 / skipped 81 / failed []**. The separate 37→38 upgrade fixture was advanced by 43 migrations after its test. No real staging customer data was copied.

The original release boundary remains **88 historical files**. This remediation changes **six files**, five already in that boundary plus one new regression test; the combined boundary is **89 unique files**, excluding `.DS_Store`. Exact remediation files:

- [docs/external-customer-commercial-lifecycle-20260902.json](/Users/williammolina/meetro-server/meetro-server/docs/external-customer-commercial-lifecycle-20260902.json)
- [docs/external-customer-commercial-lifecycle-20260902.md](/Users/williammolina/meetro-server/meetro-server/docs/external-customer-commercial-lifecycle-20260902.md)
- [migrations/202609020003_generalize_pre_work_deposit_approval_authority.sql](/Users/williammolina/meetro-server/meetro-server/migrations/202609020003_generalize_pre_work_deposit_approval_authority.sql)
- [server/finance/preWorkDepositService.js](/Users/williammolina/meetro-server/meetro-server/server/finance/preWorkDepositService.js)
- [test/helpers/externalLifecycleMigrationInventory.js](/Users/williammolina/meetro-server/meetro-server/test/helpers/externalLifecycleMigrationInventory.js)
- [test/preWorkDepositHistoryPostgres.test.js](/Users/williammolina/meetro-server/meetro-server/test/preWorkDepositHistoryPostgres.test.js)

Current source hashes, exact database names, migration checksums, replay results and local test logs are recorded under `postReleaseMigration78Remediation` in the JSON certificate. The original certificate fields retain their historical meaning. Staging deployment, migration retry and bounded live checks occur only after the remediation commit; their results must be reported separately.
