"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");
const {
  readFileSync,
} = require("node:fs");

const {
  INVOICE_CLASSIFICATIONS,
  DEPOSIT_CLASSIFICATIONS,
  paymentReminderInternals,
} = require(
  "../server/finance/paymentReminderService"
);


test("business timezone prevents UTC midnight from advancing Reminder classification early", () => {
  assert.equal(
    paymentReminderInternals.dateInTimeZone(
      "America/New_York",
      new Date(
        "2026-09-03T02:55:00.000Z"
      )
    ),
    "2026-09-02"
  );

  assert.equal(
    paymentReminderInternals.dateInTimeZone(
      "Europe/London",
      new Date(
        "2026-09-03T02:55:00.000Z"
      )
    ),
    "2026-09-03"
  );
});

test("Invoice Reminder classification is server-derived from exact due truth", () => {
  assert.equal(
    paymentReminderInternals
      .classifyInvoiceReminder({
        dueMode:
          "SPECIFIC_DATE",
        dueDate:
          "2026-09-05",
        classifiedOn:
          "2026-09-02",
      })
      .classification,
    INVOICE_CLASSIFICATIONS
      .UPCOMING_DUE
  );

  assert.equal(
    paymentReminderInternals
      .classifyInvoiceReminder({
        dueMode:
          "SPECIFIC_DATE",
        dueDate:
          "2026-09-02",
        classifiedOn:
          "2026-09-02",
      })
      .classification,
    INVOICE_CLASSIFICATIONS
      .DUE_TODAY
  );

  assert.equal(
    paymentReminderInternals
      .classifyInvoiceReminder({
        dueMode:
          "SPECIFIC_DATE",
        dueDate:
          "2026-08-31",
        classifiedOn:
          "2026-09-02",
      })
      .classification,
    INVOICE_CLASSIFICATIONS
      .OVERDUE
  );
});

test("Due-on-receipt Reminder uses canonical issuance date as effective due date", () => {
  const result =
    paymentReminderInternals
      .classifyInvoiceReminder({
        dueMode:
          "DUE_ON_RECEIPT",
        issuedAt:
          "2026-08-31T18:00:00.000Z",
        invoiceDate:
          "2026-08-31",
        classifiedOn:
          "2026-09-02",
      });

  assert.equal(
    result.classification,
    INVOICE_CLASSIFICATIONS
      .OVERDUE
  );

  assert.deepEqual(
    result.due,
    {
      mode:
        "DUE_ON_RECEIPT",
      date: null,
      effectiveDate:
        "2026-08-31",
    }
  );
});


test("PostgreSQL DATE objects normalize to exact date-only Reminder evidence", () => {
  const reminder =
    paymentReminderInternals
      .reminderProjection({
        id:
          "88888888-8888-4888-8888-888888888888",
        source_type:
          "INVOICE",
        invoice_id:
          "11111111-1111-4111-8111-111111111111",
        deposit_obligation_id:
          null,
        job_id:
          "22222222-2222-4222-8222-222222222222",
        relationship_id:
          9,
        conversation_id:
          340,
        message_id:
          601,
        source_version:
          3,
        classification:
          "OVERDUE",
        classified_on:
          new Date(
            "2026-09-02T00:00:00.000Z"
          ),
        currency:
          "USD",
        amount_minor:
          17000,
        due_mode:
          "SPECIFIC_DATE",
        due_date:
          new Date(
            "2026-08-31T00:00:00.000Z"
          ),
        effective_due_date:
          new Date(
            "2026-08-31T00:00:00.000Z"
          ),
        message_text:
          "Payment reminder.",
        sent_at:
          new Date(
            "2026-09-02T22:00:00.000Z"
          ),
      });

  assert.equal(
    reminder.classifiedOn,
    "2026-09-02"
  );

  assert.deepEqual(
    reminder.due,
    {
      mode:
        "SPECIFIC_DATE",
      date:
        "2026-08-31",
      effectiveDate:
        "2026-08-31",
    }
  );
});

test("Reminder wording preserves canonical amount without creating payment truth", () => {
  assert.match(
    paymentReminderInternals
      .defaultInvoiceReminderMessage({
        invoiceNumber:
          "INV-ABC123",
        amountMinor:
          17000,
        currency:
          "USD",
        classification:
          INVOICE_CLASSIFICATIONS
            .OVERDUE,
        due: {
          effectiveDate:
            "2026-08-31",
        },
      }),
    /USD 170\.00/
  );

  assert.match(
    paymentReminderInternals
      .defaultDepositReminderMessage({
        amountMinor:
          31000,
        currency:
          "USD",
        classification:
          DEPOSIT_CLASSIFICATIONS
            .REMAINING,
      }),
    /USD 310\.00/
  );
});

test("Reminder service reads canonical balances and never mutates Payment or scheduling truth", () => {
  const source =
    readFileSync(
      require.resolve(
        "../server/finance/paymentReminderService"
      ),
      "utf8"
    );

  assert.match(
    source,
    /invoice\.balance_minor/
  );

  assert.match(
    source,
    /deposit\.remaining_minor/
  );

  assert.match(
    source,
    /Number\(invoice\.version\)[\s\S]*expectedVersion/
  );

  assert.match(
    source,
    /Number\(deposit\.version\)[\s\S]*expectedVersion/
  );

  assert.match(
    source,
    /createPaymentReminderMessageWithClient/
  );

  assert.match(
    source,
    /INSERT INTO canonical_payment_reminders/
  );

  assert.match(
    source,
    /SELECT messages\.created_at[\s\S]*WHERE messages\.id = \$22/
  );

  assert.doesNotMatch(
    source,
    /Number\(message\.id\),\s*message\.created_at/
  );


  assert.match(
    source,
    /SELECT messages\.created_at[\s\S]*WHERE messages\.id = \$22/
  );

  assert.doesNotMatch(
    source,
    /Number\(message\.id\),\s*message\.created_at/
  );


  assert.doesNotMatch(
    source,
    /INSERT INTO canonical_invoice_payments/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO canonical_pre_work_payment_receipts/
  );

  assert.doesNotMatch(
    source,
    /UPDATE canonical_invoice_versions/
  );

  assert.doesNotMatch(
    source,
    /UPDATE canonical_pre_work_deposit_versions/
  );

  assert.doesNotMatch(
    source,
    /scheduling_locked\s*=|schedulingLocked\s*=/
  );
});

test("R1A reminder service requires ordinary Meetro customer provenance", () => {
  const source =
    readFileSync(
      require.resolve(
        "../server/finance/paymentReminderService"
      ),
      "utf8"
    );

  assert.match(
    source,
    /ordinary_request_selection/
  );

  assert.match(
    source,
    /approval\.approval_source !==[\s\S]*"MEETRO_CUSTOMER"/
  );

  assert.match(
    source,
    /conversation_status[\s\S]*"active"/
  );

  assert.match(
    source,
    /PAYMENT_REMINDER_TIME_ZONE_REQUIRED/
  );

  assert.match(
    source,
    /business_time_zone/
  );
});
