"use strict";

const { buildSecurityVerificationEmail } = require("./securityVerificationEmail");
const { buildPasswordResetEmail } = require("./passwordResetEmail");

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";

function createResendEmailProvider({
  apiKey,
  from,
  replyTo,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const normalizedApiKey = String(apiKey || "").trim();
  const normalizedFrom = String(from || "").trim();
  const normalizedReplyTo = String(replyTo || "").trim();

  if (!normalizedApiKey || !normalizedFrom || typeof fetchImpl !== "function") {
    return Object.freeze({
      configured: false,
      providerName: "resend",
      async sendSecurityVerificationCode() {
        return { accepted: false, status: "configuration_error" };
      },
      async sendPasswordResetEmail() {
        return { accepted: false, status: "configuration_error" };
      },
    });
  }

  async function sendEmail({ recipientEmail, subject, text, html }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(RESEND_EMAIL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${normalizedApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: normalizedFrom,
          to: [String(recipientEmail || "").trim()],
          subject,
          text,
          html,
          ...(normalizedReplyTo ? { reply_to: normalizedReplyTo } : {}),
        }),
        signal: controller.signal,
      });
      return response.ok
        ? { accepted: true, status: "accepted" }
        : { accepted: false, status: "provider_rejected" };
    } catch (error) {
      return {
        accepted: false,
        status: error?.name === "AbortError" ? "timeout" : "provider_unavailable",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({
    configured: true,
    providerName: "resend",
    async sendSecurityVerificationCode({ recipientEmail, code, expiresInMinutes }) {
      const email = buildSecurityVerificationEmail({ code, expiresInMinutes });
      return sendEmail({ recipientEmail, ...email });
    },
    async sendPasswordResetEmail({ recipientEmail, resetUrl, expiresInMinutes }) {
      const email = buildPasswordResetEmail({ resetUrl, expiresInMinutes });
      return sendEmail({ recipientEmail, ...email });
    },
  });
}

module.exports = {
  RESEND_EMAIL_ENDPOINT,
  createResendEmailProvider,
};
