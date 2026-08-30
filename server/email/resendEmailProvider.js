"use strict";

const { buildSecurityVerificationEmail } = require("./securityVerificationEmail");
const { buildPasswordResetEmail } = require("./passwordResetEmail");
const { buildTeamInvitationEmail } = require("./teamInvitationEmail");

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
      async sendBusinessDocumentEmail() {
        return { accepted: false, status: "configuration_error" };
      },
      async sendTeamInvitationEmail() {
        return { accepted: false, status: "configuration_error" };
      },
    });
  }

  async function sendEmail({ recipientEmail, subject, text, html, idempotencyKey, attachments }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(RESEND_EMAIL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${normalizedApiKey}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {}),
        },
        body: JSON.stringify({
          from: normalizedFrom,
          to: [String(recipientEmail || "").trim()],
          subject,
          text,
          html,
          ...(Array.isArray(attachments) && attachments.length ? {
            attachments: attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              content_type: attachment.contentType,
            })),
          } : {}),
          ...(normalizedReplyTo ? { reply_to: normalizedReplyTo } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { accepted: false, status: "provider_rejected" };
      let providerReference = null;
      try {
        const result = await response.json();
        providerReference = typeof result?.id === "string" ? result.id : null;
      } catch {
        // A provider acceptance without a response identifier remains truthful.
      }
      return {
        accepted: true,
        status: "accepted",
        ...(providerReference ? { providerReference } : {}),
      };
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
    async sendBusinessDocumentEmail({
      recipientEmail,
      subject,
      text,
      html,
      attachment,
      idempotencyKey,
    }) {
      return sendEmail({
        recipientEmail,
        subject,
        text,
        html,
        idempotencyKey,
        attachments: attachment ? [attachment] : [],
      });
    },
    async sendTeamInvitationEmail({
      recipientEmail,
      businessName,
      role,
      joinUrl,
      idempotencyKey,
    }) {
      const email = buildTeamInvitationEmail({
        businessName,
        role,
        joinUrl,
      });
      return sendEmail({
        recipientEmail,
        ...email,
        idempotencyKey,
      });
    },
  });
}

module.exports = {
  RESEND_EMAIL_ENDPOINT,
  createResendEmailProvider,
};
