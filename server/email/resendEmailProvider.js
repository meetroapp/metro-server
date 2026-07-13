"use strict";

const { buildSecurityVerificationEmail } = require("./securityVerificationEmail");

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
    });
  }

  return Object.freeze({
    configured: true,
    providerName: "resend",
    async sendSecurityVerificationCode({ recipientEmail, code, expiresInMinutes }) {
      const email = buildSecurityVerificationEmail({ code, expiresInMinutes });
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
            subject: email.subject,
            text: email.text,
            html: email.html,
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
    },
  });
}

module.exports = {
  RESEND_EMAIL_ENDPOINT,
  createResendEmailProvider,
};
