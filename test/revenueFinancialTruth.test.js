"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRevenuePeriod,
} = require("../server/finance/revenuePeriod");

const {
  buildRevenueFinancialTruth,
} = require("../server/finance/revenueFinancialTruth");

const NOW =
  new Date("2026-09-15T16:30:00.000Z");

function range(period = "LAST_30_DAYS") {
  return buildRevenuePeriod({
    period,
    timeZone: "America/New_York",
    now: NOW,
  });
}

function fixtureInput(period = "LAST_30_DAYS") {
  return {
    range: range(period),

    preWorkReceipts: [
      {
        receiptId: "deposit-510",
        grossAmountMinor: 51000,
        currency: "USD",
        receivedAt:
          "2026-08-29T14:00:00.000Z",
      },
    ],

    preWorkReversals: [],

    invoicePayments: [
      {
        paymentId: "invoice-payment-170",
        amountMinor: 17000,
        currency: "USD",
        receivedDate: "2026-09-12",
      },
    ],

    invoiceIssuances: [
      {
        invoiceId: "invoice-680",
        totalMinor: 68000,
        currency: "USD",
        issuedAt:
          "2026-09-10T16:00:00.000Z",
      },
    ],

    currentInvoices: [
      {
        invoiceId: "invoice-680",
        status: "PAID",
        balanceMinor: 0,
        currency: "USD",
      },
    ],

    firstPaidTransitions: [
      {
        invoiceId: "invoice-680",
        currency: "USD",
        source: "PAYMENT",
        receivedDate: "2026-09-12",
      },
    ],
  };
}

test("certified lifecycle contributes $680 cash exactly once across the 30-day period", () => {
  const truth =
    buildRevenueFinancialTruth(
      fixtureInput()
    );

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.currency,
    "USD"
  );

  assert.equal(
    truth.cashReceivedMinor,
    68000
  );

  assert.equal(
    truth.invoicedMinor,
    68000
  );

  assert.equal(
    truth.outstandingMinor,
    0
  );

  assert.equal(
    truth.paidInvoices,
    1
  );

  assert.notEqual(
    truth.cashReceivedMinor,
    119000
  );

  assert.notEqual(
    truth.cashReceivedMinor,
    136000
  );
});

test("THIS_MONTH includes the final $170 payment but not the August deposit", () => {
  const truth =
    buildRevenueFinancialTruth(
      fixtureInput("THIS_MONTH")
    );

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.cashReceivedMinor,
    17000
  );

  assert.equal(
    truth.invoicedMinor,
    68000
  );

  assert.equal(
    truth.outstandingMinor,
    0
  );

  assert.equal(
    truth.paidInvoices,
    1
  );
});

test("DEALLOCATE correction changes allocation only and never reduces Cash Received", () => {
  const input =
    fixtureInput();

  input.preWorkReversals.push({
    reversalId: "allocation-correction",
    reversedMinor: 10000,
    currency: "USD",
    reversalEffect: "DEALLOCATE",
    reversedAt:
      "2026-09-14T15:00:00.000Z",
  });

  const truth =
    buildRevenueFinancialTruth(input);

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.cashReceivedMinor,
    68000
  );
});

test("RECEIPT_REVERSAL reduces cash in the reversal reporting period", () => {
  const input =
    fixtureInput();

  input.preWorkReversals.push({
    reversalId: "verified-refund",
    reversedMinor: 10000,
    currency: "USD",
    reversalEffect:
      "RECEIPT_REVERSAL",
    reversedAt:
      "2026-09-14T15:00:00.000Z",
  });

  const truth =
    buildRevenueFinancialTruth(input);

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.cashReceivedMinor,
    58000
  );
});

test("refund-only periods may truthfully report negative net Cash Received", () => {
  const truth =
    buildRevenueFinancialTruth({
      range: range("THIS_MONTH"),

      preWorkReceipts: [],

      preWorkReversals: [
        {
          reversalId: "old-cash-refund",
          reversedMinor: 10000,
          currency: "USD",
          reversalEffect:
            "RECEIPT_REVERSAL",
          reversedAt:
            "2026-09-14T15:00:00.000Z",
        },
      ],

      invoicePayments: [],
      invoiceIssuances: [],
      currentInvoices: [],
      firstPaidTransitions: [],
    });

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.currency,
    "USD"
  );

  assert.equal(
    truth.cashReceivedMinor,
    -10000
  );
});

test("Outstanding now is current truth and is not restricted by the activity period", () => {
  const truth =
    buildRevenueFinancialTruth({
      range: range("THIS_MONTH"),

      preWorkReceipts: [],
      preWorkReversals: [],
      invoicePayments: [],
      invoiceIssuances: [],

      currentInvoices: [
        {
          invoiceId: "older-open-invoice",
          status: "PARTIALLY_PAID",
          balanceMinor: 32000,
          currency: "USD",
        },
      ],

      firstPaidTransitions: [],
    });

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.cashReceivedMinor,
    0
  );

  assert.equal(
    truth.invoicedMinor,
    0
  );

  assert.equal(
    truth.outstandingMinor,
    32000
  );
});

test("first PAID transition uses its canonical source date and counts each Invoice once", () => {
  const truth =
    buildRevenueFinancialTruth({
      range: range("THIS_MONTH"),

      preWorkReceipts: [],
      preWorkReversals: [],
      invoicePayments: [],

      invoiceIssuances: [
        {
          invoiceId: "paid-at-issue",
          totalMinor: 25000,
          currency: "USD",
          issuedAt:
            "2026-09-03T16:00:00.000Z",
        },
        {
          invoiceId: "paid-later",
          totalMinor: 30000,
          currency: "USD",
          issuedAt:
            "2026-09-04T16:00:00.000Z",
        },
      ],

      currentInvoices: [
        {
          invoiceId: "paid-at-issue",
          status: "PAID",
          balanceMinor: 0,
          currency: "USD",
        },
        {
          invoiceId: "paid-later",
          status: "PAID",
          balanceMinor: 0,
          currency: "USD",
        },
      ],

      firstPaidTransitions: [
        {
          invoiceId: "paid-at-issue",
          currency: "USD",
          source: "ISSUANCE",
          occurredAt:
            "2026-09-03T16:00:00.000Z",
        },
        {
          invoiceId: "paid-later",
          currency: "USD",
          source: "PAYMENT",
          receivedDate: "2026-09-12",
        },
      ],
    });

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.invoicedMinor,
    55000
  );

  assert.equal(
    truth.paidInvoices,
    2
  );
});

test("mixed monetary currencies fail closed rather than being added together", () => {
  const truth =
    buildRevenueFinancialTruth({
      range: range(),

      preWorkReceipts: [
        {
          receiptId: "usd-receipt",
          grossAmountMinor: 10000,
          currency: "USD",
          receivedAt:
            "2026-09-01T12:00:00.000Z",
        },
      ],

      preWorkReversals: [],

      invoicePayments: [],

      invoiceIssuances: [
        {
          invoiceId: "eur-invoice",
          totalMinor: 20000,
          currency: "EUR",
          issuedAt:
            "2026-09-02T12:00:00.000Z",
        },
      ],

      currentInvoices: [],
      firstPaidTransitions: [],
    });

  assert.equal(
    truth.state,
    "MULTI_CURRENCY"
  );

  assert.equal(
    truth.currency,
    null
  );

  assert.equal(
    truth.cashReceivedMinor,
    null
  );

  assert.equal(
    truth.invoicedMinor,
    null
  );
});

test("duplicate or malformed canonical event history fails closed", () => {
  const input =
    fixtureInput();

  input.invoiceIssuances.push({
    ...input.invoiceIssuances[0],
  });

  const duplicate =
    buildRevenueFinancialTruth(input);

  assert.equal(
    duplicate.state,
    "UNSAFE_FINANCIAL_HISTORY"
  );

  const malformed =
    buildRevenueFinancialTruth({
      ...fixtureInput(),
      invoicePayments: [
        {
          paymentId: "bad-payment",
          amountMinor: -100,
          currency: "USD",
          receivedDate: "2026-09-12",
        },
      ],
    });

  assert.equal(
    malformed.state,
    "UNSAFE_FINANCIAL_HISTORY"
  );
});
