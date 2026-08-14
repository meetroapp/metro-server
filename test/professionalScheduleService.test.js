"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getProfessionalSchedule,
  professionalScheduleInternals,
} = require("../server/workflow/professionalScheduleService");

const UUIDS = Object.freeze({
  job: "10000000-0000-4000-8000-000000000001",
  evaluation: "20000000-0000-4000-8000-000000000002",
  quote: "30000000-0000-4000-8000-000000000003",
  decision: "40000000-0000-4000-8000-000000000004",
  visitA: "50000000-0000-4000-8000-000000000005",
  visitB: "60000000-0000-4000-8000-000000000006",
});

function opportunity(overrides = {}) {
  return {
    purpose: "EVALUATION",
    job_id: UUIDS.job,
    evaluation_id: UUIDS.evaluation,
    quote_id: null,
    approved_quote_decision_id: null,
    authority_state: "ACTIVE",
    authority_activated_at: "2026-08-12T12:00:00.000Z",
    subject_updated_at: "2026-08-12T12:00:00.000Z",
    job_created_at: "2026-08-10T12:00:00.000Z",
    job_title: "Synthetic kitchen repair",
    job_category: "Handyman",
    customer_name: "QA Customer",
    location_normalization_status: "normalized",
    location_intake_mode: "address_after_selection",
    service_address_line1: null,
    service_city: "Brooklyn",
    service_region: "NY",
    service_postal_code: "11201",
    service_country_code: "US",
    discovery_area_label: "Brooklyn, NY",
    opportunity_total: "1",
    ...overrides,
  };
}

function visit(overrides = {}) {
  return {
    id: UUIDS.visitA,
    job_id: UUIDS.job,
    purpose: "EVALUATION",
    created_at: "2026-08-12T10:00:00.000Z",
    approved_quote_decision_id: null,
    approved_quote_decision: null,
    version: 2,
    state: "PROPOSED",
    scheduled_start_at: "2026-08-15T14:00:00.000Z",
    scheduled_end_at: "2026-08-15T15:00:00.000Z",
    time_zone: "America/New_York",
    location_mode: "JOB_SERVICE_LOCATION",
    cancellation_reason: null,
    cancelled_at: null,
    completed_at: null,
    version_created_at: "2026-08-12T11:00:00.000Z",
    evaluation_id: UUIDS.evaluation,
    job_title: "Synthetic kitchen repair",
    job_category: "Handyman",
    customer_name: "QA Customer",
    location_normalization_status: "normalized",
    location_intake_mode: "exact_on_file",
    service_address_line1: "1 Test Street",
    service_city: "Brooklyn",
    service_region: "NY",
    service_postal_code: "11201",
    service_country_code: "US",
    discovery_area_label: "Brooklyn, NY",
    change_request_reason: null,
    change_request_version: null,
    change_request_created_at: null,
    active_capabilities: ["visit.read", "visit.cancel"],
    waiting_on_customer_total: "1",
    change_requested_total: "0",
    upcoming_total: "0",
    ...overrides,
  };
}

function poolWith({ opportunities = [], visits = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("evaluation_opportunities AS")) return { rows: opportunities };
      if (text.includes("FROM canonical_visits visits")) return { rows: visits };
      throw new Error(`Unexpected Schedule query: ${text.slice(0, 80)}`);
    },
  };
}

test("active aggregate projects truthful opportunity, Visit, summary, identity, and privacy", async () => {
  const pool = poolWith({ opportunities: [opportunity()], visits: [visit()] });
  const result = await getProfessionalSchedule({
    pool,
    authenticatedActor: { id: 77 },
    view: "active",
    limit: 20,
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
  });

  assert.equal(result.code, "PROFESSIONAL_SCHEDULE_LOADED");
  assert.deepEqual(result.schedule.summary, {
    readyToSchedule: 1,
    waitingOnCustomer: 1,
    changeRequested: 0,
    upcoming: 0,
  });
  assert.equal(result.schedule.opportunities[0].semanticState, "READY_TO_SCHEDULE");
  assert.equal(result.schedule.opportunities[0].evaluationId, UUIDS.evaluation);
  assert.equal(result.schedule.opportunities[0].actions.canStartScheduling, true);
  assert.equal(result.schedule.opportunities[0].location.address, null);
  assert.equal(result.schedule.opportunities[0].location.serviceArea, "Brooklyn, NY");
  assert.equal(result.schedule.visits[0].semanticState, "WAITING_FOR_CUSTOMER");
  assert.equal(result.schedule.visits[0].actions.canCancel, true);
  assert.equal(result.schedule.visits[0].actions.canReschedule, false);
  assert.equal(result.schedule.visits[0].customer.displayName, "QA Customer");
  assert.equal("email" in result.schedule.visits[0].customer, false);
  assert.deepEqual(pool.calls.map(({ text }) => text.split(" ")[0]), ["BEGIN", "WITH", "WITH", "COMMIT"]);
  assert.equal(pool.calls.some(({ text }) => /\b(INSERT|UPDATE|DELETE)\b/.test(text)), false);
});

test("change-request evidence drives presentation without Visit detail fan-out", async () => {
  const row = visit({
    change_request_reason: "Please move this to Friday",
    change_request_version: 2,
    change_request_created_at: "2026-08-12T12:30:00.000Z",
    waiting_on_customer_total: "0",
    change_requested_total: "1",
  });
  const result = await getProfessionalSchedule({
    pool: poolWith({ visits: [row] }),
    authenticatedActor: { id: 77 },
    limit: 20,
  });
  assert.equal(result.schedule.visits[0].semanticState, "CHANGE_REQUESTED");
  assert.deepEqual(result.schedule.visits[0].latestCustomerChangeRequest, {
    visitVersion: 2,
    reason: "Please move this to Friday",
    createdAt: "2026-08-12T12:30:00.000Z",
  });
  assert.equal(result.schedule.summary.changeRequested, 1);
});

test("scheduled professional actions reuse state, time, and exact capability truth", () => {
  const projected = professionalScheduleInternals.visitProjection(visit({
    state: "SCHEDULED",
    active_capabilities: ["visit.read", "visit.reschedule", "visit.cancel", "visit.complete"],
  }), new Date("2026-08-16T12:00:00.000Z"));
  assert.equal(projected.semanticState, "SCHEDULED");
  assert.deepEqual(projected.actions, {
    canReschedule: true,
    canCancel: true,
    canComplete: true,
    canViewJob: true,
  });
  assert.equal("canConfirm" in projected.actions, false);
  assert.equal("canRequestChange" in projected.actions, false);
});

test("history view is bounded and deterministic with opaque cursor pagination", async () => {
  const earlier = visit({
    id: UUIDS.visitA,
    state: "CANCELLED",
    scheduled_start_at: "2026-08-10T12:00:00.000Z",
    cancelled_at: "2026-08-11T12:00:00.000Z",
  });
  const later = visit({
    id: UUIDS.visitB,
    state: "COMPLETED",
    scheduled_start_at: "2026-08-12T12:00:00.000Z",
    completed_at: "2026-08-13T12:00:00.000Z",
  });
  const first = await getProfessionalSchedule({
    pool: poolWith({ visits: [earlier, later] }),
    authenticatedActor: { id: 77 },
    view: "history",
    limit: 1,
  });
  assert.equal(first.schedule.visits[0].id, UUIDS.visitB);
  assert.equal(first.schedule.page.hasMore, true);
  assert.ok(first.schedule.page.nextCursor);

  const second = await getProfessionalSchedule({
    pool: poolWith({ visits: [earlier, later] }),
    authenticatedActor: { id: 77 },
    view: "history",
    limit: 1,
    cursor: first.schedule.page.nextCursor,
  });
  assert.equal(second.schedule.visits[0].id, UUIDS.visitA);
  assert.equal(second.schedule.page.hasMore, false);
});

test("SQL fails closed to exact professional roles, approved decisions, grants, and supported purposes", async () => {
  const pool = poolWith();
  await getProfessionalSchedule({ pool, authenticatedActor: { id: 77 } });
  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /relationships\.professional_user_id = \$1/);
  assert.match(sql, /professional_roles\.role = 'PRIMARY_PROFESSIONAL'/);
  assert.match(sql, /customer_roles\.role = 'CUSTOMER_REPRESENTATIVE'/);
  assert.match(sql, /decisions\.decision = 'APPROVED'/);
  assert.match(sql, /quotes\.status = 'ISSUED'/);
  assert.match(sql, /grants\.capability = 'visit\.read'/);
  assert.match(sql, /visits\.purpose IN \('EVALUATION','APPROVED_WORK'\)/);
  assert.doesNotMatch(sql, /FOLLOW_UP/);
});

test("invalid view, limit, cursor, and caller-supplied authority fail before database reads", async () => {
  const pool = poolWith();
  const inputs = [
    { view: "all" },
    { limit: 101 },
    { cursor: "not-a-cursor" },
    { professionalUserId: 77 },
  ];
  for (const extra of inputs) {
    const result = await getProfessionalSchedule({
      pool,
      authenticatedActor: { id: 77 },
      ...extra,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
  assert.equal(pool.calls.length, 0);
});
