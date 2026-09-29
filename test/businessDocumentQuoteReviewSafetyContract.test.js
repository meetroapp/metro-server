"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  quoteDraftServiceInternals: {
    workingQuoteReviewSafety,
  },
} = require("../server/authorization/quoteDraftService");

function content(overrides = {}) {
  return {
    customerName: "Liam Molina",
    projectTitle:
      "Emergency Plumbing: Outside main waterline is leaking water",
    projectDescription: "Replace damaged main water line.",
    recommendedSolution: "",
    materialItems: [],
    laborItems: [],
    lineItems: [],
    totalOverride: "350.00",
    currency: "USD",
    paymentTerms: "Balance due on completion",
    estimatedDuration: "",
    notes: "",
    agreement: {
      exclusions: [],
    },
    ...overrides,
  };
}

test(
  "exact saved valid Quote returns ready server safety and blank duration remains optional",
  () => {
    const safety = workingQuoteReviewSafety(content());

    assert.deepEqual(safety, {
      ready: true,
      blockingErrors: [],
      warnings: [],
    });
  }
);

test(
  "missing payment terms is advisory and does not make the exact saved Quote unready",
  () => {
    const safety = workingQuoteReviewSafety(
      content({
        paymentTerms: "",
      })
    );

    assert.equal(safety.ready, true);
    assert.deepEqual(safety.blockingErrors, []);

    assert.deepEqual(safety.warnings, [
      {
        code: "QUOTE_PAYMENT_TERMS_MISSING",
        field: "terms",
        message:
          "Add payment terms so the customer knows when payment is expected.",
      },
    ]);

    assert.equal(
      safety.warnings.some(
        ({ code }) => code === "QUOTE_DURATION_MISSING"
      ),
      false
    );
  }
);

test("malformed saved commercial content fails closed", () => {
  const safety = workingQuoteReviewSafety(
    content({
      totalOverride: "350.000",
    })
  );

  assert.equal(safety.ready, false);
  assert.equal(safety.blockingErrors.length, 1);
  assert.match(
    safety.blockingErrors[0].code,
    /^QUOTE_/
  );
});

test("zero exact saved total fails closed", () => {
  const safety = workingQuoteReviewSafety(
    content({
      totalOverride: "0.00",
    })
  );

  assert.equal(safety.ready, false);

  assert.ok(
    safety.blockingErrors.some(
      ({ code }) => code === "QUOTE_TOTAL_REQUIRED"
    )
  );
});

test(
  "quote-review reads exact saved content and returns top-level server safety",
  () => {
    const source = readFileSync(
      join(
        __dirname,
        "..",
        "server",
        "authorization",
        "quoteDraftService.js"
      ),
      "utf8"
    );

    assert.match(
      source,
      /drafts\.content AS document_content/
    );

    assert.match(
      source,
      /code: "BUSINESS_DOCUMENT_QUOTE_REVIEW_LOADED",[\s\S]*review,[\s\S]*quoteSafety: workingQuoteReviewSafety\(row\.document_content\)/
    );
  }
);
