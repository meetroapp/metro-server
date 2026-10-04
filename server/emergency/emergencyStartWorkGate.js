"use strict";

const { loadEmergencyProfessionalContext, loadEmergencyQuoteApprovalSource } = require("./emergencyCommercialContext");
const { quoteDraftServiceInternals } = require("../authorization/quoteDraftService");
const { evaluateApprovedWorkDepositGateWithClient } = require("../finance/preWorkDepositService");

function blocked(code, message) {
  return { success: false, status: 409, code, message };
}

async function requireEmergencyStartWork({ client, emergencyRequest, relationship, conversation, actorId }) {
  const context = await loadEmergencyProfessionalContext(client, {
    emergencyRequestId: emergencyRequest.id, actorId, lock: true,
  });
  if (!context || emergencyRequest.status !== "professional_arrived" || !emergencyRequest.arrived_at
      || context.emergency_status !== "professional_arrived" || !context.arrived_at
      || Number(context.relationship_id) !== Number(relationship.id)
      || Number(context.conversation_id) !== Number(conversation.id)) {
    return blocked("EMERGENCY_WORK_AUTHORITY_REQUIRED", "Confirmed arrival and exact selected Emergency authority are required before work can start.");
  }
  const evaluationError = await quoteDraftServiceInternals.requireEmergencyJobEvaluation({
    client, context, logger: { warn() {} },
  });
  if (evaluationError) {
    return blocked("EMERGENCY_EVALUATION_REQUIRED_BEFORE_WORK", "A completed Emergency Evaluation is required before work can start.");
  }
  // Bind the current issued agreement. A later declined/pending Quote cannot
  // fall back to a previously approved Quote to unlock work.
  const approval = await loadEmergencyQuoteApprovalSource(client, {
    jobId: context.job_id, lock: true, latestIssuedQuote: true,
  });
  if (!approval) {
    return blocked("EMERGENCY_APPROVED_QUOTE_REQUIRED_BEFORE_WORK", "Homeowner approval of the issued Emergency Quote is required before work can start.");
  }
  const gate = await evaluateApprovedWorkDepositGateWithClient({
    client, jobId: context.job_id, quoteApprovalId: approval.quote_approval_id, lock: true,
  });
  if (!gate.allowed) {
    if (gate.state === "TERMS_UNVERIFIED") {
      return blocked("EMERGENCY_DEPOSIT_TERMS_UNVERIFIED", "The approved deposit terms must be verified before work can start.");
    }
    if (gate.state === "UNAVAILABLE") {
      return blocked("EMERGENCY_APPROVED_QUOTE_REQUIRED_BEFORE_WORK", "An exact approved Emergency Quote is required before work can start.");
    }
    return blocked("EMERGENCY_DEPOSIT_REQUIRED_BEFORE_WORK", "The required deposit must be fully satisfied before work can start.");
  }
  return null;
}

module.exports = { requireEmergencyStartWork };
