"use strict";
const invoiceService = require("./invoicePaymentService");
const { buildBusinessDocumentCustomerPackage } = require("../documents/businessDocumentCustomerPackage");
const { renderBusinessDocumentCustomerPdf } = require("../documents/businessDocumentPdfRenderer");

// A presentation of the authorized Invoice, never a saved working-document copy.
async function getCanonicalInvoicePdf(input, { readInvoice, render = renderBusinessDocumentCustomerPdf } = {}) {
  const reader = readInvoice || (input.audience === "customer" ? invoiceService.getCustomerInvoice : invoiceService.getProfessionalInvoice);
  const result = await reader({ pool: input.pool, authenticatedActor: input.authenticatedActor, invoiceId: input.invoiceId });
  if (!result.ok) return result;
  const invoice = result.invoice;
  const version = invoice.currentVersion || result.invoiceVersion;
  if (!Number.isSafeInteger(version) || version < 1 || invoice.invoiceId !== input.invoiceId || (input.expectedVersion != null && Number(input.expectedVersion) !== version)) {
    return { ok: false, status: 409, code: "STALE_INVOICE_VERSION", message: "The Invoice changed. Reopen it before downloading." };
  }
  const base = buildBusinessDocumentCustomerPackage({
    id: invoice.invoiceId, documentType: "INVOICE", documentNumber: invoice.invoiceNumber,
    version, photos: [],
    content: { customerName: invoice.customer.displayName, projectTitle: invoice.job.title,
      invoiceDate: invoice.invoiceDate, dueDate: invoice.due.date || "Due on receipt",
      currency: invoice.currency, notes: invoice.customerNotes || "", paymentTerms: invoice.terms || "" },
  }, invoice.business);
  const customerPackage = Object.freeze({ ...base, source: "CANONICAL_INVOICE",
    document: Object.freeze({ ...base.document, status: invoice.status }),
    lineItems: Object.freeze(invoice.lineItems.map(item => Object.freeze({ description: item.description, quantity: item.quantity, unitAmountMinor: item.unitAmountMinor, lineTotalMinor: item.lineTotalMinor, pricingPresentation: "unit" }))),
    subtotalMinor: invoice.subtotalMinor, totalMinor: invoice.totalMinor, paidMinor: invoice.paidMinor, balanceMinor: invoice.balanceMinor,
  });
  return { ok: true, status: 200, code: "INVOICE_PDF_READY", pdf: await render(customerPackage) };
}
module.exports = { getCanonicalInvoicePdf };
