"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listProfessionalQuoteCustomerOptions,
  professionalQuoteCustomerOptionsInternals,
} = require("../server/workflow/professionalQuoteCustomerOptionsService");

const CUSTOMER_ONE = 501;
const CUSTOMER_TWO = 502;
const JOB_ONE = "11111111-1111-4111-8111-111111111111";
const JOB_TWO = "22222222-2222-4222-8222-222222222222";
const JOB_THREE = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const CANONICAL_QUOTE = "55555555-5555-4555-8555-555555555555";

function row(overrides = {}) {
  return {
    customer_user_id: CUSTOMER_ONE,
    customer_name: "Jordan Customer",
    job_id: JOB_ONE,
    request_id: 81,
    relationship_id: 91,
    title: "Kitchen repair",
    service_city: "Orlando",
    discovery_area_label: "Orlando, FL",
    existing_working_draft_id: null,
    existing_canonical_quote_id: null,
    created_at: "2026-09-06T12:00:00.000Z",
    ...overrides,
  };
}

function pool(rows = [row()]) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("professional_quote_customer_options:list")) return { rows };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

test("unauthenticated Quote customer option reads fail closed", async () => {
  const result = await listProfessionalQuoteCustomerOptions({
    pool: pool(),
    authenticatedActor: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("canonical authenticated customer identity groups multiple eligible Jobs", async () => {
  const database = pool([
    row(),
    row({ job_id: JOB_TWO, request_id: 82, relationship_id: 92, title: "Bath repair" }),
    row({
      customer_user_id: CUSTOMER_TWO,
      customer_name: "Jordan Customer",
      job_id: JOB_THREE,
      request_id: 83,
      relationship_id: 93,
      title: "Roof repair",
    }),
  ]);
  const result = await listProfessionalQuoteCustomerOptions({
    pool: database,
    authenticatedActor: { id: 77 },
  });
  assert.equal(result.code, "PROFESSIONAL_QUOTE_CUSTOMER_OPTIONS_LOADED");
  assert.equal(result.contractVersion, 1);
  assert.equal(result.customers.length, 2);
  assert.equal(result.customers[0].customerId, CUSTOMER_ONE);
  assert.deepEqual(result.customers[0].jobs.map(({ jobId }) => jobId), [JOB_ONE, JOB_TWO]);
  assert.equal(result.customers[1].customerId, CUSTOMER_TWO);
  assert.equal(result.customers[0].displayName, result.customers[1].displayName);
  assert.notEqual(result.customers[0].customerId, result.customers[1].customerId);
  assert.deepEqual(database.calls[1].params, [
    77,
    ["participant.read", "quote.create", "quote.read", "quote.scope.manage"],
  ]);
});

test("an unrelated professional receives no Job owned by another professional", async () => {
  const calls = [];
  const database = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("professional_quote_customer_options:list")) {
        return { rows: params[0] === 77 ? [row()] : [] };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };
  const result = await listProfessionalQuoteCustomerOptions({
    pool: database,
    authenticatedActor: { id: 88 },
  });
  assert.deepEqual(result.customers, []);
  assert.equal(database.calls[1].params[0], 88);
});

test("returned Job authority and existing-root state are exact and bounded", () => {
  const available = professionalQuoteCustomerOptionsInternals.jobProjection(row());
  assert.deepEqual(available, {
    jobId: JOB_ONE,
    requestId: 81,
    relationshipId: 91,
    title: "Kitchen repair",
    city: "Orlando",
    serviceArea: "Orlando, FL",
    customerName: "Jordan Customer",
    newQuoteEligible: true,
    existingQuote: null,
  });
  const existing = professionalQuoteCustomerOptionsInternals.jobProjection(row({
    existing_working_draft_id: DRAFT,
  }));
  assert.equal(existing.newQuoteEligible, false);
  assert.deepEqual(existing.existingQuote, {
    workingDraftId: DRAFT,
    canonicalQuoteId: null,
  });
  const canonical = professionalQuoteCustomerOptionsInternals.jobProjection(row({
    existing_canonical_quote_id: CANONICAL_QUOTE,
  }));
  assert.equal(canonical.newQuoteEligible, false);
  assert.deepEqual(canonical.existingQuote, {
    workingDraftId: null,
    canonicalQuoteId: CANONICAL_QUOTE,
  });
});

test("SQL proves marketplace customer and professional authority and excludes external Contacts", () => {
  const sql = professionalQuoteCustomerOptionsInternals.QUOTE_CUSTOMER_OPTIONS_SQL;
  assert.match(sql, /jobs\.source_type = 'ordinary_request_selection'/);
  assert.match(sql, /relationships\.status = 'active'/);
  assert.match(sql, /relationships\.professional_user_id = \$1/);
  assert.match(sql, /customer_participants\.identity_type = 'authenticated_user'/);
  assert.match(sql, /customer_roles\.role = 'CUSTOMER_REPRESENTATIVE'/);
  assert.match(sql, /professional_participants\.user_id = \$1/);
  assert.match(sql, /professional_roles\.role = 'PRIMARY_PROFESSIONAL'/);
  assert.match(sql, /customer_role_revocations\.id IS NULL/);
  assert.match(sql, /professional_role_revocations\.id IS NULL/);
  assert.match(sql, /grants\.capability = required\.capability/);
  assert.match(sql, /grant_revocations\.id IS NULL/);
  assert.match(sql, /canonical_quotes quotes[\s\S]*quotes\.parent_quote_id IS NULL/);
  assert.match(sql, /business_document_working_drafts drafts[\s\S]*drafts\.document_type = 'QUOTE'/);
  assert.match(sql, /drafts\.draft_status = 'WORKING_DRAFT'/);
  assert.doesNotMatch(sql, /business_contacts|business_customer_relationships/);
});

test("inactive marketplace relationships are excluded", () => {
  const sql = professionalQuoteCustomerOptionsInternals.QUOTE_CUSTOMER_OPTIONS_SQL;
  assert.match(sql, /relationships\.status = 'active'/);
  assert.match(sql, /relationships\.professional_user_id = \$1/);
});

test("missing or revoked authenticated customer participant authority is excluded", () => {
  const sql = professionalQuoteCustomerOptionsInternals.QUOTE_CUSTOMER_OPTIONS_SQL;
  assert.match(sql, /INNER JOIN relationship_participants customer_participants/);
  assert.match(sql, /customer_participants\.identity_type = 'authenticated_user'/);
  assert.match(sql, /customer_roles\.role = 'CUSTOMER_REPRESENTATIVE'/);
  assert.match(sql, /customer_role_revocations\.id IS NULL/);
});

test("missing or revoked professional participant authority is excluded", () => {
  const sql = professionalQuoteCustomerOptionsInternals.QUOTE_CUSTOMER_OPTIONS_SQL;
  assert.match(sql, /professional_participants\.user_id = \$1/);
  assert.match(sql, /professional_participants\.identity_type = 'authenticated_user'/);
  assert.match(sql, /professional_roles\.role = 'PRIMARY_PROFESSIONAL'/);
  assert.match(sql, /professional_role_revocations\.id IS NULL/);
});

test("every current Quote capability is required and revoked grants are excluded", () => {
  const sql = professionalQuoteCustomerOptionsInternals.QUOTE_CUSTOMER_OPTIONS_SQL;
  assert.deepEqual(professionalQuoteCustomerOptionsInternals.REQUIRED_CAPABILITIES, [
    "participant.read",
    "quote.create",
    "quote.read",
    "quote.scope.manage",
  ]);
  assert.match(sql, /unnest\(\$2::text\[\]\)/);
  assert.match(sql, /grants\.capability = required\.capability/);
  assert.match(sql, /grant_revocations\.id IS NULL/);
});

test("only valid active canonical Jobs are projected", () => {
  const sql = professionalQuoteCustomerOptionsInternals.QUOTE_CUSTOMER_OPTIONS_SQL;
  assert.match(sql, /posts\.lifecycle_contract_version = 2/);
  assert.match(sql, /posts\.cancelled_at IS NULL/);
  assert.match(sql, /selections\.ended_at IS NULL/);
  assert.match(sql, /NOT EXISTS[\s\S]*canonical_job_completion_records/);
});

test("external Business Contacts can never enter the Meetro options query", () => {
  const sql = professionalQuoteCustomerOptionsInternals.QUOTE_CUSTOMER_OPTIONS_SQL;
  assert.doesNotMatch(sql, /business_contacts|business_customer_relationships/);
});

test("GET runs in a read-only transaction and contains no mutation", async () => {
  const database = pool();
  await listProfessionalQuoteCustomerOptions({
    pool: database,
    authenticatedActor: { id: 77 },
  });
  assert.equal(database.calls[0].sql, "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(database.calls.at(-1).sql, "COMMIT");
  const sql = database.calls.map(({ sql }) => sql).join("\n");
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
});
