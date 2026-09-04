"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");

const {
  deriveQuoteDepositGate,
} = require("../server/authorization/quoteDecisionHandoff");

const {
  preWorkDepositServiceInternals,
} = require("../server/finance/preWorkDepositService");

const {
  workingQuoteConversion,
} = quoteDraftServiceInternals;

function quote(overrides = {}) {
  return {
    projectTitle: "Kitchen Remodel",
    totalOverride: "10000.00",
    currency: "USD",
    paymentTerms: "Balance due after completion.",
    depositMode: "PERCENT",
    depositPercent: "25",
    depositFixedAmount: "",
    ...overrides,
  };
}

test(
  "structured percentage deposit becomes approved Quote deposit authority",
  () => {
    const converted = workingQuoteConversion(quote());

    assert.equal(converted.error, undefined);
    assert.equal(converted.totals.totalMinor, 1000000);
    assert.match(
      converted.customerTermsSnapshot.paymentTerms,
      /25% deposit due on approval/
    );

    const gate = deriveQuoteDepositGate({
      customerTermsSnapshot:
        converted.customerTermsSnapshot,
      totalMinor: converted.totals.totalMinor,
    });

    assert.equal(gate.state, "DEPOSIT_DUE");
    assert.equal(gate.percent, 25);
    assert.equal(gate.dueMinor, 250000);
    assert.equal(gate.remainingMinor, 750000);
  }
);

test(
  "structured fixed deposit becomes canonical fixed deposit authority",
  () => {
    const converted = workingQuoteConversion(
      quote({
        depositMode: "FIXED",
        depositPercent: "",
        depositFixedAmount: "2500.00",
      })
    );

    assert.equal(converted.error, undefined);
    assert.match(
      converted.customerTermsSnapshot.paymentTerms,
      /Deposit due on approval: \$2500\.00/
    );

    const requirement =
      preWorkDepositServiceInternals.deriveDepositRequirement({
        customerTermsSnapshot:
          converted.customerTermsSnapshot,
        totalMinor: converted.totals.totalMinor,
      });

    assert.equal(requirement.kind, "REQUIRED");
    assert.equal(requirement.ruleType, "FIXED");
    assert.equal(requirement.requiredMinor, 250000);
  }
);

test(
  "same legacy deposit wording and structured deposit do not duplicate",
  () => {
    const converted = workingQuoteConversion(
      quote({
        paymentTerms:
          "25% deposit. Balance due after completion.",
      })
    );

    assert.equal(converted.error, undefined);

    const matches =
      converted.customerTermsSnapshot.paymentTerms.match(
        /25% deposit/gi
      ) || [];

    assert.equal(matches.length, 1);

    const gate = deriveQuoteDepositGate({
      customerTermsSnapshot:
        converted.customerTermsSnapshot,
      totalMinor: converted.totals.totalMinor,
    });

    assert.equal(gate.state, "DEPOSIT_DUE");
    assert.equal(gate.dueMinor, 250000);
  }
);

test(
  "conflicting structured and written deposit terms fail closed",
  () => {
    const converted = workingQuoteConversion(
      quote({
        paymentTerms:
          "50% deposit. Balance due after completion.",
      })
    );

    assert.equal(
      converted.error,
      "AMBIGUOUS_WORKING_QUOTE_DEPOSIT_TERMS"
    );
  }
);

test(
  "legacy text-only deposits remain supported",
  () => {
    const converted = workingQuoteConversion(
      quote({
        depositMode: "NONE",
        depositPercent: "",
        paymentTerms:
          "50% deposit due on approval. Balance due after completion.",
      })
    );

    assert.equal(converted.error, undefined);

    const gate = deriveQuoteDepositGate({
      customerTermsSnapshot:
        converted.customerTermsSnapshot,
      totalMinor: converted.totals.totalMinor,
    });

    assert.equal(gate.state, "DEPOSIT_DUE");
    assert.equal(gate.dueMinor, 500000);
  }
);

test(
  "fixed deposit cannot exceed approved Quote total",
  () => {
    const converted = workingQuoteConversion(
      quote({
        depositMode: "FIXED",
        depositPercent: "",
        depositFixedAmount: "12000.00",
      })
    );

    assert.equal(
      converted.error,
      "INVALID_WORKING_QUOTE_DEPOSIT"
    );
  }
);
