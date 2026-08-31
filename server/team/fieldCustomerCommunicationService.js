"use strict";

const { createHash } = require("node:crypto");
const {
  advanceConversationParticipantReadStateWithClient,
  ensureConversationParticipantStatesWithClient,
} = require("../conversations/conversationParticipantStateService");
const {
  createOrRefreshCommunicationMessageAlert,
  getCommunicationAttentionWindowWithClient,
} = require("../alerts/communicationAlertService");
const { permissionForRole } = require("./teamService");

const MAX_CUSTOMER_MESSAGE_LENGTH = 5000;
const MAX_CUSTOMER_MESSAGE_HISTORY = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const READ_FIELDS = new Set(["businessId", "assignmentId"]);
const SEND_FIELDS = new Set([
  "businessId",
  "assignmentId",
  "message",
  "idempotencyKey",
]);
const UNSAFE_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function unsupportedFields(payload, supported) {
  if (!plainObject(payload)) return null;
  return Object.keys(payload).filter((field) => !supported.has(field));
}

function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= maximum &&
    !UNSAFE_TEXT_CONTROL_PATTERN.test(normalized)
    ? normalized
    : null;
}

function normalizeIdempotencyKey(value) {
  return boundedText(value, 200);
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateReadPayload(payload) {
  if (!plainObject(payload)) {
    return failure(400, "FIELD_CUSTOMER_CONVERSATION_REQUEST_INVALID", "Exact business and assignment identity are required.");
  }
  const unsupported = unsupportedFields(payload, READ_FIELDS);
  if (unsupported.length > 0) {
    return failure(400, "FIELD_CUSTOMER_CONVERSATION_FIELDS_UNSUPPORTED", "Customer Conversation authority is resolved by Meetro.");
  }
  const businessId = positiveInteger(payload.businessId);
  const assignmentId = uuid(payload.assignmentId);
  if (!businessId || !assignmentId) {
    return failure(400, "FIELD_CUSTOMER_CONVERSATION_REQUEST_INVALID", "Exact business and assignment identity are required.");
  }
  return { ok: true, businessId, assignmentId };
}

function validateSendPayload(payload) {
  if (!plainObject(payload)) {
    return failure(400, "FIELD_CUSTOMER_MESSAGE_REQUEST_INVALID", "Exact delegated customer message identity is required.");
  }
  const unsupported = unsupportedFields(payload, SEND_FIELDS);
  if (unsupported.length > 0) {
    return failure(400, "FIELD_CUSTOMER_MESSAGE_FIELDS_UNSUPPORTED", "Customer Conversation and canonical sender authority are resolved by Meetro.");
  }
  const businessId = positiveInteger(payload.businessId);
  const assignmentId = uuid(payload.assignmentId);
  const message = boundedText(payload.message, MAX_CUSTOMER_MESSAGE_LENGTH);
  const idempotencyKey = normalizeIdempotencyKey(payload.idempotencyKey);
  if (!businessId || !assignmentId || !message || !idempotencyKey) {
    return failure(400, "FIELD_CUSTOMER_MESSAGE_REQUEST_INVALID", "Exact delegated customer message identity is required.");
  }
  return { ok: true, businessId, assignmentId, message, idempotencyKey };
}

async function databaseClient(pool) {
  return typeof pool.connect === "function" ? pool.connect() : pool;
}

async function withTransaction(pool, action, { readOnly = false } = {}) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query(
      readOnly
        ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        : "BEGIN"
    );
    started = true;
    const result = await action(client);
    if (result?.ok === false) {
      await client.query("ROLLBACK");
      started = false;
      return result;
    }
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadActor(database, actorUserId, businessId) {
  const result = await database.query(
    `SELECT memberships.*, users.username
       FROM business_team_memberships memberships
       JOIN users ON users.id = memberships.user_id
      WHERE memberships.user_id = $1
        AND memberships.contractor_profile_id = $2
        AND memberships.status = 'ACTIVE'
      ORDER BY memberships.id ASC
      LIMIT 2`,
    [actorUserId, businessId]
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

async function loadExactAuthority(
  database,
  { businessId, jobId, assignmentId, lock = false }
) {
  const result = await database.query(
    `/* field_customer_communication:exact_authority */
     SELECT assignments.*,
            memberships.user_id AS member_user_id,
            memberships.role AS member_role,
            memberships.status AS member_status,
            jobs.source_request_selection_id,
            jobs.source_request_relationship_id,
            jobs.lifecycle_contract_version,
            relationships.status AS relationship_status,
            selections.ended_at AS selection_ended_at,
            conversations.id AS conversation_id,
            conversations.status AS conversation_status,
            conversations.homeowner_id,
            conversations.professional_user_id,
            conversations.contractor_id,
            customers.username AS customer_name,
            profiles.business_name
       FROM business_job_assignments assignments
       JOIN business_team_memberships memberships
         ON memberships.id = assignments.membership_id
        AND memberships.contractor_profile_id = assignments.contractor_profile_id
       JOIN jobs
         ON jobs.id = assignments.job_id
        AND jobs.lifecycle_contract_version = 2
       JOIN contractor_profiles profiles
         ON profiles.id = assignments.contractor_profile_id
       JOIN request_relationships relationships
         ON relationships.id = jobs.source_request_relationship_id
        AND relationships.post_id = jobs.job_request_id
        AND relationships.emergency_request_id IS NULL
        AND relationships.status = 'active'
        AND relationships.contractor_id = profiles.id
        AND relationships.professional_user_id = profiles.user_id
       JOIN request_selections selections
         ON selections.id = jobs.source_request_selection_id
        AND selections.request_relationship_id = relationships.id
        AND selections.post_id = jobs.job_request_id
        AND selections.selected_by_user_id = relationships.homeowner_id
        AND selections.contractor_id = profiles.id
        AND selections.professional_user_id = profiles.user_id
        AND selections.ended_at IS NULL
       JOIN conversations
         ON conversations.id = selections.conversation_id
        AND conversations.request_selection_id = selections.id
        AND conversations.relationship_id = relationships.id
        AND conversations.homeowner_id = relationships.homeowner_id
        AND conversations.contractor_id = profiles.id
        AND conversations.professional_user_id = profiles.user_id
       JOIN users customers ON customers.id = conversations.homeowner_id
      WHERE assignments.id = $1
        AND assignments.contractor_profile_id = $2
        AND assignments.job_id = $3
      ORDER BY conversations.id ASC
      LIMIT 2
      ${lock
        ? "FOR UPDATE OF assignments, memberships, jobs, relationships, selections, conversations"
        : ""}`,
    [assignmentId, businessId, jobId]
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

async function loadActivationVersion(database, assignmentId) {
  const result = await database.query(
    `SELECT assignment_version
       FROM business_job_assignment_events
      WHERE assignment_id = $1
        AND event_type IN ('ASSIGNED', 'REASSIGNED')
      ORDER BY assignment_version DESC
      LIMIT 2`,
    [assignmentId]
  );
  if (result.rows.length === 0) return null;
  return positiveInteger(result.rows[0].assignment_version);
}

function authorityFailure(actor, authority) {
  if (!actor || actor.status !== "ACTIVE" || actor.role !== "FIELD_EMPLOYEE") {
    return failure(403, "FIELD_CUSTOMER_COMMUNICATION_PERMISSION_REQUIRED", "Only an active Field Employee may use delegated customer messaging.");
  }
  if (!authority) {
    return failure(404, "FIELD_CUSTOMER_CONVERSATION_NOT_FOUND", "The exact assigned Job customer Conversation was not found.");
  }
  if (
    authority.state !== "ACTIVE" ||
    authority.member_status !== "ACTIVE" ||
    authority.member_role !== "FIELD_EMPLOYEE" ||
    authority.membership_id !== actor.id ||
    Number(authority.member_user_id) !== Number(actor.user_id) ||
    Number(authority.contractor_profile_id) !== Number(actor.contractor_profile_id) ||
    Number(authority.contractor_id) !== Number(actor.contractor_profile_id) ||
    authority.relationship_status !== "active" ||
    authority.selection_ended_at != null ||
    Number(authority.lifecycle_contract_version) !== 2
  ) {
    return failure(403, "FIELD_CUSTOMER_ASSIGNMENT_REQUIRED", "Only the exact actively assigned Field Employee may access this customer Conversation.");
  }
  return null;
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeCustomerMessage(row, authority) {
  const customerMessage = Number(row.sender_id) === Number(authority.homeowner_id);
  const delegated = !customerMessage && Boolean(row.delegated_membership_id);
  return {
    id: Number(row.id),
    direction: customerMessage ? "CUSTOMER" : "BUSINESS",
    text: row.message_text,
    createdAt: iso(row.created_at),
    author: delegated
      ? {
          type: "FIELD_EMPLOYEE",
          displayName: row.delegated_employee_name || "Field Employee",
          role: "FIELD_EMPLOYEE",
        }
      : customerMessage
        ? { type: "CUSTOMER", displayName: authority.customer_name || "Customer" }
        : { type: "BUSINESS", displayName: authority.business_name || "Business" },
  };
}

async function loadSafeProjection(database, authority) {
  const result = await database.query(
    `/* field_customer_communication:safe_text_projection */
     SELECT messages.id, messages.sender_id, messages.message_text,
            messages.created_at,
            commands.membership_id AS delegated_membership_id,
            delegated_users.username AS delegated_employee_name
       FROM messages
       LEFT JOIN business_job_customer_message_commands commands
         ON commands.result_message_id = messages.id
        AND commands.completed_at IS NOT NULL
       LEFT JOIN business_team_memberships delegated_memberships
         ON delegated_memberships.id = commands.membership_id
        AND delegated_memberships.contractor_profile_id = commands.contractor_profile_id
       LEFT JOIN users delegated_users
         ON delegated_users.id = commands.actor_user_id
        AND delegated_users.id = delegated_memberships.user_id
      WHERE messages.conversation_id = $1
        AND messages.quote_request_id IS NULL
        AND messages.sender_id IN ($2, $3)
        AND messages.receiver_id IN ($2, $3)
        AND messages.sender_id <> messages.receiver_id
        AND messages.message_type = 'text'
        AND NULLIF(btrim(messages.message_text), '') IS NOT NULL
        AND messages.image_url IS NULL
        AND messages.workflow_type IS NULL
        AND messages.workflow_status IS NULL
        AND COALESCE(messages.workflow_payload, '{}'::jsonb) = '{}'::jsonb
        AND messages.quote_id IS NULL
        AND messages.invoice_id IS NULL
        AND messages.job_id IS NULL
        AND messages.delivery_idempotency_key IS NULL
        AND messages.delivery_request_fingerprint IS NULL
        AND messages.invoice_delivery_idempotency_key IS NULL
        AND messages.invoice_delivery_request_fingerprint IS NULL
      ORDER BY messages.created_at ASC NULLS LAST, messages.id ASC
      LIMIT ${MAX_CUSTOMER_MESSAGE_HISTORY}`,
    [authority.conversation_id, authority.homeowner_id, authority.professional_user_id]
  );
  return {
    conversationId: Number(authority.conversation_id),
    jobId: authority.job_id,
    customer: { displayName: authority.customer_name || "Customer" },
    messages: result.rows.map((row) => serializeCustomerMessage(row, authority)),
  };
}

async function resolveAuthorizedContext({
  database,
  actorUserId,
  businessId,
  jobId,
  assignmentId,
  lock = false,
}) {
  const actor = await loadActor(database, actorUserId, businessId);
  if (!actor || !permissionForRole(actor.role, "FIELD_CUSTOMER_COMMUNICATION")) {
    return { error: authorityFailure(actor, null) };
  }
  const authority = await loadExactAuthority(database, {
    businessId,
    jobId,
    assignmentId,
    lock,
  });
  const error = authorityFailure(actor, authority);
  if (error) return { error };
  const activationVersion = await loadActivationVersion(database, assignmentId);
  if (!activationVersion) {
    return { error: failure(409, "FIELD_CUSTOMER_ASSIGNMENT_EVIDENCE_REQUIRED", "Current assignment activation evidence is required.") };
  }
  return { actor, authority, activationVersion };
}

async function getFieldCustomerConversation({
  pool,
  authenticatedActor,
  jobId,
  payload,
}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const normalizedJobId = uuid(jobId);
  if (!pool || !actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  const validation = validateReadPayload(payload);
  if (!validation.ok) return validation;
  if (!normalizedJobId) return failure(400, "FIELD_CUSTOMER_JOB_INVALID", "Exact Job identity is required.");
  return withTransaction(pool, async (client) => {
    const context = await resolveAuthorizedContext({
      database: client,
      actorUserId,
      businessId: validation.businessId,
      jobId: normalizedJobId,
      assignmentId: validation.assignmentId,
    });
    if (context.error) return context.error;
    return {
      ok: true,
      status: 200,
      code: "FIELD_CUSTOMER_CONVERSATION_LOADED",
      conversation: await loadSafeProjection(client, context.authority),
    };
  }, { readOnly: true });
}

async function reserveCommand(database, {
  actor,
  authority,
  activationVersion,
  idempotencyKey,
  requestFingerprint,
}) {
  let result = await database.query(
    `SELECT * FROM business_job_customer_message_commands
      WHERE membership_id = $1 AND assignment_id = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [actor.id, authority.id, idempotencyKey]
  );
  if (result.rows[0]) return { command: result.rows[0], created: false };

  result = await database.query(
    `INSERT INTO business_job_customer_message_commands
       (contractor_profile_id, job_id, assignment_id, membership_id,
        assignment_activation_version, actor_user_id, idempotency_key,
        request_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (membership_id, assignment_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      authority.contractor_profile_id,
      authority.job_id,
      authority.id,
      actor.id,
      activationVersion,
      actor.user_id,
      idempotencyKey,
      requestFingerprint,
    ]
  );
  if (result.rows[0]) return { command: result.rows[0], created: true };

  result = await database.query(
    `SELECT * FROM business_job_customer_message_commands
      WHERE membership_id = $1 AND assignment_id = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [actor.id, authority.id, idempotencyKey]
  );
  if (!result.rows[0]) throw new Error("Delegated customer message command reservation was not returned.");
  return { command: result.rows[0], created: false };
}

async function sendFieldCustomerMessage({
  pool,
  authenticatedActor,
  jobId,
  payload,
}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const normalizedJobId = uuid(jobId);
  if (!pool || !actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  const validation = validateSendPayload(payload);
  if (!validation.ok) return validation;
  if (!normalizedJobId) return failure(400, "FIELD_CUSTOMER_JOB_INVALID", "Exact Job identity is required.");

  return withTransaction(pool, async (client) => {
    const context = await resolveAuthorizedContext({
      database: client,
      actorUserId,
      businessId: validation.businessId,
      jobId: normalizedJobId,
      assignmentId: validation.assignmentId,
      lock: true,
    });
    if (context.error) return context.error;

    const requestFingerprint = fingerprint({
      businessId: validation.businessId,
      jobId: normalizedJobId,
      assignmentId: validation.assignmentId,
      assignmentActivationVersion: context.activationVersion,
      message: validation.message,
    });
    const reserved = await reserveCommand(client, {
      ...context,
      idempotencyKey: validation.idempotencyKey,
      requestFingerprint,
    });
    const command = reserved.command;
    if (command.request_fingerprint !== requestFingerprint) {
      return failure(409, "FIELD_CUSTOMER_MESSAGE_IDEMPOTENCY_CONFLICT", "The idempotency key is bound to a different delegated customer message.");
    }
    if (!reserved.created) {
      if (!command.completed_at || !positiveInteger(command.result_message_id)) {
        return failure(409, "FIELD_CUSTOMER_MESSAGE_COMMAND_IN_PROGRESS", "The delegated customer message command is still in progress.");
      }
      const conversation = await loadSafeProjection(client, context.authority);
      return {
        ok: true,
        status: 200,
        code: "FIELD_CUSTOMER_MESSAGE_SENT",
        replayed: true,
        message: conversation.messages.find((item) => item.id === Number(command.result_message_id)) || null,
        conversation,
      };
    }

    if (context.authority.conversation_status !== "active") {
      return failure(409, "FIELD_CUSTOMER_CONVERSATION_CLOSED", "Messages cannot be sent to a closed customer Conversation.");
    }

    await ensureConversationParticipantStatesWithClient({
      client,
      conversationId: context.authority.conversation_id,
    });
    const recipientAttention = await getCommunicationAttentionWindowWithClient({
      client,
      conversationId: context.authority.conversation_id,
      recipientUserId: context.authority.homeowner_id,
    });
    const inserted = await client.query(
      `/* field_customer_communication:delegated_canonical_text */
       INSERT INTO messages
         (quote_request_id, conversation_id, sender_id, receiver_id,
          message_text, image_url, message_type, workflow_type,
          workflow_status, workflow_payload)
       VALUES (NULL, $1, $2, $3, $4, NULL, 'text', NULL, NULL, '{}'::jsonb)
       RETURNING id, conversation_id, sender_id, receiver_id, message_text,
                 image_url, message_type, workflow_type, workflow_status,
                 workflow_payload, created_at`,
      [
        context.authority.conversation_id,
        context.authority.professional_user_id,
        context.authority.homeowner_id,
        validation.message,
      ]
    );
    const message = inserted.rows[0];
    if (!message) throw new Error("Delegated canonical customer message was not returned.");

    await advanceConversationParticipantReadStateWithClient({
      client,
      conversation: {
        id: context.authority.conversation_id,
        homeowner_id: context.authority.homeowner_id,
        professional_user_id: context.authority.professional_user_id,
      },
      participantUserId: context.authority.professional_user_id,
      lastReadMessageId: message.id,
      lastReadAt: message.created_at || null,
    });
    const activity = await client.query(
      "UPDATE conversations SET updated_at = COALESCE($2, CURRENT_TIMESTAMP) WHERE id = $1",
      [context.authority.conversation_id, message.created_at || null]
    );
    if (activity.rowCount !== 1) throw new Error("Canonical Conversation activity could not be updated.");

    await createOrRefreshCommunicationMessageAlert({
      client,
      conversation: {
        id: context.authority.conversation_id,
        homeowner_id: context.authority.homeowner_id,
        professional_user_id: context.authority.professional_user_id,
      },
      senderUserId: context.authority.professional_user_id,
      recipientUserId: context.authority.homeowner_id,
      recipientLastReadMessageId: recipientAttention.lastReadMessageId,
      message,
    });
    const completed = await client.query(
      `UPDATE business_job_customer_message_commands
          SET result_message_id = $2, completed_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND result_message_id IS NULL AND completed_at IS NULL
        RETURNING *`,
      [command.id, message.id]
    );
    if (completed.rows.length !== 1) throw new Error("Delegated customer message provenance could not be completed.");

    const conversation = await loadSafeProjection(client, context.authority);
    return {
      ok: true,
      status: 201,
      code: "FIELD_CUSTOMER_MESSAGE_SENT",
      replayed: false,
      message: conversation.messages.find((item) => item.id === Number(message.id)) || serializeCustomerMessage({
        ...message,
        delegated_membership_id: actor.id,
        delegated_employee_name: actor.username,
      }, context.authority),
      conversation,
    };
  });
}

module.exports = {
  MAX_CUSTOMER_MESSAGE_HISTORY,
  MAX_CUSTOMER_MESSAGE_LENGTH,
  fingerprint,
  getFieldCustomerConversation,
  normalizeIdempotencyKey,
  sendFieldCustomerMessage,
  serializeCustomerMessage,
  validateReadPayload,
  validateSendPayload,
};
