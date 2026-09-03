"use strict";

const {
  quoteDeliveryRequestFingerprint,
} = require("../authorization/quoteDeliveryAuthority");

const CONVERSATION_STATUSES = Object.freeze({
  ACTIVE: "active",
  CLOSED: "closed",
});

const CONVERSATION_STATUS_VALUES = Object.freeze(
  Object.values(CONVERSATION_STATUSES)
);

const EMERGENCY_ACTION_BY_STATUS = Object.freeze({
  assigned: "mark_en_route",
  professional_en_route: "mark_arrived",
  professional_arrived: "start_work",
  work_in_progress: "complete_work",
});

function isValidPositiveInteger(value) {
  const normalized = String(value ?? "").trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    return false;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function parsePositiveInteger(value) {
  return isValidPositiveInteger(value)
    ? Number(value)
    : null;
}

function validateConversationStatus(status) {
  return CONVERSATION_STATUS_VALUES.includes(status);
}

function isConversationParticipant(conversation = {}, userId) {
  return (
    String(conversation.homeowner_id) === String(userId) ||
    String(conversation.professional_user_id) === String(userId)
  );
}

function participantArchiveField(conversation = {}, userId) {
  if (String(conversation.homeowner_id) === String(userId)) {
    return "homeowner_archived_at";
  }

  if (
    String(conversation.professional_user_id) === String(userId)
  ) {
    return "professional_archived_at";
  }

  return null;
}

function canArchiveConversation(conversation = {}, userId) {
  const field = participantArchiveField(conversation, userId);

  return Boolean(
    conversation.status === CONVERSATION_STATUSES.ACTIVE &&
      field &&
      !conversation[field]
  );
}

function canRestoreConversation(conversation = {}, userId) {
  const field = participantArchiveField(conversation, userId);

  return Boolean(
    conversation.status === CONVERSATION_STATUSES.ACTIVE &&
      field &&
      conversation[field]
  );
}

function canCloseConversation(conversation = {}, userId) {
  return Boolean(
    conversation.status === CONVERSATION_STATUSES.ACTIVE &&
      isConversationParticipant(conversation, userId)
  );
}

function hasExactlyOneConversationSource(row = {}) {
  const hasRequest =
    parsePositiveInteger(row.post_id) !== null;
  const hasEmergency =
    parsePositiveInteger(row.emergency_request_id) !== null;

  return hasRequest !== hasEmergency;
}

function getConversationSource(row = {}) {
  if (!hasExactlyOneConversationSource(row)) {
    throw new TypeError(
      "The conversation relationship source is invalid."
    );
  }

  const emergencyId = parsePositiveInteger(
    row.emergency_request_id
  );

  if (emergencyId) {
    return {
      type: "emergency",
      id: emergencyId,
      title: row.request_title || "",
      serviceDomain: row.source_service_domain || "",
      serviceSpecialty: row.source_service_specialty || "",
      isEmergency: true,
    };
  }

  const requestId = parsePositiveInteger(row.post_id);

  return {
    type: "request",
    id: requestId,
    title: row.request_title || "",
    serviceDomain: row.source_service_domain || "",
    serviceSpecialty: row.source_service_specialty || "",
    isEmergency: false,
  };
}

function deriveEmergencyWorkflow({
  row = {},
  viewerRole,
} = {}) {
  const isAuthorizedEmergency =
    parsePositiveInteger(row.emergency_request_id) !== null &&
    row.source_relationship_status === "active";
  const canManage =
    isAuthorizedEmergency &&
    viewerRole === "professional" &&
    row.status === CONVERSATION_STATUSES.ACTIVE;
  const action = canManage
    ? EMERGENCY_ACTION_BY_STATUS[
        row.source_workflow_status
      ] || null
    : null;
  const allowedActions = action ? [action] : [];

  return {
    workflow: {
      status: row.source_workflow_status || null,
      assignedAt: row.source_assigned_at || null,
      enRouteAt: row.source_en_route_at || null,
      arrivedAt: row.source_arrived_at || null,
      workStartedAt:
        row.source_work_started_at || null,
      completedAt: row.source_completed_at || null,
      allowedActions,
    },
    permissions: {
      canSendMessages:
        row.status === CONVERSATION_STATUSES.ACTIVE,
      canManageWorkflow: allowedActions.length > 0,
      canMarkEnRoute:
        action === "mark_en_route",
      canMarkArrived:
        action === "mark_arrived",
      canStartWork:
        action === "start_work",
      canCompleteWork:
        action === "complete_work",
    },
  };
}

function requireActiveEmergencyRelationship(row = {}) {
  if (row.source_relationship_status !== "active") {
    throw new TypeError(
      "An active Emergency relationship is required."
    );
  }
}

function serializeConversationForHomeowner(row = {}) {
  return {
    id: row.id,
    relationship_id: row.relationship_id,
    contractor_id: row.contractor_id,
    business_name: row.business_name || "",
    business_image_url: row.business_image_url || "",
    professional_category: row.professional_category || "",
    status: row.status,
    archived: Boolean(row.homeowner_archived_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  };
}

function serializeConversationForProfessional(row = {}) {
  const value = {
    id: row.id,
    relationship_id: row.relationship_id,
    request_id: row.post_id,
    request_title: row.request_title || "",
    homeowner_display_name: row.homeowner_display_name || "",
    status: row.status,
    archived: Boolean(row.professional_archived_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  };

  if (parsePositiveInteger(row.emergency_request_id)) {
    delete value.request_id;
    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = getConversationSource(row);
  }

  return value;
}

function serializeConversationSummaryForHomeowner(row = {}) {
  const conversationId = parsePositiveInteger(row.id);
  const requestId = parsePositiveInteger(row.post_id);
  const source = getConversationSource(row);

  const value = {
    id: conversationId,
    conversation_id: conversationId,
    request_id: requestId,
    request_title: row.request_title || "",
    relationship: {
      title: row.request_title || "",
      stage: "conversation",
    },
    display: {
      name: row.business_name || "",
      image_url: row.business_image_url || "",
      category: row.professional_category || "",
    },
    status: {
      value: row.status,
      active: row.status === CONVERSATION_STATUSES.ACTIVE,
      archived: Boolean(row.homeowner_archived_at),
      requires_attention: false,
    },
    last_activity: row.updated_at || row.created_at || null,
    last_message_preview:
      typeof row.last_message_preview === "string"
        ? row.last_message_preview
        : null,
    unread_count: Math.max(
      0,
      Number.parseInt(row.unread_count, 10) || 0
    ),
    conversation_available: Boolean(conversationId),
    permissions: {
      canSendMessages:
        row.status === CONVERSATION_STATUSES.ACTIVE,
    },
  };

  if (source.type === "emergency") {
    requireActiveEmergencyRelationship(row);
    const emergency = deriveEmergencyWorkflow({
      row,
      viewerRole: "homeowner",
    });

    value.request_id = null;
    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = source;
    value.viewer = {
      role: "homeowner",
    };
    value.workflow = emergency.workflow;
    value.permissions = emergency.permissions;
  }

  return value;
}

function serializeConversationSummaryForProfessional(row = {}) {
  const source = getConversationSource(row);
  const value = {
    id: row.id,
    relationship: {
      id: row.relationship_id,
      title: row.request_title || "",
      stage: "conversation",
    },
    display: {
      name: row.homeowner_display_name || "Customer",
      image_url: "",
      category: "",
    },
    status: {
      value: row.status,
      active: row.status === CONVERSATION_STATUSES.ACTIVE,
      archived: Boolean(row.professional_archived_at),
      requires_attention: false,
    },
    last_activity: row.updated_at || row.created_at || null,
    last_message_preview:
      typeof row.last_message_preview === "string"
        ? row.last_message_preview
        : null,
    unread_count: Math.max(
      0,
      Number.parseInt(row.unread_count, 10) || 0
    ),
    conversation_available:
      row.status === CONVERSATION_STATUSES.ACTIVE,
  };

  if (source.type === "emergency") {
    requireActiveEmergencyRelationship(row);
    const emergency = deriveEmergencyWorkflow({
      row,
      viewerRole: "professional",
    });

    value.emergency_request_id = parsePositiveInteger(
      row.emergency_request_id
    );
    value.source = source;
    value.viewer = {
      role: "professional",
    };
    value.workflow = emergency.workflow;
    value.permissions = emergency.permissions;
  }

  return value;
}

function normalizeMessageWorkflowPayload(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function canonicalQuoteDecisionForMessage(row = {}) {
  const decision = ["APPROVED", "DECLINED"].includes(row.canonical_quote_decision)
    ? row.canonical_quote_decision
    : null;
  const decisionVersion = Number(row.canonical_quote_decision_version);
  const currentVersion = Number(row.canonical_quote_current_version);
  if (
    !decision ||
    !Number.isSafeInteger(decisionVersion) ||
    decisionVersion < 1 ||
    decisionVersion !== currentVersion ||
    Number(row.canonical_quote_customer_user_id) !== Number(row.receiver_id) ||
    row.delivery_request_fingerprint !== quoteDeliveryRequestFingerprint({
      actorId: Number(row.sender_id),
      quoteId: row.quote_id,
      expectedIssuedVersion: decisionVersion,
    })
  ) return null;
  const decidedAt = new Date(row.canonical_quote_decided_at);
  if (Number.isNaN(decidedAt.getTime())) return null;
  return { decision, decidedAt: decidedAt.toISOString(), version: decisionVersion };
}

function normalizeQuoteSharedPayload(row = {}) {
  const payload = normalizeMessageWorkflowPayload(row.workflow_payload);
  if (
    row.message_type !== "quote_shared" ||
    row.workflow_type !== "QUOTE_SHARED" ||
    row.workflow_status !== "SENT" ||
    payload.schemaVersion !== 1 ||
    payload.quoteId !== row.quote_id ||
    payload.jobId !== row.job_id
  ) return {};

  const text = (value, max = 1000) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : null;
  const integer = (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const scopeItems = Array.isArray(payload.scopeItems)
    ? payload.scopeItems.slice(0, 200).map((item) => ({
        description: text(item?.description),
        quantity: integer(item?.quantity),
        amountMinor: integer(item?.amountMinor),
      })).filter((item) => item.description && item.quantity && item.amountMinor !== null)
    : [];
  const conditions = Array.isArray(payload.conditions)
    ? payload.conditions.slice(0, 200).map((item) => text(item)).filter(Boolean)
    : [];
  const exclusions = Array.isArray(payload.exclusions)
    ? payload.exclusions.slice(0, 200).map((item) => ({
        description: text(item?.description),
        quantity: integer(item?.quantity),
      })).filter((item) => item.description && item.quantity)
    : [];
  const totalMinor = integer(payload.totalMinor);
  const currency = typeof payload.currency === "string" && /^[A-Z]{3}$/.test(payload.currency)
    ? payload.currency
    : null;
  const lineageLabel = ["Original", "Revised", "Additional"].includes(payload.lineageLabel)
    ? payload.lineageLabel
    : null;
  const persistedBusinessStatus = ["WAITING_ON_CUSTOMER", "APPROVED", "DECLINED"].includes(payload.businessStatus)
    ? payload.businessStatus
    : null;
  const canonicalDecision = canonicalQuoteDecisionForMessage(row);
  const businessStatus = canonicalDecision?.decision || persistedBusinessStatus;
  if (totalMinor === null || !currency || !lineageLabel || !businessStatus) return {};

  return {
    schemaVersion: 1,
    quoteId: row.quote_id,
    jobId: row.job_id,
    quoteNumber: text(row.canonical_quote_number, 80) || "Quote",
    lineageLabel,
    businessStatus,
    totalMinor,
    currency,
    scopeItems,
    conditions,
    exclusions,
    issuedAt: text(payload.issuedAt, 80),
    decidedAt: canonicalDecision?.decidedAt || text(payload.decidedAt, 80),
    business: {
      displayName: text(payload.business?.displayName, 200) || "Professional",
    },
    job: {
      title: text(payload.job?.title, 200) || "Job",
      service: text(payload.job?.service, 120),
    },
  };
}

function normalizeInvoiceSharedPayload(row = {}) {
  const payload = normalizeMessageWorkflowPayload(row.workflow_payload);
  const text = (value, max = 1000) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : null;
  const integer = (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const dueMode = ["DUE_ON_RECEIPT", "SPECIFIC_DATE"].includes(payload.due?.mode)
    ? payload.due.mode
    : null;
  const totalMinor = integer(payload.totalMinor);
  const balanceMinor = integer(payload.balanceMinor);
  const paidMinor = payload.paidMinor == null && totalMinor !== null && balanceMinor !== null
    ? totalMinor - balanceMinor
    : integer(payload.paidMinor);
  const currency = typeof payload.currency === "string" && /^[A-Z]{3}$/.test(payload.currency)
    ? payload.currency
    : null;
  if (
    row.message_type !== "invoice_shared" ||
    row.workflow_type !== "INVOICE_SHARED" ||
    row.workflow_status !== "SENT" ||
    payload.schemaVersion !== 1 ||
    payload.invoiceId !== row.invoice_id ||
    payload.jobId !== row.job_id ||
    !text(payload.invoiceNumber, 40) ||
    !["SENT", "PARTIALLY_PAID", "PAID"].includes(payload.status) ||
    totalMinor === null || paidMinor === null || paidMinor < 0 || balanceMinor === null ||
    totalMinor !== paidMinor + balanceMinor ||
    !currency || !dueMode
  ) return {};

  return {
    schemaVersion: 1,
    invoiceId: row.invoice_id,
    invoiceNumber: text(payload.invoiceNumber, 40),
    jobId: row.job_id,
    status: payload.status,
    totalMinor,
    paidMinor,
    balanceMinor,
    currency,
    due: {
      mode: dueMode,
      date: dueMode === "SPECIFIC_DATE" ? text(payload.due?.date, 10) : null,
    },
    business: {
      displayName: text(payload.business?.displayName, 200) || "Professional",
    },
    job: {
      title: text(payload.job?.title, 200) || "Job",
      service: text(payload.job?.service, 120),
    },
    issuedAt: text(payload.issuedAt, 80),
    terms: text(payload.terms, 2000),
  };
}

function normalizePaymentLifecyclePayload(row = {}) {
  const payload = normalizeMessageWorkflowPayload(row.workflow_payload);
  const expected = row.message_type === "payment_request"
    ? { workflowType: "PAYMENT_REQUEST", states: ["PAYMENT_REQUIRED"] }
    : row.message_type === "payment_received"
      ? { workflowType: "PAYMENT_RECEIVED", states: ["PARTIALLY_RECEIVED", "DEPOSIT_RECEIVED"] }
      : null;
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = (value, max = 2000) => typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
  const payment = payload.payment == null ? null : {
    receiptId: text(payload.payment?.receiptId, 80),
    grossAmountMinor: integer(payload.payment?.grossAmountMinor),
    allocatedMinor: integer(payload.payment?.allocatedMinor),
    displayMethod: text(payload.payment?.displayMethod, 160),
    receivedAt: text(payload.payment?.receivedAt, 80),
    externalReference: text(payload.payment?.externalReference, 300),
  };
  const quoteTotalMinor = integer(payload.quoteTotalMinor);
  const requiredMinor = integer(payload.requiredMinor);
  const receivedMinor = integer(payload.receivedMinor);
  const remainingMinor = integer(payload.remainingMinor);
  const balanceRemainingMinor = integer(payload.balanceRemainingMinor);
  const uuid = (value) => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
  const quoteId = uuid(payload.quoteId);
  const jobId = uuid(payload.jobId);
  const depositRequestDocumentId = uuid(payload.depositRequestDocumentId);
  const paymentRequirementId = uuid(payload.paymentRequirementId);
  const depositRequestReference = text(payload.depositRequestReference, 40);
  const depositRequestBindingPresent = [
    payload.depositRequestDocumentId,
    payload.paymentRequirementId,
    payload.depositRequestReference,
  ].some((value) => value != null);
  const validDepositRequestBinding = !depositRequestBindingPresent || (
    row.message_type === "payment_request" && depositRequestDocumentId &&
    paymentRequirementId && /^WDR-[A-Z0-9]{8}$/.test(depositRequestReference || "")
  );
  if (!expected || row.workflow_type !== expected.workflowType || row.workflow_status !== "SENT" ||
      payload.schemaVersion !== 1 || !quoteId || !jobId ||
      !Number.isSafeInteger(payload.issuedQuoteVersion) || payload.issuedQuoteVersion < 1 ||
      !expected.states.includes(payload.state) || !/^[A-Z]{3}$/.test(payload.currency || "") ||
      [quoteTotalMinor, requiredMinor, receivedMinor, remainingMinor, balanceRemainingMinor].includes(null) ||
      receivedMinor + remainingMinor !== requiredMinor ||
      (row.message_type === "payment_request" && balanceRemainingMinor !== quoteTotalMinor - requiredMinor) ||
      (row.message_type === "payment_received" && balanceRemainingMinor !== quoteTotalMinor - receivedMinor) ||
      (row.message_type === "payment_request" && payment !== null) ||
      !validDepositRequestBinding ||
      (row.message_type === "payment_received" && (!payment?.receiptId || !payment.displayMethod || !payment.receivedAt))) {
    return {};
  }
  return {
    schemaVersion: 1,
    quoteId,
    jobId,
    issuedQuoteVersion: payload.issuedQuoteVersion,
    state: payload.state,
    currency: payload.currency,
    quoteTotalMinor,
    requiredMinor,
    receivedMinor,
    remainingMinor,
    balanceRemainingMinor,
    paymentTerms: text(payload.paymentTerms),
    payment,
    ...(depositRequestBindingPresent ? {
      depositRequestDocumentId,
      depositRequestReference,
      paymentRequirementId,
    } : {}),
  };
}


function normalizePaymentReminderPayload(row = {}) {
  const payload =
    normalizeMessageWorkflowPayload(row.workflow_payload);

  if (
    row.message_type !== "payment_reminder" ||
    row.workflow_type !== "PAYMENT_REMINDER" ||
    row.workflow_status !== "SENT" ||
    payload.schemaVersion !== 1
  ) {
    return {};
  }

  const uuid = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value.toLowerCase()
      : null;

  const integer = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0
      ? parsed
      : null;
  };

  const date = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : null;

  const reminderId = uuid(payload.reminderId);
  const jobId = uuid(payload.jobId);
  const invoiceId = uuid(payload.invoiceId);
  const paymentRequirementId =
    uuid(payload.paymentRequirementId);

  const sourceType = payload.sourceType;
  const sourceVersion = integer(payload.sourceVersion);
  const amountMinor = integer(payload.amountMinor);
  const classifiedOn = date(payload.classifiedOn);

  let reminderTimeZone = null;

  try {
    const submitted =
      typeof payload.timeZone === "string"
        ? payload.timeZone.trim()
        : "";

    if (
      submitted.includes("/") &&
      submitted.length >= 3 &&
      submitted.length <= 100
    ) {
      reminderTimeZone =
        new Intl.DateTimeFormat(
          "en-US",
          {
            timeZone:
              submitted,
          }
        )
          .resolvedOptions()
          .timeZone ||
        submitted;
    }
  } catch {
    reminderTimeZone =
      null;
  }

  const currency =
    typeof payload.currency === "string" &&
    /^[A-Z]{3}$/.test(payload.currency)
      ? payload.currency
      : null;

  const invoiceClassifications =
    new Set(["UPCOMING_DUE", "DUE_TODAY", "OVERDUE"]);

  const depositClassifications =
    new Set(["DEPOSIT_DUE", "DEPOSIT_REMAINING"]);

  let due = null;

  if (sourceType === "INVOICE") {
    const mode = payload.due?.mode;
    const dueDate =
      payload.due?.date == null
        ? null
        : date(payload.due.date);
    const effectiveDate =
      date(payload.due?.effectiveDate);

    if (
      !invoiceId ||
      paymentRequirementId ||
      !invoiceClassifications.has(payload.classification) ||
      !["DUE_ON_RECEIPT", "SPECIFIC_DATE"].includes(mode) ||
      !effectiveDate ||
      (
        mode === "DUE_ON_RECEIPT" &&
        payload.due?.date != null
      ) ||
      (
        mode === "SPECIFIC_DATE" &&
        (!dueDate || dueDate !== effectiveDate)
      )
    ) {
      return {};
    }

    due = {
      mode,
      date: dueDate,
      effectiveDate,
    };
  } else if (sourceType === "DEPOSIT") {
    if (
      invoiceId ||
      !paymentRequirementId ||
      !depositClassifications.has(payload.classification) ||
      payload.due != null
    ) {
      return {};
    }
  } else {
    return {};
  }

  if (
    !reminderId ||
    !jobId ||
    sourceVersion == null ||
    sourceVersion < 1 ||
    amountMinor == null ||
    amountMinor < 1 ||
    !classifiedOn ||
    !reminderTimeZone ||
    payload.timeZone !== reminderTimeZone ||
    !currency
  ) {
    return {};
  }

  return {
    schemaVersion: 1,
    reminderId,
    sourceType,
    invoiceId: sourceType === "INVOICE" ? invoiceId : null,
    paymentRequirementId:
      sourceType === "DEPOSIT"
        ? paymentRequirementId
        : null,
    jobId,
    sourceVersion,
    classification: payload.classification,
    classifiedOn,
    timeZone: reminderTimeZone,
    currency,
    amountMinor,
    due,
  };
}

function serializeConversationMessage(row = {}, viewerUserId) {
  const quoteShared = row.message_type === "quote_shared";
  const invoiceShared = row.message_type === "invoice_shared";
  const paymentLifecycle = ["payment_request", "payment_received"].includes(row.message_type);
  const paymentReminder = row.message_type === "payment_reminder";
  const value = {
    id: row.id,
    sender: {
      id: row.sender_id,
      isViewer:
        String(row.sender_id) === String(viewerUserId),
    },
    recipient: {
      id: row.receiver_id ?? null,
    },
    content: {
      text: row.message_text || "",
      imageUrl: row.image_url || null,
      type: row.message_type || "text",
    },
    workflow: {
      type: row.workflow_type || null,
      status: row.workflow_status || null,
      payload: quoteShared
        ? normalizeQuoteSharedPayload(row)
        : invoiceShared
          ? normalizeInvoiceSharedPayload(row)
          : paymentLifecycle
            ? normalizePaymentLifecyclePayload(row)
            : paymentReminder
              ? normalizePaymentReminderPayload(row)
              : normalizeMessageWorkflowPayload(row.workflow_payload),
    },
    createdAt: row.created_at || null,
  };
  const delegatedDisplayName =
    typeof row.delegated_author_display_name === "string"
      ? row.delegated_author_display_name.trim()
      : "";
  if (
    row.delegated_author_type === "FIELD_EMPLOYEE" &&
    row.delegated_author_role === "FIELD_EMPLOYEE" &&
    delegatedDisplayName
  ) {
    value.delegatedAuthor = {
      type: "FIELD_EMPLOYEE",
      displayName: delegatedDisplayName,
      role: "FIELD_EMPLOYEE",
    };
  }
  if (quoteShared) {
    value.reference = {
      type: "quote",
      quoteId: row.quote_id || null,
      jobId: row.job_id || null,
    };
  }
  if (invoiceShared) {
    value.reference = {
      type: "invoice",
      invoiceId: row.invoice_id || null,
      jobId: row.job_id || null,
    };
  }
  if (paymentLifecycle) {
    value.reference = {
      type: "payment",
      quoteId: value.workflow.payload.quoteId || null,
      jobId: value.workflow.payload.jobId || null,
    };
  }
  if (paymentReminder) {
    value.reference = {
      type: "payment_reminder",
      sourceType: value.workflow.payload.sourceType || null,
      invoiceId: value.workflow.payload.invoiceId || null,
      paymentRequirementId:
        value.workflow.payload.paymentRequirementId || null,
      jobId: value.workflow.payload.jobId || null,
    };
  }
  return value;
}

function serializeConversationDetail(row = {}, viewerUserId) {
  const viewerIsHomeowner =
    String(row.homeowner_id) === String(viewerUserId);
  const viewerIsProfessional =
    String(row.professional_user_id) === String(viewerUserId);

  if (!viewerIsHomeowner && !viewerIsProfessional) {
    throw new TypeError(
      "The conversation viewer must be an authorized participant."
    );
  }

  const source = getConversationSource(row);
  const viewerRole = viewerIsHomeowner
    ? "homeowner"
    : "professional";

  if (source.type === "emergency") {
    requireActiveEmergencyRelationship(row);
  }

  const emergency =
    source.type === "emergency"
      ? deriveEmergencyWorkflow({
          row,
          viewerRole,
        })
      : null;
  const relationship =
    source.type === "emergency"
      ? {
          id: row.relationship_id,
          emergencyRequestId: source.id,
          title: source.title,
          source,
        }
      : {
          id: row.relationship_id,
          requestId: row.post_id,
          ...(row.job_id ? { jobId: row.job_id } : {}),
          title: row.request_title || "",
        };

  const value = {
    conversation: {
      id: row.id,
      type: source.type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at || null,
    },
    participants: {
      viewer: {
        id: viewerUserId,
        role: viewerRole,
      },
      homeowner: {
        id: row.homeowner_id,
        displayName:
          row.homeowner_display_name || "Customer",
      },
      business: {
        id: row.contractor_id,
        userId: row.professional_user_id,
        name: row.business_name || "",
        imageUrl: row.business_image_url || "",
        category: row.professional_category || "",
      },
    },
    relationship,
    workflow: emergency?.workflow || {
      status: null,
      stage: null,
    },
    permissions: emergency
      ? {
          canRead: true,
          ...emergency.permissions,
        }
      : {
          canRead: true,
          canSendMessages:
            row.status === CONVERSATION_STATUSES.ACTIVE,
          canManageWorkflow: false,
        },
  };

  if (source.type === "emergency") {
    value.location = {
      locationText: row.source_location_text || "",
      unitNumber: row.source_unit_number || "",
      accessNotes: row.source_access_notes || "",
    };
  }

  return value;
}

module.exports = {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_VALUES,
  canArchiveConversation,
  canCloseConversation,
  canRestoreConversation,
  deriveEmergencyWorkflow,
  getConversationSource,
  hasExactlyOneConversationSource,
  isConversationParticipant,
  isValidPositiveInteger,
  parsePositiveInteger,
  participantArchiveField,
  normalizeInvoiceSharedPayload,
  normalizePaymentLifecyclePayload,
  normalizePaymentReminderPayload,
  normalizeQuoteSharedPayload,
  serializeConversationForHomeowner,
  serializeConversationForProfessional,
  serializeConversationDetail,
  serializeConversationMessage,
  serializeConversationSummaryForHomeowner,
  serializeConversationSummaryForProfessional,
  validateConversationStatus,
};
