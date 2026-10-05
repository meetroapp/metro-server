"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  CONNECTED_SERVICE_STATUS,
  CONNECTED_SERVICE_CAPABILITY,
  CONNECTED_SERVICE_PROVIDER,
  getConnectedServiceProviders,
} = require("../server/integrations/connectedServicesRegistry");

test("Connected Services registry mirrors the frozen provider-neutral client contract", () => {
  assert.deepEqual(CONNECTED_SERVICE_STATUS, {
    COMING_SOON: "COMING_SOON",
    NOT_CONNECTED: "NOT_CONNECTED",
    CONNECTED: "CONNECTED",
    NEEDS_ATTENTION: "NEEDS_ATTENTION",
    UNAVAILABLE: "UNAVAILABLE",
  });

  assert.deepEqual(CONNECTED_SERVICE_CAPABILITY, {
    PAYMENTS: "PAYMENTS",
    ACCOUNTING: "ACCOUNTING",
    CALENDAR: "CALENDAR",
  });

  assert.deepEqual(CONNECTED_SERVICE_PROVIDER, {
    STRIPE_PAYMENTS: "STRIPE_PAYMENTS",
    QUICKBOOKS: "QUICKBOOKS",
    GOOGLE_CALENDAR: "GOOGLE_CALENDAR",
    MICROSOFT_OUTLOOK_CALENDAR:
      "MICROSOFT_OUTLOOK_CALENDAR",
  });

  assert.deepEqual(getConnectedServiceProviders(), [
    {
      provider: "STRIPE_PAYMENTS",
      capability: "PAYMENTS",
      name: "Stripe Payments",
      status: "COMING_SOON",
    },
    {
      provider: "QUICKBOOKS",
      capability: "ACCOUNTING",
      name: "QuickBooks",
      status: "COMING_SOON",
    },
    {
      provider: "GOOGLE_CALENDAR",
      capability: "CALENDAR",
      name: "Google Calendar",
      status: "COMING_SOON",
    },
    {
      provider: "MICROSOFT_OUTLOOK_CALENDAR",
      capability: "CALENDAR",
      name: "Microsoft Outlook Calendar",
      status: "COMING_SOON",
    },
  ]);
});

test("R2 registry has no provider connection or Meetro subscription authority", () => {
  const root = path.join(__dirname, "..");
  const source = [
    "server/integrations/connectedServicesRegistry.js",
    "server/integrations/connectedServicesService.js",
    "server/integrations/connectedServices.js",
  ]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");

  assert.doesNotMatch(
    source,
    /professional_subscription_accounts|professional_subscriptions|stripe_customer_id|billingPortal|checkout\.sessions|paymentIntents|accountLinks|oauth|webhook/i
  );
  assert.doesNotMatch(
    source,
    /canonical_pre_work_payment_receipts|canonical_invoice_payments|deposit\.payment\.record|payment\.record/i
  );
});
