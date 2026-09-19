"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { ensureEmergencySelectionJob } = require("../../server/emergency/emergencyJobFoundationService");
const dispatch = require("../../server/emergency/emergencyDispatchService");
const evaluation = require("../../server/authorization/evaluationService");
const quotes = require("../../server/authorization/quoteDraftService");
const delivery = require("../../server/authorization/quoteDeliveryService");
const deposits = require("../../server/finance/preWorkDepositService");
const quiet = { info() {}, warn() {} };
function success(result) {
  assert.equal(result.ok === true || result.success === true, true, JSON.stringify(result));
  return result;
}

// All schema, fixtures, and service transactions live inside one outer ROLLBACK.
// Service transaction boundaries are mapped to savepoints, never real commits.
function transactionalFacade(client) {
  const sql = [];
  const facade = {
    sql,
    async query(text, values) {
      sql.push(text);
      if (/^BEGIN\b/.test(text)) return client.query("SAVEPOINT service_transaction");
      if (text === "COMMIT") return client.query("RELEASE SAVEPOINT service_transaction");
      if (text === "ROLLBACK") {
        await client.query("ROLLBACK TO SAVEPOINT service_transaction");
        return client.query("RELEASE SAVEPOINT service_transaction");
      }
      return client.query(text, values);
    },
    async connect() { return facade; },
    release() {},
  };
  return facade;
}

async function fixture(client, pool) {
  const ids = {};
  for (const kind of ["homeowner", "professional", "outsider"]) {
    ids[kind] = (await client.query(`INSERT INTO users (username, email, password_hash, role, account_type)
      VALUES ($1, $2, 'test-hash', $3, $4) RETURNING id`,
    [kind, `${randomUUID()}@example.test`, kind === 'professional' ? 'handyman' : 'homeowner', kind === 'professional' ? 'professional' : 'homeowner'])).rows[0].id;
  }
  ids.profile = (await client.query(`INSERT INTO contractor_profiles (user_id, business_name, category, location)
    VALUES ($1, 'Emergency Test Professional', 'plumbing', 'Test location') RETURNING id`, [ids.professional])).rows[0].id;
  const request = (await client.query(`INSERT INTO emergency_requests
    (homeowner_id, category, service_domain, service_specialty, title, location_text, status, assigned_at)
    VALUES ($1, 'plumbing', 'home_services', 'plumbing_repair', 'Emergency leak', 'Test location', 'assigned', CURRENT_TIMESTAMP) RETURNING *`, [ids.homeowner])).rows[0];
  const relationship = (await client.query(`INSERT INTO request_relationships
    (post_id, emergency_request_id, homeowner_id, contractor_id, professional_user_id, status)
    VALUES (NULL, $1, $2, $3, $4, 'active') RETURNING *`, [request.id, ids.homeowner, ids.profile, ids.professional])).rows[0];
  ids.conversation = (await client.query(`INSERT INTO conversations
    (relationship_id, homeowner_id, contractor_id, professional_user_id)
    VALUES ($1, $2, $3, $4) RETURNING id`, [relationship.id, ids.homeowner, ids.profile, ids.professional])).rows[0].id;
  const job = await ensureEmergencySelectionJob({ client, emergencyRequest: request, relationship, logger: quiet });
  const f = { ...ids, request: request.id, relationship: relationship.id, job: job.job.id, pool };
  success(await dispatch.markEmergencyEnRoute({ pool, authenticatedUserId: ids.professional, emergencyRequestId: request.id }));
  success(await dispatch.markEmergencyArrived({ pool, authenticatedUserId: ids.professional, emergencyRequestId: request.id }));
  return f;
}
function start(f, actor = f.professional) {
  return dispatch.startEmergencyWork({ pool: f.pool, authenticatedUserId: actor, emergencyRequestId: f.request });
}
async function completedEvaluation(f) {
  const created = success(await evaluation.createEvaluation({
    pool: f.pool, authenticatedActor: { id: f.professional },
    sourceContext: { type: "emergency_request", emergencyRequestId: f.request, relationshipId: f.relationship },
    content: { serviceType: "plumbing_repair", evaluationContext: "emergency_request",
      observations: "Supply seal is leaking.", findings: [{ summary: "Failed seal", severity: "high", customerShareable: true }],
      scopeRecommendations: ["Replace seal."], diagnosisSummary: "Failed seal" },
    expectedVersion: 0, idempotencyKey: randomUUID(),
  }));
  success(await evaluation.completeEvaluation({ pool: f.pool, authenticatedActor: { id: f.professional },
    evaluationId: created.aggregate.id, expectedVersion: created.aggregate.version,
    idempotencyKey: randomUUID() }));
}
async function issuedQuote(f, paymentTerms = "Balance due on completion") {
  const created = success(await quotes.createDraftQuote({ pool: f.pool, authenticatedActor: { id: f.professional },
    jobId: f.job, currency: "USD", customerTermsSnapshot: { schemaVersion: 1, paymentTerms,
      estimatedDuration: "1 day", customerNotes: "", agreement: { exclusions: [], additionalWorkTerms: "Written approval required.",
        hiddenConditionsTerms: "Revised Quote required.", diagnosticTerms: "Stated scope only.", customerResponsibilities: "Provide access.",
        warrantyTerms: "One year.", cancellationTerms: "As agreed.", acceptanceTerms: "Accepts issued Quote.", preauthorizedAdditionalWorkLimit: "$0" } },
    idempotencyKey: randomUUID(), logger: quiet }));
  const scoped = success(await quotes.addDraftScopeItem({ pool: f.pool, authenticatedActor: { id: f.professional },
    quoteId: created.quote.id, expectedVersion: created.quote.currentVersion,
    item: { classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE",
      description: "Replace seal", quantity: 1, unitAmountMinor: 10000, source: { type: "MANUAL_PROFESSIONAL" } },
    idempotencyKey: randomUUID(), logger: quiet }));
  return success(await quotes.issueQuote({ pool: f.pool, authenticatedActor: { id: f.professional },
    quoteId: created.quote.id, expectedVersion: scoped.quote.currentVersion, idempotencyKey: randomUUID(), logger: quiet })).quote;
}
function decide(f, quote, decision = "APPROVED", actor = f.homeowner) {
  return (decision === "APPROVED" ? quotes.approveIssuedQuote : quotes.declineIssuedQuote)({ pool: f.pool,
    authenticatedActor: { id: actor }, quoteId: quote.id, expectedIssuedVersion: quote.currentVersion,
    idempotencyKey: randomUUID(), logger: quiet });
}
function send(f, quote) {
  return delivery.sendQuoteInMeetro({ pool: f.pool, authenticatedActor: { id: f.professional }, quoteId: quote.id,
    expectedIssuedVersion: quote.currentVersion, idempotencyKey: randomUUID(), logger: quiet });
}
function pay(f, amount, expectedVersion) {
  return deposits.confirmDepositReceived({ pool: f.pool, authenticatedActor: { id: f.professional }, jobId: f.job,
    amountMinor: amount, currency: "USD", normalizedMethod: "BUSINESS_TRANSFER_APP", displayMethod: "Business transfer app",
    receivedAt: "2026-09-18T12:00:00.000Z", externalReference: randomUUID(), expectedVersion, idempotencyKey: randomUUID(), logger: quiet });
}

module.exports = { success, transactionalFacade, fixture, start, completedEvaluation, issuedQuote, decide, send, pay };
