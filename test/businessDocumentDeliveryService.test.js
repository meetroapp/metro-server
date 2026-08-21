"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  deliverBusinessDocument,
  getBusinessDocumentCustomerPdf,
  listBusinessDocumentDeliveries,
} = require("../server/documents/businessDocumentDeliveryService");
const {
  renderBusinessDocumentCustomerPdf,
} = require("../server/documents/businessDocumentPdfRenderer");

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const EMAIL_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MESSAGE_KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function context({ owner = 1, jobId = "22222222-2222-4222-8222-222222222222", version = 2 } = {}) {
  return {
    owner,
    contractorProfileId: 10,
    business: { business_name: "Handyman LLC", business_email: "pro@example.test" },
    document: {
      id: DRAFT_ID,
      documentType: "QUOTE",
      reference: "WQ-FAN",
      jobId,
      version,
      content: {
        customerName: "Jack Smith",
        customerEmail: "jack@example.test",
        projectTitle: "Fan replacement",
        recommendedSolution: "Replace fan.",
        materialItems: [{ name: "Fan", total: "89.99" }],
        laborItems: [{ description: "Installation", total: "180" }],
        agreement: { exclusions: ["Painting"], hiddenConditionsTerms: "Hidden work is excluded." },
      },
      photos: [
        { id: "public", role: "BEFORE", visibility: "CUSTOMER_VISIBLE", media: { secure_url: "https://res.cloudinary.com/demo/public.jpg" } },
        { id: "private", role: "AFTER", visibility: "PRIVATE_INTERNAL", media: { secure_url: "https://res.cloudinary.com/demo/private.jpg" } },
      ],
    },
  };
}

function memoryStore({ conversation = true } = {}) {
  const source = context();
  const events = [];
  const commands = new Map();
  return {
    source,
    events,
    async loadContext({ actorUserId, draftId }) {
      return actorUserId === source.owner && draftId === source.document.id ? source : null;
    },
    async reserveEmail(values) {
      if (source.document.version !== values.documentVersion) return { kind: "version_conflict", currentVersion: source.document.version };
      const current = commands.get(`EMAIL:${values.idempotencyKey}`);
      if (current) return current.hash === values.requestHash
        ? { kind: "replay", delivery: { ...current.delivery, replayed: true } }
        : { kind: "idempotency_conflict" };
      const delivery = {
        id: `email-${events.length + 1}`, documentId: DRAFT_ID, documentType: values.documentType,
        documentReference: values.documentReference, documentVersion: values.documentVersion,
        channel: "EMAIL", state: "REQUESTING", recipientEmail: values.recipientEmail,
        subject: values.subject, customerMessage: values.customerMessage,
      };
      events.push({ delivery, snapshot: values.customerPackage });
      commands.set(`EMAIL:${values.idempotencyKey}`, { hash: values.requestHash, delivery });
      return { kind: "reserved", delivery, eventId: delivery.id };
    },
    async completeEmail({ eventId, state, providerStatus, providerReference, failureCode }) {
      const event = events.find((item) => item.delivery.id === eventId);
      Object.assign(event.delivery, { state, providerStatus, providerReference, failureCode, sentAt: state === "DELIVERY_REQUESTED" ? "2026-08-21T16:18:00.000Z" : null });
      return event.delivery;
    },
    async deliverMessage(values) {
      if (!conversation || !source.document.jobId) return { kind: "conversation_unavailable" };
      const current = commands.get(`MEETRO_MESSAGE:${values.idempotencyKey}`);
      if (current) return current.hash === values.requestHash
        ? { kind: "replay", delivery: { ...current.delivery, replayed: true } }
        : { kind: "idempotency_conflict" };
      const delivery = {
        id: `message-${events.length + 1}`, documentId: DRAFT_ID, documentType: values.documentType,
        documentReference: values.documentReference, documentVersion: values.documentVersion,
        channel: "MEETRO_MESSAGE", state: "SENT", recipientUserId: 8,
        conversationId: 50, messageId: 70, sentAt: "2026-08-21T16:20:00.000Z",
      };
      events.push({ delivery, snapshot: values.customerPackage });
      commands.set(`MEETRO_MESSAGE:${values.idempotencyKey}`, { hash: values.requestHash, delivery });
      return { kind: "sent", delivery };
    },
    async list({ actorUserId }) {
      return actorUserId === source.owner ? events.map((item) => item.delivery) : [];
    },
  };
}

function deliveryInput(overrides = {}) {
  return {
    pool: {}, authenticatedActor: { id: 1 }, draftId: DRAFT_ID,
    expectedVersion: 2, idempotencyKey: EMAIL_KEY, channel: "EMAIL",
    recipientEmail: "jack@example.test", subject: "Your Quote", customerMessage: "Please review.",
    pdfRenderer: async (customerPackage) => ({
      buffer: Buffer.from("%PDF-professional"),
      base64: Buffer.from("%PDF-professional").toString("base64"),
      filename: `quote-${customerPackage.document.reference}-v${customerPackage.document.version}.pdf`,
      contentType: "application/pdf",
    }),
    ...overrides,
  };
}

test("Email delivery sends one exact saved customer-safe version and retry replays without duplication", async () => {
  const store = memoryStore();
  const providerCalls = [];
  const emailDelivery = {
    providerName: "resend",
    async sendBusinessDocumentEmail(input) { providerCalls.push(input); return { accepted: true, status: "accepted", providerReference: "email-1" }; },
  };
  const first = await deliverBusinessDocument({ ...deliveryInput(), store, emailDelivery });
  const replay = await deliverBusinessDocument({ ...deliveryInput(), store, emailDelivery });
  assert.equal(first.status, 202);
  assert.equal(first.delivery.state, "DELIVERY_REQUESTED");
  assert.equal(replay.delivery.replayed, true);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].idempotencyKey, EMAIL_KEY);
  assert.equal(providerCalls[0].attachment.contentType, "application/pdf");
  assert.equal(providerCalls[0].attachment.filename, "quote-WQ-FAN-v2.pdf");
  assert.equal(Buffer.from(providerCalls[0].attachment.content, "base64").toString(), "%PDF-professional");
  assert.equal(store.events[0].snapshot.document.version, 2);
  assert.doesNotMatch(JSON.stringify(store.events[0].snapshot), /private\.jpg/);
});

test("PDF rendering failure is governed before provider invocation and cannot create false delivery-requested state", async () => {
  const store = memoryStore();
  let providerCalls = 0;
  const result = await deliverBusinessDocument({
    ...deliveryInput({ pdfRenderer: async () => { throw new Error("decode failed"); } }),
    store,
    emailDelivery: { async sendBusinessDocumentEmail() { providerCalls += 1; return { accepted: true }; } },
  });
  assert.equal(result.status, 422);
  assert.equal(result.code, "BUSINESS_DOCUMENT_PDF_RENDER_FAILED");
  assert.equal(result.delivery.state, "FAILED");
  assert.equal(result.delivery.failureCode, "BUSINESS_DOCUMENT_PDF_RENDER_FAILED");
  assert.equal(providerCalls, 0);
  assert.equal(store.events.some((event) => event.delivery.state === "DELIVERY_REQUESTED"), false);
});

test("customer photo timeout fails closed before the Email provider is invoked", async () => {
  const store = memoryStore();
  let providerCalls = 0;
  const result = await deliverBusinessDocument({
    ...deliveryInput({
      pdfRenderer: (customerPackage) => renderBusinessDocumentCustomerPdf(customerPackage, {
        timeoutMs: 5,
        fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
      }),
    }),
    store,
    emailDelivery: { async sendBusinessDocumentEmail() { providerCalls += 1; return { accepted: true }; } },
  });
  assert.equal(result.status, 422);
  assert.equal(result.code, "BUSINESS_DOCUMENT_PDF_RENDER_FAILED");
  assert.equal(providerCalls, 0);
  assert.equal(store.events.some((event) => event.delivery.state === "DELIVERY_REQUESTED"), false);
});

test("Email failure remains failed without acceptance, payment, lifecycle, or duplicate authority", async () => {
  const store = memoryStore();
  const before = structuredClone(store.source);
  const failed = await deliverBusinessDocument({
    ...deliveryInput(), store,
    emailDelivery: { providerName: "resend", async sendBusinessDocumentEmail() { return { accepted: false, status: "provider_rejected" }; } },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.delivery.state, "FAILED");
  assert.deepEqual(store.source, before);
  assert.equal(failed.delivery.acceptedAt, undefined);
  assert.equal(failed.delivery.paymentStatus, undefined);
  assert.equal(failed.delivery.jobStatus, undefined);
});

test("stale version and another business fail before provider invocation", async () => {
  const store = memoryStore();
  let providerCalls = 0;
  const emailDelivery = { async sendBusinessDocumentEmail() { providerCalls += 1; return { accepted: true }; } };
  const stale = await deliverBusinessDocument({ ...deliveryInput({ expectedVersion: 1 }), store, emailDelivery });
  const other = await deliverBusinessDocument({ ...deliveryInput({ authenticatedActor: { id: 2 } }), store, emailDelivery });
  assert.equal(stale.status, 409);
  assert.equal(other.status, 404);
  assert.equal(providerCalls, 0);
});

test("governed Message succeeds once while standalone draft remains truthfully unavailable", async () => {
  const store = memoryStore();
  const sent = await deliverBusinessDocument({
    ...deliveryInput({ channel: "MEETRO_MESSAGE", recipientEmail: undefined, subject: "", idempotencyKey: MESSAGE_KEY }),
    store,
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.delivery.channel, "MEETRO_MESSAGE");
  assert.equal(sent.delivery.state, "SENT");
  const unavailableStore = memoryStore({ conversation: false });
  const unavailable = await deliverBusinessDocument({
    ...deliveryInput({ channel: "MEETRO_MESSAGE", recipientEmail: undefined, subject: "", idempotencyKey: MESSAGE_KEY }),
    store: unavailableStore,
  });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.code, "BUSINESS_DOCUMENT_MESSAGE_UNAVAILABLE");
  assert.equal(unavailableStore.events.length, 0);
});

test("owner-scoped history preserves legitimate Email and Message attempts", async () => {
  const store = memoryStore();
  await deliverBusinessDocument({ ...deliveryInput(), store, emailDelivery: { async sendBusinessDocumentEmail() { return { accepted: true, status: "accepted" }; } } });
  await deliverBusinessDocument({ ...deliveryInput({ channel: "MEETRO_MESSAGE", recipientEmail: undefined, subject: "", idempotencyKey: MESSAGE_KEY }), store });
  const history = await listBusinessDocumentDeliveries({ pool: {}, authenticatedActor: { id: 1 }, draftId: DRAFT_ID, store });
  const denied = await listBusinessDocumentDeliveries({ pool: {}, authenticatedActor: { id: 2 }, draftId: DRAFT_ID, store });
  assert.equal(history.deliveries.length, 2);
  assert.equal(denied.status, 404);
});

test("owner-scoped customer PDF retrieval enforces exact version for Quote and Invoice without mutation", async () => {
  const store = memoryStore();
  const before = structuredClone(store.source);
  const pdfRenderer = async (customerPackage) => ({
    buffer: Buffer.from("%PDF-saved"), base64: Buffer.from("%PDF-saved").toString("base64"),
    filename: `${customerPackage.document.type.toLowerCase()}-${customerPackage.document.reference}-v${customerPackage.document.version}.pdf`,
    contentType: "application/pdf",
  });
  const quote = await getBusinessDocumentCustomerPdf({
    pool: {}, authenticatedActor: { id: 1 }, draftId: DRAFT_ID,
    expectedVersion: 2, store, pdfRenderer,
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.pdf.contentType, "application/pdf");
  assert.equal(quote.pdf.filename, "quote-WQ-FAN-v2.pdf");
  const stale = await getBusinessDocumentCustomerPdf({
    pool: {}, authenticatedActor: { id: 1 }, draftId: DRAFT_ID,
    expectedVersion: 1, store, pdfRenderer,
  });
  const denied = await getBusinessDocumentCustomerPdf({
    pool: {}, authenticatedActor: { id: 2 }, draftId: DRAFT_ID,
    expectedVersion: 2, store, pdfRenderer,
  });
  assert.equal(stale.status, 409);
  assert.equal(denied.status, 404);
  store.source.document.documentType = "INVOICE";
  store.source.document.reference = "WI-FAN";
  const invoice = await getBusinessDocumentCustomerPdf({
    pool: {}, authenticatedActor: { id: 1 }, draftId: DRAFT_ID,
    expectedVersion: 2, store, pdfRenderer,
  });
  assert.equal(invoice.pdf.filename, "invoice-WI-FAN-v2.pdf");
  store.source.document.documentType = before.document.documentType;
  store.source.document.reference = before.document.reference;
  assert.deepEqual(store.source, before);
});
