"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getCustomerJobQuotes,
  customerJobQuotesInternals,
} = require("../server/authorization/customerJobQuotesService");

const IDS = Object.freeze({
  waiting: "10000000-0000-4000-8000-000000000001",
  approved: "20000000-0000-4000-8000-000000000002",
  declined: "30000000-0000-4000-8000-000000000003",
  additional: "40000000-0000-4000-8000-000000000004",
  job: "60000000-0000-4000-8000-000000000006",
  otherJob: "70000000-0000-4000-8000-000000000007",
  participant: "80000000-0000-4000-8000-000000000008",
});

function context(overrides = {}) {
  return {
    job_id: IDS.job,
    lifecycle_contract_version: 2,
    job_request_id: 16,
    relationship_id: 21,
    relationship_status: "active",
    actor_participant_id: IDS.participant,
    job_title: "Synthetic sink repair",
    job_service: "Handyman",
    actor_is_customer_representative: true,
    can_read_customer_quotes: true,
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    id: IDS.waiting,
    job_id: IDS.job,
    status: "ISSUED",
    currency: "USD",
    lineage_type: null,
    created_at: "2026-08-10T12:00:00.000Z",
    updated_at: "2026-08-13T12:00:00.000Z",
    issued_at: "2026-08-12T12:00:00.000Z",
    total_minor: "265000",
    customer_decision: null,
    decided_at: null,
    business_status: "WAITING_ON_CUSTOMER",
    relevance_priority: 1,
    last_activity_at: "2026-08-13T12:00:00.000Z",
    has_approve_authority: true,
    has_decline_authority: true,
    sentinel_future_column: "must-not-leak",
    professional_material_cost_minor: 12345,
    labor_cost_minor: 45678,
    markup_basis_points: 2500,
    internal_notes: "private",
    integrity_hash: "private-integrity",
    grant_id: "private-grant",
    ...overrides,
  };
}

function orderedQuotes() {
  return [
    quote(),
    quote({
      id: IDS.additional,
      lineage_type: "SUPPLEMENTAL_QUOTE",
      updated_at: "2026-08-14T12:00:00.000Z",
      issued_at: "2026-08-14T11:00:00.000Z",
      last_activity_at: "2026-08-14T12:00:00.000Z",
      total_minor: "45000",
    }),
    quote({
      id: IDS.approved,
      customer_decision: "APPROVED",
      business_status: "APPROVED",
      relevance_priority: 2,
      decided_at: "2026-08-13T13:00:00.000Z",
      last_activity_at: "2026-08-13T13:00:00.000Z",
    }),
    quote({
      id: IDS.declined,
      lineage_type: "REVISED_QUOTE",
      customer_decision: "DECLINED",
      business_status: "DECLINED",
      relevance_priority: 3,
      decided_at: "2026-08-11T13:00:00.000Z",
      last_activity_at: "2026-08-11T13:00:00.000Z",
    }),
  ].sort((left, right) =>
    left.relevance_priority - right.relevance_priority ||
    Date.parse(right.last_activity_at) - Date.parse(left.last_activity_at) ||
    left.id.localeCompare(right.id)
  );
}

function poolWith({ jobContext = context(), rows = orderedQuotes() } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("SELECT\n      jobs.id AS job_id")) {
        return { rows: jobContext ? [jobContext] : [] };
      }
      if (text.includes("SELECT\n      quotes.id")) {
        const [, actorId, relationshipId, participantId, priority, activityAt, quoteId, queryLimit] = params;
        assert.equal(actorId, 77);
        assert.equal(relationshipId, 21);
        assert.equal(participantId, IDS.participant);
        let selected = rows.filter((row) => row.status === "ISSUED" && row.job_id === IDS.job);
        if (priority != null) {
          selected = selected.filter((row) =>
            row.relevance_priority > priority ||
            (row.relevance_priority === priority && row.last_activity_at < activityAt) ||
            (row.relevance_priority === priority && row.last_activity_at === activityAt && row.id > quoteId)
          );
        }
        return { rows: selected.slice(0, queryLimit) };
      }
      throw new Error(`Unexpected customer Job Quotes query: ${text.slice(0, 100)}`);
    },
  };
}

test("customer discovery returns only exact issued Job Quotes with independent lineage and decisions", async () => {
  const result = await getCustomerJobQuotes({
    pool: poolWith(),
    authenticatedActor: { id: 77 },
    jobId: IDS.job,
  });
  assert.equal(result.code, "CUSTOMER_JOB_QUOTES_LOADED");
  assert.deepEqual(result.job, {
    id: IDS.job,
    requestId: 16,
    title: "Synthetic sink repair",
    service: "Handyman",
  });
  assert.deepEqual(result.quotes.map(({ quoteId, businessStatus, lineageLabel }) => ({
    quoteId,
    businessStatus,
    lineageLabel,
  })), [
    { quoteId: IDS.additional, businessStatus: "WAITING_ON_CUSTOMER", lineageLabel: "Additional" },
    { quoteId: IDS.waiting, businessStatus: "WAITING_ON_CUSTOMER", lineageLabel: "Original" },
    { quoteId: IDS.approved, businessStatus: "APPROVED", lineageLabel: "Original" },
    { quoteId: IDS.declined, businessStatus: "DECLINED", lineageLabel: "Revised" },
  ]);
  assert.equal(new Set(result.quotes.map(({ quoteId }) => quoteId)).size, 4);
  assert.ok(result.quotes.every(({ jobId }) => jobId === IDS.job));
});

test("customer DTO is an explicit privacy allowlist with exact terminal action truth", () => {
  const waiting = customerJobQuotesInternals.quoteProjection(quote());
  assert.deepEqual(Object.keys(waiting), [
    "quoteId",
    "jobId",
    "businessStatus",
    "status",
    "customerDecision",
    "totalMinor",
    "currency",
    "lineageLabel",
    "createdAt",
    "updatedAt",
    "issuedAt",
    "decidedAt",
    "actions",
  ]);
  assert.deepEqual(waiting.actions, {
    canViewQuote: true,
    canApprove: true,
    canDecline: true,
  });
  for (const forbidden of [
    "sentinel_future_column",
    "professional_material_cost_minor",
    "labor_cost_minor",
    "markup_basis_points",
    "margin",
    "internal_notes",
    "integrity_hash",
    "grant_id",
    "idempotency",
    "versions",
    "parentQuoteId",
    "lineageType",
  ]) assert.equal(forbidden in waiting, false);
  for (const [decision, businessStatus] of [
    ["APPROVED", "APPROVED"],
    ["DECLINED", "DECLINED"],
  ]) {
    assert.deepEqual(customerJobQuotesInternals.quoteProjection(quote({
      customer_decision: decision,
      business_status: businessStatus,
      has_approve_authority: true,
      has_decline_authority: true,
    })).actions, {
      canViewQuote: true,
      canApprove: false,
      canDecline: false,
    });
  }
});

test("wrong, inactive, revoked-role, and missing-read-authority customer contexts fail closed", async () => {
  for (const jobContext of [
    null,
    context({ lifecycle_contract_version: 1 }),
    context({ relationship_status: "closed" }),
    context({ actor_participant_id: null }),
    context({ actor_is_customer_representative: false }),
    context({ can_read_customer_quotes: false }),
  ]) {
    const pool = poolWith({ jobContext });
    const result = await getCustomerJobQuotes({
      pool,
      authenticatedActor: { id: 77 },
      jobId: IDS.job,
    });
    assert.deepEqual(result, {
      ok: false,
      status: 404,
      code: "CUSTOMER_JOB_QUOTES_UNAVAILABLE",
      message: "The customer Quotes are unavailable.",
    });
    assert.equal(pool.calls.some(({ text }) => text.includes("SELECT\n      quotes.id")), false);
  }
});

test("authentication, exact Job identity, bounds, cursor scope, and caller-supplied identity fail before reads", async () => {
  const cases = [
    { authenticatedActor: null, jobId: IDS.job, code: "COMMERCIAL_AUTHORITY_AUTHENTICATION_REQUIRED" },
    { authenticatedActor: { id: 77 }, jobId: "not-a-job", code: "INVALID_CUSTOMER_JOB_ID" },
    { authenticatedActor: { id: 77 }, jobId: IDS.job, limit: 0, code: "INVALID_CUSTOMER_QUOTES_LIMIT" },
    { authenticatedActor: { id: 77 }, jobId: IDS.job, limit: 51, code: "INVALID_CUSTOMER_QUOTES_LIMIT" },
    { authenticatedActor: { id: 77 }, jobId: IDS.job, cursor: "broken", code: "INVALID_CUSTOMER_QUOTES_CURSOR" },
    { authenticatedActor: { id: 77 }, jobId: IDS.job, customerUserId: 77, code: "CUSTOMER_JOB_QUOTES_FIELD_REJECTED" },
  ];
  for (const { code, ...input } of cases) {
    const pool = poolWith();
    const result = await getCustomerJobQuotes({ pool, ...input });
    assert.equal(result.code, code);
    assert.equal(pool.calls.length, 0);
  }
  const cursor = customerJobQuotesInternals.encodeCursor({
    actorId: 77,
    jobId: IDS.job,
    priority: 1,
    activityAt: "2026-08-13T12:00:00.000Z",
    quoteId: IDS.waiting,
  });
  for (const input of [
    { authenticatedActor: { id: 78 }, jobId: IDS.job },
    { authenticatedActor: { id: 77 }, jobId: IDS.otherJob },
  ]) {
    const pool = poolWith();
    const result = await getCustomerJobQuotes({ pool, cursor, ...input });
    assert.equal(result.code, "CUSTOMER_QUOTES_CURSOR_SCOPE_MISMATCH");
    assert.equal(pool.calls.length, 0);
  }
});

test("bounded keyset ordering has no duplicates or omissions and uses one summary query per page", async () => {
  const rows = orderedQuotes();
  const firstPool = poolWith({ rows });
  const first = await getCustomerJobQuotes({
    pool: firstPool,
    authenticatedActor: { id: 77 },
    jobId: IDS.job,
    limit: 2,
  });
  const secondPool = poolWith({ rows });
  const second = await getCustomerJobQuotes({
    pool: secondPool,
    authenticatedActor: { id: 77 },
    jobId: IDS.job,
    limit: 2,
    cursor: first.pagination.nextCursor,
  });
  const ids = [...first.quotes, ...second.quotes].map(({ quoteId }) => quoteId);
  assert.deepEqual(ids, rows.map(({ id }) => id));
  assert.equal(new Set(ids).size, rows.length);
  assert.equal(first.pagination.hasMore, true);
  assert.equal(second.pagination.hasMore, false);
  for (const pool of [firstPool, secondPool]) {
    assert.equal(pool.calls.filter(({ text }) => text.includes("SELECT\n      quotes.id")).length, 1);
    assert.equal(pool.calls.length, 4);
  }
});

test("discovery query is read-only, excludes Drafts, and derives authority from exact canonical scope", async () => {
  const pool = poolWith({ rows: [] });
  const result = await getCustomerJobQuotes({
    pool,
    authenticatedActor: { id: 77 },
    jobId: IDS.job,
  });
  assert.equal(result.ok, true);
  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /REPEATABLE READ READ ONLY/);
  assert.match(sql, /quotes\.status = 'ISSUED'/);
  assert.match(sql, /canonical_quote_issuances/);
  assert.match(sql, /relationships\.status = 'active'/);
  assert.match(sql, /roles\.role = 'CUSTOMER_REPRESENTATIVE'/);
  assert.match(sql, /grants\.capability = 'quote\.read_customer'/);
  assert.match(sql, /quotes\.job_id = \$1/);
  assert.match(sql, /relationships\.id = \$3/);
  assert.match(sql, /customer\.id = \$4/);
  assert.doesNotMatch(sql, /SELECT\s+\*/i);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+/i);
  assert.doesNotMatch(sql, /customer_name|professional_name|conversation|email/i);
});
