"use strict";

const {
  MediaConfigurationError,
  MediaValidationError,
  createCloudinaryMedia,
  normalizeUploadMetadata,
} = require("./cloudinary");

const ENABLED_SIGNATURE_PURPOSES = Object.freeze([
  "personal_profile",
  "business-logo",
  "business-portfolio",
  "request-photo",
]);

async function findOwnedContractorProfileId(pool, userId) {
  const result = await pool.query(
    `
    SELECT id
    FROM contractor_profiles
    WHERE user_id = $1
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    `,
    [userId]
  );
  return result.rows[0]?.id || null;
}

function sendMediaError(res, error) {
  if (error instanceof MediaValidationError) {
    const status = error.code === "MEDIA_OWNER_INVALID" ? 404 : 400;
    return res.status(status).json({
      success: false,
      code: error.code,
      message: status === 404
        ? "The requested media destination is unavailable."
        : "The media request is invalid.",
    });
  }

  if (error instanceof MediaConfigurationError) {
    return res.status(503).json({
      success: false,
      code: "MEDIA_SERVICE_UNAVAILABLE",
      message: "Media uploads are temporarily unavailable.",
    });
  }

  console.error("Media signature operation failed", {
    code: "MEDIA_SIGNATURE_OPERATION_FAILED",
  });
  return res.status(500).json({
    success: false,
    code: "MEDIA_SIGNATURE_FAILED",
    message: "The media request could not be completed.",
  });
}

function createUploadSignatureHandler({ getPool, env = process.env } = {}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool is required");
  }

  return async function uploadSignatureHandler(req, res) {
    try {
      const metadata = normalizeUploadMetadata(req.body);
      if (!ENABLED_SIGNATURE_PURPOSES.includes(metadata.purpose)) {
        throw new MediaValidationError("MEDIA_PURPOSE_NOT_ENABLED");
      }

      const media = req.app?.locals?.cloudinaryMedia || createCloudinaryMedia({ env });
      const ownership = { userId: req.user.id };

      if (
        metadata.purpose !== "personal_profile" &&
        metadata.purpose !== "request-photo"
      ) {
        ownership.contractorProfileId = await findOwnedContractorProfileId(
          getPool(req),
          req.user.id
        );
        if (!ownership.contractorProfileId) {
          throw new MediaValidationError("MEDIA_OWNER_INVALID");
        }
      }

      const upload = media.createUploadSignature(metadata, ownership);
      return res.json({
        success: true,
        code: "MEDIA_UPLOAD_SIGNATURE_CREATED",
        upload,
      });
    } catch (error) {
      return sendMediaError(res, error);
    }
  };
}

module.exports = {
  createUploadSignatureHandler,
  findOwnedContractorProfileId,
  sendMediaError,
};
