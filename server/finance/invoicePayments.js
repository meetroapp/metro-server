"use strict";

const service = require("./invoicePaymentService");

function sendInvoiceResult(res, result, fields = []) {
  res.setHeader?.("Cache-Control", "private, no-store");
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "INVOICE_PAYMENT_FAILED",
      message: result?.message || "The Invoice operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  for (const field of fields) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createInvoicePaymentHandlers({
  getPool,
  sendPublicDatabaseError,
  invoicePaymentService = service,
} = {}) {
  const handle = (operation, fields, action) => async (req, res) => {
    try {
      return sendInvoiceResult(res, await action(req), fields);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "INVOICE_PAYMENT_FAILED",
        message: "The Invoice operation could not be completed.",
      });
    }
  };

  return {
    getWorkspace: handle("get_professional_invoice_workspace", ["workspace"], (req) =>
      invoicePaymentService.getProfessionalInvoiceWorkspace({
        pool: getPool(req),
        authenticatedActor: req.user,
        limit: req.query?.limit,
      })),
    createInvoice: handle("create_invoice", ["invoice"], (req) =>
      invoicePaymentService.createInvoice({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
        expectedCompletionVersion: req.body?.expectedCompletionVersion,
        due: req.body?.due,
        customerNotes: req.body?.customerNotes,
        terms: req.body?.terms,
        extraWork: req.body?.extraWork,
        idempotencyKey: req.headers?.["idempotency-key"],
      })),
    getProfessionalInvoice: handle("get_professional_invoice", ["invoice"], (req) =>
      invoicePaymentService.getProfessionalInvoice({
        pool: getPool(req),
        authenticatedActor: req.user,
        invoiceId: req.params.invoiceId,
      })),
    getProfessionalJobInvoice: handle("get_professional_job_invoice", ["invoice"], (req) =>
      invoicePaymentService.getProfessionalJobInvoice({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })),
    issueInvoice: handle("issue_invoice", ["invoice", "delivery"], (req) =>
      invoicePaymentService.issueInvoice({
        pool: getPool(req),
        authenticatedActor: req.user,
        invoiceId: req.params.invoiceId,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })),
    recordPayment: handle("record_invoice_payment", ["invoice", "payment"], (req) =>
      invoicePaymentService.recordPayment({
        pool: getPool(req),
        authenticatedActor: req.user,
        invoiceId: req.params.invoiceId,
        expectedVersion: req.body?.expectedVersion,
        amountMinor: req.body?.amountMinor,
        method: req.body?.method,
        receivedDate: req.body?.receivedDate,
        customerReference: req.body?.customerReference,
        idempotencyKey: req.headers?.["idempotency-key"],
      })),
    getCustomerInvoice: handle("get_customer_invoice", ["invoice"], (req) =>
      invoicePaymentService.getCustomerInvoice({
        pool: getPool(req),
        authenticatedActor: req.user,
        invoiceId: req.params.invoiceId,
      })),
    getCustomerJobInvoice: handle("get_customer_job_invoice", ["invoice"], (req) =>
      invoicePaymentService.getCustomerJobInvoice({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })),
  };
}

function registerInvoicePaymentRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  invoicePaymentService = service,
} = {}) {
  const handlers = createInvoicePaymentHandlers({
    getPool,
    sendPublicDatabaseError,
    invoicePaymentService,
  });
  app.get("/professional/invoices/workspace", authMiddleware, handlers.getWorkspace);
  app.post("/professional/jobs/:jobId/invoices", authMiddleware, handlers.createInvoice);
  app.get("/professional/jobs/:jobId/invoice", authMiddleware, handlers.getProfessionalJobInvoice);
  app.get("/professional/invoices/:invoiceId", authMiddleware, handlers.getProfessionalInvoice);
  app.post("/professional/invoices/:invoiceId/issue", authMiddleware, handlers.issueInvoice);
  app.post("/professional/invoices/:invoiceId/payments", authMiddleware, handlers.recordPayment);
  app.get("/customer/invoices/:invoiceId", authMiddleware, handlers.getCustomerInvoice);
  app.get("/customer/jobs/:jobId/invoice", authMiddleware, handlers.getCustomerJobInvoice);
  return handlers;
}

module.exports = {
  createInvoicePaymentHandlers,
  registerInvoicePaymentRoutes,
  sendInvoiceResult,
};
