"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBusinessDocumentDraft,
} = require("../server/documents/businessDocumentDraftService");
const {
  buildBusinessDocumentCustomerPackage,
  customerPackageLines,
} = require("../server/documents/businessDocumentCustomerPackage");

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const REQUIREMENT_ID = "22222222-2222-4222-8222-222222222222";
const QUOTE_ID = "33333333-3333-4333-8333-333333333333";
const DECISION_ID = "44444444-4444-4444-8444-444444444444";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authority(overrides = {}) {
  return {
    paymentRequirementId: REQUIREMENT_ID,
    jobId: JOB_ID,
    relationshipId: 341,
    quoteId: QUOTE_ID,
    issuedQuoteVersion: 13,
    customerDecisionId: DECISION_ID,
    state: "DUE",
    currency: "USD",
    quoteTotalMinor: 68000,
    requiredMinor: 51000,
    appliedMinor: 0,
    remainingMinor: 51000,
    latestVersion: 1,
    quoteReference: "Q-0000001",
    depositRule: { type: "PERCENT", percentBasisPoints: 7500, fixedMinor: null },
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    documentType: "DEPOSIT_REQUEST",
    jobId: JOB_ID,
    paymentRequirementId: REQUIREMENT_ID,
    content: {
      customerName: "Customer Example",
      customerEmail: "customer@example.test",
      projectTitle: "Cabinet repair",
      quoteReference: "Q-0000001",
      notes: "Thank you for approving the work.",
      paymentInstructions: "Pay by check.",
      customerMessage: "Please review this deposit request.",
    },
    workspace: {
      activeDocument: "DEPOSIT_REQUEST",
      instructions: [],
      manualOverrides: {},
      privateReminders: [],
    },
    photos: [],
    customerParty: null,
    ...overrides,
  };
}

test("Deposit Request creation requires exact active server payment authority and uses WDR identity", async () => {
  let captured = null;
  const result = await createBusinessDocumentDraft({
    pool: {},
    authenticatedActor: { id: 15 },
    payload: payload(),
    idempotencyKey: KEY,
    store: {
      async resolveBusinessOwner() { return { kind: "resolved", contractorProfileId: 9 }; },
      async loadDepositRequestAuthority() { return authority(); },
      async create({ draft }) {
        captured = draft;
        return {
          kind: "created",
          document: {
            id: draft.id,
            documentType: draft.documentType,
            status: "WORKING_DRAFT",
            reference: draft.reference,
            documentNumber: null,
            jobId: draft.jobId,
            paymentRequirementId: draft.paymentRequirementId,
            depositRequestAuthority: authority(),
            version: 1,
            content: draft.content,
            workspace: draft.workspace,
            photos: [],
          },
        };
      },
    },
  });
  assert.equal(result.status, 201);
  assert.match(captured.reference, /^WDR-[A-F0-9]{8}$/);
  assert.equal(captured.paymentRequirementId, REQUIREMENT_ID);
  assert.equal(result.document.documentNumber, null);
});

test("client-controlled financial fields and satisfied requirements fail closed", async () => {
  const invalid = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 15 }, idempotencyKey: KEY,
    payload: payload({ content: { ...payload().content, totalOverride: "1.00" } }),
    store: {},
  });
  assert.equal(invalid.status, 400);

  const satisfied = await createBusinessDocumentDraft({
    pool: {}, authenticatedActor: { id: 15 }, idempotencyKey: KEY,
    payload: payload(),
    store: {
      async resolveBusinessOwner() { return { kind: "resolved", contractorProfileId: 9 }; },
      async loadDepositRequestAuthority() { return authority({ state: "SATISFIED", appliedMinor: 51000, remainingMinor: 0 }); },
    },
  });
  assert.equal(satisfied.code, "DEPOSIT_REQUEST_REQUIREMENT_UNAVAILABLE");
});

test("customer package derives $680/$510/$170 only from server authority and creates no payment", () => {
  const document = {
    id: "55555555-5555-4555-8555-555555555555",
    documentType: "DEPOSIT_REQUEST",
    reference: "WDR-ABCDEF12",
    documentNumber: null,
    jobId: JOB_ID,
    paymentRequirementId: REQUIREMENT_ID,
    depositRequestAuthority: authority(),
    version: 1,
    content: payload().content,
    photos: [],
  };
  const customerPackage = buildBusinessDocumentCustomerPackage(document, { business_name: "Example Pro" });
  assert.equal(customerPackage.depositRequest.projectTotalMinor, 68000);
  assert.equal(customerPackage.depositRequest.requestedMinor, 51000);
  assert.equal(customerPackage.depositRequest.remainingAfterDepositMinor, 17000);
  assert.equal(customerPackage.depositRequest.paymentsReceivedMinor, 0);
  assert.equal(customerPackage.depositRequest.amountStillNeededMinor, 51000);
  assert.equal(customerPackage.document.type, "DEPOSIT_REQUEST");
  assert.equal(customerPackage.document.reference, "WDR-ABCDEF12");
  assert.doesNotMatch(JSON.stringify(customerPackage), /invoiceId|paymentReceipt|allocationId/i);
  assert.match(customerPackageLines(customerPackage).join("\n"), /Project total: \$680\.00[\s\S]*Deposit requested: \$510\.00[\s\S]*Amount remaining after deposit: \$170\.00/);
});
