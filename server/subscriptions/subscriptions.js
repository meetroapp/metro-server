"use strict";

const subscriptionService = require("./subscriptionService");
const { createAppleSubscriptionVerifier } = require("./appleSubscriptionVerifier");

function send(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "SUBSCRIPTION_OPERATION_FAILED",
      message: result?.message || "The subscription operation could not be completed.",
    });
  }
  const { ok, status, ...payload } = result;
  return res.status(status || 200).json({ success: true, ...payload });
}

function createSubscriptionHandlers({
  getPool,
  sendPublicDatabaseError,
  service = subscriptionService,
  environment = process.env,
  verifierFactory = createAppleSubscriptionVerifier,
}) {
  const handle = (operation, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return send(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "SUBSCRIPTION_OPERATION_FAILED",
        message: "The subscription operation could not be completed.",
      });
    }
  };
  const verify = (eventType) => handle("verify_apple_subscription", (req) =>
    service.verifyAppleEvidence({
      pool: getPool(req),
      authenticatedActor: req.user,
      signedTransactionInfo: req.body?.signedTransactionInfo,
      signedRenewalInfo: req.body?.signedRenewalInfo,
      eventType,
      verifier: verifierFactory(environment),
      environment,
    })
  );
  const appleNotification = handle("process_apple_subscription_notification", async (req) => {
    const signedPayload = req.body?.signedPayload;
    if (typeof signedPayload !== "string" || signedPayload.length < 100) {
      return { ok: false, status: 400, code: "INVALID_APPLE_NOTIFICATION", message: "Apple notification is invalid." };
    }
    const verifier = verifierFactory(environment);
    if (!verifier.configured) {
      return { ok: false, status: 503, code: "APPLE_SERVER_CONFIGURATION_REQUIRED", message: "Apple purchase verification is not configured." };
    }
    let notification;
    let transaction;
    try {
      notification = await verifier.verifyNotification(signedPayload);
      const signedTransactionInfo = notification?.data?.signedTransactionInfo;
      if (!signedTransactionInfo) {
        return { ok: true, status: 200, code: "APPLE_NOTIFICATION_VERIFIED_NO_TRANSACTION" };
      }
      transaction = await verifier.verifyTransaction(signedTransactionInfo);
    } catch {
      return { ok: false, status: 422, code: "APPLE_NOTIFICATION_NOT_VERIFIED", message: "Apple could not verify this notification." };
    }
    const accountToken = String(transaction?.appAccountToken || "").toLowerCase();
    if (!accountToken) {
      return { ok: false, status: 422, code: "APPLE_NOTIFICATION_ACCOUNT_MISSING", message: "Apple notification has no business binding." };
    }
    const owner = await getPool(req).query(
      `SELECT profiles.user_id
         FROM professional_subscription_accounts accounts
         JOIN contractor_profiles profiles ON profiles.id = accounts.contractor_profile_id
        WHERE lower(accounts.app_account_token::text) = $1`,
      [accountToken]
    );
    if (!owner.rows[0]) {
      return { ok: true, status: 202, code: "APPLE_NOTIFICATION_ACCOUNT_UNKNOWN" };
    }
    return service.verifyAppleEvidence({
      pool: getPool(req),
      authenticatedActor: { id: Number(owner.rows[0].user_id) },
      signedTransactionInfo: notification.data.signedTransactionInfo,
      signedRenewalInfo: notification.data.signedRenewalInfo,
      eventType: `SERVER_NOTIFICATION_${String(notification.notificationType || "UNKNOWN")}_${String(notification.subtype || "NONE")}_${String(notification.notificationUUID || "NO_UUID")}`,
      verifier,
      environment,
    });
  });
  return {
    getState: handle("get_subscription_state", (req) => service.getSubscriptionState({
      pool: getPool(req),
      authenticatedActor: req.user,
      environment,
    })),
    verifyPurchase: verify("PURCHASE_OR_REFRESH"),
    restore: verify("RESTORE"),
    appleNotification,
  };
}

function registerSubscriptionRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError("Subscription route dependencies are required.");
  }
  const handlers = createSubscriptionHandlers(options);
  app.get("/subscriptions/me", authMiddleware, handlers.getState);
  app.post("/subscriptions/apple/verify", authMiddleware, handlers.verifyPurchase);
  app.post("/subscriptions/apple/restore", authMiddleware, handlers.restore);
  app.post("/subscriptions/apple/notifications", handlers.appleNotification);
  return handlers;
}

module.exports = {
  createSubscriptionHandlers,
  registerSubscriptionRoutes,
  send,
};
