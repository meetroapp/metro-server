"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getCustomerJobQuotes } = require("../server/authorization/customerJobQuotesService");
const { quoteDeliveryRequestFingerprint } = require("../server/authorization/quoteDeliveryAuthority");

const ID = Object.freeze({
  job: "60000000-0000-4000-8000-000000000006",
  quote: "10000000-0000-4000-8000-000000000001",
  customer: "80000000-0000-4000-8000-000000000008",
  professional: "90000000-0000-4000-8000-000000000009",
  conversation: "a0000000-0000-4000-8000-00000000000a",
});
function emergency(overrides = {}) {
  return {
    job_id: ID.job,
    source_type: "emergency_request",
    job_request_id: null,
    lifecycle_contract_version: 2,
    emergency_request_id: 51,
    relationship_id: 21,
    relationship_status: "active",
    homeowner_id: 77,
    professional_user_id: 88,
    customer_participant_id: ID.customer,
    professional_participant_id: ID.professional,
    conversation_id: ID.conversation,
    job_title: "Emergency leak",
    job_service: "Plumbing",
    business_name: "ABC Plumbing",
    customer_role_active: true,
    ...overrides,
  };
}
function deliveredQuote() {
  return {
    id: ID.quote, job_id: ID.job, status: "ISSUED", currency: "USD",
    lineage_type: null, created_at: "2026-08-10T12:00:00Z",
    updated_at: "2026-08-13T12:00:00Z", issued_at: "2026-08-12T12:00:00Z",
    total_minor: "92500", customer_decision: null, decided_at: null,
    business_status: "WAITING_ON_CUSTOMER", relevance_priority: 1,
    last_activity_at: "2026-08-13T12:00:00Z",
    has_approve_authority: true, has_decline_authority: true,
  };
}
function poolWith({ context = emergency(), readGrant = true, delivered = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT\n      jobs.id AS job_id")) return { rows: [] };
      if (sql.includes("emergency.title AS job_title")) {
        assert.deepEqual(params, [ID.job, 77]);
        return { rows: context ? [context] : [] };
      }
      if (sql.includes("SELECT EXISTS (")) {
        assert.equal(params[1], ID.job);
        return { rows: [{ can_read_customer_quotes: readGrant && params[0] === ID.customer }] };
      }
      if (sql.startsWith("SELECT quotes.id, aggregates.current_version")) {
        assert.deepEqual(params, [ID.job, 21, 51, ID.professional]);
        return { rows: [{ id: ID.quote, current_version: 3 }] };
      }
      if (sql.includes("SELECT\n      quotes.id")) {
        assert.deepEqual(params.slice(0, 4), [ID.job, 77, 21, ID.customer]);
        assert.deepEqual(params.slice(9), [51, ID.professional, ID.conversation, 88]);
        assert.equal(JSON.parse(params[8])[ID.quote], quoteDeliveryRequestFingerprint({
          actorId: 88, quoteId: ID.quote, expectedIssuedVersion: 3,
        }));
        return { rows: delivered ? [deliveredQuote()] : [] };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
    },
  };
}
async function read(pool) {
  return getCustomerJobQuotes({ pool, authenticatedActor: { id: 77 }, jobId: ID.job });
}

test("Emergency homeowner receives exact delivered Quote under canonical context and grant", async () => {
  const pool = poolWith();
  const result = await read(pool);
  assert.equal(result.code, "CUSTOMER_JOB_QUOTES_LOADED");
  assert.deepEqual(result.job, {
    id: ID.job, sourceType: "emergency_request", requestId: null,
    title: "Emergency leak", service: "Plumbing", issuerName: "ABC Plumbing",
  });
  assert.deepEqual(result.quotes.map(({ quoteId }) => quoteId), [ID.quote]);
  assert.equal("emergencyRequestId" in result.job, false);
  const sql = pool.calls.map(({ sql }) => sql).join("\n");
  for (const required of [
    "jobs.source_type = 'emergency_request'", "jobs.job_request_id IS NULL",
    "relationships.emergency_request_id = emergency.id",
    "relationships.status = 'active'", "customer.source_evidence_type = 'emergency_selection'",
    "roles.role = 'CUSTOMER_REPRESENTATIVE'", "grants.capability = 'quote.read_customer'",
    "quotes.emergency_request_id = $10", "aggregates.emergency_request_id = $10",
    "issuances.issuer_participant_id = $11",
    "issuances.source_snapshot_integrity_hash = versions.integrity_hash",
    "delivery_conversations.id = $12", "deliveries.sender_id = relationships.professional_user_id",
    "deliveries.receiver_id = $2", "deliveries.quote_id = quotes.id",
    "deliveries.job_id = quotes.job_id", "deliveries.delivery_request_fingerprint",
  ]) assert.ok(sql.includes(required), required);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+/i);
});

test("Emergency context and read authority reject wrong homeowner, role, relationship, participant and grant", async () => {
  for (const options of [
    { context: null },
    { context: emergency({ lifecycle_contract_version: 1 }) },
    { context: emergency({ job_id: "70000000-0000-4000-8000-000000000007" }) },
    { context: emergency({ homeowner_id: 99 }) },
    { context: emergency({ relationship_status: "closed" }) },
    { context: emergency({ customer_participant_id: null }) },
    { context: emergency({ customer_role_active: false }) },
    { context: emergency({ job_request_id: 16 }) },
    { context: emergency({ emergency_request_id: null }) },
    { context: emergency({ conversation_id: null }) },
    { context: emergency({ professional_participant_id: null }) },
    { readGrant: false },
  ]) {
    const pool = poolWith(options);
    const result = await read(pool);
    assert.equal(result.code, "CUSTOMER_JOB_QUOTES_UNAVAILABLE");
    assert.equal(pool.calls.some(({ sql }) => sql.includes("SELECT\n      quotes.id")), false);
  }
});

test("Emergency undelivered or wrong-fingerprint Quote is absent from the exact delivery-gated page", async () => {
  const pool = poolWith({ delivered: false });
  const result = await read(pool);
  assert.deepEqual(result.quotes, []);
  const pageSql = pool.calls.find(({ sql }) => sql.includes("SELECT\n      quotes.id")).sql;
  assert.match(pageSql, /relationships\.id = \$3/);
  assert.match(pageSql, /quotes\.job_id = \$1/);
  assert.match(pageSql, /deliveries\.workflow_payload ->> 'quoteId' = quotes\.id::text/);
  assert.match(pageSql, /deliveries\.workflow_payload ->> 'jobId' = quotes\.job_id::text/);
  assert.match(pageSql, /COALESCE\(\$9::jsonb ->> quotes\.id::text, ''\)/);
});
