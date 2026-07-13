"use strict";

const SUBJECT = "Your Meetro verification code";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildSecurityVerificationEmail({ code, expiresInMinutes }) {
  const safeCode = String(code || "").trim();
  const safeExpiry = Number(expiresInMinutes);

  if (!/^\d{6}$/.test(safeCode)) {
    throw new Error("A six-digit verification code is required.");
  }
  if (!Number.isFinite(safeExpiry) || safeExpiry <= 0) {
    throw new Error("A positive verification expiry is required.");
  }

  const expiryText = `${safeExpiry} minute${safeExpiry === 1 ? "" : "s"}`;
  const text = [
    "Meetro Community",
    "",
    "Use this verification code to continue your login:",
    safeCode,
    "",
    `This code expires in ${expiryText} and works only once.`,
    "If you did not request this login, ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f7f3e8;color:#173f2a;font-family:Arial,sans-serif;">
    <main style="max-width:520px;margin:0 auto;padding:28px;background:#fffdf7;border:1px solid #ded6c4;border-radius:8px;">
      <p style="margin:0 0 20px;font-size:14px;font-weight:700;">Meetro Community</p>
      <h1 style="margin:0 0 12px;font-size:24px;">Your verification code</h1>
      <p style="margin:0 0 20px;line-height:1.5;">Use this code to continue your login.</p>
      <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;">${escapeHtml(safeCode)}</p>
      <p style="margin:0 0 8px;line-height:1.5;">This code expires in ${escapeHtml(expiryText)} and works only once.</p>
      <p style="margin:0;line-height:1.5;color:#5f665f;">If you did not request this login, ignore this email.</p>
    </main>
  </body>
</html>`;

  return Object.freeze({ subject: SUBJECT, text, html });
}

module.exports = {
  SECURITY_VERIFICATION_SUBJECT: SUBJECT,
  buildSecurityVerificationEmail,
};
