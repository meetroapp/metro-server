"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getProfessionalQuotes,
  professionalQuotesInternals,
} = require("../server/authorization/professionalQuotesService");

const IDS = Object.freeze({
  draft: "10000000-0000-4000-8000-000000000001",
  waiting: "20000000-0000-4000-8000-000000000002",
  deliveryPending: "25000000-0000-4000-8000-000000000025",
  approved: "30000000-0000-4000-8000-000000000003",
  declined: "40000000-0000-4000-8000-000000000004",
  supplemental: "50000000-0000-4000-8000-000000000005",
  job: "60000000-0000-4000-8000-000000000006",
});

function quote(overrides = {}) {
  return {
    id: IDS.draft,
    job_id: IDS.job,
    parent_quote_id: null,
    lineage_type: null,
    status: "DRAFT",
    currency: "USD",
    issued_at: null,
    created_at: "2026-08-10T12:00:00.000Z",
    updated_at: "2026-08-13T12:00:00.000Z",
    total_minor: "12500",
    customer_decision: null,
    decided_at: null,
    job_title: "Synthetic sink repair",
    job_service: "Plumbing",
    customer_name: "QA Customer",
    classification: "DRAFT",
    classification_priority: 1,
    last_activity_at: "2026-08-13T12:00:00.000Z",
    can_manage_scope: true,
    can_view_job: true,
    sentinel_future_column: "must-not-leak",
    customer_email: "private@example.com",
    service_address_line1: "1 Private Street",
    integrity_hash: "private-integrity",
    ...overrides,
  };
}

function orderedQuotes() {
  return [
    quote(),
    quote({
      id: IDS.deliveryPending,
      status: "ISSUED",
      classification: "DELIVERY_PENDING",
      classification_priority: 2,
      issued_at: "2026-08-12T13:00:00.000Z",
      last_activity_at: "2026-08-12T13:00:00.000Z",
      can_manage_scope: true,
    }),
    quote({
      id: IDS.waiting,
      status: "ISSUED",
      classification: "WAITING_ON_CUSTOMER",
      classification_priority: 3,
      issued_at: "2026-08-12T12:00:00.000Z",
      last_activity_at: "2026-08-12T12:00:00.000Z",
      can_manage_scope: true,
    }),
    quote({
      id: IDS.approved,
      status: "ISSUED",
      classification: "APPROVED",
      classification_priority: 4,
      customer_decision: "APPROVED",
      issued_at: "2026-08-11T12:00:00.000Z",
      decided_at: "2026-08-13T13:00:00.000Z",
      last_activity_at: "2026-08-13T13:00:00.000Z",
      can_manage_scope: false,
    }),
    quote({
      id: IDS.supplemental,
      parent_quote_id: IDS.approved,
      lineage_type: "SUPPLEMENTAL_QUOTE",
      classification: "DRAFT",
      classification_priority: 1,
      updated_at: "2026-08-14T12:00:00.000Z",
      last_activity_at: "2026-08-14T12:00:00.000Z",
    }),
    quote({
      id: IDS.declined,
      status: "ISSUED",
      classification: "DECLINED",
      classification_priority: 5,
      customer_decision: "DECLINED",
      issued_at: "2026-08-09T12:00:00.000Z",
      decided_at: "2026-08-10T13:00:00.000Z",
      last_activity_at: "2026-08-10T13:00:00.000Z",
      can_manage_scope: false,
    }),
  ].sort((left, right) =>
    left.classification_priority - right.classification_priority ||
    Date.parse(right.last_activity_at) - Date.parse(left.last_activity_at) ||
    left.id.localeCompare(right.id)
  );
}

function poolWith(rows = orderedQuotes()) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("COUNT(*) FILTER")) {
        return { rows: [{
          drafts: rows.filter((row) => row.classification === "DRAFT").length,
          delivery_pending: rows.filter((row) => row.classification === "DELIVERY_PENDING").length,
          waiting_on_customer: rows.filter((row) => row.classification === "WAITING_ON_CUSTOMER").length,
          approved: rows.filter((row) => row.classification === "APPROVED").length,
          declined: rows.filter((row) => row.classification === "DECLINED").length,
        }] };
      }
      if (text.includes("ORDER BY classification_priority")) {
        const [, deliveryFingerprints, classification, priority, activityAt, quoteId, queryLimit] = params;
        assert.equal(typeof deliveryFingerprints, "string");
        let selected = rows.filter((row) => !classification || row.classification === classification);
        if (priority != null) {
          selected = selected.filter((row) =>
            row.classification_priority > priority ||
            (row.classification_priority === priority && row.last_activity_at < activityAt) ||
            (row.classification_priority === priority && row.last_activity_at === activityAt && row.id > quoteId)
          );
        }
        return { rows: selected.slice(0, queryLimit) };
      }
      if (text.startsWith("SELECT quotes.id, aggregates.current_version")) {
        return {
          rows: rows
            .filter((row) => row.status === "ISSUED")
            .map((row) => ({ id: row.id, current_version: 2 })),
        };
      }
      throw new Error(`Unexpected Professional Quotes query: ${text.slice(0, 100)}`);
    },
  };
}

test("global read classifies canonical status and decision truth separately", async () => {
  const pool = poolWith();
  const result = await getProfessionalQuotes({
    pool,
    authenticatedActor: { id: 77 },
    limit: 20,
  });
  assert.equal(result.code, "PROFESSIONAL_QUOTES_LOADED");
  assert.deepEqual(result.summary, {
    drafts: 2,
    deliveryPending: 1,
    waitingOnCustomer: 1,
    approved: 1,
    declined: 1,
  });
  assert.deepEqual(result.quotes.map(({ classification }) => classification), [
    "DRAFT",
    "DRAFT",
    "DELIVERY_PENDING",
    "WAITING_ON_CUSTOMER",
    "APPROVED",
    "DECLINED",
  ]);
  assert.equal(result.quotes.find(({ id }) => id === IDS.approved).status, "ISSUED");
  assert.equal(result.quotes.find(({ id }) => id === IDS.approved).customerDecision, "APPROVED");
});

test("approved parent and Draft supplemental remain separate canonical records", async () => {
  const result = await getProfessionalQuotes({
    pool: poolWith(),
    authenticatedActor: { id: 77 },
  });
  const parent = result.quotes.find(({ id }) => id === IDS.approved);
  const supplemental = result.quotes.find(({ id }) => id === IDS.supplemental);
  assert.equal(parent.classification, "APPROVED");
  assert.equal(parent.lineageLabel, "Original");
  assert.equal(supplemental.classification, "DRAFT");
  assert.equal(supplemental.lineageType, "SUPPLEMENTAL_QUOTE");
  assert.equal(supplemental.lineageLabel, "Additional");
  assert.equal(supplemental.parentQuoteId, parent.id);
  assert.equal(professionalQuotesInternals.lineageLabel("REVISED_QUOTE"), "Revised");
});

test("DTO is an explicit privacy-safe allowlist with exact professional actions", () => {
  const dto = professionalQuotesInternals.quoteProjection(quote());
  assert.deepEqual(Object.keys(dto), [
    "id", "jobId", "classification", "status", "customerDecision",
    "totalMinor", "currency", "lineageType", "lineageLabel", "parentQuoteId",
    "customer", "job", "createdAt", "updatedAt", "issuedAt", "decidedAt",
    "lastActivityAt", "actions",
  ]);
  assert.deepEqual(dto.customer, { displayName: "QA Customer" });
  assert.deepEqual(dto.job, { title: "Synthetic sink repair", service: "Plumbing" });
  assert.deepEqual(dto.actions, {
    canViewQuote: true,
    canContinueDraft: true,
    canViewJob: true,
  });
  for (const forbidden of [
    "sentinel_future_column", "customer_email", "phone", "service_address_line1",
    "integrity_hash", "versions", "scopeItems", "grants", "canApprove",
    "canDecline", "canScheduleWork",
  ]) assert.equal(forbidden in dto, false);
  assert.equal(professionalQuotesInternals.quoteProjection(quote({
    status: "ISSUED",
    classification: "WAITING_ON_CUSTOMER",
  })).actions.canContinueDraft, false);
});

test("classification filter retains canonical total summary", async () => {
  const result = await getProfessionalQuotes({
    pool: poolWith(),
    authenticatedActor: { id: 77 },
    classification: "approved",
  });
  assert.equal(result.classification, "approved");
  assert.deepEqual(result.quotes.map(({ classification }) => classification), ["APPROVED"]);
  assert.deepEqual(result.summary, {
    drafts: 2,
    deliveryPending: 1,
    waitingOnCustomer: 1,
    approved: 1,
    declined: 1,
  });
});

test("keyset cursor pagination has stable ordering without duplicates or omissions", async () => {
  const rows = orderedQuotes();
  const first = await getProfessionalQuotes({
    pool: poolWith(rows),
    authenticatedActor: { id: 77 },
    limit: 2,
  });
  assert.equal(first.pagination.hasMore, true);
  assert.ok(first.pagination.nextCursor);
  const second = await getProfessionalQuotes({
    pool: poolWith(rows),
    authenticatedActor: { id: 77 },
    limit: 2,
    cursor: first.pagination.nextCursor,
  });
  const third = await getProfessionalQuotes({
    pool: poolWith(rows),
    authenticatedActor: { id: 77 },
    limit: 2,
    cursor: second.pagination.nextCursor,
  });
  const ids = [...first.quotes, ...second.quotes, ...third.quotes].map(({ id }) => id);
  assert.deepEqual(ids, rows.map(({ id }) => id));
  assert.equal(new Set(ids).size, rows.length);
  assert.equal(third.pagination.hasMore, false);
});

test("cursor is scoped to authenticated professional and selected classification", async () => {
  const first = await getProfessionalQuotes({
    pool: poolWith(),
    authenticatedActor: { id: 77 },
    limit: 1,
  });
  for (const input of [
    { authenticatedActor: { id: 78 }, cursor: first.pagination.nextCursor },
    { authenticatedActor: { id: 77 }, classification: "draft", cursor: first.pagination.nextCursor },
  ]) {
    const result = await getProfessionalQuotes({ pool: poolWith(), limit: 1, ...input });
    assert.equal(result.ok, false);
    assert.equal(result.code, "QUOTES_CURSOR_SCOPE_MISMATCH");
  }
});

test("invalid authentication, filters, limits, cursors, and supplied authority fail before reads", async () => {
  const inputs = [
    { authenticatedActor: null },
    { authenticatedActor: { id: 77 }, classification: "needs_attention" },
    { authenticatedActor: { id: 77 }, limit: 0 },
    { authenticatedActor: { id: 77 }, limit: 101 },
    { authenticatedActor: { id: 77 }, cursor: "not-a-cursor" },
    { authenticatedActor: { id: 77 }, professionalUserId: 77 },
    { authenticatedActor: { id: 77 }, businessId: 12 },
  ];
  for (const input of inputs) {
    const pool = poolWith();
    const result = await getProfessionalQuotes({ pool, ...input });
    assert.equal(result.ok, false);
    assert.equal(pool.calls.length, 0);
  }
});

test("SQL enforces lifecycle-v2 professional role, active relationship, exact read grant, and coherent decisions", async () => {
  const pool = poolWith([]);
  await getProfessionalQuotes({ pool, authenticatedActor: { id: 77 } });
  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /relationships\.professional_user_id = \$1/);
  assert.match(sql, /relationships\.status = 'active'/);
  assert.match(sql, /professional_roles\.role = 'PRIMARY_PROFESSIONAL'/);
  assert.match(sql, /jobs\.lifecycle_contract_version = 2/);
  assert.match(sql, /read_grants\.capability = 'quote\.read'/);
  assert.match(sql, /read_grants\.scope_type = 'job'/);
  assert.match(sql, /read_revocations\.id IS NULL/);
  assert.match(sql, /participant_read_grants\.capability = 'participant\.read'/);
  assert.match(sql, /concern_read_grants\.capability = 'reported_concern\.read'/);
  assert.match(sql, /decisions\.issued_quote_version = aggregates\.current_version/);
  assert.match(sql, /quotes\.status = 'DRAFT'/);
  assert.match(sql, /quotes\.status = 'ISSUED'/);
  assert.match(sql, /decisions\.decision IN \('APPROVED', 'DECLINED'\)/);
  assert.doesNotMatch(sql, /customers\.email|customers\.phone|service_address_line1/);
});

test("read uses one coherent read-only snapshot and bounded identity, summary, and page queries", async () => {
  const pool = poolWith();
  await getProfessionalQuotes({ pool, authenticatedActor: { id: 77 } });
  assert.equal(pool.calls[0].text, "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(pool.calls.at(-1).text, "COMMIT");
  assert.equal(pool.calls.length, 5);
  assert.equal(pool.calls.filter(({ text }) => text.includes("COUNT(*) FILTER")).length, 1);
  assert.equal(pool.calls.filter(({ text }) => text.includes("ORDER BY classification_priority")).length, 1);
  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.doesNotMatch(sql, /SELECT\s+\*/i);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(sql, /loadQuoteProjection|listDraftQuotesByJob/);
});
