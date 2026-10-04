"use strict";

const service =
  require("./paymentReminderService");

function sendPaymentReminderResult(
  res,
  result
) {
  res.setHeader?.(
    "Cache-Control",
    "private, no-store"
  );

  if (!result?.ok) {
    return res
      .status(
        result?.status || 500
      )
      .json({
        success: false,
        code:
          result?.code ||
          "PAYMENT_REMINDER_FAILED",
        message:
          result?.message ||
          "The Payment Reminder could not be sent.",
      });
  }

  const payload = {
    success: true,
    code: result.code,
    reminder:
      result.reminder,
  };

  if (result.replayed) {
    payload.replayed = true;
  }

  return res
    .status(
      result.status || 200
    )
    .json(payload);
}

function createPaymentReminderHandlers({
  getPool,
  sendPublicDatabaseError,
  paymentReminderService = service,
} = {}) {
  if (
    typeof getPool !== "function" ||
    typeof sendPublicDatabaseError !==
      "function"
  ) {
    throw new TypeError(
      "Payment Reminder route dependencies are required."
    );
  }

  async function handle(
    req,
    res,
    action,
    operation
  ) {
    try {
      return sendPaymentReminderResult(
        res,
        await action()
      );
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code:
          "PAYMENT_REMINDER_FAILED",
        message:
          "The Payment Reminder could not be sent.",
      });
    }
  }

  return {
    sendInvoiceReminder:
      (req, res) =>
        handle(
          req,
          res,
          () =>
            paymentReminderService
              .sendInvoicePaymentReminder({
                pool:
                  getPool(req),
                authenticatedActor:
                  req.user,
                invoiceId:
                  req.params.invoiceId,
                expectedVersion:
                  req.body
                    ?.expectedVersion,
                messageText:
                  req.body
                    ?.messageText,
                idempotencyKey:
                  req.headers?.[
                    "idempotency-key"
                  ],
              }),
          "send_invoice_payment_reminder"
        ),

    sendDepositReminder:
      (req, res) =>
        handle(
          req,
          res,
          () =>
            paymentReminderService
              .sendDepositPaymentReminder({
                pool:
                  getPool(req),
                authenticatedActor:
                  req.user,
                jobId:
                  req.params.jobId,
                expectedVersion:
                  req.body
                    ?.expectedVersion,
                messageText:
                  req.body
                    ?.messageText,
                idempotencyKey:
                  req.headers?.[
                    "idempotency-key"
                  ],
              }),
          "send_deposit_payment_reminder"
        ),
  };
}

function registerPaymentReminderRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  paymentReminderService = service,
} = {}) {
  if (
    !app ||
    typeof app.post !== "function"
  ) {
    throw new TypeError(
      "An Express application is required."
    );
  }

  if (
    typeof authMiddleware !==
    "function"
  ) {
    throw new TypeError(
      "authMiddleware must be a function."
    );
  }

  const handlers =
    createPaymentReminderHandlers({
      getPool,
      sendPublicDatabaseError,
      paymentReminderService,
    });

  app.post(
    "/professional/invoices/:invoiceId/reminders",
    authMiddleware,
    handlers.sendInvoiceReminder
  );

  app.post(
    "/jobs/:jobId/pre-work-deposit/reminders",
    authMiddleware,
    handlers.sendDepositReminder
  );

  return handlers;
}

module.exports = {
  createPaymentReminderHandlers,
  registerPaymentReminderRoutes,
  sendPaymentReminderResult,
};
