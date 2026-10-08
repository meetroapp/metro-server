"use strict";
const express = require("express");
const { requireOwner } = require("./stripeConnectAuthority");
const { assertProvider } = require("./stripeConnectProvider");
const { isConnectConfig } = require("./stripeConnectConfig");
const onboarding = require("./stripeConnectOnboardingService");
const webhook = require("./stripeConnectWebhookService");
const WEBHOOK_PATHS = Object.freeze({ THIN: "/connected-services/stripe/webhooks/thin", SNAPSHOT: "/connected-services/stripe/webhooks/snapshot" });
function send(res, result) {
  const { ok, status, ...payload } = result;
  return res.status(status || 500).json({ success: Boolean(ok), ...payload });
}
function createStripeConnectHandlers({ getPool, getRuntime, onboardingService = onboarding, webhookService = webhook }) {
  function runtime() {
    const value = getRuntime();
    if (!isConnectConfig(value?.config) || !value.config.enabled) return null;
    assertProvider(value.provider, value.config, value.config); return value;
  }
  const failed = res => send(res, { ok: false, status: 503, code: "STRIPE_CONNECT_UNAVAILABLE" });
  async function owner(req, res, refresh) {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const body = req.body == null ? {} : req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(req.query || {}).length ||
        Object.keys(body).some(k => !(refresh ? [] : ["intent", "country"]).includes(k))) return send(res, { ok: false, status: 400, code: "STRIPE_CONNECT_INVALID_COMMAND" });
      const command = refresh ? { intent: "REFRESH" } : body;
      const authority = await requireOwner({ pool: getPool(req), authenticatedActor: req.user, command });
      if (!authority.ok) return send(res, authority);
      const selected = runtime(); if (!selected) return failed(res);
      const options = { pool: getPool(req), authenticatedActor: req.user, ...selected };
      const result = refresh ? await onboardingService.refresh(options) :
        await onboardingService.onboard({ ...options, command, idempotencyKey: req.get("Idempotency-Key") });
      return send(res, result);
    } catch { return failed(res); }
  }
  async function receive(req, res, format) {
    res.setHeader("Cache-Control", "no-store");
    try {
      const selected = runtime(); if (!selected) return failed(res);
      const result = await webhookService.receive({ pool: getPool(req), ...selected, rawBody: req.body,
        signature: req.get("Stripe-Signature"), format });
      if (result.ok && result.processable) {
        const processed = await webhookService.processEvent({ pool: getPool(req), ...selected, eventId: result.eventId });
        if (!processed.ok) return send(res, { ok: false, status: 503, code: "EVENT_PROCESSING_UNAVAILABLE" });
      }
      // Internal ledger/work identity never becomes caller-controlled authority.
      const { eventId, processable, ...publicResult } = result;
      return send(res, publicResult);
    } catch { return failed(res); }
  }
  return { onboard: (req, res) => owner(req, res, false), refresh: (req, res) => owner(req, res, true),
    thin: (req, res) => receive(req, res, "THIN"), snapshot: (req, res) => receive(req, res, "SNAPSHOT") };
}
function registerStripeConnectWebhooks(options) {
  const h = createStripeConnectHandlers(options);
  const raw = express.raw({ type: "application/json", limit: "256kb", inflate: false });
  options.app.post("/connected-services/stripe/webhooks/thin", raw, h.thin);
  options.app.post("/connected-services/stripe/webhooks/snapshot", raw, h.snapshot);
}
function registerStripeConnectOwnerRoutes(options) {
  const h = createStripeConnectHandlers(options);
  options.app.post("/connected-services/stripe/onboarding", options.authMiddleware, h.onboard);
  options.app.post("/connected-services/stripe/refresh", options.authMiddleware, h.refresh);
}
module.exports = { WEBHOOK_PATHS, createStripeConnectHandlers, registerStripeConnectWebhooks, registerStripeConnectOwnerRoutes };
