"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildBusinessDocumentCustomerPackage,
  customerPackageLines,
} = require("../server/documents/businessDocumentCustomerPackage");

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const REQUIREMENT_ID = "22222222-2222-4222-8222-222222222222";
const QUOTE_ID = "33333333-3333-4333-8333-333333333333";
const DECISION_ID = "44444444-4444-4444-8444-444444444444";

function depositDocument() {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    documentType: "DEPOSIT_REQUEST",
    reference: "WDR-TEST",
    version: 2,
    jobId: JOB_ID,
    paymentRequirementId: REQUIREMENT_ID,
    content: {
      customerName: "Bob Hamel",
      customerEmail: "bob@example.test",
      customerAddress: "4135 Residence Drive",
      customerLocation: "4135 Residence Drive",
      serviceLocation: "4135 Residence Drive",
      projectTitle: "Window repair",
      projectDescription: "Repair the damaged windows.",
      recommendedSolution: "Repair the windows and damaged trim.",
      quoteReference: "Q-0000049",
      paymentInstructions: "Pay by check, Venmo, or Zelle.",
    },
    depositRequestAuthority: {
      paymentRequirementId: REQUIREMENT_ID,
      jobId: JOB_ID,
      relationshipId: 341,
      quoteId: QUOTE_ID,
      issuedQuoteVersion: 7,
      customerDecisionId: DECISION_ID,
      state: "DUE",
      currency: "USD",
      quoteTotalMinor: 68000,
      requiredMinor: 34000,
      appliedMinor: 0,
      remainingMinor: 34000,
      latestVersion: 1,
      quoteReference: "Q-0000049",
      depositRule: {
        type: "PERCENT",
        percentBasisPoints: 5000,
        fixedMinor: null,
      },
    },
    photos: [],
  };
}

test("R4 Deposit Request carries approved scope and governed deposit terms", () => {
  const pkg = buildBusinessDocumentCustomerPackage(
    depositDocument(),
    { business_name: "BGone Handyman" }
  );

  assert.equal(
    pkg.project.scope,
    "Repair the windows and damaged trim."
  );

  assert.equal(
    pkg.depositRequest.approvedQuoteReference,
    "Q-0000049"
  );

  assert.equal(pkg.depositRequest.issuedQuoteVersion, 7);

  assert.deepEqual(pkg.depositRequest.depositRule, {
    type: "PERCENT",
    percentBasisPoints: 5000,
    fixedMinor: null,
  });

  assert.equal(pkg.depositRequest.projectTotalMinor, 68000);
  assert.equal(pkg.depositRequest.requestedMinor, 34000);
  assert.equal(pkg.depositRequest.remainingAfterDepositMinor, 34000);
  assert.equal(pkg.depositRequest.amountStillNeededMinor, 34000);
});

test("R4 Deposit Request customer text carries commercial context and never calls it an Invoice", () => {
  const pkg = buildBusinessDocumentCustomerPackage(
    depositDocument(),
    { business_name: "BGone Handyman" }
  );

  const lines = customerPackageLines(pkg);

  assert.equal(
    lines.some((line) => /^DEPOSIT REQUEST /.test(line)),
    true
  );

  assert.equal(
    lines.some((line) =>
      line.startsWith("Approved scope") &&
      line.includes("Repair the windows and damaged trim.")
    ),
    true
  );

  assert.equal(
    lines.some((line) =>
      line === "Approved Quote: Q-0000049 · Version 7"
    ),
    true
  );

  assert.equal(
    lines.some((line) =>
      line === "Deposit terms: 50% of approved Quote"
    ),
    true
  );

  assert.equal(
    lines.some((line) => /^Deposit requested:/i.test(line)),
    true
  );

  assert.equal(
    lines.some((line) => /^INVOICE /.test(line)),
    false
  );
});
