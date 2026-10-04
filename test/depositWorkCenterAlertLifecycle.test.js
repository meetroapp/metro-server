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

test("explicit Meetro Deposit Request delivery creates canonical Deposit Work Center attention", () => {
  const delivery = source(
    "server/documents/businessDocumentDeliveryService.js"
  );

  assert.match(
    delivery,
    /documentType === "DEPOSIT_REQUEST"[\s\S]*sourceEventType:\s*"deposit\.request_sent"/
  );

  assert.match(
    delivery,
    /sourceEntityType:\s*"deposit_obligation"/
  );

  assert.match(
    delivery,
    /sourceEntityId:[\s\S]*deposit\.paymentRequirementId/
  );

  assert.match(
    delivery,
    /sourceEventTypes:[\s\S]*"deposit\.required"[\s\S]*"deposit\.request_sent"/
  );

  assert.match(
    delivery,
    /workCenterStage:\s*"deposit"/
  );

  assert.match(
    delivery,
    /type:\s*"quote"[\s\S]*jobId:\s*deposit\.jobId[\s\S]*quoteId:\s*deposit\.quoteId/
  );
});

test("partial confirmed Deposit payment produces current Deposit Work Center attention", () => {
  const deposit = source(
    "server/finance/preWorkDepositService.js"
  );

  assert.match(
    deposit,
    /sourceEventType:[\s\S]*"deposit\.payment_recorded"/
  );

  assert.match(
    deposit,
    /state === "SATISFIED"[\s\S]*else if \(customerUserId\)[\s\S]*deposit\.payment_recorded/
  );

  assert.match(
    deposit,
    /depositPaymentRecorded\.title/
  );

  assert.match(
    deposit,
    /workCenterStage:\s*"deposit"/
  );
});

test("full Deposit satisfaction retires due request and partial-payment attention", () => {
  const deposit = source(
    "server/finance/preWorkDepositService.js"
  );

  assert.match(
    deposit,
    /sourceEventTypes:\s*\[[\s\S]*"deposit\.required"[\s\S]*"deposit\.request_sent"[\s\S]*"deposit\.payment_recorded"[\s\S]*\]/
  );

  assert.match(
    deposit,
    /sourceEventType:\s*"deposit\.satisfied"/
  );
});

test("Deposit Request delivery remains durable Payment Request conversation evidence", () => {
  const delivery = source(
    "server/documents/businessDocumentDeliveryService.js"
  );

  assert.match(
    delivery,
    /messageType:\s*"payment_request"/
  );

  assert.match(
    delivery,
    /workflowType:\s*"PAYMENT_REQUEST"/
  );

  assert.match(
    delivery,
    /depositRequestDocumentId/
  );

  assert.match(
    delivery,
    /paymentRequirementId/
  );
});
