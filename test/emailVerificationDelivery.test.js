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
