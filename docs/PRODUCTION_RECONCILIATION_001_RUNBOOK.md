# MC-PRODUCTION-RECONCILIATION-001 Runbook

This runbook prepares a later, separately authorized production reconciliation.
It does not authorize backup creation, message quarantine, migration execution,
or backend promotion by itself.

## Pre-State

Require all of the following before continuing:

- Backend repository is clean at the reviewed reconciliation commit.
- `origin/main` and `origin/staging` still point to the certified backend SHA
  `6e4d78ed0e3cfe0541ff686198299ec1d850cdf6` unless a later task explicitly
  supersedes it.
- Production backend remains on recovered SHA
  `c4a32b32803ad87dad3fa6d0da0cb1fbebb63452`.
- Production auto-deploy remains disabled.
- Railway target is project `profound-magic`, environment `production`,
  database service `Postgres`, database `railway`.
- Production migration ledger and schema still match the runner's exact
  `EXPECTED_PRESTATE` classification.
- No frontend, staging, CORS, DNS, or unrelated environment change is in scope.

Stop on any mismatch. Do not repair drift interactively.

## Backup Proof Modes

Set exactly one `PRODUCTION_BACKUP_TYPE`:

- `railway_managed`
- `logical_pg_dump`

Missing and unknown modes are rejected. The runner never falls back from one
proof type to the other. Both modes require a backup less than 24 hours old and
a Railway API check proving production backend auto-deploy remains disabled.

### Railway-Managed Backup

For `railway_managed`, create one on-demand backup through Railway's production
`Postgres` volume controls. Wait until the backup is available, verify that a
restore action is visible without invoking it, and record its exact ID,
creation timestamp, expiration timestamp, and volume instance. Set:

```bash
export PRODUCTION_BACKUP_TYPE=railway_managed
export PRODUCTION_BACKUP_ID='<verified Railway backup ID>'
export PRODUCTION_BACKUP_CREATED_AT='<exact ISO-8601 timestamp>'
```

The runner queries Railway and requires that exact backup on the pinned
production volume. Invalid Railway proof cannot use logical proof variables as
a fallback.

### Certified Logical pg_dump

Railway managed backups are unavailable on the current Hobby plan. The
certified alternative is a PostgreSQL custom archive created read-only from the
exact production `Postgres` service. Keep it outside Git and protect both its
directory and file:

```bash
export BACKUP_PATH='/Users/williammolina/MeetroBackups/production/production_<UTC>_railway.dump'
mkdir -p /Users/williammolina/MeetroBackups/production
chmod 700 /Users/williammolina/MeetroBackups/production
railway run --environment production --service Postgres -- \
  /bin/zsh -lc 'umask 077; exec pg_dump --format=custom --no-owner \
  --no-privileges --file="$BACKUP_PATH" "$DATABASE_PUBLIC_URL"'
chmod 600 "$BACKUP_PATH"
pg_restore --list "$BACKUP_PATH"
shasum -a 256 "$BACKUP_PATH"
```

Never print the database URL or archive contents. The currently certified
archive is:

- path: `/Users/williammolina/MeetroBackups/production/production_20260809T014155Z_railway.dump`
- SHA-256: `ae7b7ca8b8676713427eaec5a535f2e440b7ba6e2f8b8b3027a514b0bb29b318`
- completed: `2026-08-09T01:42:32.000Z`
- source and dump version: PostgreSQL `18.4`
- directory mode: `0700`; archive mode: `0600`

Set the proof explicitly:

```bash
export PRODUCTION_BACKUP_TYPE=logical_pg_dump
export PRODUCTION_BACKUP_PATH='/Users/williammolina/MeetroBackups/production/production_20260809T014155Z_railway.dump'
export PRODUCTION_BACKUP_SHA256='ae7b7ca8b8676713427eaec5a535f2e440b7ba6e2f8b8b3027a514b0bb29b318'
export PRODUCTION_BACKUP_CREATED_AT='2026-08-09T01:42:32.000Z'
export PRODUCTION_BACKUP_DATABASE='railway'
export PRODUCTION_BACKUP_PROJECT_ID='10d1facd-6aa6-4052-9897-803396f813c4'
export PRODUCTION_BACKUP_ENVIRONMENT_ID='3554dcb8-3f0a-4b8f-bbdf-162777ad87fa'
export PRODUCTION_BACKUP_POSTGRES_SERVICE_ID='80a103f2-56b3-4b62-a261-51a19169de5b'
export PRODUCTION_BACKUP_VOLUME_ID='240904be-1b53-48f2-9ab8-6681e6d5b0d2'
export PRODUCTION_BACKUP_VOLUME_INSTANCE_ID='d17824c7-8e51-4fcb-b0ed-4efb6e806448'
```

The runner rejects relative, repository-contained, symlinked, insecure,
missing, corrupt, wrong-format, wrong-database, incompatible, stale, or
checksum-mismatched archives. It then performs a fresh complete restore into a
socket-only local database named `meetro_test_*`, verifies counts, table
inventory, catalog fingerprints, migration ledger, orphan fingerprints, and
absence of partial reconciliation markers, and destroys the disposable target.
Cleanup failure blocks production eligibility.

## Message Reconciliation

The only permitted source rows are message IDs `8`, `9`, `10`, and `11` with
the SHA-256 fingerprints pinned in
`scripts/production-reconciliation-manifest.js`.

Inside one database transaction, the runner:

1. acquires a transaction-scoped advisory lock;
2. rechecks the exact ledger, schema, orphan evidence, and fingerprints;
3. creates `legacy_orphan_message_archive` through its pinned migration;
4. locks the four source rows with `FOR UPDATE`;
5. archives each complete original record and its fingerprint;
6. verifies all four archive records and non-authoritative classification;
7. deletes exactly IDs `8`, `9`, `10`, and `11` from `messages`;
8. applies the remaining allowlisted migrations;
9. verifies final schema markers, ledger checksums, archive integrity, and live
   row absence before committing.

Any failure rolls back the archive, deletions, ledger writes, and migrations.
No participant-pair inference or authority reassignment exists in the runner.

## Migration Preflight

Set sensitive values in the operator shell without printing them:

```bash
export RAILWAY_API_TOKEN='<secure Railway API token>'
export NODE_ENV=production
export CONFIRM_PRODUCTION_TARGET='profound-magic/production/Postgres/railway'
```

Also export exactly one of the backup proof sets above. PostgreSQL `initdb`,
`pg_ctl`, `createdb`, `dropdb`, and `pg_restore` matching the archive's major
version must be available locally for `logical_pg_dump`.

Run the read-only preflight:

```bash
railway run \
  --project 10d1facd-6aa6-4052-9897-803396f813c4 \
  --environment production \
  --service Postgres \
  --no-local \
  -- node scripts/run-production-reconciliation.js --preflight
```

Require decision `READY`, code
`PRODUCTION_RECONCILIATION_PREFLIGHT_READY`, `mutationStarted: false`, and the
exact 12-entry migration list. Stop on any other result.

## Authorized Migration List

Execution order is deliberately different from filename order:

1. `202608090001_create_legacy_orphan_message_archive.sql`
2. quarantine and verify exact messages `8`, `9`, `10`, `11`
3. `202607210001_add_message_conversation_identity.sql`
4. `202607210002_allow_dual_message_identity.sql`
5. `202608010001_create_commercial_authority_foundation.sql`
6. `202608010002_create_canonical_evaluations.sql`
7. `202608030001_create_conversation_participant_state.sql`
8. `202608030002_create_canonical_alerts.sql`
9. `202608060001_create_professional_response_foundation.sql`
10. `202608060002_create_request_selection_authority.sql`
11. `202608070001_create_job_request_create_command_idempotency.sql`
12. `202608070002_create_intelligence_operation_idempotency.sql`
13. `202608070003_add_job_request_service_location.sql`

The baseline is intentionally excluded and never receives a fabricated ledger
record.

## Execution Command

Only a separately authorized execution task may set these confirmations:

```bash
export CONFIRM_PRODUCTION_RECONCILIATION=YES
export CONFIRM_ORPHAN_POLICY=PRESERVE_AND_QUARANTINE
export CONFIRM_PRODUCTION_RECONCILIATION_CHAIN=archive-then-202607210001-through-202608070003
export CONFIRM_PRODUCTION_MUTATION=EXECUTE
```

After pausing backend traffic, repeat preflight and then run:

```bash
railway run \
  --project 10d1facd-6aa6-4052-9897-803396f813c4 \
  --environment production \
  --service Postgres \
  --no-local \
  -- node scripts/run-production-reconciliation.js --execute
```

Require `APPLIED_AND_VERIFIED`. An already completed replay returns
`ALREADY_APPLIED` with process exit code `2` and performs no mutation.

## Post-Migration Schema Verification

Before resuming traffic or promoting backend code:

- rerun `--preflight` and require `ALREADY_APPLIED`;
- verify all 26 legitimate production ledger entries and checksums;
- verify no baseline ledger entry;
- verify archive IDs and SHA-256 fingerprints are exact;
- verify the four IDs are absent from live `messages`;
- verify archive update/delete attempts are rejected;
- verify all expected tables, indexes, constraints, functions, triggers, and
  altered columns are present;
- inspect database and backend logs for `42P01`, `42703`, migration errors, and
  unexpected lock timeouts.

## Backend Promotion

Database convergence must pass before a separately authorized manual Railway
redeploy of exact backend SHA
`6e4d78ed0e3cfe0541ff686198299ec1d850cdf6`. Do not change the production
source branch and do not enable auto-deploy.

After promotion, certify health, authentication, Job Request owner reads,
conversation inbox/detail/messages, alerts, professional opportunities, and
structured-location privacy using only approved read-only production fixtures.

## Log Certification

Require no new `42P01`, `42703`, schema-backed 5xx responses,
`CONVERSATIONS_FETCH_FAILED`, `CONVERSATION_MESSAGES_FETCH_FAILED`,
`ALERT_COUNTS_FETCH_FAILED`, or `REQUEST_OPPORTUNITIES_FETCH_FAILED` during the
certification window.

## Rollback / Restore Procedure

- Before transaction commit: any runner failure automatically rolls back all
  reconciliation and migration changes. Keep the recovered backend active.
- After commit but before backend promotion: do not restore automatically.
  Inspect schema and archive verification first; the changes are additive apart
  from the four governed quarantines.
- After backend promotion: redeploy recovered backend SHA `c4a32b3` first if
  application behavior is unsafe. Keep production traffic paused while deciding
  whether database restore is necessary.
- For `railway_managed`, restore only the exact recorded backup through
  Railway's supported workflow under separate incident authorization.
- For `logical_pg_dump`, first repeat restoration into a disposable
  `meetro_test_*` target and reverify its checksum and certified state. A later
  production restore requires a separately authorized, explicitly targeted
  `pg_restore`; this runner never restores into production.
- Account explicitly for all writes after the backup timestamp before either
  recovery path. Never restore automatically.

## Lock and Maintenance Impact

Use a controlled maintenance window with backend traffic paused. Although the
reviewed production tables are small, the chain uses `ALTER TABLE`, constraint
validation, non-concurrent index creation, and trigger installation on
`messages`, `posts`, `request_relationships`, and `conversations`. Those steps
can take table-level locks and block active requests.

## Stop Conditions

Stop immediately if any of the following occurs:

- backup proof type is missing, unknown, stale, expired, or has any identity,
  path, permission, checksum, archive, version, restore, or cleanup failure;
- production auto-deploy is enabled;
- Git, Railway, database, ledger, schema, or orphan fingerprints drift;
- any additional identity-less message appears;
- any archive or migration checksum differs;
- preflight does not return `READY`;
- traffic cannot be paused for the maintenance window;
- execution reports any result other than `APPLIED_AND_VERIFIED` or the
  no-op `ALREADY_APPLIED` replay result;
- postflight or log certification fails.
