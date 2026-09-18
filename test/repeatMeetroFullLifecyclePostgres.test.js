"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  createVisitWorkstream,
  ensureCompletedVisitEvaluation,
  quiet,
} = require("./helpers/visitLifecycleFixture");

const {
  createJobRequest,
} = require("../server/requests/jobRequestCreateService");

const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");

const {
  sendQuoteInMeetro,
} = require("../server/authorization/quoteDeliveryService");

const {
  confirmDepositReceived,
  materializePreWorkDepositObligation,
} = require("../server/finance/preWorkDepositService");

const {
  bindWorkstreamToExecution,
  classifyWorkActivity,
  completeApprovedWork,
  materializeApprovedWorkExecution,
} = require("../server/workflow/approvedWorkExecutionService");

const {
  materializeWorkPreparation,
  reviseWorkPreparation,
} = require("../server/workflow/workPreparationService");

const {
  createWorkActivity,
} = require("../server/workflow/workstreamService");

const {
  activateApprovedWorkVisitAuthority,
} = require("../server/workflow/approvedWorkVisitService");

const {
  completeVisit,
  confirmVisit,
  proposeVisit,
  startVisit,
} = require("../server/workflow/visitService");

const {
  getProfessionalSchedule,
} = require("../server/workflow/professionalScheduleService");

const {
  getCanonicalLiveJob,
} = require("../server/workflow/liveJobProjectionService");

const {
  completeJob,
  getCustomerJobHistory,
  getJobCompletionReview,
  getProfessionalJobHistory,
} = require("../server/workflow/jobCompletionService");

const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl =
  process.env.REPEAT_MEETRO_LIFECYCLE_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(
      databaseUrl,
      {
        nodeEnv: process.env.NODE_ENV,
      }
    ),
  };
}

function command(
  service,
  pool,
  actorId,
  values,
  idempotencyKey = randomUUID()
) {
  return service({
    pool,
    authenticatedActor: {
      id: actorId,
    },
    idempotencyKey,
    logger: quiet,
    ...values,
  });
}

function customerTermsSnapshot() {
  return {
    schemaVersion: 1,
    paymentTerms:
      "75% deposit; balance due on completion.",
    estimatedDuration: "1 day",
    customerNotes: "",
    agreement: {
      exclusions: [],
      additionalWorkTerms:
        "Written customer approval is required.",
      hiddenConditionsTerms:
        "Hidden conditions require a revised Quote.",
      diagnosticTerms:
        "Diagnostic work is limited to the stated scope.",
      customerResponsibilities:
        "Provide safe site access.",
      warrantyTerms:
        "One-year workmanship warranty.",
      cancellationTerms:
        "Cancellation terms apply as stated.",
      acceptanceTerms:
        "Approval accepts this exact issued Quote.",
      preauthorizedAdditionalWorkLimit: "$0",
    },
  };
}

function repeatRequestPayload(
  priorRelationshipId,
  suffix
) {
  return {
    title:
      `Repeat customer exterior repair ${suffix}`,
    description:
      "This is completely new work requested from a business the homeowner previously hired through Meetro.",
    category: "handyman",
    request_category: "handyman",
    service_domain: "home_services",
    service_specialty: "handyman",
    location: "Cape Coral, FL 33904",
    location_intake_mode: "exact_on_file",
    service_address_line1:
      "123 Repeat Customer Ave",
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    unit_number: "",
    access_notes: "",
    request_photos: [],
    request_origin:
      "existing_customer_request",
    source_meetro_relationship_id:
      priorRelationshipId,
  };
}

async function count(pool, table) {
  const result =
    await pool.query(
      `SELECT count(*)::integer AS count
       FROM ${table}`
    );

  return Number(
    result.rows[0].count
  );
}

test(
  "disposable PostgreSQL certifies Repeat Meetro full lifecycle from prior relationship without Selection reuse",
  {
    skip: !databaseUrl,
  },
  async () => {
    const pool =
      new Pool({
        connectionString:
          databaseUrl,
        max: 12,
      });

    const suffix =
      randomUUID();

    try {
      const migrations =
        getMigrationFiles();

      assert.equal(
        migrations.length,
        99
      );

      const migrated =
        await runMigrationCollection(
          pool,
          migrations,
          targetMetadata()
        );

      assert.equal(
        migrated.success,
        true,
        JSON.stringify(migrated)
      );

      assert.equal(
        migrated.applied.length,
        99
      );

      /*
       * Establish real prior Meetro provenance through the
       * ordinary marketplace Request -> Response -> Selection flow.
       * This is the Worked With / repeat-customer authority source.
       */
      const identities =
        await createVisitTestIdentities(
          pool,
          suffix
        );

      const prior =
        await createVisitLifecycleFixture(
          pool,
          identities,
          `${suffix}-prior`
        );

      const priorRelationshipResult =
        await pool.query(
          `SELECT
             relationships.id,
             relationships.homeowner_user_id,
             relationships.contractor_profile_id,
             relationships.professional_user_id,
             relationships.established_from_request_selection_id
           FROM meetro_customer_business_relationships relationships
           WHERE relationships.homeowner_user_id = $1
             AND relationships.professional_user_id = $2
           LIMIT 1`,
          [
            identities.homeownerId,
            identities.professionalId,
          ]
        );

      assert.equal(
        priorRelationshipResult.rows.length,
        1
      );

      const priorRelationship =
        priorRelationshipResult.rows[0];

      assert.ok(
        priorRelationship
          .established_from_request_selection_id
      );

      const priorSelection =
        await pool.query(
          `SELECT
             id,
             post_id,
             request_relationship_id,
             selected_by_user_id,
             contractor_id,
             professional_user_id
           FROM request_selections
           WHERE id = $1`,
          [
            priorRelationship
              .established_from_request_selection_id,
          ]
        );

      assert.equal(
        priorSelection.rows.length,
        1
      );

      assert.equal(
        Number(
          priorSelection.rows[0]
            .selected_by_user_id
        ),
        identities.homeownerId
      );

      assert.equal(
        Number(
          priorSelection.rows[0]
            .professional_user_id
        ),
        identities.professionalId
      );

      assert.equal(
        prior.jobId != null,
        true
      );

      const before = {
        responses:
          await count(
            pool,
            "professional_responses"
          ),
        selections:
          await count(
            pool,
            "request_selections"
          ),
        alerts:
          await count(
            pool,
            "alerts"
          ),
        jobs:
          await count(
            pool,
            "jobs"
          ),
      };

      /*
       * Request New Work:
       * only the durable prior Meetro relationship is carried.
       * All work/lifecycle state is new.
       */
      const created =
        await createJobRequest({
          pool,
          authenticatedActor: {
            id:
              identities.homeownerId,
          },
          payload:
            repeatRequestPayload(
              priorRelationship.id,
              suffix
            ),
          idempotencyKey:
            randomUUID(),
          env: {
            JOB_LIFECYCLE_V2_ENABLED:
              "true",
            JOB_LIFECYCLE_V2_READINESS:
              "MC-JOB-LIFECYCLE-004B",
          },
        });

      assert.equal(
        created.ok,
        true,
        created.code
      );

      assert.equal(
        created.status,
        201
      );

      assert.equal(
        created.post.request_origin,
        "existing_customer_request"
      );

      assert.equal(
        created.post
          .source_meetro_relationship_id,
        priorRelationship.id
      );

      assert.equal(
        created.relationship
          .authoritySource,
        "existing_customer_request"
      );

      assert.equal(
        created.conversation.status,
        "active"
      );

      assert.equal(
        created.job.sourceType,
        "existing_customer_request"
      );

      assert.equal(
        await count(
          pool,
          "professional_responses"
        ),
        before.responses
      );

      assert.equal(
        await count(
          pool,
          "request_selections"
        ),
        before.selections
      );

      assert.equal(
        await count(
          pool,
          "alerts"
        ),
        before.alerts
      );

      assert.equal(
        await count(
          pool,
          "jobs"
        ),
        before.jobs + 1
      );

      const sourceTruth =
        await pool.query(
          `SELECT
             jobs.id,
             jobs.source_type,
             jobs.job_request_id,
             jobs.source_request_selection_id,
             jobs.source_request_relationship_id,
             posts.request_origin,
             posts.source_meetro_relationship_id,
             relationships.professional_response_id,
             relationships.ordinary_authority_source,
             relationships.source_meetro_relationship_id,
             conversations.id AS conversation_id,
             conversations.request_selection_id
           FROM jobs
           INNER JOIN posts
             ON posts.id =
                jobs.job_request_id
           INNER JOIN request_relationships relationships
             ON relationships.id =
                jobs.source_request_relationship_id
           INNER JOIN conversations
             ON conversations.relationship_id =
                relationships.id
           WHERE jobs.id = $1`,
          [
            created.job.id,
          ]
        );

      assert.equal(
        sourceTruth.rows.length,
        1
      );

      const source =
        sourceTruth.rows[0];

      assert.equal(
        source.source_type,
        "existing_customer_request"
      );

      assert.equal(
        source.request_origin,
        "existing_customer_request"
      );

      assert.equal(
        source.source_request_selection_id,
        null
      );

      assert.equal(
        source.professional_response_id,
        null
      );

      assert.equal(
        source.request_selection_id,
        null
      );

      assert.equal(
        source.ordinary_authority_source,
        "existing_customer_request"
      );

      assert.equal(
        source.source_meetro_relationship_id,
        priorRelationship.id
      );

      /*
       * The old Worked With relationship is provenance only.
       * Fresh lifecycle evidence is the new Request Relationship.
       */
      assert.notEqual(
        String(
          source
            .source_request_relationship_id
        ),
        String(
          priorSelection.rows[0]
            .request_relationship_id
        )
      );

      const participants =
        await pool.query(
          `SELECT
             participants.id,
             participants.user_id,
             participants.request_relationship_id,
             participants.source_evidence_type,
             roles.role
           FROM relationship_participants participants
           INNER JOIN participant_role_assignments roles
             ON roles.participant_id =
                participants.id
            AND roles.job_id =
                participants.job_id
           WHERE participants.job_id = $1
           ORDER BY participants.user_id`,
          [
            created.job.id,
          ]
        );

      assert.equal(
        participants.rows.length,
        2
      );

      assert.deepEqual(
        participants.rows
          .map(
            (row) =>
              row.role
          )
          .sort(),
        [
          "CUSTOMER_REPRESENTATIVE",
          "PRIMARY_PROFESSIONAL",
        ].sort()
      );

      assert.equal(
        participants.rows.every(
          (row) =>
            row.source_evidence_type ===
              "existing_customer_request" &&
            Number(
              row.request_relationship_id
            ) ===
              Number(
                created.relationship.id
              )
        ),
        true
      );

      /*
       * No prior Job lifecycle state is copied into the new Job.
       */
      const freshState =
        await pool.query(
          `SELECT
             (SELECT count(*)::integer
                FROM canonical_evaluation_job_subjects
               WHERE job_id = $1)
                 AS evaluations,
             (SELECT count(*)::integer
                FROM canonical_quotes
               WHERE job_id = $1)
                 AS quotes,
             (SELECT count(*)::integer
                FROM canonical_quote_approvals
               WHERE job_id = $1)
                 AS approvals,
             (SELECT count(*)::integer
                FROM canonical_pre_work_deposit_obligations
               WHERE job_id = $1)
                 AS deposits,
             (SELECT count(*)::integer
                FROM canonical_visits
               WHERE job_id = $1)
                 AS visits,
             (SELECT count(*)::integer
                FROM canonical_job_completion_records
               WHERE job_id = $1)
                 AS completions`,
          [
            created.job.id,
          ]
        );

      assert.deepEqual(
        freshState.rows[0],
        {
          evaluations: 0,
          quotes: 0,
          approvals: 0,
          deposits: 0,
          visits: 0,
          completions: 0,
        }
      );

      const professionalParticipant =
        participants.rows.find(
          (row) =>
            Number(row.user_id) ===
            identities.professionalId
        );

      const homeownerParticipant =
        participants.rows.find(
          (row) =>
            Number(row.user_id) ===
            identities.homeownerId
        );

      assert.ok(
        professionalParticipant
      );

      assert.ok(
        homeownerParticipant
      );

      const fixture = {
        requestId:
          Number(created.post.id),
        jobId:
          created.job.id,
        professionalParticipantId:
          professionalParticipant.id,
        homeownerParticipantId:
          homeownerParticipant.id,
      };

      /*
       * Fresh Evaluation.
       */
      const workstream =
        await createVisitWorkstream(
          pool,
          identities,
          fixture,
          `${suffix}-repeat`,
          1
        );

      const evaluation =
        await ensureCompletedVisitEvaluation(
          pool,
          identities,
          fixture,
          `${suffix}-repeat`
        );

      assert.equal(
        evaluation.status,
        "completed"
      );

      /*
       * Fresh Job Quote with 75% deposit terms.
       */
      const draft =
        await command(
          createDraftQuote,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            currency: "USD",
            customerTermsSnapshot:
              customerTermsSnapshot(),
          },
          `repeat-quote-${suffix}`
        );

      assert.equal(
        draft.ok,
        true,
        draft.code
      );

      const scoped =
        await command(
          addDraftScopeItem,
          pool,
          identities.professionalId,
          {
            quoteId:
              draft.quote.id,
            expectedVersion:
              draft.quote
                .currentVersion,
            item: {
              classification:
                "LABOR_SERVICE",
              scopeSemantic:
                "FUTURE_WORK",
              materialResponsibility:
                "NOT_APPLICABLE",
              description:
                "Fresh repeat-customer approved repair",
              quantity: 1,
              unitAmountMinor: 68000,
              source: {
                type: "WORKSTREAM",
                workstreamId:
                  workstream.id,
                version:
                  workstream
                    .currentVersion,
              },
            },
          },
          `repeat-scope-${suffix}`
        );

      assert.equal(
        scoped.ok,
        true,
        scoped.code
      );

      const issued =
        await command(
          issueQuote,
          pool,
          identities.professionalId,
          {
            quoteId:
              scoped.quote.id,
            expectedVersion:
              scoped.quote
                .currentVersion,
          },
          `repeat-issue-${suffix}`
        );

      assert.equal(
        issued.ok,
        true,
        issued.code
      );

      const delivered =
        await command(
          sendQuoteInMeetro,
          pool,
          identities.professionalId,
          {
            quoteId:
              issued.quote.id,
            expectedIssuedVersion:
              issued.quote
                .currentVersion,
          },
          `repeat-deliver-${suffix}`
        );

      assert.equal(
        delivered.ok,
        true,
        delivered.code
      );

      const approved =
        await command(
          approveIssuedQuote,
          pool,
          identities.homeownerId,
          {
            quoteId:
              issued.quote.id,
            expectedIssuedVersion:
              issued.quote
                .currentVersion,
          },
          `repeat-approve-${suffix}`
        );

      assert.equal(
        approved.ok,
        true,
        approved.code
      );

      const approvalResult =
        await pool.query(
          `SELECT
             approvals.id,
             approvals.approval_source,
             approvals.decision,
             approvals.customer_decision_id,
             approvals.external_approval_evidence_id,
             decisions.relationship_id
               AS relationship_id
           FROM canonical_quote_approvals approvals
           INNER JOIN canonical_quote_customer_decisions decisions
             ON decisions.id =
                approvals.customer_decision_id
            AND decisions.quote_id =
                approvals.quote_id
            AND decisions.issued_quote_version =
                approvals.issued_quote_version
            AND decisions.job_id =
                approvals.job_id
           WHERE approvals.quote_id = $1`,
          [
            issued.quote.id,
          ]
        );

      assert.equal(
        approvalResult.rows.length,
        1
      );

      const approval =
        approvalResult.rows[0];

      assert.equal(
        approval.approval_source,
        "MEETRO_CUSTOMER"
      );

      assert.equal(
        approval.decision,
        "APPROVED"
      );

      assert.equal(
        approval.customer_decision_id,
        approved.customerDecision.id
      );

      assert.equal(
        approval.external_approval_evidence_id,
        null
      );

      assert.equal(
        Number(
          approval.relationship_id
        ),
        Number(
          created.relationship.id
        )
      );

      /*
       * Deposit: partial remains locked.
       */
      const deposit =
        await command(
          materializePreWorkDepositObligation,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
          },
          `repeat-deposit-${suffix}`
        );

      assert.equal(
        deposit.ok,
        true,
        deposit.code
      );

      assert.equal(
        deposit.deposit.requiredMinor,
        51000
      );

      assert.equal(
        deposit.deposit.state,
        "DUE"
      );

      const partial =
        await command(
          confirmDepositReceived,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            amountMinor: 10000,
            currency: "USD",
            normalizedMethod:
              "BUSINESS_TRANSFER_APP",
            displayMethod:
              "Business transfer app",
            receivedAt:
              new Date(
                Date.now() -
                  120000
              ).toISOString(),
            expectedVersion: 1,
            externalReference:
              `repeat-partial-${suffix}`,
          },
          `repeat-partial-${suffix}`
        );

      assert.equal(
        partial.deposit.state,
        "PARTIALLY_SATISFIED"
      );

      const partialSchedule =
        await command(
          activateApprovedWorkVisitAuthority,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            quoteId:
              issued.quote.id,
          },
          `repeat-visit-partial-${suffix}`
        );

      assert.equal(
        partialSchedule.code,
        "DEPOSIT_REQUIRED_BEFORE_SCHEDULING"
      );

      const satisfied =
        await command(
          confirmDepositReceived,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            amountMinor: 41000,
            currency: "USD",
            normalizedMethod:
              "BUSINESS_TRANSFER_APP",
            displayMethod:
              "Business transfer app",
            receivedAt:
              new Date(
                Date.now() -
                  60000
              ).toISOString(),
            expectedVersion: 2,
            externalReference:
              `repeat-satisfied-${suffix}`,
          },
          `repeat-satisfied-${suffix}`
        );

      assert.equal(
        satisfied.deposit.state,
        "SATISFIED"
      );

      /*
       * Approved Work Execution + Work Preparation.
       */
      const executionResult =
        await command(
          materializeApprovedWorkExecution,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            approvedCustomerDecisionId:
              approved.customerDecision.id,
          },
          `repeat-execution-${suffix}`
        );

      assert.equal(
        executionResult.ok,
        true,
        executionResult.code
      );

      const execution =
        executionResult.execution;

      const bound =
        await command(
          bindWorkstreamToExecution,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            executionId:
              execution.id,
            workstreamId:
              workstream.id,
            expectedExecutionVersion:
              execution.currentVersion,
          },
          `repeat-bind-${suffix}`
        );

      assert.equal(
        bound.ok,
        true,
        bound.code
      );

      const plan =
        await command(
          materializeWorkPreparation,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            approvedCustomerDecisionId:
              approved.customerDecision.id,
          },
          `repeat-plan-${suffix}`
        );

      assert.equal(
        plan.ok,
        true,
        plan.code
      );

      const readyPlan =
        await command(
          reviseWorkPreparation,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            planId:
              plan.workPreparation.id,
            expectedVersion: 1,
            planningState:
              "PLANNED",
            workStartPolicy:
              "NONE",
            internalNotes: null,
            items: [],
          },
          `repeat-plan-ready-${suffix}`
        );

      assert.equal(
        readyPlan.ok,
        true,
        readyPlan.code
      );

      const activityResult =
        await command(
          createWorkActivity,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            workstreamId:
              workstream.id,
            activityType:
              "APPROVED_WORK_EXECUTION",
            statement:
              "Complete the fresh repeat-customer approved repair.",
            customerVisible: true,
          },
          `repeat-activity-${suffix}`
        );

      assert.equal(
        activityResult.ok,
        true,
        activityResult.code
      );

      const activity =
        activityResult.activity;

      const classified =
        await command(
          classifyWorkActivity,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            executionId:
              execution.id,
            workstreamId:
              workstream.id,
            activityId:
              activity.id,
            expectedExecutionVersion:
              execution.currentVersion,
            expectedActivityVersion:
              activity.currentVersion,
            classification:
              "EXECUTION",
            scopeBasis:
              "DECISION_WIDE",
          },
          `repeat-classify-${suffix}`
        );

      assert.equal(
        classified.ok,
        true,
        classified.code
      );

      /*
       * Deposit now unlocks scheduling.
       */
      const activated =
        await command(
          activateApprovedWorkVisitAuthority,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            quoteId:
              issued.quote.id,
          },
          `repeat-visit-authority-${suffix}`
        );

      assert.equal(
        activated.ok,
        true,
        activated.code
      );

      const proposed =
        await command(
          proposeVisit,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            purpose:
              "APPROVED_WORK",
            approvedQuoteDecisionId:
              approved.customerDecision.id,
            workstreamIds: [
              workstream.id,
            ],
            scheduledStartAt:
              "2026-09-18T14:00:00.000Z",
            scheduledEndAt:
              "2026-09-18T15:00:00.000Z",
            timeZone:
              "America/New_York",
            locationMode:
              "JOB_SERVICE_LOCATION",
            clock: () =>
              new Date(
                "2026-09-17T17:00:00.000Z"
              ),
          },
          `repeat-visit-propose-${suffix}`
        );

      assert.equal(
        proposed.ok,
        true,
        proposed.code
      );

      const confirmed =
        await command(
          confirmVisit,
          pool,
          identities.homeownerId,
          {
            jobId:
              fixture.jobId,
            visitId:
              proposed.visit.id,
            expectedVersion:
              proposed.visit
                .currentVersion,
            clock: () =>
              new Date(
                "2026-09-17T17:05:00.000Z"
              ),
          },
          `repeat-visit-confirm-${suffix}`
        );

      assert.equal(
        confirmed.ok,
        true,
        confirmed.code
      );

      assert.equal(
        confirmed.visit.state,
        "SCHEDULED"
      );

      const schedule =
        await getProfessionalSchedule({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          view: "active",
          limit: 50,
          clock: () =>
            new Date(
              "2026-09-17T18:00:00.000Z"
            ),
        });

      assert.equal(
        schedule.ok,
        true,
        schedule.code
      );

      const scheduledVisit =
        schedule.schedule.visits.find(
          (visit) =>
            visit.id ===
            confirmed.visit.id
        );

      assert.ok(
        scheduledVisit
      );

      assert.equal(
        scheduledVisit.state,
        "SCHEDULED"
      );

      /*
       * Visit start becomes canonical Approved Work start evidence.
       */
      const startedVisit =
        await command(
          startVisit,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            visitId:
              confirmed.visit.id,
            expectedVersion:
              confirmed.visit
                .currentVersion,
            approvedWorkExecutionId:
              execution.id,
            expectedExecutionVersion:
              execution.currentVersion,
            acknowledgeScheduleVariance:
              false,
            clock: () =>
              new Date(
                "2026-09-18T14:00:00.000Z"
              ),
          },
          `repeat-visit-start-${suffix}`
        );

      assert.equal(
        startedVisit.ok,
        true,
        startedVisit.code
      );

      assert.equal(
        startedVisit.visit.state,
        "STARTED"
      );

      assert.equal(
        startedVisit
          .approvedWorkStartEvent
          .sourceType,
        "APPROVED_WORK_VISIT"
      );

      const completedVisit =
        await command(
          completeVisit,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            visitId:
              startedVisit.visit.id,
            expectedVersion:
              startedVisit.visit
                .currentVersion,
            clock: () =>
              new Date(
                "2026-09-18T15:00:00.000Z"
              ),
          },
          `repeat-visit-complete-${suffix}`
        );

      assert.equal(
        completedVisit.ok,
        true,
        completedVisit.code
      );

      assert.equal(
        completedVisit.visit.state,
        "COMPLETED"
      );

      /*
       * Complete exact approved work. The classified PLANNED
       * activity is reconciled to DONE because exact Work-start
       * evidence already exists from the completed Visit.
       */
      const workCompleted =
        await command(
          completeApprovedWork,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            executionId:
              execution.id,
            expectedExecutionVersion:
              execution.currentVersion,
            expectedWorkstreams: [
              {
                workstreamId:
                  workstream.id,
                expectedVersion:
                  workstream
                    .currentVersion,
              },
            ],
            expectedActivities: [
              {
                activityId:
                  activity.id,
                expectedVersion:
                  activity
                    .currentVersion,
              },
            ],
          },
          `repeat-work-complete-${suffix}`
        );

      assert.equal(
        workCompleted.ok,
        true,
        workCompleted.code
      );

      assert.equal(
        workCompleted.code,
        "APPROVED_WORK_COMPLETED"
      );

      const live =
        await getCanonicalLiveJob({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          logger: quiet,
        });

      assert.equal(
        live.ok,
        true,
        live.code
      );

      assert.equal(
        live.liveJob.stage.code,
        "WORKSTREAMS_COMPLETE_PENDING_JOB_COMPLETION"
      );

      const review =
        await getJobCompletionReview({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          logger: quiet,
        });

      assert.equal(
        review.ok,
        true,
        review.code
      );

      assert.equal(
        review.completionReview
          .eligible,
        true
      );

      assert.equal(
        review.completionReview
          .canComplete,
        true
      );

      const completed =
        await command(
          completeJob,
          pool,
          identities.professionalId,
          {
            jobId:
              fixture.jobId,
            expectedVersion:
              review
                .completionReview
                .currentVersion,
          },
          `repeat-job-complete-${suffix}`
        );

      assert.equal(
        completed.ok,
        true,
        completed.code
      );

      assert.equal(
        completed.code,
        "JOB_COMPLETED"
      );

      /*
       * Both professional and authenticated homeowner history
       * survive through the fresh repeat relationship.
       */
      const professionalHistory =
        await getProfessionalJobHistory({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
        });

      assert.equal(
        professionalHistory.ok,
        true,
        professionalHistory.code
      );

      assert.equal(
        professionalHistory
          .jobHistory
          .audience,
        "professional"
      );

      assert.equal(
        professionalHistory
          .jobHistory
          .approvedQuote
          .totalMinor,
        68000
      );

      const customerHistory =
        await getCustomerJobHistory({
          pool,
          authenticatedActor: {
            id:
              identities.homeownerId,
          },
          jobId:
            fixture.jobId,
        });

      assert.equal(
        customerHistory.ok,
        true,
        customerHistory.code
      );

      assert.equal(
        customerHistory
          .jobHistory
          .audience,
        "customer"
      );

      assert.equal(
        customerHistory
          .jobHistory
          .actions
          .canMessageProfessional,
        true
      );

      /*
       * Final canonical truth: fresh repeat source, Meetro approval,
       * satisfied deposit, completed work and completed Job.
       */
      const finalTruth =
        await pool.query(
          `SELECT
             jobs.source_type,
             jobs.source_request_selection_id,
             jobs.source_request_relationship_id,
             approvals.approval_source,
             deposits.relationship_id AS deposit_relationship_id,
             deposit_versions.state AS deposit_state,
             completions.status AS completion_status
           FROM jobs
           INNER JOIN canonical_quote_approvals approvals
             ON approvals.job_id =
                jobs.id
            AND approvals.decision =
                'APPROVED'
           INNER JOIN canonical_pre_work_deposit_obligations deposits
             ON deposits.job_id =
                jobs.id
            AND deposits.quote_approval_id =
                approvals.id
           INNER JOIN LATERAL (
             SELECT state
             FROM canonical_pre_work_deposit_versions versions
             WHERE versions.obligation_id =
                   deposits.id
             ORDER BY versions.version DESC
             LIMIT 1
           ) deposit_versions
             ON TRUE
           INNER JOIN canonical_job_completion_records completions
             ON completions.job_id =
                jobs.id
           WHERE jobs.id = $1`,
          [
            fixture.jobId,
          ]
        );

      assert.equal(
        finalTruth.rows.length,
        1
      );

      assert.deepEqual(
        {
          source:
            finalTruth.rows[0]
              .source_type,
          selection:
            finalTruth.rows[0]
              .source_request_selection_id,
          relationship:
            Number(
              finalTruth.rows[0]
                .source_request_relationship_id
            ),
          approval:
            finalTruth.rows[0]
              .approval_source,
          depositRelationship:
            Number(
              finalTruth.rows[0]
                .deposit_relationship_id
            ),
          deposit:
            finalTruth.rows[0]
              .deposit_state,
          completion:
            finalTruth.rows[0]
              .completion_status,
        },
        {
          source:
            "existing_customer_request",
          selection: null,
          relationship:
            Number(
              created.relationship.id
            ),
          approval:
            "MEETRO_CUSTOMER",
          depositRelationship:
            Number(
              created.relationship.id
            ),
          deposit:
            "SATISFIED",
          completion:
            "COMPLETED",
        }
      );

      const externalEvidence =
        await pool.query(
          `SELECT count(*)::integer AS count
           FROM canonical_quote_external_approval_evidence
           WHERE job_id = $1`,
          [
            fixture.jobId,
          ]
        );

      assert.equal(
        externalEvidence
          .rows[0]
          .count,
        0
      );
    } finally {
      await pool.end();
    }
  }
);
