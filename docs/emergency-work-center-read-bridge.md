# Emergency Work Center read-contract bridge — implementation report

**Candidate only. Not release-ready. PostgreSQL integration validation remains pending.**

## Git and scope

- Repository: `meetroapp/metro-server`.
- Exact certified base: `4acf378e71b9d91dae90b89f09844b1fa051198a` — `Complete Emergency completion, final invoice, payment, and history lifecycle`.
- Isolated bare repository: `/private/tmp/meetro-emergency-read-bridge.git`.
- Worktree: `/private/tmp/meetro-emergency-read-bridge`.
- Branch: `codex/emergency-work-center-read-bridge`.
- The candidate commit containing this report is a direct child of the certified base; obtain its full SHA with `git rev-parse HEAD` in this worktree.
- No push, deployment, staging mutation, production access, or migration execution.
- Preserved client worktree: `/private/tmp/meetro-professional-emergency-ui`, branch `codex/professional-emergency-work-center`, unchanged HEAD `d6e816c3d9df1e6758c028462b240f48102fc139`. Its uncommitted files were not edited, deleted, reset, staged, or committed.

## Implemented

### Professional Job picker

`GET /professional/jobs` combines the unchanged ordinary selection query with a separate Emergency branch derived directly from `EMERGENCY_LIFECYCLE_CONTEXT_SQL`.

The Emergency branch requires the exact selected professional, active source-shaped relationship and conversation, active/unrevoked professional and customer roles, and the same required picker capabilities. Only selected active dispatch stages without canonical completion are included. It introduces no Post, Request Selection, or alternate authority table.

Emergency rows expose `jobId`, `sourceType = emergency_request`, `sourceLabel = Emergency`, `title`, canonical `serviceDomain`/`serviceSpecialty`, `lifecycleStatus = ACTIVE`, `customerLabel`, exact `relationshipId`, and exact `emergencyRequestId`. City/service area remain null where this Emergency context has no corresponding source fields. Existing normal rows retain their prior values and gain their actual `jobs.source_type` as `sourceType`.

### Emergency live state

`GET /jobs/:jobId/live-state` keeps the existing HTTP wrapper and ordinary projection behavior. If the ordinary source loader finds no Job, a dedicated Emergency branch uses `loadEmergencyLifecycleContext`; it does not treat an Emergency ID as an ordinary request ID.

The branch requires exact source/Job/actor/relationship identity, an active professional role, and canonical `participant.read` / `quote.read` grants. It reuses:

- `listEvaluationsForEmergencyRequest` and the certified `requireEmergencyJobEvaluation` evidence check;
- `listDraftQuotesByJob` and `loadEmergencyQuoteApprovalSource` with `latestIssuedQuote: true`;
- `evaluateApprovedWorkDepositGateWithClient` and the existing deposit projection;
- `loadCompletionReadiness` / `readinessProjection`;
- the existing Emergency Invoice context loader.

These are reads without locks or materialization. Dispatch mutation endpoints are unchanged. External approval cannot satisfy the governed Emergency Quote approval lookup, which requires `MEETRO_CUSTOMER` evidence. A newer issued Quote cannot inherit an older Quote's approval. Drafts do not replace the current issued agreement.

The Emergency response explicitly carries:

- `jobId`, `sourceType`, `sourceLabel`, `requestId: null`, `relationshipId`, `emergencyRequestId`, `conversationId`, `serviceTitle`, `customerLabel`;
- `stage`, `responsibility`, `blocker`, `nextAction`, `availableActions`, `reasonCodes`;
- dispatch status and canonical timestamps;
- Evaluation state, current Quote decision state and approval identifiers;
- canonical deposit amounts/state and `startWorkLocked`;
- canonical Invoice total/paid/balance amounts;
- evidence version/freshness fields.

`nextAction.available` and `availableActions` reflect the current read snapshot. Existing mutations remain authoritative and recheck their gates. No Schedule, Visit, Work Plan, or Workstream requirement is introduced.

| Evidence | Stage code | Primary action code |
| --- | --- | --- |
| Assigned | `ASSIGNED` | `MARK_EN_ROUTE` |
| On the Way | `ON_THE_WAY` | `MARK_ARRIVED` |
| Arrived, no completed Evaluation | `EVALUATION_NEEDED` | `START_EVALUATION` |
| Draft Evaluation | `EVALUATION_IN_PROGRESS` | `EDIT_EVALUATION` |
| Completed Evaluation, no Quote | `QUOTE_NEEDED` | `CREATE_QUOTE` |
| Draft Quote | `QUOTE_DRAFT` | `REVIEW_QUOTE` |
| Issued, awaiting customer decision | `WAITING_FOR_CUSTOMER_DECISION` | `REVIEW_QUOTE` |
| Current issued Quote declined | `QUOTE_DECLINED` | `REVIEW_QUOTE` |
| Required deposit unsatisfied or unverified | `QUOTE_APPROVED_DEPOSIT_DUE` | `VIEW_DEPOSIT` |
| Current approved Quote, completed Evaluation, confirmed arrival, satisfied/no deposit | `WORK_READY` | `START_WORK` |
| Work In Progress | `WORK_IN_PROGRESS` | `COMPLETE_WORK` only when certified completion readiness allows it |
| Canonical completion, no Invoice | `JOB_COMPLETED` (Ready to Invoice) | `CREATE_FINAL_INVOICE` |
| Draft/Sent Invoice | `FINAL_INVOICE` | `VIEW_INVOICE` |
| Partially Paid | `PARTIALLY_PAID` | `VIEW_INVOICE` |
| Paid | `PAID` | `VIEW_JOB_HISTORY` |

Invoice state takes precedence over completion, which takes precedence over active work and earlier commercial stages. Invalid/missing arrival evidence fails closed. Canonical deposit states `NOT_REQUIRED`, `DUE`, `PARTIALLY_SATISFIED`, and `SATISFIED` are preserved; unverified/unavailable/unsupported states present as `UNVERIFIED` and keep Start Work blocked. Scheduling terminology is removed from the Emergency deposit view; monetary arithmetic is still provided by the existing canonical service.

### Invoice and History source identity

Additive `sourceType` comes from `jobs.source_type` in professional Invoice workspace ready rows and Invoice rows, Invoice detail, professional History list/detail, shared customer History detail, and Completion Review. Emergency also receives `sourceLabel = Emergency`.

History enrichment now branches on explicit `source_type`, not on null request fields. Emergency History continues to preserve null ordinary request ID, exact relationship/conversation, approved amount, and `visits: false` / `workPlan: false`. Invoice accounting and durable relationship semantics are unchanged.

This is the server contract bridge. The preserved client must adopt the source-aware contracts and Emergency stage/action codes before release; no client code was changed in this task.

## Validation

| Command | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Focused command below | 399 | 389 | 0 | 10 |
| `npm test` | 2904 | 2827 | 0 | 77 |

Focused command:

```sh
node --test test/professionalJobPicker*.test.js test/liveJob*.test.js test/emergency*.test.js test/jobCompletion*.test.js test/invoicePayment*.test.js test/preWorkDeposit*.test.js test/businessCustomerInvoiceAuthorityRuntime.test.js test/migrationInventoryGovernance.test.js
```

Full command:

```sh
npm test
```

The initial full run failed when the sandbox blocked local HTTP test listeners (`listen EPERM`). The final full run used authorized local socket access and passed with the counts above. No database environment variables were enabled.

Service/unit tests cover all listed stages, capability and completion gating, outsider/invalid context rejection, explicit Emergency picker identity, shared SQL authorization guards, source separation from external Jobs, null ordinary request identity, no scheduling prerequisites, and $100 / $50 credited / $50 due → Paid / $0 balance.

**Skipped coverage is not counted as verified:** the existing Task 4/5 PostgreSQL suites apply migrations, including 104, to an empty database. They were not enabled because rerunning 104 was explicitly prohibited. Other optional database suites also remain skipped. The new `test/emergencyWorkCenterBridgePostgres.test.js` requires an already-migrated disposable local database and never runs migrations or DDL. It uses the existing certified lifecycle fixture and actual services, with an outer rollback, to verify discovery, authorization, dispatch, Evaluation, deposit, completion, Invoice payment, and both histories. It was not executed because no such database was provided.

To run the new integration suite after supplying an authorized already-migrated local test database:

```sh
NODE_ENV=test EMERGENCY_BRIDGE_DATABASE_URL=<disposable-local-test-database-url> node --test test/emergencyWorkCenterBridgePostgres.test.js
```

`git diff --check`: passed. No lint/build/typecheck scripts are configured in this server repository.

Logs:

- `/private/tmp/meetro-emergency-bridge-focused-final.log`
- `/private/tmp/meetro-emergency-bridge-full-final.log`

## Migration and safety evidence

All **104 migration SQL files** were compared as raw bytes with Git objects at the certified base and are identical. Migration 104 SHA-256 remains:

`d5e4df95299ae55f2b6bd46c47a91e9c1f828f11404d03d932a12f021cda29a3`

No migration was applied or reapplied, and no migration 105 exists in this candidate. No certified Emergency mutation rule was changed. Ordinary source queries and stages retain their behavior, apart from additive source metadata. No push, force push, staging deployment, production operation, or protected client edit occurred.

## Changed files

- `server/emergency/emergencyCommercialContext.js`
- `server/emergency/emergencyLiveJobProjection.js`
- `server/workflow/jobSourcePresentation.js`
- `server/workflow/professionalJobPickerService.js`
- `server/workflow/liveJobProjectionService.js`
- `server/workflow/jobCompletionService.js`
- `server/finance/invoicePaymentService.js`
- `test/professionalJobPickerService.test.js`
- `test/invoicePaymentService.test.js`
- `test/helpers/emergencyLifecycleFixture.js` (optional stop at Assigned; existing callers retain arrival behavior)
- `test/emergencyWorkCenterBridge.test.js`
- `test/emergencyWorkCenterBridgePostgres.test.js`
- `docs/emergency-work-center-read-bridge.md`

## Remaining validation

Provide an already-migrated disposable local database (or explicitly authorize the test-only migration exception) to complete real PostgreSQL verification. Until that validation is complete, do not declare the bridge certified or release-ready. Resume the preserved client implementation and device QA only after the bridge is accepted.
