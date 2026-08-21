"use strict";

const { createHash } = require("node:crypto");

const AGREEMENT_TEXT_KEYS = Object.freeze([
  "additionalWorkTerms",
  "hiddenConditionsTerms",
  "diagnosticTerms",
  "customerResponsibilities",
  "warrantyTerms",
  "cancellationTerms",
  "acceptanceTerms",
  "preauthorizedAdditionalWorkLimit",
]);

function cleanText(value, maximum = 12000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function safeEmail(value) {
  const normalized = cleanText(value, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function amountMinor(value) {
  const amount = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : 0;
}

function rowAmountMinor(row = {}) {
  const explicit = row.total ?? row.amount;
  if (String(explicit ?? "").trim()) return amountMinor(explicit);
  const quantity = Number(row.quantity || row.hours || 0);
  const price = Number(row.unitPrice || row.cost || row.rate || 0);
  return Number.isFinite(quantity) && Number.isFinite(price)
    ? Math.round(quantity * price * 100)
    : 0;
}

function safeRows(content = {}) {
  return [
    ...(Array.isArray(content.lineItems) ? content.lineItems : []),
    ...(Array.isArray(content.materialItems) ? content.materialItems : []),
    ...(Array.isArray(content.laborItems) ? content.laborItems : []),
  ].map((row) => ({
    description: cleanText(row.description || row.name, 1200),
    amountMinor: rowAmountMinor(row),
  })).filter((row) => row.description && row.amountMinor >= 0);
}

function safeAgreement(value = {}) {
  const exclusions = Array.isArray(value.exclusions)
    ? value.exclusions.map((item) => cleanText(item, 3000)).filter(Boolean).slice(0, 100)
    : [];
  const result = { exclusions };
  for (const key of AGREEMENT_TEXT_KEYS) result[key] = cleanText(value[key], 8000);
  return Object.freeze(result);
}

function safePhotos(photos = []) {
  return photos.filter((photo) =>
    photo?.visibility === "CUSTOMER_VISIBLE" &&
    ["GENERAL_EVIDENCE", "BEFORE", "AFTER"].includes(photo?.role)
  ).map((photo) => Object.freeze({
    mediaId: cleanText(photo.id || photo.public_id || photo.media?.public_id, 500),
    imageUrl: cleanText(photo.media?.secure_url, 2000),
    role: photo.role,
    name: cleanText(photo.name, 500) || "Project photo",
  })).filter((photo) => photo.mediaId && /^https:\/\//i.test(photo.imageUrl));
}

function buildBusinessDocumentCustomerPackage(document, business = {}) {
  if (!document || !["QUOTE", "INVOICE"].includes(document.documentType)) return null;
  const content = document.content || {};
  const lineItems = safeRows(content);
  const computedTotalMinor = lineItems.reduce((sum, item) => sum + item.amountMinor, 0);
  const totalMinor = String(content.totalOverride || "").trim()
    ? amountMinor(content.totalOverride)
    : computedTotalMinor;
  const agreement = document.documentType === "QUOTE"
    ? safeAgreement(content.agreement || {})
    : safeAgreement({});
  return Object.freeze({
    schemaVersion: 1,
    source: "BUSINESS_DOCUMENT_WORKING_DRAFT_DELIVERY",
    document: Object.freeze({
      id: String(document.id),
      type: document.documentType,
      reference: cleanText(document.reference, 240),
      version: Number(document.version),
      status: "SAVED_DRAFT_NOT_ISSUED",
    }),
    business: Object.freeze({
      displayName: cleanText(business.business_name || business.displayName, 240) || "Meetro Professional",
      email: safeEmail(business.business_email || business.email) || null,
      phone: cleanText(business.phone, 80) || null,
    }),
    customer: Object.freeze({
      name: cleanText(content.customerName, 240) || null,
      email: safeEmail(content.customerEmail) || null,
      location: cleanText(content.customerLocation || content.serviceLocation, 600) || null,
    }),
    project: Object.freeze({
      title: cleanText(content.projectTitle, 500) || null,
      scope: cleanText(content.recommendedSolution || content.projectDescription || content.workPerformed, 12000) || null,
    }),
    lineItems: Object.freeze(lineItems.map(Object.freeze)),
    totalMinor,
    currency: /^[A-Z]{3}$/.test(String(content.currency || "").toUpperCase())
      ? String(content.currency).toUpperCase()
      : "USD",
    paymentTerms: cleanText(content.paymentTerms || content.terms, 8000) || null,
    estimatedDuration: cleanText(content.estimatedDuration, 240) || null,
    agreement,
    notes: cleanText(content.notes, 8000) || null,
    photos: Object.freeze(safePhotos(document.photos || [])),
  });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function customerPackageHash(customerPackage) {
  return createHash("sha256").update(stable(customerPackage)).digest("hex");
}

function formatMoney(minor, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(minor || 0) / 100);
}

function customerPackageLines(customerPackage, customerMessage = "") {
  const agreement = customerPackage.agreement || {};
  const sections = [
    customerPackage.business.displayName,
    `${customerPackage.document.type === "QUOTE" ? "QUOTE + SERVICE AGREEMENT" : "INVOICE"} ${customerPackage.document.reference}`,
    `Saved document version ${customerPackage.document.version} · Not issued`,
    customerPackage.customer.name ? `Customer: ${customerPackage.customer.name}` : null,
    customerPackage.project.title ? `Project: ${customerPackage.project.title}` : null,
    customerPackage.project.scope ? `Scope of Work\n${customerPackage.project.scope}` : null,
    ...customerPackage.lineItems.map((item) => `${item.description}: ${formatMoney(item.amountMinor, customerPackage.currency)}`),
    `${customerPackage.document.type === "QUOTE" ? "Project Price" : "Total Due"}: ${formatMoney(customerPackage.totalMinor, customerPackage.currency)}`,
    customerPackage.paymentTerms ? `Deposit / Payment Terms\n${customerPackage.paymentTerms}` : null,
    agreement.exclusions?.length ? `Not Included / Exclusions\n${agreement.exclusions.map((item) => `- ${item}`).join("\n")}` : null,
    agreement.additionalWorkTerms ? `Additional Work / Change Orders\n${agreement.additionalWorkTerms}` : null,
    agreement.hiddenConditionsTerms ? `Hidden / Unforeseen Conditions\n${agreement.hiddenConditionsTerms}` : null,
    agreement.diagnosticTerms ? `Diagnostic / Troubleshooting Fees\n${agreement.diagnosticTerms}` : null,
    agreement.customerResponsibilities ? `Customer Responsibilities\n${agreement.customerResponsibilities}` : null,
    customerPackage.estimatedDuration ? `Estimated Schedule / Duration\n${customerPackage.estimatedDuration}` : null,
    agreement.warrantyTerms ? `Warranty / Workmanship\n${agreement.warrantyTerms}` : null,
    agreement.cancellationTerms ? `Cancellation / Rescheduling\n${agreement.cancellationTerms}` : null,
    agreement.preauthorizedAdditionalWorkLimit ? `Pre-authorized Additional Work Limit\n${agreement.preauthorizedAdditionalWorkLimit}` : null,
    agreement.acceptanceTerms ? `Acceptance Terms\n${agreement.acceptanceTerms}` : null,
    customerPackage.notes ? `Notes\n${customerPackage.notes}` : null,
    cleanText(customerMessage, 4000) ? `Message\n${cleanText(customerMessage, 4000)}` : null,
    ...customerPackage.photos.map((photo) => `${photo.role.replaceAll("_", " ")} photo: ${photo.imageUrl}`),
  ];
  return sections.filter(Boolean);
}

function escapePdfText(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildCustomerPackagePdf(customerPackage, customerMessage = "") {
  const lines = customerPackageLines(customerPackage, customerMessage)
    .flatMap((line) => String(line).split("\n"))
    .flatMap((line) => line.match(/.{1,88}(?:\s|$)|.{1,88}/g) || [""])
    .slice(0, 120);
  const stream = ["BT", "/F1 10 Tf", "48 742 Td", "13 TL", ...lines.map((line, index) => `${index ? "T* " : ""}(${escapePdfText(line.trim())}) Tj`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function buildCustomerPackageEmail(customerPackage, { subject, customerMessage } = {}) {
  const lines = customerPackageLines(customerPackage, customerMessage);
  const imageHtml = customerPackage.photos.map((photo) =>
    `<figure><img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(photo.role.replaceAll("_", " "))} project evidence" style="max-width:240px;height:auto"><figcaption>${escapeHtml(photo.role.replaceAll("_", " "))}</figcaption></figure>`
  ).join("");
  return Object.freeze({
    subject: cleanText(subject, 240) || `${customerPackage.document.type === "QUOTE" ? "Quote" : "Invoice"} ${customerPackage.document.reference}`,
    text: lines.join("\n\n"),
    html: `<main>${lines.map((line) => `<p style="white-space:pre-line">${escapeHtml(line)}</p>`).join("")}${imageHtml}</main>`,
    attachment: Object.freeze({
      filename: `${customerPackage.document.type.toLowerCase()}-${customerPackage.document.reference || "document"}-v${customerPackage.document.version}.pdf`.replace(/[^a-z0-9._-]+/gi, "-"),
      content: buildCustomerPackagePdf(customerPackage, customerMessage),
      contentType: "application/pdf",
    }),
  });
}

module.exports = {
  AGREEMENT_TEXT_KEYS,
  buildBusinessDocumentCustomerPackage,
  buildCustomerPackageEmail,
  buildCustomerPackagePdf,
  customerPackageHash,
  customerPackageLines,
  safeAgreement,
};
