"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { createJobRequest } = require("../server/requests/jobRequestCreateService");
const {
  submitProfessionalResponse,
} = require("../server/relationships/professionalResponseService");
const {
  selectProfessionalResponse,
} = require("../server/relationships/requestSelectionService");
const {
  createOrdinaryJobEvaluation,
} = require("../server/authorization/evaluationService");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  createWorkstream,
} = require("../server/workflow/workstreamService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const cleanDatabaseUrl = process.env.VISIT_FOUNDATION_DATABASE_URL;
const upgradeDatabaseUrl = process.env.VISIT_FOUNDATION_UPGRADE_DATABASE_URL;
const migrationName =
  "202608130001_create_canonical_visit_persistence_foundation.sql";
const quiet = { info() {}, warn() {} };

function targetMetadata(databaseUrl) {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestPayload(description) {
  return {
    title: `Visit foundation ${description}`,
    description,
    category: "home_repair",
    request_category: "home_repair",
    service_domain: "home_services",
    service_specialty: "handyman",
    location: "Cape Coral, FL 33904",
    location_intake_mode: "address_after_selection",
    service_address_line1: null,
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    unit_number: "",
    access_notes: "",
    request_photos: [],
  };
}

function evaluationContent(description) {
  return {
    serviceType: "handyman",
    evaluationContext: "ordinary_job",
    observations: description,
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

async function createIdentities(pool, suffix) {
  const homeowner = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Visit Homeowner', $1, 'test-only-hash', 'homeowner', 'homeowner')
     RETURNING id`,
    [`visit-homeowner-${suffix}@example.test`]
  );
  const professional = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Visit Professional', $1, 'test-only-hash', 'handyman', 'professional')
     RETURNING id`,
    [`visit-professional-${suffix}@example.test`]
  );
  await pool.query(
    `INSERT INTO contractor_profiles
      (user_id, business_name, category, location, profile_details)
     VALUES ($1, 'Visit Test Service', 'handyman', 'Cape Coral', $2::jsonb)`,
    [
      professional.rows[0].id,
      JSON.stringify({
        service_area: "Cape Coral",
        service_specialties: ["handyman"],
      }),
    ]
  );
  return {
    homeownerId: Number(homeowner.rows[0].id),
    professionalId: Number(professional.rows[0].id),
  };
}

async function createLifecycleFixture(pool, identities, suffix) {
  const created = await createJobRequest({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    payload: requestPayload(`fixture ${suffix}`),
    idempotencyKey: randomUUID(),
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
  });
  assert.equal(created.ok, true, created.code);

  const response = await submitProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "Synthetic Visit foundation response." },
    idempotencyKey: `visit-response-${suffix}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true, response.code);

  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: randomUUID(),
  });
  assert.equal(selection.ok, true, selection.code);

  const result = await pool.query(
    `SELECT jobs.id AS job_id,
       jobs.source_request_relationship_id AS relationship_id,
       professional.id AS professional_participant_id,
       homeowner.id AS homeowner_participant_id
     FROM jobs
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id
       AND professional.user_id = $2
     INNER JOIN relationship_participants homeowner
       ON homeowner.job_id = jobs.id
       AND homeowner.user_id = $3
     WHERE jobs.job_request_id = $1`,
    [created.post.id, identities.professionalId, identities.homeownerId]
  );

  return {
    requestId: Number(created.post.id),
    jobId: result.rows[0].job_id,
    relationshipId: Number(result.rows[0].relationship_id),
    professionalParticipantId: result.rows[0].professional_participant_id,
    homeownerParticipantId: result.rows[0].homeowner_participant_id,
  };
}

async function createEvaluation(pool, identities, fixture, suffix) {
  const result = await createOrdinaryJobEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    content: evaluationContent(`Visit evaluation ${suffix}`),
    expectedVersion: 0,
    idempotencyKey: `visit-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(result.ok, true, result.code);
  return result.evaluation;
}

async function createCanonicalWorkstream(pool, identities, fixture, suffix, sequence) {
  const result = await createWorkstream({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    title: `Visit workstream ${suffix} ${sequence}`,
    sequence,
    idempotencyKey: `visit-workstream-${suffix}-${sequence}`,
    logger: quiet,
  });
  assert.equal(result.ok, true, result.code);
  return result.workstream;
}

function quoteCommand(service, pool, actorId, values, idempotencyKey) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey,
    logger: quiet,
    ...values,
  });
}

async function createApprovedQuoteDecision(pool, identities, fixture, suffix) {
  const created = await quoteCommand(
    createDraftQuote,
    pool,
    identities.professionalId,
    { jobId: fixture.jobId, currency: "USD" },
    `visit-quote-create-${suffix}`
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
        description: "Governed synthetic approved work",
        quantity: 1,
        unitAmountMinor: 10000,
        source: { type: "MANUAL_PROFESSIONAL" },
      },
    },
    `visit-quote-scope-${suffix}`
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
    `visit-quote-issue-${suffix}`
  );
  assert.equal(issued.ok, true, issued.code);

  const approved = await quoteCommand(
    approveIssuedQuote,
    pool,
    identities.homeownerId,
    {
      quoteId: issued.quote.id,
      expectedIssuedVersion: issued.quote.currentVersion,
    },
    `visit-quote-approve-${suffix}`
  );
  assert.equal(approved.ok, true, approved.code);

  const decision = await pool.query(
    `SELECT id, job_id, decision
     FROM canonical_quote_customer_decisions
     WHERE quote_id = $1`,
    [issued.quote.id]
  );
  return decision.rows[0];
}

async function insertVisitCommand(
  client,
  fixture,
  { actor = "professional", commandName = "visit.propose", scope, key } = {}
) {
  const id = randomUUID();
  const participantId = actor === "customer"
    ? fixture.homeownerParticipantId
    : fixture.professionalParticipantId;
  const commandScope = scope || `job:${fixture.jobId}:visits`;
  const idempotencyKey = key || randomUUID();
  await client.query(
    `INSERT INTO canonical_visit_command_idempotency (
       id, actor_participant_id, job_id, command_name,
       command_scope, idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      participantId,
      fixture.jobId,
      commandName,
      commandScope,
      idempotencyKey,
      fingerprint({ commandName, commandScope, idempotencyKey }),
    ]
  );
  return { id, participantId, idempotencyKey };
}

async function insertVisitIdentity(
  client,
  fixture,
  purpose,
  { approvedDecision = null, command = null } = {}
) {
  const visitId = randomUUID();
  const visitCommand = command || await insertVisitCommand(client, fixture);
  await client.query(
    `INSERT INTO canonical_visits (
       id, job_id, purpose, created_by_participant_id,
       created_command_idempotency_id,
       approved_quote_decision_id, approved_quote_decision
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      visitId,
      fixture.jobId,
      purpose,
      visitCommand.participantId,
      visitCommand.id,
      approvedDecision?.id || null,
      approvedDecision?.decision || null,
    ]
  );
  return { id: visitId, command: visitCommand };
}

async function insertVisitVersion(
  client,
  fixture,
  visit,
  {
    version = 1,
    state = "PROPOSED",
    start = "2026-08-14T13:00:00.000Z",
    end = "2026-08-14T14:00:00.000Z",
    timeZone = "America/New_York",
    locationMode = "JOB_SERVICE_LOCATION",
    cancellationReason = null,
    cancelledAt = null,
    completedAt = null,
    command = visit.command,
  } = {}
) {
  await client.query(
    `INSERT INTO canonical_visit_versions (
       visit_id, version, job_id, state,
       scheduled_start_at, scheduled_end_at, time_zone, location_mode,
       cancellation_reason, cancelled_at, completed_at,
       recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14
     )`,
    [
      visit.id,
      version,
      fixture.jobId,
      state,
      start,
      end,
      timeZone,
      locationMode,
      cancellationReason,
      cancelledAt,
      completedAt,
      command.participantId,
      command.id,
      fingerprint({ visitId: visit.id, version, state, start, end, timeZone }),
    ]
  );
}

async function insertProposedVisit(client, fixture, purpose, options = {}) {
  const visit = await insertVisitIdentity(client, fixture, purpose, options);
  await insertVisitVersion(client, fixture, visit);
  await client.query(
    `INSERT INTO canonical_visit_events (
       id, visit_id, visit_version, previous_visit_version, job_id,
       event_type, visit_state, recorded_by_participant_id,
       command_idempotency_id
     ) VALUES ($1, $2, 1, NULL, $3, 'VISIT_PROPOSED', 'PROPOSED', $4, $5)`,
    [
      randomUUID(),
      visit.id,
      fixture.jobId,
      visit.command.participantId,
      visit.command.id,
    ]
  );
  return visit;
}

async function insertVisitEvent(
  client,
  fixture,
  visit,
  {
    eventType,
    visitVersion,
    previousVisitVersion,
    visitState,
    command,
    reason = null,
  }
) {
  await client.query(
    `INSERT INTO canonical_visit_events (
       id, visit_id, visit_version, previous_visit_version, job_id,
       event_type, visit_state, reason, recorded_by_participant_id,
       command_idempotency_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      visit.id,
      visitVersion,
      previousVisitVersion,
      fixture.jobId,
      eventType,
      visitState,
      reason,
      command.participantId,
      command.id,
    ]
  );
}

async function expectDatabaseRejection(client, statement, values, expectedCode) {
  const savepoint = `visit_${randomUUID().replaceAll("-", "")}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await assert.rejects(
      client.query(statement, values),
      (error) => error?.code === expectedCode
    );
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

test(
  "clean disposable PostgreSQL certifies canonical Visit persistence constraints",
  { skip: !cleanDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: cleanDatabaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 39);
      const applied = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(applied.success, true);
      assert.equal(applied.applied.length, 39);

      const replay = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata(cleanDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.equal(replay.skipped.length, 39);

      const empty = await pool.query(
        `SELECT
           (SELECT count(*) FROM canonical_visits)::integer AS visits,
           (SELECT count(*) FROM canonical_visit_versions)::integer AS versions,
           (SELECT count(*) FROM canonical_visit_events)::integer AS events`
      );
      assert.deepEqual(empty.rows[0], { visits: 0, versions: 0, events: 0 });

      const capabilities = await pool.query(
        `SELECT count(*)::integer AS capability_count
         FROM lifecycle_capabilities
         WHERE capability LIKE 'visit.%'`
      );
      assert.equal(capabilities.rows[0].capability_count, 7);

      const identities = await createIdentities(pool, suffix);
      const firstJob = await createLifecycleFixture(pool, identities, `${suffix}-a`);
      const secondJob = await createLifecycleFixture(pool, identities, `${suffix}-b`);
      const firstEvaluation = await createEvaluation(
        pool,
        identities,
        firstJob,
        `${suffix}-a`
      );
      const secondEvaluation = await createEvaluation(
        pool,
        identities,
        secondJob,
        `${suffix}-b`
      );
      const firstWorkstream = await createCanonicalWorkstream(
        pool,
        identities,
        firstJob,
        `${suffix}-a`,
        1
      );
      const secondWorkstream = await createCanonicalWorkstream(
        pool,
        identities,
        firstJob,
        `${suffix}-a`,
        2
      );
      const crossWorkstream = await createCanonicalWorkstream(
        pool,
        identities,
        secondJob,
        `${suffix}-b`,
        1
      );
      const firstDecision = await createApprovedQuoteDecision(
        pool,
        identities,
        firstJob,
        `${suffix}-a`
      );
      const secondDecision = await createApprovedQuoteDecision(
        pool,
        identities,
        secondJob,
        `${suffix}-b`
      );

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const evaluationVisitA = await insertProposedVisit(
          client,
          firstJob,
          "EVALUATION"
        );
        const evaluationVisitB = await insertProposedVisit(
          client,
          firstJob,
          "EVALUATION"
        );
        const crossEvaluationAttemptVisit = await insertProposedVisit(
          client,
          firstJob,
          "EVALUATION"
        );
        const followUpVisit = await insertProposedVisit(
          client,
          firstJob,
          "FOLLOW_UP"
        );
        const approvedWorkVisit = await insertProposedVisit(
          client,
          firstJob,
          "APPROVED_WORK",
          { approvedDecision: firstDecision }
        );

        const changeRequestCommand = await insertVisitCommand(client, firstJob, {
          actor: "customer",
          commandName: "visit.change_request",
          scope: `visit:${evaluationVisitA.id}`,
        });
        await insertVisitEvent(client, firstJob, evaluationVisitA, {
          eventType: "VISIT_CHANGE_REQUESTED",
          visitVersion: 1,
          previousVisitVersion: 1,
          visitState: "PROPOSED",
          command: changeRequestCommand,
          reason: "Customer requested a different proposed time.",
        });
        const unchangedSchedule = await client.query(
          `SELECT count(*)::integer AS version_count
           FROM canonical_visit_versions
           WHERE visit_id = $1`,
          [evaluationVisitA.id]
        );
        assert.equal(unchangedSchedule.rows[0].version_count, 1);

        const confirmCommand = await insertVisitCommand(client, firstJob, {
          actor: "customer",
          commandName: "visit.confirm",
          scope: `visit:${followUpVisit.id}`,
        });
        await insertVisitVersion(client, firstJob, followUpVisit, {
          version: 2,
          state: "SCHEDULED",
          command: confirmCommand,
        });
        await insertVisitEvent(client, firstJob, followUpVisit, {
          eventType: "VISIT_CONFIRMED",
          visitVersion: 2,
          previousVisitVersion: 1,
          visitState: "SCHEDULED",
          command: confirmCommand,
        });

        const rescheduleCommand = await insertVisitCommand(client, firstJob, {
          commandName: "visit.reschedule",
          scope: `visit:${followUpVisit.id}`,
        });
        await insertVisitVersion(client, firstJob, followUpVisit, {
          version: 3,
          state: "SCHEDULED",
          start: "2026-08-15T13:00:00.000Z",
          end: "2026-08-15T14:00:00.000Z",
          command: rescheduleCommand,
        });
        await insertVisitEvent(client, firstJob, followUpVisit, {
          eventType: "VISIT_RESCHEDULED",
          visitVersion: 3,
          previousVisitVersion: 2,
          visitState: "SCHEDULED",
          command: rescheduleCommand,
          reason: "Customer requested Friday instead of Thursday.",
        });

        const completeCommand = await insertVisitCommand(client, firstJob, {
          commandName: "visit.complete",
          scope: `visit:${followUpVisit.id}`,
        });
        await insertVisitVersion(client, firstJob, followUpVisit, {
          version: 4,
          state: "COMPLETED",
          start: "2026-08-15T13:00:00.000Z",
          end: "2026-08-15T14:00:00.000Z",
          completedAt: "2026-08-15T14:00:00.000Z",
          command: completeCommand,
        });
        await insertVisitEvent(client, firstJob, followUpVisit, {
          eventType: "VISIT_COMPLETED",
          visitVersion: 4,
          previousVisitVersion: 3,
          visitState: "COMPLETED",
          command: completeCommand,
        });

        const cancelCommand = await insertVisitCommand(client, firstJob, {
          commandName: "visit.cancel",
          scope: `visit:${evaluationVisitB.id}`,
        });
        await insertVisitVersion(client, firstJob, evaluationVisitB, {
          version: 2,
          state: "CANCELLED",
          cancellationReason: "Professional cancelled the proposed Visit.",
          cancelledAt: "2026-08-13T18:00:00.000Z",
          command: cancelCommand,
        });
        await insertVisitEvent(client, firstJob, evaluationVisitB, {
          eventType: "VISIT_CANCELLED",
          visitVersion: 2,
          previousVisitVersion: 1,
          visitState: "CANCELLED",
          command: cancelCommand,
          reason: "Professional cancelled the proposed Visit.",
        });

        const latest = await client.query(
          `SELECT version, state, scheduled_start_at
           FROM canonical_visit_versions
           WHERE visit_id = $1
           ORDER BY version DESC
           LIMIT 1`,
          [followUpVisit.id]
        );
        assert.equal(Number(latest.rows[0].version), 4);
        assert.equal(latest.rows[0].state, "COMPLETED");

        const visitCount = await client.query(
          `SELECT count(*)::integer AS count
           FROM canonical_visits WHERE job_id = $1`,
          [firstJob.jobId]
        );
        assert.equal(visitCount.rows[0].count, 5);

        for (const purpose of ["COMPLETION", "OTHER"]) {
          const invalidPurposeCommand = await insertVisitCommand(
            client,
            firstJob
          );
          await expectDatabaseRejection(
            client,
            `INSERT INTO canonical_visits (
               id, job_id, purpose, created_by_participant_id,
               created_command_idempotency_id
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
              randomUUID(),
              firstJob.jobId,
              purpose,
              invalidPurposeCommand.participantId,
              invalidPurposeCommand.id,
            ],
            "23514"
          );
        }

        const invalidApprovedCommand = await insertVisitCommand(client, firstJob);
        await expectDatabaseRejection(
          client,
          `INSERT INTO canonical_visits (
             id, job_id, purpose, created_by_participant_id,
             created_command_idempotency_id
           ) VALUES ($1, $2, 'APPROVED_WORK', $3, $4)`,
          [
            randomUUID(),
            firstJob.jobId,
            invalidApprovedCommand.participantId,
            invalidApprovedCommand.id,
          ],
          "23514"
        );

        const crossDecisionCommand = await insertVisitCommand(client, firstJob);
        await expectDatabaseRejection(
          client,
          `INSERT INTO canonical_visits (
             id, job_id, purpose, created_by_participant_id,
             created_command_idempotency_id,
             approved_quote_decision_id, approved_quote_decision
           ) VALUES ($1, $2, 'APPROVED_WORK', $3, $4, $5, 'APPROVED')`,
          [
            randomUUID(),
            firstJob.jobId,
            crossDecisionCommand.participantId,
            crossDecisionCommand.id,
            secondDecision.id,
          ],
          "23503"
        );

        for (const state of ["RESCHEDULED", "PAUSED"]) {
          const invalidVersionCommand = await insertVisitCommand(
            client,
            firstJob,
            {
              commandName: "visit.reschedule",
              scope: `visit:${followUpVisit.id}`,
            }
          );
          await expectDatabaseRejection(
            client,
            `INSERT INTO canonical_visit_versions (
               visit_id, version, job_id, state,
               scheduled_start_at, scheduled_end_at, time_zone, location_mode,
               recorded_by_participant_id, command_idempotency_id,
               integrity_hash
             ) VALUES ($1, 5, $2, $3, $4, $5, 'America/New_York',
               'JOB_SERVICE_LOCATION', $6, $7, $8)`,
            [
              followUpVisit.id,
              firstJob.jobId,
              state,
              "2026-08-15T13:00:00.000Z",
              "2026-08-15T14:00:00.000Z",
              invalidVersionCommand.participantId,
              invalidVersionCommand.id,
              fingerprint({ invalid: state }),
            ],
            "23514"
          );
        }

        await expectDatabaseRejection(
          client,
          `INSERT INTO canonical_visit_versions (
             visit_id, version, job_id, state,
             scheduled_start_at, scheduled_end_at, time_zone, location_mode,
             recorded_by_participant_id, command_idempotency_id, integrity_hash
           ) VALUES ($1, 1, $2, 'PROPOSED', $3, $4, 'America/New_York',
             'JOB_SERVICE_LOCATION', $5, $6, $7)`,
          [
            followUpVisit.id,
            firstJob.jobId,
            "2026-08-14T13:00:00.000Z",
            "2026-08-14T14:00:00.000Z",
            followUpVisit.command.participantId,
            followUpVisit.command.id,
            fingerprint({ duplicate: "version" }),
          ],
          "23505"
        );

        for (const [timeZone, start, end] of [
          ["", "2026-08-16T13:00:00.000Z", "2026-08-16T14:00:00.000Z"],
          ["America/New_York", "2026-08-16T13:00:00.000Z", "2026-08-16T13:00:00.000Z"],
          ["America/New_York", "2026-08-16T13:00:00.000Z", "2026-08-16T12:00:00.000Z"],
        ]) {
          const command = await insertVisitCommand(client, firstJob, {
            commandName: "visit.reschedule",
            scope: `visit:${followUpVisit.id}`,
          });
          await expectDatabaseRejection(
            client,
            `INSERT INTO canonical_visit_versions (
               visit_id, version, job_id, state,
               scheduled_start_at, scheduled_end_at, time_zone, location_mode,
               recorded_by_participant_id, command_idempotency_id, integrity_hash
             ) VALUES ($1, 5, $2, 'SCHEDULED', $3, $4, $5,
               'REMOTE', $6, $7, $8)`,
            [
              followUpVisit.id,
              firstJob.jobId,
              start,
              end,
              timeZone,
              command.participantId,
              command.id,
              fingerprint({ timeZone, start, end }),
            ],
            "23514"
          );
        }

        await client.query(
          `INSERT INTO canonical_visit_evaluation_links (
             visit_id, job_id, evaluation_id,
             linked_by_participant_id, command_idempotency_id
           ) VALUES
             ($1, $3, $4, $5, $6),
             ($2, $3, $4, $5, $7)`,
          [
            evaluationVisitA.id,
            evaluationVisitB.id,
            firstJob.jobId,
            firstEvaluation.id,
            firstJob.professionalParticipantId,
            evaluationVisitA.command.id,
            evaluationVisitB.command.id,
          ]
        );

        await expectDatabaseRejection(
          client,
          `INSERT INTO canonical_visit_evaluation_links (
             visit_id, job_id, evaluation_id,
             linked_by_participant_id, command_idempotency_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            crossEvaluationAttemptVisit.id,
            firstJob.jobId,
            secondEvaluation.id,
            firstJob.professionalParticipantId,
            crossEvaluationAttemptVisit.command.id,
          ],
          "23503"
        );

        await client.query(
          `INSERT INTO canonical_visit_workstream_links (
             visit_id, workstream_id, job_id,
             linked_by_participant_id, command_idempotency_id
           ) VALUES
             ($1, $3, $5, $6, $7),
             ($1, $4, $5, $6, $7),
             ($2, $3, $5, $6, $8)`,
          [
            approvedWorkVisit.id,
            followUpVisit.id,
            firstWorkstream.id,
            secondWorkstream.id,
            firstJob.jobId,
            firstJob.professionalParticipantId,
            approvedWorkVisit.command.id,
            followUpVisit.command.id,
          ]
        );

        await expectDatabaseRejection(
          client,
          `INSERT INTO canonical_visit_workstream_links (
             visit_id, workstream_id, job_id,
             linked_by_participant_id, command_idempotency_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            approvedWorkVisit.id,
            crossWorkstream.id,
            firstJob.jobId,
            firstJob.professionalParticipantId,
            approvedWorkVisit.command.id,
          ],
          "23503"
        );

        const duplicateKey = randomUUID();
        await insertVisitCommand(client, firstJob, {
          scope: `job:${firstJob.jobId}:visits`,
          key: duplicateKey,
        });
        await expectDatabaseRejection(
          client,
          `INSERT INTO canonical_visit_command_idempotency (
             id, actor_participant_id, job_id, command_name,
             command_scope, idempotency_key, request_fingerprint
           ) VALUES ($1, $2, $3, 'visit.propose', $4, $5, $6)`,
          [
            randomUUID(),
            firstJob.professionalParticipantId,
            firstJob.jobId,
            `job:${firstJob.jobId}:visits`,
            duplicateKey,
            fingerprint({ duplicateKey }),
          ],
          "23505"
        );

        for (const [statement, values] of [
          [
            `UPDATE canonical_visits SET purpose = 'FOLLOW_UP' WHERE id = $1`,
            [evaluationVisitA.id],
          ],
          [
            `UPDATE canonical_visit_versions SET time_zone = 'UTC'
             WHERE visit_id = $1 AND version = 1`,
            [evaluationVisitA.id],
          ],
          [
            `DELETE FROM canonical_visit_events WHERE visit_id = $1`,
            [evaluationVisitA.id],
          ],
          [
            `DELETE FROM canonical_visit_evaluation_links WHERE visit_id = $1`,
            [evaluationVisitA.id],
          ],
          [
            `DELETE FROM canonical_visit_workstream_links
             WHERE visit_id = $1 AND workstream_id = $2`,
            [approvedWorkVisit.id, firstWorkstream.id],
          ],
        ]) {
          await expectDatabaseRejection(client, statement, values, "55000");
        }

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }
);

test(
  "staging-equivalent upgrade adds Visit schema without backfill or grants",
  { skip: !upgradeDatabaseUrl },
  async () => {
    const pool = new Pool({ connectionString: upgradeDatabaseUrl, max: 4 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const priorMigrations = migrations.filter(
        ({ filename }) => filename < migrationName
      );
      const visitMigration = migrations.filter(
        ({ filename }) => filename === migrationName
      );
      assert.equal(priorMigrations.length, 35);
      assert.equal(visitMigration.length, 1);

      const prior = await runMigrationCollection(
        pool,
        priorMigrations,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(prior.success, true);
      assert.equal(prior.applied.length, 35);

      const identities = await createIdentities(pool, suffix);
      const existingJob = await createLifecycleFixture(pool, identities, suffix);
      const before = await pool.query(
        `SELECT count(*)::integer AS jobs FROM jobs`
      );
      assert.equal(before.rows[0].jobs, 1);

      const upgraded = await runMigrationCollection(
        pool,
        visitMigration,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(upgraded.success, true);
      assert.deepEqual(upgraded.applied, [migrationName]);

      const after = await pool.query(
        `SELECT
           (SELECT count(*) FROM jobs)::integer AS jobs,
           (SELECT count(*) FROM canonical_visits)::integer AS visits,
           (SELECT count(*) FROM canonical_visit_versions)::integer AS versions,
           (SELECT count(*) FROM canonical_visit_events)::integer AS events,
           (SELECT count(*) FROM lifecycle_authority_grants
             WHERE capability LIKE 'visit.%')::integer AS visit_grants`
      );
      assert.deepEqual(after.rows[0], {
        jobs: 1,
        visits: 0,
        versions: 0,
        events: 0,
        visit_grants: 0,
      });

      const preserved = await pool.query(
        `SELECT id, job_request_id, source_request_relationship_id
         FROM jobs WHERE id = $1`,
        [existingJob.jobId]
      );
      assert.equal(preserved.rows.length, 1);

      const replay = await runMigrationCollection(
        pool,
        visitMigration,
        targetMetadata(upgradeDatabaseUrl)
      );
      assert.equal(replay.success, true);
      assert.deepEqual(replay.skipped, [migrationName]);
    } finally {
      await pool.end();
    }
  }
);
