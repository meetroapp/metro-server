# Emergency Work Center read bridge — PostgreSQL certification

**EMERGENCY WORK CENTER READ BRIDGE — POSTGRESQL CERTIFIED**

The corrected candidate is the commit containing this report on `codex/emergency-work-center-read-bridge`. Its exact SHA is recorded in the final task response and the local certification evidence. This certifies the server bridge; it is not deployment approval or completed client/device QA.

## Candidate and repair

The initial freeze confirmed clean candidate `21583b405807907db146c3cdbf7e228d69de7da8` with exact parent `4acf378e71b9d91dae90b89f09844b1fa051198a`. The original candidate failed real PostgreSQL certification and is superseded.

The defect was in `loadEmergencyLiveState`: it called `listDraftQuotesByJob` during Assigned and On the Way. That certified Quote reader requires confirmed arrival and returned `QUOTE_UNAVAILABLE`, blocking the dispatch read. The repair defers that Quote read until `arrived_at` is present and dispatch is `professional_arrived`, `work_in_progress`, or `completed`. It preserves the certified Quote authority and does not change mutations, migrations, or other sources.

The PostgreSQL suite now also checks exact picker/live-state/History identity, malformed relationships, complete preserved-record flags, all paid amounts, and ordinary Job Request regression. Zero-fabrication counts begin before Emergency selection, covering the entire Emergency lifecycle. The ordinary regression uses the existing request/response/selection fixture services. Its savepoint facade resets deferred constraints at each simulated BEGIN because an ordinary command makes them immediate before COMMIT; real new transactions reset this mode automatically. This was a harness correction, not a production change.

## Disposable database and governed migrations

- Database: `meetro_test_emergency_work_center_read_bridge`.
- Host: existing local PostgreSQL at `127.0.0.1:5432`.
- Safety: repository `assertSafeTestDatabaseUrl`, `inspectTemporaryDatabaseName`, migration target guards, and `createCleanupPlan`.
- The database was newly created and empty. No staging or production database was accessed.
- Runner: `scripts/run-migrations.js`, with `NODE_ENV=test`, `MIGRATION_TARGET=local-test`, `CONFIRM_MIGRATION_TARGET=local-test`, `PGSSLMODE=disable`, and the disposable URL in `DATABASE_URL`.
- Result: 104 applied, 0 skipped, 0 failed. No fabricated ledger entries.
- Ledger: exactly 104 entries; every checksum matches the corresponding file; every execution target is `local-test`.
- Migration 104: `202609190004_generalize_emergency_completion_invoice_history.sql`, SHA-256 `d5e4df95299ae55f2b6bd46c47a91e9c1f828f11404d03d932a12f021cda29a3`.
- All 104 migration files remain byte-for-byte identical to the frozen candidate and certified parent. Migration 105 is absent.

## Verified PostgreSQL behavior

The dedicated suite invokes actual services against PostgreSQL, with fixtures and service commands wrapped in an outer rollback. It does not apply migrations itself.

| Assertion | Result |
| --- | --- |
| Selected professional discovers exact Emergency Job, relationship, request, customer and explicit source | PASS |
| Outsider, inactive relationship, mismatched homeowner relationship fail closed | PASS |
| Assigned → On the Way → Arrived/Evaluation Required → Evaluation In Progress → Quote Required | PASS |
| Awaiting Approval → Deposit Required → partial deposit → Ready to Start → Work In Progress | PASS |
| Ready to Invoice → Final Invoice → Partially Paid → Paid | PASS |
| Exact live-state Job, Emergency Request, relationship, conversation, title, customer; ordinary request ID null | PASS |
| Emergency Invoice workspace ready and Invoice rows expose explicit source | PASS |
| Approved total 10000; deposit credit 5000; balance 5000; final paid 10000 and balance 0 | PASS |
| Professional and homeowner History preserve exact identity, title, null ordinary request and approved amount | PASS |
| History preserves Evaluation, findings, recommendations, approved Quotes; Visits and Work Plan false | PASS |
| Ordinary Job Request picker contract and live-state read with canonical request ID | PASS |
| Emergency creates zero posts, selections, canonical Visits and canonical Workstreams | PASS |
| No Schedule, Visit, Work Plan or Workstream prerequisite | PASS |

The eight PostgreSQL tests comprise seven lifecycle/regression subtests and their parent test. No PostgreSQL bridge test was skipped.

## Test totals

| Run | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Dedicated bridge PostgreSQL | 8 | 8 | 0 | 0 |
| Focused regression with bridge PostgreSQL enabled | 406 | 397 | 0 | 9 |
| Full server suite with bridge PostgreSQL enabled | 2911 | 2835 | 0 | 76 |

Other optional database suites, including separate Task 4/5 suites, were not enabled and are not claimed as executed in this certification. The actual Emergency dispatch, Evaluation, Quote, deposit, completion, Invoice and History services were exercised by the bridge suite. The previously established suites were rerun only because the production bridge code changed.

All three commands used `NODE_ENV=test` and `EMERGENCY_BRIDGE_DATABASE_URL=postgresql://127.0.0.1:5432/meetro_test_emergency_work_center_read_bridge`:

```sh
node --test test/emergencyWorkCenterBridgePostgres.test.js

node --test test/professionalJobPicker*.test.js test/liveJob*.test.js test/emergency*.test.js test/jobCompletion*.test.js test/invoicePayment*.test.js test/preWorkDeposit*.test.js test/businessCustomerInvoiceAuthorityRuntime.test.js test/migrationInventoryGovernance.test.js

npm test
```

## Cleanup and integrity

Before dropping the database, independent queries confirmed zero retained rows in users, Jobs, Emergency Requests, posts, selections, canonical Visits, Workstreams, Quotes, Invoices and completion records. `DROP DATABASE` succeeded. A subsequent `pg_database` query returned **0** matching databases.

No container or PostgreSQL server was started for this task. The pre-existing local server remains running. The preserved client worktree's tracked and untracked file contents match the pre-test SHA-256 snapshot. GitHub staging was checked read-only before and after testing and remains `4acf378e71b9d91dae90b89f09844b1fa051198a`. No candidate push, deployment, staging database access or production access occurred. `git diff --check` passed; the corrected candidate is committed with a clean worktree.

Local evidence directory: `/private/tmp/meetro-emergency-bridge-certification/`.

- `migrations-before.json` / `migrations-after.json`: all 104 migration file hashes.
- `migrations.log`: governed runner result.
- `database-evidence.json`: full migration ledger and post-rollback row counts.
- `bridge-postgres.log`, `focused.log`, `full.log`: final passing test output.
- `client-before.json`: preserved client file hashes.
- `final-integrity.json`: corrected candidate SHA and final integrity checks.

The existing client worktree remains untouched. Client live integration and device QA can proceed in their separately authorized task.
