"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  getJobCustomerParty,
  linkJobCustomerParty,
  customerPartyInternals: {
    normalizeCustomerParty,
    resolveInvoiceCustomerParty,
  },
} = require("../server/relationships/customerPartyService");

const ACTOR_ONE = { id: 101 };
const ACTOR_TWO = { id: 202 };
const JOB_ONE = "11111111-1111-4111-8111-111111111111";
const CONTACT_ONE = "22222222-2222-4222-8222-222222222222";
const CONTACT_TWO = "33333333-3333-4333-8333-333333333333";
const RELATIONSHIP_ONE = "44444444-4444-4444-8444-444444444444";
const RELATIONSHIP_TWO = "55555555-5555-4555-8555-555555555555";
const COMMAND_ONE = "66666666-6666-4666-8666-666666666666";

function party(overrides = {}) {
  return {
    contractorProfileId: 10,
    businessContactId: CONTACT_ONE,
    customerRelationshipId: RELATIONSHIP_ONE,
    ...overrides,
  };
}

function createMemoryStore() {
  const links = new Map();
  const commands = new Map();
  const validParties = new Map([
    [`101:${CONTACT_ONE}:${RELATIONSHIP_ONE}`, party()],
    [`101:${CONTACT_TWO}:${RELATIONSHIP_TWO}`, party({
      businessContactId: CONTACT_TWO,
      customerRelationshipId: RELATIONSHIP_TWO,
    })],
  ]);
  const sideEffects = {
    contacts: 0,
    relationships: 0,
    users: 0,
    requestRelationships: 0,
    conversations: 0,
    quoteDecisions: 0,
    invoicePayments: 0,
    visits: 0,
    moments: 0,
    lifecycle: 0,
  };
  return {
    links,
    commands,
    validParties,
    sideEffects,
    async link(input) {
      if (input.actorUserId !== 101) return { kind: "authority_denied" };
      const owned = validParties.get(
        `${input.actorUserId}:${input.party.businessContactId}:${input.party.customerRelationshipId}`
      );
      if (!owned) return { kind: "party_unavailable" };
      const commandKey = `${input.actorUserId}:${input.idempotencyKey}`;
      const priorCommand = commands.get(commandKey);
      if (priorCommand) {
        return priorCommand.hash === input.requestHash
          ? { kind: "replay", customerParty: structuredClone(priorCommand.party) }
          : { kind: "idempotency_conflict" };
      }
      const existing = links.get(input.jobId);
      if (existing && (
        existing.businessContactId !== owned.businessContactId ||
        existing.customerRelationshipId !== owned.customerRelationshipId
      )) return { kind: "link_conflict" };
      const linked = existing || {
        ...owned,
        jobId: input.jobId,
        linkedAt: "2026-08-24T12:00:00.000Z",
      };
      links.set(input.jobId, linked);
      commands.set(commandKey, {
        hash: input.requestHash,
        party: structuredClone(linked),
      });
      return { kind: existing ? "existing" : "linked", customerParty: linked };
    },
    async get({ actorUserId, jobId }) {
      return actorUserId === 101 ? links.get(jobId) || null : null;
    },
  };
}

function input(store, overrides = {}) {
  return {
    store,
    authenticatedActor: ACTOR_ONE,
    jobId: JOB_ONE,
    idempotencyKey: COMMAND_ONE,
    payload: {
      businessContactId: CONTACT_ONE,
      customerRelationshipId: RELATIONSHIP_ONE,
    },
    ...overrides,
  };
}

test("explicitly links an external Contact and Relationship to the canonical Job without a user", async () => {
  const store = createMemoryStore();
  const result = await linkJobCustomerParty(input(store));
  assert.equal(result.status, 201);
  assert.equal(result.customerParty.jobId, JOB_ONE);
  assert.equal(result.customerParty.businessContactId, CONTACT_ONE);
  assert.equal(result.customerParty.customerRelationshipId, RELATIONSHIP_ONE);
  assert.equal("userId" in result.customerParty, false);
  assert.deepEqual(Object.values(store.sideEffects), new Array(10).fill(0));

  const loaded = await getJobCustomerParty({
    store,
    authenticatedActor: ACTOR_ONE,
    jobId: JOB_ONE,
  });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.customerParty.businessContactId, CONTACT_ONE);
});

test("cross-business Job authority and unavailable or mismatched parties fail closed", async () => {
  const store = createMemoryStore();
  const crossBusiness = await linkJobCustomerParty(input(store, {
    authenticatedActor: ACTOR_TWO,
  }));
  assert.equal(crossBusiness.status, 403);

  const wrongRelationship = await linkJobCustomerParty(input(store, {
    payload: {
      businessContactId: CONTACT_ONE,
      customerRelationshipId: RELATIONSHIP_TWO,
    },
  }));
  assert.equal(wrongRelationship.status, 404);
  assert.equal(store.links.size, 0);
});

test("exact replay is idempotent while changed payload and Job reassignment conflict", async () => {
  const store = createMemoryStore();
  const first = await linkJobCustomerParty(input(store));
  const replay = await linkJobCustomerParty(input(store));
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);
  assert.equal(store.links.size, 1);

  const changedCommand = await linkJobCustomerParty(input(store, {
    payload: {
      businessContactId: CONTACT_TWO,
      customerRelationshipId: RELATIONSHIP_TWO,
    },
  }));
  assert.equal(changedCommand.status, 409);

  const reassignment = await linkJobCustomerParty(input(store, {
    idempotencyKey: "77777777-7777-4777-8777-777777777777",
    payload: {
      businessContactId: CONTACT_TWO,
      customerRelationshipId: RELATIONSHIP_TWO,
    },
  }));
  assert.equal(reassignment.status, 409);
  assert.equal(store.links.get(JOB_ONE).businessContactId, CONTACT_ONE);
});

test("customer-party input requires explicit exact UUIDs and never accepts identity text", () => {
  assert.equal(normalizeCustomerParty({
    businessContactId: CONTACT_ONE,
    customerRelationshipId: RELATIONSHIP_ONE,
  }).mode, "LINK");
  assert.equal(normalizeCustomerParty(undefined, { allowOmitted: true }).mode, "PRESERVE");
  assert.equal(normalizeCustomerParty(null).mode, "CLEAR");
  for (const invalid of [
    { customerName: "Jack Smith" },
    { email: "jack@example.test" },
    { phone: "555-0100" },
    { businessContactId: CONTACT_ONE, customerRelationshipId: RELATIONSHIP_ONE, userId: 7 },
  ]) assert.equal(normalizeCustomerParty(invalid), null);
});

test("Invoice customer-party propagation is deterministic and conflicts fail closed", () => {
  const linked = party();
  assert.deepEqual(resolveInvoiceCustomerParty({ jobParty: linked }), {
    party: linked,
    sourceType: "JOB",
    sourceQuoteId: null,
  });
  assert.deepEqual(resolveInvoiceCustomerParty({
    quoteParties: [
      { sourceQuoteId: "quote-one", party: linked },
      { sourceQuoteId: "quote-two", party: { ...linked } },
    ],
  }), {
    party: linked,
    sourceType: "CANONICAL_QUOTE",
    sourceQuoteId: "quote-one",
  });
  assert.deepEqual(resolveInvoiceCustomerParty({
    jobParty: linked,
    quoteParties: [{ sourceQuoteId: "quote-two", party: party({ businessContactId: CONTACT_TWO }) }],
  }), { error: "CUSTOMER_PARTY_SOURCE_CONFLICT" });
  assert.deepEqual(resolveInvoiceCustomerParty(), {
    party: null,
    sourceType: null,
    sourceQuoteId: null,
  });
});

test("implementation contains no text matching or competing identity creation path", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "relationships", "customerPartyService.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /INSERT INTO\s+(business_contacts|business_customer_relationships|users|request_relationships|conversations)/i);
  assert.doesNotMatch(source, /email_normalized|phone_normalized|customer_name|customerName/i);
  assert.doesNotMatch(source, /UPDATE\s+(business_contacts|business_customer_relationships|jobs|canonical_quotes|canonical_invoices)/i);
});
