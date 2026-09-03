"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const sql = readFileSync(
  path.join(
    __dirname,
    "../migrations/202609020007_create_payment_reminder_evidence.sql"
  ),
  "utf8"
);

test("Payment Reminder migration creates separate communication evidence, not Payment authority", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_payment_reminder_command_idempotency/i
  );
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_payment_reminders/i
  );
  assert.match(
    sql,
    /command_name = 'payment\.reminder\.send'/i
  );
  assert.match(
    sql,
    /source_type IN \('INVOICE', 'DEPOSIT'\)/i
  );
  assert.match(
    sql,
    /classification IN \([\s\S]*'UPCOMING_DUE'[\s\S]*'DUE_TODAY'[\s\S]*'OVERDUE'[\s\S]*'DEPOSIT_DUE'[\s\S]*'DEPOSIT_REMAINING'/i
  );
  assert.match(
    sql,
    /classification_time_zone TEXT NOT NULL/i
  );

  assert.match(
    sql,
    /timeZone'[\s\S]*classification_time_zone/i
  );

  assert.match(
    sql,
    /message_type IS DISTINCT FROM 'payment_reminder'/i
  );
  assert.match(
    sql,
    /v_message_workflow_type IS DISTINCT FROM[\s\S]*'PAYMENT_REMINDER'/i
  );
  assert.match(
    sql,
    /canonical_payment_reminders_append_only/i
  );

  assert.doesNotMatch(
    sql,
    /UPDATE\s+canonical_invoice_versions/i
  );
  assert.doesNotMatch(
    sql,
    /UPDATE\s+canonical_pre_work_deposit_versions/i
  );
  assert.doesNotMatch(
    sql,
    /INSERT INTO\s+canonical_invoice_payments/i
  );
  assert.doesNotMatch(
    sql,
    /INSERT INTO\s+canonical_pre_work_payment_receipts/i
  );
});

test("Payment Reminder evidence is Meetro-customer-only in R1A", () => {
  assert.match(
    sql,
    /ordinary_request_selection/i
  );
  assert.match(
    sql,
    /v_source_approval IS DISTINCT FROM[\s\S]*'MEETRO_CUSTOMER'/i
  );
  assert.match(
    sql,
    /active governed customer conversation/i
  );
});
