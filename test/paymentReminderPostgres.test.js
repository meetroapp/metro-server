"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  ensureCompletedVisitEvaluation,
  quiet,
} = require("./helpers/visitLifecycleFixture");

const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");

const {
  sendQuoteInMeetro,
} = require("../server/authorization/quoteDeliveryService");

const {
  confirmDepositReceived,
  getProfessionalDepositStatus,
  materializePreWorkDepositObligation,
} = require("../server/finance/preWorkDepositService");

const {
  sendDepositPaymentReminder,
  sendInvoicePaymentReminder,
} = require("../server/finance/paymentReminderService");

const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl =
  process.env.PAYMENT_REMINDER_DATABASE_URL;

const BUSINESS_TIME_ZONE =
  "America/New_York";

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(
      databaseUrl,
      {
        nodeEnv: process.env.NODE_ENV,
      }
    ),
  };
}

function sha(value) {
  return createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function businessToday() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          BUSINESS_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(
      new Date()
    );

  const values =
    Object.fromEntries(
      parts
        .filter(
          (part) =>
            [
              "year",
              "month",
              "day",
            ].includes(
              part.type
            )
        )
        .map(
          (part) => [
            part.type,
            part.value,
          ]
        )
    );

  return `${values.year}-${values.month}-${values.day}`;
}

async function configureBusinessTimeZone(
  pool,
  identities
) {
  const profile =
    await pool.query(
      `SELECT id
       FROM contractor_profiles
       WHERE user_id = $1
       LIMIT 1`,
      [
        identities.professionalId,
      ]
    );

  assert.equal(
    profile.rowCount,
    1
  );

  const businessId =
    Number(
      profile.rows[0].id
    );

  await pool.query(
    `INSERT INTO business_team_memberships (
       contractor_profile_id,
       user_id,
       role,
       status,
       created_by_user_id
     )
     VALUES (
       $1,
       $2,
       'OWNER',
       'ACTIVE',
       $2
     )
     ON CONFLICT (
       contractor_profile_id,
       user_id
     )
     DO NOTHING`,
    [
      businessId,
      identities.professionalId,
    ]
  );

  const membership =
    await pool.query(
      `SELECT id
       FROM business_team_memberships
       WHERE contractor_profile_id = $1
         AND user_id = $2
         AND role = 'OWNER'
         AND status = 'ACTIVE'
       LIMIT 1`,
      [
        businessId,
        identities.professionalId,
      ]
    );

  assert.equal(
    membership.rowCount,
    1
  );

  await pool.query(
    `UPDATE contractor_profiles
     SET
       time_zone = $2,
       week_start_day =
         'SUNDAY',
       time_settings_updated_at =
         CURRENT_TIMESTAMP,
       time_settings_updated_by_membership_id =
         $3
     WHERE id = $1`,
    [
      businessId,
      BUSINESS_TIME_ZONE,
      membership.rows[0].id,
    ]
  );
}

const depositTerms = Object.freeze({
  schemaVersion: 1,
  paymentTerms:
    "75% deposit; balance due on completion.",
  estimatedDuration: "1 day",
  customerNotes: "",
  agreement: Object.freeze({
    exclusions: [],
    additionalWorkTerms:
      "Written customer approval is required.",
    hiddenConditionsTerms:
      "Hidden conditions require a revised Quote.",
    diagnosticTerms:
      "Diagnostic work is limited to the stated scope.",
    customerResponsibilities:
      "Provide safe site access.",
    warrantyTerms:
      "One-year workmanship warranty.",
    cancellationTerms:
      "Cancellation terms apply as stated.",
    acceptanceTerms:
      "Approval accepts this exact issued Quote.",
    preauthorizedAdditionalWorkLimit:
      "$0",
  }),
});

async function createApprovedDepositQuote(
  pool,
  identities,
  fixture,
  suffix
) {
  await ensureCompletedVisitEvaluation(
    pool,
    identities,
    fixture,
    suffix
  );

  const created =
    await createDraftQuote({
      pool,
      authenticatedActor: {
        id: identities.professionalId,
      },
      jobId: fixture.jobId,
      currency: "USD",
      customerTermsSnapshot:
        depositTerms,
      idempotencyKey:
        `reminder-quote-create-${suffix}`,
      logger: quiet,
    });

  assert.equal(
    created.ok,
    true,
    created.code
  );

  const scoped =
    await addDraftScopeItem({
      pool,
      authenticatedActor: {
        id: identities.professionalId,
      },
      quoteId:
        created.quote.id,
      expectedVersion:
        created.quote.currentVersion,
      item: {
        classification:
          "LABOR_SERVICE",
        scopeSemantic:
          "FUTURE_WORK",
        materialResponsibility:
          "NOT_APPLICABLE",
        description:
          "Payment Reminder runtime work",
        quantity: 1,
        unitAmountMinor: 68000,
        source: {
          type:
            "MANUAL_PROFESSIONAL",
        },
      },
      idempotencyKey:
        `reminder-quote-scope-${suffix}`,
      logger: quiet,
    });

  assert.equal(
    scoped.ok,
    true,
    scoped.code
  );

  const issued =
    await issueQuote({
      pool,
      authenticatedActor: {
        id: identities.professionalId,
      },
      quoteId:
        scoped.quote.id,
      expectedVersion:
        scoped.quote.currentVersion,
      idempotencyKey:
        `reminder-quote-issue-${suffix}`,
      logger: quiet,
    });

  assert.equal(
    issued.ok,
    true,
    issued.code
  );

  const delivered =
    await sendQuoteInMeetro({
      pool,
      authenticatedActor: {
        id: identities.professionalId,
      },
      quoteId:
        issued.quote.id,
      expectedIssuedVersion:
        issued.quote.currentVersion,
      idempotencyKey:
        `reminder-quote-deliver-${suffix}`,
      logger: quiet,
    });

  assert.equal(
    delivered.ok,
    true,
    delivered.code
  );

  const approved =
    await approveIssuedQuote({
      pool,
      authenticatedActor: {
        id: identities.homeownerId,
      },
      quoteId:
        issued.quote.id,
      expectedIssuedVersion:
        issued.quote.currentVersion,
      idempotencyKey:
        `reminder-quote-approve-${suffix}`,
      logger: quiet,
    });

  assert.equal(
    approved.ok,
    true,
    approved.code
  );

  return issued.quote;
}

async function loadJobContext(
  pool,
  fixture,
  identities
) {
  const result =
    await pool.query(
      `SELECT
         jobs.job_request_id,
         jobs.source_request_relationship_id
           AS relationship_id,
         conversations.id
           AS conversation_id,
         conversations.status
           AS conversation_status,
         relationships.homeowner_id,
         relationships.professional_user_id
       FROM jobs
       INNER JOIN request_relationships relationships
         ON relationships.id =
           jobs.source_request_relationship_id
       LEFT JOIN conversations
         ON conversations.relationship_id =
           relationships.id
       WHERE jobs.id = $1
         AND relationships.professional_user_id = $2
         AND relationships.homeowner_id = $3
       LIMIT 1`,
      [
        fixture.jobId,
        identities.professionalId,
        identities.homeownerId,
      ]
    );

  assert.equal(
    result.rowCount,
    1
  );

  assert.equal(
    result.rows[0]
      .conversation_status,
    "active"
  );

  return result.rows[0];
}

async function insertIssuedInvoice(
  pool,
  {
    fixture,
    identities,
    context,
  }
) {
  const invoiceId =
    randomUUID();

  const invoiceNumber =
    `INV-${invoiceId
      .replaceAll("-", "")
      .slice(0, 12)
      .toUpperCase()}`;

  const dueDate =
    businessToday();

  const versionHash =
    sha(
      `payment-reminder-invoice:${invoiceId}:1`
    );

  await pool.query(
    `INSERT INTO canonical_invoices (
       id,
       job_id,
       job_request_id,
       relationship_id,
       issuer_participant_id,
       invoice_number
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6
     )`,
    [
      invoiceId,
      fixture.jobId,
      Number(
        context.job_request_id
      ),
      Number(
        context.relationship_id
      ),
      fixture.professionalParticipantId,
      invoiceNumber,
    ]
  );

  await pool.query(
    `INSERT INTO canonical_invoice_versions (
       invoice_id,
       version,
       job_id,
       status,
       currency,
       subtotal_minor,
       total_minor,
       paid_minor,
       balance_minor,
       invoice_date,
       due_mode,
       due_date,
       customer_notes,
       terms,
       created_by_participant_id,
       integrity_hash
     )
     VALUES (
       $1,
       1,
       $2,
       'SENT',
       'USD',
       17000,
       17000,
       0,
       17000,
       $3,
       'SPECIFIC_DATE',
       $3,
       NULL,
       'Balance due by the stated date.',
       $4,
       $5
     )`,
    [
      invoiceId,
      fixture.jobId,
      dueDate,
      fixture.professionalParticipantId,
      versionHash,
    ]
  );

  const deliveryKey =
    `runtime-invoice-${randomUUID()}`;

  const deliveryHash =
    sha(deliveryKey);

  const message =
    await pool.query(
      `INSERT INTO messages (
         quote_request_id,
         conversation_id,
         sender_id,
         receiver_id,
         message_text,
         image_url,
         message_type,
         workflow_type,
         workflow_status,
         workflow_payload,
         invoice_id,
         job_id,
         invoice_delivery_idempotency_key,
         invoice_delivery_request_fingerprint
       )
       VALUES (
         NULL,
         $1,
         $2,
         $3,
         'Invoice shared for Payment Reminder certification.',
         NULL,
         'invoice_shared',
         'INVOICE_SHARED',
         'SENT',
         $4::jsonb,
         $5,
         $6,
         $7,
         $8
       )
       RETURNING id, created_at`,
      [
        Number(
          context.conversation_id
        ),
        identities.professionalId,
        identities.homeownerId,
        JSON.stringify({
          schemaVersion: 1,
          invoiceId,
          jobId:
            fixture.jobId,
        }),
        invoiceId,
        fixture.jobId,
        deliveryKey,
        deliveryHash,
      ]
    );

  assert.equal(
    message.rowCount,
    1
  );

  await pool.query(
    `INSERT INTO canonical_invoice_issuances (
       invoice_id,
       invoice_version,
       job_id,
       conversation_id,
       message_id,
       issued_by_participant_id,
       issued_at,
       source_integrity_hash
     )
     VALUES (
       $1,
       1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7
     )`,
    [
      invoiceId,
      fixture.jobId,
      Number(
        context.conversation_id
      ),
      Number(
        message.rows[0].id
      ),
      fixture.professionalParticipantId,
      message.rows[0].created_at,
      versionHash,
    ]
  );

  return {
    invoiceId,
    invoiceNumber,
    dueDate,
  };
}

async function invoiceSnapshot(
  pool,
  invoiceId
) {
  const versions =
    await pool.query(
      `SELECT
         version,
         status,
         currency,
         total_minor,
         paid_minor,
         balance_minor,
         due_mode,
         due_date
       FROM canonical_invoice_versions
       WHERE invoice_id = $1
       ORDER BY version`,
      [invoiceId]
    );

  const payments =
    await pool.query(
      `SELECT count(*)::integer
         AS count
       FROM canonical_invoice_payments
       WHERE invoice_id = $1`,
      [invoiceId]
    );

  return {
    versions:
      versions.rows.map(
        (row) => ({
          version:
            Number(row.version),
          status:
            row.status,
          currency:
            row.currency,
          totalMinor:
            Number(
              row.total_minor
            ),
          paidMinor:
            Number(
              row.paid_minor
            ),
          balanceMinor:
            Number(
              row.balance_minor
            ),
          dueMode:
            row.due_mode,
          dueDate:
            row.due_date instanceof Date
              ? row.due_date
                  .toISOString()
                  .slice(0, 10)
              : String(
                  row.due_date
                ).slice(0, 10),
        })
      ),
    paymentCount:
      Number(
        payments.rows[0]
          .count
      ),
  };
}

async function depositSnapshot(
  pool,
  obligationId
) {
  const versions =
    await pool.query(
      `SELECT
         version,
         state,
         required_minor,
         applied_minor,
         remaining_minor
       FROM canonical_pre_work_deposit_versions
       WHERE obligation_id = $1
       ORDER BY version`,
      [obligationId]
    );

  return versions.rows.map(
    (row) => ({
      version:
        Number(row.version),
      state:
        row.state,
      requiredMinor:
        Number(
          row.required_minor
        ),
      appliedMinor:
        Number(
          row.applied_minor
        ),
      remainingMinor:
        Number(
          row.remaining_minor
        ),
    })
  );
}

test(
  "disposable PostgreSQL certifies canonical Payment Reminder R1A",
  {
    skip:
      !databaseUrl,
  },
  async () => {
    const pool =
      new Pool({
        connectionString:
          databaseUrl,
        max: 12,
      });

    const suffix =
      randomUUID();

    try {
      const migrations =
        getMigrationFiles();

      assert.equal(
        migrations.at(-1)
          .filename,
        "202609020007_create_payment_reminder_evidence.sql"
      );

      const migrated =
        await runMigrationCollection(
          pool,
          migrations,
          targetMetadata()
        );

      assert.equal(
        migrated.success,
        true,
        JSON.stringify(
          migrated
        )
      );

      assert.equal(
        migrated.applied.length,
        migrations.length
      );

      const replayMigration =
        await runMigrationCollection(
          pool,
          migrations,
          targetMetadata()
        );

      assert.equal(
        replayMigration.applied
          .length,
        0
      );

      assert.equal(
        replayMigration.skipped
          .length,
        migrations.length
      );

      const identities =
        await createVisitTestIdentities(
          pool,
          suffix
        );

      await configureBusinessTimeZone(
        pool,
        identities
      );

      const fixture =
        await createVisitLifecycleFixture(
          pool,
          identities,
          `payment-reminder-${suffix}`
        );

      const context =
        await loadJobContext(
          pool,
          fixture,
          identities
        );

      const quote =
        await createApprovedDepositQuote(
          pool,
          identities,
          fixture,
          suffix
        );

      assert.ok(
        quote.id
      );

      const materialized =
        await materializePreWorkDepositObligation({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          idempotencyKey:
            `reminder-deposit-materialize-${suffix}`,
          logger:
            quiet,
        });

      assert.equal(
        materialized.ok,
        true,
        materialized.code
      );

      assert.equal(
        materialized.deposit
          .state,
        "DUE"
      );

      assert.equal(
        materialized.deposit
          .remainingMinor,
        51000
      );

      const invoice =
        await insertIssuedInvoice(
          pool,
          {
            fixture,
            identities,
            context,
          }
        );

      // --------------------------------------------------
      // Invoice reminder
      // --------------------------------------------------

      const invoiceBefore =
        await invoiceSnapshot(
          pool,
          invoice.invoiceId
        );

      const invoiceKey =
        `invoice-reminder-${suffix}`;

      const invoiceReminder =
        await sendInvoicePaymentReminder({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          invoiceId:
            invoice.invoiceId,
          expectedVersion: 1,
          idempotencyKey:
            invoiceKey,
        });

      assert.equal(
        invoiceReminder.ok,
        true,
        invoiceReminder.code
      );

      assert.equal(
        invoiceReminder.code,
        "PAYMENT_REMINDER_SENT"
      );

      assert.equal(
        invoiceReminder.reminder
          .sourceType,
        "INVOICE"
      );

      assert.equal(
        invoiceReminder.reminder
          .classification,
        "DUE_TODAY"
      );

      assert.equal(
        invoiceReminder.reminder
          .amountMinor,
        17000
      );

      assert.equal(
        invoiceReminder.reminder
          .timeZone,
        BUSINESS_TIME_ZONE
      );

      assert.equal(
        invoiceReminder.reminder
          .classifiedOn,
        invoice.dueDate
      );

      assert.equal(
        invoiceReminder.reminder
          .sourceVersion,
        1
      );

      assert.equal(
        invoiceReminder.reminder
          .due.date,
        invoice.dueDate
      );

      const invoiceReplay =
        await sendInvoicePaymentReminder({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          invoiceId:
            invoice.invoiceId,
          expectedVersion: 1,
          idempotencyKey:
            invoiceKey,
        });

      assert.equal(
        invoiceReplay.replayed,
        true
      );

      assert.equal(
        invoiceReplay.reminder
          .reminderId,
        invoiceReminder.reminder
          .reminderId
      );

      const invoiceAfter =
        await invoiceSnapshot(
          pool,
          invoice.invoiceId
        );

      assert.deepEqual(
        invoiceAfter,
        invoiceBefore
      );

      const invoiceEvidence =
        await pool.query(
          `SELECT
             count(*)::integer
               AS reminder_count,
             count(DISTINCT message_id)::integer
               AS message_count
           FROM canonical_payment_reminders
           WHERE source_type = 'INVOICE'
             AND invoice_id = $1`,
          [
            invoice.invoiceId,
          ]
        );

      assert.deepEqual(
        invoiceEvidence.rows[0],
        {
          reminder_count: 1,
          message_count: 1,
        }
      );

      const invoiceMessages =
        await pool.query(
          `SELECT
             count(*)::integer
               AS count
           FROM messages
           WHERE message_type =
             'payment_reminder'
             AND workflow_type =
             'PAYMENT_REMINDER'
             AND workflow_payload
               ->> 'reminderId' = $1`,
          [
            invoiceReminder
              .reminder
              .reminderId,
          ]
        );

      assert.equal(
        invoiceMessages.rows[0]
          .count,
        1
      );

      // --------------------------------------------------
      // Deposit DUE reminder
      // --------------------------------------------------

      const depositKey =
        `deposit-reminder-due-${suffix}`;

      const depositReminder =
        await sendDepositPaymentReminder({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          expectedVersion:
            materialized.deposit
              .latestVersion,
          idempotencyKey:
            depositKey,
        });

      assert.equal(
        depositReminder.ok,
        true,
        depositReminder.code
      );

      assert.equal(
        depositReminder.reminder
          .classification,
        "DEPOSIT_DUE"
      );

      assert.equal(
        depositReminder.reminder
          .amountMinor,
        51000
      );

      const depositReplay =
        await sendDepositPaymentReminder({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          expectedVersion:
            materialized.deposit
              .latestVersion,
          idempotencyKey:
            depositKey,
        });

      assert.equal(
        depositReplay.replayed,
        true
      );

      assert.equal(
        depositReplay.reminder
          .reminderId,
        depositReminder.reminder
          .reminderId
      );

      // --------------------------------------------------
      // Establish a real partial payment first.
      // Reminder must not create it.
      // --------------------------------------------------

      const partial =
        await confirmDepositReceived({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          amountMinor:
            20000,
          currency:
            "USD",
          normalizedMethod:
            "CASH",
          displayMethod:
            "Cash",
          externalReference:
            null,
          receivedAt:
            new Date()
              .toISOString(),
          expectedVersion:
            materialized.deposit
              .latestVersion,
          idempotencyKey:
            `reminder-partial-payment-${suffix}`,
          logger:
            quiet,
        });

      assert.equal(
        partial.ok,
        true,
        partial.code
      );

      assert.equal(
        partial.deposit.state,
        "PARTIALLY_SATISFIED"
      );

      assert.equal(
        partial.deposit
          .remainingMinor,
        31000
      );

      const depositBefore =
        await depositSnapshot(
          pool,
          partial.deposit
            .obligationId
        );

      const remainingKey =
        `deposit-reminder-remaining-${suffix}`;

      const remainingReminder =
        await sendDepositPaymentReminder({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          expectedVersion:
            partial.deposit
              .latestVersion,
          idempotencyKey:
            remainingKey,
        });

      assert.equal(
        remainingReminder.ok,
        true,
        remainingReminder.code
      );

      assert.equal(
        remainingReminder.reminder
          .classification,
        "DEPOSIT_REMAINING"
      );

      assert.equal(
        remainingReminder.reminder
          .amountMinor,
        31000
      );

      const depositAfter =
        await depositSnapshot(
          pool,
          partial.deposit
            .obligationId
        );

      assert.deepEqual(
        depositAfter,
        depositBefore
      );

      const depositEvidence =
        await pool.query(
          `SELECT
             classification,
             amount_minor
           FROM canonical_payment_reminders
           WHERE source_type =
             'DEPOSIT'
             AND deposit_obligation_id =
               $1
           ORDER BY sent_at, id`,
          [
            partial.deposit
              .obligationId,
          ]
        );

      assert.deepEqual(
        depositEvidence.rows.map(
          (row) => ({
            classification:
              row.classification,
            amountMinor:
              Number(
                row.amount_minor
              ),
          })
        ),
        [
          {
            classification:
              "DEPOSIT_DUE",
            amountMinor:
              51000,
          },
          {
            classification:
              "DEPOSIT_REMAINING",
            amountMinor:
              31000,
          },
        ]
      );

      // --------------------------------------------------
      // Fail closed on unauthorized/stale commands.
      // --------------------------------------------------

      const outsider =
        await sendInvoicePaymentReminder({
          pool,
          authenticatedActor: {
            id:
              identities.outsiderId,
          },
          invoiceId:
            invoice.invoiceId,
          expectedVersion: 1,
          idempotencyKey:
            `outsider-reminder-${suffix}`,
        });

      assert.equal(
        outsider.ok,
        false
      );

      const stale =
        await sendDepositPaymentReminder({
          pool,
          authenticatedActor: {
            id:
              identities.professionalId,
          },
          jobId:
            fixture.jobId,
          expectedVersion: 1,
          idempotencyKey:
            `stale-reminder-${suffix}`,
        });

      assert.equal(
        stale.code,
        "STALE_PAYMENT_REMINDER_SOURCE"
      );

      // --------------------------------------------------
      // Canonical reminder evidence itself is append-only.
      // --------------------------------------------------

      await assert.rejects(
        pool.query(
          `UPDATE canonical_payment_reminders
           SET message_text =
             'forbidden rewrite'
           WHERE id = $1`,
          [
            invoiceReminder
              .reminder
              .reminderId,
          ]
        )
      );

      // --------------------------------------------------
      // Communication alert exists through canonical
      // message attention; no payment authority is implied.
      // --------------------------------------------------

      const reminderAlert =
        await pool.query(
          `SELECT
             source_domain,
             source_event_type,
             destination_type
           FROM alerts
           WHERE recipient_user_id = $1
             AND source_domain =
               'communication'
             AND destination_type =
               'conversation'
           ORDER BY id DESC
           LIMIT 1`,
          [
            identities.homeownerId,
          ]
        );

      assert.equal(
        reminderAlert.rowCount,
        1
      );

      assert.equal(
        reminderAlert.rows[0]
          .source_event_type,
        "conversation.message_created"
      );

      const migrationLedger =
        await pool.query(
          `SELECT
             filename,
             execution_target
           FROM schema_migrations
           WHERE filename =
             '202609020007_create_payment_reminder_evidence.sql'`
        );

      assert.deepEqual(
        migrationLedger.rows,
        [
          {
            filename:
              "202609020007_create_payment_reminder_evidence.sql",
            execution_target:
              "local-test",
          },
        ]
      );

      console.log(
        JSON.stringify(
          {
            migrationCount:
              migrations.length,
            invoiceReminder:
              invoiceReminder
                .reminder,
            depositDueReminder:
              depositReminder
                .reminder,
            depositRemainingReminder:
              remainingReminder
                .reminder,
          },
          null,
          2
        )
      );
    } finally {
      await pool.end();
    }
  }
);
