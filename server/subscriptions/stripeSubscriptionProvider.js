"use strict";

const Stripe = require("stripe");

function createStripeSubscriptionProvider(environment = process.env) {
  const secretKey = String(environment.STRIPE_SECRET_KEY || "").trim();
  const webhookSecret = String(environment.STRIPE_WEBHOOK_SECRET || "").trim();
  const client = secretKey ? new Stripe(secretKey) : null;
  return {
    configured: Boolean(client && webhookSecret),
    checkoutConfigured: Boolean(client),
    webhookConfigured: Boolean(webhookSecret),
    async createCustomer(params, options) { return client.customers.create(params, options); },
    async createCheckoutSession(params, options) { return client.checkout.sessions.create(params, options); },
    async createPortalSession(params) { return client.billingPortal.sessions.create(params); },
    async retrievePrice(id) { return client.prices.retrieve(id); },
    async retrieveSubscription(id) { return client.subscriptions.retrieve(id); },
    constructEvent(rawBody, signature) {
      if (!client || !webhookSecret) throw new Error("Stripe webhook verification is not configured.");
      return client.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}

module.exports = { createStripeSubscriptionProvider };
