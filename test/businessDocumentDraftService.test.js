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
const JOB_THREE = "77777777-7777-4777-8777-777777777777";
const LEGACY_DRAFT = "88888888-8888-4888-8888-888888888888";
const KEY_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_THREE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_FOUR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const KEY_FIVE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SESSION_ONE = "33333333-3333-4333-8333-333333333333";
const SESSION_TWO = "44444444-4444-4444-8444-444444444444";
const SESSION_MISSING = "55555555-5555-4555-8555-555555555555";

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
      customerEmail: "jack@example.test",
      projectTitle: "Fan replacement",
      projectDescription: "Replace the existing fan.",
      lineItems: [],
      materialItems: [{ id: "fan", name: "Fan", total: "89.99" }],
      laborItems: [{ id: "install", description: "Installation", total: "180" }],
      totalOverride: "",
      terms: "",
      estimatedDuration: "",
      notes: "",
      agreement: {
        exclusions: ["Painting"],
        additionalWorkTerms: "Extra work requires additional authorization.",
        hiddenConditionsTerms: "Hidden conditions are outside the original price.",
        diagnosticTerms: "Diagnostic time remains billable.",
        customerResponsibilities: "Provide safe access.",
        warrantyTerms: "Workmanship warranty as stated here.",
        cancellationTerms: "Rescheduling requires notice.",
        acceptanceTerms: "Acceptance applies to this scope and version.",
        preauthorizedAdditionalWorkLimit: "$150",
      },
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

function createMemoryStore({ initializeSequences = true } = {}) {
  const documents = new Map();
  const commands = new Map();
  const physicalMedia = new Set();
  const analysisSessions = new Map([
    [SESSION_ONE, 1],
    [SESSION_TWO, 2],
  ]);
  const authorityRecords = { jobs: 1, customers: 1, quotes: 1, invoices: 1, payments: 1, lifecycleEvents: 1 };
  const profilesByActor = new Map([
    [1, [10]],
    [2, [20]],
  ]);
  const jobOwners = new Map([
    [JOB_ONE, { actorUserId: 1, contractorProfileId: 10 }],
    [JOB_TWO, { actorUserId: 2, contractorProfileId: 20 }],
    [JOB_THREE, { actorUserId: 1, contractorProfileId: 11 }],
  ]);
  const documentNumbers = new Map();
  const allocationCounts = new Map();
  function initializeSequence(
    contractorProfileId,
    documentType,
    { prefix, width = 7, lastNumber = 0 } = {}
  ) {
    documentNumbers.set(`${contractorProfileId}:${documentType}`, {
      prefix: prefix || (documentType === "QUOTE" ? "Q" : "INV"),
      width,
      lastNumber,
    });
  }
  if (initializeSequences) {
    for (const contractorProfileId of [10, 20]) {
      initializeSequence(contractorProfileId, "QUOTE");
      initializeSequence(contractorProfileId, "INVOICE");
    }
  }
  function allocateNumber(contractorProfileId, documentType) {
    const key = `${contractorProfileId}:${documentType}`;
    const sequence = documentNumbers.get(key);
    if (!sequence) return { kind: "numbering_setup_required" };
    sequence.lastNumber += 1;
    allocationCounts.set(key, (allocationCounts.get(key) || 0) + 1);
    return {
      kind: "allocated",
      documentNumber: `${sequence.prefix}-${String(sequence.lastNumber).padStart(sequence.width, "0")}`,
    };
  }
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 7, 21, 12, clock++)).toISOString();
  function insertLegacyDocument({
    id = LEGACY_DRAFT,
    actorUserId = 1,
    contractorProfileId = 10,
    documentType = "QUOTE",
  } = {}) {
    const timestamp = now();
    const source = payload({
      documentType,
      jobId: null,
      photos: [],
      workspace: {
        ...payload().workspace,
        activeDocument: documentType,
        instructions: [],
      },
    });
    documents.set(id, {
      actorUserId,
      contractorProfileId,
      document: {
        id,
        documentType,
        status: "WORKING_DRAFT",
        reference: `${documentType === "QUOTE" ? "WQ" : "WI"}-LEGACY`,
        documentNumber: null,
        jobId: null,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        content: source.content,
        workspace: source.workspace,
        photos: [],
      },
    });
    return id;
  }
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
    async resolveBusinessOwner(_pool, actorUserId, jobId) {
      if (jobId) {
        const owner = jobOwners.get(jobId);
        return owner?.actorUserId === actorUserId
          ? { kind: "resolved", contractorProfileId: owner.contractorProfileId }
          : { kind: "job_unavailable" };
      }
      const profiles = profilesByActor.get(actorUserId) || [];
      if (profiles.length === 0) return { kind: "profile_required" };
      if (profiles.length > 1) return { kind: "profile_ambiguous" };
      return { kind: "resolved", contractorProfileId: profiles[0] };
    },
    async getOwnedBusinessContext(_pool, actorUserId, draftId) {
      const current = documents.get(draftId);
      if (!current || current.actorUserId !== actorUserId) return null;
      return {
        contractor_profile_id: current.contractorProfileId,
        document_type: current.document.documentType,
        document_number: current.document.documentNumber,
        version: current.document.version,
      };
    },
    async validateJobAssociation(_pool, actorUserId, jobId, contractorProfileId) {
      if (!jobId) return true;
      const owner = jobOwners.get(jobId);
      return owner?.actorUserId === actorUserId &&
        owner.contractorProfileId === contractorProfileId;
    },
    async validateJobAnalysisSessionOwnership(_pool, actorUserId, sessionId) {
      return !sessionId || analysisSessions.get(sessionId) === actorUserId;
    },
    async create({ actorUserId, contractorProfileId, command, draft }) {
      return commandResult(command, () => {
        const timestamp = now();
        const allocation = allocateNumber(contractorProfileId, draft.documentType);
        if (allocation.kind !== "allocated") return allocation;
        const document = {
          id: draft.id,
          documentType: draft.documentType,
          status: "WORKING_DRAFT",
          reference: draft.reference,
          documentNumber: allocation.documentNumber,
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
        const jobOwner = draft.jobId ? jobOwners.get(draft.jobId) : null;
        if (draft.jobId && (
          jobOwner?.actorUserId !== actorUserId ||
          jobOwner.contractorProfileId !== current.contractorProfileId
        )) return { kind: "job_unavailable" };
        let documentNumber = current.document.documentNumber;
        if (!documentNumber) {
          const allocation = allocateNumber(
            current.contractorProfileId,
            draft.documentType
          );
          if (allocation.kind !== "allocated") return allocation;
          documentNumber = allocation.documentNumber;
        }
        const document = {
          ...current.document,
          documentNumber,
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
    documentNumbers,
    allocationCounts,
    initializeSequence,
    insertLegacyDocument,
    jobOwners,
    profilesByActor,
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
  assert.equal(result.document.documentNumber, "Q-0000001");
  assert.equal(result.document.jobId, null);
  assert.equal(result.document.content.customerName, "Jack Smith");
  assert.deepEqual(result.document.content.agreement.exclusions, ["Painting"]);
  assert.equal(result.document.workspace.privateReminders[0].text, "Bring a ladder");
  assert.equal(result.document.photos[0].role, "BEFORE");
  assert.equal(result.document.photos[0].visibility, "PRIVATE_INTERNAL");
  assert.equal(result.document.photos[0].media.lifecycle_state, "business_document_working_draft");
  assert.equal(result.document.photos[0].media.customer_visible_by_default, false);
  assert.equal(result.document.issuedAt, undefined);
  assert.equal(result.document.approval, undefined);
});

test("server-owned Quote and Invoice numbers are atomic, business-scoped, independent, and immutable", async () => {
  const store = createMemoryStore();
  const quoteInput = (idempotencyKey, actorId = 1) => createBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: actorId },
    payload: payload({ photos: [] }),
    idempotencyKey,
    store,
    normalizeMediaCollection,
  });

  const [firstQuote, secondQuote] = await Promise.all([
    quoteInput(KEY_ONE),
    quoteInput(KEY_TWO),
  ]);
  assert.deepEqual(
    new Set([firstQuote.document.documentNumber, secondQuote.document.documentNumber]),
    new Set(["Q-0000001", "Q-0000002"])
  );

  const invoicePayload = payload({
    documentType: "INVOICE",
    photos: [],
    workspace: {
      ...payload().workspace,
      activeDocument: "INVOICE",
      instructions: [],
    },
  });
  const invoice = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: invoicePayload,
    idempotencyKey: KEY_THREE, store, normalizeMediaCollection,
  });
  const otherBusinessQuote = await quoteInput(KEY_FOUR, 2);
  assert.equal(invoice.document.documentNumber, "INV-0000001");
  assert.equal(otherBusinessQuote.document.documentNumber, "Q-0000001");

  const updated = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: firstQuote.document.id,
    payload: { ...payload({ photos: [] }), expectedVersion: 1 },
    idempotencyKey: KEY_FIVE, store, normalizeMediaCollection,
  });
  assert.equal(updated.document.documentNumber, firstQuote.document.documentNumber);

  const reopened = await getBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: firstQuote.document.id, store,
  });
  assert.equal(reopened.document.documentNumber, firstQuote.document.documentNumber);
});

test("continued business sequence preserves prefix and width supplied by the shared allocator", async () => {
  const store = createMemoryStore({ initializeSequences: false });
  store.initializeSequence(10, "QUOTE", {
    prefix: "BG",
    width: 7,
    lastNumber: 1019,
  });
  const result = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ photos: [] }),
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  });
  assert.equal(result.status, 201);
  assert.equal(result.document.documentNumber, "BG-0001020");
});

test("missing numbering setup fails governed without document, number, or stale idempotency reservation", async () => {
  const store = createMemoryStore({ initializeSequences: false });
  const input = {
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ photos: [] }),
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  };
  const missing = await createBusinessDocumentDraft(input);
  assert.equal(missing.status, 409);
  assert.equal(missing.code, "BUSINESS_DOCUMENT_NUMBERING_SETUP_REQUIRED");
  assert.equal(store.documents.size, 0);
  assert.equal(store.allocationCounts.size, 0);

  store.initializeSequence(10, "QUOTE");
  const retried = await createBusinessDocumentDraft(input);
  assert.equal(retried.status, 201);
  assert.equal(retried.document.documentNumber, "Q-0000001");
});

test("create resolves exact Job business and rejects ambiguous or missing Job-less ownership", async () => {
  const jobStore = createMemoryStore();
  jobStore.profilesByActor.set(1, [10, 11]);
  const jobLinked = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 },
    payload: payload({ jobId: JOB_ONE, photos: [] }),
    idempotencyKey: KEY_ONE, store: jobStore, normalizeMediaCollection,
  });
  assert.equal(jobLinked.status, 201);
  assert.equal(
    jobStore.documents.get(jobLinked.document.id).contractorProfileId,
    10
  );

  const ambiguousStore = createMemoryStore();
  ambiguousStore.profilesByActor.set(1, [10, 11]);
  const ambiguous = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ photos: [] }),
    idempotencyKey: KEY_TWO, store: ambiguousStore, normalizeMediaCollection,
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.code, "BUSINESS_DOCUMENT_PROFILE_AMBIGUOUS");
  assert.equal(ambiguousStore.documents.size, 0);

  const missingStore = createMemoryStore();
  missingStore.profilesByActor.delete(1);
  const missing = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ photos: [] }),
    idempotencyKey: KEY_THREE, store: missingStore, normalizeMediaCollection,
  });
  assert.equal(missing.status, 403);
  assert.equal(missing.code, "BUSINESS_DOCUMENT_AUTHORITY_REQUIRED");
});

test("legacy unnumbered update allocates once and later updates preserve the assigned number", async () => {
  const store = createMemoryStore({ initializeSequences: false });
  store.initializeSequence(10, "QUOTE", {
    prefix: "BG",
    width: 7,
    lastNumber: 1019,
  });
  store.insertLegacyDocument();

  const first = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: LEGACY_DRAFT,
    payload: { ...payload({ photos: [] }), expectedVersion: 1 },
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  });
  assert.equal(first.status, 200);
  assert.equal(first.document.documentNumber, "BG-0001020");
  assert.equal(store.allocationCounts.get("10:QUOTE"), 1);

  const second = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: LEGACY_DRAFT,
    payload: { ...payload({ photos: [] }), expectedVersion: 2 },
    idempotencyKey: KEY_TWO, store, normalizeMediaCollection,
  });
  assert.equal(second.status, 200);
  assert.equal(second.document.documentNumber, "BG-0001020");
  assert.equal(store.allocationCounts.get("10:QUOTE"), 1);
});

test("legacy unnumbered update without setup changes nothing and can retry after initialization", async () => {
  const store = createMemoryStore({ initializeSequences: false });
  store.insertLegacyDocument();
  const input = {
    pool: {}, authenticatedActor: { id: 1 }, draftId: LEGACY_DRAFT,
    payload: { ...payload({ photos: [] }), expectedVersion: 1 },
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  };

  const missing = await updateBusinessDocumentDraft(input);
  assert.equal(missing.status, 409);
  assert.equal(missing.code, "BUSINESS_DOCUMENT_NUMBERING_SETUP_REQUIRED");
  assert.equal(store.documents.get(LEGACY_DRAFT).document.version, 1);
  assert.equal(store.documents.get(LEGACY_DRAFT).document.documentNumber, null);
  assert.equal(store.allocationCounts.size, 0);

  store.initializeSequence(10, "QUOTE");
  const retried = await updateBusinessDocumentDraft(input);
  assert.equal(retried.status, 200);
  assert.equal(retried.document.version, 2);
  assert.equal(retried.document.documentNumber, "Q-0000001");
});

test("update and delete use saved draft owner while cross-business Job reassociation fails", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ photos: [] }),
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  });
  store.profilesByActor.set(1, [99]);

  const updated = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    payload: { ...payload({ photos: [] }), expectedVersion: 1 },
    idempotencyKey: KEY_TWO, store, normalizeMediaCollection,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.document.documentNumber, "Q-0000001");
  assert.equal(
    store.documents.get(created.document.id).contractorProfileId,
    10
  );

  const crossBusiness = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    payload: { ...payload({ jobId: JOB_THREE, photos: [] }), expectedVersion: 2 },
    idempotencyKey: KEY_THREE, store, normalizeMediaCollection,
  });
  assert.equal(crossBusiness.status, 409);
  assert.equal(crossBusiness.code, "BUSINESS_DOCUMENT_JOB_CONFLICT");
  assert.equal(store.documents.get(created.document.id).document.jobId, null);

  const deleted = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    expectedVersion: 2, store,
  });
  assert.equal(deleted.status, 200);
  assert.equal(store.documents.has(created.document.id), false);
});

test("deleting a numbered draft does not rewind or reuse the consumed number", async () => {
  const store = createMemoryStore();
  const first = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ photos: [] }),
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  });
  await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: first.document.id,
    expectedVersion: 1, store,
  });
  const second = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload({ photos: [] }),
    idempotencyKey: KEY_TWO, store, normalizeMediaCollection,
  });
  assert.equal(first.document.documentNumber, "Q-0000001");
  assert.equal(second.document.documentNumber, "Q-0000002");
});

test("caller-supplied Quote and Invoice numbers cannot overwrite server identity", async () => {
  const store = createMemoryStore();
  const source = payload({
    photos: [],
    content: {
      ...payload().content,
      quoteNumber: "BG-0001020",
      invoiceNumber: "INV-9999999",
    },
  });
  const result = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: source,
    idempotencyKey: KEY_ONE, store, normalizeMediaCollection,
  });
  assert.equal(result.document.documentNumber, "Q-0000001");
  assert.equal(result.document.content.quoteNumber, "");
  assert.equal(result.document.content.invoiceNumber, "");
});

test("Quote agreement terms persist as professional-controlled working-draft content and bind to each saved version", async () => {
  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, payload: payload(), idempotencyKey: KEY_ONE,
    store, normalizeMediaCollection,
  });
  assert.equal(created.document.version, 1);
  assert.equal(created.document.content.agreement.hiddenConditionsTerms, "Hidden conditions are outside the original price.");
  const revisedPayload = payload({
    content: {
      ...payload().content,
      agreement: {
        ...payload().content.agreement,
        hiddenConditionsTerms: "Concealed wiring requires separate authorization.",
      },
    },
  });
  const revised = await updateBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 1 }, draftId: created.document.id,
    payload: { ...revisedPayload, expectedVersion: 1 }, idempotencyKey: KEY_TWO,
    store, normalizeMediaCollection,
  });
  assert.equal(revised.document.version, 2);
  assert.equal(revised.document.content.agreement.hiddenConditionsTerms, "Concealed wiring requires separate authorization.");
  assert.equal(created.document.content.agreement.hiddenConditionsTerms, "Hidden conditions are outside the original price.");
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

test("owned private Job Analysis session round-trips with the working document", async () => {
  const store = createMemoryStore();
  const source = payload({
    photos: [],
    workspace: {
      ...payload().workspace,
      jobAnalysisSessionId: SESSION_ONE,
    },
  });

  const created = await createBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: 1 },
    payload: source,
    idempotencyKey: KEY_ONE,
    store,
    normalizeMediaCollection,
  });

  assert.equal(created.status, 201);
  assert.equal(
    created.document.workspace.jobAnalysisSessionId,
    SESSION_ONE
  );

  const reopened = await getBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: 1 },
    draftId: created.document.id,
    store,
  });

  assert.equal(
    reopened.document.workspace.jobAnalysisSessionId,
    SESSION_ONE
  );
  assert.equal(reopened.document.jobId, null);
});

test("foreign or missing private Job Analysis sessions fail closed before document persistence", async () => {
  for (const sessionId of [SESSION_TWO, SESSION_MISSING]) {
    const store = createMemoryStore();

    const result = await createBusinessDocumentDraft({
      pool: {},
      authenticatedActor: { id: 1 },
      payload: payload({
        photos: [],
        workspace: {
          ...payload().workspace,
          jobAnalysisSessionId: sessionId,
        },
      }),
      idempotencyKey: KEY_ONE,
      store,
      normalizeMediaCollection,
    });

    assert.equal(result.status, 409);
    assert.equal(
      result.code,
      "BUSINESS_DOCUMENT_JOB_ANALYSIS_CONFLICT"
    );
    assert.equal(store.documents.size, 0);
  }

  const store = createMemoryStore();
  const created = await createBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: 1 },
    payload: payload({
      photos: [],
      workspace: {
        ...payload().workspace,
        jobAnalysisSessionId: SESSION_ONE,
      },
    }),
    idempotencyKey: KEY_ONE,
    store,
    normalizeMediaCollection,
  });

  const rejected = await updateBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: 1 },
    draftId: created.document.id,
    payload: {
      ...payload({
        photos: [],
        workspace: {
          ...payload().workspace,
          jobAnalysisSessionId: SESSION_TWO,
        },
      }),
      expectedVersion: created.document.version,
    },
    idempotencyKey: KEY_TWO,
    store,
    normalizeMediaCollection,
  });

  assert.equal(rejected.status, 409);
  assert.equal(
    rejected.code,
    "BUSINESS_DOCUMENT_JOB_ANALYSIS_CONFLICT"
  );

  const reopened = await getBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: 1 },
    draftId: created.document.id,
    store,
  });

  assert.equal(reopened.document.version, 1);
  assert.equal(
    reopened.document.workspace.jobAnalysisSessionId,
    SESSION_ONE
  );
});

test("malformed Job Analysis session identity is rejected as an invalid workspace", async () => {
  const store = createMemoryStore();

  const result = await createBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: 1 },
    payload: payload({
      photos: [],
      workspace: {
        ...payload().workspace,
        jobAnalysisSessionId: "not-a-session-id",
      },
    }),
    idempotencyKey: KEY_ONE,
    store,
    normalizeMediaCollection,
  });

  assert.equal(result.status, 400);
  assert.equal(result.code, "BUSINESS_DOCUMENT_INVALID");
  assert.equal(store.documents.size, 0);
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
  const unrelatedActor = await deleteBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 3 }, draftId: created.document.id,
    expectedVersion: 1, store,
  });
  assert.equal(unrelatedActor.status, 404);
  assert.equal(unrelatedActor.code, "BUSINESS_DOCUMENT_NOT_FOUND");
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
