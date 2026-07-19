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
const { serializeOwnedBusinessProfile } = require("./businessProfile");
const { REQUIRED_METADATA_FIELDS } = require("./personalProfileImage");

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

function parseDetails(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseStoredMedia(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value.public_id ? value : null;
}

function validateCloudinaryUrl(secureUrl, configuration, publicId, format) {
  let url;
  try {
    url = new URL(secureUrl);
  } catch {
    throw new MediaValidationError("MEDIA_URL_INVALID");
  }
  const decodedPath = decodeURIComponent(url.pathname);
  const expectedPrefix = `/${configuration.cloudName}/image/upload/`;
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

function normalizeBusinessLogo(payload, {
  env = process.env,
  contractorProfileId,
} = {}) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  if (source.purpose !== "business-logo") {
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
    "business-logo",
    { contractorProfileId }
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

async function safelyDelete(mediaService, publicId, contractorProfileId, logCode) {
  if (!publicId) return;
  try {
    await mediaService.deleteOwnedAsset(publicId, {
      purpose: "business-logo",
      ownership: { contractorProfileId },
    });
  } catch {
    console.error("Business logo media cleanup failed", { code: logCode });
  }
}

async function persistBusinessProfileLogo({
  pool,
  userId,
  payload,
  env = process.env,
  mediaService = createCloudinaryMedia({ env }),
} = {}) {
  let client = null;
  let transactionStarted = false;
  let metadata = null;
  let contractorProfileId = null;
  let currentMedia = null;

  try {
    client = typeof pool?.connect === "function" ? await pool.connect() : pool;
    if (!client || typeof client.query !== "function") {
      throw new TypeError("A database client is required");
    }

    await client.query("BEGIN");
    transactionStarted = true;
    const current = await client.query(
      `
      SELECT *
      FROM contractor_profiles
      WHERE user_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE
      `,
      [userId]
    );
    const row = current.rows[0];
    if (!row) {
      throw new MediaValidationError("MEDIA_OWNER_INVALID");
    }

    contractorProfileId = row.id;
    const details = parseDetails(row.profile_details);
    currentMedia = parseStoredMedia(details.logo_media);
    metadata = normalizeBusinessLogo(payload, { env, contractorProfileId });
    const nextDetails = {
      ...details,
      logo_media: metadata,
    };

    const updated = await client.query(
      `
      UPDATE contractor_profiles
      SET image_url = $1,
          profile_details = $2::jsonb
      WHERE id = $3 AND user_id = $4
      RETURNING *
      `,
      [
        metadata.secure_url,
        JSON.stringify(nextDetails),
        contractorProfileId,
        userId,
      ]
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
        contractorProfileId,
        "OLD_BUSINESS_LOGO_DELETE_FAILED"
      );
    }

    return {
      profile: serializeOwnedBusinessProfile(updated.rows[0]),
      media: metadata,
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    if (metadata?.public_id && currentMedia?.public_id !== metadata.public_id) {
      await safelyDelete(
        mediaService,
        metadata.public_id,
        contractorProfileId,
        "NEW_BUSINESS_LOGO_CLEANUP_FAILED"
      );
    }
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

function sendBusinessProfileLogoError(res, error) {
  if (error instanceof MediaValidationError) {
    const status = error.code === "MEDIA_OWNER_INVALID" ? 404 : 400;
    return res.status(status).json({
      success: false,
      code: error.code,
      message: "The business logo could not be saved.",
    });
  }
  if (error instanceof MediaConfigurationError) {
    return res.status(503).json({
      success: false,
      code: "MEDIA_SERVICE_UNAVAILABLE",
      message: "Media uploads are temporarily unavailable.",
    });
  }
  console.error("Business logo persistence failed", {
    code: "BUSINESS_LOGO_PERSISTENCE_FAILED",
  });
  return res.status(500).json({
    success: false,
    code: "BUSINESS_LOGO_PERSISTENCE_FAILED",
    message: "The business logo could not be saved.",
  });
}

function createBusinessProfileLogoHandler({ getPool, env = process.env } = {}) {
  return async function businessProfileLogoHandler(req, res) {
    try {
      const result = await persistBusinessProfileLogo({
        pool: getPool(req),
        userId: req.user.id,
        payload: req.body,
        env,
        mediaService: req.app?.locals?.cloudinaryMedia || createCloudinaryMedia({ env }),
      });
      return res.json({
        success: true,
        code: "BUSINESS_LOGO_UPDATED",
        profile: result.profile,
      });
    } catch (error) {
      return sendBusinessProfileLogoError(res, error);
    }
  };
}

module.exports = {
  createBusinessProfileLogoHandler,
  normalizeBusinessLogo,
  persistBusinessProfileLogo,
  sendBusinessProfileLogoError,
};
