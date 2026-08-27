"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const {
  commercialAuthorityInternals,
} = require("./commercialAuthorityService");
const {
  QUOTE_CAPABILITIES,
  QUOTE_STATUS,
  calculateTotals,
  quoteDraftServiceInternals,
} = require("./quoteDraftService");
const {
  advanceConversationParticipantReadStateWithClient,
  ensureConversationParticipantStatesWithClient,
} = require("../conversations/conversationParticipantStateService");
const {
  createOrRefreshCommunicationMessageAlert,
  getCommunicationAttentionWindowWithClient,
  resolveCommunicationRecipient,
} = require("../alerts/communicationAlertService");

const {
  databaseClient,
  failure,
  isPlainObject,
  normalizedUuid,
  positiveInteger,
  rollback,
  validateAuthenticatedActor,
  validateIdempotencyKey,
} = commercialAuthorityInternals;
const {
  customerQuoteDetailProjection,
  deriveCommercialSnapshots,
  integrityHash,
  loadQuoteContext,
  loadQuoteProjection,
  persistedSnapshotIsValid,
  quoteIntegrityContract,
  requireQuoteAuthority,
} = quoteDraftServiceInternals;

const MESSAGE_TYPE = "quote_shared";
const WORKFLOW_TYPE = "QUOTE_SHARED";
const WORKFLOW_STATUS = "SENT";
const DELIVERY_STATE = "SENT_IN_MEETRO";
const COMMAND_NAME = "professional.quote.send_in_meetro";
const SNAPSHOT_SCHEMA_VERSION = 1;

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : { info() {}, warn() {} };
}

function validateInput(input, fields) {
  const allowed = new Set(["pool", "authenticatedActor", "logger", ...fields]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: failure(400, "QUOTE_DELIVERY_FIELD_REJECTED", "The Quote delivery request is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const quoteId = normalizedUuid(input.quoteId);
  if (!quoteId) {
    return { error: failure(400, "INVALID_QUOTE_DELIVERY", "The Quote delivery request is invalid.") };
  }
  return { actorId: actor.id, quoteId };
}

async function runTransaction(pool, mode, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${mode}`);
    started = true;
    const value = await action(client);
    if (value?.abort) {
      await client.query("ROLLBACK");
      started = false;
      return value.abort;
    }
    await client.query("COMMIT");
    started = false;
    return value;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadDeliveryContext(client, context) {
  const result = await client.query(
    `
    SELECT
      conversations.id AS conversation_id,
      conversations.relationship_id AS conversation_relationship_id,
      conversations.homeowner_id,
      conversations.professional_user_id,
      conversations.status AS conversation_status,
      posts.title AS job_title,
      posts.category AS job_service,
      contractor_profiles.business_name
    FROM jobs
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
    INNER JOIN contractor_profiles
      ON contractor_profiles.user_id = relationships.professional_user_id
    LEFT JOIN conversations
      ON conversations.relationship_id = relationships.id
    WHERE jobs.id = $1
      AND relationships.id = $2
      AND relationships.homeowner_id = $3
      AND relationships.professional_user_id = $4
    LIMIT 1
    `,
    [
      context.job_id,
      context.relationship_id,
      context.homeowner_user_id,
      context.selected_professional_user_id,
    ]
  );
  return result.rows[0] || null;
}

function validIssuedQuote(quote, issuance) {
  if (!quote || quote.status !== QUOTE_STATUS.ISSUED || !quote.issuedAt) return false;
  const current = quote.versions.find((version) => version.version === quote.currentVersion);
  const totals = calculateTotals(quote.scopeItems);
  const commercialSnapshots = deriveCommercialSnapshots(quote.scopeItems);
  const integrityContract = current
    ? quoteIntegrityContract(current.integrityVersion, current.customerTermsSnapshot)
    : { error: "INVALID_QUOTE_INTEGRITY_CONTRACT" };
  if (
    !current ||
    current.status !== QUOTE_STATUS.ISSUED ||
    !current.issuedAt ||
    typeof current.integrityHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(current.integrityHash) ||
    quote.scopeItems.some((item) => !persistedSnapshotIsValid(item)) ||
    totals.error ||
    Number(current.materialsSubtotalMinor) !== totals.materialsSubtotalMinor ||
    Number(current.laborServiceSubtotalMinor) !== totals.laborServiceSubtotalMinor ||
    Number(current.totalMinor) !== Number(quote.totalMinor) ||
    Number(current.scopeItemCount) !== quote.scopeItems.length ||
    !isDeepStrictEqual(current.conditions, commercialSnapshots.conditions) ||
    !isDeepStrictEqual(current.exclusions, commercialSnapshots.exclusions) ||
    integrityContract.error ||
    !isDeepStrictEqual(
      quote.customerTermsSnapshot == null ? null : quote.customerTermsSnapshot,
      integrityContract.customerTermsSnapshot
    ) ||
    new Date(current.issuedAt).getTime() !== new Date(quote.issuedAt).getTime()
  ) return false;
  const recomputedHash = integrityHash({
    quoteId: quote.id,
    version: quote.currentVersion,
    currency: quote.currency,
    status: current.status,
    issuedAt: current.issuedAt,
    totals,
    snapshots: quote.scopeItems,
    conditions: commercialSnapshots.conditions,
    exclusions: commercialSnapshots.exclusions,
    integrityVersion: integrityContract.integrityVersion,
    customerTermsSnapshot: integrityContract.customerTermsSnapshot,
  });
  return Boolean(
    issuance &&
    Number(issuance.quote_version) === quote.currentVersion &&
    issuance.source_snapshot_integrity_hash === current.integrityHash &&
    recomputedHash === current.integrityHash &&
    new Date(issuance.issued_at).getTime() === new Date(quote.issuedAt).getTime()
  );
}

async function loadIssuance(client, quote) {
  const result = await client.query(
    `SELECT quote_version, issued_at, source_snapshot_integrity_hash
     FROM canonical_quote_issuances
     WHERE quote_id = $1 AND job_id = $2 AND quote_version = $3
     LIMIT 1`,
    [quote.id, quote.jobId, quote.currentVersion]
  );
  return result.rows[0] || null;
}

function safeText(value, fallback, max = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, max);
}

function buildSafeSnapshot(quote, deliveryContext) {
  const customer = customerQuoteDetailProjection(quote);
  if (!customer) return null;
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    quoteId: customer.quoteId,
    jobId: customer.jobId,
    lineageLabel: customer.lineageLabel,
    businessStatus: customer.businessStatus,
    totalMinor: customer.totalMinor,
    currency: customer.currency,
    scopeItems: customer.scopeItems,
    conditions: customer.conditions,
    exclusions: customer.exclusions,
    issuedAt: customer.issuedAt,
    decidedAt: customer.decidedAt,
    business: {
      displayName: safeText(deliveryContext.business_name, "Professional"),
    },
    job: {
      title: safeText(deliveryContext.job_title, deliveryContext.job_service || "Job"),
      service: safeText(deliveryContext.job_service, "", 120) || null,
    },
  };
  if (customer.customerTermsSnapshot != null) {
    snapshot.customerTermsSnapshot = customer.customerTermsSnapshot;
  }
  return snapshot;
}

function hasSendAuthority(deliveryContext, actorId) {
  return Boolean(
    deliveryContext &&
    positiveInteger(deliveryContext.conversation_id) &&
    Number(deliveryContext.conversation_relationship_id) > 0 &&
    Number(deliveryContext.professional_user_id) === actorId &&
    Number(deliveryContext.homeowner_id) > 0 &&
    Number(deliveryContext.homeowner_id) !== actorId &&
    deliveryContext.conversation_status === "active" &&
    resolveCommunicationRecipient({
      homeowner_id: deliveryContext.homeowner_id,
      professional_user_id: deliveryContext.professional_user_id,
    }, actorId) === Number(deliveryContext.homeowner_id)
  );
}

function deliveryProjection(quote, snapshot, deliveryContext, canSendInMeetro) {
  return {
    quoteId: quote.id,
    jobId: quote.jobId,
    expectedIssuedVersion: quote.currentVersion,
    messageType: WORKFLOW_TYPE,
    snapshot,
    actions: { canSendInMeetro },
    conversation: canSendInMeetro
      ? { id: Number(deliveryContext.conversation_id) }
      : null,
    existingDelivery: deliveryContext?.existing_delivery || null,
  };
}

async function loadExistingQuoteDelivery(client, quote, deliveryContext) {
  if (!hasSendAuthority(deliveryContext, Number(deliveryContext?.professional_user_id))) {
    return null;
  }
  const result = await client.query(
    `SELECT id, conversation_id, sender_id, receiver_id, quote_id, job_id, created_at
     FROM messages
     WHERE conversation_id = $1
       AND sender_id = $2
       AND receiver_id = $3
       AND quote_id = $4
       AND job_id = $5
       AND message_type = 'quote_shared'
       AND workflow_type = 'QUOTE_SHARED'
       AND workflow_status = 'SENT'
     ORDER BY id ASC
     LIMIT 1`,
    [
      Number(deliveryContext.conversation_id),
      Number(deliveryContext.professional_user_id),
      Number(deliveryContext.homeowner_id),
      quote.id,
      quote.jobId,
    ]
  );
  return result.rows[0]
    ? messageDeliveryEvidence(result.rows[0], { replayed: true })
    : null;
}

async function loadAuthorizedDelivery({ client, actorId, quoteId, logger, lock = false }) {
  const context = await loadQuoteContext(client, quoteId, actorId, { lock });
  const authorityError = await requireQuoteAuthority({
    client,
    context,
    capability: QUOTE_CAPABILITIES.READ,
    logger,
  });
  if (authorityError) return { error: authorityError };
  const quote = await loadQuoteProjection(client, quoteId);
  const issuance = quote ? await loadIssuance(client, quote) : null;
  if (!validIssuedQuote(quote, issuance)) {
    return { error: failure(409, "QUOTE_NOT_DELIVERABLE", "Only a valid issued Quote can be sent.") };
  }
  const deliveryContext = await loadDeliveryContext(client, context);
  const snapshot = deliveryContext ? buildSafeSnapshot(quote, deliveryContext) : null;
  if (!snapshot) {
    return { error: failure(409, "QUOTE_DELIVERY_SNAPSHOT_INVALID", "The Quote delivery snapshot is invalid.") };
  }
  if (deliveryContext) {
    deliveryContext.existing_delivery = await loadExistingQuoteDelivery(
      client,
      quote,
      deliveryContext
    );
  }
  return {
    context,
    quote,
    deliveryContext,
    snapshot,
    canSendInMeetro: hasSendAuthority(deliveryContext, actorId),
  };
}

async function getProfessionalQuoteDelivery(input = {}) {
  const validated = validateInput(input, ["quoteId"]);
  if (validated.error) return validated.error;
  const logger = safeLogger(input.logger);
  return runTransaction(input.pool, "REPEATABLE READ READ ONLY", async (client) => {
    const loaded = await loadAuthorizedDelivery({ client, ...validated, logger });
    if (loaded.error) return { abort: loaded.error };
    return {
      ok: true,
      success: true,
      status: 200,
      code: "PROFESSIONAL_QUOTE_DELIVERY_LOADED",
      delivery: deliveryProjection(
        loaded.quote,
        loaded.snapshot,
        loaded.deliveryContext,
        loaded.canSendInMeetro
      ),
    };
  });
}

function requestFingerprint({ actorId, quoteId, expectedIssuedVersion }) {
  return createHash("sha256").update(JSON.stringify({
    command: COMMAND_NAME,
    actorId,
    quoteId,
    expectedIssuedVersion,
  })).digest("hex");
}

function messageDeliveryEvidence(message, { replayed = false } = {}) {
  return {
    messageId: Number(message.id),
    conversationId: Number(message.conversation_id),
    quoteId: message.quote_id,
    jobId: message.job_id,
    messageType: WORKFLOW_TYPE,
    state: DELIVERY_STATE,
    sentAt: message.created_at,
    replayed,
  };
}

async function findExistingDelivery(client, actorId, quoteId, idempotencyKey) {
  const result = await client.query(
    `SELECT id, conversation_id, sender_id, receiver_id, message_text,
      message_type, workflow_type, workflow_status, workflow_payload,
      quote_id, job_id, delivery_request_fingerprint, created_at
     FROM messages
     WHERE sender_id = $1 AND quote_id = $2
       AND delivery_idempotency_key = $3 AND message_type = 'quote_shared'
     LIMIT 1
     FOR UPDATE`,
    [actorId, quoteId, idempotencyKey]
  );
  return result.rows[0] || null;
}

async function sendQuoteInMeetro(input = {}) {
  const validated = validateInput(input, ["quoteId", "expectedIssuedVersion", "idempotencyKey"]);
  if (validated.error) return validated.error;
  const expectedIssuedVersion = positiveInteger(input.expectedIssuedVersion);
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (!expectedIssuedVersion || idempotency.error) {
    return idempotency.error || failure(400, "INVALID_QUOTE_DELIVERY", "The Quote delivery request is invalid.");
  }
  const logger = safeLogger(input.logger);
  const fingerprint = requestFingerprint({ ...validated, expectedIssuedVersion });

  return runTransaction(input.pool, "READ COMMITTED", async (client) => {
    const loaded = await loadAuthorizedDelivery({
      client,
      ...validated,
      logger,
      lock: true,
    });
    if (loaded.error) return { abort: loaded.error };
    if (!loaded.canSendInMeetro) {
      return { abort: failure(409, "QUOTE_DELIVERY_CONVERSATION_UNAVAILABLE", "The Quote cannot be sent in Meetro.") };
    }

    const existing = await findExistingDelivery(
      client,
      validated.actorId,
      validated.quoteId,
      idempotency.idempotencyKey
    );
    if (existing) {
      if (existing.delivery_request_fingerprint !== fingerprint) {
        return { abort: failure(409, "QUOTE_DELIVERY_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different Quote delivery.") };
      }
      return {
        ok: true,
        success: true,
        status: 200,
        code: "QUOTE_SENT_IN_MEETRO",
        delivery: messageDeliveryEvidence(existing, { replayed: true }),
      };
    }
    if (loaded.quote.currentVersion !== expectedIssuedVersion) {
      return { abort: failure(409, "STALE_QUOTE_VERSION", "The Quote version is stale.") };
    }
    if (loaded.deliveryContext.existing_delivery) {
      return {
        ok: true,
        success: true,
        status: 200,
        code: "QUOTE_SENT_IN_MEETRO",
        delivery: loaded.deliveryContext.existing_delivery,
      };
    }

    const conversation = {
      id: Number(loaded.deliveryContext.conversation_id),
      homeowner_id: Number(loaded.deliveryContext.homeowner_id),
      professional_user_id: Number(loaded.deliveryContext.professional_user_id),
      status: loaded.deliveryContext.conversation_status,
    };
    const receiverId = resolveCommunicationRecipient(conversation, validated.actorId);
    await ensureConversationParticipantStatesWithClient({ client, conversationId: conversation.id });
    const recipientAttentionWindow = await getCommunicationAttentionWindowWithClient({
      client,
      conversationId: conversation.id,
      recipientUserId: receiverId,
    });
    const messageText = `${loaded.snapshot.business.displayName} shared a Quote.`;
    const inserted = await client.query(
      `INSERT INTO messages (
        quote_request_id, conversation_id, sender_id, receiver_id,
        message_text, image_url, message_type, workflow_type, workflow_status,
        workflow_payload, quote_id, job_id, delivery_idempotency_key,
        delivery_request_fingerprint
      ) VALUES (
        NULL, $1, $2, $3, $4, NULL, 'quote_shared', 'QUOTE_SHARED', 'SENT',
        $5::jsonb, $6, $7, $8, $9
      )
      ON CONFLICT (sender_id, quote_id, delivery_idempotency_key)
        WHERE message_type = 'quote_shared'
      DO NOTHING
      RETURNING id, conversation_id, sender_id, receiver_id, message_text,
        message_type, workflow_type, workflow_status, workflow_payload,
        quote_id, job_id, delivery_request_fingerprint, created_at`,
      [
        conversation.id,
        validated.actorId,
        receiverId,
        messageText,
        JSON.stringify(loaded.snapshot),
        loaded.quote.id,
        loaded.quote.jobId,
        idempotency.idempotencyKey,
        fingerprint,
      ]
    );
    let message = inserted.rows[0];
    if (!message) {
      message = await findExistingDelivery(
        client,
        validated.actorId,
        validated.quoteId,
        idempotency.idempotencyKey
      );
      if (!message || message.delivery_request_fingerprint !== fingerprint) {
        return { abort: failure(409, "QUOTE_DELIVERY_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different Quote delivery.") };
      }
      return {
        ok: true,
        success: true,
        status: 200,
        code: "QUOTE_SENT_IN_MEETRO",
        delivery: messageDeliveryEvidence(message, { replayed: true }),
      };
    }

    await advanceConversationParticipantReadStateWithClient({
      client,
      conversation,
      participantUserId: validated.actorId,
      lastReadMessageId: message.id,
      lastReadAt: message.created_at || null,
    });
    const activity = await client.query(
      `UPDATE conversations SET updated_at = COALESCE($2, CURRENT_TIMESTAMP) WHERE id = $1`,
      [conversation.id, message.created_at || null]
    );
    if (activity.rowCount === 0) throw new Error("Conversation activity could not be updated.");
    await createOrRefreshCommunicationMessageAlert({
      client,
      conversation,
      senderUserId: validated.actorId,
      recipientUserId: receiverId,
      recipientLastReadMessageId: recipientAttentionWindow.lastReadMessageId,
      message,
    });
    logger.info("Quote sent in Meetro", {
      code: "QUOTE_SENT_IN_MEETRO",
      quoteId: loaded.quote.id,
      jobId: loaded.quote.jobId,
      conversationId: conversation.id,
      messageId: Number(message.id),
    });
    return {
      ok: true,
      success: true,
      status: 201,
      code: "QUOTE_SENT_IN_MEETRO",
      delivery: messageDeliveryEvidence(message),
    };
  });
}

module.exports = {
  COMMAND_NAME,
  DELIVERY_STATE,
  MESSAGE_TYPE,
  WORKFLOW_STATUS,
  WORKFLOW_TYPE,
  getProfessionalQuoteDelivery,
  sendQuoteInMeetro,
  quoteDeliveryInternals: Object.freeze({
    buildSafeSnapshot,
    deliveryProjection,
    hasSendAuthority,
    loadExistingQuoteDelivery,
    messageDeliveryEvidence,
    requestFingerprint,
    validIssuedQuote,
  }),
};
