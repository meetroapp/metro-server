"use strict";

const {
  ALLOWED_MEDIA_FORMATS,
  MAX_UPLOAD_SIZE_BYTES,
  MediaConfigurationError,
  MediaValidationError,
  buildOwnedMediaFolder,
  createCloudinaryMedia,
  resolveCloudinaryConfiguration,
} = require("../media/cloudinary");

const REQUIRED_METADATA_FIELDS = Object.freeze([
  "secure_url",
  "public_id",
  "resource_type",
  "format",
  "bytes",
  "width",
  "height",
  "version",
  "uploaded_at",
]);

function requirePositiveInteger(value, code = "MEDIA_METADATA_INVALID") {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new MediaValidationError(code);
  }
  return number;
}

function normalizeUploadedAt(value) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    throw new MediaValidationError("MEDIA_METADATA_INVALID");
  }
  return date.toISOString();
}

function validateCloudinaryUrl(secureUrl, configuration, publicId, format) {
  let url;
  try {
    url = new URL(secureUrl);
  } catch {
    throw new MediaValidationError("MEDIA_URL_INVALID");
  }
  const expectedPrefix = `/${configuration.cloudName}/image/upload/`;
  const decodedPath = decodeURIComponent(url.pathname);
  const expectedAssetPath = `/${publicId}.${format}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "res.cloudinary.com" ||
    !decodedPath.startsWith(expectedPrefix) ||
    !decodedPath.endsWith(expectedAssetPath)
  ) {
    throw new MediaValidationError("MEDIA_URL_INVALID");
  }
  return url.toString();
}

function normalizePersonalProfileImage(payload, { env = process.env, userId } = {}) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  if (source.purpose !== "personal_profile") {
    throw new MediaValidationError("MEDIA_PURPOSE_INVALID");
  }
  const media = source.media && typeof source.media === "object" && !Array.isArray(source.media)
    ? source.media
    : {};
  if (REQUIRED_METADATA_FIELDS.some((field) => media[field] === undefined || media[field] === null || media[field] === "")) {
    throw new MediaValidationError("MEDIA_METADATA_MISSING");
  }

  const configuration = resolveCloudinaryConfiguration(env);
  const ownedFolder = buildOwnedMediaFolder(
    configuration,
    "personal_profile",
    { userId }
  );
  const publicId = String(media.public_id).trim();
  if (!publicId.startsWith(`${ownedFolder}/`)) {
    throw new MediaValidationError("MEDIA_ASSET_OWNERSHIP_INVALID");
  }
  const resourceType = String(media.resource_type).trim().toLowerCase();
  if (resourceType !== "image") {
    throw new MediaValidationError("MEDIA_RESOURCE_TYPE_INVALID");
  }
  const format = String(media.format).trim().toLowerCase();
  if (!ALLOWED_MEDIA_FORMATS.includes(format)) {
    throw new MediaValidationError("MEDIA_FILE_TYPE_INVALID");
  }
  const bytes = requirePositiveInteger(media.bytes, "MEDIA_FILE_SIZE_INVALID");
  if (bytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new MediaValidationError("MEDIA_FILE_TOO_LARGE");
  }
  const secureUrl = validateCloudinaryUrl(
    String(media.secure_url).trim(),
    configuration,
    publicId,
    format
  );

  return Object.freeze({
    secure_url: secureUrl,
    public_id: publicId,
    resource_type: resourceType,
    format,
    bytes,
    width: requirePositiveInteger(media.width),
    height: requirePositiveInteger(media.height),
    version: requirePositiveInteger(media.version),
    uploaded_at: normalizeUploadedAt(media.uploaded_at),
  });
}

function parseStoredMedia(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value.public_id ? value : null;
}

async function safelyDelete(mediaService, publicId, userId, logCode) {
  if (!publicId) return;
  try {
    await mediaService.deleteOwnedAsset(publicId, {
      purpose: "personal_profile",
      ownership: { userId },
    });
  } catch {
    console.error("Personal profile media cleanup failed", { code: logCode });
  }
}

async function persistPersonalProfileImage({
  pool,
  userId,
  payload,
  env = process.env,
  mediaService = createCloudinaryMedia({ env }),
} = {}) {
  const metadata = normalizePersonalProfileImage(payload, { env, userId });
  let client = null;
  let transactionStarted = false;
  let currentMedia = null;
  try {
    client = typeof pool?.connect === "function" ? await pool.connect() : pool;
    if (!client || typeof client.query !== "function") {
      throw new TypeError("A database client is required");
    }
    await client.query("BEGIN");
    transactionStarted = true;
    const current = await client.query(
      "SELECT profile_photo_details FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (!current.rows[0]) {
      throw new MediaValidationError("MEDIA_OWNER_INVALID");
    }
    currentMedia = parseStoredMedia(current.rows[0].profile_photo_details);
    const updated = await client.query(
      `
      UPDATE users
      SET profile_photo_url = $1,
          profile_photo_details = $2::jsonb
      WHERE id = $3
      RETURNING id, username, email, role, account_type, business_name,
                business_category, profile_photo_url, token_version, created_at
      `,
      [metadata.secure_url, JSON.stringify(metadata), userId]
    );
    if (!updated.rows[0]) {
      throw new MediaValidationError("MEDIA_OWNER_INVALID");
    }
    await client.query("COMMIT");
    transactionStarted = false;

    if (currentMedia?.public_id && currentMedia.public_id !== metadata.public_id) {
      await safelyDelete(
        mediaService,
        currentMedia.public_id,
        userId,
        "OLD_PROFILE_IMAGE_DELETE_FAILED"
      );
    }
    return { user: updated.rows[0], media: metadata };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    if (currentMedia?.public_id !== metadata.public_id) {
      await safelyDelete(
        mediaService,
        metadata.public_id,
        userId,
        "NEW_PROFILE_IMAGE_CLEANUP_FAILED"
      );
    }
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

function sendPersonalProfileImageError(res, error) {
  if (error instanceof MediaValidationError) {
    const status = error.code === "MEDIA_OWNER_INVALID" ? 404 : 400;
    return res.status(status).json({
      success: false,
      code: error.code,
      message: "The profile image could not be saved.",
    });
  }
  if (error instanceof MediaConfigurationError) {
    return res.status(503).json({
      success: false,
      code: "MEDIA_SERVICE_UNAVAILABLE",
      message: "Media uploads are temporarily unavailable.",
    });
  }
  console.error("Personal profile image persistence failed", {
    code: "PROFILE_IMAGE_PERSISTENCE_FAILED",
  });
  return res.status(500).json({
    success: false,
    code: "PROFILE_IMAGE_PERSISTENCE_FAILED",
    message: "The profile image could not be saved.",
  });
}

function createPersonalProfileImageHandler({ getPool, env = process.env } = {}) {
  return async function personalProfileImageHandler(req, res) {
    try {
      const result = await persistPersonalProfileImage({
        pool: getPool(req),
        userId: req.user.id,
        payload: req.body,
        env,
        mediaService: req.app?.locals?.cloudinaryMedia || createCloudinaryMedia({ env }),
      });
      return res.json({
        success: true,
        code: "PROFILE_IMAGE_UPDATED",
        user: result.user,
      });
    } catch (error) {
      return sendPersonalProfileImageError(res, error);
    }
  };
}

module.exports = {
  REQUIRED_METADATA_FIELDS,
  createPersonalProfileImageHandler,
  normalizePersonalProfileImage,
  persistPersonalProfileImage,
  sendPersonalProfileImageError,
};
