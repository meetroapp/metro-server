"use strict";

const { jsPDF } = require("jspdf");
const sharp = require("sharp");

const PAGE = Object.freeze({ width: 612, height: 792, margin: 48, footerY: 766 });
const COLOR = Object.freeze({
  ink: [24, 49, 70], text: [42, 45, 48], muted: [91, 105, 116],
  line: [196, 209, 218], fill: [242, 246, 248], accent: [31, 81, 50],
});
const MAX_CUSTOMER_PHOTOS = 12;
const MAX_IMAGE_BYTES = 12_000_000;
const MAX_TOTAL_IMAGE_BYTES = 30_000_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_NORMALIZED_DIMENSION = 2400;
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

async function normalizeCustomerImage(bytes, {
  maximumBytes = MAX_IMAGE_BYTES,
  maximumPixels = MAX_IMAGE_PIXELS,
  maximumDimension = MAX_NORMALIZED_DIMENSION,
} = {}) {
  try {
    const source = Buffer.from(bytes);
    const metadata = await sharp(source, {
      failOn: "error",
      limitInputPixels: maximumPixels,
      sequentialRead: true,
    }).metadata();
    const normalized = await sharp(source, {
      failOn: "error",
      limitInputPixels: maximumPixels,
      sequentialRead: true,
    })
      .autoOrient()
      .resize({
        width: maximumDimension,
        height: maximumDimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 86, progressive: false, chromaSubsampling: "4:4:4" })
      .toBuffer({ resolveWithObject: true });
    if (normalized.data.byteLength > maximumBytes) {
      throw new BusinessDocumentPdfRenderError("A normalized customer-visible photo is too large.", "image_too_large");
    }
    return Object.freeze({
      bytes: new Uint8Array(normalized.data),
      format: "JPEG",
      mime: "image/jpeg",
      width: normalized.info.width,
      height: normalized.info.height,
      sourceOrientation: Number(metadata.orientation || 1),
      sourceByteLength: source.byteLength,
    });
  } catch (error) {
    if (error instanceof BusinessDocumentPdfRenderError) throw error;
    throw new BusinessDocumentPdfRenderError("A customer-visible photo could not be decoded safely.", "image_decode_invalid");
  }
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
    const normalized = await normalizeCustomerImage(bytes, { maximumBytes });
    return Object.freeze({
      ...photo,
      ...normalized,
      dataUrl: `data:${normalized.mime};base64,${Buffer.from(normalized.bytes).toString("base64")}`,
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
  const maximumTotalBytes = options.maximumTotalBytes || MAX_TOTAL_IMAGE_BYTES;
  const totalSourceBytes = prepared.reduce((sum, photo) => sum + photo.sourceByteLength, 0);
  const totalNormalizedBytes = prepared.reduce((sum, photo) => sum + photo.bytes.byteLength, 0);
  if (totalSourceBytes > maximumTotalBytes || totalNormalizedBytes > maximumTotalBytes) {
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

function renderPreparedCustomerPdf(customerPackage, photos, logo = null, options = {}) {
  const Pdf = options.jsPDFImpl || jsPDF;
  const doc = new Pdf({ unit: "pt", format: "letter", compress: false });
  const contentWidth = PAGE.width - PAGE.margin * 2;
  const footerReserve = 44;
  const contentBottom = PAGE.footerY - footerReserve;
  const usablePageHeight = contentBottom - 60;
  const layout = [];
  let y = PAGE.margin;

  function pageNumber() {
    return doc.getCurrentPageInfo().pageNumber;
  }
  function record(name, page, start, end) {
    layout.push(Object.freeze({ name, page, start, end }));
  }
  function page() {
    doc.addPage();
    y = 34;
    addText(doc, customerPackage.business.displayName, PAGE.margin, y, { size: 9, color: COLOR.muted, style: "bold" });
    addText(doc, customerPackage.document.type, PAGE.width - PAGE.margin, y, { size: 9, color: COLOR.muted, style: "bold", align: "right" });
    doc.setDrawColor(...COLOR.line);
    doc.line(PAGE.margin, 42, PAGE.width - PAGE.margin, 42);
    y = 60;
  }
  function ensureSpace(height) {
    if (y + height <= contentBottom) return false;
    page();
    return true;
  }
  function section(title, body) {
    if (!body) return;
    const lines = doc.splitTextToSize(String(body), contentWidth);
    ensureSpace(28 + Math.min(lines.length, 2) * 12);
    const startPage = pageNumber();
    const startY = y;
    y = addText(doc, title, PAGE.margin, y, { size: 12, color: COLOR.ink, style: "bold" });
    y += 3;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...COLOR.text);
    for (const line of lines) {
      ensureSpace(13);
      doc.text(String(line), PAGE.margin, y);
      y += 12;
    }
    y += 8;
    record(title, startPage, startY, y);
  }
  function bulletSection(title, values) {
    const present = (values || []).filter(Boolean);
    if (!present.length) return;
    ensureSpace(46);
    y = addText(doc, title, PAGE.margin, y, { size: 12, color: COLOR.ink, style: "bold" });
    for (const value of present) {
      const lines = doc.splitTextToSize(String(value), contentWidth - 16);
      ensureSpace(Math.min(lines.length, 2) * 12 + 5);
      addText(doc, "-", PAGE.margin + 4, y + 3, { size: 9.5 });
      for (const line of lines) {
        ensureSpace(13);
        addText(doc, line, PAGE.margin + 16, y + 3, { size: 9.5 });
        y += 12;
      }
    }
    y += 8;
  }
  function photoSection(title, role) {
    const group = photos.filter((photo) => photo.role === role);
    if (!group.length) return;
    ensureSpace(88);
    const startPage = pageNumber();
    const startY = y;
    y = addText(doc, title, PAGE.margin, y, { size: 12, color: COLOR.ink, style: "bold" });
    y += 5;
    const gap = 10;
    const columns = 3;
    const width = (contentWidth - gap * (columns - 1)) / columns;
    const height = 52;
    for (let index = 0; index < group.length; index += columns) {
      ensureSpace(height + 12);
      group.slice(index, index + columns).forEach((photo, column) => {
        const scale = Math.min(width / photo.width, height / photo.height);
        const renderedWidth = photo.width * scale;
        const renderedHeight = photo.height * scale;
        doc.addImage(photo.dataUrl, photo.format, PAGE.margin + column * (width + gap) + (width - renderedWidth) / 2, y + (height - renderedHeight) / 2, renderedWidth, renderedHeight, undefined, "FAST");
      });
      y += height + 10;
    }
    y += 4;
    record(title, startPage, startY, y);
  }
  function summaryRows(entries, columns = 3) {
    const width = contentWidth / columns;
    const rows = [];
    for (let index = 0; index < entries.length; index += columns) {
      const cells = entries.slice(index, index + columns);
      const height = Math.max(48, ...cells.map(([, value]) => 30 + doc.splitTextToSize(String(value), width - 16).length * 10));
      rows.push({ cells, height, width });
    }
    return rows;
  }
  function summaryGrid(entries, columns = 3) {
    if (!entries.length) return;
    const rows = summaryRows(entries, columns);
    const totalHeight = rows.reduce((sum, row) => sum + row.height, 0) + 8;
    if (totalHeight <= usablePageHeight) ensureSpace(totalHeight);
    const startPage = pageNumber();
    const startY = y;
    for (const row of rows) {
      ensureSpace(row.height);
      row.cells.forEach(([label, value], column) => {
        const x = PAGE.margin + column * row.width;
        doc.setDrawColor(...COLOR.line);
        doc.setFillColor(...COLOR.fill);
        doc.rect(x, y, row.width, row.height, "FD");
        addText(doc, label, x + 8, y + 14, { size: 7, color: COLOR.muted, style: "bold" });
        addText(doc, value, x + 8, y + 30, { size: 8.5, maxWidth: row.width - 16 });
      });
      y += row.height;
    }
    y += 8;
    record("Customer footer summary", startPage, startY, y);
  }

  if (logo?.dataUrl) doc.addImage(logo.dataUrl, logo.format, PAGE.margin, y - 10, 34, 34, undefined, "FAST");
  addText(doc, customerPackage.business.displayName, PAGE.margin + (logo ? 44 : 0), y + 4, { size: 17, color: COLOR.ink, style: "bold", maxWidth: logo ? 286 : 330 });
  addText(doc, customerPackage.document.type, PAGE.width - PAGE.margin, y + 5, { size: 23, color: COLOR.ink, style: "bold", align: "right" });
  y += 30;
  const contact = [customerPackage.business.phone, customerPackage.business.email, customerPackage.business.website, customerPackage.business.location].filter(Boolean).join("  |  ");
  if (contact) y = addText(doc, contact, PAGE.margin, y, { size: 8.5, color: COLOR.muted, maxWidth: contentWidth });
  addText(doc, `READY FOR CUSTOMER REVIEW  |  VERSION ${customerPackage.document.version}`, PAGE.width - PAGE.margin, y, { size: 9, color: COLOR.accent, style: "bold", align: "right" });
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

  section("Observation", customerPackage.project.observation);
  section(customerPackage.document.type === "QUOTE" ? "Scope of Work" : "Work Performed", customerPackage.project.scope);
  photoSection("Project Photos / Evidence", "GENERAL_EVIDENCE");
  photoSection("Before Photos", "BEFORE");
  photoSection("After Photos", "AFTER");

  const financialRows = [
    ["Subtotal", customerPackage.subtotalMinor],
    customerPackage.discountMinor ? ["Discount", -customerPackage.discountMinor] : null,
    customerPackage.taxMinor ? ["Tax", customerPackage.taxMinor] : null,
    customerPackage.feesMinor ? ["Fees", customerPackage.feesMinor] : null,
    customerPackage.document.type === "INVOICE" && customerPackage.paidMinor != null ? ["Amount paid", customerPackage.paidMinor] : null,
  ].filter(Boolean);
  const savedStatus = "Ready for Customer Review";
  const summaryEntries = customerPackage.document.type === "QUOTE"
    ? [
        ["Payment Terms", customerPackage.paymentTerms || "Confirm terms before delivery."],
        ["Estimated Duration", customerPackage.estimatedDuration || "Not confirmed."],
        ["Acceptance / Status", savedStatus],
      ]
    : [
        ["Payment Terms", customerPackage.paymentTerms || "Not confirmed."],
        ["Due Date", customerPackage.document.dueDate || "Not confirmed."],
        ["Status", savedStatus],
        ["Amount Paid", money(customerPackage.paidMinor || 0, customerPackage.currency)],
        ["Balance Due", money(customerPackage.balanceMinor, customerPackage.currency)],
      ];
  const summaryCellWidth = contentWidth / 3;
  const compactSummaryEntries = summaryEntries.filter(([, value]) =>
    doc.splitTextToSize(String(value), summaryCellWidth - 16).length <= 4
  );
  const longSummaryEntries = summaryEntries.filter(([, value]) =>
    doc.splitTextToSize(String(value), summaryCellWidth - 16).length > 4
  );
  const summaryColumns = Math.min(3, compactSummaryEntries.length || 1);
  const summaryHeight = compactSummaryEntries.length
    ? summaryRows(compactSummaryEntries, summaryColumns).reduce((sum, row) => sum + row.height, 0) + 8
    : 0;
  const pricingTailHeight = 62 + financialRows.length * 16 + 4 + summaryHeight;

  if (customerPackage.lineItems.length) {
    const showUnits = customerPackage.lineItems.some((item) => item.pricingPresentation !== "flat");
    const x = { description: PAGE.margin, quantity: 376, unit: 430, amount: 512 };
    const descriptionWidth = showUnits ? 300 : 420;
    const rowHeights = customerPackage.lineItems.map((item) => Math.max(22, doc.splitTextToSize(item.description, descriptionWidth).length * 12 + 8));
    const allPricingHeight = 31 + rowHeights.reduce((sum, height) => sum + height + 3, 0) + 5 + pricingTailHeight;
    if (allPricingHeight <= usablePageHeight) ensureSpace(allPricingHeight);
    function tableHeader() {
      doc.setFillColor(...COLOR.fill);
      doc.rect(PAGE.margin, y + 3, contentWidth, 22, "F");
      addText(doc, "Description", x.description + 7, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
      if (showUnits) {
        addText(doc, "Qty", x.quantity, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
        addText(doc, "Unit", x.unit, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
      }
      addText(doc, "Amount", x.amount, y + 17, { size: 7.5, color: COLOR.muted, style: "bold" });
      y += 31;
    }
    tableHeader();
    for (let index = 0; index < customerPackage.lineItems.length; index += 1) {
      const item = customerPackage.lineItems[index];
      const rowHeight = rowHeights[index];
      const lastRow = index === customerPackage.lineItems.length - 1;
      if (ensureSpace(rowHeight + 4 + (lastRow ? pricingTailHeight : 0))) tableHeader();
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

  ensureSpace(pricingTailHeight);
  const pricingPage = pageNumber();
  const pricingStart = y;
  doc.setDrawColor(...COLOR.ink);
  doc.setFillColor(...COLOR.fill);
  doc.rect(PAGE.margin, y, contentWidth, 48, "FD");
  addText(doc, customerPackage.document.type === "QUOTE" ? "PROJECT PRICE" : "TOTAL DUE", PAGE.margin + 28, y + 29, { size: 11, color: COLOR.ink, style: "bold" });
  addText(doc, money(customerPackage.document.type === "INVOICE" ? customerPackage.balanceMinor : customerPackage.totalMinor, customerPackage.currency), PAGE.width - PAGE.margin - 28, y + 31, { size: 22, color: COLOR.ink, style: "bold", align: "right" });
  y += 62;
  for (const [label, amount] of financialRows) {
    addText(doc, label, PAGE.margin + 300, y, { size: 8.5, color: COLOR.muted });
    addText(doc, money(amount, customerPackage.currency), PAGE.width - PAGE.margin, y, { size: 8.5, style: "bold", align: "right" });
    y += 16;
  }
  y += 4;
  record("Pricing totals", pricingPage, pricingStart, y);
  section("Pricing", customerPackage.pricingPresentation?.note);
  if (customerPackage.document.type === "QUOTE" && customerPackage.deposit) {
    const label = customerPackage.deposit.mode === "PERCENT"
      ? `${customerPackage.deposit.percent}% deposit due on approval`
      : "Deposit due on approval";
    section("Deposit", `${label} — ${money(customerPackage.deposit.dueMinor, customerPackage.currency)}\nRemaining balance — ${money(customerPackage.deposit.remainingMinor, customerPackage.currency)}`);
  }
  summaryGrid(compactSummaryEntries, summaryColumns);
  for (const [label, value] of longSummaryEntries) section(label, value);

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
    subject: `Ready for customer review - version ${customerPackage.document.version}`,
    author: customerPackage.business.displayName,
    creator: "Meetro",
  });
  return Object.freeze({
    buffer: Buffer.from(doc.output("arraybuffer")),
    pageCount: pages,
    layout: Object.freeze(layout),
  });
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
    const rendered = renderPreparedCustomerPdf(customerPackage, photos, logo, options);
    const buffer = rendered.buffer;
    return Object.freeze({
      buffer,
      base64: buffer.toString("base64"),
      filename: safeFilename(customerPackage),
      contentType: "application/pdf",
      documentId: customerPackage.document.id,
      documentVersion: customerPackage.document.version,
      photoCount: photos.length,
      pageCount: rendered.pageCount,
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
    MAX_IMAGE_PIXELS,
    MAX_NORMALIZED_DIMENSION,
    MAX_TOTAL_IMAGE_BYTES,
    fetchCustomerImage,
    imageKind,
    normalizeCustomerImage,
    prepareCustomerPhotos,
    renderPreparedCustomerPdf,
    safeFilename,
    trustedMediaUrl,
  },
};
