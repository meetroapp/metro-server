"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  ACTION_DEFINITIONS,
  DERIVATION_PRECEDENCE,
  LIVE_JOB_CONTRACT_VERSION,
  deriveCanonicalLiveJob,
  getCanonicalLiveJob,
  loadCanonicalState,
} = require("../server/workflow/liveJobProjectionService");

const DERIVED_AT = "2026-08-12T12:00:00.000Z";
const BASE_CAPABILITIES = [
  "reported_concern.read",
  "participant.read",
  "evaluation.perform",
  "finding.submit",
  "finding.confirm",
  "recommendation.create",
  "recommendation.read",
  "quote.create",
  "quote.read",
  "quote.scope.manage",
  "quote.issue",
  "workstream.read",
  "work_activity.create",
  "work_activity.progress",
  "work_activity.read",
  "work_obligation.read",
  "workstream.complete",
];

function state(overrides = {}) {
  return {
    jobCreatedAt: "2026-08-10T12:00:00.000Z",
    hasConversation: true,
    capabilities: BASE_CAPABILITIES,
    evaluation: null,
    findings: [],
    recommendations: [],
    quotes: [],
    workstreams: [],
    activities: [],
    obligations: [],
    ...overrides,
  };
}

function derive(overrides = {}) {
  return deriveCanonicalLiveJob(state(overrides), { derivedAt: DERIVED_AT });
}

function approvedWorkScheduling(overrides = {}) {
  return [{
    quoteId: "approved-parent",
    approvedQuoteDecisionId: "approved-decision",
    authorityState: "AVAILABLE",
    visitState: null,
    ...overrides,
  }];
}

function assertProjection(projection, expected) {
  assert.equal(projection.contractVersion, LIVE_JOB_CONTRACT_VERSION);
  assert.equal(projection.stage.code, expected.stage);
  assert.equal(projection.responsibility.code, expected.responsibility);
  assert.equal(projection.nextAction.code, expected.nextAction);
  assert.equal(projection.blocker?.code || null, expected.blocker || null);
  assert.equal(projection.freshness.derivedAt, DERIVED_AT);
}

test("newly selected Job requires Evaluation without fabricating scheduling", () => {
  const projection = derive();
  assertProjection(projection, {
    stage: "EVALUATION_NEEDED",
    responsibility: "PROFESSIONAL",
    nextAction: "START_OR_CONTINUE_EVALUATION",
    blocker: "EVALUATION_NOT_RECORDED",
  });
  assert.deepEqual(
    projection.availableActions.map((action) => action.code),
    ["VIEW_CONCERN", "MESSAGE_CUSTOMER", "START_EVALUATION"]
  );
  assert.equal(projection.stage.label, "Evaluation draft available");
  assert.equal(projection.nextAction.label, "Open or continue the Evaluation");
  assert.equal(
    projection.availableActions.find((action) => action.code === "START_EVALUATION").label,
    "Open Evaluation"
  );
  assert.equal(
    projection.availableActions.some((action) => /SCHEDULE/.test(action.code)),
    false
  );
});

test("draft Evaluation remains professional work in progress", () => {
  const projection = derive({
    evaluation: { id: "evaluation", status: "draft", version: 3, observations: "Leak observed" },
  });
  assertProjection(projection, {
    stage: "EVALUATION_IN_PROGRESS",
    responsibility: "PROFESSIONAL",
    nextAction: "START_OR_CONTINUE_EVALUATION",
    blocker: "EVALUATION_INCOMPLETE",
  });
  assert.equal(projection.freshness.evaluationVersion, 3);
  assert.equal(
    projection.availableActions.some((action) => action.code === "COMPLETE_EVALUATION"),
    false
  );
});

test("completed Evaluation Visit provenance unlocks the draft finalization action", () => {
  const projection = derive({
    evaluation: {
      id: "evaluation",
      status: "draft",
      version: 3,
      observations: "Leak observed",
      evaluation_visit_id: "evaluation-visit",
    },
  });
  assert.equal(
    projection.availableActions.some((action) => action.code === "COMPLETE_EVALUATION"),
    true
  );
});

test("completed Evaluation without Findings requires Findings", () => {
  const projection = derive({
    evaluation: { id: "evaluation", status: "completed", version: 2 },
  });
  assertProjection(projection, {
    stage: "FINDINGS_NEEDED",
    responsibility: "PROFESSIONAL",
    nextAction: "REVIEW_FINDINGS",
    blocker: "FINDINGS_NOT_RECORDED",
  });
});

test("completed physical and remote assessments retain one simple operational stage", () => {
  for (const [completionMode, reason] of [
    ["PHYSICAL", "ON_SITE_ASSESSMENT_COMPLETED"],
    ["REMOTE", "REMOTE_ASSESSMENT_COMPLETED"],
  ]) {
    const projection = derive({
      evaluation: {
        id: "evaluation",
        status: "completed",
        version: 2,
        completion_mode: completionMode,
      },
    });
    assert.equal(projection.stage.code, "FINDINGS_NEEDED");
    assert.equal(projection.freshness.evaluationCompletionMode, completionMode);
    assert.equal(projection.reasonCodes.includes(reason), true);
    assert.doesNotMatch(
      `${projection.stage.label} ${projection.nextAction.label} ${projection.nextAction.description}`,
      /canonical|provenance|authority|claim|idempotency/i
    );
  }
});

test("proposed Findings require professional confirmation", () => {
  const projection = derive({
    evaluation: { id: "evaluation", status: "completed", version: 2 },
    findings: [{ id: "finding", version: 1, confirmation_state: "PROPOSED" }],
  });
  assertProjection(projection, {
    stage: "FINDINGS_REVIEW_NEEDED",
    responsibility: "PROFESSIONAL",
    nextAction: "REVIEW_FINDINGS",
    blocker: "FINDINGS_AWAITING_CONFIRMATION",
  });
});

test("confirmed Finding without Recommendation requires Recommendation", () => {
  const projection = derive({
    evaluation: { id: "evaluation", status: "completed", version: 2 },
    findings: [{ id: "finding", version: 2, confirmation_state: "CONFIRMED" }],
  });
  assertProjection(projection, {
    stage: "RECOMMENDATIONS_NEEDED",
    responsibility: "PROFESSIONAL",
    nextAction: "PREPARE_RECOMMENDATIONS",
  });
});

test("completed Evaluation, confirmed Findings, and Recommendation require Quote", () => {
  const projection = derive({
    evaluation: { id: "evaluation", status: "completed", version: 2 },
    findings: [{ id: "finding", version: 2, confirmation_state: "CONFIRMED" }],
    recommendations: [{ id: "recommendation", finding_id: "finding", version: 1, status: "ACTIVE" }],
  });
  assertProjection(projection, {
    stage: "QUOTE_NEEDED",
    responsibility: "PROFESSIONAL",
    nextAction: "BUILD_QUOTE",
  });
});

test("draft Quote is a professional review step", () => {
  const projection = derive({
    quotes: [{ id: "quote", version: 2, status: "DRAFT", scope_item_count: 2 }],
  });
  assertProjection(projection, {
    stage: "QUOTE_DRAFT",
    responsibility: "PROFESSIONAL",
    nextAction: "REVIEW_DRAFT_QUOTE",
    blocker: "QUOTE_NOT_ISSUED",
  });
});

test("an approved parent with scheduling authority outranks a supplemental Draft", () => {
  const projection = derive({
    quotes: [
      {
        id: "supplemental",
        parent_quote_id: "approved-parent",
        lineage_type: "SUPPLEMENTAL_QUOTE",
        version: 1,
        status: "DRAFT",
        scope_item_count: 1,
      },
      { id: "approved-parent", version: 4, status: "ISSUED", customer_decision: "APPROVED", scope_item_count: 2 },
    ],
    approvedWorkScheduling: approvedWorkScheduling(),
  });
  assert.equal(projection.stage.code, "QUOTE_APPROVED");
  assert.equal(projection.stage.label, "Work approved — ready to schedule");
  assert.equal(projection.nextAction.label, "Schedule approved work");
  assert.deepEqual(projection.reasonCodes, [
    "APPROVED_WORK_VISIT_AUTHORITY_AVAILABLE",
    "SUPPLEMENTAL_DRAFT_REMAINS_SECONDARY",
  ]);
  assert.equal(projection.availableActions.some((action) => /SCHEDULE|VISIT/.test(action.code)), false);
});

test("approved Quote with available authority projects executable work without a supplemental Draft", () => {
  const projection = derive({
    quotes: [{
      id: "approved-parent",
      version: 4,
      status: "ISSUED",
      customer_decision: "APPROVED",
      scope_item_count: 2,
    }],
    approvedWorkScheduling: approvedWorkScheduling(),
  });
  assert.equal(projection.stage.code, "QUOTE_APPROVED");
  assert.equal(projection.stage.label, "Work approved — ready to schedule");
  assert.equal(projection.nextAction.label, "Schedule approved work");
});

test("scheduled approved work remains primary over a supplemental Draft", () => {
  const projection = derive({
    quotes: [
      {
        id: "supplemental",
        parent_quote_id: "approved-parent",
        lineage_type: "SUPPLEMENTAL_QUOTE",
        version: 1,
        status: "DRAFT",
        scope_item_count: 1,
      },
      { id: "approved-parent", version: 4, status: "ISSUED", customer_decision: "APPROVED", scope_item_count: 2 },
    ],
    approvedWorkScheduling: approvedWorkScheduling({
      authorityState: "ACTIVE",
      visitState: "SCHEDULED",
    }),
  });
  assert.equal(projection.stage.code, "WORK_READY");
  assert.equal(projection.stage.label, "Approved work scheduled");
  assert.equal(projection.nextAction.label, "Review scheduled work");
  assert.deepEqual(projection.reasonCodes, [
    "APPROVED_WORK_VISIT_SCHEDULED",
    "SUPPLEMENTAL_DRAFT_REMAINS_SECONDARY",
  ]);
});

test("a supplemental Draft cannot regress active or completed approved work", () => {
  const quotes = [
    { id: "supplemental", version: 1, status: "DRAFT", scope_item_count: 1 },
    { id: "approved-parent", version: 4, status: "ISSUED", customer_decision: "APPROVED", scope_item_count: 2 },
  ];
  const active = derive({
    quotes,
    workstreams: [{ id: "workstream", version: 2, state: "ACTIVE" }],
  });
  assert.equal(active.stage.code, "WORK_IN_PROGRESS");

  const completed = derive({
    quotes,
    workstreams: [{ id: "workstream", version: 3, state: "COMPLETED" }],
  });
  assert.equal(completed.stage.code, "WORKSTREAMS_COMPLETE_PENDING_JOB_COMPLETION");
});

test("approved Quote without canonical scheduling authority never fabricates scheduling", () => {
  const projection = derive({
    quotes: [
      { id: "supplemental", version: 1, status: "DRAFT", scope_item_count: 1 },
      { id: "approved-parent", version: 4, status: "ISSUED", customer_decision: "APPROVED", scope_item_count: 2 },
    ],
  });
  assert.equal(projection.stage.code, "QUOTE_DRAFT");
  assert.equal(projection.nextAction.code, "REVIEW_DRAFT_QUOTE");
  assert.equal(projection.availableActions.some((action) => /SCHEDULE|VISIT/.test(action.code)), false);
});

test("issued Quote without decision waits on the customer", () => {
  const projection = derive({
    quotes: [{ id: "quote", version: 3, status: "ISSUED", scope_item_count: 2 }],
  });
  assertProjection(projection, {
    stage: "WAITING_FOR_CUSTOMER_DECISION",
    responsibility: "CUSTOMER",
    nextAction: "WAIT_FOR_CUSTOMER_DECISION",
    blocker: "CUSTOMER_DECISION_PENDING",
  });
});

test("declined customer decision remains separate from issued Quote version status", () => {
  const projection = derive({
    quotes: [{
      id: "quote",
      version: 3,
      status: "ISSUED",
      customer_decision: "DECLINED",
      scope_item_count: 2,
    }],
  });
  assertProjection(projection, {
    stage: "QUOTE_DECLINED",
    responsibility: "PROFESSIONAL",
    nextAction: "REVIEW_DECLINED_QUOTE",
    blocker: "CUSTOMER_DECLINED_QUOTE",
  });
});

test("approved Quote fails closed at absent Visit/Schedule authority", () => {
  const projection = derive({
    quotes: [{ id: "quote", version: 4, status: "ISSUED", customer_decision: "APPROVED", scope_item_count: 2 }],
  });
  assertProjection(projection, {
    stage: "QUOTE_APPROVED",
    responsibility: "SYSTEM_WAITING",
    nextAction: "NEXT_STEP_NOT_YET_AVAILABLE",
    blocker: "NEXT_WORKFLOW_AUTHORITY_NOT_AVAILABLE",
  });
  assert.equal(
    projection.availableActions.some((action) => /SCHEDULE|VISIT/.test(action.code)),
    false
  );
});

test("active Workstream takes deterministic precedence over prior commercial records", () => {
  const projection = derive({
    quotes: [{ id: "quote", version: 4, status: "ISSUED", customer_decision: "APPROVED", scope_item_count: 2 }],
    workstreams: [{ id: "workstream", version: 2, state: "ACTIVE" }],
    activities: [{ id: "activity", version: 2, status: "IN_PROGRESS" }],
  });
  assertProjection(projection, {
    stage: "WORK_IN_PROGRESS",
    responsibility: "PROFESSIONAL",
    nextAction: "REVIEW_ACTIVE_WORK",
  });
});

test("blocked Workstream and open obligation identify a bounded blocker", () => {
  const blocked = derive({
    workstreams: [{ id: "workstream", version: 2, state: "BLOCKED" }],
  });
  assertProjection(blocked, {
    stage: "WORK_BLOCKED",
    responsibility: "PROFESSIONAL",
    nextAction: "REVIEW_BLOCKED_WORK",
    blocker: "WORKSTREAM_BLOCKED",
  });

  const obligation = derive({
    workstreams: [{ id: "workstream", version: 1, state: "OPEN" }],
    obligations: [{ id: "obligation", version: 1, status: "OPEN" }],
  });
  assert.equal(obligation.blocker.code, "UNRESOLVED_OBLIGATION");
});

test("completed Workstreams require the separate whole-Job completion command", () => {
  const projection = derive({
    workstreams: [
      { id: "workstream-1", version: 3, state: "COMPLETED" },
      { id: "workstream-2", version: 2, state: "COMPLETED" },
    ],
  });
  assertProjection(projection, {
    stage: "WORKSTREAMS_COMPLETE_PENDING_JOB_COMPLETION",
    responsibility: "PROFESSIONAL",
    nextAction: "REVIEW_WORKSTREAM_COMPLETION",
  });
  assert.equal(projection.blocker, null);
  assert.deepEqual(projection.reasonCodes, [
    "ALL_WORKSTREAMS_COMPLETED",
    "JOB_COMPLETION_REVIEW_AVAILABLE",
  ]);
});

test("durable Job completion outranks work and hands off without financial mutation", () => {
  const projection = derive({
    completion: {
      id: "completion",
      version: 1,
      status: "COMPLETED",
      completed_at: "2026-08-15T12:00:00.000Z",
    },
    workstreams: [{ id: "workstream", version: 3, state: "COMPLETED" }],
  });
  assertProjection(projection, {
    stage: "JOB_COMPLETED",
    responsibility: "NONE",
    nextAction: "READY_TO_INVOICE",
  });
  assert.deepEqual(projection.availableActions.map((action) => action.code), [
    "VIEW_CONCERN",
    "MESSAGE_CUSTOMER",
    "VIEW_JOB_HISTORY",
  ]);
  assert.match(projection.nextAction.description, /separate next step/i);
});

test("completed Job financial next actions come from canonical Invoice truth", () => {
  const completion = { id: "completion", version: 1, status: "COMPLETED" };
  const cases = [
    ["DRAFT", "REVIEW_DRAFT_INVOICE"],
    ["SENT", "WAIT_FOR_PAYMENT"],
    ["PARTIALLY_PAID", "REVIEW_BALANCE_DUE"],
    ["PAID", "REVIEW_PAID_INVOICE"],
  ];
  for (const [status, nextAction] of cases) {
    const projection = derive({
      completion,
      invoice: { id: "invoice", version: status === "DRAFT" ? 1 : 2, status },
    });
    assert.equal(projection.stage.code, "JOB_COMPLETED");
    assert.equal(projection.nextAction.code, nextAction);
    assert.equal(projection.availableActions.some((action) => action.code === "VIEW_INVOICE"), true);
    assert.equal(projection.freshness.invoiceVersion, status === "DRAFT" ? 1 : 2);
  }
});

test("projection vocabulary and precedence are code-owned and exclude still-deferred domains", () => {
  assert.deepEqual(DERIVATION_PRECEDENCE, [
    "JOB_COMPLETION",
    "BLOCKED_WORK",
    "ACTIVE_WORK",
    "READY_WORK",
    "TERMINAL_WORKSTREAMS",
    "APPROVED_WORK_SCHEDULING",
    "DRAFT_QUOTE",
    "ISSUED_QUOTE_DECISION",
    "DECLINED_QUOTE",
    "APPROVED_QUOTE",
    "EVALUATION",
    "FINDINGS",
    "RECOMMENDATIONS",
    "QUOTE_PREPARATION",
  ]);
  assert.equal(
    Object.keys(ACTION_DEFINITIONS).some((action) =>
      /SCHEDULE|VISIT|COMPLETE_JOB|CLOSE_JOB/.test(action)
    ),
    false
  );
});

test("malformed Job identity fails before database access", async () => {
  let queries = 0;
  const result = await getCanonicalLiveJob({
    pool: { async query() { queries += 1; throw new Error("unexpected"); } },
    authenticatedActor: { id: 7 },
    jobId: "legacy-job",
  });
  assert.equal(result.code, "INVALID_JOB_ID");
  assert.equal(queries, 0);
});

test("unauthorized professional receives a fail-closed unavailable response", async () => {
  const result = await getCanonicalLiveJob({
    pool: { async query() { return { rows: [] }; } },
    authenticatedActor: { id: 9 },
    jobId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.status, 404);
  assert.equal(result.code, "LIVE_JOB_UNAVAILABLE");
  assert.equal(result.liveJob, undefined);
});

test("authorized lifecycle-v2 professional receives the read-only canonical projection", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      const source = String(sql);
      queries.push(source);
      if (source.includes("live_job:authorized_context")) {
        return {
          rows: [{
            job_id: "11111111-1111-4111-8111-111111111111",
            job_request_id: 41,
            relationship_id: 72,
            lifecycle_contract_version: 2,
            job_created_at: "2026-08-10T12:00:00.000Z",
            relationship_status: "active",
            selected_professional_user_id: 9,
            actor_account_type: "professional",
            actor_participant_id: "22222222-2222-4222-8222-222222222222",
            is_primary_professional: true,
            conversation_id: 340,
            active_capabilities: BASE_CAPABILITIES,
          }],
        };
      }
      if (source.includes("live_job:")) return { rows: [] };
      throw new Error(`Unexpected query: ${source}`);
    },
  };
  const result = await getCanonicalLiveJob({
    pool,
    authenticatedActor: { id: 9 },
    jobId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "LIVE_JOB_STATE_LOADED");
  assert.equal(result.liveJob.stage.code, "EVALUATION_NEEDED");
  assert.equal(result.liveJob.requestId, 41);
  assert.equal(queries.filter((sql) => sql.includes("live_job:")).length, 11);
  assert.equal(queries.some((sql) => /\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(sql)), false);
});

test("canonical state projects exact approved-work authority without changing Quote truth", async () => {
  const approvedQuote = {
    id: "approved-parent",
    version: 4,
    status: "ISSUED",
    customer_decision: "APPROVED",
    customer_decision_id: "approved-decision",
    scope_item_count: 2,
  };
  const pool = {
    async query(sql) {
      const source = String(sql);
      if (source.includes("live_job:quotes")) return { rows: [approvedQuote] };
      if (source.includes("live_job:approved_work_scheduling")) {
        return {
          rows: [{
            quote_id: approvedQuote.id,
            approved_quote_decision_id: approvedQuote.customer_decision_id,
            activation_id: null,
            active_grant_count: 0,
            visit_state: null,
          }],
        };
      }
      if (source.includes("live_job:")) return { rows: [] };
      throw new Error(`Unexpected query: ${source}`);
    },
  };
  const canonical = await loadCanonicalState(pool, {
    job_id: "11111111-1111-4111-8111-111111111111",
    relationship_id: 72,
    actor_participant_id: "22222222-2222-4222-8222-222222222222",
    active_capabilities: BASE_CAPABILITIES,
  });
  assert.equal(canonical.quotes[0].status, "ISSUED");
  assert.equal(canonical.quotes[0].customer_decision, "APPROVED");
  assert.deepEqual(canonical.approvedWorkScheduling, [{
    quoteId: "approved-parent",
    approvedQuoteDecisionId: "approved-decision",
    authorityState: "AVAILABLE",
    visitState: null,
  }]);
});

test("missing lifecycle read grants produce 403 without loading child records", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      const source = String(sql);
      queries.push(source);
      if (source.includes("live_job:authorized_context")) {
        return {
          rows: [{
            job_id: "11111111-1111-4111-8111-111111111111",
            job_request_id: 41,
            relationship_id: 72,
            lifecycle_contract_version: 2,
            relationship_status: "active",
            selected_professional_user_id: 9,
            actor_account_type: "professional",
            actor_participant_id: "22222222-2222-4222-8222-222222222222",
            is_primary_professional: true,
            conversation_id: 340,
            active_capabilities: [],
          }],
        };
      }
      if (source.includes("lifecycle_authority:active_grant")) return { rows: [] };
      throw new Error("Child records must not load without read authority");
    },
  };
  const result = await getCanonicalLiveJob({
    pool,
    authenticatedActor: { id: 9 },
    jobId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.status, 403);
  assert.equal(result.code, "LIVE_JOB_READ_AUTHORITY_REQUIRED");
  assert.equal(queries.some((sql) => sql.includes("live_job:evaluation")), false);
});

test("production pool reads use one repeatable-read snapshot and release the client", async () => {
  const events = [];
  const client = {
    async query(sql) {
      const source = String(sql);
      events.push(source);
      if (source.startsWith("BEGIN")) return { rows: [] };
      if (source === "COMMIT") return { rows: [] };
      if (source.includes("live_job:authorized_context")) {
        return {
          rows: [{
            job_id: "11111111-1111-4111-8111-111111111111",
            job_request_id: 41,
            relationship_id: 72,
            lifecycle_contract_version: 2,
            job_created_at: "2026-08-10T12:00:00.000Z",
            relationship_status: "active",
            selected_professional_user_id: 9,
            actor_account_type: "professional",
            actor_participant_id: "22222222-2222-4222-8222-222222222222",
            is_primary_professional: true,
            conversation_id: 340,
            active_capabilities: BASE_CAPABILITIES,
          }],
        };
      }
      if (source.includes("live_job:")) return { rows: [] };
      throw new Error(`Unexpected query: ${source}`);
    },
    release() { events.push("RELEASE"); },
  };
  const pool = {
    query() { throw new Error("Pool query must not bypass the snapshot client"); },
    async connect() { events.push("CONNECT"); return client; },
  };
  const result = await getCanonicalLiveJob({
    pool,
    authenticatedActor: { id: 9 },
    jobId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events.slice(0, 2), [
    "CONNECT",
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  ]);
  assert.deepEqual(events.slice(-2), ["COMMIT", "RELEASE"]);
});

test("authorized context excludes cancelled requests and contains no mutation statement", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "workflow", "liveJobProjectionService.js"),
    "utf8"
  );
  assert.match(source, /posts\.cancelled_at IS NULL/);
  assert.match(source, /scope_type = 'approved_work'/);
  assert.match(source, /scope_approved_quote_decision_id = decisions\.id/);
  assert.match(source, /customer\.user_id = relationships\.homeowner_id/);
  assert.match(source, /visits\.purpose = 'APPROVED_WORK'/);
  assert.doesNotMatch(source, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i);
});
