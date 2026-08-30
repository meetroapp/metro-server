"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitEvaluation,
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  completeEvaluation,
} = require("../server/authorization/evaluationService");
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
  activateApprovedWorkVisitAuthority,
} = require("../server/workflow/approvedWorkVisitService");
const {
  cancelVisit,
  confirmVisit,
  proposeVisit,
  requestVisitChange,
  rescheduleVisit,
} = require("../server/workflow/visitService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.ALERT_B1_DATABASE_URL;
const clock = () => new Date("2026-08-13T12:00:00.000Z");

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

function command(service, pool, actorId, values, idempotencyKey = randomUUID()) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey,
    logger: quiet,
    clock,
    ...values,
  });
}

function quoteCommand(service, pool, actorId, values, idempotencyKey = randomUUID()) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey,
    logger: quiet,
    ...values,
  });
}

function evaluationProposal(fixture, hour = 13) {
  return {
    jobId: fixture.jobId,
    purpose: "EVALUATION",
    scheduledStartAt: `2026-08-20T${String(hour).padStart(2, "0")}:00:00.000Z`,
    scheduledEndAt: `2026-08-20T${String(hour + 1).padStart(2, "0")}:00:00.000Z`,
    timeZone: "America/New_York",
    locationMode: "JOB_SERVICE_LOCATION",
  };
}

function approvedWorkProposal(fixture, decision, hour = 16) {
  return {
    ...evaluationProposal(fixture, hour),
    purpose: "APPROVED_WORK",
    approvedQuoteDecisionId: decision.id,
  };
}

async function visitAlerts(pool, visitId) {
  const result = await pool.query(
    `SELECT recipient_user_id, source_event_type, lifecycle_state,
      canonical_event_key, destination_type, destination_payload
     FROM alerts
     WHERE source_domain = 'workflow'
       AND source_entity_type = 'visit'
       AND source_entity_id = $1
     ORDER BY id`,
    [visitId]
  );
  return result.rows.map((row) => ({
    recipient: Number(row.recipient_user_id),
    event: row.source_event_type,
    state: row.lifecycle_state,
    key: row.canonical_event_key,
    destinationType: row.destination_type,
    destination: row.destination_payload,
  }));
}

test(
  "Alert-B1 certifies Evaluation and Approved Work Visit counterpart attention",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300006_create_business_job_assignment_authority.sql");
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, migrated.errorCode);
      assert.equal(migrated.applied.length, migrations.length);

      const identities = await createVisitTestIdentities(pool, suffix);
      const evaluationFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-evaluation`
      );
      const approvedFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-approved`
      );
      const relationshipAlerts = await pool.query(
        `SELECT recipient_user_id, source_event_type, lifecycle_state,
          canonical_event_key, destination_type
         FROM alerts
         WHERE source_event_type IN (
           'request.professional_response_submitted',
           'request.professional_selected'
         )
         ORDER BY id`
      );
      assert.deepEqual(relationshipAlerts.rows.map((row) => ({
        recipient: Number(row.recipient_user_id),
        event: row.source_event_type,
        state: row.lifecycle_state,
        destination: row.destination_type,
      })), [
        { recipient: identities.homeownerId, event: "request.professional_response_submitted", state: "resolved", destination: "request" },
        { recipient: identities.professionalId, event: "request.professional_selected", state: "active", destination: "conversation" },
        { recipient: identities.homeownerId, event: "request.professional_response_submitted", state: "resolved", destination: "request" },
        { recipient: identities.professionalId, event: "request.professional_selected", state: "active", destination: "conversation" },
      ]);
      assert.equal(
        relationshipAlerts.rows.every((row) => /^[0-9a-f]{64}$/.test(row.canonical_event_key)),
        true
      );

      const proposalKey = randomUUID();
      const proposed = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        evaluationProposal(evaluationFixture),
        proposalKey
      );
      assert.equal(proposed.code, "VISIT_PROPOSED");
      const proposalReplay = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        evaluationProposal(evaluationFixture),
        proposalKey
      );
      assert.equal(proposalReplay.replayed, true);
      assert.deepEqual((await visitAlerts(pool, proposed.visit.id)).map(({ recipient, event, state }) => ({
        recipient,
        event,
        state,
      })), [
        { recipient: identities.homeownerId, event: "visit.proposed", state: "active" },
      ]);

      const confirmed = await command(
        confirmVisit,
        pool,
        identities.homeownerId,
        { jobId: evaluationFixture.jobId, visitId: proposed.visit.id, expectedVersion: 1 }
      );
      assert.equal(confirmed.code, "VISIT_CONFIRMED");
      const changed = await command(
        requestVisitChange,
        pool,
        identities.homeownerId,
        {
          jobId: evaluationFixture.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          reason: "Please use the afternoon schedule.",
        }
      );
      assert.equal(changed.code, "VISIT_CHANGE_REQUESTED");
      const rescheduled = await command(
        rescheduleVisit,
        pool,
        identities.professionalId,
        {
          jobId: evaluationFixture.jobId,
          visitId: proposed.visit.id,
          expectedVersion: 2,
          scheduledStartAt: "2026-08-21T17:00:00.000Z",
          scheduledEndAt: "2026-08-21T18:00:00.000Z",
          timeZone: "America/New_York",
          locationMode: "REMOTE",
          reason: "Accepted the requested afternoon schedule.",
        }
      );
      assert.equal(rescheduled.code, "VISIT_SCHEDULE_PROPOSED");
      const evaluationAlerts = await visitAlerts(pool, proposed.visit.id);
      assert.deepEqual(evaluationAlerts.map(({ recipient, event, state }) => ({
        recipient,
        event,
        state,
      })), [
        { recipient: identities.homeownerId, event: "visit.proposed", state: "resolved" },
        { recipient: identities.professionalId, event: "visit.confirmed", state: "active" },
        { recipient: identities.professionalId, event: "visit.change_requested", state: "resolved" },
        { recipient: identities.homeownerId, event: "visit.schedule_proposed", state: "active" },
      ]);

      const approvedEvaluation = await createVisitEvaluation(
        pool,
        identities,
        approvedFixture,
        `${suffix}-approved`
      );
      const completedEvaluation = await completeEvaluation({
        pool,
        authenticatedActor: { id: identities.professionalId },
        evaluationId: approvedEvaluation.id,
        expectedVersion: 1,
        completionMode: "REMOTE",
        assessmentMethod: "PHONE",
        assessmentBasis: "Reviewed the approved-work fixture with the customer by phone.",
        idempotencyKey: randomUUID(),
        logger: quiet,
      });
      assert.equal(completedEvaluation.ok, true, completedEvaluation.code);
      const createdQuote = await quoteCommand(
        createDraftQuote,
        pool,
        identities.professionalId,
        { jobId: approvedFixture.jobId, currency: "USD" }
      );
      assert.equal(createdQuote.ok, true, createdQuote.code);
      const scopedQuote = await quoteCommand(
        addDraftScopeItem,
        pool,
        identities.professionalId,
        {
          quoteId: createdQuote.quote.id,
          expectedVersion: createdQuote.quote.currentVersion,
          item: {
            classification: "LABOR_SERVICE",
            scopeSemantic: "FUTURE_WORK",
            materialResponsibility: "NOT_APPLICABLE",
            description: "Governed Alert-B1 approved work",
            quantity: 1,
            unitAmountMinor: 10000,
            source: { type: "MANUAL_PROFESSIONAL" },
          },
        }
      );
      assert.equal(scopedQuote.ok, true, scopedQuote.code);
      const issuedQuote = await quoteCommand(
        issueQuote,
        pool,
        identities.professionalId,
        {
          quoteId: scopedQuote.quote.id,
          expectedVersion: scopedQuote.quote.currentVersion,
        }
      );
      assert.equal(issuedQuote.ok, true, issuedQuote.code);
      const deliveredQuote = await quoteCommand(
        sendQuoteInMeetro,
        pool,
        identities.professionalId,
        {
          quoteId: issuedQuote.quote.id,
          expectedIssuedVersion: issuedQuote.quote.currentVersion,
        }
      );
      assert.equal(deliveredQuote.ok, true, deliveredQuote.code);
      const approvedQuote = await quoteCommand(
        approveIssuedQuote,
        pool,
        identities.homeownerId,
        {
          quoteId: issuedQuote.quote.id,
          expectedIssuedVersion: issuedQuote.quote.currentVersion,
        }
      );
      assert.equal(approvedQuote.ok, true, approvedQuote.code);
      const quoteAlerts = await pool.query(
        `SELECT recipient_user_id, source_event_type, lifecycle_state,
          canonical_event_key, destination_type, destination_payload
         FROM alerts
         WHERE source_entity_type = 'quote' AND source_entity_id = $1
         ORDER BY id`,
        [issuedQuote.quote.id]
      );
      assert.deepEqual(quoteAlerts.rows.map((row) => ({
        recipient: Number(row.recipient_user_id),
        event: row.source_event_type,
        state: row.lifecycle_state,
        destination: row.destination_type,
      })), [
        { recipient: identities.homeownerId, event: "quote.delivered", state: "resolved", destination: "quote" },
        { recipient: identities.professionalId, event: "quote.customer_approved", state: "active", destination: "conversation" },
      ]);
      for (const row of quoteAlerts.rows) {
        assert.match(row.canonical_event_key, /^[0-9a-f]{64}$/);
      }
      const decisionResult = await pool.query(
        `SELECT id, quote_id, job_id, decision
         FROM canonical_quote_customer_decisions
         WHERE quote_id = $1`,
        [issuedQuote.quote.id]
      );
      const decision = decisionResult.rows[0];
      const activated = await activateApprovedWorkVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: approvedFixture.jobId,
        quoteId: decision.quote_id,
        idempotencyKey: randomUUID(),
        logger: quiet,
      });
      assert.equal(activated.code, "APPROVED_WORK_VISIT_AUTHORITY_ACTIVATED");

      const approvedProposed = await command(
        proposeVisit,
        pool,
        identities.professionalId,
        approvedWorkProposal(approvedFixture, decision)
      );
      assert.equal(approvedProposed.code, "VISIT_PROPOSED");
      const approvedCancelled = await command(
        cancelVisit,
        pool,
        identities.professionalId,
        {
          jobId: approvedFixture.jobId,
          visitId: approvedProposed.visit.id,
          expectedVersion: 1,
          reason: "Approved-work Visit cancelled with canonical authority.",
        }
      );
      assert.equal(approvedCancelled.code, "VISIT_CANCELLED");
      const approvedAlerts = await visitAlerts(pool, approvedProposed.visit.id);
      assert.deepEqual(approvedAlerts.map(({ recipient, event, state }) => ({
        recipient,
        event,
        state,
      })), [
        { recipient: identities.homeownerId, event: "visit.proposed", state: "resolved" },
        { recipient: identities.homeownerId, event: "visit.cancelled", state: "active" },
      ]);

      for (const alert of [...evaluationAlerts, ...approvedAlerts]) {
        assert.match(alert.key, /^[0-9a-f]{64}$/);
        assert.equal(alert.destinationType, "visit");
        assert.equal(alert.destination.visitId === proposed.visit.id ||
          alert.destination.visitId === approvedProposed.visit.id, true);
        assert.equal(
          alert.destination.jobId === evaluationFixture.jobId ||
            alert.destination.jobId === approvedFixture.jobId,
          true
        );
        assert.equal(Number.isSafeInteger(alert.destination.requestId), true);
        assert.equal(Number.isSafeInteger(alert.destination.conversationId), true);
      }
    } finally {
      await pool.end();
    }
  }
);
