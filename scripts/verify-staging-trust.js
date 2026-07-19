#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const LIVE_ENV_GATE = "MEETRO_ALLOW_LIVE_STAGING_TRUST";
const LIVE_CLI_CONFIRMATION = "--confirm-staging-trust";
const STAGING_TARGET = "staging";
const LOCAL_TEST_TARGET = "local-test";
const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const RUN_PREFIX = "qa-staging-trust";
const MEDIA_TRUST = Object.freeze({
  status: "SIGNED_UPLOAD_FOUNDATION_READY",
  reason:
    "Authenticated, owner-scoped Cloudinary signatures are available for approved profile purposes.",
  releaseNote:
    "Client media uploads remain disabled until a separately governed UI phase.",
});

const SENSITIVE_KEY_PATTERN =
  /password|passphrase|authorization|cookie|access[_-]?token|refresh[_-]?token|jwt|secret|reset[_-]?token|challenge[_-]?id|verification[_-]?code|database[_-]?url/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AUTHORIZATION_PATTERN = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const VERIFICATION_CODE_PATTERN = /\b\d{6}\b/g;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/;

function createRunId(idGenerator = () => crypto.randomUUID()) {
  return String(idGenerator()).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    String(hostname).toLowerCase()
  );
}

function hasProductionMarker(value) {
  return /(^|[^a-z])(prod|production)([^a-z]|$)/i.test(String(value || ""));
}

function normalizeBaseUrl(value) {
  const parsed = new URL(String(value || ""));
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

function validateTargetAuthorization({ env = process.env, args = process.argv.slice(2) } = {}) {
  const reasons = [];
  const rawUrl = String(env.MEETRO_STAGING_API_URL || "").trim();
  const targetType = String(env.MEETRO_STAGING_TRUST_TARGET || "").trim();
  let parsedUrl = null;

  if (env[LIVE_ENV_GATE] !== "1") {
    reasons.push(`${LIVE_ENV_GATE}=1 is required.`);
  }
  if (!args.includes(LIVE_CLI_CONFIRMATION)) {
    reasons.push(`${LIVE_CLI_CONFIRMATION} is required.`);
  }
  if (![STAGING_TARGET, LOCAL_TEST_TARGET].includes(targetType)) {
    reasons.push("MEETRO_STAGING_TRUST_TARGET must be staging or local-test.");
  }
  if (!rawUrl) {
    reasons.push("MEETRO_STAGING_API_URL is required.");
  } else {
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      reasons.push("MEETRO_STAGING_API_URL must be a valid URL.");
    }
  }

  if (parsedUrl) {
    if (parsedUrl.username || parsedUrl.password) {
      reasons.push("Embedded URL credentials are not allowed.");
    }
    if (parsedUrl.search || parsedUrl.hash) {
      reasons.push("Staging trust URLs must not contain query strings or fragments.");
    }
    if (hasProductionMarker(`${parsedUrl.hostname} ${parsedUrl.pathname} ${targetType}`)) {
      reasons.push("Production-like staging trust targets are not allowed.");
    }

    if (targetType === STAGING_TARGET) {
      if (parsedUrl.protocol !== "https:") {
        reasons.push("Public staging trust targets require HTTPS.");
      }
      if (isLocalHostname(parsedUrl.hostname)) {
        reasons.push("Localhost requires explicit local-test target mode.");
      }
    }

    if (targetType === LOCAL_TEST_TARGET) {
      if (env.NODE_ENV !== "test" || !isLocalHostname(parsedUrl.hostname)) {
        reasons.push("local-test mode requires NODE_ENV=test and a localhost URL.");
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        reasons.push("local-test URLs must use HTTP or HTTPS.");
      }
    }
  }

  return {
    authorized: reasons.length === 0,
    reasons,
    target: {
      type: targetType || "unknown",
      host: parsedUrl?.hostname || "unknown",
    },
    baseUrl: reasons.length === 0 ? normalizeBaseUrl(rawUrl) : "",
  };
}

function redactString(value) {
  let result = String(value)
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(AUTHORIZATION_PATTERN, "Bearer [REDACTED]")
    .replace(VERIFICATION_CODE_PATTERN, "[REDACTED_CODE]");

  try {
    const parsed = new URL(result);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      result = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
    }
  } catch {
    result = result.replace(
      /https?:\/\/[^\s]+/gi,
      (candidate) => {
        try {
          const parsed = new URL(candidate);
          return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
        } catch {
          return "[REDACTED_URL]";
        }
      }
    );
  }

  return result;
}

function redactSecrets(value, key = "") {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (key === "code" && typeof value === "string" && !SAFE_CODE_PATTERN.test(value)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactSecrets(childValue, childKey),
      ])
    );
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

function safeResponseCode(body, fallback) {
  const candidate = body?.code;
  return typeof candidate === "string" && SAFE_CODE_PATTERN.test(candidate)
    ? candidate
    : fallback;
}

async function requestJson({
  baseUrl,
  endpoint,
  method = "GET",
  token,
  body,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = now();

  try {
    const response = await fetchImpl(`${baseUrl}${endpoint}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsedBody = null;
    if (text) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body: parsedBody,
      headers: response.headers,
      elapsedMs: Math.max(0, now() - startedAt),
      errorCode: safeResponseCode(parsedBody, response.ok ? "HTTP_OK" : "HTTP_ERROR"),
    };
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      body: null,
      headers: new Headers(),
      elapsedMs: Math.max(0, now() - startedAt),
      errorCode: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function createSummary({ runId, target, startedAt }) {
  return {
    runId,
    target,
    startedAt,
    completedAt: null,
    checks: [],
    totals: { passed: 0, failed: 0, skipped: 0 },
    resources: [],
    cleanup: {
      attempted: false,
      complete: false,
      retainedAccounts: [],
      retainedResources: [],
      failures: [],
    },
    mediaTrust: { ...MEDIA_TRUST },
    result: "fail",
  };
}

function addCheck(summary, {
  name,
  pass,
  expectedStatus,
  actualStatus,
  safeCode,
  elapsedMs = 0,
  skipped = false,
}) {
  const status = skipped ? "skipped" : pass ? "pass" : "fail";
  summary.checks.push({
    name,
    status,
    expectedStatus: expectedStatus ?? null,
    actualStatus: actualStatus ?? null,
    safeCode: safeCode || (skipped ? "CHECK_SKIPPED" : pass ? "CHECK_PASSED" : "CHECK_FAILED"),
    elapsedMs,
  });
  summary.totals[status === "pass" ? "passed" : status === "fail" ? "failed" : "skipped"] += 1;
  return pass;
}

function trackResource(resources, { type, id, marker, cleanupSupported = false }) {
  const resource = {
    type,
    id: id === undefined || id === null ? "unknown" : String(id),
    marker,
    cleanupSupported,
  };
  resources.push(resource);
  return resource;
}

async function cleanupResources(resources, cleanupHandlers = {}) {
  const cleanup = {
    attempted: true,
    complete: true,
    retainedAccounts: [],
    retainedResources: [],
    failures: [],
  };

  for (const resource of [...resources].reverse()) {
    const handler = cleanupHandlers[resource.type];
    if (!resource.cleanupSupported || typeof handler !== "function") {
      const retained = { type: resource.type, id: resource.id, marker: resource.marker };
      cleanup.retainedResources.push(retained);
      if (resource.type === "account") cleanup.retainedAccounts.push(resource.marker);
      cleanup.complete = false;
      continue;
    }

    try {
      await handler(resource);
    } catch (error) {
      cleanup.complete = false;
      cleanup.failures.push({
        type: resource.type,
        id: resource.id,
        code: "CLEANUP_FAILED",
        message: redactString(error?.message || "Cleanup failed."),
      });
    }
  }

  return cleanup;
}

function getToken(result) {
  return typeof result?.body?.token === "string" ? result.body.token : "";
}

function getUser(result) {
  return result?.body?.user || null;
}

function includesId(value, id) {
  return JSON.stringify(value || {}).includes(`\"id\":${Number(id)}`);
}

async function expectedRequest(context, {
  name,
  endpoint,
  expectedStatus,
  validate = () => true,
  ...options
}) {
  const response = await requestJson({
    baseUrl: context.baseUrl,
    endpoint,
    fetchImpl: context.fetchImpl,
    timeoutMs: context.timeoutMs,
    now: context.now,
    ...options,
  });
  addCheck(context.summary, {
    name,
    pass: response.status === expectedStatus && validate(response.body, response),
    expectedStatus,
    actualStatus: response.status,
    safeCode: response.errorCode,
    elapsedMs: response.elapsedMs,
  });
  return response;
}

async function createAccount(context, label, accountType) {
  const marker = `${RUN_PREFIX}-${context.runId}-${label.toLowerCase()}`;
  const email = `${marker}@example.test`;
  const password = `Trust${context.runId.slice(0, 12)}${label}9`;
  const response = await expectedRequest(context, {
    name: `account_${label.toLowerCase()}_signup`,
    endpoint: "/auth/signup",
    method: "POST",
    expectedStatus: 200,
    body: {
      username: marker,
      email,
      password,
      account_type: accountType,
      role: accountType === "professional" ? "handyman" : "homeowner",
      business_name: accountType === "professional" ? marker : "",
      business_category: accountType === "professional" ? "handyman" : "",
    },
    validate: (body) => Boolean(body?.token && body?.user?.id),
  });
  const user = getUser(response);
  if (!user?.id || !getToken(response)) return null;

  trackResource(context.resources, {
    type: "account",
    id: user.id,
    marker,
  });
  return { label, marker, email, password, user, signupToken: getToken(response) };
}

async function loginAccount(context, account) {
  const response = await expectedRequest(context, {
    name: `account_${account.label.toLowerCase()}_login`,
    endpoint: "/auth/login",
    method: "POST",
    expectedStatus: 200,
    body: { email: account.email, password: account.password },
    validate: (body) => Boolean(body?.token && body?.user?.id === account.user.id),
  });
  account.token = getToken(response);
  return Boolean(account.token);
}

async function verifyAuthAndCors(context) {
  await expectedRequest(context, {
    name: "malformed_login_normalized",
    endpoint: "/auth/login",
    method: "POST",
    expectedStatus: 400,
    body: {},
  });
  await expectedRequest(context, {
    name: "invalid_login_normalized",
    endpoint: "/auth/login",
    method: "POST",
    expectedStatus: 401,
    body: {
      email: `${RUN_PREFIX}-${context.runId}-missing@example.test`,
      password: `Missing${context.runId}9`,
    },
  });
  await expectedRequest(context, {
    name: "unapproved_cors_origin_rejected",
    endpoint: "/health",
    method: "OPTIONS",
    expectedStatus: 403,
    headers: {
      Origin: "https://unapproved-origin.example",
      "Access-Control-Request-Method": "GET",
    },
  });
}

async function verifyAccountIdentity(context, account) {
  await expectedRequest(context, {
    name: `account_${account.label.toLowerCase()}_identity`,
    endpoint: "/auth/me",
    token: account.token,
    expectedStatus: 200,
    validate: (body) => body?.user?.id === account.user.id,
  });
}

async function createPost(context, account) {
  const marker = `${account.marker}-post`;
  const response = await expectedRequest(context, {
    name: `account_${account.label.toLowerCase()}_post_create`,
    endpoint: "/posts",
    method: "POST",
    token: account.token,
    expectedStatus: 200,
    body: {
      title: marker,
      description: `Ownership trust record ${context.runId}`,
      category: "staging-trust",
      location: "Staging Trust",
    },
    validate: (body) => Boolean(body?.post?.id),
  });
  const post = response.body?.post;
  if (post?.id) {
    trackResource(context.resources, { type: "post", id: post.id, marker });
  }
  return post || null;
}

async function verifyPostIsolation(context, accountA, accountB, postA, postB) {
  await expectedRequest(context, {
    name: "account_a_post_list_isolated",
    endpoint: "/posts",
    token: accountA.token,
    expectedStatus: 200,
    validate: (body) => includesId(body, postA.id) && !includesId(body, postB.id),
  });
  await expectedRequest(context, {
    name: "account_b_post_list_isolated",
    endpoint: "/posts",
    token: accountB.token,
    expectedStatus: 200,
    validate: (body) => includesId(body, postB.id) && !includesId(body, postA.id),
  });
  await expectedRequest(context, {
    name: "account_a_cannot_read_b_post",
    endpoint: `/posts/${postB.id}`,
    token: accountA.token,
    expectedStatus: 404,
  });
  await expectedRequest(context, {
    name: "account_b_cannot_read_a_post",
    endpoint: `/posts/${postA.id}`,
    token: accountB.token,
    expectedStatus: 404,
  });
}

async function createProfessionalWorkflow(context, accountA, accountB) {
  const profileMarker = `${accountA.marker}-profile`;
  const profileResponse = await expectedRequest(context, {
    name: "account_a_contractor_profile_create",
    endpoint: "/contractor-profiles",
    method: "POST",
    token: accountA.token,
    expectedStatus: 200,
    body: {
      business_name: profileMarker,
      category: "handyman",
      phone: "239-555-0100",
      location: "Staging Trust",
      bio: `Trust run ${context.runId}`,
    },
    validate: (body) => Boolean(body?.profile?.id),
  });
  const profile = profileResponse.body?.profile;
  if (!profile?.id) return false;
  trackResource(context.resources, {
    type: "contractor_profile",
    id: profile.id,
    marker: profileMarker,
  });

  const quoteMarker = `${accountA.marker}-quote`;
  const quoteResponse = await expectedRequest(context, {
    name: "account_a_quote_create",
    endpoint: "/quote-requests",
    method: "POST",
    token: accountA.token,
    expectedStatus: 200,
    body: {
      contractor_id: profile.id,
      project_title: quoteMarker,
      project_description: `Trust run ${context.runId}`,
      location: "Staging Trust",
    },
    validate: (body) => Boolean(body?.quote?.id),
  });
  const quote = quoteResponse.body?.quote;
  if (!quote?.id) return false;
  trackResource(context.resources, {
    type: "quote_request",
    id: quote.id,
    marker: quoteMarker,
  });

  const messageMarker = `${accountA.marker}-message`;
  const messageResponse = await expectedRequest(context, {
    name: "account_a_message_create",
    endpoint: "/messages",
    method: "POST",
    token: accountA.token,
    expectedStatus: 200,
    body: {
      quote_request_id: quote.id,
      receiver_id: accountA.user.id,
      message_text: messageMarker,
    },
    validate: (body) => Boolean(body?.data?.id),
  });
  if (messageResponse.body?.data?.id) {
    trackResource(context.resources, {
      type: "message",
      id: messageResponse.body.data.id,
      marker: messageMarker,
    });
  }
  await expectedRequest(context, {
    name: "account_b_cannot_read_a_messages",
    endpoint: `/messages/${quote.id}`,
    token: accountB.token,
    expectedStatus: 404,
  });
  await expectedRequest(context, {
    name: "account_b_cannot_write_a_messages",
    endpoint: "/messages",
    method: "POST",
    token: accountB.token,
    expectedStatus: 404,
    body: {
      quote_request_id: quote.id,
      receiver_id: accountA.user.id,
      message_text: `${accountB.marker}-unauthorized-message`,
    },
  });

  const workflowMarker = `${accountA.marker}-workflow`;
  const workflowResponse = await expectedRequest(context, {
    name: "account_a_workflow_create",
    endpoint: "/workflow-events",
    method: "POST",
    token: accountA.token,
    expectedStatus: 200,
    body: {
      quote_request_id: quote.id,
      workflow_type: "staging_trust",
      workflow_status: "verified",
      workflow_payload: { trustRunId: context.runId },
      event_label: workflowMarker,
    },
    validate: (body) => Boolean(body?.workflow_event?.id),
  });
  if (workflowResponse.body?.workflow_event?.id) {
    trackResource(context.resources, {
      type: "workflow_event",
      id: workflowResponse.body.workflow_event.id,
      marker: workflowMarker,
    });
  }
  await expectedRequest(context, {
    name: "account_b_cannot_read_a_workflow",
    endpoint: `/workflow-events/${quote.id}`,
    token: accountB.token,
    expectedStatus: 404,
  });
  await expectedRequest(context, {
    name: "account_b_cannot_write_a_workflow",
    endpoint: "/workflow-events",
    method: "POST",
    token: accountB.token,
    expectedStatus: 404,
    body: {
      quote_request_id: quote.id,
      workflow_type: "staging_trust",
      workflow_status: "unauthorized",
      workflow_payload: { trustRunId: context.runId },
      event_label: `${accountB.marker}-unauthorized-workflow`,
    },
  });

  const projectMarker = `${accountA.marker}-project`;
  const projectResponse = await expectedRequest(context, {
    name: "account_a_project_create",
    endpoint: "/contractor-projects",
    method: "POST",
    token: accountA.token,
    expectedStatus: 200,
    body: {
      contractor_id: profile.id,
      title: projectMarker,
      description: `Trust run ${context.runId}`,
      image_urls: [],
    },
    validate: (body) => Boolean(body?.project?.id),
  });
  const project = projectResponse.body?.project;
  if (project?.id) {
    trackResource(context.resources, {
      type: "contractor_project",
      id: project.id,
      marker: projectMarker,
    });
    await expectedRequest(context, {
      name: "account_b_cannot_mutate_a_project",
      endpoint: `/contractor-projects/${project.id}`,
      method: "PUT",
      token: accountB.token,
      expectedStatus: 404,
      body: {
        title: `${accountB.marker}-unauthorized-project`,
        description: "Must be rejected",
        image_urls: [],
      },
    });
  }
  return true;
}

async function runStagingTrust({
  env = process.env,
  args = process.argv.slice(2),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = () => Date.now(),
  isoNow = () => new Date().toISOString(),
  idGenerator,
  cleanupHandlers = {},
} = {}) {
  const authorization = validateTargetAuthorization({ env, args });
  const runId = createRunId(idGenerator);
  const summary = createSummary({
    runId,
    target: authorization.target,
    startedAt: isoNow(),
  });
  const resources = [];
  const context = {
    baseUrl: authorization.baseUrl,
    fetchImpl,
    timeoutMs,
    now,
    runId,
    resources,
    summary,
  };

  if (!authorization.authorized) {
    addCheck(summary, {
      name: "execution_authorization",
      pass: false,
      safeCode: "UNSAFE_TARGET_OR_MISSING_GATE",
    });
    summary.cleanup = await cleanupResources(resources, cleanupHandlers);
    summary.completedAt = isoNow();
    summary.result = "fail";
    return redactSecrets(summary);
  }

  try {
    const health = await expectedRequest(context, {
      name: "staging_health",
      endpoint: "/health",
      expectedStatus: 200,
      validate: (body) => body?.status === "ok",
    });
    if (health.status !== 200 || health.body?.status !== "ok") {
      throw new Error("CRITICAL_SETUP_FAILED");
    }

    await verifyAuthAndCors(context);
    const accountA = await createAccount(context, "A", "professional");
    const accountB = await createAccount(context, "B", "homeowner");
    if (!accountA || !accountB) throw new Error("CRITICAL_SETUP_FAILED");
    if (!(await loginAccount(context, accountA)) || !(await loginAccount(context, accountB))) {
      throw new Error("CRITICAL_SETUP_FAILED");
    }

    await verifyAccountIdentity(context, accountA);
    await verifyAccountIdentity(context, accountB);
    const postA = await createPost(context, accountA);
    const postB = await createPost(context, accountB);
    if (!postA?.id || !postB?.id) throw new Error("CRITICAL_SETUP_FAILED");
    await verifyPostIsolation(context, accountA, accountB, postA, postB);
    await createProfessionalWorkflow(context, accountA, accountB);
  } catch (error) {
    if (error?.message !== "CRITICAL_SETUP_FAILED") {
      addCheck(summary, {
        name: "verifier_runtime",
        pass: false,
        safeCode: "VERIFIER_RUNTIME_FAILURE",
      });
    }
  } finally {
    summary.resources = resources.map(({ type, id, marker }) => ({ type, id, marker }));
    summary.cleanup = await cleanupResources(resources, cleanupHandlers);
    summary.completedAt = isoNow();
  }

  if (summary.totals.failed > 0 || summary.cleanup.failures.length > 0) {
    summary.result = "fail";
  } else if (!summary.cleanup.complete) {
    summary.result = "pass_with_retained_test_accounts";
  } else {
    summary.result = "pass";
  }
  return redactSecrets(summary);
}

function exitCodeForSummary(summary) {
  return summary?.result === "pass" ? 0 : 1;
}

async function main() {
  const summary = await runStagingTrust();
  console.log(JSON.stringify(redactSecrets(summary), null, 2));
  process.exitCode = exitCodeForSummary(summary);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LIVE_CLI_CONFIRMATION,
  LIVE_ENV_GATE,
  MEDIA_TRUST,
  RUN_PREFIX,
  addCheck,
  cleanupResources,
  createRunId,
  createSummary,
  exitCodeForSummary,
  hasProductionMarker,
  normalizeBaseUrl,
  redactSecrets,
  requestJson,
  runStagingTrust,
  trackResource,
  validateTargetAuthorization,
};
