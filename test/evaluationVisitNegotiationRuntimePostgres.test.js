"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  completeEvaluation,
  createOrdinaryJobEvaluation,
  updateEvaluationDraft,
} = require("../server/authorization/evaluationService");
const {
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");
const {
  completeVisit,
  confirmVisit,
  proposeVisit,
  requestVisitChange,
  rescheduleVisit,
} = require("../server/workflow/visitService");
const {
  getProfessionalSchedule,
} = require("../server/workflow/professionalScheduleService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.EVALUATION_VISIT_R3_DATABASE_URL;
const professionalClock = () => new Date("2026-08-26T12:00:00.000Z");
const completionClock = () => new Date("2026-09-04T18:00:00.000Z");

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

function command(service, pool, actorId, values, idempotencyKey, clock = professionalClock) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey,
    logger: quiet,
    clock,
    ...values,
  });
}

function proposal(fixture, values = {}) {
  return {
    jobId: fixture.jobId,
    purpose: "EVALUATION",
    scheduledStartAt: "2026-09-02T14:00:00.000Z",
    scheduledEndAt: "2026-09-02T15:00:00.000Z",
    timeZone: "America/New_York",
    locationMode: "JOB_SERVICE_LOCATION",
    ...values,
  };
}

function evaluationContent(observations) {
  return {
    serviceType: "handyman",
    evaluationContext: "ordinary_job",
    observations,
    measurements: [],
    findings: [],
    diagnosisSummary: "",
    limitations: "",
    scopeRecommendations: [],
    relevantConditions: [],
    supportingMediaReferences: [],
    internalNotes: "",
  };
}

async function lifecycleCounts(pool, jobId) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM canonical_visits
         WHERE job_id = $1)::integer AS visits,
       (SELECT count(*) FROM canonical_visit_versions
         WHERE job_id = $1)::integer AS visit_versions,
       (SELECT count(*) FROM canonical_visit_events
         WHERE job_id = $1)::integer AS visit_events,
       (SELECT count(*) FROM canonical_visit_evaluation_links
         WHERE job_id = $1)::integer AS evaluation_links,
       (SELECT count(*) FROM canonical_evaluation_job_subjects
         WHERE job_id = $1)::integer AS evaluations,
       (SELECT count(*) FROM canonical_quotes
         WHERE job_id = $1)::integer AS quotes,
       (SELECT count(*) FROM canonical_invoices
         WHERE job_id = $1)::integer AS invoices`,
    [jobId]
  );
  return result.rows[0];
}

test(
  "Migration 56 runtime enforces Evaluation Visit negotiation and completed-Visit provenance",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 63);
      assert.equal(
        migrations.at(-2).filename,
        "202608270001_add_canonical_visit_start_authority.sql"
      );
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, migrated.errorCode);
      assert.equal(migrated.applied.length, 63);

      const identities = await createVisitTestIdentities(pool, suffix);
      const directFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-direct`
      );
      const negotiatedFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-negotiated`
      );
      const reasonedFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-reasoned`
      );
      const scheduledCreationFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-scheduled-creation`
      );

      const grants = await pool.query(
        `SELECT participants.user_id, grants.capability
         FROM lifecycle_authority_grants grants
         INNER JOIN relationship_participants participants
           ON participants.id = grants.grantee_participant_id
         WHERE grants.job_id = $1
           AND grants.scope_type = 'evaluation_visit'
           AND grants.scope_job_id = $1
         ORDER BY participants.user_id, grants.capability`,
        [directFixture.jobId]
      );
      assert.deepEqual(
        grants.rows.filter((row) => Number(row.user_id) === identities.homeownerId)
          .map((row) => row.capability),
        ["visit.change_request", "visit.confirm", "visit.read"]
      );
      assert.deepEqual(
        grants.rows.filter((row) => Number(row.user_id) === identities.professionalId)
          .map((row) => row.capability),
        [
          "visit.cancel",
          "visit.complete",
          "visit.confirm",
          "visit.propose",
          "visit.read",
          "visit.reschedule",
        ]
      );

      const scheduleBefore = await getProfessionalSchedule({
        pool,
        authenticatedActor: { id: identities.professionalId },
        view: "active",
        clock: professionalClock,
      });
      const directOpportunity = scheduleBefore.schedule.opportunities.find(
        (item) => item.jobId === directFixture.jobId
      );
      assert.equal(directOpportunity.semanticState, "READY_TO_SCHEDULE");
      assert.equal(directOpportunity.purpose, "EVALUATION");
      assert.equal(directOpportunity.evaluationId, null);

      const beforeCompletion = await createOrdinaryJobEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: directFixture.jobId,
        content: evaluationContent("Prepared before the Evaluation Visit existed."),
        expectedVersion: 0,
        idempotencyKey: `r3-evaluation-before-completion-${suffix}`,
        logger: quiet,
      });
      assert.equal(beforeCompletion.code, "EVALUATION_CREATED");
      assert.equal(beforeCompletion.evaluation.status, "draft");
      assert.equal(beforeCompletion.evaluation.capabilities.canComplete, false);
      assert.equal(beforeCompletion.aggregate.sourceContext.evaluationVisitId, null);
      const beforeCompletionReplay = await createOrdinaryJobEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: directFixture.jobId,
        content: evaluationContent("Prepared before the Evaluation Visit existed."),
        expectedVersion: 0,
        idempotencyKey: `r3-evaluation-before-completion-${suffix}`,
        logger: quiet,
      });
      assert.equal(beforeCompletionReplay.replayed, true);
      assert.equal(
        beforeCompletionReplay.evaluation.id,
        beforeCompletion.evaluation.id
      );

      const noVisitEvaluation = await createOrdinaryJobEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: directFixture.jobId,
        visitId: randomUUID(),
        content: evaluationContent("Attempted before the Evaluation Visit."),
        expectedVersion: 0,
        idempotencyKey: `r3-evaluation-before-visit-${suffix}`,
        logger: quiet,
      });
      assert.equal(noVisitEvaluation.code, "COMPLETED_EVALUATION_VISIT_REQUIRED");

      for (const purpose of ["FOLLOW_UP", "APPROVED_WORK"]) {
        const deniedPurpose = await command(
          proposeVisit,
          pool,
          identities.professionalId,
          proposal(directFixture, {
            purpose,
            approvedQuoteDecisionId: purpose === "APPROVED_WORK" ? randomUUID() : undefined,
          }),
          randomUUID()
        );
        assert.equal(deniedPurpose.code, "VISIT_AUTHORITY_REQUIRED");
      }

      const directProposalKey = randomUUID();
      const directProposed = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(directFixture),
        directProposalKey
      );
      assert.equal(directProposed.code, "VISIT_PROPOSED");
      assert.equal(directProposed.visit.state, "PROPOSED");
      assert.equal(directProposed.visit.currentVersion, 1);
      assert.equal(directProposed.visit.evaluationId, null);
      const proposedCompletionDenied = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: beforeCompletion.evaluation.id,
        expectedVersion: 1,
        completionMode: "PHYSICAL",
        idempotencyKey: `r5-physical-proposed-denied-${suffix}`,
        logger: quiet,
      });
      assert.equal(
        proposedCompletionDenied.code,
        "COMPLETED_EVALUATION_VISIT_REQUIRED"
      );

      const directProposalReplay = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(directFixture),
        directProposalKey
      );
      assert.equal(directProposalReplay.replayed, true);
      assert.equal(directProposalReplay.visit.id, directProposed.visit.id);

      const ownProposalDenied = await command(
        confirmVisit,
        pool,
        identities.professionalId,
        {
          jobId: directFixture.jobId,
          visitId: directProposed.visit.id,
          expectedVersion: 1,
        },
        randomUUID()
      );
      assert.equal(ownProposalDenied.code, "VISIT_OPPOSITE_PARTY_CONFIRMATION_REQUIRED");

      const directConfirmKey = randomUUID();
      const directConfirmed = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: directFixture.jobId,
          visitId: directProposed.visit.id,
          expectedVersion: 1,
        },
        directConfirmKey
      );
      assert.equal(directConfirmed.visit.state, "SCHEDULED");
      assert.equal(directConfirmed.visit.currentVersion, 2);
      const scheduledDraft = await updateEvaluationDraft({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: beforeCompletion.evaluation.id,
        content: evaluationContent("Continued while the Visit was scheduled."),
        expectedVersion: 1,
        idempotencyKey: `r5-evaluation-during-scheduled-${suffix}`,
        logger: quiet,
      });
      assert.equal(scheduledDraft.code, "EVALUATION_DRAFT_UPDATED");
      assert.equal(scheduledDraft.aggregate.version, 2);
      const scheduledCompletionDenied = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: beforeCompletion.evaluation.id,
        expectedVersion: 2,
        idempotencyKey: `r5-physical-scheduled-denied-${suffix}`,
        logger: quiet,
      });
      assert.equal(
        scheduledCompletionDenied.code,
        "COMPLETED_EVALUATION_VISIT_REQUIRED"
      );
      const directConfirmReplay = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: directFixture.jobId,
          visitId: directProposed.visit.id,
          expectedVersion: 1,
        },
        directConfirmKey
      );
      assert.equal(directConfirmReplay.replayed, true);
      assert.equal(directConfirmReplay.visit.currentVersion, 2);

      const visitCompletionKey = randomUUID();
      const completedVisit = await command(
        completeVisit,
        pool,
        identities.professionalId,
        {
          jobId: directFixture.jobId,
          visitId: directProposed.visit.id,
          expectedVersion: 2,
        },
        visitCompletionKey,
        completionClock
      );
      assert.equal(completedVisit.visit.state, "COMPLETED");
      assert.equal(completedVisit.visit.currentVersion, 3);
      assert.equal(completedVisit.visit.evaluationId, beforeCompletion.evaluation.id);
      const completedVisitReplay = await command(
        completeVisit,
        pool,
        identities.professionalId,
        {
          jobId: directFixture.jobId,
          visitId: directProposed.visit.id,
          expectedVersion: 2,
        },
        visitCompletionKey,
        completionClock
      );
      assert.equal(completedVisitReplay.replayed, true);
      assert.equal(completedVisitReplay.visit.currentVersion, 3);
      assert.deepEqual(await lifecycleCounts(pool, directFixture.jobId), {
        visits: 1,
        visit_versions: 3,
        visit_events: 3,
        evaluation_links: 1,
        evaluations: 1,
        quotes: 0,
        invoices: 0,
      });

      const continuedEvaluation = await updateEvaluationDraft({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: beforeCompletion.evaluation.id,
        content: evaluationContent("Documented after the completed Evaluation Visit."),
        expectedVersion: 2,
        idempotencyKey: `r4-evaluation-after-visit-${suffix}`,
        logger: quiet,
      });
      assert.equal(continuedEvaluation.code, "EVALUATION_DRAFT_UPDATED");
      assert.equal(continuedEvaluation.evaluation.capabilities.canComplete, true);
      assert.equal(
        continuedEvaluation.aggregate.sourceContext.evaluationVisitId,
        directProposed.visit.id
      );

      const completedEvaluation = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: beforeCompletion.evaluation.id,
        expectedVersion: 3,
        idempotencyKey: `r3-complete-evaluation-${suffix}`,
        logger: quiet,
      });
      assert.equal(completedEvaluation.code, "EVALUATION_COMPLETED");
      assert.equal(completedEvaluation.evaluation.status, "completed");
      assert.equal(completedEvaluation.evaluation.completionMode, "PHYSICAL");
      const physicalContext = await pool.query(
        `SELECT jobs.source_request_relationship_id AS relationship_id,
          relationship_participants.id AS actor_participant_id
         FROM jobs
         INNER JOIN relationship_participants
           ON relationship_participants.job_id = jobs.id
           AND relationship_participants.user_id = $2
         WHERE jobs.id = $1`,
        [directFixture.jobId, identities.professionalId]
      );
      assert.equal(
        await quoteDraftServiceInternals.requireSavedEvaluation({
          client: pool,
          context: {
            job_id: directFixture.jobId,
            job_request_id: directFixture.requestId,
            relationship_id: Number(physicalContext.rows[0].relationship_id),
            actor_user_id: identities.professionalId,
            actor_participant_id: physicalContext.rows[0].actor_participant_id,
          },
          logger: quiet,
        }),
        null
      );
      const remoteAfterPhysical = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: beforeCompletion.evaluation.id,
        expectedVersion: 4,
        completionMode: "REMOTE",
        assessmentMethod: "PHONE",
        assessmentBasis: "A physical Visit already completed this Evaluation.",
        idempotencyKey: `r5-remote-after-physical-${suffix}`,
        logger: quiet,
      });
      assert.equal(
        remoteAfterPhysical.code,
        "REMOTE_EVALUATION_PHYSICAL_PROVENANCE_CONFLICT"
      );
      assert.deepEqual(await lifecycleCounts(pool, directFixture.jobId), {
        visits: 1,
        visit_versions: 3,
        visit_events: 3,
        evaluation_links: 1,
        evaluations: 1,
        quotes: 0,
        invoices: 0,
      });

      const negotiatedProposed = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(negotiatedFixture),
        randomUUID()
      );
      const proposedStateDraft = await createOrdinaryJobEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: negotiatedFixture.jobId,
        content: evaluationContent("Prepared while the Visit proposal awaited review."),
        expectedVersion: 0,
        idempotencyKey: `r5-evaluation-created-while-proposed-${suffix}`,
        logger: quiet,
      });
      assert.equal(proposedStateDraft.code, "EVALUATION_CREATED");
      assert.equal(proposedStateDraft.aggregate.sourceContext.evaluationVisitId, null);
      const missingLegacyReason = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 1,
          reason: null,
        },
        randomUUID()
      );
      assert.equal(missingLegacyReason.code, "INVALID_VISIT_CHANGE_REQUEST");
      assert.equal(negotiatedProposed.visit.currentVersion, 1);

      const alternateKey = randomUUID();
      const alternate = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 1,
          reason: null,
          scheduledStartAt: "2026-09-03T17:00:00.000Z",
          scheduledEndAt: "2026-09-03T18:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
        },
        alternateKey
      );
      assert.equal(alternate.code, "VISIT_SCHEDULE_PROPOSED");
      assert.equal(alternate.visit.state, "PROPOSED");
      assert.equal(alternate.visit.currentVersion, 2);

      const alternateReplay = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 1,
          reason: null,
          scheduledStartAt: "2026-09-03T17:00:00.000Z",
          scheduledEndAt: "2026-09-03T18:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
        },
        alternateKey
      );
      assert.equal(alternateReplay.replayed, true);
      assert.equal(alternateReplay.visit.currentVersion, 2);

      const alternateEvidence = await pool.query(
        `SELECT versions.state, versions.recorded_by_participant_id,
           events.event_type, events.visit_version,
           events.previous_visit_version, events.reason,
           events.recorded_by_participant_id AS event_participant_id
         FROM canonical_visit_versions versions
         INNER JOIN canonical_visit_events events
           ON events.visit_id = versions.visit_id
          AND events.visit_version = versions.version
          AND events.event_type = 'VISIT_SCHEDULE_PROPOSED'
         WHERE versions.visit_id = $1 AND versions.version = 2`,
        [negotiatedProposed.visit.id]
      );
      assert.deepEqual(alternateEvidence.rows, [{
        state: "PROPOSED",
        recorded_by_participant_id: negotiatedFixture.homeownerParticipantId,
        event_type: "VISIT_SCHEDULE_PROPOSED",
        visit_version: 2,
        previous_visit_version: 1,
        reason: null,
        event_participant_id: negotiatedFixture.homeownerParticipantId,
      }]);

      const customerCannotSelfConfirm = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 2,
        },
        randomUUID()
      );
      assert.equal(
        customerCannotSelfConfirm.code,
        "VISIT_OPPOSITE_PARTY_CONFIRMATION_REQUIRED"
      );

      const staleAlternate = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 1,
          reason: "A stale second customer time.",
          scheduledStartAt: "2026-09-03T19:00:00.000Z",
          scheduledEndAt: "2026-09-03T20:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
        },
        randomUUID()
      );
      assert.equal(staleAlternate.code, "STALE_VISIT_VERSION");

      const scheduleWithCustomerProposal = await getProfessionalSchedule({
        pool,
        authenticatedActor: { id: identities.professionalId },
        view: "active",
        clock: professionalClock,
      });
      const actionableProposal = scheduleWithCustomerProposal.schedule.visits.find(
        (item) => item.id === negotiatedProposed.visit.id
      );
      assert.equal(actionableProposal.semanticState, "CHANGE_REQUESTED");
      assert.equal(actionableProposal.currentVersion, 2);
      assert.equal(actionableProposal.actions.canConfirm, true);

      const professionalConfirm = await command(
        confirmVisit,
        pool,
        identities.professionalId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 2,
        },
        randomUUID()
      );
      assert.equal(professionalConfirm.visit.state, "SCHEDULED");
      assert.equal(professionalConfirm.visit.currentVersion, 3);

      const professionalRevision = await command(
        rescheduleVisit,
        pool,
        identities.professionalId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 3,
          reason: "Professional schedule revision requiring renewed confirmation.",
          scheduledStartAt: "2026-09-04T15:00:00.000Z",
          scheduledEndAt: "2026-09-04T16:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
        },
        randomUUID()
      );
      assert.equal(professionalRevision.visit.state, "PROPOSED");
      assert.equal(professionalRevision.visit.currentVersion, 4);

      const scheduledCreationProposal = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(scheduledCreationFixture),
        randomUUID()
      );
      const scheduledCreationVisit = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: scheduledCreationFixture.jobId,
          visitId: scheduledCreationProposal.visit.id,
          expectedVersion: 1,
        },
        randomUUID()
      );
      assert.equal(scheduledCreationVisit.visit.state, "SCHEDULED");
      const scheduledStateDraft = await createOrdinaryJobEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: scheduledCreationFixture.jobId,
        content: evaluationContent("Prepared after the Visit was scheduled."),
        expectedVersion: 0,
        idempotencyKey: `r5-evaluation-created-while-scheduled-${suffix}`,
        logger: quiet,
      });
      assert.equal(scheduledStateDraft.code, "EVALUATION_CREATED");
      assert.equal(scheduledStateDraft.aggregate.sourceContext.evaluationVisitId, null);

      const professionalCannotSelfConfirm = await command(
        confirmVisit,
        pool,
        identities.professionalId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 4,
        },
        randomUUID()
      );
      assert.equal(
        professionalCannotSelfConfirm.code,
        "VISIT_OPPOSITE_PARTY_CONFIRMATION_REQUIRED"
      );

      const renewedCustomerConfirmation = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        {
          jobId: negotiatedFixture.jobId,
          visitId: negotiatedProposed.visit.id,
          expectedVersion: 4,
        },
        randomUUID()
      );
      assert.equal(renewedCustomerConfirmation.visit.state, "SCHEDULED");
      assert.equal(renewedCustomerConfirmation.visit.currentVersion, 5);

      const lineage = await pool.query(
        `SELECT event_type, visit_version, previous_visit_version, visit_state
         FROM canonical_visit_events
         WHERE visit_id = $1
         ORDER BY visit_version`,
        [negotiatedProposed.visit.id]
      );
      assert.deepEqual(lineage.rows, [
        {
          event_type: "VISIT_PROPOSED",
          visit_version: 1,
          previous_visit_version: null,
          visit_state: "PROPOSED",
        },
        {
          event_type: "VISIT_SCHEDULE_PROPOSED",
          visit_version: 2,
          previous_visit_version: 1,
          visit_state: "PROPOSED",
        },
        {
          event_type: "VISIT_CONFIRMED",
          visit_version: 3,
          previous_visit_version: 2,
          visit_state: "SCHEDULED",
        },
        {
          event_type: "VISIT_SCHEDULE_PROPOSED",
          visit_version: 4,
          previous_visit_version: 3,
          visit_state: "PROPOSED",
        },
        {
          event_type: "VISIT_CONFIRMED",
          visit_version: 5,
          previous_visit_version: 4,
          visit_state: "SCHEDULED",
        },
      ]);
      assert.deepEqual(await lifecycleCounts(pool, negotiatedFixture.jobId), {
        visits: 1,
        visit_versions: 5,
        visit_events: 5,
        evaluation_links: 0,
        evaluations: 1,
        quotes: 0,
        invoices: 0,
      });

      const reasonedProposed = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        proposal(reasonedFixture),
        randomUUID()
      );
      const overlongNote = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: reasonedFixture.jobId,
          visitId: reasonedProposed.visit.id,
          expectedVersion: 1,
          reason: "x".repeat(2001),
          scheduledStartAt: "2026-09-06T14:00:00.000Z",
          scheduledEndAt: "2026-09-06T15:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
        },
        randomUUID()
      );
      assert.equal(overlongNote.code, "INVALID_VISIT_CHANGE_REQUEST");

      const reasonedAlternate = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: reasonedFixture.jobId,
          visitId: reasonedProposed.visit.id,
          expectedVersion: 1,
          reason: "  Please coordinate arrival at the front entrance.  ",
          scheduledStartAt: "2026-09-06T14:00:00.000Z",
          scheduledEndAt: "2026-09-06T15:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "JOB_SERVICE_LOCATION",
        },
        randomUUID()
      );
      assert.equal(reasonedAlternate.code, "VISIT_SCHEDULE_PROPOSED");
      assert.equal(reasonedAlternate.visit.currentVersion, 2);
      const reasonedEvent = await pool.query(
        `SELECT reason FROM canonical_visit_events
         WHERE visit_id = $1
           AND visit_version = 2
           AND event_type = 'VISIT_SCHEDULE_PROPOSED'`,
        [reasonedProposed.visit.id]
      );
      assert.deepEqual(reasonedEvent.rows, [{
        reason: "Please coordinate arrival at the front entrance.",
      }]);

      const legacyReasonOnly = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: reasonedFixture.jobId,
          visitId: reasonedProposed.visit.id,
          expectedVersion: 2,
          reason: "Please call before arriving.",
        },
        randomUUID()
      );
      assert.equal(legacyReasonOnly.code, "VISIT_CHANGE_REQUESTED");
      assert.equal(legacyReasonOnly.visit.currentVersion, 2);
      assert.equal(legacyReasonOnly.event.reason, "Please call before arriving.");
      assert.deepEqual(await lifecycleCounts(pool, reasonedFixture.jobId), {
        visits: 1,
        visit_versions: 2,
        visit_events: 3,
        evaluation_links: 0,
        evaluations: 0,
        quotes: 0,
        invoices: 0,
      });
    } finally {
      await pool.end();
    }
  }
);
