"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  establishBusinessCustomerRelationship,
  getBusinessCustomerRelationship,
  getBusinessCustomerRelationshipByContact,
  listBusinessCustomerRelationships,
} = require("../server/relationships/businessCustomerRelationshipService");

const ACTOR_ONE = { id: 101 };
const ACTOR_TWO = { id: 202 };
const CONTACT_ONE = "11111111-1111-4111-8111-111111111111";
const CONTACT_TWO = "22222222-2222-4222-8222-222222222222";
const CONTACT_THREE = "55555555-5555-4555-8555-555555555555";
const RELATIONSHIP_ONE = "33333333-3333-4333-8333-333333333333";

let keyCounter = 500;
function key() {
  keyCounter += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(keyCounter).padStart(12, "0")}`;
}

function createMemoryStore() {
  const owners = new Map([[10, 101], [20, 202]]);
  const contacts = new Map([
    [CONTACT_ONE, {
      id: CONTACT_ONE,
      contractorProfileId: 10,
      partyType: "PERSON",
      displayName: "External Customer",
      companyName: null,
      email: "external@example.test",
      phone: "555-0100",
      address: "1 Main St",
      serviceArea: null,
      privateNote: "Business-private history.",
      status: "ACTIVE",
      version: 7,
      roles: [{ id: "role-one", role: "TENANT", active: true }],
    }],
    [CONTACT_TWO, {
      id: CONTACT_TWO,
      contractorProfileId: 20,
      partyType: "ORGANIZATION",
      displayName: "Other Business Customer",
      companyName: "Other Business Customer LLC",
      email: null,
      phone: null,
      address: null,
      serviceArea: "Denver",
      privateNote: null,
      status: "ACTIVE",
      version: 1,
      roles: [],
    }],
    [CONTACT_THREE, {
      id: CONTACT_THREE,
      contractorProfileId: 10,
      partyType: "PERSON",
      displayName: "Second External Customer",
      companyName: null,
      email: null,
      phone: null,
      address: null,
      serviceArea: null,
      privateNote: null,
      status: "ACTIVE",
      version: 1,
      roles: [],
    }],
  ]);
  const relationships = new Map();
  const commands = new Map();

  function copy(value) {
    return structuredClone(value);
  }

  function project(relationship) {
    const contact = contacts.get(relationship.businessContactId);
    return {
      ...copy(relationship),
      contact: {
        id: contact.id,
        partyType: contact.partyType,
        displayName: contact.displayName,
        companyName: contact.companyName,
        email: contact.email,
        phone: contact.phone,
        address: contact.address,
        serviceArea: contact.serviceArea,
        status: contact.status,
        version: contact.version,
      },
    };
  }

  function ownedContact(actorUserId, contractorProfileId, contactId) {
    const contact = contacts.get(contactId);
    return contact &&
      contact.contractorProfileId === contractorProfileId &&
      owners.get(contractorProfileId) === actorUserId
      ? contact
      : null;
  }

  function ownedRelationship(actorUserId, predicate) {
    const relationship = [...relationships.values()].find((candidate) =>
      predicate(candidate) && owners.get(candidate.contractorProfileId) === actorUserId
    );
    return relationship ? project(relationship) : null;
  }

  return {
    owners,
    contacts,
    relationships,
    commands,
    sideEffects: {
      users: 0,
      requestRelationships: 0,
      conversations: 0,
      jobs: 0,
      quotes: 0,
      decisions: 0,
      invoices: 0,
      payments: 0,
      visits: 0,
      lifecycle: 0,
    },
    async resolveOwner(_pool, actorUserId, contractorProfileId) {
      return owners.get(contractorProfileId) === actorUserId;
    },
    async establish(input) {
      if (!ownedContact(
        input.actorUserId,
        input.contractorProfileId,
        input.businessContactId
      )) return { kind: "not_found" };
      const commandId = `${input.actorUserId}:${input.command.operation}:${input.command.key}`;
      const existingCommand = commands.get(commandId);
      if (existingCommand) {
        return existingCommand.hash === input.command.hash
          ? { kind: "replay", response: copy(existingCommand.response) }
          : { kind: "idempotency_conflict" };
      }
      const existing = [...relationships.values()].find((relationship) =>
        relationship.contractorProfileId === input.contractorProfileId &&
        relationship.businessContactId === input.businessContactId
      );
      const relationship = existing || {
        id: input.relationshipId,
        contractorProfileId: input.contractorProfileId,
        businessContactId: input.businessContactId,
        version: 1,
        createdAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:00:00.000Z",
      };
      if (!existing) relationships.set(relationship.id, relationship);
      const response = { relationship: project(relationship) };
      commands.set(commandId, { hash: input.command.hash, response: copy(response) });
      return { kind: existing ? "existing" : "created", response };
    },
    async get(_pool, actorUserId, relationshipId) {
      return copy(ownedRelationship(
        actorUserId,
        (relationship) => relationship.id === relationshipId
      ));
    },
    async getByContact(_pool, actorUserId, businessContactId) {
      return copy(ownedRelationship(
        actorUserId,
        (relationship) => relationship.businessContactId === businessContactId
      ));
    },
    async list(_pool, actorUserId, contractorProfileId, limit) {
      return [...relationships.values()]
        .filter((relationship) => relationship.contractorProfileId === contractorProfileId)
        .filter((relationship) => owners.get(relationship.contractorProfileId) === actorUserId)
        .slice(0, limit)
        .map((relationship) => project(relationship));
    },
  };
}

function establishInput(store, overrides = {}) {
  return {
    store,
    authenticatedActor: ACTOR_ONE,
    idempotencyKey: key(),
    idFactory: () => RELATIONSHIP_ONE,
    payload: {
      contractorProfileId: 10,
      businessContactId: CONTACT_ONE,
    },
    ...overrides,
  };
}

test("explicitly establishes stable continuity for an external Contact without a Meetro user", async () => {
  const store = createMemoryStore();
  const result = await establishBusinessCustomerRelationship(establishInput(store));
  assert.equal(result.status, 201);
  assert.equal(result.relationship.id, RELATIONSHIP_ONE);
  assert.equal(result.relationship.contractorProfileId, 10);
  assert.equal(result.relationship.businessContactId, CONTACT_ONE);
  assert.equal(result.relationship.version, 1);
  assert.equal(result.relationship.contact.displayName, "External Customer");
  assert.equal("userId" in result.relationship.contact, false);
  assert.equal(store.sideEffects.users, 0);
});

test("requires owned Contact authority and hides cross-business Contact existence", async () => {
  const store = createMemoryStore();
  const denied = await establishBusinessCustomerRelationship(establishInput(store, {
    authenticatedActor: ACTOR_TWO,
  }));
  assert.equal(denied.status, 404);
  assert.equal(denied.code, "BUSINESS_CUSTOMER_RELATIONSHIP_CONTACT_NOT_FOUND");
  assert.equal(store.relationships.size, 0);
});

test("exact establish replay is idempotent and conflicting key reuse fails closed", async () => {
  const store = createMemoryStore();
  const idempotencyKey = key();
  const input = establishInput(store, { idempotencyKey });
  const first = await establishBusinessCustomerRelationship(input);
  const replay = await establishBusinessCustomerRelationship(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.relationship.id, first.relationship.id);
  const conflict = await establishBusinessCustomerRelationship({
    ...input,
    payload: { contractorProfileId: 10, businessContactId: CONTACT_THREE },
  });
  assert.equal(conflict.code, "BUSINESS_CUSTOMER_RELATIONSHIP_IDEMPOTENCY_CONFLICT");
});

test("alternate establishment retries return one owner-and-Contact relationship", async () => {
  const store = createMemoryStore();
  const first = await establishBusinessCustomerRelationship(establishInput(store));
  const second = await establishBusinessCustomerRelationship(establishInput(store, {
    idFactory: () => "44444444-4444-4444-8444-444444444444",
  }));
  assert.equal(second.code, "BUSINESS_CUSTOMER_RELATIONSHIP_EXISTS");
  assert.equal(second.relationship.id, first.relationship.id);
  assert.equal(store.relationships.size, 1);
});

test("list, read-by-ID, and Contact lookup return the same owner-scoped relationship", async () => {
  const store = createMemoryStore();
  const established = await establishBusinessCustomerRelationship(establishInput(store));
  const listed = await listBusinessCustomerRelationships({
    store,
    authenticatedActor: ACTOR_ONE,
    query: { contractorProfileId: 10 },
  });
  const read = await getBusinessCustomerRelationship({
    store,
    authenticatedActor: ACTOR_ONE,
    relationshipId: established.relationship.id,
  });
  const byContact = await getBusinessCustomerRelationshipByContact({
    store,
    authenticatedActor: ACTOR_ONE,
    businessContactId: CONTACT_ONE,
  });
  assert.deepEqual(listed.relationships.map((item) => item.id), [RELATIONSHIP_ONE]);
  assert.equal(read.relationship.id, RELATIONSHIP_ONE);
  assert.equal(byContact.relationship.id, RELATIONSHIP_ONE);
});

test("every relationship read rejects another business owner", async () => {
  const store = createMemoryStore();
  await establishBusinessCustomerRelationship(establishInput(store));
  const read = await getBusinessCustomerRelationship({
    store,
    authenticatedActor: ACTOR_TWO,
    relationshipId: RELATIONSHIP_ONE,
  });
  const byContact = await getBusinessCustomerRelationshipByContact({
    store,
    authenticatedActor: ACTOR_TWO,
    businessContactId: CONTACT_ONE,
  });
  const list = await listBusinessCustomerRelationships({
    store,
    authenticatedActor: ACTOR_TWO,
    query: { contractorProfileId: 10 },
  });
  assert.equal(read.status, 404);
  assert.equal(byContact.status, 404);
  assert.equal(list.status, 404);
});

test("relationship establishment leaves Contact identity, roles, Note, and version unchanged", async () => {
  const store = createMemoryStore();
  const before = structuredClone(store.contacts.get(CONTACT_ONE));
  const result = await establishBusinessCustomerRelationship(establishInput(store));
  assert.deepEqual(store.contacts.get(CONTACT_ONE), before);
  assert.equal("privateNote" in result.relationship.contact, false);
  assert.equal("roles" in result.relationship.contact, false);
  assert.equal(result.relationship.contact.version, 7);
});

test("Contact roles and active status are not prerequisites for explicit continuity", async () => {
  const store = createMemoryStore();
  const contact = store.contacts.get(CONTACT_ONE);
  contact.roles = [];
  contact.status = "ARCHIVED";
  const result = await establishBusinessCustomerRelationship(establishInput(store));
  assert.equal(result.status, 201);
  assert.equal(result.relationship.contact.status, "ARCHIVED");
  assert.deepEqual(contact.roles, []);
});

test("strict validation rejects unauthenticated, malformed, and authority-inventing input", async () => {
  const store = createMemoryStore();
  assert.equal((await establishBusinessCustomerRelationship({})).code, "AUTHENTICATION_REQUIRED");
  assert.equal((await establishBusinessCustomerRelationship(establishInput(store, {
    idempotencyKey: "bad",
  }))).code, "BUSINESS_CUSTOMER_RELATIONSHIP_IDEMPOTENCY_REQUIRED");
  assert.equal((await establishBusinessCustomerRelationship(establishInput(store, {
    payload: {
      contractorProfileId: 10,
      businessContactId: CONTACT_ONE,
      linkedUserId: 99,
    },
  }))).code, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED");
  assert.equal((await listBusinessCustomerRelationships({
    store,
    authenticatedActor: ACTOR_ONE,
    query: { contractorProfileId: 10, stage: "lead" },
  })).code, "BUSINESS_CUSTOMER_RELATIONSHIP_FIELD_REJECTED");
});

test("Customer Relationship runtime has no downstream or marketplace mutation authority", async () => {
  const store = createMemoryStore();
  await establishBusinessCustomerRelationship(establishInput(store));
  assert.deepEqual(Object.values(store.sideEffects), Array(10).fill(0));
  const source = readFileSync(
    join(__dirname, "..", "server", "relationships", "businessCustomerRelationshipService.js"),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:users|request_relationships|business_contacts|business_contact_roles|conversations|jobs|canonical_quotes|canonical_quote_customer_decisions|canonical_invoices|payments|canonical_visits|workflow_events)/i
  );
  assert.doesNotMatch(source, /openai|ask meetro|provider/i);
});
