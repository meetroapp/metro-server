"use strict";

const { visitServiceInternals: { canonicalTimeZone, localDateKey } } = require("../workflow/visitService");
function scheduledVisit(visit, query, now) {
  if (visit.state !== "SCHEDULED" || !canonicalTimeZone(visit.timeZone) || !Number.isFinite(Date.parse(visit.scheduledStartAt))) return false;
  const instant = new Date(visit.scheduledStartAt);
  const today = localDateKey(now, visit.timeZone);
  const date = localDateKey(instant, visit.timeZone);
  if (query.next && instant < now) return false;
  if (query.day !== null) {
    const calendar = new Date(`${today}T12:00:00Z`);
    if (query.day === "tomorrow") calendar.setUTCDate(calendar.getUTCDate() + 1);
    else if (typeof query.day === "number") calendar.setUTCDate(calendar.getUTCDate() + (query.day - calendar.getUTCDay() + 7) % 7);
    if (date !== calendar.toISOString().slice(0, 10)) return false;
  }
  if (query.daypart) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: visit.timeZone, hour: "2-digit", hourCycle: "h23" }).format(instant));
    if (query.daypart === "morning" ? hour < 5 || hour >= 12 : query.daypart === "afternoon" ? hour < 12 || hour >= 17 : hour >= 5 && hour < 17) return false;
  }
  return true;
}
function scheduleText(visit) {
  return `${new Intl.DateTimeFormat("en-US", { timeZone: visit.timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.scheduledStartAt))} (${visit.timeZone})`;
}
function money(minor, currency) {
  if (!Number.isSafeInteger(minor) || minor < 0 || !/^[A-Z]{3}$/.test(currency || "")) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}

// Only explicitly projected canonical fields can answer factual questions.
// Missing facts are unknown; working draft values are never payment evidence.
function recordAnswer(item, query) {
  const facts = item.context.facts;
  if (query.kind === "SCHEDULE") return item.visits?.length ? item.visits.map(scheduleText).join("; ") : "No matching confirmed schedule was available in this authorized read.";
  if (query.kind === "DEPOSIT") {
    const deposit = item.deposit;
    if (!deposit) return "Deposit status is unavailable in this authorized read.";
    const amount = money(deposit.remainingMinor, deposit.currency);
    return `Deposit: ${deposit.state || "unavailable"}${amount ? `; ${amount} remaining` : ""}.`;
  }
  if (query.kind === "INVOICE") {
    if (item.record.type === "DOCUMENT_DRAFT") return "This is a working document, not payment evidence. Payment status is not confirmed here.";
    const remaining = money(facts.balanceMinor, facts.currency);
    return `Invoice status: ${facts.status || "unavailable"}${remaining ? `; ${remaining} unpaid` : ""}.`;
  }
  if (query.kind === "QUOTE") {
    if (item.record.type === "DOCUMENT_DRAFT") return "Working draft. Quote approval is not established by this draft.";
    const decision = facts.customerDecision?.decision || facts.customerDecision || facts.approval?.decision || facts.customerResponse?.decision || facts.approvalStatus || facts.decisionState || (facts.approval?.id && ["MEETRO_CUSTOMER", "EXTERNAL_EVIDENCE"].includes(facts.approval.source) ? "APPROVED" : null);
    return `Quote status: ${facts.status || "unavailable"}; customer decision: ${typeof decision === "string" ? decision : "not confirmed in this read"}.`;
  }
  return `Current status: ${facts.stage?.label || facts.status || "unavailable in this authorized read"}.`;
}
function includeInAggregate(item, query) {
  if (query.kind === "SCHEDULE") return Boolean(item.visits?.length);
  if (query.inProgress) return item.context.facts.stage?.code === "WORK_IN_PROGRESS" || item.context.facts.status === "IN_PROGRESS";
  if (query.outstanding && query.kind === "DEPOSIT") return Number.isSafeInteger(item.deposit?.remainingMinor) && item.deposit.remainingMinor > 0;
  if (query.outstanding && query.kind === "INVOICE") return item.record.type === "INVOICE" && Number.isSafeInteger(item.context.facts.balanceMinor) && item.context.facts.balanceMinor > 0 && ["SENT", "PARTIALLY_PAID"].includes(item.context.facts.status);
  if (query.outstanding && query.kind === "QUOTE") return item.record.type === "QUOTE" && item.waitingForApproval === true;

  return true;
}
module.exports = { scheduledVisit, recordAnswer, includeInAggregate };
