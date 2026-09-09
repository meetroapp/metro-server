"use strict";

const { isPlainObject } = require("./intelligenceGatewayContracts");
const { getCustomerJobQuotes } = require("../authorization/customerJobQuotesService");
const { getCanonicalLiveJob } = require("../workflow/liveJobProjectionService");
const { getBusinessDocumentDraft } = require("../documents/businessDocumentDraftService");
const { getDraftQuote, getCustomerIssuedQuote } = require("../authorization/quoteDraftService");
const { getProfessionalInvoice, getCustomerInvoice } = require("../finance/invoicePaymentService");
const { getEvaluation } = require("../authorization/evaluationService");
const { getVisit } = require("../workflow/visitService");
const { getBusinessCustomerRelationship, getBusinessCustomerRelationshipActivity } = require("../relationships/businessCustomerRelationshipService");
const { getConversation } = require("../conversations/conversationService");
const { listConversationMessages } = require("../conversations/conversationMessageService");

function invalid() { throw Object.assign(new Error("The conversational record context is unavailable."), { code: "intelligence_context_invalid" }); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(["JOB", "DOCUMENT_DRAFT", "QUOTE", "INVOICE", "EVALUATION", "VISIT", "CUSTOMER_RELATIONSHIP", "CONVERSATION", "JOB_REQUEST"]);
const PROFESSIONAL = new Set(["DOCUMENT_DRAFT", "EVALUATION", "CUSTOMER_RELATIONSHIP"]);

// Only descriptive and display facts leave these existing authorized read paths.
// Never forward email/phone, media URLs, permissions, private costs, full payloads,
// or arbitrary fields added to a service response in the future.
const FIELDS = new Set("id jobId title description status version documentType documentNumber invoiceNumber customerDisplayName customerName displayName companyName serviceArea subject message_text created_at updated_at stage code label responsibility blocker nextAction reasonCodes freshness quoteVersion evaluationVersion currentVersion currency totalMinor paidMinor balanceMinor total subtotal taxRate taxAmount dueDate invoiceDate quantity unitPrice amountMinor unitPriceMinor lineTotalMinor lineItems lines scopeItems scopeSections recommendedSolution workPerformed customerNotes terms notes scopeSummary observations diagnosisSummary limitations completionMode scheduledStart scheduledEnd startsAt endsAt timezone date time content contact jobs quotes invoices documents workstreams summary aggregate quote invoice visit work currentStage state scheduledStartAt scheduledEndAt timeZone purpose completedAt startedAt issuedAt decisionState decidedAt scopeSemantic workStatus classification includedInTotal unitAmountMinor materialsSubtotalMinor laborServiceSubtotalMinor subtotalMinor customer business job service due kind value days totals conditions exclusions approvalSource approvalStatus deposit quoteTotalMinor requestedAmountMinor receivedAmountMinor outstandingAmountMinor payments receivedAt method paymentDate".split(" "));
function boundedFacts(value, depth = 0, budget = { left: 14000 }) {
  if (budget.left <= 0 || depth > 5) return null;
  if (typeof value === "string") { const text = value.slice(0, Math.min(1200, budget.left)); budget.left -= text.length; return text; }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => boundedFacts(item, depth + 1, budget));
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => FIELDS.has(key)).slice(0, 40).map(([key, item]) => [key, boundedFacts(item, depth + 1, budget)]));
}

const readers = {
  JOB: async (base, record, role) => {
    if (role === "professional") { const result = await getCanonicalLiveJob({ ...base, jobId: record.id }); return result.ok ? result.liveJob : null; }
    const result = await getCustomerJobQuotes({ ...base, jobId: record.id, limit: 12 });
    return result.ok ? { ...result.job, quotes: result.quotes } : null;
  },
  DOCUMENT_DRAFT: async (base, record) => { const result = await getBusinessDocumentDraft({ ...base, draftId: record.id }); return result.ok ? result.document : null; },
  QUOTE: async (base, record, role) => { const result = await (role === "professional" ? getDraftQuote : getCustomerIssuedQuote)({ ...base, quoteId: record.id }); return result.ok ? result.quote : null; },
  INVOICE: async (base, record, role) => { const result = await (role === "professional" ? getProfessionalInvoice : getCustomerInvoice)({ ...base, invoiceId: record.id }); return result.ok ? result.invoice : null; },
  EVALUATION: async (base, record) => { const result = await getEvaluation({ ...base, evaluationId: record.id }); return result.ok ? result.evaluation : null; },
  VISIT: async (base, record) => { const result = await getVisit({ ...base, jobId: record.jobId, visitId: record.id }); return result.ok ? result.visit : null; },
  CUSTOMER_RELATIONSHIP: async (base, record) => {
    const result = await getBusinessCustomerRelationship({ ...base, relationshipId: record.id });
    if (!result.ok) return null;
    const history = await getBusinessCustomerRelationshipActivity({ ...base, relationshipId: record.id });
    return { ...result.relationship, ...(history.ok ? { summary: history.activity } : {}) };
  },
  CONVERSATION: async ({ pool, authenticatedActor }, record) => {
    // Message listing is not independently authorized: check participant read first.
    const result = await getConversation({ pool, conversationId: record.id, participantUserId: authenticatedActor.id });
    if (!result.ok) return null;
    const page = await listConversationMessages({ pool, conversationId: record.id, limit: 12 });
    if (!page.ok) return null;
    return { id: record.id, status: result.conversation.status, summary: page.messages.map(({ message_text, created_at }) => ({ message_text, created_at })) };
  },
  JOB_REQUEST: async ({ pool, authenticatedActor }, record) => {
    // Same exact owner boundary as GET /posts/:id; no matching/discovery inference.
    const result = await pool.query(`/* ask_conversation:owned_request */
      SELECT id, title, description, status, updated_at FROM posts WHERE id = $1 AND user_id = $2`, [record.id, authenticatedActor.id]);
    return result.rows[0] || null;
  },
};

async function loadConversationContext({ context, runtimeContext }, authorizedReaders = readers) {
  if (!isPlainObject(context) || Object.keys(context).some((key) => key !== "record")) invalid();
  if (!Object.hasOwn(context, "record")) return null;
  const record = context.record;
  if (!isPlainObject(record) || !TYPES.has(record.type) || Object.keys(record).some((key) => !["type", "id", "jobId"].includes(key))) invalid();
  const numeric = ["CONVERSATION", "JOB_REQUEST"].includes(record.type);
  if (typeof record.id !== "string" || !(numeric ? /^[1-9]\d*$/.test(record.id) && Number.isSafeInteger(Number(record.id)) : UUID.test(record.id))) invalid();
  if (record.type === "VISIT" ? !UUID.test(record.jobId || "") : Object.hasOwn(record, "jobId")) invalid();
  const role = runtimeContext.authenticatedActor.role;
  if (PROFESSIONAL.has(record.type) && role !== "professional") invalid();
  const facts = await authorizedReaders[record.type]({ pool: runtimeContext.pool, authenticatedActor: runtimeContext.authenticatedActor }, record, role);
  if (!facts) invalid();
  return { type: record.type, id: record.id, facts: boundedFacts(facts), coverage: "Bounded authorized excerpt; omitted fields and history are not evidence of absence." };
}

module.exports = { loadConversationContext, boundedFacts };
