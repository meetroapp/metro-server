"use strict";

const SUBJECT = "Reset your Meetro password";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildPasswordResetEmail({ resetUrl, expiresInMinutes }) {
  const url = String(resetUrl || "").trim();
  const expiry = Number(expiresInMinutes);
  if (!url || !Number.isFinite(expiry) || expiry <= 0) {
    throw new Error("A reset URL and positive expiry are required.");
  }

  const expiryText = `${expiry} minute${expiry === 1 ? "" : "s"}`;
  const text = [
    "Meetro Community",
    "",
    "A password reset was requested for your account.",
    `Reset your password: ${url}`,
    "",
    `This link expires in ${expiryText} and works only once.`,
    "If you did not request this reset, ignore this email.",
    "Meetro will never ask for your current password by email.",
  ].join("\n");

  const safeUrl = escapeHtml(url);
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f7f3e8;color:#173f2a;font-family:Arial,sans-serif;">
<main style="max-width:520px;margin:0 auto;padding:28px;background:#fffdf7;border:1px solid #ded6c4;border-radius:8px;">
<p style="margin:0 0 20px;font-size:14px;font-weight:700;">Meetro Community</p>
<h1 style="margin:0 0 12px;font-size:24px;">Reset your password</h1>
<p style="line-height:1.5;">A password reset was requested for your account.</p>
<p style="margin:24px 0;"><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#1f4d34;color:#fff;text-decoration:none;border-radius:6px;">Reset Password</a></p>
<p style="line-height:1.5;">This link expires in ${escapeHtml(expiryText)} and works only once.</p>
<p style="line-height:1.5;color:#5f665f;">If you did not request this reset, ignore this email. Meetro will never ask for your current password by email.</p>
</main></body></html>`;

  return Object.freeze({ subject: SUBJECT, text, html });
}

module.exports = {
  PASSWORD_RESET_SUBJECT: SUBJECT,
  buildPasswordResetEmail,
};
