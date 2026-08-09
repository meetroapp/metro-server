"use strict";

const lifecycleService = require("./reportedConcernService");

function sendResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "REQUEST_LIFECYCLE_FAILED",
      message: result?.message || "The request lifecycle could not be loaded.",
    });
  }
  const body = { success: true, code: result.code };
  if (result.lifecycle) body.lifecycle = result.lifecycle;
  if (result.clarification) body.clarification = result.clarification;
  if (result.replayed) body.replayed = true;
  return res.status(result.status || 200).json(body);
}

function createLifecycleHandlers({
  getPool,
  sendPublicDatabaseError,
  service = lifecycleService,
} = {}) {
  const handle = (operation, action) => async (req, res) => {
    if (typeof res.setHeader === "function") {
      res.setHeader("Cache-Control", "private, no-store");
    }
    try {
      return sendResult(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "REQUEST_LIFECYCLE_FAILED",
        message: "The request lifecycle could not be completed.",
      });
    }
  };

  return {
    getRequestLifecycle: handle("get_request_lifecycle", (req) =>
      service.listRequestLifecycle({
        pool: getPool(req),
        authenticatedActor: req.user,
        postId: req.params.postId,
      })
    ),
    appendConcernClarification: handle("append_concern_clarification", (req) =>
      service.appendConcernClarification({
        pool: getPool(req),
        authenticatedActor: req.user,
        postId: req.params.postId,
        concernId: req.params.concernId,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerLifecycleRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = lifecycleService,
} = {}) {
  const handlers = createLifecycleHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get(
    "/posts/:postId/lifecycle",
    authMiddleware,
    handlers.getRequestLifecycle
  );
  app.post(
    "/posts/:postId/reported-concerns/:concernId/clarifications",
    authMiddleware,
    handlers.appendConcernClarification
  );
  return handlers;
}

module.exports = {
  createLifecycleHandlers,
  registerLifecycleRoutes,
  sendResult,
};
