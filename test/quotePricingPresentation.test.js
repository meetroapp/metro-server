"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  businessDocumentDraftInternals,
} = require("../server/documents/businessDocumentDraftService");
const {
  buildBusinessDocumentCustomerPackage,
  customerPackageLines,
} = require("../server/documents/businessDocumentCustomerPackage");
const {
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");
const {
  renderBusinessDocumentCustomerPdf,
} = require("../server/documents/businessDocumentPdfRenderer");

function content(overrides = {}) {
  return {
    customerName: "Customer",
    projectTitle: "Cabinet repair",
    projectDescription: "Repair damaged cabinet and trim.",
    recommendedSolution: "Replace damaged material and repair trim.",
    lineItems: [],
    laborItems: [{ description: "Labor", total: "500" }],
    materialItems: [{ name: "Materials", total: "180" }],
    totalOverride: "",
    currency: "USD",
    terms: "",
    paymentTerms: "",
    estimatedDuration: "",
    notes: "",
    agreement: { exclusions: [] },
    ...overrides,
  };
}

function document(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    documentType: "QUOTE",
    reference: "Q-TEST",
    documentNumber: "Q-0000001",
    version: 1,
    content: content(overrides),
    workspace: { instructions: [], privateReminders: [] },
    photos: [],
  };
}

test("working-document JSON accepts bounded pricing/deposit settings and rejects invalid values", () => {
  const normalized = businessDocumentDraftInternals.normalizeContent(content({
    pricingDisplayMode: "TOTAL_ONLY",
    materialsDisplayMode: "INCLUDED_IN_TOTAL",
    depositMode: "PERCENT",
    depositPercent: "75",
    depositFixedAmount: "",
  }));
  assert.equal(normalized.pricingDisplayMode, "TOTAL_ONLY");
  assert.equal(normalized.materialsDisplayMode, "INCLUDED_IN_TOTAL");
  assert.equal(normalized.depositMode, "PERCENT");
  assert.equal(normalized.depositPercent, "75");
  assert.equal(businessDocumentDraftInternals.normalizeContent(content({ pricingDisplayMode: "PRIVATE_INTERNAL" })), null);
  assert.equal(businessDocumentDraftInternals.normalizeContent(content({ depositMode: "PERCENT", depositPercent: "101" })), null);
  assert.equal(businessDocumentDraftInternals.normalizeContent(content({ depositMode: "FIXED", depositFixedAmount: "-1" })), null);
});

test("saved total-only customer package hides internal rows and exposes 75% deposit truth", () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(document({
    totalOverride: "950",
    pricingDisplayMode: "TOTAL_ONLY",
    materialsDisplayMode: "INCLUDED_IN_TOTAL",
    depositMode: "PERCENT",
    depositPercent: "75",
    depositFixedAmount: "",
  }), { business_name: "Business" });
  assert.deepEqual(customerPackage.lineItems, []);
  assert.equal(customerPackage.totalMinor, 95000);
  assert.equal(customerPackage.pricingPresentation.note, "Labor and standard materials included");
  assert.deepEqual(customerPackage.deposit, {
    mode: "PERCENT",
    percent: 75,
    dueMinor: 71250,
    remainingMinor: 23750,
  });
  const text = customerPackageLines(customerPackage).join("\n");
  assert.doesNotMatch(text, /^Labor:|^Materials:/m);
  assert.match(text, /Labor and standard materials included/);
  assert.match(text, /75% deposit due on approval: \$712\.50/);
  assert.match(text, /Remaining balance: \$237\.50/);
});

test("saved total-only PDF agrees with customer package without leaking internal breakdown", async () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(document({
    totalOverride: "950",
    pricingDisplayMode: "TOTAL_ONLY",
    materialsDisplayMode: "INCLUDED_IN_TOTAL",
    depositMode: "PERCENT",
    depositPercent: "75",
  }), { business_name: "Business" });
  const artifact = await renderBusinessDocumentCustomerPdf(customerPackage);
  const pdfText = artifact.buffer.toString("latin1");
  assert.match(pdfText, /PROJECT PRICE/);
  assert.match(pdfText, /Labor and standard materials included/);
  assert.match(pdfText, /75% deposit due on approval/);
  assert.match(pdfText, /\$712\.50/);
  assert.match(pdfText, /\$237\.50/);
  assert.match(pdfText, /\/F1 10\.5 Tf/);
  assert.match(pdfText, /\/F2 12\.5 Tf/);
  assert.match(pdfText, /\/F2 22 Tf/);
  assert.doesNotMatch(pdfText, /Labor:|Materials:|\$500\.00|\$180\.00/);
});

test("customer-provided materials remain internal and are excluded from customer total", () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(document({
    pricingDisplayMode: "CATEGORY_BREAKDOWN",
    materialsDisplayMode: "CUSTOMER_PROVIDES",
    depositMode: "NONE",
  }), { business_name: "Business" });
  assert.equal(customerPackage.totalMinor, 50000);
  assert.deepEqual(customerPackage.lineItems.map((row) => row.description), ["Labor"]);
  assert.equal(customerPackage.pricingPresentation.note, "Customer to provide materials");
  assert.doesNotMatch(JSON.stringify(customerPackage.lineItems), /Materials|18000/);
});

test("canonical bridge respects total-only, category, and customer-provided presentation", () => {
  const totalOnly = quoteDraftServiceInternals.workingQuoteConversion(content({
    pricingDisplayMode: "TOTAL_ONLY",
    materialsDisplayMode: "INCLUDED_IN_TOTAL",
  }));
  assert.equal(totalOnly.error, undefined);
  assert.equal(totalOnly.items.length, 1);
  assert.equal(totalOnly.items[0].description, "Cabinet repair");
  assert.equal(totalOnly.totals.totalMinor, 68000);
  assert.match(totalOnly.customerTermsSnapshot.customerNotes, /Labor and standard materials included/);

  const category = quoteDraftServiceInternals.workingQuoteConversion(content({
    pricingDisplayMode: "CATEGORY_BREAKDOWN",
    materialsDisplayMode: "SHOW_SEPARATELY",
  }));
  assert.deepEqual(category.items.map((item) => item.description), ["Labor and services", "Materials"]);
  assert.equal(category.totals.totalMinor, 68000);

  const customerProvides = quoteDraftServiceInternals.workingQuoteConversion(content({
    pricingDisplayMode: "DETAILED_LINE_ITEMS",
    materialsDisplayMode: "CUSTOMER_PROVIDES",
  }));
  assert.equal(customerProvides.totals.totalMinor, 50000);
  assert.deepEqual(customerProvides.items.map((item) => item.description), ["Labor"]);
  assert.match(customerProvides.customerTermsSnapshot.customerNotes, /Customer to provide materials/);
});
