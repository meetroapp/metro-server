"use strict";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roleLabel(role) {
  const normalized = String(role || "").trim().toUpperCase();
  if (normalized === "FIELD_EMPLOYEE") return "Field Employee";
  if (normalized === "BOOKKEEPER_FINANCE") return "Bookkeeper / Finance";
  if (normalized === "MANAGER") return "Manager";
  return normalized
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeJoinUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("A Team invitation URL is required.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("A valid Team invitation URL is required.");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("A valid Team invitation URL is required.");
  }
  return parsed.toString();
}

function buildTeamInvitationEmail({ businessName, role, joinUrl }) {
  const safeBusinessName = String(businessName || "").trim();
  if (!safeBusinessName) {
    throw new Error("A Business name is required for a Team invitation.");
  }

  const safeRole = roleLabel(role);
  const safeJoinUrl = normalizeJoinUrl(joinUrl);

  const subject = `You're invited to join ${safeBusinessName} on Meetro`;

  const text = [
    "Meetro Community",
    "",
    `${safeBusinessName} invited you to join their Meetro Team.`,
    "",
    `Role: ${safeRole}`,
    "",
    "Join Team:",
    safeJoinUrl,
    "",
    "Use the invited email address to sign in or create your Meetro account.",
    "You do not need to purchase a Meetro subscription. Your access is provided by the business that invited you.",
    "",
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f7f3e8;color:#173f2a;font-family:Arial,sans-serif;">
    <main style="max-width:560px;margin:0 auto;padding:28px;background:#fffdf7;border:1px solid #ded6c4;border-radius:12px;">
      <p style="margin:0 0 20px;font-size:14px;font-weight:700;">Meetro Community</p>
      <h1 style="margin:0 0 12px;font-size:24px;">You're invited to join ${escapeHtml(safeBusinessName)}</h1>
      <p style="margin:0 0 18px;line-height:1.5;">${escapeHtml(safeBusinessName)} invited you to join their Meetro Team.</p>
      <p style="margin:0 0 22px;line-height:1.5;"><strong>Role:</strong> ${escapeHtml(safeRole)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(safeJoinUrl)}"
           style="display:inline-block;padding:12px 18px;background:#173f2a;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">
          Join Team
        </a>
      </p>
      <p style="margin:0 0 10px;line-height:1.5;">Use the invited email address to sign in or create your Meetro account.</p>
      <p style="margin:0 0 10px;line-height:1.5;">You do not need to purchase a Meetro subscription. Your access is provided by the business that invited you.</p>
      <p style="margin:18px 0 0;line-height:1.5;color:#5f665f;">If you were not expecting this invitation, you can ignore this email.</p>
    </main>
  </body>
</html>`;

  return Object.freeze({ subject, text, html });
}

module.exports = {
  buildTeamInvitationEmail,
};
