"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  VISIT_CAPABILITIES,
  VISIT_COMMANDS,
  VISIT_LOCATION_MODES,
  VISIT_PURPOSES,
  VISIT_STATES,
  completeVisit,
  proposeVisit,
  rescheduleVisit,
  visitServiceInternals,
} = require("../server/workflow/visitService");

const serviceSource = readFileSync(
  join(__dirname, "..", "server", "workflow", "visitService.js"),
  "utf8"
);
const indexSource = readFileSync(join(__dirname, "..", "index.js"), "utf8");

test("Visit runtime vocabulary exactly preserves the approved authority contract", () => {
  assert.deepEqual(VISIT_PURPOSES, ["EVALUATION", "APPROVED_WORK", "FOLLOW_UP"]);
  assert.deepEqual(VISIT_STATES, ["PROPOSED", "SCHEDULED", "CANCELLED", "COMPLETED"]);
  assert.deepEqual(VISIT_LOCATION_MODES, ["JOB_SERVICE_LOCATION", "REMOTE"]);
  assert.deepEqual(Object.values(VISIT_CAPABILITIES).sort(), [
    "visit.cancel",
    "visit.change_request",
    "visit.complete",
    "visit.confirm",
    "visit.propose",
    "visit.read",
    "visit.reschedule",
  ]);
  assert.deepEqual(Object.values(VISIT_COMMANDS).sort(), [
    "visit.cancel",
    "visit.change_request",
    "visit.complete",
    "visit.confirm",
    "visit.link_evaluation",
    "visit.propose",
    "visit.reschedule",
  ]);
  assert.equal(VISIT_PURPOSES.includes("COMPLETION"), false);
  assert.equal(VISIT_PURPOSES.includes("OTHER"), false);
  assert.equal(VISIT_STATES.includes("RESCHEDULED"), false);
});

test("Visit scheduling requires offset instants, ordered bounds, and a canonical IANA zone", () => {
  assert.equal(
    visitServiceInternals.strictInstant("2026-08-20T13:00:00"),
    null
  );
  assert.equal(
    visitServiceInternals.strictInstant("2026-02-30T13:00:00.000Z"),
    null
  );
  assert.equal(
    visitServiceInternals.strictInstant("2026-08-20T13:00:00-04:00"),
    "2026-08-20T17:00:00.000Z"
  );
  assert.equal(visitServiceInternals.canonicalTimeZone("America/New_York"), "America/New_York");
  assert.equal(visitServiceInternals.canonicalTimeZone("Not/A_Zone"), null);
  assert.equal(visitServiceInternals.normalizedSchedule({
    scheduledStartAt: "2026-08-20T13:00:00.000Z",
    scheduledEndAt: "2026-08-20T13:00:00.000Z",
    timeZone: "America/New_York",
    locationMode: "REMOTE",
  }), null);
});

test("invalid and browser-owned Visit authority fails before database access", async () => {
  const pool = { query() { throw new Error("database must not be reached"); } };
  const actor = { id: 7 };
  assert.equal((await proposeVisit({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    purpose: "COMPLETION",
    scheduledStartAt: "2026-08-20T13:00:00.000Z",
    scheduledEndAt: null,
    timeZone: "America/New_York",
    locationMode: "REMOTE",
    idempotencyKey: "proposal-key",
  })).code, "INVALID_VISIT_PROPOSAL");
  assert.equal((await rescheduleVisit({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    visitId: "00000000-0000-4000-8000-000000000002",
    expectedVersion: 1,
    scheduledStartAt: "2026-08-20T13:00:00",
    scheduledEndAt: null,
    timeZone: "America/New_York",
    locationMode: "REMOTE",
    idempotencyKey: "reschedule-key",
  })).code, "INVALID_VISIT_RESCHEDULE");
  assert.equal((await completeVisit({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    visitId: "00000000-0000-4000-8000-000000000002",
    expectedVersion: 1,
    state: "COMPLETED",
    idempotencyKey: "complete-key",
  })).code, "VISIT_AUTHORITY_FIELD_REJECTED");
  assert.equal((await proposeVisit({
    pool,
    authenticatedActor: actor,
    jobId: "00000000-0000-4000-8000-000000000001",
    purpose: "FOLLOW_UP",
    scheduledStartAt: "2026-08-20T13:00:00.000Z",
    scheduledEndAt: null,
    timeZone: "America/New_York",
    locationMode: "REMOTE",
    idempotencyKey: "past-proposal-key",
    clock: () => new Date("2026-08-21T13:00:00.000Z"),
  })).code, "VISIT_START_TIME_NOT_FUTURE");
});

test("canonical Visit DTO is an explicit allowlist with truthful actor actions", () => {
  const row = {
    id: "visit-id",
    job_id: "job-id",
    purpose: "EVALUATION",
    state: "PROPOSED",
    version: 1,
    scheduled_start_at: "2026-08-20T13:00:00.000Z",
    scheduled_end_at: null,
    time_zone: "America/New_York",
    location_mode: "REMOTE",
    cancellation_reason: null,
    cancelled_at: null,
    completed_at: null,
    evaluation_id: null,
    workstream_ids: [],
    approved_quote_decision_id: null,
    approved_quote_decision: null,
    created_by_participant_id: "professional-participant",
    recorded_by_participant_id: "professional-participant",
    created_at: "2026-08-13T12:00:00.000Z",
    version_created_at: "2026-08-13T12:00:00.000Z",
    request_fingerprint: "must-not-leak",
    command_idempotency_id: "must-not-leak",
    integrity_hash: "must-not-leak",
    future_sentinel: "must-not-leak",
  };
  const context = {
    actor_user_id: 1,
    homeowner_user_id: 1,
    selected_professional_user_id: 2,
    actor_is_customer_representative: true,
    actor_is_primary_professional: false,
    active_visit_capabilities: [
      "visit.read",
      "visit.confirm",
      "visit.change_request",
    ],
  };
  const dto = visitServiceInternals.visitProjection(
    row,
    context,
    new Date("2026-08-13T12:00:00.000Z")
  );
  assert.deepEqual(Object.keys(dto), [
    "id",
    "jobId",
    "purpose",
    "state",
    "currentVersion",
    "scheduledStartAt",
    "scheduledEndAt",
    "timeZone",
    "locationMode",
    "cancellationReason",
    "cancelledAt",
    "completedAt",
    "evaluationId",
    "workstreamIds",
    "approvedQuoteDecisionEvidence",
    "createdByParticipantId",
    "recordedByParticipantId",
    "createdAt",
    "versionCreatedAt",
    "actions",
  ]);
  assert.deepEqual(dto.actions, {
    canConfirm: true,
    canRequestChange: true,
    canReschedule: false,
    canCancel: false,
    canComplete: false,
  });
  assert.equal(JSON.stringify(dto).includes("must-not-leak"), false);
});

test("Visit runtime registers routes without grants or adjacent lifecycle mutation", () => {
  assert.match(indexSource, /registerVisitRoutes\(\{/);
  assert.doesNotMatch(
    serviceSource,
    /INSERT INTO\s+(?:lifecycle_authority_grants|participant_role_assignments)/i
  );
  assert.doesNotMatch(
    serviceSource,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:jobs|canonical_evaluations|canonical_quotes|canonical_quote_customer_decisions|canonical_workstreams|canonical_work_activity_versions|workflow_events)/i
  );
  assert.doesNotMatch(
    serviceSource,
    /job\.complete|invoice\.|["'](?:COMPLETION|OTHER|RESCHEDULED)["']/i
  );
});
