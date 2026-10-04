"use strict";

const DEPOSIT_PERCENT_PATTERN = /(?:^|[^0-9])(\d{1,3}(?:\.\d+)?)\s*%\s*(?:deposit|down payment)\b/i;

function boundedText(value, maximum = 160) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, maximum) : null;
}

function deriveQuoteDepositGate({ customerTermsSnapshot, totalMinor } = {}) {
  const paymentTerms = boundedText(customerTermsSnapshot?.paymentTerms, 8000);
  const canonicalTotal = Number(totalMinor);
  if (!paymentTerms || !Number.isSafeInteger(canonicalTotal) || canonicalTotal < 0) {
    return Object.freeze({ state: "NONE", paymentTerms: paymentTerms || null });
  }
  if (!/\b(?:deposit|down payment)\b/i.test(paymentTerms)) {
    return Object.freeze({ state: "NONE", paymentTerms });
  }
  const match = paymentTerms.match(DEPOSIT_PERCENT_PATTERN);
  const percent = match ? Number(match[1]) : null;
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return Object.freeze({ state: "DEPOSIT_TERMS_UNVERIFIED", paymentTerms });
  }
  const dueMinor = Math.round((canonicalTotal * percent) / 100);
  if (!Number.isSafeInteger(dueMinor) || dueMinor < 0 || dueMinor > canonicalTotal) {
    return Object.freeze({ state: "DEPOSIT_TERMS_UNVERIFIED", paymentTerms });
  }
  return Object.freeze({
    state: "DEPOSIT_DUE",
    paymentTerms,
    percent,
    dueMinor,
    remainingMinor: canonicalTotal - dueMinor,
  });
}

module.exports = {
  deriveQuoteDepositGate,
};
