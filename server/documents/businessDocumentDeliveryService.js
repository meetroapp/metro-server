"use strict";

const { createHash } = require("node:crypto");
const {
  createBusinessDocumentDeliveryMessageWithClient,
} = require("../conversations/conversationMessageService");
const {
  buildBusinessDocumentCustomerPackage,
  buildCustomerPackageEmail,
  customerPackageHash,
} = require("./businessDocumentCustomerPackage");
const {
  renderBusinessDocumentCustomerPdf,
} = require("./businessDocumentPdfRenderer");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNELS = Object.freeze(["EMAIL", "MEETRO_MESSAGE"]);

function failure(status, code, message, extra = {}) {
  return { ok: false, status, code, message, ...extra };
}

function exactObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return exactObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function actorId(actor) {
  const id = Number(actor?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function text(value, maximum, required = false) {
  if (value == null) return required ? null : "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length > maximum || (required && !normalized)) return null;
  return normalized;
}

function email(value) {
  const normalized = text(value, 320, true);
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (exactObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function validateDeliveryInput(input) {
  const allowed = new Set([
    "pool", "authenticatedActor", "draftId", "expectedVersion", "idempotencyKey",
    "channel", "recipientEmail", "subject", "customerMessage", "store", "emailDelivery",
    "pdfRenderer", "fetchImpl",
  ]);
  if (!onlyKeys(input, allowed)) return { error: failure(400, "BUSINESS_DOCUMENT_DELIVERY_FIELD_REJECTED", "The delivery request is invalid.") };
  const id = actorId(input.authenticatedActor);
  const draftId = uuid(input.draftId);
  const key = uuid(input.idempotencyKey);
  const expectedVersion = Number(input.expectedVersion);
  const channel = String(input.channel || "").trim().toUpperCase();
  const subject = text(input.subject, 240);
  const customerMessage = text(input.customerMessage, 4000);
  const recipientEmail = channel === "EMAIL" ? email(input.recipientEmail) : null;
  if (!id) return { error: failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.") };
  if (!draftId || !key || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !CHANNELS.includes(channel) || subject === null || customerMessage === null ||
      (channel === "EMAIL" && !recipientEmail) ||
      (channel === "MEETRO_MESSAGE" && input.recipientEmail != null)) {
    return { error: failure(400, "BUSINESS_DOCUMENT_DELIVERY_INVALID", "A valid saved document version, channel, and recipient are required.") };
  }
  return { actorId: id, draftId, expectedVersion, idempotencyKey: key, channel, recipientEmail, subject, customerMessage };
}

function timestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function deliveryProjection(row, { replayed = false } = {}) {
  return Object.freeze({
    id: String(row.id),
    documentId: String(row.source_document_id),
    documentType: row.document_type,
    documentReference: row.document_reference,
    documentVersion: Number(row.document_version),
    channel: row.channel,
    state: row.delivery_state,
    recipientEmail: row.recipient_email || null,
    recipientUserId: row.recipient_user_id == null ? null : Number(row.recipient_user_id),
    conversationId: row.conversation_id == null ? null : Number(row.conversation_id),
    messageId: row.message_id == null ? null : Number(row.message_id),
    subject: row.subject || "",
    customerMessage: row.customer_message || "",
    provider: row.provider_name || null,
    providerReference: row.provider_reference || null,
    providerStatus: row.provider_status || null,
    failureCode: row.failure_code || null,
    requestedAt: timestamp(row.requested_at),
    sentAt: timestamp(row.sent_at),
    replayed,
  });
}

async function withTransaction(pool, action) {
  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  if (!client || typeof client.query !== "function") throw new TypeError("A database pool is required.");
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await action(client);
    if (result?.abort) {
      await client.query("ROLLBACK");
      started = false;
      return result.abort;
    }
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadPhotos(client, documentId) {
  const result = await client.query(
    `/* business_document_delivery:load_photos */
     SELECT public_id AS id, media, role, visibility, media->>'name' AS name
     FROM business_document_draft_media
     WHERE document_draft_id = $1
     ORDER BY display_order ASC, id ASC`,
    [documentId]
  );
  return result.rows;
}

async function loadOwnedContext(client, actorUserId, draftId, { lock = false } = {}) {
  const result = await client.query(
    `/* business_document_delivery:load_owned */
     SELECT drafts.*, profiles.business_name, profiles.phone, profiles.location,
            profiles.image_url, profiles.profile_details,
            users.email AS business_email
     FROM business_document_working_drafts drafts
     INNER JOIN contractor_profiles profiles ON profiles.id = drafts.contractor_profile_id
     INNER JOIN users ON users.id = profiles.user_id
     WHERE drafts.id = $1 AND profiles.user_id = $2
       AND drafts.draft_status = 'WORKING_DRAFT'
     LIMIT 1 ${lock ? "FOR SHARE OF drafts" : ""}`,
    [draftId, actorUserId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    contractorProfileId: Number(row.contractor_profile_id),
    business: row,
    document: {
      id: String(row.id),
      documentType: row.document_type,
      reference: row.draft_reference,
      jobId: row.job_id || null,
      version: Number(row.version),
      content: exactObject(row.content) ? row.content : {},
      photos: await loadPhotos(client, row.id),
    },
  };
}

async function findEvent(client, actorUserId, channel, idempotencyKey) {
  const result = await client.query(
    `/* business_document_delivery:find_event */
     SELECT * FROM business_document_delivery_events
     WHERE actor_user_id = $1 AND channel = $2 AND idempotency_key = $3
     LIMIT 1 FOR UPDATE`,
    [actorUserId, channel, idempotencyKey]
  );
  return result.rows[0] || null;
}

async function insertEvent(client, values) {
  const result = await client.query(
    `/* business_document_delivery:insert_event */
     INSERT INTO business_document_delivery_events (
       contractor_profile_id, actor_user_id, document_draft_id, source_document_id,
       document_type, document_reference, document_version, channel, delivery_state,
       recipient_email, recipient_user_id, conversation_id, subject, customer_message,
       customer_document_snapshot, snapshot_hash, provider_name, idempotency_key, request_hash
     ) VALUES (
       $1, $2, $3, $3, $4, $5, $6, $7, 'REQUESTING',
       $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17
     ) RETURNING *`,
    [
      values.contractorProfileId, values.actorUserId, values.draftId,
      values.documentType, values.documentReference, values.documentVersion,
      values.channel, values.recipientEmail, values.recipientUserId,
      values.conversationId, values.subject, values.customerMessage,
      JSON.stringify(values.customerPackage), values.snapshotHash,
      values.providerName, values.idempotencyKey, values.requestHash,
    ]
  );
  return result.rows[0];
}

async function reserveEmailSql(values) {
  return withTransaction(values.pool, async (client) => {
    const current = await loadOwnedContext(client, values.actorUserId, values.draftId, { lock: true });
    if (!current) return { abort: { kind: "not_found" } };
    if (current.document.version !== values.documentVersion) return { abort: { kind: "version_conflict", currentVersion: current.document.version } };
    const existing = await findEvent(client, values.actorUserId, "EMAIL", values.idempotencyKey);
    if (existing) return existing.request_hash === values.requestHash
      ? { kind: "replay", delivery: deliveryProjection(existing, { replayed: true }) }
      : { kind: "idempotency_conflict" };
    const row = await insertEvent(client, values);
    return { kind: "reserved", delivery: deliveryProjection(row), eventId: row.id };
  });
}

async function completeEmailSql({ pool, actorUserId, eventId, state, providerStatus, providerReference, failureCode }) {
  const result = await pool.query(
    `/* business_document_delivery:complete_email */
     UPDATE business_document_delivery_events
     SET delivery_state = $3, provider_status = $4, provider_reference = $5,
         failure_code = $6, sent_at = CASE WHEN $3 IN ('SENT', 'DELIVERY_REQUESTED') THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND actor_user_id = $2 AND channel = 'EMAIL'
       AND delivery_state = 'REQUESTING'
     RETURNING *`,
    [eventId, actorUserId, state, providerStatus, providerReference, failureCode]
  );
  return result.rows[0] ? deliveryProjection(result.rows[0]) : null;
}

async function governedConversation(client, actorUserId, jobId) {
  if (!jobId) return null;
  const result = await client.query(
    `/* business_document_delivery:governed_conversation */
     SELECT conversations.id AS conversation_id, conversations.status AS conversation_status,
            relationships.homeowner_id AS recipient_user_id,
            relationships.professional_user_id
     FROM jobs
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
      AND relationships.professional_user_id = $1
      AND relationships.status = 'active'
      AND relationships.emergency_request_id IS NULL
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id
      AND professional.request_relationship_id = relationships.id
      AND professional.user_id = $1
     INNER JOIN relationship_participants customer
       ON customer.job_id = jobs.id
      AND customer.request_relationship_id = relationships.id
      AND customer.user_id = relationships.homeowner_id
     INNER JOIN participant_role_assignments roles
       ON roles.participant_id = professional.id AND roles.job_id = jobs.id
      AND roles.role = 'PRIMARY_PROFESSIONAL'
      AND roles.valid_from <= CURRENT_TIMESTAMP
      AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
     LEFT JOIN participant_role_revocations revocations
       ON revocations.role_assignment_id = roles.id
     INNER JOIN conversations
       ON conversations.relationship_id = relationships.id
      AND conversations.status = 'active'
     WHERE jobs.id = $2 AND revocations.id IS NULL
     LIMIT 1`,
    [actorUserId, jobId]
  );
  return result.rows[0] || null;
}

async function deliverMessageSql(values) {
  return withTransaction(values.pool, async (client) => {
    const current = await loadOwnedContext(client, values.actorUserId, values.draftId, { lock: true });
    if (!current) return { abort: { kind: "not_found" } };
    if (current.document.version !== values.documentVersion) return { abort: { kind: "version_conflict", currentVersion: current.document.version } };
    const existing = await findEvent(client, values.actorUserId, "MEETRO_MESSAGE", values.idempotencyKey);
    if (existing) return existing.request_hash === values.requestHash
      ? { kind: "replay", delivery: deliveryProjection(existing, { replayed: true }) }
      : { kind: "idempotency_conflict" };
    const context = await governedConversation(client, values.actorUserId, current.document.jobId);
    if (!context) return { abort: { kind: "conversation_unavailable" } };
    const conversation = {
      id: Number(context.conversation_id),
      homeowner_id: Number(context.recipient_user_id),
      professional_user_id: Number(context.professional_user_id),
      status: context.conversation_status,
    };
    const event = await insertEvent(client, {
      ...values,
      recipientUserId: Number(context.recipient_user_id),
      conversationId: conversation.id,
    });
    const label = values.documentType === "QUOTE" ? "Quote" : "Invoice";
    const messageText = [
      values.customerMessage,
      `${current.business.business_name || "Your professional"} shared ${label} ${values.documentReference} (version ${values.documentVersion}).`,
      `Amount: ${(values.customerPackage.totalMinor / 100).toFixed(2)} ${values.customerPackage.currency}.`,
    ].filter(Boolean).join("\n\n");
    const message = await createBusinessDocumentDeliveryMessageWithClient({
      client,
      conversation,
      senderUserId: values.actorUserId,
      recipientUserId: Number(context.recipient_user_id),
      messageText,
      workflowPayload: values.customerPackage,
    });
    const completed = await client.query(
      `/* business_document_delivery:complete_message */
       UPDATE business_document_delivery_events
       SET delivery_state = 'SENT', message_id = $2, sent_at = COALESCE($3, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [event.id, message.id, message.created_at || null]
    );
    return { kind: "sent", delivery: deliveryProjection(completed.rows[0]) };
  });
}

async function listSql({ pool, actorUserId, draftId }) {
  const result = await pool.query(
    `/* business_document_delivery:list */
     SELECT events.*
     FROM business_document_delivery_events events
     INNER JOIN contractor_profiles profiles ON profiles.id = events.contractor_profile_id
     WHERE profiles.user_id = $1 AND events.source_document_id = $2
     ORDER BY events.requested_at DESC, events.id DESC
     LIMIT 100`,
    [actorUserId, draftId]
  );
  return result.rows.map((row) => deliveryProjection(row));
}

const sqlStore = Object.freeze({
  loadContext({ pool, actorUserId, draftId }) { return loadOwnedContext(pool, actorUserId, draftId); },
  reserveEmail: reserveEmailSql,
  completeEmail: completeEmailSql,
  deliverMessage: deliverMessageSql,
  list: listSql,
});

function governedOutcome(result) {
  if (result.kind === "not_found") return failure(404, "BUSINESS_DOCUMENT_NOT_FOUND", "The saved working document was not found.");
  if (result.kind === "version_conflict") return failure(409, "BUSINESS_DOCUMENT_DELIVERY_VERSION_CONFLICT", "A newer saved document version exists.", { currentVersion: result.currentVersion });
  if (result.kind === "idempotency_conflict") return failure(409, "BUSINESS_DOCUMENT_DELIVERY_IDEMPOTENCY_CONFLICT", "The delivery identity was already used for a different request.");
  if (result.kind === "conversation_unavailable") return failure(409, "BUSINESS_DOCUMENT_MESSAGE_UNAVAILABLE", "Meetro Message is unavailable because this document has no active governed customer conversation.");
  return null;
}

async function deliverBusinessDocument(input = {}) {
  const validated = validateDeliveryInput(input);
  if (validated.error) return validated.error;
  const store = input.store || sqlStore;
  const context = await store.loadContext({ pool: input.pool, actorUserId: validated.actorId, draftId: validated.draftId });
  if (!context) return failure(404, "BUSINESS_DOCUMENT_NOT_FOUND", "The saved working document was not found.");
  if (context.document.version !== validated.expectedVersion) {
    return failure(409, "BUSINESS_DOCUMENT_DELIVERY_VERSION_CONFLICT", "A newer saved document version exists.", { currentVersion: context.document.version });
  }
  const customerPackage = buildBusinessDocumentCustomerPackage(context.document, context.business);
  if (!customerPackage || customerPackage.document.version !== validated.expectedVersion) {
    return failure(409, "BUSINESS_DOCUMENT_DELIVERY_PACKAGE_INVALID", "A customer-safe saved document package could not be created.");
  }
  const hash = customerPackageHash(customerPackage);
  const commandHash = requestHash({
    actorUserId: validated.actorId, draftId: validated.draftId,
    documentVersion: validated.expectedVersion, channel: validated.channel,
    recipientEmail: validated.recipientEmail, subject: validated.subject,
    customerMessage: validated.customerMessage, snapshotHash: hash,
  });
  const values = {
    pool: input.pool,
    actorUserId: validated.actorId,
    contractorProfileId: context.contractorProfileId,
    draftId: validated.draftId,
    documentType: context.document.documentType,
    documentReference: context.document.reference,
    documentVersion: validated.expectedVersion,
    channel: validated.channel,
    recipientEmail: validated.recipientEmail,
    recipientUserId: null,
    conversationId: null,
    subject: validated.subject,
    customerMessage: validated.customerMessage,
    customerPackage,
    snapshotHash: hash,
    providerName: input.emailDelivery?.providerName || null,
    idempotencyKey: validated.idempotencyKey,
    requestHash: commandHash,
  };

  if (validated.channel === "MEETRO_MESSAGE") {
    const result = await store.deliverMessage(values);
    const error = governedOutcome(result);
    return error || {
      ok: true, status: 200, code: "BUSINESS_DOCUMENT_SENT_IN_MEETRO",
      delivery: result.delivery,
    };
  }

  const reservation = await store.reserveEmail(values);
  const reservationError = governedOutcome(reservation);
  if (reservationError) return reservationError;
  if (reservation.kind === "replay") {
    const failed = reservation.delivery.state === "FAILED";
    return failed
      ? failure(502, "BUSINESS_DOCUMENT_EMAIL_FAILED", "The prior email delivery attempt failed. Choose Retry to create a new attempt.", { delivery: reservation.delivery })
      : { ok: true, status: 200, code: "BUSINESS_DOCUMENT_DELIVERY_REPLAYED", delivery: reservation.delivery };
  }
  let pdfArtifact;
  try {
    const renderer = input.pdfRenderer || renderBusinessDocumentCustomerPdf;
    pdfArtifact = await renderer(customerPackage, { fetchImpl: input.fetchImpl });
  } catch {
    const delivery = await store.completeEmail({
      pool: input.pool, actorUserId: validated.actorId, eventId: reservation.eventId,
      state: "FAILED", providerStatus: "pdf_render_failed",
      providerReference: null, failureCode: "BUSINESS_DOCUMENT_PDF_RENDER_FAILED",
    });
    if (!delivery) throw new Error("Business document PDF failure evidence could not be completed.");
    return failure(422, "BUSINESS_DOCUMENT_PDF_RENDER_FAILED", "The customer PDF could not be prepared. Nothing was sent and the saved document is unchanged.", { delivery });
  }
  const emailPackage = buildCustomerPackageEmail(customerPackage, {
    subject: validated.subject,
    customerMessage: validated.customerMessage,
    pdfArtifact,
  });
  let providerResult;
  try {
    providerResult = typeof input.emailDelivery?.sendBusinessDocumentEmail === "function"
      ? await input.emailDelivery.sendBusinessDocumentEmail({
          recipientEmail: validated.recipientEmail,
          ...emailPackage,
          idempotencyKey: validated.idempotencyKey,
        })
      : { accepted: false, status: "provider_not_configured" };
  } catch {
    providerResult = { accepted: false, status: "provider_unavailable" };
  }
  const ambiguous = providerResult.status === "timeout";
  const state = providerResult.accepted || ambiguous ? "DELIVERY_REQUESTED" : "FAILED";
  const delivery = await store.completeEmail({
    pool: input.pool, actorUserId: validated.actorId, eventId: reservation.eventId,
    state, providerStatus: providerResult.status || "provider_unavailable",
    providerReference: providerResult.providerReference || null,
    failureCode: state === "FAILED" ? "EMAIL_PROVIDER_REJECTED" : null,
  });
  if (!delivery) throw new Error("Business document email delivery evidence could not be completed.");
  if (state === "FAILED") {
    return failure(502, "BUSINESS_DOCUMENT_EMAIL_FAILED", "The email could not be sent. The saved document is unchanged and you can retry.", { delivery });
  }
  return {
    ok: true, status: 202, code: "BUSINESS_DOCUMENT_EMAIL_DELIVERY_REQUESTED",
    delivery,
  };
}

async function getBusinessDocumentCustomerPdf(input = {}) {
  const allowed = new Set([
    "pool", "authenticatedActor", "draftId", "expectedVersion", "store",
    "pdfRenderer", "fetchImpl",
  ]);
  if (!onlyKeys(input, allowed)) return failure(400, "BUSINESS_DOCUMENT_PDF_FIELD_REJECTED", "The customer PDF request is invalid.");
  const id = actorId(input.authenticatedActor);
  const draftId = uuid(input.draftId);
  const expectedVersion = Number(input.expectedVersion);
  if (!id) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!draftId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return failure(400, "BUSINESS_DOCUMENT_PDF_INVALID", "A valid saved document and version are required.");
  }
  const store = input.store || sqlStore;
  const context = await store.loadContext({ pool: input.pool, actorUserId: id, draftId });
  if (!context) return failure(404, "BUSINESS_DOCUMENT_NOT_FOUND", "The saved working document was not found.");
  if (context.document.version !== expectedVersion) {
    return failure(409, "BUSINESS_DOCUMENT_PDF_VERSION_CONFLICT", "A different saved document version exists.", { currentVersion: context.document.version });
  }
  const customerPackage = buildBusinessDocumentCustomerPackage(context.document, context.business);
  if (!customerPackage) return failure(409, "BUSINESS_DOCUMENT_DELIVERY_PACKAGE_INVALID", "A customer-safe saved document package could not be created.");
  try {
    const renderer = input.pdfRenderer || renderBusinessDocumentCustomerPdf;
    const pdf = await renderer(customerPackage, { fetchImpl: input.fetchImpl });
    return { ok: true, status: 200, code: "BUSINESS_DOCUMENT_CUSTOMER_PDF_READY", pdf };
  } catch {
    return failure(422, "BUSINESS_DOCUMENT_PDF_RENDER_FAILED", "The customer PDF could not be prepared. The saved document is unchanged.");
  }
}

async function listBusinessDocumentDeliveries(input = {}) {
  const allowed = new Set(["pool", "authenticatedActor", "draftId", "store"]);
  if (!onlyKeys(input, allowed)) return failure(400, "BUSINESS_DOCUMENT_DELIVERY_FIELD_REJECTED", "The delivery-history request is invalid.");
  const id = actorId(input.authenticatedActor);
  const draftId = uuid(input.draftId);
  if (!id) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!draftId) return failure(400, "BUSINESS_DOCUMENT_ID_INVALID", "A valid working document ID is required.");
  const store = input.store || sqlStore;
  const context = await store.loadContext({ pool: input.pool, actorUserId: id, draftId });
  if (!context) return failure(404, "BUSINESS_DOCUMENT_NOT_FOUND", "The saved working document was not found.");
  return {
    ok: true, status: 200, code: "BUSINESS_DOCUMENT_DELIVERIES_LOADED",
    deliveries: await store.list({ pool: input.pool, actorUserId: id, draftId }),
  };
}

module.exports = {
  deliverBusinessDocument,
  getBusinessDocumentCustomerPdf,
  listBusinessDocumentDeliveries,
  businessDocumentDeliveryInternals: {
    CHANNELS,
    deliveryProjection,
    requestHash,
    sqlStore,
    validateDeliveryInput,
  },
};
