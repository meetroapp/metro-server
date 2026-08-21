"use strict";

const { jsPDF } = require("jspdf");

const PAGE = Object.freeze({ width: 612, height: 792, margin: 48, footerY: 766 });
const COLOR = Object.freeze({
  ink: [24, 49, 70], text: [42, 45, 48], muted: [91, 105, 116],
  line: [196, 209, 218], fill: [242, 246, 248], accent: [31, 81, 50],
});
const MAX_CUSTOMER_PHOTOS = 12;
const MAX_IMAGE_BYTES = 12_000_000;
const MAX_TOTAL_IMAGE_BYTES = 30_000_000;
const IMAGE_TIMEOUT_MS = 8_000;
const IMAGE_CONCURRENCY = 3;
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

class BusinessDocumentPdfRenderError extends Error {
  constructor(message, reason = "render_failed") {
    super(message);
    this.name = "BusinessDocumentPdfRenderError";
    this.code = "BUSINESS_DOCUMENT_PDF_RENDER_FAILED";
    this.reason = reason;
  }
}

function trustedMediaUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" &&
      url.hostname === "res.cloudinary.com" &&
      /^\/[a-z0-9_-]+\/image\/upload\//i.test(url.pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function imageKind(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "PNG";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "WEBP";
  return null;
}

async function boundedBody(response, maximum) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maximum) throw new BusinessDocumentPdfRenderError("A customer-visible photo is too large.", "image_too_large");
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw new BusinessDocumentPdfRenderError("A customer-visible photo is too large.", "image_too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new BusinessDocumentPdfRenderError("A customer-visible photo is too large.", "image_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchCustomerImage(photo, {
  fetchImpl = globalThis.fetch,
  timeoutMs = IMAGE_TIMEOUT_MS,
  maximumBytes = MAX_IMAGE_BYTES,
} = {}) {
  const imageUrl = trustedMediaUrl(photo?.imageUrl);
  if (!imageUrl || typeof fetchImpl !== "function") {
    throw new BusinessDocumentPdfRenderError("A customer-visible photo is unavailable.", "unsafe_image_url");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(imageUrl, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "image/png,image/jpeg,image/webp" },
    });
    if (!response?.ok) throw new BusinessDocumentPdfRenderError("A customer-visible photo could not be retrieved.", "image_fetch_failed");
    const mime = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!IMAGE_MIME.has(mime)) throw new BusinessDocumentPdfRenderError("A customer-visible photo has an unsupported type.", "image_type_invalid");
    const bytes = await boundedBody(response, maximumBytes);
    const format = imageKind(bytes);
    if (!format || (mime === "image/png" && format !== "PNG") || (mime === "image/jpeg" && format !== "JPEG") || (mime === "image/webp" && format !== "WEBP")) {
      throw new BusinessDocumentPdfRenderError("A customer-visible photo could not be decoded safely.", "image_decode_invalid");
    }
    return Object.freeze({
      ...photo,
      bytes,
      format,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
    });
  } catch (error) {
    if (error instanceof BusinessDocumentPdfRenderError) throw error;
    const reason = error?.name === "AbortError" ? "image_timeout" : "image_fetch_failed";
    throw new BusinessDocumentPdfRenderError("A customer-visible photo could not be retrieved.", reason);
  } finally {
    clearTimeout(timeout);
  }
}

async function mapBounded(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

async function prepareCustomerPhotos(customerPackage, options = {}) {
  const photos = customerPackage.photos || [];
  if (photos.length > MAX_CUSTOMER_PHOTOS) throw new BusinessDocumentPdfRenderError("Too many customer-visible photos were selected.", "image_count_exceeded");
  const prepared = await mapBounded(photos, options.concurrency || IMAGE_CONCURRENCY, (photo) => fetchCustomerImage(photo, options));
  const totalBytes = prepared.reduce((sum, photo) => sum + photo.bytes.byteLength, 0);
  if (totalBytes > (options.maximumTotalBytes || MAX_TOTAL_IMAGE_BYTES)) {
    throw new BusinessDocumentPdfRenderError("Customer-visible photos exceed the PDF preparation limit.", "image_total_exceeded");
  }
  return prepared;
}

function money(minor, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(minor || 0) / 100);
}

function addText(doc, value, x, y, { size = 10, color = COLOR.text, style = "normal", maxWidth, align = "left" } = {}) {
  doc.setFont("helvetica", style);
  doc.setFontSize(size);
  doc.setTextColor(...color);
  const lines = maxWidth ? doc.splitTextToSize(String(value || ""), maxWidth) : [String(value || "")];
  doc.text(lines, x, y, { align });
  return y + lines.length * size * 1.25;
}

function safeFilename(customerPackage) {
  const kind = customerPackage.document.type === "QUOTE" ? "quote" : "invoice";
  const reference = String(customerPackage.document.reference || "document")
    .replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
  return `${kind}-${reference}-v${customerPackage.document.version}.pdf`;
}

function renderPreparedCustomerPdf(customerPackage, photos, logo = null) {
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: false });
  const contentWidth = PAGE.width - PAGE.margin * 2;
  let y = PAGE.margin;
  const footerReserve = 44;

  function page() {
    doc.addPage();
    y = PAGE.margin;
  }
  function ensureSpace(height) {
    if (y + height > PAGE.footerY - footerReserve) page();
  }
  function section(title, body) {
    if (!body) return;
    const lines = doc.splitTextToSize(String(body), contentWidth);
    ensureSpace(28 + lines.length * 12);
    y = addText(doc, title, PAGE.margin, y, { size: 12, color: COLOR.ink, style: "bold" });
    y = addText(doc, body, PAGE.margin, y + 3, { size: 9.5, maxWidth: contentWidth });
    y += 8;
  }
  function bulletSection(title, values) {
    const present = (values || []).filter(Boolean);
    if (!present.length) return;
    ensureSpace(34);
    y = addText(doc, title, PAGE.margin, y, { size: 12, color: COLOR.ink, style: "bold" });
    for (const value of present) {
      const lines = doc.splitTextToSize(String(value), contentWidth - 16);
      ensureSpace(lines.length * 12 + 5);
      addText(doc, "-", PAGE.margin + 4, y + 3, { size: 9.5 });
      y = addText(doc, value, PAGE.margin + 16, y + 3, { size: 9.5, maxWidth: contentWidth - 16 });
    }
    y += 8;
  }
  function photoSection(title, role) {
    const group = photos.filter((photo) => photo.role === role);
    if (!group.length) return;
    ensureSpace(138);
    y = addText(doc, title, PAGE.margin, y, { size: 12, color: COLOR.ink, style: "bold" });
    y += 5;
    const gap = 10;
    const columns = 3;
    const width = (contentWidth - gap * (columns - 1)) / columns;
    const height = 96;
    for (let index = 0; index < group.length; index += columns) {
      ensureSpace(height + 12);
      group.slice(index, index + columns).forEach((photo, column) => {
        const properties = doc.getImageProperties(photo.dataUrl);
        const scale = Math.min(width / properties.width, height / properties.height);
        const renderedWidth = properties.width * scale;
        const renderedHeight = properties.height * scale;
        doc.addImage(photo.dataUrl, photo.format, PAGE.margin + column * (width + gap) + (width - renderedWidth) / 2, y + (height - renderedHeight) / 2, renderedWidth, renderedHeight, undefined, "FAST");
      });
      y += height + 10;
    }
    y += 4;
  }

  if (logo?.dataUrl) doc.addImage(logo.dataUrl, logo.format, PAGE.margin, y - 10, 34, 34, undefined, "FAST");
  addText(doc, customerPackage.business.displayName, PAGE.margin + (logo ? 44 : 0), y + 4, { size: 17, color: COLOR.ink, style: "bold", maxWidth: logo ? 286 : 330 });
  addText(doc, customerPackage.document.type, PAGE.width - PAGE.margin, y + 5, { size: 23, color: COLOR.ink, style: "bold", align: "right" });
  y += 30;
  const contact = [customerPackage.business.phone, customerPackage.business.email, customerPackage.business.website, customerPackage.business.location].filter(Boolean).join("  |  ");
  if (contact) y = addText(doc, contact, PAGE.margin, y, { size: 8.5, color: COLOR.muted, maxWidth: contentWidth });
  addText(doc, `SAVED DRAFT  |  VERSION ${customerPackage.document.version}`, PAGE.width - PAGE.margin, y, { size: 9, color: COLOR.accent, style: "bold", align: "right" });
  y += 8;
  doc.setDrawColor(...COLOR.ink);
  doc.setLineWidth(1.2);
  doc.line(PAGE.margin, y, PAGE.width - PAGE.margin, y);
  y += 10;

  const meta = [
    ["CUSTOMER", [customerPackage.customer.name, customerPackage.customer.address || customerPackage.customer.location, customerPackage.customer.phone, customerPackage.customer.email].filter(Boolean).join("\n") || "-"],
    ["PROJECT", customerPackage.project.title || "-"],
    [customerPackage.document.type, customerPackage.document.reference || "-"],
    [customerPackage.document.dueDate ? "DATE / DUE DATE" : "DATE", customerPackage.document.dueDate ? `${customerPackage.document.date || "-"} / ${customerPackage.document.dueDate}` : customerPackage.document.date || "-"],
  ];
  const metaWidth = contentWidth / meta.length;
  const metaLines = Math.max(...meta.map(([, value]) => doc.splitTextToSize(String(value), metaWidth - 16).length), 1);
  const metaHeight = 34 + Math.max(0, metaLines - 1) * 10;
  doc.setFillColor(...COLOR.fill);
  doc.setDrawColor(...COLOR.line);
  doc.rect(PAGE.margin, y, contentWidth, metaHeight, "FD");
  meta.forEach(([label, value], index) => {
    const x = PAGE.margin + metaWidth * index + 8;
    addText(doc, label, x, y + 11, { size: 6.8, color: COLOR.muted, style: "bold" });
    addText(doc, value, x, y + 25, { size: 8.3, style: "bold", maxWidth: metaWidth - 16 });
  });
  y += metaHeight + 14;

  section(customerPackage.document.type === "QUOTE" ? "Scope of Work" : "Work Performed", customerPackage.project.scope);
  photoSection("Project Photos / Evidence", "GENERAL_EVIDENCE");
  photoSection("Before Photos", "BEFORE");
  photoSection("After Photos", "AFTER");

  if (customerPackage.lineItems.length) {
    ensureSpace(68);
    const showUnits = customerPackage.lineItems.some((item) => item.pricingPresentation !== "flat");
    const x = { description: PAGE.margin, quantity: 376, unit: 430, amount: 512 };
    const descriptionWidth = showUnits ? 300 : 420;
    doc.setFillColor(...COLOR.fill);
    doc.rect(PAGE.margin, y + 3, contentWidth, 22, "F");
    addText(doc, "Description", x.description + 7, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
    if (showUnits) {
      addText(doc, "Qty", x.quantity, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
      addText(doc, "Unit", x.unit, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
    }
    addText(doc, "Amount", x.amount, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
    y += 31;
    for (const item of customerPackage.lineItems) {
      const descriptionLines = doc.splitTextToSize(item.description, descriptionWidth);
      const rowHeight = Math.max(22, descriptionLines.length * 12 + 8);
      ensureSpace(rowHeight + 4);
      addText(doc, item.description, x.description + 7, y + 10, { size: 8.8, maxWidth: descriptionWidth });
      if (item.pricingPresentation !== "flat") {
        addText(doc, String(item.quantity), x.quantity, y + 10, { size: 8.8 });
        addText(doc, item.unitAmountMinor == null ? "-" : money(item.unitAmountMinor, customerPackage.currency), x.unit, y + 10, { size: 8.3 });
      }
      addText(doc, money(item.lineTotalMinor, customerPackage.currency), x.amount, y + 10, { size: 8.3, style: "bold" });
      doc.setDrawColor(...COLOR.line);
      doc.line(PAGE.margin, y + rowHeight, PAGE.width - PAGE.margin, y + rowHeight);
      y += rowHeight + 3;
    }
    y += 5;
  }

  ensureSpace(86);
  doc.setDrawColor(...COLOR.ink);
  doc.setFillColor(...COLOR.fill);
  doc.rect(PAGE.margin, y, contentWidth, 48, "FD");
  addText(doc, customerPackage.document.type === "QUOTE" ? "PROJECT PRICE" : "TOTAL DUE", PAGE.margin + 28, y + 29, { size: 11, color: COLOR.ink, style: "bold" });
  addText(doc, money(customerPackage.document.type === "INVOICE" ? customerPackage.balanceMinor : customerPackage.totalMinor, customerPackage.currency), PAGE.width - PAGE.margin - 28, y + 31, { size: 22, color: COLOR.ink, style: "bold", align: "right" });
  y += 62;
  const financialRows = [
    ["Subtotal", customerPackage.subtotalMinor],
    customerPackage.discountMinor ? ["Discount", -customerPackage.discountMinor] : null,
    customerPackage.taxMinor ? ["Tax", customerPackage.taxMinor] : null,
    customerPackage.feesMinor ? ["Fees", customerPackage.feesMinor] : null,
    customerPackage.document.type === "INVOICE" && customerPackage.paidMinor != null ? ["Amount paid", customerPackage.paidMinor] : null,
  ].filter(Boolean);
  for (const [label, amount] of financialRows) {
    ensureSpace(18);
    addText(doc, label, PAGE.margin + 300, y, { size: 8.5, color: COLOR.muted });
    addText(doc, money(amount, customerPackage.currency), PAGE.width - PAGE.margin, y, { size: 8.5, style: "bold", align: "right" });
    y += 16;
  }
  y += 4;

  section("Payment Terms", customerPackage.paymentTerms);
  section("Estimated Duration", customerPackage.estimatedDuration);
  bulletSection("Project Conditions", customerPackage.conditions);
  const agreement = customerPackage.agreement || {};
  bulletSection("Not Included / Exclusions", [...new Set([...(customerPackage.exclusions || []), ...(agreement.exclusions || [])])]);
  section("Additional Work / Change Orders", agreement.additionalWorkTerms);
  section("Hidden / Unforeseen Conditions", agreement.hiddenConditionsTerms);
  section("Diagnostic / Troubleshooting Fees", agreement.diagnosticTerms);
  section("Customer Responsibilities", agreement.customerResponsibilities);
  section("Pre-authorized Additional Work Limit", agreement.preauthorizedAdditionalWorkLimit);
  section("Cancellation / Rescheduling", agreement.cancellationTerms);
  section("Warranty / Workmanship", agreement.warrantyTerms || customerPackage.warrantyNotes);
  section("Acceptance Terms", agreement.acceptanceTerms);
  section("Notes", customerPackage.notes);
  section("Customer Message", customerPackage.customerMessage);
  section("Acceptance / Status", customerPackage.document.type === "QUOTE" ? "Saved Draft - Not Issued" : "Saved Draft - Not Issued or Paid");

  const pages = doc.getNumberOfPages();
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    doc.setPage(pageNumber);
    doc.setDrawColor(...COLOR.line);
    doc.line(PAGE.margin, PAGE.footerY - 10, PAGE.width - PAGE.margin, PAGE.footerY - 10);
    addText(doc, customerPackage.business.displayName, PAGE.margin, PAGE.footerY, { size: 7, color: COLOR.muted });
    addText(doc, `Prepared with Meetro  |  ${pageNumber} / ${pages}`, PAGE.width - PAGE.margin, PAGE.footerY, { size: 7, color: COLOR.muted, align: "right" });
  }
  doc.setProperties({
    title: `${customerPackage.document.type} ${customerPackage.document.reference}`,
    subject: `Saved document version ${customerPackage.document.version} - Not issued`,
    author: customerPackage.business.displayName,
    creator: "Meetro",
  });
  return Buffer.from(doc.output("arraybuffer"));
}

async function renderBusinessDocumentCustomerPdf(customerPackage, options = {}) {
  if (!customerPackage?.document || !Array.isArray(customerPackage.lineItems) || !Array.isArray(customerPackage.photos)) {
    throw new BusinessDocumentPdfRenderError("The saved customer document is invalid.", "model_invalid");
  }
  try {
    const photos = await prepareCustomerPhotos(customerPackage, options);
    let logo = null;
    if (customerPackage.business?.logoUrl) {
      try {
        logo = await fetchCustomerImage({ imageUrl: customerPackage.business.logoUrl }, { ...options, maximumBytes: 2_000_000 });
      } catch { /* business name remains the safe branding fallback */ }
    }
    const buffer = renderPreparedCustomerPdf(customerPackage, photos, logo);
    return Object.freeze({
      buffer,
      base64: buffer.toString("base64"),
      filename: safeFilename(customerPackage),
      contentType: "application/pdf",
      documentId: customerPackage.document.id,
      documentVersion: customerPackage.document.version,
      photoCount: photos.length,
    });
  } catch (error) {
    if (error instanceof BusinessDocumentPdfRenderError) throw error;
    throw new BusinessDocumentPdfRenderError("The customer PDF could not be prepared.", "render_failed");
  }
}

module.exports = {
  BusinessDocumentPdfRenderError,
  renderBusinessDocumentCustomerPdf,
  businessDocumentPdfRendererInternals: {
    IMAGE_CONCURRENCY,
    IMAGE_TIMEOUT_MS,
    MAX_CUSTOMER_PHOTOS,
    MAX_IMAGE_BYTES,
    MAX_TOTAL_IMAGE_BYTES,
    fetchCustomerImage,
    imageKind,
    prepareCustomerPhotos,
    renderPreparedCustomerPdf,
    safeFilename,
    trustedMediaUrl,
  },
};
