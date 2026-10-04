"use strict";

const assert = require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const {
  join,
} = require("node:path");
const test = require("node:test");

const {
  ACTIONABLE_WORK_CENTER_EVENT_TYPES,
} = require(
  "../server/alerts/workCenterAttention"
);

const expected = [
  "visit.proposed",
  "visit.schedule_proposed",
  "visit.change_requested",
  "quote.delivered",
  "deposit.required",
  "deposit.request_sent",
  "deposit.payment_recorded",
  "invoice.delivered",
  "invoice.payment_recorded",
];

test("Work Center actionable event registry is exact and bounded", () => {
  assert.deepEqual(
    ACTIONABLE_WORK_CENTER_EVENT_TYPES,
    expected
  );

  for (const informational of [
    "visit.confirmed",
    "visit.cancelled",
    "visit.started",
    "visit.completed",
    "deposit.satisfied",
    "work.completed",
    "invoice.paid",
  ]) {
    assert.equal(
      ACTIONABLE_WORK_CENTER_EVENT_TYPES.includes(
        informational
      ),
      false
    );
  }
});

test("read informational Alerts disappear but active actionable Alerts retain Work Center attention", () => {
  const source = readFileSync(
    join(
      __dirname,
      "..",
      "server",
      "alerts",
      "workCenterAttention.js"
    ),
    "utf8"
  );

  assert.match(
    source,
    /alerts\.lifecycle_state = 'active'/
  );

  assert.match(
    source,
    /alerts\.read_at IS NULL[\s\S]*OR alerts\.source_event_type IN/
  );

  for (const eventType of expected) {
    assert.match(
      source,
      new RegExp(
        eventType.replaceAll(".", "\\.")
      )
    );
  }

  assert.match(
    source,
    /quote\.customer_approved[\s\S]*workCenterStage' = 'deposit'/
  );
});

test("sending the explicit Deposit Request resolves the Business Quote-approved action", () => {
  const source = readFileSync(
    join(
      __dirname,
      "..",
      "server",
      "documents",
      "businessDocumentDeliveryService.js"
    ),
    "utf8"
  );

  assert.match(
    source,
    /sourceEntityType:\s*"quote"[\s\S]*sourceEntityId:\s*deposit\.quoteId[\s\S]*"quote\.customer_approved"[\s\S]*recipientUserId:\s*values\.actorUserId/
  );

  assert.match(
    source,
    /sourceEventType:\s*"deposit\.request_sent"/
  );
});
