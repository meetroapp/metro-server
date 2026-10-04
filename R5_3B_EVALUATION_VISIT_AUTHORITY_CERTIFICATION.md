# R5.3B — Evaluation Visit authority correction

The isolated server now resolves the missing Evaluation Visit capabilities for an authorized, active, selected Job that already has Evaluation authority but predates the Visit capability bootstrap. The same local PostgreSQL Job returned **403 VISIT_AUTHORITY_REQUIRED before** and **200 / visits: [] / actions.canPropose: true after**. The unchanged R5.3 client validator accepted the corrected server result.

This certifies the isolated implementation and local regression. No staging deployment or physical-device retest was performed. The supplied staging response confirms the denial code; it does not disclose the affected records' grant rows. The missing-bootstrap condition is reproduced and proven locally, not asserted as a database inspection of those staging records.

## Request path and root cause

1. `server/workflow/visits.js` registers authenticated GET `/jobs/:jobId/visits` and POST on the same path. Its handlers use `req.user` and the path Job ID, not body-supplied actor/business authority.
2. `visitService.listVisits` validates the actor and UUID, then calls `authorizeRead` before querying Visit rows.
3. `requireActorRole` loads the exact Job, selected relationship, participant, active role and professional identity. Role denial emits `VISIT_AUTHORITY_REQUIRED`. Unknown or inaccessible Job context preserves the existing privacy-safe 404.
4. `authorizeRead` also emits HTTP 403 `VISIT_AUTHORITY_REQUIRED`, message `Visit authority is required.`, when the context lacks an applicable Visit read capability.
5. Previously, active `evaluation.perform` authority was not resolved into the bounded Evaluation Visit capabilities at this boundary. Older selected Jobs can have that Evaluation grant without the later `evaluation_visit` grants. The existing migration explicitly performs no grant backfill. POST likewise required the missing Visit proposal capability.

**Zero Visits did not itself trigger a denial.** The read failed before row enumeration. A valid empty collection was inaccessible because the capability resolver depended solely on separately materialized Visit grants. This is the gap fixed here; no existing Evaluation or Visit is now required to resolve that Job's Evaluation Visit workspace.

## Before and after authorization

Before: exact role/Job authorization **plus** an active explicit Visit read/propose grant.

After: existing explicit authority remains effective. For a selected ordinary-request Job without any prior actor-specific Job/Evaluation/Evaluation-Visit grants, the Visit boundary may additionally resolve the existing role-specific Evaluation Visit matrix from all of:

- Lifecycle-v2 Job, exact active selected relationship and uncancelled request.
- The relationship's professional matches the owning contractor profile.
- Exact professional/customer participants with active, unrevoked primary-professional and customer-representative roles.
- An active, unrevoked Job-scoped `evaluation.perform` grant for that professional.
- The requesting participant is one of that exact Job's two participants.

Any prior explicit Visit grant in these scopes suppresses the fallback, including expired/revoked grants. It cannot resurrect withdrawn Visit access. The resolver performs SELECTs only; no grant or workflow row is created during reads. Completed Jobs and completed Evaluations cannot receive a new Evaluation Visit proposal. Job history remains readable under valid read authority.

The derived capabilities are consumed only for EVALUATION. They cannot authorize FOLLOW_UP or APPROVED_WORK. Approved Work still requires its own exact approved Quote authority and its existing deposit gate. No payment/deposit calculation or command changed. Business-document Jobs do not receive invented Evaluation authority: this correction requires the existing selected-Job Evaluation prerequisites, rather than assuming that all business-owned Jobs have them.

Mutual confirmation, alternate-time negotiation, optimistic Visit versioning, Start state/timing checks, Evaluation creation/completion, Quote gating and address projection retain their existing owners. The Schedule service consumes the same resolver so missing-bootstrap Jobs and their resulting Visits appear in the existing Schedule and history projections.

## Exact R5.3B changes

Server production files (3; within the five-file limit):

- `server/workflow/jobEvaluationVisitAuthority.js` — shared, read-only Job Evaluation Visit resolution and SQL predicate.
- `server/workflow/visitService.js` — consume the resolution in reads, action projection and Evaluation commands; block new proposals after Job/Evaluation completion.
- `server/workflow/professionalScheduleService.js` — use the same resolution for Evaluation scheduling opportunities and Visit/history reads.

Test added:

- `test/jobEvaluationVisitAuthorityPostgres.test.js` — 16 subtests plus its parent, all passing against real local PostgreSQL. Covers empty authenticated GET, no grant writes, no Evaluation prerequisite, first proposal, wrong professional/business, malformed/unknown Job, purpose separation, opposite-party confirmation, alternate time, stale version, professional-only Start, onsite Evaluation creation, exact history, closed Job, revoked Visit/Evaluation grants and participant roles, and unpaid/paid Approved Work.

The historical fixture uses real request/selection/foundation services, with only the optional bootstrap capability-registration result representing the pre-Visit condition. It does not delete grants or disable database guards. The closed-Job case seeds a completion record as a test fixture; it does not change the completion command. Unrelated inaccessible Jobs retain 404 instead of revealing their existence; known participant-role denials return 403.

Client files changed in R5.3B: **none**. The existing R5.3 `canPropose` validation, rendered Evaluation-accordion regressions and localized denial wording remain intact.

## Validation

- Focused server Visit/Evaluation/authority/Schedule files: **199 passed, 0 failed, 25 skipped, 224 total** in the default configuration.
- New PostgreSQL regression separately enabled: **17 passed, 0 failed, 0 skipped**.
- Full server suite with the new PostgreSQL regression enabled: **2397 passed, 0 failed, 70 skipped, 2467 total**. Prior baseline: 2380 passed / 70 skipped / 2450 total. Other optional database suites retain their existing skips.
- Original-versus-corrected proof on the same PostgreSQL fixture: original 403; corrected 200 with empty Visits and true proposal action. Actual corrected result passed through the R5.3 client projection successfully. Evidence: `/private/tmp/meetro-r53b-proof.log`.
- Focused client: **220/220 passed**.
- Full client final run: **4930/4930 passed**. First concurrent run had one Ask Meetro close-transition assertion failure (4929/4930); its entire test file passed independently (42/42), then the full suite passed without edits.
- `npm run build:staging`: **passed**, with the existing large-chunk advisory.
- `git diff --check`: **passed** in both candidates.

The missing server dependencies were installed from the existing lockfile using offline npm ci. Local PostgreSQL tests used a clone of the existing release fixture database; no migration was authored or run.

No protected original or outer wrapper was edited. No commit, push, deploy, reset, clean, stash, migration or iOS build was performed. Staging behavior must be checked after an independently authorized deployment; this task did not change the running backend.
