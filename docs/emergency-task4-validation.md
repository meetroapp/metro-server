# Emergency Task 4 implementation and validation

Worktree: `/private/tmp/meetro-server-emergency-job-foundation-20260919`
Branch: `feature/emergency-start-work-gate-20260919`
Certified base: `79a7959f3cdd83f2b901ad132cc14a6dfadf5e28`

## Migration 103

[202609190003_generalize_emergency_pre_work_authority.sql](/private/tmp/meetro-server-emergency-job-foundation-20260919/migrations/202609190003_generalize_emergency_pre_work_authority.sql)

SHA-256: `2706a13c9fe418383b67d7e1d56cea4ab181b81c11d2e1feff9003bc2f1fbf8a`

Exactly one migration was added. Migrations 101 and 102 retain their certified
SHA-256 values. Migration 103 adds explicit Emergency Meetro-customer obligation
shape, strict Emergency Job/relationship/profile origin guards, and read-only
historical validation. All pre-existing deposit/payment foreign keys and the
four existing origin branches are preserved. No new tables were created.
The repository inventory and latest-generation assertions now identify 103.

## Implemented behavior

- Emergency Quote delivery uses the exact active selection relationship and
  conversation, homeowner, selected professional, and emergency_selection
  participants. Its safe title/service snapshot comes from emergency_requests.
- The exact homeowner can read, approve, or decline an issued, delivered Quote.
  The canonical customer decision produces MEETRO_CUSTOMER approval on approval.
  Emergency cannot use external approval evidence.
- Customer read/approve/decline grants use the existing ordinary bootstrap
  capability list at Job materialization. Sending a valid issued Quote repairs
  missing grants on pre-Task-4 Jobs using selection evidence. Existing grants,
  including revoked grants, are never replaced or reactivated.
- Professional capabilities remain exactly evaluation.perform, participant.read,
  quote.create, quote.issue, quote.read, quote.revise, and quote.scope.manage.
  Homeowner capabilities are participant.read, quote.read_customer,
  quote.approve, and quote.decline.
- Emergency approval can materialize the existing canonical pre-work deposit
  obligation and use its existing receipts, allocations, and version ledger.
- Start Work requires selected Emergency authority, confirmed arrival, completed
  exact Evaluation, and exact issued Quote approval/version/hash. It blocks
  absent/declined approval and prevents fallback past a newer issued Quote.
- Canonical NOT_REQUIRED permits work. REQUIRED needs an existing SATISFIED
  obligation; missing, DUE, and PARTIALLY_SATISFIED remain blocked. UNVERIFIED
  terms remain blocked. Failures use Emergency-specific 409 codes.
- The gate runs inside the dispatch transaction before the only permitted
  professional_arrived → work_in_progress update. Existing successful-start
  replay remains idempotent. No Schedule lookup or record is required.
- On the Way, Arrived, and /complete behavior were not changed. No Task 5
  Completion/Invoice authority was added. Ordinary/repeat/external SQL branches
  remain unchanged; separate Emergency loaders enforce the new source identity.

## Validation

| Run | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Focused impacted suites | 172 | 167 | 0 | 5 |
| Dedicated rollback-only PostgreSQL Task 4 suite | 12 | 12 | 0 | 0 |
| Full server suite with Task 4 PostgreSQL enabled | 2872 | 2798 | 0 | 74 |

The full run includes the 12 Task 4 PostgreSQL tests; counts are not additive.
Skipped tests are opt-in suites without their separate database/configuration
inputs. An earlier sandboxed full run had four maintenance-bridge socket EPERM
failures; rerunning with local socket access resolved all four without changes
to those tests or application code.

Focused command:

```sh
node --test test/emergencyDispatch*.test.js test/emergencyJob*.test.js test/quoteDelivery*.test.js test/quoteCustomerDeliveryAuthority.test.js test/quoteDecisionHandoff.test.js test/quoteDraftService.test.js test/preWorkDeposit*.test.js test/threePathPreWorkDeposit*.test.js test/threePathRepeatMeetroQuoteDecision.test.js test/emergencyPreWorkAuthorityMigration.test.js test/migrationInventoryGovernance.test.js
```

Dedicated PostgreSQL command:

```sh
NODE_ENV=test EMERGENCY_TASK4_DATABASE_URL=postgresql://127.0.0.1:55439/meetro_test_emergency_task4 node --test test/emergencyTask4Postgres.test.js
```

Full command:

```sh
NODE_ENV=test EMERGENCY_TASK4_DATABASE_URL=postgresql://127.0.0.1:55439/meetro_test_emergency_task4 npm test
```

PostgreSQL validation applied all 103 migrations inside one outer transaction.
Runtime service transactions were mapped to savepoints. Tests exercised actual
Evaluation/Quote/approval/deposit/payment/dispatch services, source rejection,
revoked authority, origin guards, historical verification, and unchanged foreign
keys. The outer transaction rolled back and verified that the jobs table no
longer existed. The isolated test database was dropped, its PostgreSQL server
stopped, and only its task-created temporary cluster removed. No test data was
retained. No Railway, staging, or production database was accessed.

`git diff --check`: PASS (no output).

## Exact files modified or added

- [migrations/README.md](/private/tmp/meetro-server-emergency-job-foundation-20260919/migrations/README.md)
- [server/authorization/quoteDeliveryService.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/server/authorization/quoteDeliveryService.js)
- [server/authorization/quoteDraftService.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/server/authorization/quoteDraftService.js)
- [server/emergency/emergencyDispatchService.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/server/emergency/emergencyDispatchService.js)
- [server/emergency/emergencyJobFoundationService.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/server/emergency/emergencyJobFoundationService.js)
- [server/finance/preWorkDepositService.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/server/finance/preWorkDepositService.js)
- [test/approvedWorkVisitActivationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/approvedWorkVisitActivationMigration.test.js)
- [test/askMeetroWorkflowMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/askMeetroWorkflowMigration.test.js)
- [test/businessContactMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/businessContactMigration.test.js)
- [test/businessCustomerRelationshipMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/businessCustomerRelationshipMigration.test.js)
- [test/businessPortfolioAuthorityMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/businessPortfolioAuthorityMigration.test.js)
- [test/customerPartyMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/customerPartyMigration.test.js)
- [test/efrActivationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/efrActivationMigration.test.js)
- [test/emergencyDispatchService.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/emergencyDispatchService.test.js)
- [test/emergencyJobEvaluationQuoteRuntimeBridge.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/emergencyJobEvaluationQuoteRuntimeBridge.test.js)
- [test/emergencyJobFoundationService.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/emergencyJobFoundationService.test.js)
- [test/evaluationVisitActivationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/evaluationVisitActivationMigration.test.js)
- [test/evaluationVisitAuthorityNegotiationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/evaluationVisitAuthorityNegotiationMigration.test.js)
- [test/invoicePaymentMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/invoicePaymentMigration.test.js)
- [test/jobCompletionMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/jobCompletionMigration.test.js)
- [test/migrationInventoryGovernance.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/migrationInventoryGovernance.test.js)
- [test/preWorkDepositPaymentMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/preWorkDepositPaymentMigration.test.js)
- [test/quickQuoteAnalysisContinuationReviewMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/quickQuoteAnalysisContinuationReviewMigration.test.js)
- [test/quickQuotePhotoAssistReviewMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/quickQuotePhotoAssistReviewMigration.test.js)
- [test/quoteBusinessDocumentBridgeMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/quoteBusinessDocumentBridgeMigration.test.js)
- [test/quoteCompositionFeedbackMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/quoteCompositionFeedbackMigration.test.js)
- [test/quoteCustomerTermsMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/quoteCustomerTermsMigration.test.js)
- [test/quoteDeliveryMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/quoteDeliveryMigration.test.js)
- [test/quoteFoundationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/quoteFoundationMigration.test.js)
- [test/recommendationFoundationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/recommendationFoundationMigration.test.js)
- [test/visitFoundationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/visitFoundationMigration.test.js)
- [test/visitStartAuthorityMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/visitStartAuthorityMigration.test.js)
- [test/workPlanActivationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/workPlanActivationMigration.test.js)
- [test/workstreamFoundationMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/workstreamFoundationMigration.test.js)
- [docs/emergency-task4-validation.md](/private/tmp/meetro-server-emergency-job-foundation-20260919/docs/emergency-task4-validation.md)
- [migrations/202609190003_generalize_emergency_pre_work_authority.sql](/private/tmp/meetro-server-emergency-job-foundation-20260919/migrations/202609190003_generalize_emergency_pre_work_authority.sql)
- [server/emergency/emergencyCommercialContext.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/server/emergency/emergencyCommercialContext.js)
- [server/emergency/emergencyStartWorkGate.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/server/emergency/emergencyStartWorkGate.js)
- [test/emergencyPreWorkAuthorityMigration.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/emergencyPreWorkAuthorityMigration.test.js)
- [test/emergencyTask4Postgres.test.js](/private/tmp/meetro-server-emergency-job-foundation-20260919/test/emergencyTask4Postgres.test.js)

Most existing migration test changes only advance the expected last filename or
count from generation 102 to 103. Emergency dispatch/foundation tests were
updated for the new gate and homeowner-only customer grants.

## git status --short

```text
 M migrations/README.md
 M server/authorization/quoteDeliveryService.js
 M server/authorization/quoteDraftService.js
 M server/emergency/emergencyDispatchService.js
 M server/emergency/emergencyJobFoundationService.js
 M server/finance/preWorkDepositService.js
 M test/approvedWorkVisitActivationMigration.test.js
 M test/askMeetroWorkflowMigration.test.js
 M test/businessContactMigration.test.js
 M test/businessCustomerRelationshipMigration.test.js
 M test/businessPortfolioAuthorityMigration.test.js
 M test/customerPartyMigration.test.js
 M test/efrActivationMigration.test.js
 M test/emergencyDispatchService.test.js
 M test/emergencyJobEvaluationQuoteRuntimeBridge.test.js
 M test/emergencyJobFoundationService.test.js
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
?? docs/emergency-task4-validation.md
?? migrations/202609190003_generalize_emergency_pre_work_authority.sql
?? server/emergency/emergencyCommercialContext.js
?? server/emergency/emergencyStartWorkGate.js
?? test/emergencyPreWorkAuthorityMigration.test.js
?? test/emergencyTask4Postgres.test.js
```

## Remaining blockers

None for the authorized implementation and local validation. Migration 103 has
not been applied to staging or production. No commit, push, deployment, or
protected-checkout modification was performed.
