"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitApprovedDecision,
  createVisitEvaluation,
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  createVisitWorkstream,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  activateApprovedWorkVisitAuthority,
  getApprovedWorkVisitAuthority,
} = require("../server/workflow/approvedWorkVisitService");
const {
  cancelVisit,
  completeVisit,
  confirmVisit,
  listVisits,
  proposeVisit,
  requestVisitChange,
  rescheduleVisit,
} = require("../server/workflow/visitService");
const {
  addDraftScopeItem,
  createDraftQuote,
  declineIssuedQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.APPROVED_WORK_VISIT_DATABASE_URL;
const upgradeDatabaseUrl = process.env.APPROVED_WORK_VISIT_UPGRADE_DATABASE_URL;

function targetMetadata(url = databaseUrl) {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV }),
  };
}

function authorityCommand(pool, actorId, fixture, decision, key = randomUUID()) {
  return activateApprovedWorkVisitAuthority({
    pool,
    authenticatedActor: { id: actorId },
    jobId: fixture.jobId,
    quoteId: decision.quote_id,
    idempotencyKey: key,
    logger: quiet,
  });
}

function visitCommand(service, pool, actorId, values, key = randomUUID(), clock) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey: key,
    logger: quiet,
    clock: clock || (() => new Date("2026-08-13T12:00:00.000Z")),
    ...values,
  });
}

function quoteCommand(service, pool, actorId, values, key) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey: key,
    logger: quiet,
    ...values,
  });
}

function proposal(fixture, decision, workstreamIds = [], hour = 13) {
  return {
    jobId: fixture.jobId,
    purpose: "APPROVED_WORK",
    approvedQuoteDecisionId: decision.id,
    workstreamIds,
    scheduledStartAt: `2026-08-20T${String(hour).padStart(2, "0")}:00:00.000Z`,
    scheduledEndAt: `2026-08-20T${String(hour + 1).padStart(2, "0")}:00:00.000Z`,
    timeZone: "America/New_York",
    locationMode: "JOB_SERVICE_LOCATION",
  };
}

async function createIssuedQuote(pool, identities, fixture, suffix) {
  const created = await quoteCommand(
    createDraftQuote,
    pool,
    identities.professionalId,
    { jobId: fixture.jobId, currency: "USD" },
    `approved-work-pending-create-${suffix}`
  );
  assert.equal(created.ok, true, created.code);
  const scoped = await quoteCommand(
    addDraftScopeItem,
    pool,
    identities.professionalId,
    {
      quoteId: created.quote.id,
      expectedVersion: created.quote.currentVersion,
      item: {
        classification: "LABOR_SERVICE",
        scopeSemantic: "FUTURE_WORK",
        materialResponsibility: "NOT_APPLICABLE",
        description: "Synthetic Approved Work activation eligibility",
        quantity: 1,
        unitAmountMinor: 12500,
        source: { type: "MANUAL_PROFESSIONAL" },
      },
    },
    `approved-work-pending-scope-${suffix}`
  );
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await quoteCommand(
    issueQuote,
    pool,
    identities.professionalId,
    {
      quoteId: scoped.quote.id,
      expectedVersion: scoped.quote.currentVersion,
    },
    `approved-work-pending-issue-${suffix}`
  );
  assert.equal(issued.ok, true, issued.code);
  return issued.quote;
}

async function adjacentTruth(pool, fixture, evaluation, decision, workstream) {
  const result = await pool.query(
    `SELECT
       (SELECT status FROM canonical_evaluations WHERE id = $1) AS evaluation_status,
       (SELECT count(*)::integer FROM canonical_evaluation_findings
         WHERE evaluation_id = $1) AS findings,
       (SELECT count(*)::integer FROM canonical_recommendations
         WHERE evaluation_id = $1) AS recommendations,
       (SELECT decision FROM canonical_quote_customer_decisions WHERE id = $2)
         AS quote_decision,
       (SELECT status FROM canonical_quotes WHERE id = $3) AS quote_status,
       (SELECT state FROM canonical_workstream_versions
         WHERE workstream_id = $4 ORDER BY version DESC LIMIT 1) AS workstream_state,
       (SELECT count(*)::integer FROM canonical_work_activities WHERE job_id = $5)
         AS activities,
       (SELECT cancelled_at FROM posts WHERE id = $6) AS request_cancelled_at,
       (SELECT status FROM request_relationships
         WHERE id = jobs.source_request_relationship_id) AS relationship_status,
       jobs.lifecycle_contract_version
     FROM jobs WHERE jobs.id = $5`,
    [
      evaluation.id,
      decision.id,
      decision.quote_id,
      workstream.id,
      fixture.jobId,
      fixture.requestId,
    ]
  );
  return result.rows[0];
}

test(
  "disposable PostgreSQL certifies exact Approved Work Visit activation and separation",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 44);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true);
      assert.equal(migrated.applied.length, 44);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-a`);
      const crossFixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-b`);
      const pendingFixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-pending`);
      const declinedFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-declined`
      );
      const evaluation = await createVisitEvaluation(pool, identities, fixture, `${suffix}-a`);
      const workstream = await createVisitWorkstream(pool, identities, fixture, suffix, 1);
      const decision = await createVisitApprovedDecision(pool, identities, fixture, `${suffix}-a`);
      const crossDecision = await createVisitApprovedDecision(
        pool,
        identities,
        crossFixture,
        `${suffix}-b`
      );
      const pendingQuote = await createIssuedQuote(
        pool,
        identities,
        pendingFixture,
        `${suffix}-pending`
      );
      const declinedQuote = await createIssuedQuote(
        pool,
        identities,
        declinedFixture,
        `${suffix}-declined`
      );
      const declined = await quoteCommand(
        declineIssuedQuote,
        pool,
        identities.homeownerId,
        {
          quoteId: declinedQuote.id,
          expectedIssuedVersion: declinedQuote.currentVersion,
        },
        `approved-work-decline-${suffix}`
      );
      assert.equal(declined.customerDecision.decision, "DECLINED");
      const before = await adjacentTruth(pool, fixture, evaluation, decision, workstream);

      const noAutomaticAuthority = await pool.query(
        `SELECT
          (SELECT count(*)::integer FROM lifecycle_authority_grants
            WHERE job_id = $1 AND scope_type = 'approved_work') AS grants,
          (SELECT count(*)::integer
            FROM canonical_approved_work_visit_authority_activations
            WHERE job_id = $1) AS activations,
          (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visits`,
        [fixture.jobId]
      );
      assert.deepEqual(noAutomaticAuthority.rows[0], {
        grants: 0,
        activations: 0,
        visits: 0,
      });

      const available = await getApprovedWorkVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        quoteId: decision.quote_id,
        logger: quiet,
      });
      assert.equal(available.code, "APPROVED_WORK_VISIT_AUTHORITY_AVAILABLE");
      assert.equal(available.authority.actions.canActivate, true);

      for (const ineligible of [
        { fixture: pendingFixture, quote: pendingQuote },
        { fixture: declinedFixture, quote: declinedQuote },
      ]) {
        const unavailable = await getApprovedWorkVisitAuthority({
          pool,
          authenticatedActor: { id: identities.professionalId },
          jobId: ineligible.fixture.jobId,
          quoteId: ineligible.quote.id,
          logger: quiet,
        });
        assert.equal(unavailable.code, "APPROVED_WORK_VISIT_AUTHORITY_UNAVAILABLE");
      }

      const outsider = await authorityCommand(
        pool,
        identities.outsiderId,
        fixture,
        decision
      );
      assert.equal(outsider.code, "APPROVED_WORK_VISIT_AUTHORITY_UNAVAILABLE");
      const customerActivation = await authorityCommand(
        pool,
        identities.homeownerId,
        fixture,
        decision
      );
      assert.equal(
        customerActivation.code,
        "APPROVED_WORK_VISIT_AUTHORITY_UNAVAILABLE"
      );
      const wrongJob = await authorityCommand(
        pool,
        identities.professionalId,
        fixture,
        crossDecision
      );
      assert.equal(wrongJob.code, "APPROVED_WORK_VISIT_AUTHORITY_UNAVAILABLE");

      const activationKey = randomUUID();
      const activated = await authorityCommand(
        pool,
        identities.professionalId,
        fixture,
        decision,
        activationKey
      );
      assert.equal(activated.code, "APPROVED_WORK_VISIT_AUTHORITY_ACTIVATED");
      assert.equal(activated.authority.state, "ACTIVE");
      assert.equal(activated.authority.customerCapabilities.length, 3);
      assert.equal(activated.authority.professionalCapabilities.length, 5);
      const replayed = await authorityCommand(
        pool,
        identities.professionalId,
        fixture,
        decision,
        activationKey
      );
      assert.equal(replayed.replayed, true);

      const grants = await pool.query(
        `SELECT grants.grantee_participant_id, grants.capability,
          grants.scope_type, grants.scope_job_id, grants.scope_concern_id,
          grants.scope_evaluation_id, grants.scope_approved_quote_decision_id,
          grants.scope_approved_quote_decision
         FROM lifecycle_authority_grants grants
         WHERE grants.job_id = $1 AND grants.source_evidence_type = $2
         ORDER BY grants.grantee_participant_id, grants.capability`,
        [fixture.jobId, "approved_work_visit_activation"]
      );
      assert.equal(grants.rows.length, 8);
      assert.equal(grants.rows.every((row) => row.scope_type === "approved_work"), true);
      assert.equal(
        grants.rows.every((row) =>
          row.scope_job_id === fixture.jobId &&
          row.scope_concern_id === null &&
          row.scope_evaluation_id === null &&
          row.scope_approved_quote_decision_id === decision.id &&
          row.scope_approved_quote_decision === "APPROVED"
        ),
        true
      );

      const rejectedEvaluation = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        {
          ...proposal(fixture, decision),
          purpose: "EVALUATION",
          evaluationId: evaluation.id,
          approvedQuoteDecisionId: null,
        }
      );
      assert.equal(rejectedEvaluation.code, "VISIT_AUTHORITY_REQUIRED");
      const rejectedFollowUp = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        {
          ...proposal(fixture, decision),
          purpose: "FOLLOW_UP",
          approvedQuoteDecisionId: null,
        }
      );
      assert.equal(rejectedFollowUp.code, "VISIT_AUTHORITY_REQUIRED");
      const crossSubject = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(fixture, crossDecision)
      );
      assert.equal(crossSubject.code, "VISIT_AUTHORITY_REQUIRED");
      const customerProposal = await visitCommand(
        proposeVisit,
        pool,
        identities.homeownerId,
        proposal(fixture, decision)
      );
      assert.equal(customerProposal.code, "VISIT_AUTHORITY_REQUIRED");

      const first = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(fixture, decision, [workstream.id], 13)
      );
      const second = await visitCommand(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(fixture, decision, [], 16)
      );
      assert.equal(first.code, "VISIT_PROPOSED");
      assert.equal(second.code, "VISIT_PROPOSED");
      assert.notEqual(first.visit.id, second.visit.id);
      assert.deepEqual(first.visit.workstreamIds, [workstream.id]);

      const professionalConfirm = await visitCommand(
        confirmVisit,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId, visitId: first.visit.id, expectedVersion: 1 }
      );
      assert.equal(professionalConfirm.code, "VISIT_AUTHORITY_REQUIRED");
      const customerConfirm = await visitCommand(
        confirmVisit,
        pool,
        identities.homeownerId,
        { jobId: fixture.jobId, visitId: first.visit.id, expectedVersion: 1 }
      );
      assert.equal(customerConfirm.code, "VISIT_CONFIRMED");

      const change = await visitCommand(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: fixture.jobId,
          visitId: first.visit.id,
          expectedVersion: 2,
          reason: "Please use a different approved-work Visit time; scope is unchanged.",
        }
      );
      assert.equal(change.code, "VISIT_CHANGE_REQUESTED");
      assert.equal(change.visit.currentVersion, 2);
      assert.equal(change.visit.scheduledStartAt, first.visit.scheduledStartAt);

      const rescheduled = await visitCommand(
        rescheduleVisit,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          visitId: first.visit.id,
          expectedVersion: 2,
          scheduledStartAt: "2026-08-21T14:00:00.000Z",
          scheduledEndAt: "2026-08-21T15:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
          reason: "Customer timing request accepted.",
        }
      );
      assert.equal(rescheduled.code, "VISIT_RESCHEDULED");
      const cancelled = await visitCommand(
        cancelVisit,
        pool,
        identities.professionalId,
        {
          jobId: fixture.jobId,
          visitId: second.visit.id,
          expectedVersion: 1,
          reason: "Synthetic second-Visit cancellation.",
        }
      );
      assert.equal(cancelled.code, "VISIT_CANCELLED");
      const completed = await visitCommand(
        completeVisit,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId, visitId: first.visit.id, expectedVersion: 3 },
        randomUUID(),
        () => new Date("2026-08-21T16:00:00.000Z")
      );
      assert.equal(completed.code, "VISIT_COMPLETED");

      const readable = await listVisits({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
        logger: quiet,
      });
      assert.equal(readable.code, "VISITS_FOUND");
      assert.equal(readable.visits.length, 2);
      assert.equal(readable.visits.every((visit) => visit.purpose === "APPROVED_WORK"), true);

      const after = await adjacentTruth(pool, fixture, evaluation, decision, workstream);
      assert.deepEqual(after, before);
      const history = await pool.query(
        `SELECT
          (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visits,
          (SELECT count(*)::integer FROM canonical_visit_versions WHERE job_id = $1) AS versions,
          (SELECT count(*)::integer FROM canonical_visit_events WHERE job_id = $1) AS events,
          (SELECT count(*)::integer FROM canonical_visit_workstream_links WHERE job_id = $1) AS links,
          (SELECT count(*)::integer FROM canonical_approved_work_visit_authority_activations
            WHERE job_id = $1) AS activations`,
        [fixture.jobId]
      );
      assert.deepEqual(history.rows[0], {
        visits: 2,
        versions: 6,
        events: 7,
        links: 1,
        activations: 1,
      });
    } finally {
      await pool.end();
    }
  }
);

test(
  "staging-equivalent 37 to 38 upgrade preserves truth and activates nothing",
  { skip: !upgradeDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: upgradeDatabaseUrl, max: 8 });
    try {
      const migrations = getMigrationFiles();
      const activationIndex = migrations.findIndex(({ filename }) =>
        filename === "202608130003_activate_approved_work_visit_authority.sql"
      );
      const before002d = migrations.slice(0, activationIndex);
      const activationMigration = migrations[activationIndex];
      assert.equal(before002d.length, 37);
      assert.equal(
        activationMigration.filename,
        "202608130003_activate_approved_work_visit_authority.sql"
      );
      const baseline = await runMigrationCollection(
        pool,
        before002d,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(baseline.success, true);
      assert.equal(baseline.applied.length, 37);
      const before = await pool.query(
        `SELECT
          (SELECT count(*)::integer FROM jobs) AS jobs,
          (SELECT count(*)::integer FROM canonical_quotes) AS quotes,
          (SELECT count(*)::integer FROM canonical_quote_customer_decisions) AS decisions,
          (SELECT count(*)::integer FROM canonical_workstreams) AS workstreams,
          (SELECT count(*)::integer FROM canonical_visits) AS visits,
          (SELECT count(*)::integer FROM lifecycle_authority_grants
            WHERE capability LIKE 'visit.%') AS visit_grants`
      );
      const upgraded = await runMigrationCollection(
        pool,
        [activationMigration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(upgraded.success, true);
      assert.equal(upgraded.applied.length, 1);
      const replay = await runMigrationCollection(
        pool,
        [activationMigration],
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.equal(replay.skipped.length, 1);
      const after = await pool.query(
        `SELECT
          (SELECT count(*)::integer FROM jobs) AS jobs,
          (SELECT count(*)::integer FROM canonical_quotes) AS quotes,
          (SELECT count(*)::integer FROM canonical_quote_customer_decisions) AS decisions,
          (SELECT count(*)::integer FROM canonical_workstreams) AS workstreams,
          (SELECT count(*)::integer FROM canonical_visits) AS visits,
          (SELECT count(*)::integer FROM lifecycle_authority_grants
            WHERE capability LIKE 'visit.%') AS visit_grants,
          (SELECT count(*)::integer
            FROM canonical_approved_work_visit_authority_activations) AS activations`
      );
      assert.deepEqual(
        Object.fromEntries(Object.entries(after.rows[0]).filter(([key]) => key !== "activations")),
        before.rows[0]
      );
      assert.equal(after.rows[0].activations, 0);
    } finally {
      await pool.end();
    }
  }
);
