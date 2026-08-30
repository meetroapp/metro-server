"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createEmailDelivery } = require("../server/email/emailDelivery");
const {
  RESEND_EMAIL_ENDPOINT,
  createResendEmailProvider,
} = require("../server/email/resendEmailProvider");
const {
  SECURITY_VERIFICATION_SUBJECT,
  buildSecurityVerificationEmail,
} = require("../server/email/securityVerificationEmail");
const {
  buildTeamInvitationEmail,
} = require("../server/email/teamInvitationEmail");
const {
  TWO_FACTOR_FAILURE,
  createTwoFactorChallengeStore,
} = require("../server/security/twoFactorChallenges");

test("email delivery selects Resend only from explicit safe configuration", async () => {
  const missing = createEmailDelivery({ env: {} });
  assert.equal(missing.configured, false);
  assert.deepEqual(await missing.sendSecurityVerificationCode({}), {
    accepted: false,
    status: "provider_not_configured",
  });

  const unsupported = createEmailDelivery({ env: { EMAIL_PROVIDER: "other" } });
  assert.deepEqual(await unsupported.sendSecurityVerificationCode({}), {
    accepted: false,
    status: "unsupported_provider",
  });

  for (const env of [
    { EMAIL_PROVIDER: "resend", SECURITY_EMAIL_FROM: "Meetro <security@example.test>" },
    { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "secret-api-key" },
  ]) {
    const delivery = createEmailDelivery({ env });
    const result = await delivery.sendSecurityVerificationCode({});
    assert.equal(delivery.configured, false);
    assert.equal(result.accepted, false);
    assert.equal(JSON.stringify(result).includes("secret-api-key"), false);
  }
});

test("Resend request uses configured sender and concise plain and HTML verification content", async () => {
  let request;
  const provider = createEmailDelivery({
    env: {
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "resend-secret-value",
      SECURITY_EMAIL_FROM: "Meetro Security <security@auth.getmeetro.com>",
      SECURITY_EMAIL_REPLY_TO: "support@getmeetro.com",
    },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200 };
    },
  });

  const result = await provider.sendSecurityVerificationCode({
    recipientEmail: "person@example.test",
    maskedEmail: "pe***@example.test",
    code: "483920",
    expiresInMinutes: 10,
    challengeId: "challenge-private",
  });

  assert.deepEqual(result, { accepted: true, status: "accepted" });
  assert.equal(request.url, RESEND_EMAIL_ENDPOINT);
  assert.equal(request.options.method, "POST");
  assert.equal(request.body.from, "Meetro Security <security@auth.getmeetro.com>");
  assert.deepEqual(request.body.to, ["person@example.test"]);
  assert.equal(request.body.reply_to, "support@getmeetro.com");
  assert.equal(request.body.subject, SECURITY_VERIFICATION_SUBJECT);
  assert.match(request.body.text, /483920/);
  assert.match(request.body.html, /483920/);
  assert.match(request.body.text, /10 minutes/);
  assert.match(request.body.text, /works only once/);
  assert.match(request.body.text, /ignore this email/i);
  assert.doesNotMatch(request.body.text, /password|jwt|challenge-private/i);
  assert.doesNotMatch(request.body.html, /password|jwt|challenge-private/i);
  assert.equal(JSON.stringify(result).includes("resend-secret-value"), false);
});

test("verification email builder rejects invalid codes and never adds sensitive fields", () => {
  assert.throws(
    () => buildSecurityVerificationEmail({ code: "12345", expiresInMinutes: 10 }),
    /six-digit/
  );
  const email = buildSecurityVerificationEmail({ code: "123456", expiresInMinutes: 10 });
  assert.match(email.text, /Meetro Community/);
  assert.match(email.html, /Meetro Community/);
  assert.doesNotMatch(`${email.text}${email.html}`, /authorization|bearer|database|server error/i);
});

test("Resend sends a governed Team invitation with exact Business, role, and Join Team link", async () => {
  let request;
  const provider = createEmailDelivery({
    env: {
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "resend-secret-value",
      SECURITY_EMAIL_FROM: "Meetro <team@example.test>",
      SECURITY_EMAIL_REPLY_TO: "support@example.test",
    },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200 };
    },
  });

  const result = await provider.sendTeamInvitationEmail({
    recipientEmail: "liam@example.test",
    businessName: "All Handyman Services",
    role: "FIELD_EMPLOYEE",
    joinUrl: "https://staging.example.test/login#teamMembers?invitation=safe-token",
    idempotencyKey: "team-invitation-safe-test",
  });

  assert.deepEqual(result, { accepted: true, status: "accepted" });
  assert.equal(request.url, RESEND_EMAIL_ENDPOINT);
  assert.deepEqual(request.body.to, ["liam@example.test"]);
  assert.match(request.body.subject, /All Handyman Services/);
  assert.match(request.body.text, /Field Employee/);
  assert.match(request.body.text, /Join Team/);
  assert.match(request.body.text, /safe-token/);
  assert.match(request.body.html, /safe-token/);
  assert.match(request.body.text, /do not need to purchase a Meetro subscription/i);
  assert.equal(
    request.options.headers["Idempotency-Key"],
    "team-invitation-safe-test"
  );
  assert.doesNotMatch(
    `${request.body.text}${request.body.html}`,
    /resend-secret-value/
  );
});

test("Team invitation email builder rejects missing governed values", () => {
  assert.throws(
    () => buildTeamInvitationEmail({
      businessName: "",
      role: "FIELD_EMPLOYEE",
      joinUrl: "https://example.test",
    }),
    /Business name/
  );
  assert.throws(
    () => buildTeamInvitationEmail({
      businessName: "Example",
      role: "FIELD_EMPLOYEE",
      joinUrl: "javascript:alert(1)",
    }),
    /valid Team invitation URL/
  );
});

test("configured Resend delivery accepts a governed business-document PDF with provider idempotency", async () => {
  let request;
  const provider = createResendEmailProvider({
    apiKey: "private-key",
    from: "documents@example.test",
    fetchImpl: async (_url, options) => {
      request = { headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, async json() { return { id: "resend-document-1" }; } };
    },
  });
  const result = await provider.sendBusinessDocumentEmail({
    recipientEmail: "jack@example.test",
    subject: "Quote WQ-FAN",
    text: "Customer-safe Quote",
    html: "<p>Customer-safe Quote</p>",
    idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    attachment: { filename: "quote.pdf", content: "JVBERi0xLjQ=", contentType: "application/pdf" },
  });
  assert.equal(result.providerReference, "resend-document-1");
  assert.equal(request.headers["Idempotency-Key"], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(request.body.attachments, [{ filename: "quote.pdf", content: "JVBERi0xLjQ=", content_type: "application/pdf" }]);
});

test("Resend provider normalizes rejection, network failure, and timeout without raw details", async () => {
  const rejected = createResendEmailProvider({
    apiKey: "private-key",
    from: "security@example.test",
    fetchImpl: async () => ({ ok: false, status: 422, async json() { return { secret: "raw" }; } }),
  });
  assert.deepEqual(
    await rejected.sendSecurityVerificationCode({
      recipientEmail: "person@example.test", code: "123456", expiresInMinutes: 10,
    }),
    { accepted: false, status: "provider_rejected" }
  );

  const unavailable = createResendEmailProvider({
    apiKey: "private-key",
    from: "security@example.test",
    fetchImpl: async () => { throw new Error("raw provider body private-key"); },
  });
  const failure = await unavailable.sendSecurityVerificationCode({
    recipientEmail: "person@example.test", code: "123456", expiresInMinutes: 10,
  });
  assert.deepEqual(failure, { accepted: false, status: "provider_unavailable" });
  assert.doesNotMatch(JSON.stringify(failure), /private-key|raw provider body/);

  const timeout = createResendEmailProvider({
    apiKey: "private-key",
    from: "security@example.test",
    timeoutMs: 1,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
      void resolve;
    }),
  });
  assert.deepEqual(
    await timeout.sendSecurityVerificationCode({
      recipientEmail: "person@example.test", code: "123456", expiresInMinutes: 10,
    }),
    { accepted: false, status: "timeout" }
  );
});

test("challenge activation occurs after delivery and stores no plaintext code", () => {
  let currentTime = 1000;
  let challengeNumber = 0;
  const store = createTwoFactorChallengeStore({
    now: () => currentTime,
    codeGenerator: () => "654321",
    idGenerator: () => `challenge-${++challengeNumber}`,
  });

  const prepared = store.prepare("Person@Example.Test", { accountId: 7 });
  assert.equal(prepared.deliveryCode, "654321");
  assert.equal(store.size(), 0);

  const activated = store.activate(prepared);
  assert.equal(activated.ok, true);
  assert.equal(store.size(), 1);
  assert.equal(Object.hasOwn(prepared, "deliveryCode"), false);
  assert.equal(store.hasStoredPlaintextCode(), false);

  const cooldown = store.prepare("person@example.test");
  assert.equal(cooldown.ok, false);
  assert.equal(cooldown.code, TWO_FACTOR_FAILURE.SEND_COOLDOWN);

  currentTime += 60 * 1000;
  const resent = store.prepare("person@example.test");
  store.activate(resent);
  assert.equal(
    store.verify({
      challengeId: activated.challengeId,
      identity: "person@example.test",
      code: "654321",
    }).code,
    TWO_FACTOR_FAILURE.MISSING_CHALLENGE
  );
});

test("failed registration delivery can retain an opaque resend-only context", () => {
  const store = createTwoFactorChallengeStore({
    codeGenerator: () => "654321",
    idGenerator: () => "recovery-challenge",
  });

  const prepared = store.prepare("person@example.test", {
    accountId: 7,
    passwordVerified: true,
    tokenVersionSnapshot: 3,
  });
  const recovery = store.preserveForResend(prepared);

  assert.deepEqual(recovery, {
    ok: true,
    challengeId: "recovery-challenge",
    expiresAt: prepared.expiresAt,
  });
  assert.equal(store.hasStoredPlaintextCode(), false);
  assert.equal(
    store.verify({
      challengeId: recovery.challengeId,
      identity: "person@example.test",
      code: "654321",
    }).code,
    TWO_FACTOR_FAILURE.MISSING_CHALLENGE
  );
  assert.equal(
    store.getActiveSession({
      challengeId: recovery.challengeId,
      identity: "person@example.test",
    }).passwordVerified,
    true
  );

  const replacement = store.prepare("person@example.test");
  assert.equal(replacement.ok, true);
});

test("failed provisional delivery can retry and successful sends obey the bounded window", () => {
  let currentTime = 0;
  let challengeNumber = 0;
  const store = createTwoFactorChallengeStore({
    now: () => currentTime,
    codeGenerator: () => "123456",
    idGenerator: () => `challenge-${++challengeNumber}`,
  });

  const failed = store.prepare("person@example.test");
  store.cancel(failed);
  assert.equal(store.prepare("person@example.test").ok, true);
  store.cancel(store.prepare("other@example.test"));

  for (let send = 0; send < 5; send += 1) {
    const prepared = store.prepare("limited@example.test");
    assert.equal(prepared.ok, true);
    store.activate(prepared);
    currentTime += 60 * 1000;
  }

  const limited = store.prepare("limited@example.test");
  assert.equal(limited.ok, false);
  assert.equal(limited.code, TWO_FACTOR_FAILURE.SEND_LIMIT_REACHED);
});

test("default challenge generation produces exactly six digits", () => {
  const store = createTwoFactorChallengeStore();
  const issued = store.issue("person@example.test");
  assert.match(issued.deliveryCode, /^\d{6}$/);
  assert.equal(store.hasStoredPlaintextCode(), false);
});
