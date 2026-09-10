"use strict";

const { isPlainObject } = require("./intelligenceGatewayContracts");
const { parseRetrievalIntent, matchRank } = require("./retrievalIntent");
const readers = require("./retrievalReaders");
const { loadRetrievalContinuation, MAX_RECORDS } = require("./retrievalContinuation");
const { scheduledVisit, recordAnswer, includeInAggregate } = require("./retrievalAnswers");
const MAX_CHOICES = 5;
function invalid() { throw Object.assign(new Error("Invalid retrieval context."), { code: "intelligence_context_invalid" }); }

async function buildRetrievalContext({ input, context, runtimeContext }) {
  const options = context.retrieval;
  if (Object.keys(context).some((key) => !["record", "retrieval"].includes(key)) || !isPlainObject(options) || options.version !== 1 ||
    Object.keys(options).some((key) => !["version", "continuation"].includes(key))) invalid();
  const services = { ...readers, loadRetrievalContinuation, ...runtimeContext.retrievalServices };
  const base = { pool: runtimeContext.pool, authenticatedActor: runtimeContext.authenticatedActor };
  const query = parseRetrievalIntent(input.message);
  const now = runtimeContext.retrievalClock ? new Date(runtimeContext.retrievalClock()) : new Date();
  let items = [], truncated = false;
  async function authorize(candidate) {
    const authorized = await services.readAuthorizedRecord(base, candidate.record);
    if (!authorized) return null;
    const facts = authorized.facts;
    const name = String(candidate.name || facts.customerName || facts.customerDisplayName || facts.contact?.displayName || "").slice(0, 100);
    const title = String(candidate.title || facts.title || facts.subject || facts.documentNumber || facts.invoiceNumber || "").slice(0, 120);
    return { record: candidate.record, name, title, number: candidate.number || facts.documentNumber || facts.invoiceNumber || "", label: [name, title].filter(Boolean).join(" — ") || candidate.record.type, context: { ...authorized, facts: { ...facts, ...(title ? { title } : {}), ...(name ? { customerName: name } : {}) } } };
  }
  if (context.record) {
    const exact = await authorize({ record: context.record });
    if (!exact) return outcome("SAFE_NOT_FOUND", [], "The requested record is unavailable in your authorized records.");
    // A named entity can intentionally supersede current context; deictic
    // language always retains the exact supplied record.
    if (query.deictic || (!query.name && !query.id && !query.number) || matchRank(exact, query)) items = [exact];
  }
  if (!items.length && options.continuation) {
    const prior = await services.loadRetrievalContinuation(base, options.continuation);
    for (const candidate of prior) {
      const item = await authorize(candidate);
      if (item) items.push(item);
    }
    if (items.length !== prior.length) return outcome("SAFE_NOT_FOUND", [], "The previous record context is unavailable. Search again.");
    if (query.name || query.id || query.number) items = bestMatches(items, query);
    if (!query.name && !query.id && !query.number && items.length > 1 && !query.aggregate) return ambiguity(items);
  }
  if (!items.length && (query.name || query.id || query.number || query.aggregate)) {
    const found = await services.discoverCandidates(base, query);
    truncated = found.truncated;
    for (const candidate of found.candidates.slice(0, readers.CANDIDATE_LIMIT)) {
      const item = await authorize(candidate);
      if (item) items.push(item);
    }
    items = bestMatches(items, query);
  }
  if (!items.length) {
    if (!query.requiresRecord && !context.record && !options.continuation) return outcome("NO_RECORD_REQUIRED", [], null);
    return outcome("NOT_FOUND", [], truncated ? "Narrow the customer, title, or document number to search your authorized records." : "No matching record was available in your authorized records. Try an exact customer name, title, or document number.");
  }
  if ((!query.aggregate || query.operational) && (items.length > 1 || truncated)) return ambiguity(items, truncated);
  if (query.operational) return outcome("RESOLVED", items.slice(0, 1), query.mixed
    ? "This request combines a question and a change. Send them separately. No action has been proposed or applied."
    : "The target record is resolved. Continue through its existing governed operation and Review. Confirm & Apply is still required; nothing has been changed.", !query.mixed);
  const deterministic = !query.reasoning && query.kind !== "REASONING";
  if (deterministic) {
    for (const item of items) {
      const jobId = item.record.type === "JOB" ? item.record.id : item.context.facts.jobId;
      if (query.kind === "SCHEDULE") {
        const visits = jobId ? await services.readVisits(base, jobId) : null;
        item.visits = (visits || []).filter((visit) => scheduledVisit(visit, query, now)).sort((a, b) => Date.parse(a.scheduledStartAt) - Date.parse(b.scheduledStartAt) || a.id.localeCompare(b.id)).slice(0, MAX_RECORDS);
      }
      if (query.kind === "DEPOSIT") item.deposit = jobId ? await services.readDeposit(base, jobId) : null;
    }
    if (query.kind === "QUOTE" && query.outstanding && query.aggregate) {
      const waiting = await services.readWaitingQuotes(base);
      truncated ||= waiting?.truncated || false;
      for (const item of items) item.waitingForApproval = waiting
        ? waiting.ids.includes(item.record.id)
        : item.context.facts.businessStatus === "WAITING_ON_CUSTOMER";
    }
    if (query.aggregate) items = items.filter((item) => includeInAggregate(item, query));
    items.sort((a, b) => query.kind === "SCHEDULE" ? Date.parse(a.visits?.[0]?.scheduledStartAt || 0) - Date.parse(b.visits?.[0]?.scheduledStartAt || 0) || a.record.id.localeCompare(b.record.id) : a.label.localeCompare(b.label) || a.record.id.localeCompare(b.record.id));
    const limit = query.next ? 1 : MAX_RECORDS;
    truncated ||= items.length > limit;
    items = items.slice(0, limit);
    const lines = items.map((item) => `${item.label}: ${recordAnswer(item, query)}`);
    return outcome(items.length ? "RESOLVED" : "NOT_FOUND", items, (lines.join("\n") || "No matching confirmed facts were available in this bounded authorized read.") + (truncated ? "\nThis is a bounded result, not a complete account report. Narrow the query for more specific results." : ""));
  }
  // Reasoning is bounded to one unique record. Aggregate prose must not imply
  // complete coverage of a capped query.
  if (items.length > 1) return ambiguity(items);
  return outcome("RESOLVED", items, null);

  function ambiguity(matches, more = false) {
    truncated ||= more || matches.length > MAX_CHOICES;
    const choices = matches.slice(0, MAX_CHOICES);
    return outcome("AMBIGUOUS", choices, `I found multiple possible records. Which one do you mean?${truncated ? " Narrow the name or title if your record is not listed." : ""}`);
  }
  function outcome(status, selected, deterministicText, reviewRequired = false) {
    return { audience: base.authenticatedActor.role, record: selected.length === 1 ? selected[0].context : null,
      retrieval: { version: 1, status, records: selected.map(({ record, name, title, number, label }) => ({ record, name, title, number, label })), truncated, reviewRequired, deterministicText } };
  }
}
function bestMatches(items, query) {
  const ranked = items.map((item) => [item, matchRank(item, query)]);
  const best = Math.max(0, ...ranked.map(([, rank]) => rank));
  return ranked.filter(([, rank]) => rank > 0 && rank === best).map(([item]) => item);
}
function retrievalResult(text, semanticInput, operationId) {
  const retrieval = semanticInput.context.retrieval;
  const result = { schemaVersion: 1, text, authorityClassification: "CONVERSATIONAL_NON_CANONICAL", directMutationAllowed: false };
  if (!retrieval) return result;
  return { ...result, resolution: { version: 1, status: retrieval.status, audience: semanticInput.context.audience,
    records: retrieval.records, truncated: retrieval.truncated, reviewRequired: retrieval.reviewRequired,
    continuation: retrieval.records.length ? { reference: operationId, expiresAfterSeconds: 900 } : null,
    answerSource: retrieval.deterministicText === null ? "PROVIDER_CONVERSATION" : "DETERMINISTIC_RETRIEVAL",
    providerInvoked: retrieval.deterministicText === null } };
}
module.exports = { buildRetrievalContext, retrievalResult };
