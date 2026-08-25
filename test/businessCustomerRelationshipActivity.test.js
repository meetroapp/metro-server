"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  businessCustomerRelationshipInternals,
  getBusinessCustomerRelationshipActivity,
} = require("../server/relationships/businessCustomerRelationshipService");

const ACTOR = { id: 101 };
const OTHER_ACTOR = { id: 202 };
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const RELATIONSHIP_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const INVOICE_ID = "55555555-5555-4555-8555-555555555555";

function createPool({ owned = true, archived = false, empty = false } = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, values = []) {
      const text = String(sql);
      calls.push({ sql: text, values });
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(text)) return { rows: [], rowCount: 0 };
      if (text.includes("business_customer_relationship:load_owned")) {
        if (!owned || Number(values[1]) !== ACTOR.id) return { rows: [] };
        return { rows: [{
          id: RELATIONSHIP_ID,
          contractor_profile_id: 10,
          business_contact_id: CONTACT_ID,
          version: 1,
          created_at: "2026-08-20T10:00:00.000Z",
          updated_at: "2026-08-20T10:00:00.000Z",
          contact_party_type: "PERSON",
          contact_display_name: "External Customer",
          contact_company_name: null,
          contact_email: "external@example.test",
          contact_phone: "555-0100",
          contact_address_text: "1 Main St",
          contact_service_area_text: null,
          contact_status: archived ? "ARCHIVED" : "ACTIVE",
          contact_version: 3,
        }] };
      }
      if (text.includes("business_customer_relationship:activity_work")) {
        return { rows: empty ? [] : [{
          job_id: JOB_ID,
          service_title: "Kitchen repair",
          service_category: "Handyman",
          job_created_at: "2026-08-21T12:00:00.000Z",
          completion_status: "COMPLETED",
          completed_at: "2026-08-23T12:00:00.000Z",
          linked_at: "2026-08-21T12:01:00.000Z",
        }] };
      }
      if (text.includes("business_customer_relationship:activity_quotes")) {
        return { rows: empty ? [] : [{
          quote_id: QUOTE_ID,
          job_id: JOB_ID,
          job_title: "Kitchen repair",
          document_number: "Q-0001020",
          status: "ISSUED",
          classification: "APPROVED",
          customer_decision: "APPROVED",
          currency: "USD",
          total_minor: "28999",
          created_at: "2026-08-21T13:00:00.000Z",
          updated_at: "2026-08-21T14:00:00.000Z",
          issued_at: "2026-08-21T15:00:00.000Z",
          decided_at: "2026-08-22T15:00:00.000Z",
          last_activity_at: "2026-08-22T15:00:00.000Z",
          linked_at: "2026-08-21T13:01:00.000Z",
        }] };
      }
      if (text.includes("business_customer_relationship:activity_invoices")) {
        return { rows: empty ? [] : [{
          invoice_id: INVOICE_ID,
          invoice_number: "INV-ABCDEF123456",
          job_id: JOB_ID,
          job_title: "Kitchen repair",
          status: "PARTIALLY_PAID",
          currency: "USD",
          total_minor: "28999",
          paid_minor: "10000",
          balance_minor: "18999",
          invoice_date: "2026-08-23",
          created_at: "2026-08-23T13:00:00.000Z",
          updated_at: "2026-08-24T13:00:00.000Z",
          issued_at: "2026-08-23T14:00:00.000Z",
          last_activity_at: "2026-08-24T13:00:00.000Z",
          linked_at: "2026-08-23T13:01:00.000Z",
        }] };
      }
      if (text.includes("business_customer_relationship:activity_media")) {
        return { rows: empty ? [] : [{
          job_id: JOB_ID,
          job_title: "Kitchen repair",
          media_id: "meetro/users/101/request-photos/kitchen-before",
          secure_url: "https://res.cloudinary.com/meetro/image/upload/v1/meetro/users/101/request-photos/kitchen-before.jpg",
          format: "jpg",
          uploaded_at: "2026-08-21T11:00:00.000Z",
        }] };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  return pool;
}

function input(pool, overrides = {}) {
  return {
    pool,
    authenticatedActor: ACTOR,
    relationshipId: RELATIONSHIP_ID,
    ...overrides,
  };
}

test("owned Customer Relationship returns canonical work, Quote, and Invoice activity", async () => {
  const pool = createPool();
  const result = await getBusinessCustomerRelationshipActivity(input(pool));
  assert.equal(result.status, 200);
  assert.equal(result.code, "BUSINESS_CUSTOMER_RELATIONSHIP_ACTIVITY_LOADED");
  assert.deepEqual(result.activity.relationship, {
    id: RELATIONSHIP_ID,
    contractorProfileId: 10,
    businessContactId: CONTACT_ID,
    contactStatus: "ACTIVE",
  });
  assert.deepEqual(result.activity.work[0], {
    jobId: JOB_ID,
    title: "Kitchen repair",
    service: "Handyman",
    status: "COMPLETED",
    createdAt: "2026-08-21T12:00:00.000Z",
    completedAt: "2026-08-23T12:00:00.000Z",
    linkedAt: "2026-08-21T12:01:00.000Z",
  });
  assert.equal(result.activity.quotes[0].documentNumber, "Q-0001020");
  assert.equal(result.activity.quotes[0].classification, "APPROVED");
  assert.equal(result.activity.quotes[0].customerDecision, "APPROVED");
  assert.equal(result.activity.quotes[0].totalMinor, 28999);
  assert.equal(result.activity.invoices[0].status, "PARTIALLY_PAID");
  assert.equal(result.activity.invoices[0].paidMinor, 10000);
  assert.equal(result.activity.invoices[0].balanceMinor, 18999);
  assert.deepEqual(result.activity.documents.map(({ documentType }) => documentType), [
    "INVOICE",
    "QUOTE",
  ]);
  assert.equal(result.activity.media[0].parentId, JOB_ID);
});

test("cross-business activity read fails closed before any history query", async () => {
  const pool = createPool();
  const result = await getBusinessCustomerRelationshipActivity(input(pool, {
    authenticatedActor: OTHER_ACTOR,
  }));
  assert.equal(result.status, 404);
  assert.equal(result.code, "BUSINESS_CUSTOMER_RELATIONSHIP_NOT_FOUND");
  assert.equal(pool.calls.some(({ sql }) => sql.includes(":activity_")), false);
});

test("relationship with no canonical customer-party links returns truthful empty arrays", async () => {
  const result = await getBusinessCustomerRelationshipActivity(input(createPool({ empty: true })));
  assert.deepEqual(result.activity.work, []);
  assert.deepEqual(result.activity.quotes, []);
  assert.deepEqual(result.activity.invoices, []);
  assert.deepEqual(result.activity.documents, []);
  assert.deepEqual(result.activity.media, []);
});

test("archived external Contact retains historical activity without Meetro account identity", async () => {
  const result = await getBusinessCustomerRelationshipActivity(input(createPool({ archived: true })));
  assert.equal(result.activity.relationship.contactStatus, "ARCHIVED");
  assert.equal(result.activity.work.length, 1);
  assert.equal(result.activity.quotes.length, 1);
  assert.equal(result.activity.invoices.length, 1);
  assert.equal(result.activity.documents.length, 2);
  assert.equal(result.activity.media.length, 1);
  assert.equal("userId" in result.activity.relationship, false);
  assert.equal("email" in result.activity.relationship, false);
  assert.equal("phone" in result.activity.relationship, false);
});

test("every history query is scoped to the exact business, Contact, and Relationship", async () => {
  const pool = createPool();
  await getBusinessCustomerRelationshipActivity(input(pool));
  const queries = pool.calls.filter(({ sql }) => sql.includes(":activity_"));
  assert.equal(queries.length, 4);
  for (const query of queries) {
    assert.deepEqual(query.values, [10, CONTACT_ID, RELATIONSHIP_ID]);
    assert.match(query.sql, /parties\.contractor_profile_id = \$1/);
    assert.match(query.sql, /parties\.business_contact_id = \$2/);
    assert.match(query.sql, /parties\.business_customer_relationship_id = \$3/);
  }
});

test("history identity comes only from canonical customer-party linkage tables", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.match(source, /FROM job_customer_parties parties/);
  assert.match(source, /FROM canonical_quote_customer_parties parties/);
  assert.match(source, /FROM canonical_invoice_customer_parties parties/);
  assert.doesNotMatch(source, /request_relationships/);
  assert.doesNotMatch(source, /contacts\.(?:display_name|email|phone)/);
  assert.doesNotMatch(source, /(?:customer|contact).*(?:name|email|phone).*=/i);
});

test("canonical Quote and Invoice current-state authorities drive the projections", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.match(source, /canonical_quote_versions current/);
  assert.match(source, /current\.version = aggregates\.current_version/);
  assert.match(source, /canonical_quote_customer_decisions decisions/);
  assert.match(source, /decisions\.issued_quote_version = aggregates\.current_version/);
  assert.match(source, /canonical_invoice_versions versions/);
  assert.match(source, /ORDER BY versions\.version DESC/);
  assert.match(source, /current\.paid_minor/);
  assert.match(source, /current\.balance_minor/);
});

test("activity ordering is newest-authoritative-first with a stable identity tie-breaker", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.match(source, /COALESCE\(completions\.completed_at, jobs\.created_at\) DESC,[\s\S]*jobs\.id ASC/);
  assert.match(source, /ORDER BY last_activity_at DESC NULLS LAST, quotes\.id ASC/);
  assert.match(source, /ORDER BY last_activity_at DESC NULLS LAST, invoices\.id ASC/);
  assert.match(source, /ORDER BY photo\.item->>'uploaded_at' DESC NULLS LAST,[\s\S]*photo\.item->>'public_id' ASC/);
});

test("activity projection contains no CRM analytics, fabricated history, or mutation SQL", async () => {
  const pool = createPool();
  const result = await getBusinessCustomerRelationshipActivity(input(pool));
  const serialized = JSON.stringify(result.activity);
  assert.doesNotMatch(serialized, /score|health|engagement|churn|probability|lifetimeValue|salesStage|urgency/i);
  for (const call of pool.calls) {
    assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE|UPSERT)\b/i);
  }
  assert.match(pool.calls[0].sql, /READ ONLY/);
  assert.equal(pool.calls.at(-1).sql, "COMMIT");
});

test("strict activity input rejects malformed identity and unsupported authority fields", async () => {
  assert.equal((await getBusinessCustomerRelationshipActivity({})).code, "AUTHENTICATION_REQUIRED");
  assert.equal((await getBusinessCustomerRelationshipActivity({
    pool: createPool(),
    authenticatedActor: ACTOR,
    relationshipId: "invalid",
  })).code, "BUSINESS_CUSTOMER_RELATIONSHIP_ID_INVALID");
  assert.equal((await getBusinessCustomerRelationshipActivity({
    pool: createPool(),
    authenticatedActor: ACTOR,
    relationshipId: RELATIONSHIP_ID,
    customerEmail: "external@example.test",
  })).code, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED");
});

test("relationship activity implementation adds no schema, AI, or downstream mutation path", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "relationships", "businessCustomerRelationshipService.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /openai|provider|ask meetro/i);
  assert.doesNotMatch(
    String(businessCustomerRelationshipInternals.sqlStore.getActivity),
    /business_document_working_drafts|business_document_draft_media|moments|conversations/i
  );
});
