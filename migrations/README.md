# Governed Database Migrations

This directory is the ordered source of truth for Meetro backend schema changes.
Migrations are additive, reviewed SQL files; the runner does not provide a
destructive reset path and does not support production execution.

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
11. `202607230001_create_emergency_requests.sql`
12. `202607230002_add_emergency_relationship_source.sql`

README and other non-SQL files are ignored. Malformed SQL migration filenames
cause discovery to fail closed.

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

Production is not an allowed target. There is no production package command,
and production-like target metadata is rejected. Migrations are never run from
application startup, dependency installation, or the normal test command.

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
