"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { deriveEmergencyLiveJob } = require("../server/emergency/emergencyLiveJobProjection");
const { getCanonicalLiveJob } = require("../server/workflow/liveJobProjectionService");
const { listAuthorizedProfessionalJobs, professionalJobPickerInternals: picker } = require("../server/workflow/professionalJobPickerService");
const { EMERGENCY_LIFECYCLE_CONTEXT_SQL } = require("../server/emergency/emergencyCommercialContext");
const { historySummary } = require("../server/workflow/jobCompletionService");
const { jobSourcePresentation } = require("../server/workflow/jobSourcePresentation");
const JOB = "11111111-1111-4111-8111-111111111111";
const PROFESSIONAL = "22222222-2222-4222-8222-222222222222";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const instant = "2026-09-19T10:00:00.000Z";
// Server unit inputs follow the certified context and service projections;
// database-backed scenarios separately use the existing lifecycle fixture.
function context(overrides = {}) {
  return { job_id: JOB, source_type: "emergency_request", job_source_type: "emergency_request",
    source_context_type: "emergency_request", lifecycle_contract_version: 2, job_request_id: null,
    emergency_request_id: 45, job_emergency_request_id: 45, relationship_id: 123,
    relationship_status: "active", professional_user_id: 77, actor_user_id: 77,
    professional_participant_id: PROFESSIONAL, actor_participant_id: PROFESSIONAL,
    primary_role_active: true, customer_role_active: true, conversation_id: 91,
    conversation_status: "active", job_title: "Emergency leak", customer_name: "Customer",
    emergency_status: "professional_arrived", assigned_at: instant, en_route_at: instant, arrived_at: instant,
    job_created_at: instant, ...overrides };
}
function state(overrides = {}) {
  return { capabilities: ["participant.read", "quote.read", "quote.create", "quote.scope.manage", "evaluation.perform"],
    evaluation: null, completedEvaluation: null, quotes: [], issued: null, approval: null,
    depositGate: null, deposit: null, invoice: null, completionReview: null, ...overrides };
}
const completedEvaluation = { id: "evaluation", evaluation_version: 2, status: "completed" };
const issued = { id: QUOTE, currentVersion: 3, status: "ISSUED", decisionState: null, decisionVersion: null };
const approval = { quote_id: QUOTE, quote_approval_id: "approval", approval_source: "MEETRO_CUSTOMER", customer_decision_id: "decision" };
function approved(depositState, allowed) {
  return state({ completedEvaluation, issued, approval, quotes: [issued],
    depositGate: { state: depositState, allowed }, deposit: { state: depositState, schedulingLocked: !allowed } });
}
const cases = [
  ["Assigned", context({ emergency_status: "assigned", arrived_at: null }), state(), "ASSIGNED", "MARK_EN_ROUTE"],
  ["On the Way", context({ emergency_status: "professional_en_route", arrived_at: null }), state(), "ON_THE_WAY", "MARK_ARRIVED"],
  ["Arrived / Evaluation Required", context(), state(), "EVALUATION_NEEDED", "START_EVALUATION"],
  ["Evaluation In Progress", context(), state({ evaluation: { aggregate: { id: "evaluation", version: 1 }, evaluation: { status: "draft" } } }), "EVALUATION_IN_PROGRESS", "EDIT_EVALUATION"],
  ["Evaluation Complete / Quote Required", context(), state({ completedEvaluation }), "QUOTE_NEEDED", "CREATE_QUOTE"],
  ["Draft Quote", context(), state({ completedEvaluation, quotes: [{ status: "DRAFT", currentVersion: 1 }] }), "QUOTE_DRAFT", "REVIEW_QUOTE"],
  ["Awaiting Approval", context(), state({ completedEvaluation, issued, quotes: [issued] }), "WAITING_FOR_CUSTOMER_DECISION", "REVIEW_QUOTE"],
  ["Declined", context(), state({ completedEvaluation, issued: { ...issued, decisionState: "DECLINED", decisionVersion: 3 } }), "QUOTE_DECLINED", "REVIEW_QUOTE"],
  ["Deposit Required", context(), approved("DUE", false), "QUOTE_APPROVED_DEPOSIT_DUE", "VIEW_DEPOSIT"],
  ["Partial deposit remains blocked", context(), approved("PARTIALLY_SATISFIED", false), "QUOTE_APPROVED_DEPOSIT_DUE", "VIEW_DEPOSIT"],
  ["Unverified deposit remains blocked", context(), approved("TERMS_UNVERIFIED", false), "QUOTE_APPROVED_DEPOSIT_DUE", "VIEW_DEPOSIT"],
  ["Satisfied deposit / Ready to Start", context(), approved("SATISFIED", true), "WORK_READY", "START_WORK"],
  ["No deposit / Ready to Start", context(), approved("NOT_REQUIRED", true), "WORK_READY", "START_WORK"],
  ["Work In Progress", context({ emergency_status: "work_in_progress" }), state({ completionReview: { canComplete: true } }), "WORK_IN_PROGRESS", "COMPLETE_WORK"],
  ["Ready to Invoice", context({ emergency_status: "completed", completion_id: "completion" }), state(), "JOB_COMPLETED", "CREATE_FINAL_INVOICE"],
];
for (const status of ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID"]) {
  cases.push([status, context({ emergency_status: "completed", completion_id: "completion" }), state({ invoice: {
    invoice_id: "invoice", status, version: 2, total_minor: 10000, paid_minor: status === "PAID" ? 10000 : 5000,
    balance_minor: status === "PAID" ? 0 : 5000, currency: "USD",
  } }), status === "PAID" ? "PAID" : status === "PARTIALLY_PAID" ? "PARTIALLY_PAID" : "FINAL_INVOICE", status === "PAID" ? "VIEW_JOB_HISTORY" : "VIEW_INVOICE"]);
}
for (const [name, ctx, evidence, stage, action] of cases) {
  test(`Emergency server presentation: ${name}`, () => {
    const live = deriveEmergencyLiveJob(ctx, evidence);
    assert.equal(live.stage.code, stage); assert.equal(live.nextAction.code, action);
    assert.ok(live.availableActions.some(item => item.code === action));
    assert.equal(live.sourceType, "emergency_request"); assert.equal(live.sourceLabel, "Emergency");
    assert.equal(live.requestId, null); assert.equal(live.relationshipId, 123);
    assert.equal(live.emergencyRequestId, 45); assert.equal(live.conversationId, 91);
    assert.doesNotMatch(JSON.stringify(live), /schedule|visit|workstream/i);
    if (live.deposit) assert.equal(live.deposit.startWorkLocked, !evidence.depositGate.allowed);
    if (evidence.invoice) {
      assert.equal(live.invoice.totalMinor, 10000);
      assert.equal(live.invoice.paidMinor, evidence.invoice.paid_minor);
      assert.equal(live.invoice.balanceMinor, evidence.invoice.balance_minor);
    }
  });
}

test("commands remain unavailable when canonical capabilities or completion gates fail", () => {
  for (const [ctx, evidence, action] of [
    [context(), state({ capabilities: ["participant.read", "quote.read"] }), "START_EVALUATION"],
    [context(), state({ completedEvaluation, capabilities: ["participant.read", "quote.read"] }), "CREATE_QUOTE"],
    [context({ emergency_status: "work_in_progress" }), state({ completionReview: { canComplete: false } }), "COMPLETE_WORK"],
  ]) {
    const live = deriveEmergencyLiveJob(ctx, evidence);
    assert.equal(live.nextAction.available, false);
    assert.ok(!live.availableActions.some(item => item.code === action));
  }
  const missingArrival = deriveEmergencyLiveJob(context({ arrived_at: null }), approved("NOT_REQUIRED", true));
  assert.equal(missingArrival.nextAction.available, false);
  const missingEvaluation = deriveEmergencyLiveJob(context(), { ...approved("SATISFIED", true), completedEvaluation: null });
  assert.equal(missingEvaluation.stage.code, "EVALUATION_NEEDED");
});

test("stale customer decision cannot make a newer issued Quote declined or approved", () => {
  const live = deriveEmergencyLiveJob(context(), state({ completedEvaluation,
    issued: { ...issued, decisionState: "DECLINED", decisionVersion: 2 } }));
  assert.equal(live.stage.code, "WAITING_FOR_CUSTOMER_DECISION");
  assert.equal(live.quote.state, "AWAITING_APPROVAL");
  assert.ok(!live.availableActions.some(item => item.code === "START_WORK"));
});

test("picker Emergency query reuses exact governed context and requires active selected roles and grants", () => {
  const sql = picker.EMERGENCY_AUTHORIZED_JOBS_SQL;
  assert.ok(sql.includes(EMERGENCY_LIFECYCLE_CONTEXT_SQL));
  for (const expected of [/relationships\.post_id IS NULL/, /relationships\.status = 'active'/,
    /relationships\.emergency_request_id = emergency\.id/, /jobs\.source_request_selection_id IS NULL/,
    /emergency_jobs\.professional_user_id = \$1/, /emergency_jobs\.primary_role_active = TRUE/,
    /emergency_jobs\.customer_role_active = TRUE/, /revocations\.id IS NULL/]) assert.match(sql, expected);
  assert.doesNotMatch(sql, /JOIN posts|JOIN request_selections|\b(?:INSERT|UPDATE|DELETE)\b/i);
});

test("selected Emergency picker row preserves exact identity; outsider receives none", async () => {
  const calls = [];
  const pool = { async query(sql, params = []) { calls.push(sql); return { rows:
    sql.includes("professional_job_picker:list") && params[0] === 77
      ? [{ ...context(), title: "Emergency leak", service_domain: "home_services", service_specialty: "plumbing_repair" }] : [] }; } };
  const result = await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: 77 } });
  assert.deepEqual(result.jobs[0], { jobId: JOB, sourceType: "emergency_request", sourceLabel: "Emergency", relationshipId: 123,
    emergencyRequestId: 45, title: "Emergency leak", serviceDomain: "home_services", serviceSpecialty: "plumbing_repair",
    lifecycleStatus: "ACTIVE", customerLabel: "Customer", city: null, serviceArea: null });
  assert.deepEqual((await listAuthorizedProfessionalJobs({ pool, authenticatedActor: { id: 88 } })).jobs, []);
  assert.doesNotMatch(calls.join("\n"), /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
});

function readPool(ctx, { granted = true } = {}) {
  const calls = [];
  return { calls, async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes("live_job:authorized_context")) return { rows: [] };
    if (sql.includes("AS primary_role_active") && sql.includes("emergency_requests emergency")) {
      return { rows: ctx && params[0] === JOB && params[1] === 77 ? [ctx] : [] };
    }
    if (sql.includes("lifecycle_authority:active_grant")) return { rows: granted ? [{ id: "grant" }] : [] };
    if (sql.includes("emergency_commercial:approved_quote")) return { rows: [] };
    if (sql.includes("jobs.source_type AS job_source_type")) return { rows: [{ ...ctx,
      selected_professional_user_id: 77, actor_is_primary_professional: true }] };
    return { rows: [] };
  } };
}
for (const status of ["assigned", "professional_en_route", "professional_arrived"]) {
  test(`live-state boundary reads governed Emergency ${status} without ordinary state loaders or mutations`, async () => {
    const pool = readPool(context({ emergency_status: status }));
    const result = await getCanonicalLiveJob({ pool, jobId: JOB, authenticatedActor: { id: 77 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, "LIVE_JOB_STATE_LOADED"); assert.equal(result.liveJob.requestId, null);
    assert.equal(result.liveJob.sourceType, "emergency_request");
    assert.ok(!pool.calls.some(({ sql }) => /live_job:(evaluation|workstreams|approved_work_scheduling)/.test(sql)));
    assert.doesNotMatch(pool.calls.map(call => call.sql).join("\n"), /\b(?:INSERT|UPDATE|DELETE)\b/i);
  });
}
for (const changes of [null, { relationship_status: "closed" }, { relationship_id: null },
  { primary_role_active: false }, { professional_user_id: 88 }, { job_request_id: 45 }, { emergency_request_id: null }]) {
  test(`Emergency live-state fails closed for invalid context ${JSON.stringify(changes)}`, async () => {
    const pool = readPool(changes === null ? null : context(changes));
    const result = await getCanonicalLiveJob({ pool, jobId: JOB, authenticatedActor: { id: 77 } });
    assert.equal(result.status, 404); assert.equal(result.liveJob, undefined);
    assert.ok(!pool.calls.some(({ sql }) => sql.includes("canonical_evaluations")));
  });
}

test("outsider and revoked read grants cannot obtain Emergency live state", async () => {
  assert.equal((await getCanonicalLiveJob({ pool: readPool(context()), jobId: JOB, authenticatedActor: { id: 88 } })).status, 404);
  assert.equal((await getCanonicalLiveJob({ pool: readPool(context(), { granted: false }), jobId: JOB, authenticatedActor: { id: 77 } })).status, 403);
});

test("source identity never infers Emergency from null request IDs", () => {
  assert.deepEqual(jobSourcePresentation({ job_request_id: null }), {});
  assert.deepEqual(jobSourcePresentation({ job_request_id: null, source_type: "business_customer" }), { sourceType: "business_customer" });
  for (const source_type of ["ordinary_request_selection", "existing_customer_request", "business_document", "business_customer"]) {
    assert.equal(jobSourcePresentation({ source_type }).sourceType, source_type);
  }
});

test("Emergency history projection preserves source, relationship, amounts and no ordinary Request", () => {
  const history = historySummary({ ...context(), completed_at: instant, service_title: "Emergency leak",
    approved_total_minor: 10000, approved_currency: "USD", workstream_count: 0, work_item_count: 0, customer_update_count: 0 });
  assert.equal(history.sourceType, "emergency_request"); assert.equal(history.sourceLabel, "Emergency");
  assert.equal(history.requestId, null); assert.equal(history.relationshipId, 123);
  assert.deepEqual(history.approvedQuote, { totalMinor: 10000, currency: "USD" });
  const source = readFileSync(join(__dirname, "../server/workflow/jobCompletionService.js"), "utf8");
  assert.match(source, /visits: row.source_type !== "emergency_request"/);
  assert.match(source, /workPlan: row.source_type !== "emergency_request"/);
});
