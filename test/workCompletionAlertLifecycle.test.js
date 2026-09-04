"use strict";

const assert = require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const {
  join,
} = require("node:path");
const test = require("node:test");

function source(relativePath) {
  return readFileSync(
    join(__dirname, "..", relativePath),
    "utf8"
  );
}

test("canonical Job completion notifies the customer and points to Completion", () => {
  const jobCompletion = source(
    "server/workflow/jobCompletionService.js"
  );

  assert.match(
    jobCompletion,
    /relationships\.homeowner_id/
  );

  assert.match(
    jobCompletion,
    /sourceEventType:\s*"work\.completed"/
  );

  assert.match(
    jobCompletion,
    /sourceEntityType:\s*"job"/
  );

  assert.match(
    jobCompletion,
    /sourceEventId:\s*completionId/
  );

  assert.match(
    jobCompletion,
    /category:\s*"completion"/
  );

  assert.match(
    jobCompletion,
    /workCenterStage:\s*"completion"/
  );

  assert.match(
    jobCompletion,
    /type:\s*"job"[\s\S]*jobId:\s*validated\.jobId/
  );
});

test("Invoice delivery supersedes Work Completed and moves attention to Invoice", () => {
  const invoice = source(
    "server/finance/invoicePaymentService.js"
  );

  assert.match(
    invoice,
    /sourceDomain:\s*"workflow"[\s\S]*sourceEntityType:\s*"job"[\s\S]*sourceEventTypes:\s*\[[\s\S]*"work\.completed"/
  );

  assert.match(
    invoice,
    /sourceEventType:\s*"invoice\.delivered"[\s\S]*workCenterStage:\s*"invoice"/
  );
});

test("Invoice partial-payment attention is superseded by each newer payment", () => {
  const invoice = source(
    "server/finance/invoicePaymentService.js"
  );

  assert.match(
    invoice,
    /sourceEventTypes:\s*\[[\s\S]*"invoice\.payment_recorded"[\s\S]*\]/
  );

  assert.match(
    invoice,
    /sourceEventType:\s*status === "PAID"[\s\S]*"invoice\.paid"[\s\S]*"invoice\.payment_recorded"/
  );
});

test("fully paid Invoice guides to Completion while partial payment remains in Invoice", () => {
  const invoice = source(
    "server/finance/invoicePaymentService.js"
  );

  assert.match(
    invoice,
    /workCenterStage:[\s\S]*status === "PAID"[\s\S]*\? "completion"[\s\S]*: "invoice"/
  );
});
