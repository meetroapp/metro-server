"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBusinessDocumentDraft,
  deleteBusinessDocumentDraft,
  getBusinessDocumentDraft,
  listBusinessDocumentDrafts,
  updateBusinessDocumentDraft,
} = require("../server/documents/businessDocumentDraftService");

const JOB_ONE = "11111111-1111-4111-8111-111111111111";
const JOB_TWO = "22222222-2222-4222-8222-222222222222";
const KEY_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_THREE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function media(publicId = "meetro/businesses/10/quote-drafts/fan") {
  return {
    public_id: publicId,
    secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.jpg`,
    resource_type: "image",
    format: "jpg",
    bytes: 1200,
    width: 800,
    height: 600,
    version: 1,
  };
}

function normalizeMediaCollection(items) {
  return items.map((item, index) => ({
    ...item.media,
    display_order: index,
    uploaded_at: "2026-08-21T12:00:00.000Z",
  }));
}

function payload(overrides = {}) {
  return {
    documentType: "QUOTE",
    jobId: null,
    content: {
      customerName: "Jack Smith",
      projectTitle: "Fan replacement",
      projectDescription: "Replace the existing fan.",
      lineItems: [],
      materialItems: [{ id: "fan", name: "Fan", total: "89.99" }],
      laborItems: [{ id: "install", description: "Installation", total: "180" }],
      totalOverride: "",
      terms: "",
      estimatedDuration: "",
      notes: "",
    },
    workspace: {
      activeDocument: "QUOTE",
      instructions: [{
        id: "turn-1",
        documentType: "QUOTE",
        originalText: "fan replacement for Jack Smith. fan cost 89.99 installation cost 180",
        text: "fan replacement for Jack Smith. fan cost 89.99 installation cost 180",
        responseText: "Quote working draft updated. Review the live document.",
        recognized: true,
        revisions: 0,
        revisionHistory: [],
        privateReminder: false,
        photoIntent: null,
        createdAt: "2026-08-21T11:59:00.000Z",
        updatedAt: "2026-08-21T11:59:00.000Z",
      }],
      manualOverrides: {},
      privateReminders: [{ id: "private-1", text: "Bring a ladder" }],
    },
    photos: [{
      id: "fan",
      name: "fan.jpg",
      media: media(),
      role: "BEFORE",
      visibility: "PRIVATE_INTERNAL",
    }],
    ...overrides,
  };
}

function legacyInstruction(overrides = {}) {
  return {
    id: "legacy-turn-1",
    documentType: "QUOTE",
    text: "fan replacement for Jack Smith. fan cost 89.99 installation cost 180",
    recognized: true,
    revisions: 0,
    revisionHistory: [],
    ...overrides,
  };
}

function createMemoryStore() {
  const documents = new Map();
  const commands = new Map();
  const physicalMedia = new Set();
  const authorityRecords = { jobs: 1, customers: 1, quotes: 1, invoices: 1, payments: 1, lifecycleEvents: 1 };
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 7, 21, 12, clock++)).toISOString();
  function commandResult(command, build) {
    const identity = `${command.actorUserId}:${command.operation}:${command.key}`;
    const existing = commands.get(identity);
    if (existing) return existing.hash === command.hash
      ? { kind: "replay", document: existing.document }
      : { kind: "idempotency_conflict" };
    const result = build();
    if (result.document) commands.set(identity, { hash: command.hash, document: result.document });
    return result;
  }
  return {
    documents,
    async getProfessionalContext(_pool, actorUserId) {
      return actorUserId === 1 || actorUserId === 2
        ? { contractor_profile_id: actorUserId * 10 }
        : null;
    },
    async validateJobAssociation(_pool, actorUserId, jobId) {
      return !jobId || (actorUserId === 1 && jobId === JOB_ONE) || (actorUserId === 2 && jobId === JOB_TWO);
    },
    async create({ actorUserId, contractorProfileId, command, draft }) {
      return commandResult(command, () => {
        const timestamp = now();
        const document = {
          id: draft.id,
          documentType: draft.documentType,
          status: "WORKING_DRAFT",
          reference: draft.reference,
          jobId: draft.jobId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          content: draft.content,
          workspace: draft.workspace,
          photos: draft.photos.map((photo) => ({
            id: photo.publicId,
            name: photo.name,
            media: photo.media,
            role: photo.role,
            visibility: photo.visibility,
            displayOrder: photo.displayOrder,
            version: 1,
          })),
        };
        documents.set(draft.id, { actorUserId, contractorProfileId, document });
        document.photos.forEach((photo) => physicalMedia.add(photo.media.public_id));
        return { kind: "created", document };
      });
    },
    async update({ actorUserId, command, draftId, expectedVersion, draft }) {
      return commandResult(command, () => {
        const current = documents.get(draftId);
        if (!current || current.actorUserId !== actorUserId) return { kind: "not_found" };
        if (current.document.version !== expectedVersion) return { kind: "version_conflict", currentVersion: current.document.version };
        if (current.document.documentType !== draft.documentType) return { kind: "type_conflict" };
        const document = {
          ...current.document,
          jobId: draft.jobId,
          version: current.document.version + 1,
          updatedAt: now(),
          content: draft.content,
          workspace: draft.workspace,
          photos: draft.photos.map((photo) => ({
            id: photo.publicId,
            name: photo.name,
            media: photo.media,
            role: photo.role,
            visibility: photo.visibility,
            displayOrder: photo.displayOrder,
            version: 2,
          })),
        };
        documents.set(draftId, { ...current, document });
        return { kind: "updated", document };
      });
    },
    async get({ actorUserId, draftId }) {
      const current = documents.get(draftId);
      return current?.actorUserId === actorUserId ? current.document : null;
    },
    async delete({ actorUserId, draftId, expectedVersion }) {
      const current = documents.get(draftId);
      if (!current || current.actorUserId !== actorUserId || current.document.status !== "WORKING_DRAFT") {
        return { kind: "not_found" };
      }
      if (current.document.version !== expectedVersion) {
        return { kind: "version_conflict", currentVersion: current.document.version };
      }
      documents.delete(draftId);
      return { kind: "deleted", deletedDraftId: draftId };
    },
    async list({ actorUserId, query }) {
      return [...documents.values()]
        .filter((item) => item.actorUserId === actorUserId)
        .map((item) => item.document)
        .filter((document) => !query.type || document.documentType === query.type)
        .filter((document) => !query.search || JSON.stringify(document).toLowerCase().includes(query.search.toLowerCase()));
    },
    physicalMedia,
    authorityRecords,
  };
}

test("create saves one private noncanonical Quote draft with nullable Job and governed photo state", async () => {
  const store = createMemoryStore();
  const result = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE,
    store, normalizeMediaCollection,
  });
  assert.equal(result.status, 201);
  assert.equal(result.document.status, "WORKING_DRAFT");
  assert.equal(result.document.jobId, null);
  assert.equal(result.document.content.customerName, "Jack Smith");
  assert.equal(result.document.workspace.privateReminders[0].text, "Bring a ladder");
  assert.equal(result.document.photos[0].role, "BEFORE");
  assert.equal(result.document.photos[0].visibility, "PRIVATE_INTERNAL");
  assert.equal(result.document.photos[0].media.lifecycle_state, "business_document_working_draft");
  assert.equal(result.document.photos[0].media.customer_visible_by_default, false);
  assert.equal(result.document.issuedAt, undefined);
  assert.equal(result.document.approval, undefined);
});

test("R2 backend accepts old-client create and update payloads and safely expands legacy turns", async () => {
  const store = createMemoryStore();
  const legacyCreate = payload({
    workspace: {
      ...payload().workspace,
      instructions: [legacyInstruction()],
    },
  });
  const created = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: legacyCreate,
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.document.workspace.instructions[0], {
    ...legacyInstruction(),
    originalText: legacyInstruction().text,
    responseText: "",
    privateReminder: false,
    photoIntent: null,
  });
  assert.equal(Object.hasOwn(created.document.workspace.instructions[0], "createdAt"), false);
  assert.equal(Object.hasOwn(created.document.workspace.instructions[0], "updatedAt"), false);

  const editedText = "fan replacement for Jack Smith. fan cost 89.99 installation cost 200";
  const legacyUpdate = payload({
    content: {
      ...payload().content,
      laborItems: [{ id: "install", description: "Installation", total: "200" }],
    },
    workspace: {
      ...payload().workspace,
      instructions: [legacyInstruction({
        text: editedText,
        revisions: 1,
        revisionHistory: [legacyInstruction().text],
      })],
    },
  });
  const updated = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    payload: { ...legacyUpdate, expectedVersion: created.document.version },
    idempotencyKey: KEY_TWO, store, normalizeMediaCollection,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.document.workspace.instructions[0].text, editedText);
  assert.equal(updated.document.workspace.instructions[0].originalText, legacyInstruction().text);
  assert.equal(updated.document.workspace.instructions[0].responseText, "");
  assert.equal(updated.document.content.laborItems[0].total, "200");
});

test("supplied R2 conversation metadata remains strict while omitted metadata remains valid", async (t) => {
  const invalidCases = [
    ["originalText type", { originalText: 42 }],
    ["empty originalText", { originalText: "" }],
    ["responseText type", { responseText: {} }],
    ["privateReminder type", { privateReminder: "false" }],
    ["photoIntent value", { photoIntent: "GENERAL" }],
    ["createdAt type", { createdAt: 0 }],
    ["updatedAt value", { updatedAt: "not-a-timestamp" }],
  ];
  for (const [name, metadata] of invalidCases) {
    await t.test(name, async () => {
      const store = createMemoryStore();
      const result = await createBusinessDocumentDraft({
        pool: {}, authenticatedActor: { id: 1 },
        payload: payload({
          workspace: {
            ...payload().workspace,
            instructions: [{ ...payload().workspace.instructions[0], ...metadata }],
          },
        }),
        idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
      });
      assert.equal(result.status, 400);
      assert.equal(result.code, "BUSINESS_DOCUMENT_INVALID");
    });
  }
});

test("create retry is idempotent and does not create a duplicate draft", async () => {
  const store = createMemoryStore();
  const input = { pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE, store, normalizeMediaCollection };
  const first = await createBusinessDocumentDraft(input);
  const replay = await createBusinessDocumentDraft(input);
  assert.equal(replay.code, "BUSINESS_DOCUMENT_SAVE_REPLAYED");
  assert.equal(replay.document.id, first.document.id);
  assert.equal(store.documents.size, 1);
});

test("get denies another business while the owner can reopen the exact workspace", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({ pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE, store, normalizeMediaCollection });
  const owner = await getBusinessDocumentDraft({ pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id, store });
  const other = await getBusinessDocumentDraft({ pool: {}, authenticatedActor: { id: 2 }, draftId: created.document.id, store });
  assert.deepEqual(owner.document.workspace.instructions, created.document.workspace.instructions);
  assert.equal(owner.document.workspace.instructions[0].responseText, "Quote working draft updated. Review the live document.");
  assert.equal(owner.document.workspace.instructions[0].documentType, "QUOTE");
  assert.equal(other.status, 404);
});

test("edited working conversation and prior revision round-trip on update and reopen", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE,
    store, normalizeMediaCollection,
  });
  const editedText = "fan replacement for Jack Smith. fan cost 89.99 installation cost 200";
  const changed = payload({
    content: {
      ...payload().content,
      laborItems: [{ id: "install", description: "Installation", total: "200" }],
    },
    workspace: {
      ...payload().workspace,
      instructions: [{
        ...payload().workspace.instructions[0],
        text: editedText,
        revisions: 1,
        revisionHistory: [payload().workspace.instructions[0].text],
        updatedAt: "2026-08-21T12:05:00.000Z",
      }],
    },
  });
  const updated = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    payload: { ...changed, expectedVersion: created.document.version },
    idempotencyKey: KEY_TWO, store, normalizeMediaCollection,
  });
  const reopened = await getBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id, store,
  });
  assert.equal(updated.document.workspace.instructions[0].text, editedText);
  assert.equal(reopened.document.workspace.instructions[0].text, editedText);
  assert.equal(reopened.document.workspace.instructions[0].revisions, 1);
  assert.deepEqual(reopened.document.workspace.instructions[0].revisionHistory, [
    "fan replacement for Jack Smith. fan cost 89.99 installation cost 180",
  ]);
  assert.equal(reopened.document.workspace.instructions[0].originalText, "fan replacement for Jack Smith. fan cost 89.99 installation cost 180");
  assert.equal(reopened.document.workspace.instructions[0].responseText, "Quote working draft updated. Review the live document.");
  assert.equal(reopened.document.workspace.instructions[0].updatedAt, "2026-08-21T12:05:00.000Z");
  assert.equal(reopened.document.content.laborItems[0].total, "200");
});

test("update changes the same draft, increments version, and rejects stale overwrite", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({ pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE, store, normalizeMediaCollection });
  const changed = payload({
    content: { ...payload().content, laborItems: [{ id: "install", description: "Installation", total: "200" }] },
    photos: [{ ...payload().photos[0], visibility: "CUSTOMER_VISIBLE" }],
  });
  const updated = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    payload: { ...changed, expectedVersion: 1 }, idempotencyKey: KEY_TWO,
    store, normalizeMediaCollection,
  });
  assert.equal(updated.document.id, created.document.id);
  assert.equal(updated.document.version, 2);
  assert.equal(updated.document.content.laborItems[0].total, "200");
  assert.equal(updated.document.photos[0].visibility, "CUSTOMER_VISIBLE");
  const stale = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    payload: { ...changed, expectedVersion: 1 }, idempotencyKey: KEY_THREE,
    store, normalizeMediaCollection,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "BUSINESS_DOCUMENT_VERSION_CONFLICT");
});

test("list/search and Quote/Invoice filters remain owner-scoped", async () => {
  const store = createMemoryStore();
  await createBusinessDocumentDraft({ pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE, store, normalizeMediaCollection });
  await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 },
    payload: payload({ documentType: "INVOICE", content: { ...payload().content, customerName: "Maria Lopez" }, workspace: { ...payload().workspace, activeDocument: "INVOICE", instructions: [] }, photos: [] }),
    idempotencyKey: KEY_TWO, store, normalizeMediaCollection,
  });
  const jack = await listBusinessDocumentDrafts({ pool: {}, authenticatedActor: { id: 1 }, query: { search: "Jack Smith" }, store });
  const invoices = await listBusinessDocumentDrafts({ pool: {}, authenticatedActor: { id: 1 }, query: { type: "INVOICE" }, store });
  const other = await listBusinessDocumentDrafts({ pool: {}, authenticatedActor: { id: 2 }, query: {}, store });
  assert.equal(jack.documents.length, 1);
  assert.equal(invoices.documents[0].content.customerName, "Maria Lopez");
  assert.equal(other.documents.length, 0);
});

test("canonical Job association is nullable but a mismatched Job fails governed", async () => {
  const store = createMemoryStore();
  const associated = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ jobId: JOB_ONE, photos: [] }),
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  });
  const mismatched = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ jobId: JOB_TWO, photos: [] }),
    idempotencyKey: KEY_TWO, store, normalizeMediaCollection,
  });
  assert.equal(associated.document.jobId, JOB_ONE);
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.code, "BUSINESS_DOCUMENT_JOB_CONFLICT");
});

test("photo role and visibility remain independent", async () => {
  const store = createMemoryStore();
  for (const [key, role] of [[KEY_ONE, "BEFORE"], [KEY_TWO, "AFTER"]]) {
    const result = await createBusinessDocumentDraft({
      pool: {}, authenticatedActor: { id: 1 },
      payload: payload({ photos: [{ ...payload().photos[0], role, visibility: "PRIVATE_INTERNAL" }] }),
      idempotencyKey: key, store, normalizeMediaCollection,
    });
    assert.equal(result.document.photos[0].role, role);
    assert.equal(result.document.photos[0].visibility, "PRIVATE_INTERNAL");
  }
});

test("owner deletes only the private working draft and association while governed authority remains untouched", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE,
    store, normalizeMediaCollection,
  });
  const authorityBefore = structuredClone(store.authorityRecords);
  const result = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    expectedVersion: 1, store,
  });
  assert.equal(result.status, 200);
  assert.equal(result.deletedDraftId, created.document.id);
  assert.equal(store.documents.has(created.document.id), false);
  assert.equal(store.physicalMedia.has(media().public_id), true);
  assert.deepEqual(store.authorityRecords, authorityBefore);
});

test("delete fails closed for invalid, unknown, and another business draft", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE,
    store, normalizeMediaCollection,
  });
  const invalid = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: "not-a-draft",
    expectedVersion: 1, store,
  });
  const other = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 2 }, draftId: created.document.id,
    expectedVersion: 1, store,
  });
  const unknown = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: "33333333-3333-4333-8333-333333333333",
    expectedVersion: 1, store,
  });
  assert.equal(invalid.status, 400);
  assert.equal(other.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(other.code, unknown.code);
  assert.equal(store.documents.has(created.document.id), true);
  store.documents.get(created.document.id).document.status = "ISSUED";
  const nonWorking = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    expectedVersion: 1, store,
  });
  assert.equal(nonWorking.status, 404);
  assert.equal(store.documents.has(created.document.id), true);
  const noProfessionalProfile = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 3 }, draftId: created.document.id,
    expectedVersion: 1, store,
  });
  assert.equal(noProfessionalProfile.status, 403);
});

test("delete requires the current version and a repeated delete remains safely absent", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE,
    store, normalizeMediaCollection,
  });
  const stale = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    expectedVersion: 2, store,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.currentVersion, 1);
  assert.equal(store.documents.has(created.document.id), true);
  const deleted = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    expectedVersion: 1, store,
  });
  const retry = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    expectedVersion: 1, store,
  });
  assert.equal(deleted.status, 200);
  assert.equal(retry.status, 404);
  assert.equal(store.documents.size, 0);
});
