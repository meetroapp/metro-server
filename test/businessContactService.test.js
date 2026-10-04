"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  archiveBusinessContact,
  assignBusinessContactRole,
  createBusinessContact,
  endBusinessContactRole,
  getBusinessContact,
  listBusinessContacts,
  updateBusinessContact,
} = require("../server/contacts/businessContactService");

const ACTOR_ONE = { id: 101 };
const ACTOR_TWO = { id: 202 };
const CONTACT_ONE = "11111111-1111-4111-8111-111111111111";
const CONTACT_TWO = "22222222-2222-4222-8222-222222222222";
const ROLE_ONE = "33333333-3333-4333-8333-333333333333";

let keyCounter = 100;
function key() {
  keyCounter += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(keyCounter).padStart(12, "0")}`;
}

function createMemoryStore() {
  const owners = new Map([[10, 101], [20, 202]]);
  const contacts = new Map();
  const commands = new Map();

  function copy(value) {
    return structuredClone(value);
  }

  function owned(actorUserId, contactId) {
    const contact = contacts.get(contactId);
    return contact && owners.get(contact.contractorProfileId) === actorUserId
      ? contact
      : null;
  }

  function commandResult(input, action) {
    const commandKey = `${input.actorUserId}:${input.command.operation}:${input.command.key}`;
    const existing = commands.get(commandKey);
    if (existing) {
      return existing.hash === input.command.hash
        ? { kind: "replay", response: copy(existing.response) }
        : { kind: "idempotency_conflict" };
    }
    const outcome = action();
    if (outcome.response) {
      commands.set(commandKey, {
        hash: input.command.hash,
        response: copy(outcome.response),
      });
    }
    return outcome;
  }

  function duplicates(contact) {
    const email = contact.email?.trim().toLowerCase() || null;
    const phone = contact.phone?.replace(/\D/g, "") || null;
    return [...contacts.values()]
      .filter((candidate) => candidate.id !== contact.id)
      .filter((candidate) => candidate.contractorProfileId === contact.contractorProfileId)
      .filter((candidate) =>
        (email && candidate.email?.trim().toLowerCase() === email) ||
        (phone && candidate.phone?.replace(/\D/g, "") === phone)
      )
      .map(copy);
  }

  return {
    contacts,
    async resolveOwner(_pool, actorUserId, contractorProfileId) {
      return owners.get(contractorProfileId) === actorUserId;
    },
    async create(input) {
      return commandResult(input, () => {
        const contact = {
          id: input.contactId,
          contractorProfileId: input.contractorProfileId,
          ...input.fields,
          status: "ACTIVE",
          version: 1,
          roles: [],
        };
        contacts.set(contact.id, contact);
        return {
          kind: "created",
          response: { contact: copy(contact), duplicateCandidates: duplicates(contact) },
        };
      });
    },
    async get(_pool, actorUserId, contactId) {
      return copy(owned(actorUserId, contactId));
    },
    async list(_pool, actorUserId, contractorProfileId, query) {
      const search = query.search?.toLowerCase() || null;
      return [...contacts.values()]
        .filter((contact) => owners.get(contact.contractorProfileId) === actorUserId)
        .filter((contact) => contact.contractorProfileId === contractorProfileId)
        .filter((contact) => query.status === "ALL" || contact.status === query.status)
        .filter((contact) => !query.role || contact.roles.some((role) => role.role === query.role && role.active))
        .filter((contact) => !search || [
          contact.displayName, contact.companyName, contact.email, contact.phone,
          contact.address, contact.serviceArea,
        ].some((value) => String(value || "").toLowerCase().includes(search)))
        .slice(0, query.limit)
        .map(copy);
    },
    async update(input) {
      const contact = owned(input.actorUserId, input.contactId);
      if (!contact) return { kind: "not_found" };
      return commandResult({ ...input, contractorProfileId: contact.contractorProfileId }, () => {
        if (contact.status === "ARCHIVED") return { kind: "archived" };
        if (contact.version !== input.expectedVersion) {
          return { kind: "version_conflict", currentVersion: contact.version };
        }
        Object.assign(contact, input.patch);
        contact.version += 1;
        return {
          kind: "updated",
          response: { contact: copy(contact), duplicateCandidates: duplicates(contact) },
        };
      });
    },
    async assignRole(input) {
      const contact = owned(input.actorUserId, input.contactId);
      if (!contact) return { kind: "not_found" };
      return commandResult({ ...input, contractorProfileId: contact.contractorProfileId }, () => {
        if (contact.status === "ARCHIVED") return { kind: "archived" };
        if (contact.version !== input.expectedVersion) {
          return { kind: "version_conflict", currentVersion: contact.version };
        }
        if (contact.roles.some((entry) => entry.role === input.role && entry.active)) {
          return { kind: "role_active" };
        }
        contact.roles.push({
          id: input.roleId,
          role: input.role,
          active: true,
          assignmentSource: "PROFESSIONAL_EXPLICIT",
          sourceReference: input.sourceReference,
        });
        contact.version += 1;
        return { kind: "role_assigned", response: { contact: copy(contact) } };
      });
    },
    async endRole(input) {
      const contact = owned(input.actorUserId, input.contactId);
      if (!contact) return { kind: "not_found" };
      return commandResult({ ...input, contractorProfileId: contact.contractorProfileId }, () => {
        if (contact.status === "ARCHIVED") return { kind: "archived" };
        if (contact.version !== input.expectedVersion) {
          return { kind: "version_conflict", currentVersion: contact.version };
        }
        const role = contact.roles.find((entry) => entry.id === input.roleId && entry.active);
        if (!role) return { kind: "role_not_found" };
        role.active = false;
        role.endedAt = "2026-08-24T12:00:00.000Z";
        contact.version += 1;
        return { kind: "role_ended", response: { contact: copy(contact) } };
      });
    },
    async archive(input) {
      const contact = owned(input.actorUserId, input.contactId);
      if (!contact) return { kind: "not_found" };
      return commandResult({ ...input, contractorProfileId: contact.contractorProfileId }, () => {
        if (contact.status === "ARCHIVED") return { kind: "archived" };
        if (contact.version !== input.expectedVersion) {
          return { kind: "version_conflict", currentVersion: contact.version };
        }
        contact.status = "ARCHIVED";
        contact.version += 1;
        return { kind: "archived_contact", response: { contact: copy(contact) } };
      });
    },
  };
}

function createInput(store, overrides = {}) {
  return {
    store,
    authenticatedActor: ACTOR_ONE,
    idempotencyKey: key(),
    idFactory: () => CONTACT_ONE,
    payload: {
      contractorProfileId: 10,
      partyType: "PERSON",
      displayName: "Jack Smith",
      email: "Jack@Example.test",
      phone: "(555) 010-1200",
      privateNote: "Prefers weekday appointments.",
    },
    ...overrides,
  };
}

test("creates a stable business-owned PERSON Contact without fabricating account identity", async () => {
  const store = createMemoryStore();
  const result = await createBusinessContact(createInput(store));
  assert.equal(result.status, 201);
  assert.equal(result.contact.id, CONTACT_ONE);
  assert.equal(result.contact.partyType, "PERSON");
  assert.equal(result.contact.privateNote, "Prefers weekday appointments.");
  assert.equal(result.contact.version, 1);
  assert.equal(result.contact.status, "ACTIVE");
  assert.equal("userId" in result.contact, false);
  assert.equal("relationshipId" in result.contact, false);
});

test("supports ORGANIZATION contacts and rejects inferred account-link fields", async () => {
  const store = createMemoryStore();
  const organization = await createBusinessContact(createInput(store, {
    idFactory: () => CONTACT_TWO,
    payload: {
      contractorProfileId: 10,
      partyType: "ORGANIZATION",
      displayName: "Acme Property Group",
      companyName: "Acme Property Group LLC",
      serviceArea: "Denver metro",
    },
  }));
  assert.equal(organization.contact.partyType, "ORGANIZATION");
  const rejected = await createBusinessContact(createInput(store, {
    payload: {
      contractorProfileId: 10,
      partyType: "PERSON",
      displayName: "Linked Person",
      linkedUserId: 44,
    },
  }));
  assert.equal(rejected.code, "BUSINESS_CONTACT_FIELD_REJECTED");
});

test("enforces authenticated business ownership for create, read, and list", async () => {
  const store = createMemoryStore();
  const deniedCreate = await createBusinessContact(createInput(store, {
    authenticatedActor: ACTOR_TWO,
  }));
  assert.equal(deniedCreate.code, "BUSINESS_CONTACT_BUSINESS_UNAVAILABLE");
  await createBusinessContact(createInput(store));
  const deniedRead = await getBusinessContact({ store, authenticatedActor: ACTOR_TWO, contactId: CONTACT_ONE });
  assert.equal(deniedRead.code, "BUSINESS_CONTACT_NOT_FOUND");
  const deniedList = await listBusinessContacts({
    store,
    authenticatedActor: ACTOR_TWO,
    query: { contractorProfileId: 10 },
  });
  assert.equal(deniedList.code, "BUSINESS_CONTACT_BUSINESS_UNAVAILABLE");
});

test("reports same-business duplicate candidates but never merges or globally constrains identity", async () => {
  const store = createMemoryStore();
  const first = await createBusinessContact(createInput(store));
  const second = await createBusinessContact(createInput(store, {
    idFactory: () => CONTACT_TWO,
    payload: {
      contractorProfileId: 10,
      partyType: "PERSON",
      displayName: "J. Smith",
      email: "jack@example.test",
    },
  }));
  assert.notEqual(first.contact.id, second.contact.id);
  assert.deepEqual(second.duplicateCandidates.map((candidate) => candidate.id), [CONTACT_ONE]);
  const otherBusiness = await createBusinessContact(createInput(store, {
    authenticatedActor: ACTOR_TWO,
    idFactory: () => "44444444-4444-4444-8444-444444444444",
    payload: {
      contractorProfileId: 20,
      partyType: "PERSON",
      displayName: "Jack Smith",
      email: "jack@example.test",
    },
  }));
  assert.deepEqual(otherBusiness.duplicateCandidates, []);
  assert.equal(store.contacts.size, 3);
});

test("create and update commands are idempotent and conflicting reuse fails closed", async () => {
  const store = createMemoryStore();
  const idempotencyKey = key();
  const input = createInput(store, { idempotencyKey });
  const created = await createBusinessContact(input);
  const replay = await createBusinessContact(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.contact.id, created.contact.id);
  const conflict = await createBusinessContact({
    ...input,
    payload: { ...input.payload, displayName: "Different Contact" },
  });
  assert.equal(conflict.code, "BUSINESS_CONTACT_IDEMPOTENCY_CONFLICT");

  const updateKey = key();
  const update = {
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: updateKey,
    payload: { expectedVersion: 1, displayName: "Jack A. Smith" },
  };
  const updated = await updateBusinessContact(update);
  assert.equal(updated.contact.version, 2);
  assert.equal((await updateBusinessContact(update)).replayed, true);
  const stale = await updateBusinessContact({
    ...update,
    idempotencyKey: key(),
    payload: { expectedVersion: 1, privateNote: "Stale note" },
  });
  assert.equal(stale.code, "BUSINESS_CONTACT_VERSION_CONFLICT");
  assert.equal(stale.currentVersion, 2);
});

test("assigns multiple classification roles and ends one without granting authority", async () => {
  const store = createMemoryStore();
  await createBusinessContact(createInput(store));
  const customer = await assignBusinessContactRole({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    idFactory: () => ROLE_ONE,
    payload: { expectedVersion: 1, role: "CUSTOMER", sourceReference: "professional selection" },
  });
  assert.equal(customer.contact.version, 2);
  const tenant = await assignBusinessContactRole({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    idFactory: () => "55555555-5555-4555-8555-555555555555",
    payload: { expectedVersion: 2, role: "TENANT" },
  });
  assert.deepEqual(tenant.contact.roles.map((role) => role.role), ["CUSTOMER", "TENANT"]);
  const ended = await endBusinessContactRole({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    roleId: ROLE_ONE,
    idempotencyKey: key(),
    payload: { expectedVersion: 3 },
  });
  assert.equal(ended.contact.roles.find((role) => role.role === "CUSTOMER").active, false);
  assert.equal(ended.contact.roles.find((role) => role.role === "TENANT").active, true);
  assert.equal("quoteAuthority" in ended.contact.roles[0], false);
});

test("supports all allowed roles, rejects unknown roles, and prevents duplicate active assignment", async () => {
  const allowed = ["CUSTOMER", "PROFESSIONAL_VENDOR", "EMPLOYEE", "TENANT", "PROPERTY_MANAGER"];
  for (const [index, role] of allowed.entries()) {
    const store = createMemoryStore();
    await createBusinessContact(createInput(store));
    const result = await assignBusinessContactRole({
      store,
      authenticatedActor: ACTOR_ONE,
      contactId: CONTACT_ONE,
      idempotencyKey: key(),
      payload: { expectedVersion: 1, role },
    });
    assert.equal(result.contact.roles[0].role, role, `role ${index + 1}`);
  }
  const store = createMemoryStore();
  await createBusinessContact(createInput(store));
  const assigned = await assignBusinessContactRole({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    payload: { expectedVersion: 1, role: "CUSTOMER" },
  });
  const duplicate = await assignBusinessContactRole({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    payload: { expectedVersion: assigned.contact.version, role: "CUSTOMER" },
  });
  assert.equal(duplicate.code, "BUSINESS_CONTACT_ROLE_ALREADY_ACTIVE");
  const rejected = await assignBusinessContactRole({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    payload: { expectedVersion: assigned.contact.version, role: "JOB_OWNER" },
  });
  assert.equal(rejected.code, "BUSINESS_CONTACT_ROLE_INVALID");
});

test("list supports owner-scoped search, status, and active-role filtering", async () => {
  const store = createMemoryStore();
  await createBusinessContact(createInput(store));
  await assignBusinessContactRole({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    payload: { expectedVersion: 1, role: "CUSTOMER" },
  });
  const listed = await listBusinessContacts({
    store,
    authenticatedActor: ACTOR_ONE,
    query: { contractorProfileId: "10", search: "jack", role: "customer" },
  });
  assert.equal(listed.contacts.length, 1);
  assert.equal(listed.contacts[0].id, CONTACT_ONE);
  const none = await listBusinessContacts({
    store,
    authenticatedActor: ACTOR_ONE,
    query: { contractorProfileId: 10, role: "EMPLOYEE" },
  });
  assert.deepEqual(none.contacts, []);
});

test("archive preserves durable identity and private history while preventing later mutation", async () => {
  const store = createMemoryStore();
  await createBusinessContact(createInput(store));
  const archived = await archiveBusinessContact({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    payload: { expectedVersion: 1 },
  });
  assert.equal(archived.contact.status, "ARCHIVED");
  assert.equal(archived.contact.id, CONTACT_ONE);
  const loaded = await getBusinessContact({ store, authenticatedActor: ACTOR_ONE, contactId: CONTACT_ONE });
  assert.equal(loaded.contact.privateNote, "Prefers weekday appointments.");
  const rejected = await updateBusinessContact({
    store,
    authenticatedActor: ACTOR_ONE,
    contactId: CONTACT_ONE,
    idempotencyKey: key(),
    payload: { expectedVersion: 2, privateNote: "Should not change" },
  });
  assert.equal(rejected.code, "BUSINESS_CONTACT_ARCHIVED");
});

test("strictly validates authentication, UUID identities, fields, contact data, and versions", async () => {
  const store = createMemoryStore();
  assert.equal((await createBusinessContact({})).code, "AUTHENTICATION_REQUIRED");
  const badEmail = await createBusinessContact(createInput(store, {
    payload: { contractorProfileId: 10, partyType: "PERSON", displayName: "Jack", email: "invalid" },
  }));
  assert.equal(badEmail.code, "BUSINESS_CONTACT_INVALID");
  const badPhone = await createBusinessContact(createInput(store, {
    payload: { contractorProfileId: 10, partyType: "PERSON", displayName: "Jack", phone: "x" },
  }));
  assert.equal(badPhone.code, "BUSINESS_CONTACT_INVALID");
  const noKey = await createBusinessContact({ ...createInput(store), idempotencyKey: "bad" });
  assert.equal(noKey.code, "BUSINESS_CONTACT_IDEMPOTENCY_REQUIRED");
  const badRead = await getBusinessContact({ store, authenticatedActor: ACTOR_ONE, contactId: "bad" });
  assert.equal(badRead.code, "BUSINESS_CONTACT_ID_INVALID");
});
