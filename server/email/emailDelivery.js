"use strict";

const { createResendEmailProvider } = require("./resendEmailProvider");

function createUnavailableDelivery(status) {
  return Object.freeze({
    configured: false,
    providerName: "unavailable",
    async sendSecurityVerificationCode() {
      return { accepted: false, status };
    },
    async sendPasswordResetEmail() {
      return { accepted: false, status };
    },
  });
}

function createEmailDelivery({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const providerName = String(env.EMAIL_PROVIDER || "").trim().toLowerCase();

  if (!providerName) return createUnavailableDelivery("provider_not_configured");
  if (providerName !== "resend") return createUnavailableDelivery("unsupported_provider");

  return createResendEmailProvider({
    apiKey: env.RESEND_API_KEY,
    from: env.SECURITY_EMAIL_FROM,
    replyTo: env.SECURITY_EMAIL_REPLY_TO,
    fetchImpl,
  });
}

module.exports = { createEmailDelivery };
