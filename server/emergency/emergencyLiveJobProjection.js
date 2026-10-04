"use strict";

const { hasActiveLifecycleGrant } = require("../authorization/lifecycleAuthorityService");
const { listEvaluationsForEmergencyRequest } = require("../authorization/evaluationService");
const { listDraftQuotesByJob, quoteDraftServiceInternals } = require("../authorization/quoteDraftService");
const { loadEmergencyQuoteApprovalSource } = require("./emergencyCommercialContext");
const { evaluateApprovedWorkDepositGateWithClient, preWorkDepositServiceInternals } = require("../finance/preWorkDepositService");
const { loadCompletionReadiness, readinessProjection } = require("../workflow/jobCompletionService");
const { invoicePaymentInternals } = require("../finance/invoicePaymentService");

const CAPABILITIES = ["participant.read", "quote.read", "evaluation.perform", "quote.create", "quote.scope.manage"];
const quiet = { info() {}, warn() {} };
const iso = value => value == null ? null : new Date(value).toISOString();

// Reads the same authorities used by the certified commands. No locks,
// materialization, scheduling reads, or commercial state writes occur here.
async function loadEmergencyLiveState(client, context) {
  const capabilities = [];
  for (const capability of CAPABILITIES) {
    if (await hasActiveLifecycleGrant({ client, participantId: context.professional_participant_id,
      capability, jobId: context.job_id, logger: quiet })) capabilities.push(capability);
  }
  if (!capabilities.includes("participant.read") || !capabilities.includes("quote.read")) {
    return { error: { ok: false, status: 403, code: "LIVE_JOB_READ_AUTHORITY_REQUIRED", message: "Current Job read authority is required." } };
  }
  const actor = { id: Number(context.professional_user_id) };
  const evaluations = await listEvaluationsForEmergencyRequest({ pool: client, authenticatedActor: actor,
    emergencyRequestId: Number(context.emergency_request_id) });
  if (!evaluations.ok) return { error: evaluations };
  const evaluation = evaluations.evaluations.find(item =>
    item.aggregate.sourceContext.type === "emergency_request" &&
    item.aggregate.sourceContext.emergencyRequestId === Number(context.emergency_request_id) &&
    item.aggregate.sourceContext.relationshipId === Number(context.relationship_id)) || null;
  const evidence = await quoteDraftServiceInternals.requireEmergencyJobEvaluation({
    client, context, logger: quiet, returnEvidence: true,
  });
  const completedEvaluation = evidence?.id ? evidence : null;
  // The certified Quote reader requires confirmed arrival. Dispatch remains
  // readable before that prerequisite without weakening Quote authority.
  const quoteReadable = context.arrived_at &&
    ["professional_arrived", "work_in_progress", "completed"].includes(context.emergency_status);
  const quoteResult = quoteReadable ? await listDraftQuotesByJob({ pool: client, authenticatedActor: actor,
    jobId: context.job_id, logger: quiet }) : { ok: true, quotes: [] };
  if (!quoteResult.ok) return { error: quoteResult };
  const quotes = quoteResult.quotes.filter(quote => quote.jobId === context.job_id &&
    quote.requestId === null && quote.relationshipId === Number(context.relationship_id) &&
    quote.issuerParticipantId === context.professional_participant_id);
  // Matches the certified start gate's latest-issued rule. A newer draft does
  // not replace an issued agreement, while a newer issued Quote does.
  const issued = quotes.filter(quote => quote.status === "ISSUED").sort((a, b) =>
    new Date(b.issuedAt) - new Date(a.issuedAt) || b.id.localeCompare(a.id))[0] || null;
  const approval = await loadEmergencyQuoteApprovalSource(client, {
    jobId: context.job_id, latestIssuedQuote: true,
  });
  const currentApproval = approval && issued && issued.id === approval.quote_id &&
    issued.currentVersion === Number(approval.issued_quote_version) ? approval : null;
  const depositGate = currentApproval ? await evaluateApprovedWorkDepositGateWithClient({
    client, jobId: context.job_id, quoteApprovalId: currentApproval.quote_approval_id,
  }) : null;
  // Preserve the canonical deposit calculation and amounts; only adapt the
  // read label for unverified terms. There is no separate Emergency ledger.
  const deposit = depositGate?.source ? preWorkDepositServiceInternals.depositProjection(
    depositGate.source, depositGate.requirement, depositGate.obligation, []) : null;
  const completionReview = context.emergency_status === "work_in_progress"
    ? readinessProjection(context, await loadCompletionReadiness(client, context.job_id, context)) : null;
  const invoice = context.completion_id ? await invoicePaymentInternals.loadEmergencyInvoiceContext(client, {
    jobId: context.job_id, actorId: actor.id,
  }) : null;
  return { capabilities, evaluation, completedEvaluation, quotes, issued,
    approval: currentApproval, depositGate, deposit, completionReview, invoice };
}

function deriveEmergencyLiveJob(context, state, { derivedAt = new Date().toISOString() } = {}) {
  const has = capability => state.capabilities.includes(capability);
  const depositVerified = ["NOT_REQUIRED", "DUE", "PARTIALLY_SATISFIED", "SATISFIED"].includes(state.depositGate?.state);
  const depositSatisfied = state.depositGate?.allowed === true &&
    ["NOT_REQUIRED", "SATISFIED"].includes(state.depositGate.state);
  let stage, label, action, actionLabel, blocker = null, responsibility = "PROFESSIONAL", available = true;
  const invoice = state.invoice;
  if (invoice) {
    stage = invoice.status === "PAID" ? "PAID" : invoice.status === "PARTIALLY_PAID" ? "PARTIALLY_PAID" : "FINAL_INVOICE";
    label = stage === "PAID" ? "Paid" : stage === "PARTIALLY_PAID" ? "Partially Paid" : "Final Invoice";
    action = stage === "PAID" ? "VIEW_JOB_HISTORY" : "VIEW_INVOICE";
    actionLabel = stage === "PAID" ? "View History" : "View Invoice";
    responsibility = invoice.status === "PAID" ? "NONE" : invoice.status === "DRAFT" ? "PROFESSIONAL" : "CUSTOMER";
  } else if (context.completion_id) {
    stage = "JOB_COMPLETED"; label = "Ready to Invoice";
    action = "CREATE_FINAL_INVOICE"; actionLabel = "Create Final Invoice";
  } else if (context.emergency_status === "work_in_progress") {
    stage = "WORK_IN_PROGRESS"; label = "Work In Progress";
    action = "COMPLETE_WORK"; actionLabel = "Complete Work";
    available = state.completionReview?.canComplete === true;
    if (!available) blocker = { code: "EMERGENCY_COMPLETION_NOT_AVAILABLE", label: "Review the Emergency completion requirements." };
  } else if (context.emergency_status === "assigned") {
    stage = "ASSIGNED"; label = "Assigned"; action = "MARK_EN_ROUTE"; actionLabel = "Start Driving";
  } else if (context.emergency_status === "professional_en_route") {
    stage = "ON_THE_WAY"; label = "On the Way"; action = "MARK_ARRIVED"; actionLabel = "Mark Arrived";
  } else if (context.emergency_status !== "professional_arrived" || !context.arrived_at) {
    stage = "EMERGENCY_REVIEW_REQUIRED"; label = "Emergency status needs review";
    action = "REVIEW_EMERGENCY"; actionLabel = "Review Emergency"; available = false;
    blocker = { code: "EMERGENCY_ARRIVAL_REQUIRED", label: "Confirmed Emergency arrival is required." };
  } else if (!state.completedEvaluation) {
    const inProgress = state.evaluation?.evaluation.status === "draft";
    stage = inProgress ? "EVALUATION_IN_PROGRESS" : "EVALUATION_NEEDED";
    label = inProgress ? "Evaluation In Progress" : "Arrived · Evaluation Required";
    action = inProgress ? "EDIT_EVALUATION" : "START_EVALUATION";
    actionLabel = inProgress ? "Continue Evaluation" : "Open Evaluation";
    available = has("evaluation.perform");
    blocker = { code: inProgress ? "EVALUATION_INCOMPLETE" : "EVALUATION_NOT_RECORDED", label: "Complete the Emergency Evaluation before preparing a Quote." };
  } else if (state.approval) {
    if (!depositSatisfied) {
      const unverified = !depositVerified;
      stage = "QUOTE_APPROVED_DEPOSIT_DUE"; label = unverified ? "Deposit Unverified" : "Deposit Required";
      action = "VIEW_DEPOSIT"; actionLabel = "View Deposit";
      blocker = { code: unverified ? "DEPOSIT_UNVERIFIED" : "QUOTE_DEPOSIT_NOT_SATISFIED", label: unverified ? "The approved deposit terms must be verified." : "The required deposit must be fully satisfied before work can start." };
    } else {
      stage = "WORK_READY"; label = "Ready to Start"; action = "START_WORK"; actionLabel = "Start Work";
    }
  } else if (state.issued) {
    const declined = state.issued.decisionState === "DECLINED" && state.issued.decisionVersion === state.issued.currentVersion;
    stage = declined ? "QUOTE_DECLINED" : "WAITING_FOR_CUSTOMER_DECISION";
    label = declined ? "Declined" : "Awaiting Approval";
    action = "REVIEW_QUOTE"; actionLabel = "View Quote";
    responsibility = declined ? "PROFESSIONAL" : "CUSTOMER";
    blocker = { code: declined ? "CUSTOMER_DECLINED_QUOTE" : "CUSTOMER_DECISION_PENDING", label: declined ? "The customer declined the current Quote." : "Customer approval of the issued Quote is required." };
  } else {
    const draft = state.quotes.some(quote => quote.status === "DRAFT");
    stage = draft ? "QUOTE_DRAFT" : "QUOTE_NEEDED"; label = "Quote Required";
    action = draft ? "REVIEW_QUOTE" : "CREATE_QUOTE"; actionLabel = draft ? "Continue Quote" : "Create Quote";
    available = draft || (has("quote.create") && has("quote.scope.manage"));
  }
  const currentAction = { code: action, label: actionLabel };
  const deposit = state.deposit ? {
    ...state.deposit,
    state: depositVerified ? state.deposit.state : "UNVERIFIED",
    // Scheduling terminology is not an Emergency prerequisite.
    startWorkLocked: !depositSatisfied,
  } : state.approval ? { state: "UNVERIFIED", startWorkLocked: true } : null;
  if (deposit) delete deposit.schedulingLocked;
  return {
    contractVersion: 1,
    jobId: context.job_id, sourceType: "emergency_request", sourceLabel: "Emergency",
    requestId: null, relationshipId: Number(context.relationship_id),
    emergencyRequestId: Number(context.emergency_request_id), conversationId: Number(context.conversation_id),
    serviceTitle: context.job_title, customerLabel: context.customer_name || "Customer",
    stage: { code: stage, label },
    responsibility: { code: responsibility, label: { PROFESSIONAL: "Professional", CUSTOMER: "Customer", NONE: "No current responsibility" }[responsibility] },
    blocker, nextAction: { ...currentAction, description: actionLabel, available },
    availableActions: [...(available ? [currentAction] : []), { code: "MESSAGE_CUSTOMER", label: "Message Customer" }],
    reasonCodes: blocker ? [blocker.code] : [],
    dispatch: { status: context.emergency_status, assignedAt: iso(context.assigned_at), enRouteAt: iso(context.en_route_at),
      arrivedAt: iso(context.arrived_at), workStartedAt: iso(context.work_started_at), completedAt: iso(context.emergency_completed_at) },
    evaluation: { state: state.completedEvaluation ? "COMPLETE" : state.evaluation?.evaluation.status === "draft" ? "IN_PROGRESS" : "REQUIRED",
      evaluationId: state.completedEvaluation?.id || state.evaluation?.aggregate.id || null },
    quoteApprovalId: state.approval?.quote_approval_id || null,
    approvalSource: state.approval?.approval_source || null,
    approvedQuoteDecisionId: state.approval?.customer_decision_id || null,
    quote: state.issued ? { quoteId: state.issued.id, version: state.issued.currentVersion,
      state: state.approval ? "APPROVED" : state.issued.decisionState === "DECLINED" && state.issued.decisionVersion === state.issued.currentVersion ? "DECLINED" : "AWAITING_APPROVAL" } : null,
    deposit,
    invoice: invoice ? { invoiceId: invoice.invoice_id, status: invoice.status, currency: invoice.currency,
      totalMinor: Number(invoice.total_minor), paidMinor: Number(invoice.paid_minor), balanceMinor: Number(invoice.balance_minor) } : null,
    freshness: { derivedAt, jobCreatedAt: iso(context.job_created_at),
      evaluationVersion: Number(state.completedEvaluation?.evaluation_version || state.evaluation?.aggregate.version) || 0,
      quoteVersion: state.quotes.reduce((max, quote) => Math.max(max, quote.currentVersion), 0),
      depositVersion: Number(deposit?.latestVersion) || 0, invoiceVersion: Number(invoice?.version) || 0,
      completionVersion: Number(context.completion_version) || 0 },
  };
}

module.exports = { loadEmergencyLiveState, deriveEmergencyLiveJob };
