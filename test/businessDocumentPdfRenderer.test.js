"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBusinessDocumentCustomerPackage,
} = require("../server/documents/businessDocumentCustomerPackage");
const {
  BusinessDocumentPdfRenderError,
  renderBusinessDocumentCustomerPdf,
  businessDocumentPdfRendererInternals,
} = require("../server/documents/businessDocumentPdfRenderer");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function imageResponse(bytes = PNG, type = "image/png", declared = bytes.length) {
  return {
    ok: true,
    headers: { get(name) { return name === "content-type" ? type : name === "content-length" ? String(declared) : null; } },
    body: null,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

function fixture(type = "QUOTE") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    documentType: type,
    reference: type === "QUOTE" ? "WQ-TEST-PARITY" : "WI-TEST-PARITY",
    version: 10,
    content: {
      customerName: "Jack Smith",
      customerEmail: "jack@example.test",
      projectTitle: "Ceiling Fan Replacement",
      recommendedSolution: "Replace existing ceiling fan and install replacement fan.",
      workPerformed: "Replaced existing ceiling fan and installed replacement fan.",
      quoteDate: "2026-08-21",
      invoiceDate: "2026-08-21",
      dueDate: "2026-09-04",
      materialItems: [{ name: "Fan", total: "89.99" }],
      laborItems: [{ description: "Labor", total: "0" }, { description: "Installation", total: "200.00" }],
      paymentTerms: "50% deposit required before scheduling.",
      estimatedDuration: "1 day",
      agreement: {
        exclusions: ["Painting"],
        additionalWorkTerms: "Additional work requires authorization.",
        hiddenConditionsTerms: "Hidden conditions are excluded.",
        warrantyTerms: "One-year workmanship warranty.",
        acceptanceTerms: "Acceptance applies to this saved version only.",
      },
    },
    workspace: { privateReminders: [{ text: "private margin" }], instructions: [{ text: "private conversation" }] },
    photos: [
      ["general", "GENERAL_EVIDENCE", "CUSTOMER_VISIBLE"],
      ["before", "BEFORE", "CUSTOMER_VISIBLE"],
      ["after", "AFTER", "CUSTOMER_VISIBLE"],
      ["private", "AFTER", "PRIVATE_INTERNAL"],
    ].map(([id, role, visibility]) => ({
      id, role, visibility,
      media: { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${id}.png` },
    })),
  };
}

test("professional saved Quote PDF renders the deterministic parity fixture with grouped photos and no private or zero-dollar artifacts", async () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(fixture(), { business_name: "Handyman LLC" });
  const artifact = await renderBusinessDocumentCustomerPdf(customerPackage, { fetchImpl: async () => imageResponse() });
  const pdfText = artifact.buffer.toString("latin1");
  assert.match(pdfText, /^%PDF-/);
  assert.equal(artifact.contentType, "application/pdf");
  assert.equal(artifact.filename, "quote-WQ-TEST-PARITY-v10.pdf");
  assert.equal(artifact.photoCount, 3);
  for (const value of ["Handyman LLC", "WQ-TEST-PARITY", "Jack Smith", "Ceiling Fan Replacement", "Scope of Work", "Project Photos / Evidence", "Before Photos", "After Photos", "Additional Work / Change Orders", "Saved Draft - Not Issued"]) {
    assert.match(pdfText, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(pdfText, /Labor|\$0\.00|res\.cloudinary\.com|private margin|private conversation|private\.png/);
  assert.deepEqual(customerPackage.lineItems.map((item) => [item.description, item.lineTotalMinor]), [["Fan", 8999], ["Installation", 20000]]);
  assert.equal(customerPackage.totalMinor, 28999);
});

test("professional saved Invoice PDF preserves due and not-paid truth", async () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(fixture("INVOICE"), { business_name: "Handyman LLC" });
  const artifact = await renderBusinessDocumentCustomerPdf(customerPackage, { fetchImpl: async () => imageResponse() });
  const pdfText = artifact.buffer.toString("latin1");
  assert.equal(artifact.filename, "invoice-WI-TEST-PARITY-v10.pdf");
  assert.match(pdfText, /INVOICE/);
  assert.match(pdfText, /Work Performed/);
  assert.match(pdfText, /TOTAL DUE/);
  assert.match(pdfText, /Not Issued or Paid/);
});

test("customer photo retrieval rejects unsafe URLs, oversized bodies, invalid MIME, and timeout", async () => {
  const photo = { imageUrl: "http://127.0.0.1/private.png" };
  await assert.rejects(
    businessDocumentPdfRendererInternals.fetchCustomerImage(photo, { fetchImpl: async () => imageResponse() }),
    (error) => error instanceof BusinessDocumentPdfRenderError && error.reason === "unsafe_image_url"
  );
  const safe = { imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/photo.png" };
  await assert.rejects(
    businessDocumentPdfRendererInternals.fetchCustomerImage(safe, { fetchImpl: async () => imageResponse(PNG, "image/png", 20_000_000) }),
    (error) => error.reason === "image_too_large"
  );
  await assert.rejects(
    businessDocumentPdfRendererInternals.fetchCustomerImage(safe, { fetchImpl: async () => imageResponse(Buffer.from("plain"), "text/plain") }),
    (error) => error.reason === "image_type_invalid"
  );
  await assert.rejects(
    businessDocumentPdfRendererInternals.fetchCustomerImage(safe, {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    }),
    (error) => error.reason === "image_timeout"
  );
});

test("trusted media allowlist excludes arbitrary hosts and non-image Cloudinary paths", () => {
  assert.equal(businessDocumentPdfRendererInternals.trustedMediaUrl("https://example.com/photo.png"), null);
  assert.equal(businessDocumentPdfRendererInternals.trustedMediaUrl("https://res.cloudinary.com/demo/raw/upload/v1/file"), null);
  assert.match(businessDocumentPdfRendererInternals.trustedMediaUrl("https://res.cloudinary.com/demo/image/upload/v1/photo.png"), /^https:/);
});
