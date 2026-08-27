"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");
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
    documentNumber: type === "QUOTE" ? "Q-0001020" : "INV-0000457",
    version: 10,
    content: {
      customerName: "Jack Smith",
      customerEmail: "jack@example.test",
      projectTitle: "Ceiling Fan Replacement",
      projectDescription: "Existing fan shows visible wear at the motor housing.",
      recommendedSolution: "Replace existing ceiling fan and install replacement fan.",
      workPerformed: "Replaced existing ceiling fan and installed replacement fan.",
      quoteDate: "2026-08-21",
      invoiceDate: "2026-08-21",
      dueDate: "2026-09-04",
      materialItems: [{ name: "Fan", total: "89.99" }],
      laborItems: [{ description: "Labor", total: "0" }, { description: "Installation", total: "200.00" }],
      paymentTerms: "",
      estimatedDuration: "",
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
  assert.equal(artifact.filename, "quote-Q-0001020-v10.pdf");
  assert.equal(artifact.photoCount, 3);
  for (const value of ["Handyman LLC", "Q-0001020", "Jack Smith", "Ceiling Fan Replacement", "Observation", "Existing fan shows visible wear", "Scope of Work", "Project Photos / Evidence", "Before Photos", "After Photos", "Payment Terms", "Confirm terms before delivery", "Estimated Duration", "Not confirmed", "Additional Work / Change Orders", "Ready for Customer Review"]) {
    assert.match(pdfText, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(pdfText, /Labor|\$0\.00|res\.cloudinary\.com|private margin|private conversation|private\.png/);
  assert.deepEqual(customerPackage.lineItems.map((item) => [item.description, item.lineTotalMinor]), [["Fan", 8999], ["Installation", 20000]]);
  assert.equal(customerPackage.totalMinor, 28999);
  assert.equal(artifact.pageCount >= 1, true);
});

test("professional saved Invoice PDF preserves due and not-paid truth", async () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(fixture("INVOICE"), { business_name: "Handyman LLC" });
  const artifact = await renderBusinessDocumentCustomerPdf(customerPackage, { fetchImpl: async () => imageResponse() });
  const pdfText = artifact.buffer.toString("latin1");
  assert.equal(artifact.filename, "invoice-INV-0000457-v10.pdf");
  assert.match(pdfText, /INVOICE/);
  assert.match(pdfText, /Work Performed/);
  assert.match(pdfText, /TOTAL DUE/);
  for (const value of ["Payment Terms", "Due Date", "Amount Paid", "Balance Due", "Not confirmed"] ) {
    assert.match(pdfText, new RegExp(value));
  }
  assert.match(pdfText, /Ready for Customer Review/);
});

async function orientedJpeg(orientation) {
  return sharp({
    create: { width: 40, height: 20, channels: 3, background: { r: 220, g: 40, b: 30 } },
  }).withMetadata({ orientation }).jpeg({ quality: 92 }).toBuffer();
}

test("JPEG EXIF orientations 1, 3, 6, and 8 are normalized upright with metadata removed", async () => {
  for (const orientation of [1, 3, 6, 8]) {
    const normalized = await businessDocumentPdfRendererInternals.normalizeCustomerImage(
      await orientedJpeg(orientation)
    );
    assert.equal(normalized.sourceOrientation, orientation);
    assert.equal(normalized.format, "JPEG");
    assert.equal(normalized.bytes.byteLength <= businessDocumentPdfRendererInternals.MAX_IMAGE_BYTES, true);
    assert.deepEqual(
      [normalized.width, normalized.height],
      [6, 8].includes(orientation) ? [20, 40] : [40, 20]
    );
    const metadata = await sharp(normalized.bytes).metadata();
    assert.equal(metadata.orientation, undefined);
  }
});

test("mirrored EXIF orientation is normalized rather than only rotating placement", async () => {
  const source = await sharp({
    create: { width: 8, height: 4, channels: 3, background: { r: 230, g: 20, b: 20 } },
  }).composite([{
    input: { create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 20, b: 230 } } },
    left: 0,
    top: 0,
  }]).withMetadata({ orientation: 2 }).png().toBuffer();
  const normalized = await businessDocumentPdfRendererInternals.normalizeCustomerImage(source);
  const raw = await sharp(normalized.bytes).raw().toBuffer({ resolveWithObject: true });
  const left = raw.data.subarray(0, raw.info.channels);
  assert.equal(left[0] > left[2], true);
});

test("General Evidence, Before, and After photos all use the normalized orientation while private photos remain excluded", async () => {
  const source = fixture();
  const customerPackage = buildBusinessDocumentCustomerPackage(source, { business_name: "Handyman LLC" });
  const jpeg = await orientedJpeg(6);
  const prepared = await businessDocumentPdfRendererInternals.prepareCustomerPhotos(customerPackage, {
    fetchImpl: async () => imageResponse(jpeg, "image/jpeg"),
  });
  assert.deepEqual(prepared.map((photo) => photo.role), ["GENERAL_EVIDENCE", "BEFORE", "AFTER"]);
  assert.equal(prepared.every((photo) => photo.width === 20 && photo.height === 40), true);
  assert.equal(prepared.some((photo) => photo.mediaId === "private"), false);
});

test("Observation renders once, coexists with Recommended Solution, and excludes private workspace notes", async () => {
  const customerPackage = buildBusinessDocumentCustomerPackage(fixture(), { business_name: "Handyman LLC" });
  const artifact = await renderBusinessDocumentCustomerPdf(customerPackage, { fetchImpl: async () => imageResponse() });
  const pdfText = artifact.buffer.toString("latin1");
  assert.equal((pdfText.match(/Existing fan shows visible wear/g) || []).length, 1);
  assert.match(pdfText, /Replace existing ceiling fan and install replacement fan/);
  assert.doesNotMatch(pdfText, /private margin|private conversation/);

  const empty = fixture();
  empty.content.projectDescription = "";
  const emptyPackage = buildBusinessDocumentCustomerPackage(empty, { business_name: "Handyman LLC" });
  const emptyArtifact = await renderBusinessDocumentCustomerPdf(emptyPackage, { fetchImpl: async () => imageResponse() });
  assert.doesNotMatch(emptyArtifact.buffer.toString("latin1"), /Observation/);
});

test("populated Quote footer values replace truthful defaults", async () => {
  const source = fixture();
  source.content.paymentTerms = "50% deposit required before scheduling.";
  source.content.estimatedDuration = "1 day";
  const customerPackage = buildBusinessDocumentCustomerPackage(source, { business_name: "Handyman LLC" });
  const artifact = await renderBusinessDocumentCustomerPdf(customerPackage, { fetchImpl: async () => imageResponse() });
  const pdfText = artifact.buffer.toString("latin1");
  assert.match(pdfText, /50% deposit required before\) Tj[\s\S]*\(scheduling\./);
  assert.match(pdfText, /1 day/);
  assert.doesNotMatch(pdfText, /Confirm terms before delivery/);
});

test("pricing totals and footer summary remain together without clipping while long content paginates", async () => {
  const compact = fixture();
  compact.content.agreement = {};
  const compactPackage = buildBusinessDocumentCustomerPackage(compact, { business_name: "Handyman LLC" });
  const prepared = await businessDocumentPdfRendererInternals.prepareCustomerPhotos(compactPackage, { fetchImpl: async () => imageResponse() });
  const rendered = businessDocumentPdfRendererInternals.renderPreparedCustomerPdf(compactPackage, prepared);
  const pricing = rendered.layout.find((block) => block.name === "Pricing totals");
  const summary = rendered.layout.find((block) => block.name === "Customer footer summary");
  assert.ok(pricing);
  assert.ok(summary);
  assert.equal(rendered.pageCount <= 2, true);
  assert.equal(pricing.page, summary.page);
  assert.equal(pricing.end <= summary.start, true);
  assert.equal(summary.end <= 722, true);

  const long = fixture();
  long.photos = [];
  long.content.agreement = {};
  long.content.materialItems = Array.from({ length: 42 }, (_, index) => ({
    name: `Detailed customer-facing replacement item ${index + 1} with wrapped installation description`,
    total: "10.00",
  }));
  long.content.terms = "Customer-safe payment detail. ".repeat(240);
  const longPackage = buildBusinessDocumentCustomerPackage(long, { business_name: "Handyman LLC" });
  const longArtifact = await renderBusinessDocumentCustomerPdf(longPackage);
  assert.equal(longArtifact.pageCount > 1, true);
  assert.match(longArtifact.buffer.toString("latin1"), /Ready for Customer Review/);
});

test("zero, one, three, and many customer photos paginate deterministically without clipping pricing or the footer", async () => {
  for (const count of [0, 1, 3, 9]) {
    const source = fixture();
    source.content.agreement = {};
    source.photos = Array.from({ length: count }, (_, index) => ({
      id: `photo-${index}`,
      role: ["GENERAL_EVIDENCE", "BEFORE", "AFTER"][index % 3],
      visibility: "CUSTOMER_VISIBLE",
      media: { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/photo-${index}.png` },
    }));
    const customerPackage = buildBusinessDocumentCustomerPackage(source, { business_name: "Handyman LLC" });
    const artifact = await renderBusinessDocumentCustomerPdf(customerPackage, { fetchImpl: async () => imageResponse() });
    assert.equal(artifact.photoCount, count);
    assert.equal(artifact.pageCount >= 1, true);
    assert.match(artifact.buffer.toString("latin1"), /PROJECT PRICE/);
    assert.match(artifact.buffer.toString("latin1"), /Ready for Customer Review/);
  }

  const excessive = fixture();
  excessive.photos = Array.from({ length: 13 }, (_, index) => ({
    id: `excess-${index}`,
    role: "GENERAL_EVIDENCE",
    visibility: "CUSTOMER_VISIBLE",
    media: { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/excess-${index}.png` },
  }));
  const excessivePackage = buildBusinessDocumentCustomerPackage(excessive, { business_name: "Handyman LLC" });
  await assert.rejects(
    renderBusinessDocumentCustomerPdf(excessivePackage, { fetchImpl: async () => imageResponse() }),
    (error) => error.reason === "image_count_exceeded"
  );
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
