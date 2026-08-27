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

function optionalAmountMinor(value) {
  return String(value ?? "").trim() ? amountMinor(value) : null;
}

function rowAmountMinor(row = {}) {
  const explicit = row.total ?? row.amount;
  if (String(explicit ?? "").trim()) return amountMinor(explicit);
  const quantity = Number(row.quantity || row.hours || 0);
  const price = Number(row.unitPrice || row.rate || 0);
  return Number.isFinite(quantity) && Number.isFinite(price)
    ? Math.round(quantity * price * 100)
    : 0;
}

function safeCategorizedRows(content = {}) {
  return [
    ...(Array.isArray(content.lineItems) ? content.lineItems.map((row) => [row, "SERVICE"]) : []),
    ...(Array.isArray(content.materialItems) ? content.materialItems.map((row) => [row, "MATERIAL"]) : []),
    ...(Array.isArray(content.laborItems) ? content.laborItems.map((row) => [row, "LABOR"]) : []),
  ].map(([row, category]) => {
    const quantity = Number(row.quantity || row.hours || 0);
    const unitSource = row.unitPrice ?? row.rate;
    const unitAmount = Number(unitSource || 0);
    const unitPricing = Boolean(String(unitSource ?? "").trim()) && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitAmount) && unitAmount >= 0;
    return {
      description: cleanText(row.description || row.name, 1200),
      quantity: unitPricing ? quantity : null,
      unitAmountMinor: unitPricing ? amountMinor(unitAmount) : null,
      lineTotalMinor: rowAmountMinor(row),
      pricingPresentation: unitPricing ? "unit" : "flat",
      category,
    };
  }).filter((row) => row.description && row.lineTotalMinor > 0);
}

function customerPricing(content = {}) {
  const internalRows = safeCategorizedRows(content);
  const pricingDisplayMode = ["TOTAL_ONLY", "CATEGORY_BREAKDOWN", "DETAILED_LINE_ITEMS"].includes(content.pricingDisplayMode)
    ? content.pricingDisplayMode
    : "DETAILED_LINE_ITEMS";
  const materialsDisplayMode = ["INCLUDED_IN_TOTAL", "SHOW_SEPARATELY", "CUSTOMER_PROVIDES"].includes(content.materialsDisplayMode)
    ? content.materialsDisplayMode
    : "SHOW_SEPARATELY";
  const includedRows = materialsDisplayMode === "CUSTOMER_PROVIDES"
    ? internalRows.filter((row) => row.category !== "MATERIAL")
    : internalRows;
  let rows = includedRows;
  if (pricingDisplayMode === "TOTAL_ONLY") rows = [];
  if (pricingDisplayMode === "CATEGORY_BREAKDOWN") {
    rows = ["SERVICE", "LABOR", "MATERIAL"].map((category) => {
      const total = includedRows.filter((row) => row.category === category).reduce((sum, row) => sum + row.lineTotalMinor, 0);
      return total > 0 ? {
        description: category === "SERVICE" ? "Services" : category === "LABOR" ? "Labor" : "Materials",
        quantity: null,
        unitAmountMinor: null,
        lineTotalMinor: total,
        pricingPresentation: "flat",
      } : null;
    }).filter(Boolean);
  }
  const lineTotalMinor = includedRows.reduce((sum, row) => sum + row.lineTotalMinor, 0);
  const explicitTotalMinor = String(content.totalOverride || "").trim()
    ? amountMinor(content.totalOverride)
    : null;
  const totalMinor = explicitTotalMinor ?? lineTotalMinor;
  const pricingNote = materialsDisplayMode === "CUSTOMER_PROVIDES"
    ? "Customer to provide materials"
    : materialsDisplayMode === "INCLUDED_IN_TOTAL"
      ? "Labor and standard materials included"
      : null;
  const depositMode = ["NONE", "PERCENT", "FIXED"].includes(content.depositMode)
    ? content.depositMode
    : "NONE";
  let deposit = null;
  if (depositMode === "PERCENT") {
    const percent = Number(content.depositPercent);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      const dueMinor = Math.round(totalMinor * percent / 100);
      deposit = { mode: "PERCENT", percent, dueMinor, remainingMinor: totalMinor - dueMinor };
    }
  } else if (depositMode === "FIXED") {
    const dueMinor = optionalAmountMinor(content.depositFixedAmount);
    if (dueMinor != null && dueMinor <= totalMinor) {
      deposit = { mode: "FIXED", dueMinor, remainingMinor: totalMinor - dueMinor };
    }
  }
  return {
    rows: rows.map(({ category, ...row }) => row),
    internalRows,
    lineTotalMinor,
    totalMinor,
    pricingDisplayMode,
    materialsDisplayMode,
    pricingNote,
    deposit,
  };
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

function safeList(values = []) {
  return Array.isArray(values)
    ? values.map((value) => cleanText(value, 3000)).filter(Boolean).slice(0, 100)
    : [];
}

function businessLogo(business = {}) {
  const direct = cleanText(business.image_url || business.logoUrl, 2000);
  let details = business.profile_details;
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { details = {}; }
  }
  const candidate = direct || cleanText(details?.logo_media?.secure_url, 2000);
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function buildBusinessDocumentCustomerPackage(document, business = {}) {
  if (!document || !["QUOTE", "INVOICE"].includes(document.documentType)) return null;
  const content = document.content || {};
  const isQuote = document.documentType === "QUOTE";
  const projectObservation = isQuote ? cleanText(content.projectDescription, 12000) : "";
  const projectScope = cleanText(
    isQuote
      ? content.recommendedSolution || content.projectDescription
      : content.workPerformed || content.projectDescription,
    12000
  );
  const pricing = customerPricing(content);
  const lineItems = pricing.rows;
  const computedSubtotalMinor = pricing.lineTotalMinor;
  const subtotalMinor = optionalAmountMinor(content.subtotal) ?? computedSubtotalMinor;
  const discountMinor = optionalAmountMinor(content.discount) ?? 0;
  const taxMinor = optionalAmountMinor(content.tax) ?? 0;
  const feesMinor = optionalAmountMinor(content.fees) ?? 0;
  const totalMinor = String(content.totalOverride || "").trim()
    ? pricing.totalMinor
    : Math.max(0, computedSubtotalMinor - discountMinor + taxMinor + feesMinor);
  const paidMinor = optionalAmountMinor(content.paidAmount);
  const balanceMinor = optionalAmountMinor(content.balanceDue) ?? Math.max(0, totalMinor - (paidMinor || 0));
  const agreement = document.documentType === "QUOTE"
    ? safeAgreement(content.agreement || {})
    : safeAgreement({});
  return Object.freeze({
    schemaVersion: 1,
    source: "BUSINESS_DOCUMENT_WORKING_DRAFT_DELIVERY",
    document: Object.freeze({
      id: String(document.id),
      type: document.documentType,
      reference: cleanText(document.documentNumber || document.reference, 240),
      version: Number(document.version),
      status: "SAVED_DRAFT_NOT_ISSUED",
      date: cleanText(document.documentType === "QUOTE" ? content.quoteDate : content.invoiceDate, 80) || null,
      dueDate: cleanText(content.dueDate, 80) || null,
    }),
    business: Object.freeze({
      displayName: cleanText(business.business_name || business.displayName, 240) || "Meetro Professional",
      email: safeEmail(business.business_email || business.email) || null,
      phone: cleanText(business.phone, 80) || null,
      website: cleanText(business.website || business.business_website, 240) || null,
      location: cleanText(business.location, 500) || null,
      logoUrl: businessLogo(business),
    }),
    customer: Object.freeze({
      name: cleanText(content.customerName, 240) || null,
      email: safeEmail(content.customerEmail) || null,
      phone: cleanText(content.customerPhone, 80) || null,
      address: cleanText(content.customerAddress, 600) || null,
      location: cleanText(content.customerLocation || content.serviceLocation, 600) || null,
    }),
    project: Object.freeze({
      title: cleanText(content.projectTitle, 500) || null,
      scope: projectScope || null,
      observation: projectObservation && projectObservation !== projectScope
        ? projectObservation
        : null,
    }),
    lineItems: Object.freeze(lineItems.map(Object.freeze)),
    subtotalMinor,
    discountMinor,
    taxMinor,
    feesMinor,
    totalMinor,
    paidMinor,
    balanceMinor,
    currency: /^[A-Z]{3}$/.test(String(content.currency || "").toUpperCase())
      ? String(content.currency).toUpperCase()
      : "USD",
    paymentTerms: cleanText(content.paymentTerms || content.terms, 8000) || null,
    ...(content.pricingDisplayMode || content.materialsDisplayMode ? {
      pricingPresentation: Object.freeze({
        displayMode: pricing.pricingDisplayMode,
        materialsMode: pricing.materialsDisplayMode,
        note: pricing.pricingNote,
      }),
    } : {}),
    ...(content.depositMode ? { deposit: pricing.deposit ? Object.freeze(pricing.deposit) : null } : {}),
    estimatedDuration: cleanText(content.estimatedDuration, 240) || null,
    conditions: Object.freeze(safeList(content.conditions)),
    exclusions: Object.freeze(safeList(content.exclusions)),
    agreement,
    notes: cleanText(content.notes, 8000) || null,
    warrantyNotes: cleanText(content.warrantyNotes, 8000) || null,
    customerMessage: cleanText(content.customerMessage, 4000) || null,
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
    `Ready for customer review · Version ${customerPackage.document.version}`,
    customerPackage.customer.name ? `Customer: ${customerPackage.customer.name}` : null,
    customerPackage.project.title ? `Project: ${customerPackage.project.title}` : null,
    customerPackage.project.scope ? `Scope of Work\n${customerPackage.project.scope}` : null,
    customerPackage.project.observation ? `Observation\n${customerPackage.project.observation}` : null,
    ...customerPackage.lineItems.map((item) => `${item.description}: ${formatMoney(item.lineTotalMinor, customerPackage.currency)}`),
    `${customerPackage.document.type === "QUOTE" ? "Project Price" : "Total Due"}: ${formatMoney(customerPackage.totalMinor, customerPackage.currency)}`,
    customerPackage.pricingPresentation?.note || null,
    customerPackage.deposit
      ? `${customerPackage.deposit.mode === "PERCENT" ? `${customerPackage.deposit.percent}% deposit due on approval` : "Deposit due on approval"}: ${formatMoney(customerPackage.deposit.dueMinor, customerPackage.currency)}\nRemaining balance: ${formatMoney(customerPackage.deposit.remainingMinor, customerPackage.currency)}`
      : null,
    customerPackage.paymentTerms ? `Deposit / Payment Terms\n${customerPackage.paymentTerms}` : null,
    [...new Set([...(customerPackage.exclusions || []), ...(agreement.exclusions || [])])].length
      ? `Not Included / Exclusions\n${[...new Set([...(customerPackage.exclusions || []), ...(agreement.exclusions || [])])].map((item) => `- ${item}`).join("\n")}`
      : null,
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
    customerPackage.photos.length ? `${customerPackage.photos.length} customer-visible project photo${customerPackage.photos.length === 1 ? " is" : "s are"} included in the attached PDF.` : null,
  ];
  return sections.filter(Boolean);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function buildCustomerPackageEmail(customerPackage, { subject, customerMessage, pdfArtifact } = {}) {
  if (!pdfArtifact?.base64 || pdfArtifact.contentType !== "application/pdf") {
    throw new TypeError("A rendered saved-version PDF artifact is required.");
  }
  const lines = customerPackageLines(customerPackage, customerMessage);
  const photoRoleOrder = Object.freeze({
    GENERAL_EVIDENCE: 0,
    BEFORE: 1,
    AFTER: 2,
  });
  const imageHtml = [...customerPackage.photos]
    .sort((left, right) =>
      (photoRoleOrder[left.role] ?? 99) - (photoRoleOrder[right.role] ?? 99)
    )
    .map((photo) =>
      `<figure><img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(photo.role.replaceAll("_", " "))} project evidence" style="max-width:240px;height:auto"><figcaption>${escapeHtml(photo.role.replaceAll("_", " "))}</figcaption></figure>`
    ).join("");
  return Object.freeze({
    subject: cleanText(subject, 240) || `${customerPackage.document.type === "QUOTE" ? "Quote" : "Invoice"} ${customerPackage.document.reference}`,
    text: lines.join("\n\n"),
    html: `<main>${lines.map((line) => `<p style="white-space:pre-line">${escapeHtml(line)}</p>`).join("")}${imageHtml}</main>`,
    attachment: Object.freeze({
      filename: pdfArtifact.filename,
      content: pdfArtifact.base64,
      contentType: "application/pdf",
    }),
  });
}

module.exports = {
  AGREEMENT_TEXT_KEYS,
  buildBusinessDocumentCustomerPackage,
  buildCustomerPackageEmail,
  customerPackageHash,
  customerPackageLines,
  safeAgreement,
};
