"use strict";

const CONNECTED_SERVICE_STATUS = Object.freeze({
  COMING_SOON: "COMING_SOON",
  NOT_CONNECTED: "NOT_CONNECTED",
  CONNECTED: "CONNECTED",
  NEEDS_ATTENTION: "NEEDS_ATTENTION",
  UNAVAILABLE: "UNAVAILABLE",
});

const CONNECTED_SERVICE_CAPABILITY = Object.freeze({
  PAYMENTS: "PAYMENTS",
  ACCOUNTING: "ACCOUNTING",
  CALENDAR: "CALENDAR",
});

const CONNECTED_SERVICE_PROVIDER = Object.freeze({
  STRIPE_PAYMENTS: "STRIPE_PAYMENTS",
  QUICKBOOKS: "QUICKBOOKS",
  GOOGLE_CALENDAR: "GOOGLE_CALENDAR",
  MICROSOFT_OUTLOOK_CALENDAR: "MICROSOFT_OUTLOOK_CALENDAR",
});

/*
 * Connected Services is external Business integration authority.
 *
 * Meetro subscription billing is intentionally outside this registry.
 * A Stripe Customer used by a Business to pay Meetro for software access is
 * not merchant/payment connection authority and must never be treated as one.
 */
const CONNECTED_SERVICE_PROVIDERS = Object.freeze([
  Object.freeze({
    provider: CONNECTED_SERVICE_PROVIDER.STRIPE_PAYMENTS,
    capability: CONNECTED_SERVICE_CAPABILITY.PAYMENTS,
    name: "Stripe Payments",
    status: CONNECTED_SERVICE_STATUS.COMING_SOON,
  }),
  Object.freeze({
    provider: CONNECTED_SERVICE_PROVIDER.QUICKBOOKS,
    capability: CONNECTED_SERVICE_CAPABILITY.ACCOUNTING,
    name: "QuickBooks",
    status: CONNECTED_SERVICE_STATUS.COMING_SOON,
  }),
  Object.freeze({
    provider: CONNECTED_SERVICE_PROVIDER.GOOGLE_CALENDAR,
    capability: CONNECTED_SERVICE_CAPABILITY.CALENDAR,
    name: "Google Calendar",
    status: CONNECTED_SERVICE_STATUS.COMING_SOON,
  }),
  Object.freeze({
    provider: CONNECTED_SERVICE_PROVIDER.MICROSOFT_OUTLOOK_CALENDAR,
    capability: CONNECTED_SERVICE_CAPABILITY.CALENDAR,
    name: "Microsoft Outlook Calendar",
    status: CONNECTED_SERVICE_STATUS.COMING_SOON,
  }),
]);

function getConnectedServiceProviders() {
  return CONNECTED_SERVICE_PROVIDERS.map((provider) =>
    Object.freeze({ ...provider })
  );
}

module.exports = {
  CONNECTED_SERVICE_STATUS,
  CONNECTED_SERVICE_CAPABILITY,
  CONNECTED_SERVICE_PROVIDER,
  getConnectedServiceProviders,
};
