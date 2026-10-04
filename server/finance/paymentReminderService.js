"use strict";

const {
  createHash,
  randomUUID,
} = require("node:crypto");

const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");

const {
  createPaymentReminderMessageWithClient,
} = require("../conversations/conversationMessageService");

const {
  normalizeTimeZone,
} = require("../team/businessTimeSettingsService");

const {
  preWorkDepositServiceInternals,
} = require("./preWorkDepositService");

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

const CONTRACT_VERSION = 1;

const SOURCE_TYPES = Object.freeze({
  INVOICE: "INVOICE",
  DEPOSIT: "DEPOSIT",
});

const INVOICE_CLASSIFICATIONS = Object.freeze({
  UPCOMING_DUE: "UPCOMING_DUE",
  DUE_TODAY: "DUE_TODAY",
  OVERDUE: "OVERDUE",
});

const DEPOSIT_CLASSIFICATIONS = Object.freeze({
  DUE: "DEPOSIT_DUE",
  REMAINING: "DEPOSIT_REMAINING",
});

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function optionalText(value, maximum = 5000) {
  if (value == null || value === "") return null;

  const normalized =
    typeof value === "string"
      ? value.trim()
      : "";

  return normalized &&
    normalized.length <= maximum
    ? normalized
    : null;
}

function dateOnly(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }

  const parsed =
    new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function dateInTimeZone(
  timeZone,
  value = new Date()
) {
  const normalized =
    normalizeTimeZone(timeZone);

  if (!normalized) {
    return null;
  }

  const instant =
    value instanceof Date
      ? value
      : new Date(value);

  if (Number.isNaN(instant.getTime())) {
    return null;
  }

  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: normalized,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(instant);

  const values =
    Object.fromEntries(
      parts
        .filter(
          (part) =>
            ["year", "month", "day"]
              .includes(part.type)
        )
        .map(
          (part) => [
            part.type,
            part.value,
          ]
        )
    );

  return dateOnly(
    `${values.year}-${values.month}-${values.day}`
  );
}

function businessReminderDate(
  context,
  value = new Date()
) {
  const timeZone =
    normalizeTimeZone(
      context?.business_time_zone
    );

  if (!timeZone) {
    return null;
  }

  const classifiedOn =
    dateInTimeZone(
      timeZone,
      value
    );

  return classifiedOn
    ? {
        timeZone,
        classifiedOn,
      }
    : null;
}

function timestampDate(value) {
  if (!value) return null;

  const parsed =
    value instanceof Date
      ? value
      : new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function iso(value) {
  if (!value) return null;

  const parsed =
    value instanceof Date
      ? value
      : new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString();
}

function formatMinor(amountMinor, currency) {
  const amount = Number(amountMinor);

  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !/^[A-Z]{3}$/.test(currency || "")
  ) {
    return null;
  }

  return `${currency} ${(amount / 100).toFixed(2)}`;
}

function classifyInvoiceReminder({
  dueMode,
  dueDate = null,
  issuedAt = null,
  invoiceDate = null,
  timeZone = null,
  classifiedOn = null,
} = {}) {
  const exactClassifiedOn =
    dateOnly(classifiedOn);

  if (!exactClassifiedOn) return null;

  let effectiveDate = null;
  let normalizedDueDate = null;

  if (dueMode === "SPECIFIC_DATE") {
    normalizedDueDate = dateOnly(
      String(dueDate || "").slice(0, 10)
    );

    if (!normalizedDueDate) return null;

    effectiveDate = normalizedDueDate;
  } else if (dueMode === "DUE_ON_RECEIPT") {
    effectiveDate =
      dateInTimeZone(
        timeZone,
        issuedAt
      ) ||
      dateOnly(
        typeof invoiceDate === "string"
          ? invoiceDate
          : timestampDate(invoiceDate)
      );

    if (!effectiveDate) return null;
  } else {
    return null;
  }

  const classification =
    effectiveDate > exactClassifiedOn
      ? INVOICE_CLASSIFICATIONS.UPCOMING_DUE
      : effectiveDate === exactClassifiedOn
        ? INVOICE_CLASSIFICATIONS.DUE_TODAY
        : INVOICE_CLASSIFICATIONS.OVERDUE;

  return Object.freeze({
    classification,
    classifiedOn: exactClassifiedOn,
    due: Object.freeze({
      mode: dueMode,
      date:
        dueMode === "SPECIFIC_DATE"
          ? normalizedDueDate
          : null,
      effectiveDate,
    }),
  });
}

function defaultInvoiceReminderMessage({
  invoiceNumber,
  amountMinor,
  currency,
  classification,
  due,
}) {
  const amount =
    formatMinor(amountMinor, currency) ||
    "the outstanding balance";

  const number =
    typeof invoiceNumber === "string" &&
    invoiceNumber.trim()
      ? invoiceNumber.trim()
      : "the Invoice";

  if (
    classification ===
    INVOICE_CLASSIFICATIONS.UPCOMING_DUE
  ) {
    return `Payment reminder: ${amount} remains due on ${number} by ${due.effectiveDate}.`;
  }

  if (
    classification ===
    INVOICE_CLASSIFICATIONS.DUE_TODAY
  ) {
    return `Payment reminder: ${amount} on ${number} is due today.`;
  }

  return `Payment reminder: ${amount} remains overdue on ${number}.`;
}

function defaultDepositReminderMessage({
  amountMinor,
  currency,
  classification,
}) {
  const amount =
    formatMinor(amountMinor, currency) ||
    "the remaining deposit";

  return classification ===
    DEPOSIT_CLASSIFICATIONS.DUE
    ? `Payment reminder: the required deposit of ${amount} remains due.`
    : `Payment reminder: ${amount} of the required deposit remains due.`;
}

function validateInput(
  input,
  fields,
  {
    invoice = false,
    job = false,
  } = {}
) {
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    ...fields,
  ]);

  if (
    !isPlainObject(input) ||
    Object.keys(input).some(
      (key) => !allowed.has(key)
    )
  ) {
    return {
      error: failure(
        400,
        "PAYMENT_REMINDER_FIELD_REJECTED",
        "The Payment Reminder request is invalid."
      ),
    };
  }

  const actor =
    validateAuthenticatedActor(
      input.authenticatedActor
    );

  if (actor.error) return actor;

  if (
    !input.pool ||
    typeof input.pool.query !== "function"
  ) {
    throw new TypeError(
      "A database pool or client is required."
    );
  }

  const result = {
    actorId: actor.id,
  };

  if (invoice) {
    result.invoiceId =
      normalizedUuid(input.invoiceId);

    if (!result.invoiceId) {
      return {
        error: failure(
          400,
          "INVALID_PAYMENT_REMINDER_INVOICE",
          "A valid Invoice is required."
        ),
      };
    }
  }

  if (job) {
    result.jobId =
      normalizedUuid(input.jobId);

    if (!result.jobId) {
      return {
        error: failure(
          400,
          "INVALID_PAYMENT_REMINDER_JOB",
          "A valid Job is required."
        ),
      };
    }
  }

  return result;
}

async function runTransaction(
  pool,
  action
) {
  const client =
    await databaseClient(pool);

  let started = false;

  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE"
    );

    started = true;

    const outcome =
      await action(client);

    if (outcome?.abort) {
      await rollback(client);
      started = false;
      return outcome.abort;
    }

    await client.query("COMMIT");
    started = false;

    return outcome?.result ?? outcome;
  } catch (error) {
    if (started) {
      await rollback(client);
    }

    throw error;
  } finally {
    if (
      client !== pool &&
      typeof client.release === "function"
    ) {
      client.release();
    }
  }
}

async function loadMeetroContext(
  client,
  {
    jobId,
    actorId,
  }
) {
  const result =
    await client.query(
      `/* payment_reminder:load_meetro_context */
       SELECT
         jobs.id AS job_id,
         jobs.source_type,
         jobs.source_request_relationship_id
           AS relationship_id,

         relationships.homeowner_id,
         relationships.professional_user_id,
         relationships.status
           AS relationship_status,

         professional.id
           AS professional_participant_id,
         customer.id
           AS customer_participant_id,

         conversations.id
           AS conversation_id,
         conversations.status
           AS conversation_status,

         profiles.time_zone
           AS business_time_zone,

         EXISTS (
           SELECT 1
           FROM participant_role_assignments roles
           LEFT JOIN participant_role_revocations revocations
             ON revocations.role_assignment_id = roles.id
           WHERE roles.participant_id = professional.id
             AND roles.job_id = jobs.id
             AND roles.role = 'PRIMARY_PROFESSIONAL'
             AND roles.valid_from <= CURRENT_TIMESTAMP
             AND (
               roles.valid_until IS NULL
               OR roles.valid_until > CURRENT_TIMESTAMP
             )
             AND revocations.id IS NULL
         ) AS primary_role_active

       FROM jobs

       INNER JOIN request_relationships relationships
         ON relationships.id =
           jobs.source_request_relationship_id
        AND relationships.professional_user_id = $2

       INNER JOIN relationship_participants professional
         ON professional.job_id = jobs.id
        AND professional.request_relationship_id =
          relationships.id
        AND professional.user_id = $2

       INNER JOIN relationship_participants customer
         ON customer.job_id = jobs.id
        AND customer.request_relationship_id =
          relationships.id
        AND customer.user_id =
          relationships.homeowner_id

       LEFT JOIN conversations
         ON conversations.relationship_id =
           relationships.id

       INNER JOIN contractor_profiles profiles
         ON profiles.user_id =
           relationships.professional_user_id

       WHERE jobs.id = $1
         AND jobs.lifecycle_contract_version = 2
         AND jobs.source_type =
           'ordinary_request_selection'

       LIMIT 1

       FOR UPDATE OF jobs, relationships`,
      [
        jobId,
        actorId,
      ]
    );

  return result.rows[0] || null;
}

function meetroContextAuthorized(
  context,
  actorId
) {
  return Boolean(
    context &&
    context.source_type ===
      "ordinary_request_selection" &&
    Number(
      context.professional_user_id
    ) === actorId &&
    Number.isSafeInteger(
      Number(context.homeowner_id)
    ) &&
    context.primary_role_active === true &&
    ["active", "closed"].includes(
      context.relationship_status
    )
  );
}

function governedConversation(
  context
) {
  const id =
    positiveInteger(
      context?.conversation_id
    );

  const professionalUserId =
    positiveInteger(
      context?.professional_user_id
    );

  const homeownerId =
    positiveInteger(
      context?.homeowner_id
    );

  if (
    !id ||
    !professionalUserId ||
    !homeownerId ||
    context?.conversation_status !==
      "active"
  ) {
    return null;
  }

  return {
    id,
    homeowner_id: homeownerId,
    professional_user_id:
      professionalUserId,
    status: "active",
  };
}

async function loadInvoiceSource(
  client,
  {
    invoiceId,
    jobId,
    relationshipId,
  }
) {
  const result =
    await client.query(
      `/* payment_reminder:load_invoice */
       SELECT
         invoices.id AS invoice_id,
         invoices.invoice_number,
         invoices.job_id,
         invoices.relationship_id,

         current.version,
         current.status,
         current.currency,
         current.total_minor,
         current.paid_minor,
         current.balance_minor,
         current.invoice_date,
         current.due_mode,
         current.due_date,

         issuances.issued_at

       FROM canonical_invoices invoices

       INNER JOIN LATERAL (
         SELECT
           versions.version,
           versions.status,
           versions.currency,
           versions.total_minor,
           versions.paid_minor,
           versions.balance_minor,
           versions.invoice_date,
           versions.due_mode,
           versions.due_date
         FROM canonical_invoice_versions versions
         WHERE versions.invoice_id =
           invoices.id
         ORDER BY versions.version DESC
         LIMIT 1
       ) current ON TRUE

       LEFT JOIN canonical_invoice_issuances issuances
         ON issuances.invoice_id =
           invoices.id

       WHERE invoices.id = $1
         AND invoices.job_id = $2
         AND invoices.relationship_id = $3

       LIMIT 1

       FOR UPDATE OF invoices`,
      [
        invoiceId,
        jobId,
        relationshipId,
      ]
    );

  return result.rows[0] || null;
}

async function loadDepositSource(
  client,
  {
    jobId,
    relationshipId,
  }
) {
  const approval =
    await preWorkDepositServiceInternals
      .loadApprovedQuoteApprovalSource(
        client,
        {
          jobId,
          lock: true,
        }
      );

  if (
    !approval ||
    approval.approval_source !==
      "MEETRO_CUSTOMER" ||
    Number(
      approval.relationship_id
    ) !== Number(relationshipId)
  ) {
    return null;
  }

  const result =
    await client.query(
      `/* payment_reminder:load_deposit */
       SELECT
         obligations.id
           AS obligation_id,
         obligations.job_id,
         obligations.relationship_id,
         obligations.approval_source,
         obligations.currency,

         latest.version,
         latest.state,
         latest.required_minor,
         latest.applied_minor,
         latest.remaining_minor

       FROM canonical_pre_work_deposit_obligations obligations

       INNER JOIN LATERAL (
         SELECT
           versions.version,
           versions.state,
           versions.required_minor,
           versions.applied_minor,
           versions.remaining_minor
         FROM canonical_pre_work_deposit_versions versions
         WHERE versions.obligation_id =
           obligations.id
         ORDER BY versions.version DESC
         LIMIT 1
       ) latest ON TRUE

       WHERE obligations.quote_approval_id = $1
         AND obligations.job_id = $2
         AND obligations.relationship_id = $3
         AND obligations.approval_source =
           'MEETRO_CUSTOMER'

       LIMIT 1

       FOR UPDATE OF obligations`,
      [
        approval.quote_approval_id,
        jobId,
        relationshipId,
      ]
    );

  return result.rows[0] || null;
}

async function reserveReminderCommand(
  client,
  {
    actorId,
    sourceType,
    jobId,
    invoiceId = null,
    depositObligationId = null,
    idempotencyKey,
    fingerprint,
  }
) {
  const id = randomUUID();

  const inserted =
    await client.query(
      `/* payment_reminder:reserve_command */
       INSERT INTO canonical_payment_reminder_command_idempotency (
         id,
         actor_user_id,
         command_name,
         source_type,
         job_id,
         invoice_id,
         deposit_obligation_id,
         idempotency_key,
         request_fingerprint
       )
       VALUES (
         $1,
         $2,
         'payment.reminder.send',
         $3,
         $4,
         $5,
         $6,
         $7,
         $8
       )
       ON CONFLICT (
         actor_user_id,
         command_name,
         idempotency_key
       )
       DO NOTHING
       RETURNING *`,
      [
        id,
        actorId,
        sourceType,
        jobId,
        invoiceId,
        depositObligationId,
        idempotencyKey,
        fingerprint,
      ]
    );

  if (inserted.rows[0]) {
    return {
      row: inserted.rows[0],
      replay: null,
    };
  }

  const existing =
    await client.query(
      `/* payment_reminder:find_command */
       SELECT *
       FROM canonical_payment_reminder_command_idempotency
       WHERE actor_user_id = $1
         AND command_name =
           'payment.reminder.send'
         AND idempotency_key = $2
       LIMIT 1
       FOR UPDATE`,
      [
        actorId,
        idempotencyKey,
      ]
    );

  const row =
    existing.rows[0];

  if (
    !row ||
    row.request_fingerprint !==
      fingerprint
  ) {
    return {
      error: failure(
        409,
        "PAYMENT_REMINDER_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different Payment Reminder."
      ),
    };
  }

  if (!row.result_payload) {
    return {
      error: failure(
        409,
        "PAYMENT_REMINDER_COMMAND_IN_PROGRESS",
        "The Payment Reminder command is still being processed."
      ),
    };
  }

  return {
    row,
    replay: {
      ...row.result_payload,
      replayed: true,
      status: 200,
    },
  };
}

async function completeReminderCommand(
  client,
  commandId,
  result
) {
  const updated =
    await client.query(
      `/* payment_reminder:complete_command */
       UPDATE canonical_payment_reminder_command_idempotency
       SET
         result_payload = $2::jsonb,
         completed_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND result_payload IS NULL`,
      [
        commandId,
        JSON.stringify(result),
      ]
    );

  if (updated.rowCount !== 1) {
    throw new Error(
      "Payment Reminder idempotency could not be completed."
    );
  }
}

function reminderProjection(row) {
  return Object.freeze({
    contractVersion:
      CONTRACT_VERSION,

    reminderId:
      String(row.id),

    sourceType:
      row.source_type,

    invoiceId:
      row.invoice_id || null,

    paymentRequirementId:
      row.deposit_obligation_id || null,

    jobId:
      row.job_id,

    relationshipId:
      Number(row.relationship_id),

    conversationId:
      Number(row.conversation_id),

    messageId:
      Number(row.message_id),

    sourceVersion:
      Number(row.source_version),

    classification:
      row.classification,

    classifiedOn:
      timestampDate(row.classified_on),

    timeZone:
      row.classification_time_zone,

    currency:
      row.currency,

    amountMinor:
      Number(row.amount_minor),

    due:
      row.source_type ===
        SOURCE_TYPES.INVOICE
        ? {
            mode:
              row.due_mode,
            date:
              timestampDate(row.due_date),
            effectiveDate:
              timestampDate(
                row.effective_due_date
              ),
          }
        : null,

    messageText:
      row.message_text,

    sentAt:
      iso(row.sent_at),
  });
}

async function insertReminderEvidence(
  client,
  {
    reminderId,
    commandId,
    sourceType,
    context,
    invoiceId = null,
    depositObligationId = null,
    sourceVersion,
    classification,
    classifiedOn,
    classificationTimeZone,
    currency,
    amountMinor,
    due = null,
    message,
    messageText,
  }
) {
  const result =
    await client.query(
      `/* payment_reminder:insert_evidence */
       INSERT INTO canonical_payment_reminders (
         id,
         command_idempotency_id,
         source_type,
         job_id,
         relationship_id,
         conversation_id,
         sender_user_id,
         recipient_user_id,
         sender_participant_id,
         invoice_id,
         deposit_obligation_id,
         source_version,
         classification,
         classified_on,
         classification_time_zone,
         currency,
         amount_minor,
         due_mode,
         due_date,
         effective_due_date,
         message_text,
         message_id,
         sent_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15,
         $16,
         $17,
         $18,
         $19,
         $20,
         $21,
         $22,
         (
           SELECT messages.created_at
           FROM messages
           WHERE messages.id = $22
         )
       )
       RETURNING *`,
      [
        reminderId,
        commandId,
        sourceType,
        context.job_id,
        Number(
          context.relationship_id
        ),
        Number(
          context.conversation_id
        ),
        Number(
          context.professional_user_id
        ),
        Number(
          context.homeowner_id
        ),
        context.professional_participant_id,
        invoiceId,
        depositObligationId,
        sourceVersion,
        classification,
        classifiedOn,
        classificationTimeZone,
        currency,
        amountMinor,
        due?.mode || null,
        due?.date || null,
        due?.effectiveDate || null,
        messageText,
        Number(message.id),
      ]
    );

  const row =
    result.rows[0];

  if (!row) {
    throw new Error(
      "Canonical Payment Reminder evidence was not created."
    );
  }

  return reminderProjection(row);
}

async function sendInvoicePaymentReminder(
  input = {}
) {
  const validated =
    validateInput(
      input,
      [
        "invoiceId",
        "expectedVersion",
        "messageText",
        "idempotencyKey",
      ],
      {
        invoice: true,
      }
    );

  if (validated.error) {
    return validated.error;
  }

  const expectedVersion =
    positiveInteger(
      input.expectedVersion
    );

  const customMessage =
    input.messageText == null
      ? null
      : optionalText(
          input.messageText
        );

  const idempotency =
    validateIdempotencyKey(
      input.idempotencyKey
    );

  if (
    !expectedVersion ||
    idempotency.error ||
    (
      input.messageText != null &&
      !customMessage
    )
  ) {
    return (
      idempotency.error ||
      failure(
        400,
        "INVALID_PAYMENT_REMINDER_COMMAND",
        "The Payment Reminder command is invalid."
      )
    );
  }

  return runTransaction(
    input.pool,
    async (client) => {
      const identity =
        await client.query(
          `/* payment_reminder:invoice_identity */
           SELECT
             invoices.job_id,
             invoices.relationship_id
           FROM canonical_invoices invoices
           WHERE invoices.id = $1
           LIMIT 1`,
          [
            validated.invoiceId,
          ]
        );

      const invoiceIdentity =
        identity.rows[0];

      if (!invoiceIdentity) {
        return {
          abort: failure(
            404,
            "PAYMENT_REMINDER_INVOICE_UNAVAILABLE",
            "The Invoice is unavailable."
          ),
        };
      }

      const context =
        await loadMeetroContext(
          client,
          {
            jobId:
              invoiceIdentity.job_id,
            actorId:
              validated.actorId,
          }
        );

      if (
        !meetroContextAuthorized(
          context,
          validated.actorId
        ) ||
        Number(
          context.relationship_id
        ) !==
          Number(
            invoiceIdentity.relationship_id
          )
      ) {
        return {
          abort: failure(
            403,
            "PAYMENT_REMINDER_AUTHORITY_DENIED",
            "Payment Reminder authority is unavailable."
          ),
        };
      }

      const businessDate =
        businessReminderDate(
          context
        );

      if (!businessDate) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_TIME_ZONE_REQUIRED",
            "Configure the Business timezone before sending a Payment Reminder."
          ),
        };
      }

      const conversation =
        governedConversation(
          context
        );

      if (!conversation) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_CONVERSATION_UNAVAILABLE",
            "A governed Meetro customer conversation is required."
          ),
        };
      }

      const invoice =
        await loadInvoiceSource(
          client,
          {
            invoiceId:
              validated.invoiceId,
            jobId:
              context.job_id,
            relationshipId:
              context.relationship_id,
          }
        );

      if (!invoice) {
        return {
          abort: failure(
            404,
            "PAYMENT_REMINDER_INVOICE_UNAVAILABLE",
            "The Invoice is unavailable."
          ),
        };
      }

      const fingerprint =
        hash({
          command:
            "payment.reminder.send",
          actorId:
            validated.actorId,
          sourceType:
            SOURCE_TYPES.INVOICE,
          invoiceId:
            validated.invoiceId,
          jobId:
            context.job_id,
          expectedVersion,
          messageText:
            customMessage,
        });

      const reserved =
        await reserveReminderCommand(
          client,
          {
            actorId:
              validated.actorId,
            sourceType:
              SOURCE_TYPES.INVOICE,
            jobId:
              context.job_id,
            invoiceId:
              validated.invoiceId,
            idempotencyKey:
              idempotency.idempotencyKey,
            fingerprint,
          }
        );

      if (reserved.error) {
        return {
          abort:
            reserved.error,
        };
      }

      if (reserved.replay) {
        return {
          result:
            reserved.replay,
        };
      }

      if (
        Number(invoice.version) !==
        expectedVersion
      ) {
        return {
          abort: failure(
            409,
            "STALE_PAYMENT_REMINDER_SOURCE",
            "The Invoice changed before the reminder was sent."
          ),
        };
      }

      if (
        ![
          "SENT",
          "PARTIALLY_PAID",
        ].includes(
          invoice.status
        )
      ) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_NOT_AVAILABLE",
            "Only an unpaid issued Invoice can receive a Payment Reminder."
          ),
        };
      }

      const amountMinor =
        Number(
          invoice.balance_minor
        );

      if (
        !Number.isSafeInteger(
          amountMinor
        ) ||
        amountMinor <= 0
      ) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_NOT_AVAILABLE",
            "This Invoice has no outstanding balance."
          ),
        };
      }

      const classified =
        classifyInvoiceReminder({
          dueMode:
            invoice.due_mode,
          dueDate:
            timestampDate(
              invoice.due_date
            ),
          issuedAt:
            invoice.issued_at,
          invoiceDate:
            timestampDate(
              invoice.invoice_date
            ),
          timeZone:
            businessDate.timeZone,
          classifiedOn:
            businessDate.classifiedOn,
        });

      if (!classified) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_DUE_TRUTH_UNAVAILABLE",
            "The Invoice due status could not be determined."
          ),
        };
      }

      const reminderId =
        randomUUID();

      const messageText =
        customMessage ||
        defaultInvoiceReminderMessage({
          invoiceNumber:
            invoice.invoice_number,
          amountMinor,
          currency:
            invoice.currency,
          classification:
            classified.classification,
          due:
            classified.due,
        });

      const workflowPayload = {
        schemaVersion:
          CONTRACT_VERSION,

        reminderId,

        sourceType:
          SOURCE_TYPES.INVOICE,

        invoiceId:
          validated.invoiceId,

        paymentRequirementId:
          null,

        jobId:
          context.job_id,

        sourceVersion:
          expectedVersion,

        classification:
          classified.classification,

        classifiedOn:
          classified.classifiedOn,

        timeZone:
          businessDate.timeZone,

        currency:
          invoice.currency,

        amountMinor,

        due:
          classified.due,
      };

      const message =
        await createPaymentReminderMessageWithClient({
          client,
          conversation,
          senderUserId:
            Number(
              context.professional_user_id
            ),
          recipientUserId:
            Number(
              context.homeowner_id
            ),
          messageText,
          workflowPayload,
          jobId:
            context.job_id,
        });

      const reminder =
        await insertReminderEvidence(
          client,
          {
            reminderId,
            commandId:
              reserved.row.id,
            sourceType:
              SOURCE_TYPES.INVOICE,
            context,
            invoiceId:
              validated.invoiceId,
            sourceVersion:
              expectedVersion,
            classification:
              classified.classification,
            classifiedOn:
              classified.classifiedOn,
            classificationTimeZone:
              businessDate.timeZone,
            currency:
              invoice.currency,
            amountMinor,
            due:
              classified.due,
            message,
            messageText,
          }
        );

      const result = {
        ok: true,
        success: true,
        status: 201,
        code:
          "PAYMENT_REMINDER_SENT",
        reminder,
      };

      await completeReminderCommand(
        client,
        reserved.row.id,
        result
      );

      return {
        result,
      };
    }
  );
}

async function sendDepositPaymentReminder(
  input = {}
) {
  const validated =
    validateInput(
      input,
      [
        "jobId",
        "expectedVersion",
        "messageText",
        "idempotencyKey",
      ],
      {
        job: true,
      }
    );

  if (validated.error) {
    return validated.error;
  }

  const expectedVersion =
    positiveInteger(
      input.expectedVersion
    );

  const customMessage =
    input.messageText == null
      ? null
      : optionalText(
          input.messageText
        );

  const idempotency =
    validateIdempotencyKey(
      input.idempotencyKey
    );

  if (
    !expectedVersion ||
    idempotency.error ||
    (
      input.messageText != null &&
      !customMessage
    )
  ) {
    return (
      idempotency.error ||
      failure(
        400,
        "INVALID_PAYMENT_REMINDER_COMMAND",
        "The Payment Reminder command is invalid."
      )
    );
  }

  return runTransaction(
    input.pool,
    async (client) => {
      const context =
        await loadMeetroContext(
          client,
          {
            jobId:
              validated.jobId,
            actorId:
              validated.actorId,
          }
        );

      if (
        !meetroContextAuthorized(
          context,
          validated.actorId
        )
      ) {
        return {
          abort: failure(
            403,
            "PAYMENT_REMINDER_AUTHORITY_DENIED",
            "Payment Reminder authority is unavailable."
          ),
        };
      }

      const businessDate =
        businessReminderDate(
          context
        );

      if (!businessDate) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_TIME_ZONE_REQUIRED",
            "Configure the Business timezone before sending a Payment Reminder."
          ),
        };
      }

      const conversation =
        governedConversation(
          context
        );

      if (!conversation) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_CONVERSATION_UNAVAILABLE",
            "A governed Meetro customer conversation is required."
          ),
        };
      }

      const deposit =
        await loadDepositSource(
          client,
          {
            jobId:
              validated.jobId,
            relationshipId:
              context.relationship_id,
          }
        );

      if (!deposit) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_DEPOSIT_UNAVAILABLE",
            "An active canonical deposit requirement is required."
          ),
        };
      }

      const fingerprint =
        hash({
          command:
            "payment.reminder.send",
          actorId:
            validated.actorId,
          sourceType:
            SOURCE_TYPES.DEPOSIT,
          paymentRequirementId:
            deposit.obligation_id,
          jobId:
            validated.jobId,
          expectedVersion,
          messageText:
            customMessage,
        });

      const reserved =
        await reserveReminderCommand(
          client,
          {
            actorId:
              validated.actorId,
            sourceType:
              SOURCE_TYPES.DEPOSIT,
            jobId:
              validated.jobId,
            depositObligationId:
              deposit.obligation_id,
            idempotencyKey:
              idempotency.idempotencyKey,
            fingerprint,
          }
        );

      if (reserved.error) {
        return {
          abort:
            reserved.error,
        };
      }

      if (reserved.replay) {
        return {
          result:
            reserved.replay,
        };
      }

      if (
        Number(deposit.version) !==
        expectedVersion
      ) {
        return {
          abort: failure(
            409,
            "STALE_PAYMENT_REMINDER_SOURCE",
            "The deposit requirement changed before the reminder was sent."
          ),
        };
      }

      if (
        ![
          "DUE",
          "PARTIALLY_SATISFIED",
        ].includes(
          deposit.state
        )
      ) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_NOT_AVAILABLE",
            "Only an unpaid deposit requirement can receive a Payment Reminder."
          ),
        };
      }

      const amountMinor =
        Number(
          deposit.remaining_minor
        );

      if (
        !Number.isSafeInteger(
          amountMinor
        ) ||
        amountMinor <= 0
      ) {
        return {
          abort: failure(
            409,
            "PAYMENT_REMINDER_NOT_AVAILABLE",
            "This deposit requirement has no remaining balance."
          ),
        };
      }

      const classification =
        deposit.state === "DUE"
          ? DEPOSIT_CLASSIFICATIONS.DUE
          : DEPOSIT_CLASSIFICATIONS.REMAINING;

      const classifiedOn =
        businessDate.classifiedOn;

      const reminderId =
        randomUUID();

      const messageText =
        customMessage ||
        defaultDepositReminderMessage({
          amountMinor,
          currency:
            deposit.currency,
          classification,
        });

      const workflowPayload = {
        schemaVersion:
          CONTRACT_VERSION,

        reminderId,

        sourceType:
          SOURCE_TYPES.DEPOSIT,

        invoiceId:
          null,

        paymentRequirementId:
          deposit.obligation_id,

        jobId:
          validated.jobId,

        sourceVersion:
          expectedVersion,

        classification,

        classifiedOn,

        timeZone:
          businessDate.timeZone,

        currency:
          deposit.currency,

        amountMinor,

        due:
          null,
      };

      const message =
        await createPaymentReminderMessageWithClient({
          client,
          conversation,
          senderUserId:
            Number(
              context.professional_user_id
            ),
          recipientUserId:
            Number(
              context.homeowner_id
            ),
          messageText,
          workflowPayload,
          jobId:
            validated.jobId,
        });

      const reminder =
        await insertReminderEvidence(
          client,
          {
            reminderId,
            commandId:
              reserved.row.id,
            sourceType:
              SOURCE_TYPES.DEPOSIT,
            context,
            depositObligationId:
              deposit.obligation_id,
            sourceVersion:
              expectedVersion,
            classification,
            classifiedOn,
            classificationTimeZone:
              businessDate.timeZone,
            currency:
              deposit.currency,
            amountMinor,
            due:
              null,
            message,
            messageText,
          }
        );

      const result = {
        ok: true,
        success: true,
        status: 201,
        code:
          "PAYMENT_REMINDER_SENT",
        reminder,
      };

      await completeReminderCommand(
        client,
        reserved.row.id,
        result
      );

      return {
        result,
      };
    }
  );
}

module.exports = {
  CONTRACT_VERSION,
  DEPOSIT_CLASSIFICATIONS,
  INVOICE_CLASSIFICATIONS,
  SOURCE_TYPES,
  sendDepositPaymentReminder,
  sendInvoicePaymentReminder,
  paymentReminderInternals:
    Object.freeze({
      canonicalJson,
      classifyInvoiceReminder,
      dateInTimeZone,
      defaultDepositReminderMessage,
      defaultInvoiceReminderMessage,
      formatMinor,
      hash,
      reminderProjection,
    }),
};
