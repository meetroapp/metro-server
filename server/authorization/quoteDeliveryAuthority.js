"use strict";

const { createHash } = require("node:crypto");

const COMMAND_NAME = "professional.quote.send_in_meetro";
const COPY_COMMAND_NAME = "professional.quote.send_copy_in_meetro";
const DELIVERY_INTENT = Object.freeze({
  INITIAL: "INITIAL",
  COPY: "COPY",
});
const MESSAGE_TYPE = "quote_shared";
const WORKFLOW_TYPE = "QUOTE_SHARED";
const WORKFLOW_STATUS = "SENT";

function quoteDeliveryRequestFingerprint({
  actorId,
  quoteId,
  expectedIssuedVersion,
  deliveryIntent = DELIVERY_INTENT.INITIAL,
}) {
  const command = deliveryIntent === DELIVERY_INTENT.COPY
    ? COPY_COMMAND_NAME
    : COMMAND_NAME;
  return createHash("sha256").update(JSON.stringify({
    command,
    actorId,
    quoteId,
    expectedIssuedVersion,
  })).digest("hex");
}

function quoteDeliveryFingerprintMap(rows, actorId) {
  return Object.fromEntries(
    (Array.isArray(rows) ? rows : []).map((row) => [
      row.id,
      quoteDeliveryRequestFingerprint({
        actorId,
        quoteId: row.id,
        expectedIssuedVersion: Number(row.current_version),
      }),
    ])
  );
}

module.exports = Object.freeze({
  COMMAND_NAME,
  COPY_COMMAND_NAME,
  DELIVERY_INTENT,
  MESSAGE_TYPE,
  WORKFLOW_STATUS,
  WORKFLOW_TYPE,
  quoteDeliveryFingerprintMap,
  quoteDeliveryRequestFingerprint,
});
