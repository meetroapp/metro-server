"use strict";

const {
  ALLOWED_MEDIA_FORMATS,
  MAX_UPLOAD_SIZE_BYTES,
  MediaConfigurationError,
  MediaValidationError,
  createCloudinaryMedia,
  resolveCloudinaryConfiguration,
} = require("./cloudinary");
const { sendMediaError } = require("./uploadSignature");
const { rejectUnsupportedMedia } = require("./mediaReferencePolicy");

const BUSINESS_PORTFOLIO_PURPOSE = "business-portfolio";
const BUSINESS_PORTFOLIO_MAX_COUNT = 12;
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
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new MediaValidationError(code);
  }
  return number;
}

function parseStoredPortfolioMedia(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getPortfolioMediaUrl(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  return String(item.secure_url || item.legacy_url || "").trim();
}

function validateCloudinaryUrl(value, configuration, publicId, format) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MediaValidationError("MEDIA_URL_INVALID");
  }
  const decodedPath = decodeURIComponent(url.pathname);
  const expectedPrefix = `/${configuration.cloudName}/image/upload/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "res.cloudinary.com" ||
    !decodedPath.startsWith(expectedPrefix) ||
    !decodedPath.endsWith(`/${publicId}.${format}`)
  ) {
    throw new MediaValidationError("MEDIA_URL_INVALID");
  }
  return url.toString();
}

function normalizeBusinessPortfolioMedia(item, {
  env = process.env,
  contractorProfileId,
  displayOrder = 0,
} = {}) {
  const source = item && typeof item === "object" && !Array.isArray(item)
    ? item
    : {};
  if (source.purpose && source.purpose !== BUSINESS_PORTFOLIO_PURPOSE) {
    throw new MediaValidationError("MEDIA_PURPOSE_INVALID");
  }
  const media = source.media && typeof source.media === "object" && !Array.isArray(source.media)
    ? source.media
    : source;
  if (REQUIRED_METADATA_FIELDS.some((field) => media[field] === undefined || media[field] === null || media[field] === "")) {
    throw new MediaValidationError("MEDIA_METADATA_INVALID");
  }

  const configuration = resolveCloudinaryConfiguration(env);
  const ownerId = requirePositiveInteger(contractorProfileId, "MEDIA_OWNER_INVALID");
  const ownedPrefix = `${configuration.uploadFolder}/businesses/${ownerId}/portfolio/`;
  const publicId = String(media.public_id).trim();
  if (!publicId.startsWith(ownedPrefix)) {
    throw new MediaValidationError("MEDIA_ASSET_OWNERSHIP_INVALID");
  }

  const resourceType = String(media.resource_type).trim().toLowerCase();
  const format = String(media.format).trim().toLowerCase();
  if (resourceType !== "image" || !ALLOWED_MEDIA_FORMATS.includes(format)) {
    throw new MediaValidationError("MEDIA_FILE_TYPE_INVALID");
  }
  const bytes = requirePositiveInteger(media.bytes, "MEDIA_FILE_SIZE_INVALID");
  if (bytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new MediaValidationError("MEDIA_FILE_TOO_LARGE");
  }

  return Object.freeze({
    purpose: BUSINESS_PORTFOLIO_PURPOSE,
    public_id: publicId,
    secure_url: validateCloudinaryUrl(
      String(media.secure_url).trim(),
      configuration,
      publicId,
      format
    ),
    resource_type: "image",
    format,
    bytes,
    width: requirePositiveInteger(media.width),
    height: requirePositiveInteger(media.height),
    version: requirePositiveInteger(media.version),
    uploaded_at: String(media.uploaded_at || media.created_at || "").trim(),
    display_order: displayOrder,
    lifecycle_state: "attached",
  });
}

function normalizePortfolioCollection(payload, {
  env = process.env,
  contractorProfileId,
  existing = [],
  allowLegacy = false,
} = {}) {
  if (!Array.isArray(payload)) {
    throw new MediaValidationError("MEDIA_COLLECTION_INVALID");
  }
  if (payload.length > BUSINESS_PORTFOLIO_MAX_COUNT) {
    throw new MediaValidationError("MEDIA_COUNT_EXCEEDED");
  }

  const existingLegacy = new Set(
    parseStoredPortfolioMedia(existing)
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const seen = new Set();
  return payload.map((item, index) => {
    const legacyUrl = item && typeof item === "object" && !Array.isArray(item)
      ? String(item.legacy_url || "").trim()
      : "";
    if (legacyUrl) {
      if (!allowLegacy || !existingLegacy.has(legacyUrl) || seen.has(`legacy:${legacyUrl}`)) {
        throw new MediaValidationError("MEDIA_LEGACY_REFERENCE_INVALID");
      }
      seen.add(`legacy:${legacyUrl}`);
      return legacyUrl;
    }

    const normalized = normalizeBusinessPortfolioMedia(item, {
      env,
      contractorProfileId,
      displayOrder: index,
    });
    if (seen.has(normalized.public_id)) {
      throw new MediaValidationError("MEDIA_DUPLICATE_ASSET");
    }
    seen.add(normalized.public_id);
    return normalized;
  });
}

function serializePublicPortfolioProject(row = {}) {
  const urls = parseStoredPortfolioMedia(row.image_urls)
    .map(getPortfolioMediaUrl)
    .filter(Boolean);
  return {
    ...row,
    image_url: urls[0] || row.image_url || "",
    image_urls: urls,
  };
}

function serializeOwnedPortfolioProject(row = {}) {
  const stored = parseStoredPortfolioMedia(row.image_urls);
  return {
    ...serializePublicPortfolioProject(row),
    portfolio_media: stored.map((item, index) => {
      if (typeof item === "string") {
        return {
          legacy_url: item,
          secure_url: item,
          display_order: index,
          lifecycle_state: "legacy",
        };
      }
      return { ...item, display_order: index };
    }),
  };
}

async function safelyDeletePortfolioMedia(mediaService, publicId, contractorProfileId, code) {
  if (!publicId) return false;
  try {
    await mediaService.deleteOwnedAsset(publicId, {
      purpose: BUSINESS_PORTFOLIO_PURPOSE,
      ownership: { contractorProfileId },
      resourceType: "image",
    });
    return true;
  } catch {
    console.error("Business portfolio media cleanup failed", { code });
    return false;
  }
}

async function persistPortfolioProject({
  pool,
  userId,
  projectId,
  contractorId,
  title,
  description,
  portfolioMedia,
  env = process.env,
  mediaService = null,
} = {}) {
  let client;
  let transactionStarted = false;
  let ownerProfileId = null;
  let currentStored = [];
  let normalized = [];
  let currentPublicIds = new Set();

  try {
    client = typeof pool?.connect === "function" ? await pool.connect() : pool;
    if (!client || typeof client.query !== "function") {
      throw new TypeError("A database client is required");
    }
    await client.query("BEGIN");
    transactionStarted = true;

    if (projectId) {
      const current = await client.query(
        `
        SELECT contractor_projects.*
        FROM contractor_projects
        JOIN contractor_profiles
          ON contractor_profiles.id = contractor_projects.contractor_id
        WHERE contractor_projects.id = $1
          AND contractor_profiles.user_id = $2
        LIMIT 1
        FOR UPDATE OF contractor_projects
        `,
        [projectId, userId]
      );
      if (!current.rows[0]) throw new MediaValidationError("MEDIA_OWNER_INVALID");
      ownerProfileId = current.rows[0].contractor_id;
      currentStored = parseStoredPortfolioMedia(current.rows[0].image_urls);
    } else {
      const owner = await client.query(
        `
        SELECT id
        FROM contractor_profiles
        WHERE id = $1 AND user_id = $2
        LIMIT 1
        FOR UPDATE
        `,
        [contractorId, userId]
      );
      if (!owner.rows[0]) throw new MediaValidationError("MEDIA_OWNER_INVALID");
      ownerProfileId = owner.rows[0].id;
    }

    normalized = normalizePortfolioCollection(portfolioMedia, {
      env,
      contractorProfileId: ownerProfileId,
      existing: currentStored,
      allowLegacy: Boolean(projectId),
    });
    mediaService = mediaService || createCloudinaryMedia({ env });
    currentPublicIds = new Set(
      currentStored
        .filter((item) => item && typeof item === "object" && item.public_id)
        .map((item) => item.public_id)
    );
    const imageUrl = normalized.map(getPortfolioMediaUrl).find(Boolean) || "";
    let result;
    if (projectId) {
      result = await client.query(
        `
        UPDATE contractor_projects
        SET title = $1,
            description = $2,
            image_url = $3,
            image_urls = $4::jsonb
        WHERE id = $5 AND contractor_id = $6
        RETURNING *
        `,
        [title, description, imageUrl, JSON.stringify(normalized), projectId, ownerProfileId]
      );
    } else {
      result = await client.query(
        `
        INSERT INTO contractor_projects
          (contractor_id, title, description, image_url, image_urls)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING *
        `,
        [ownerProfileId, title, description, imageUrl, JSON.stringify(normalized)]
      );
    }
    if (!result.rows[0]) throw new MediaValidationError("MEDIA_OWNER_INVALID");

    await client.query("COMMIT");
    transactionStarted = false;

    const nextPublicIds = new Set(
      normalized
        .filter((item) => item && typeof item === "object" && item.public_id)
        .map((item) => item.public_id)
    );
    await Promise.all(
      [...currentPublicIds]
        .filter((publicId) => !nextPublicIds.has(publicId))
        .map((publicId) => safelyDeletePortfolioMedia(
          mediaService,
          publicId,
          ownerProfileId,
          "REMOVED_PORTFOLIO_MEDIA_DELETE_FAILED"
        ))
    );

    return serializeOwnedPortfolioProject(result.rows[0]);
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    await Promise.all(
      normalized
        .filter((item) => item && typeof item === "object" && item.public_id)
        .filter((item) => !currentPublicIds.has(item.public_id))
        .map((item) => safelyDeletePortfolioMedia(
          mediaService,
          item.public_id,
          ownerProfileId,
          "NEW_PORTFOLIO_MEDIA_CLEANUP_FAILED"
        ))
    );
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

function sendPortfolioError(res, error) {
  if (error instanceof MediaConfigurationError) {
    return res.status(503).json({
      success: false,
      code: "MEDIA_SERVICE_UNAVAILABLE",
      message: "Media uploads are temporarily unavailable.",
    });
  }
  if (error instanceof MediaValidationError) {
    const status = error.code === "MEDIA_OWNER_INVALID" ? 404 : 400;
    return res.status(status).json({
      success: false,
      code: error.code,
      message: "The portfolio project could not be saved.",
    });
  }
  console.error("Business portfolio persistence failed", {
    code: "BUSINESS_PORTFOLIO_PERSISTENCE_FAILED",
  });
  return res.status(500).json({
    success: false,
    code: "BUSINESS_PORTFOLIO_PERSISTENCE_FAILED",
    message: "The portfolio project could not be saved.",
  });
}

function createPortfolioProjectHandler({ getPool, env = process.env, update = false } = {}) {
  return async function portfolioProjectHandler(req, res) {
    try {
      if (rejectUnsupportedMedia(req, res, ["image_url", "image_urls"])) return;
      const project = await persistPortfolioProject({
        pool: getPool(req),
        userId: req.user.id,
        projectId: update ? req.params.id : null,
        contractorId: req.body.contractor_id,
        title: req.body.title,
        description: req.body.description,
        portfolioMedia: req.body.portfolio_media,
        env,
        mediaService: req.app?.locals?.cloudinaryMedia || null,
      });
      return res.json({
        success: true,
        code: update ? "BUSINESS_PORTFOLIO_UPDATED" : "BUSINESS_PORTFOLIO_CREATED",
        project,
      });
    } catch (error) {
      return sendPortfolioError(res, error);
    }
  };
}

function createPortfolioCleanupHandler({ getPool, env = process.env } = {}) {
  return async function portfolioCleanupHandler(req, res) {
    try {
      const owner = await getPool(req).query(
        `SELECT id FROM contractor_profiles WHERE user_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
        [req.user.id]
      );
      const contractorProfileId = owner.rows[0]?.id;
      if (!contractorProfileId) throw new MediaValidationError("MEDIA_OWNER_INVALID");
      const normalized = normalizeBusinessPortfolioMedia(req.body, {
        env,
        contractorProfileId,
      });
      const mediaService = req.app?.locals?.cloudinaryMedia || createCloudinaryMedia({ env });
      const cleaned = await safelyDeletePortfolioMedia(
        mediaService,
        normalized.public_id,
        contractorProfileId,
        "UNSAVED_PORTFOLIO_MEDIA_DELETE_FAILED"
      );
      if (!cleaned) {
        return res.status(503).json({
          success: false,
          code: "MEDIA_CLEANUP_UNAVAILABLE",
          message: "Media cleanup is temporarily unavailable.",
        });
      }
      return res.json({ success: true, code: "BUSINESS_PORTFOLIO_MEDIA_CLEANED" });
    } catch (error) {
      return sendMediaError(res, error);
    }
  };
}

module.exports = {
  BUSINESS_PORTFOLIO_MAX_COUNT,
  BUSINESS_PORTFOLIO_PURPOSE,
  createPortfolioCleanupHandler,
  createPortfolioProjectHandler,
  getPortfolioMediaUrl,
  normalizeBusinessPortfolioMedia,
  normalizePortfolioCollection,
  parseStoredPortfolioMedia,
  persistPortfolioProject,
  safelyDeletePortfolioMedia,
  serializeOwnedPortfolioProject,
  serializePublicPortfolioProject,
};
