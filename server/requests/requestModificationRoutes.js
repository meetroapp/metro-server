"use strict";

const { MediaValidationError, createCloudinaryMedia } = require("../media/cloudinary");
const { safelyDeleteRequestPhoto } = require("../media/requestPhoto");
const { sendMediaError } = require("../media/uploadSignature");
const requestModificationService = require("./requestModificationService");

function setPrivateNoStore(res) {
  if (typeof res?.setHeader === "function") {
    res.setHeader("Cache-Control", "private, no-store");
  }
}

function sendResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "REQUEST_MODIFICATION_FAILED",
      message: result?.message || "The request modification could not be completed.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    ...(result.post ? { post: result.post } : {}),
    ...(result.concernSupersession
      ? { concernSupersession: result.concernSupersession }
      : {}),
    ...(result.photo ? { photo: result.photo } : {}),
    ...(result.requestVersion
      ? { requestVersion: result.requestVersion }
      : {}),
    ...(result.replayed ? { replayed: true } : {}),
  });
}

async function cleanupRemovedPhotos(req, photos = []) {
  if (!photos.length) return;
  try {
    const media = req.app?.locals?.cloudinaryMedia ||
      createCloudinaryMedia({ env: process.env });
    for (const photo of photos) {
      await safelyDeleteRequestPhoto(media, photo.public_id, req.user.id);
    }
  } catch {
    console.error("Request photo media cleanup failed", {
      code: "REQUEST_PHOTO_DELETE_FAILED",
    });
  }
}

function createRequestModificationHandlers({
  getPool,
  sendPublicDatabaseError,
  service = requestModificationService,
} = {}) {
  return {
    updateRequest: async (req, res) => {
      setPrivateNoStore(res);
      try {
        const result = await service.updateRequest({
          pool: getPool(req),
          authenticatedActor: req.user,
          postId: req.params.id,
          payload: req.body,
        });
        if (result.ok && result.cleanupPhotos?.length > 0) {
          await cleanupRemovedPhotos(req, result.cleanupPhotos);
        }
        return sendResult(res, result);
      } catch (error) {
        if (error instanceof MediaValidationError) {
          return sendMediaError(res, error);
        }
        return sendPublicDatabaseError({
          res,
          error,
          operation: "update_post",
          code: "POST_UPDATE_FAILED",
          message: "The request could not be updated.",
        });
      }
    },

    appendRequestPhoto: async (req, res) => {
      setPrivateNoStore(res);
      try {
        return sendResult(res, await service.appendRequestPhoto({
          pool: getPool(req),
          authenticatedActor: req.user,
          postId: req.params.postId,
          concernId: req.params.concernId,
          payload: req.body,
          idempotencyKey: req.headers?.["idempotency-key"],
        }));
      } catch (error) {
        if (error instanceof MediaValidationError) {
          return sendMediaError(res, error);
        }
        return sendPublicDatabaseError({
          res,
          error,
          operation: "append_request_photo",
          code: "REQUEST_PHOTO_APPEND_FAILED",
          message: "The request photo could not be attached.",
        });
      }
    },
  };
}

function registerRequestModificationRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = requestModificationService,
} = {}) {
  const handlers = createRequestModificationHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.put("/posts/:id", authMiddleware, handlers.updateRequest);
  app.post(
    "/posts/:postId/reported-concerns/:concernId/photos",
    authMiddleware,
    handlers.appendRequestPhoto
  );
  return handlers;
}

module.exports = {
  createRequestModificationHandlers,
  registerRequestModificationRoutes,
  sendResult,
};
