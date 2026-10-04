"use strict";

const REVENUE_STATES = Object.freeze({
  READY: "READY",
  MULTI_CURRENCY: "MULTI_CURRENCY",
  UNSAFE_FINANCIAL_HISTORY: "UNSAFE_FINANCIAL_HISTORY",
});

const INVOICE_CURRENT_OUTSTANDING =
  new Set(["SENT", "PARTIALLY_PAID"]);

function currency(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toUpperCase()
      : "";

  return /^[A-Z]{3}$/.test(normalized)
    ? normalized
    : null;
}

function positiveMinor(value) {
  const number = Number(value);

  return Number.isSafeInteger(number) &&
    number > 0
    ? number
    : null;
}

function nonNegativeMinor(value) {
  const number = Number(value);

  return Number.isSafeInteger(number) &&
    number >= 0
    ? number
    : null;
}

function dateOnly(value) {
  const normalized =
    typeof value === "string"
      ? value.trim()
      : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  const parsed =
    new Date(`${normalized}T00:00:00.000Z`);

  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : null;
}

function timestamp(value) {
  if (!value) return null;

  const parsed =
    value instanceof Date
      ? value
      : new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString();
}

function timestampInRange(value, range) {
  const exact = timestamp(value);

  if (!exact) return null;

  return exact >= range.startsAt &&
    exact < range.endsAt;
}

function dateInRange(value, range) {
  const exact = dateOnly(value);

  if (!exact) return null;

  return exact >= range.localStartDate &&
    exact < range.localEndDateExclusive;
}

function safeAdd(left, right) {
  const result =
    Number(left) + Number(right);

  return Number.isSafeInteger(result)
    ? result
    : null;
}

function safeSubtract(left, right) {
  const result =
    Number(left) - Number(right);

  return Number.isSafeInteger(result)
    ? result
    : null;
}

function unsafe(range) {
  return Object.freeze({
    state:
      REVENUE_STATES.UNSAFE_FINANCIAL_HISTORY,
    period: range?.period || null,
    timeZone: range?.timeZone || null,
    localStartDate:
      range?.localStartDate || null,
    localEndDateExclusive:
      range?.localEndDateExclusive || null,
    currency: null,
    cashReceivedMinor: null,
    invoicedMinor: null,
    outstandingMinor: null,
    paidInvoices: null,
  });
}

function multiCurrency(range) {
  return Object.freeze({
    state:
      REVENUE_STATES.MULTI_CURRENCY,
    period: range.period,
    timeZone: range.timeZone,
    localStartDate: range.localStartDate,
    localEndDateExclusive:
      range.localEndDateExclusive,
    currency: null,
    cashReceivedMinor: null,
    invoicedMinor: null,
    outstandingMinor: null,
    paidInvoices: null,
  });
}

function validRange(range) {
  return Boolean(
    range &&
    typeof range.period === "string" &&
    typeof range.timeZone === "string" &&
    dateOnly(range.localStartDate) &&
    dateOnly(range.localEndDateExclusive) &&
    timestamp(range.startsAt) &&
    timestamp(range.endsAt) &&
    range.localStartDate <
      range.localEndDateExclusive &&
    range.startsAt < range.endsAt
  );
}

function buildRevenueFinancialTruth({
  range,
  preWorkReceipts = [],
  preWorkReversals = [],
  invoicePayments = [],
  invoiceIssuances = [],
  currentInvoices = [],
  firstPaidTransitions = [],
} = {}) {
  if (
    !validRange(range) ||
    !Array.isArray(preWorkReceipts) ||
    !Array.isArray(preWorkReversals) ||
    !Array.isArray(invoicePayments) ||
    !Array.isArray(invoiceIssuances) ||
    !Array.isArray(currentInvoices) ||
    !Array.isArray(firstPaidTransitions)
  ) {
    return unsafe(range);
  }

  let cashReceivedMinor = 0;
  let invoicedMinor = 0;
  let outstandingMinor = 0;
  let paidInvoices = 0;

  const currencies = new Set();
  const receiptIds = new Set();
  const reversalIds = new Set();
  const paymentIds = new Set();
  const issuanceInvoiceIds = new Set();
  const currentInvoiceIds = new Set();
  const paidInvoiceIds = new Set();

  for (const receipt of preWorkReceipts) {
    const id =
      String(receipt?.receiptId || "").trim();

    const amount =
      positiveMinor(receipt?.grossAmountMinor);

    const code =
      currency(receipt?.currency);

    const receivedAt =
      timestamp(receipt?.receivedAt);

    if (
      !id ||
      receiptIds.has(id) ||
      amount == null ||
      !code ||
      !receivedAt
    ) {
      return unsafe(range);
    }

    receiptIds.add(id);

    if (
      timestampInRange(
        receivedAt,
        range
      )
    ) {
      const next =
        safeAdd(
          cashReceivedMinor,
          amount
        );

      if (next == null) {
        return unsafe(range);
      }

      cashReceivedMinor = next;
      currencies.add(code);
    }
  }

  for (const reversal of preWorkReversals) {
    const id =
      String(reversal?.reversalId || "").trim();

    const amount =
      positiveMinor(reversal?.reversedMinor);

    const code =
      currency(reversal?.currency);

    const reversedAt =
      timestamp(reversal?.reversedAt);

    const effect =
      String(
        reversal?.reversalEffect || ""
      ).trim().toUpperCase();

    if (
      !id ||
      reversalIds.has(id) ||
      amount == null ||
      !code ||
      !reversedAt ||
      ![
        "DEALLOCATE",
        "RECEIPT_REVERSAL",
      ].includes(effect)
    ) {
      return unsafe(range);
    }

    reversalIds.add(id);

    // DEALLOCATE corrects obligation allocation only.
    // It is not cash leaving the Business.
    if (
      effect === "RECEIPT_REVERSAL" &&
      timestampInRange(
        reversedAt,
        range
      )
    ) {
      const next =
        safeSubtract(
          cashReceivedMinor,
          amount
        );

      if (next == null) {
        return unsafe(range);
      }

      cashReceivedMinor = next;
      currencies.add(code);
    }
  }

  for (const payment of invoicePayments) {
    const id =
      String(payment?.paymentId || "").trim();

    const amount =
      positiveMinor(payment?.amountMinor);

    const code =
      currency(payment?.currency);

    const receivedDate =
      dateOnly(payment?.receivedDate);

    if (
      !id ||
      paymentIds.has(id) ||
      amount == null ||
      !code ||
      !receivedDate
    ) {
      return unsafe(range);
    }

    paymentIds.add(id);

    if (
      dateInRange(
        receivedDate,
        range
      )
    ) {
      const next =
        safeAdd(
          cashReceivedMinor,
          amount
        );

      if (next == null) {
        return unsafe(range);
      }

      cashReceivedMinor = next;
      currencies.add(code);
    }
  }

  for (const issuance of invoiceIssuances) {
    const invoiceId =
      String(
        issuance?.invoiceId || ""
      ).trim();

    const amount =
      positiveMinor(issuance?.totalMinor);

    const code =
      currency(issuance?.currency);

    const issuedAt =
      timestamp(issuance?.issuedAt);

    if (
      !invoiceId ||
      issuanceInvoiceIds.has(invoiceId) ||
      amount == null ||
      !code ||
      !issuedAt
    ) {
      return unsafe(range);
    }

    issuanceInvoiceIds.add(invoiceId);

    if (
      timestampInRange(
        issuedAt,
        range
      )
    ) {
      const next =
        safeAdd(
          invoicedMinor,
          amount
        );

      if (next == null) {
        return unsafe(range);
      }

      invoicedMinor = next;
      currencies.add(code);
    }
  }

  for (const invoice of currentInvoices) {
    const invoiceId =
      String(
        invoice?.invoiceId || ""
      ).trim();

    const status =
      String(
        invoice?.status || ""
      ).trim().toUpperCase();

    const balance =
      nonNegativeMinor(
        invoice?.balanceMinor
      );

    const code =
      currency(invoice?.currency);

    if (
      !invoiceId ||
      currentInvoiceIds.has(invoiceId) ||
      ![
        "DRAFT",
        "SENT",
        "PARTIALLY_PAID",
        "PAID",
      ].includes(status) ||
      balance == null ||
      !code
    ) {
      return unsafe(range);
    }

    currentInvoiceIds.add(invoiceId);

    if (
      INVOICE_CURRENT_OUTSTANDING
        .has(status)
    ) {
      if (balance <= 0) {
        return unsafe(range);
      }

      const next =
        safeAdd(
          outstandingMinor,
          balance
        );

      if (next == null) {
        return unsafe(range);
      }

      outstandingMinor = next;
      currencies.add(code);
    } else if (
      status === "PAID" &&
      balance !== 0
    ) {
      return unsafe(range);
    }
  }

  for (
    const transition of firstPaidTransitions
  ) {
    const invoiceId =
      String(
        transition?.invoiceId || ""
      ).trim();

    const code =
      currency(transition?.currency);

    const source =
      String(
        transition?.source || ""
      ).trim().toUpperCase();

    if (
      !invoiceId ||
      paidInvoiceIds.has(invoiceId) ||
      !code ||
      !["ISSUANCE", "PAYMENT"].includes(source)
    ) {
      return unsafe(range);
    }

    paidInvoiceIds.add(invoiceId);

    let inRange = null;

    if (source === "ISSUANCE") {
      const occurredAt =
        timestamp(
          transition?.occurredAt
        );

      if (!occurredAt) {
        return unsafe(range);
      }

      inRange =
        timestampInRange(
          occurredAt,
          range
        );
    } else {
      const receivedDate =
        dateOnly(
          transition?.receivedDate
        );

      if (!receivedDate) {
        return unsafe(range);
      }

      inRange =
        dateInRange(
          receivedDate,
          range
        );
    }

    if (inRange) {
      paidInvoices += 1;
    }
  }

  if (currencies.size > 1) {
    return multiCurrency(range);
  }

  return Object.freeze({
    state: REVENUE_STATES.READY,
    period: range.period,
    timeZone: range.timeZone,
    localStartDate: range.localStartDate,
    localEndDateExclusive:
      range.localEndDateExclusive,
    currency:
      currencies.size === 1
        ? [...currencies][0]
        : null,
    cashReceivedMinor,
    invoicedMinor,
    outstandingMinor,
    paidInvoices,
  });
}

module.exports = {
  INVOICE_CURRENT_OUTSTANDING,
  REVENUE_STATES,
  buildRevenueFinancialTruth,
  dateInRange,
  timestampInRange,
};
