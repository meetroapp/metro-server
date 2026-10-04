"use strict";

const {
  MAX_UPLOAD_SIZE_BYTES,
  MediaConfigurationError,
  MediaValidationError,
  createCloudinaryMedia,
  resolveCloudinaryConfiguration,
} = require("./cloudinary");
const {
  findOwnedContractorProfileId,
  sendMediaError,
} = require("./uploadSignature");

const QUOTE_DRAFT_PHOTO_PURPOSE = "quote-draft-photo";
const QUOTE_DRAFT_PHOTO_MAX_COUNT = 5;

const REQUIRED_METADATA_FIELDS = Object.freeze([
  "secure_url",
  "public_id",
  "resource_type",
  "format",
  "bytes",
  "width",
  "height",
  "version",
]);

function requirePositiveInteger(value, code = "MEDIA_METADATA_INVALID") {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new MediaValidationError(code);
  }
  return numeric;
}

function normalizeUploadedAt(value) {
  const normalized = String(value || "").trim();
  return normalized || new Date(0).toISOString();
}

function validateCloudinaryUrl(secureUrl, configuration, publicId) {
  let parsed;
  try {
    parsed = new URL(secureUrl);
  } catch {
    throw new MediaValidationError("MEDIA_URL_INVALID");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "res.cloudinary.com" ||
    !parsed.pathname.includes(`/${configuration.cloudName}/image/upload/`) ||
    !parsed.pathname.includes(`/${publicId}`)
  ) {
    throw new MediaValidationError("MEDIA_URL_INVALID");
  }

  return secureUrl;
}

function normalizeQuoteDraftPhoto(
  payload = {},
  { env = process.env, contractorProfileId } = {}
) {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};

  if (source.purpose !== QUOTE_DRAFT_PHOTO_PURPOSE) {
    throw new MediaValidationError("MEDIA_PURPOSE_INVALID");
  }

  const media =
    source.media && typeof source.media === "object" && !Array.isArray(source.media)
      ? source.media
      : source;

  if (
    REQUIRED_METADATA_FIELDS.some(
      (field) =>
        media[field] === undefined ||
        media[field] === null ||
        media[field] === ""
    )
  ) {
    throw new MediaValidationError("MEDIA_METADATA_INVALID");
  }

  const configuration = resolveCloudinaryConfiguration(env);
  const ownerId = requirePositiveInteger(
    contractorProfileId,
    "MEDIA_OWNER_INVALID"
  );

  const ownedPrefix =
    `${configuration.uploadFolder}/businesses/${ownerId}/quote-drafts/`;

  const publicId = String(media.public_id).trim();
  if (!publicId.startsWith(ownedPrefix)) {
    throw new MediaValidationError("MEDIA_ASSET_OWNERSHIP_INVALID");
  }

  const resourceType = String(media.resource_type).trim().toLowerCase();
  const format = String(media.format).trim().toLowerCase();

  if (
    resourceType !== "image" ||
    !["jpg", "jpeg", "png", "webp"].includes(format)
  ) {
    throw new MediaValidationError("MEDIA_FILE_TYPE_INVALID");
  }

  const bytes = requirePositiveInteger(
    media.bytes,
    "MEDIA_FILE_SIZE_INVALID"
  );

  if (bytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new MediaValidationError("MEDIA_FILE_TOO_LARGE");
  }

  const secureUrl = validateCloudinaryUrl(
    String(media.secure_url).trim(),
    configuration,
    publicId
  );

  return Object.freeze({
    id: publicId,
    purpose: QUOTE_DRAFT_PHOTO_PURPOSE,
    public_id: publicId,
    secure_url: secureUrl,
    resource_type: "image",
    format,
    bytes,
    width: requirePositiveInteger(media.width),
    height: requirePositiveInteger(media.height),
    version: requirePositiveInteger(media.version),
    display_order: Number.isInteger(Number(source.display_order))
      ? Math.max(0, Number(source.display_order))
      : 0,
    uploaded_at: normalizeUploadedAt(
      media.uploaded_at || media.created_at
    ),
    contractor_profile_id: ownerId,
    lifecycle_state: "draft_transient",
    customer_visible_by_default: false,
  });
}

function normalizeQuoteDraftPhotoCollection(payload = [], options = {}) {
  if (!Array.isArray(payload)) {
    throw new MediaValidationError("MEDIA_COLLECTION_INVALID");
  }

  if (payload.length > QUOTE_DRAFT_PHOTO_MAX_COUNT) {
    throw new MediaValidationError("MEDIA_COUNT_EXCEEDED");
  }

  const seen = new Set();

  return payload.map((item, index) => {
    const normalized = normalizeQuoteDraftPhoto(
      {
        purpose: QUOTE_DRAFT_PHOTO_PURPOSE,
        ...item,
        display_order: index,
      },
      options
    );

    if (seen.has(normalized.public_id)) {
      throw new MediaValidationError("MEDIA_DUPLICATE_ASSET");
    }

    seen.add(normalized.public_id);

    return {
      ...normalized,
      display_order: index,
    };
  });
}

async function safelyDeleteQuoteDraftPhoto(
  mediaService,
  publicId,
  contractorProfileId
) {
  try {
    await mediaService.deleteOwnedAsset(publicId, {
      purpose: QUOTE_DRAFT_PHOTO_PURPOSE,
      ownership: { contractorProfileId },
      resourceType: "image",
    });
    return true;
  } catch (error) {
    if (error instanceof MediaValidationError) throw error;

    console.error("Quick Quote draft photo cleanup failed", {
      code: "QUOTE_DRAFT_PHOTO_DELETE_FAILED",
    });

    return false;
  }
}

function createQuoteDraftPhotoCleanupHandler({
  getPool,
  env = process.env,
} = {}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool is required");
  }

  return async function quoteDraftPhotoCleanupHandler(req, res) {
    try {
      const contractorProfileId =
        await findOwnedContractorProfileId(
          getPool(req),
          req.user.id
        );

      if (!contractorProfileId) {
        throw new MediaValidationError("MEDIA_OWNER_INVALID");
      }

      const normalized = normalizeQuoteDraftPhoto(req.body, {
        env,
        contractorProfileId,
      });

      const media =
        req.app?.locals?.cloudinaryMedia ||
        createCloudinaryMedia({ env });

      await safelyDeleteQuoteDraftPhoto(
        media,
        normalized.public_id,
        contractorProfileId
      );

      return res.json({
        success: true,
        code: "QUOTE_DRAFT_PHOTO_CLEANED",
      });
    } catch (error) {
      if (error instanceof MediaConfigurationError) {
        return res.status(503).json({
          success: false,
          code: "MEDIA_SERVICE_UNAVAILABLE",
          message: "Media cleanup is temporarily unavailable.",
        });
      }

      return sendMediaError(res, error);
    }
  };
}

module.exports = {
  QUOTE_DRAFT_PHOTO_MAX_COUNT,
  QUOTE_DRAFT_PHOTO_PURPOSE,
  createQuoteDraftPhotoCleanupHandler,
  normalizeQuoteDraftPhoto,
  normalizeQuoteDraftPhotoCollection,
  safelyDeleteQuoteDraftPhoto,
};
