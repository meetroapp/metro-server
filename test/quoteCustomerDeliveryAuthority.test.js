"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  approveIssuedQuote,
  getCustomerIssuedQuote,
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");
const {
  quoteDeliveryRequestFingerprint,
} = require("../server/authorization/quoteDeliveryAuthority");

const IDS = Object.freeze({
  quote: "10000000-0000-4000-8000-000000000001",
  job: "20000000-0000-4000-8000-000000000002",
  participant: "30000000-0000-4000-8000-000000000003",
});

function context(overrides = {}) {
  return {
    id: IDS.quote,
    job_id: IDS.job,
    lifecycle_contract_version: 2,
    relationship_id: 21,
    relationship_status: "active",
    actor_participant_id: IDS.participant,
    actor_user_id: 77,
    customer_user_id: 77,
    professional_user_id: 88,
    actor_is_customer_representative: true,
    status: "ISSUED",
    current_version: 2,
    decision_id: null,
    ...overrides,
  };
}

function undeliveredPool({ customerContext = context() } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("quotes.*") && sql.includes("actor_is_customer_representative")) {
        return { rows: customerContext ? [customerContext] : [] };
      }
      if (sql.includes("/* lifecycle_authority:active_grant */")) {
        return { rows: [{ id: "40000000-0000-4000-8000-000000000004" }] };
      }
      if (sql.includes("SELECT grants.id")) {
        return { rows: [{ id: "50000000-0000-4000-8000-000000000005" }] };
      }
      if (sql.includes("FROM canonical_quote_issuances")) {
        return { rows: [{ quote_version: 2, source_snapshot_integrity_hash: "a".repeat(64) }] };
      }
      if (sql.includes("FROM messages deliveries")) return { rows: [] };
      throw new Error(`Unexpected customer delivery authority query: ${sql.slice(0, 100)}`);
    },
  };
}

test("customer direct detail fails closed before projection when exact delivery is absent", async () => {
  const pool = undeliveredPool();
  const result = await getCustomerIssuedQuote({
    pool,
    authenticatedActor: { id: 77 },
    quoteId: IDS.quote,
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 404,
    code: "QUOTE_UNAVAILABLE",
    message: "The Quote is unavailable.",
  });
  assert.equal(pool.calls.some((sql) => sql.includes("canonical_quote_scope_item_snapshots")), false);
});

test("customer decision fails closed before idempotency or mutation when exact delivery is absent", async () => {
  const pool = undeliveredPool();
  const result = await approveIssuedQuote({
    pool,
    authenticatedActor: { id: 77 },
    quoteId: IDS.quote,
    expectedIssuedVersion: 2,
    idempotencyKey: "delivery-gate-decision",
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.status, 404);
  assert.equal(result.code, "QUOTE_UNAVAILABLE");
  assert.equal(pool.calls.some((sql) => sql.includes("commercial_command_idempotency")), false);
  assert.equal(pool.calls.some((sql) => /INSERT INTO canonical_quote_customer_decisions/.test(sql)), false);
  assert.equal(pool.calls.at(-1), "ROLLBACK");
});

test("wrong customer receives the same bounded unavailable response without a delivery lookup", async () => {
  const pool = undeliveredPool({
    customerContext: context({
      actor_participant_id: null,
      actor_user_id: null,
      actor_is_customer_representative: false,
    }),
  });
  const result = await getCustomerIssuedQuote({
    pool,
    authenticatedActor: { id: 79 },
    quoteId: IDS.quote,
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.status, 404);
  assert.equal(result.code, "QUOTE_UNAVAILABLE");
  assert.equal(pool.calls.some((sql) => sql.includes("FROM messages deliveries")), false);
});

test("delivery proof is exact to Quote, Job, relationship, participants, and issued version", async () => {
  const calls = [];
  const delivered = await quoteDraftServiceInternals.loadQualifyingCustomerQuoteDelivery(
    {
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows: [{ id: 71, conversation_id: 17 }] };
      },
    },
    context(),
    2
  );
  assert.equal(delivered.id, 71);
  assert.deepEqual(calls[0].values.slice(0, 5), [IDS.quote, IDS.job, 21, 77, 88]);
  assert.equal(
    calls[0].values[5],
    quoteDeliveryRequestFingerprint({ actorId: 88, quoteId: IDS.quote, expectedIssuedVersion: 2 })
  );
  assert.equal(
    calls[0].values[5],
    "7688738c403611099516a40258dd38f2a40743eed29aff60b3a67677cf9aabf4"
  );
  assert.notEqual(
    calls[0].values[5],
    quoteDeliveryRequestFingerprint({ actorId: 88, quoteId: IDS.quote, expectedIssuedVersion: 1 })
  );
  for (const invariant of [
    /delivery_conversations\.relationship_id = deliveries_relationship\.id/,
    /deliveries\.sender_id = \$5/,
    /deliveries\.receiver_id = \$4/,
    /deliveries\.workflow_status = 'SENT'/,
    /deliveries\.workflow_payload ->> 'quoteId' = \$1::text/,
    /deliveries\.workflow_payload ->> 'jobId' = \$2::text/,
  ]) assert.match(calls[0].sql, invariant);
});
