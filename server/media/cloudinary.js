"use strict";

const { v2: defaultCloudinary } = require("cloudinary");

const ALLOWED_MEDIA_PURPOSES = Object.freeze([
  "personal_profile",
  "business_profile",
  "business_cover",
]);
const ALLOWED_MEDIA_FORMATS = Object.freeze(["jpg", "jpeg", "png", "webp"]);
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const FORBIDDEN_CLIENT_FIELDS = Object.freeze([
  "apiSecret",
  "api_secret",
  "businessId",
  "contractorProfileId",
  "folder",
  "owner",
  "ownerId",
  "timestamp",
  "userId",
]);
const CONTENT_TYPE_FORMATS = Object.freeze({
  "image/jpeg": Object.freeze(["jpg", "jpeg"]),
  "image/png": Object.freeze(["png"]),
  "image/webp": Object.freeze(["webp"]),
});

class MediaConfigurationError extends Error {
  constructor(code = "MEDIA_CONFIGURATION_INVALID") {
    super(code);
    this.name = "MediaConfigurationError";
    this.code = code;
  }
}

class MediaValidationError extends Error {
  constructor(code = "MEDIA_UPLOAD_INVALID") {
    super(code);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

function requireConfigurationValue(env, key) {
  const value = String(env?.[key] || "").trim();
  if (!value) throw new MediaConfigurationError("MEDIA_CONFIGURATION_MISSING");
  return value;
}

function normalizeUploadFolder(value) {
  const folder = String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!folder || folder.includes("..") || !/^[a-zA-Z0-9/_-]+$/.test(folder)) {
    throw new MediaConfigurationError("MEDIA_UPLOAD_FOLDER_INVALID");
  }
  return folder;
}

function resolveCloudinaryConfiguration(env = process.env) {
  return Object.freeze({
    cloudName: requireConfigurationValue(env, "CLOUDINARY_CLOUD_NAME"),
    apiKey: requireConfigurationValue(env, "CLOUDINARY_API_KEY"),
    apiSecret: requireConfigurationValue(env, "CLOUDINARY_API_SECRET"),
    uploadFolder: normalizeUploadFolder(
      requireConfigurationValue(env, "CLOUDINARY_UPLOAD_FOLDER")
    ),
  });
}

function normalizeUploadMetadata(payload = {}) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};

  if (FORBIDDEN_CLIENT_FIELDS.some((field) => Object.hasOwn(source, field))) {
    throw new MediaValidationError("MEDIA_OWNERSHIP_FIELDS_FORBIDDEN");
  }

  const purpose = String(source.purpose || "").trim();
  if (!ALLOWED_MEDIA_PURPOSES.includes(purpose)) {
    throw new MediaValidationError("MEDIA_PURPOSE_INVALID");
  }

  const fileName = String(source.fileName || source.filename || "").trim();
  const extension = fileName.includes(".")
    ? fileName.split(".").pop().toLowerCase()
    : "";
  const contentType = String(source.contentType || source.fileType || "")
    .trim()
    .toLowerCase();
  const formatsForContentType = CONTENT_TYPE_FORMATS[contentType] || [];
  if (
    !ALLOWED_MEDIA_FORMATS.includes(extension) ||
    !formatsForContentType.includes(extension)
  ) {
    throw new MediaValidationError("MEDIA_FILE_TYPE_INVALID");
  }

  const fileSizeBytes = Number(source.fileSizeBytes ?? source.size);
  if (!Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) {
    throw new MediaValidationError("MEDIA_FILE_SIZE_INVALID");
  }
  if (fileSizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new MediaValidationError("MEDIA_FILE_TOO_LARGE");
  }

  return Object.freeze({
    purpose,
    fileName,
    contentType,
    extension,
    fileSizeBytes,
  });
}

function requirePositiveOwnerId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new MediaValidationError("MEDIA_OWNER_INVALID");
  }
  return id;
}

function buildOwnedMediaFolder(configuration, purpose, ownership = {}) {
  if (purpose === "personal_profile") {
    const userId = requirePositiveOwnerId(ownership.userId);
    return `${configuration.uploadFolder}/users/${userId}/profile`;
  }

  const contractorProfileId = requirePositiveOwnerId(ownership.contractorProfileId);
  const destination = purpose === "business_cover" ? "cover" : "profile";
  return `${configuration.uploadFolder}/businesses/${contractorProfileId}/${destination}`;
}

function createCloudinaryMedia({
  env = process.env,
  cloudinaryClient = defaultCloudinary,
  now = () => Date.now(),
} = {}) {
  const configuration = resolveCloudinaryConfiguration(env);
  if (
    typeof cloudinaryClient?.config !== "function" ||
    typeof cloudinaryClient?.utils?.api_sign_request !== "function" ||
    typeof cloudinaryClient?.uploader?.destroy !== "function"
  ) {
    throw new MediaConfigurationError("MEDIA_CLIENT_INVALID");
  }

  cloudinaryClient.config({
    cloud_name: configuration.cloudName,
    api_key: configuration.apiKey,
    api_secret: configuration.apiSecret,
    secure: true,
  });

  function createUploadSignature(payload = {}, ownership = {}) {
    const metadata = normalizeUploadMetadata(payload);
    const folder = buildOwnedMediaFolder(
      configuration,
      metadata.purpose,
      ownership
    );
    const timestamp = Math.floor(Number(now()) / 1000);
    if (!Number.isInteger(timestamp) || timestamp <= 0) {
      throw new MediaConfigurationError("MEDIA_TIMESTAMP_INVALID");
    }

    const signedParameters = Object.freeze({
      allowed_formats: ALLOWED_MEDIA_FORMATS.join(","),
      folder,
      timestamp,
    });
    const signature = cloudinaryClient.utils.api_sign_request(
      signedParameters,
      configuration.apiSecret
    );
    if (!signature) throw new MediaConfigurationError("MEDIA_SIGNATURE_FAILED");

    return Object.freeze({
      cloudName: configuration.cloudName,
      apiKey: configuration.apiKey,
      timestamp,
      signature,
      folder,
      allowedParameters: Object.freeze({
        resourceType: "image",
        allowedFormats: ALLOWED_MEDIA_FORMATS,
        maxFileSizeBytes: MAX_UPLOAD_SIZE_BYTES,
        signed: signedParameters,
      }),
    });
  }

  async function deleteOwnedAsset(publicId, options = {}) {
    const normalizedPublicId = String(publicId || "").trim();
    const ownedFolder = buildOwnedMediaFolder(
      configuration,
      options.purpose,
      options.ownership
    );
    if (!normalizedPublicId.startsWith(`${ownedFolder}/`)) {
      throw new MediaValidationError("MEDIA_ASSET_OWNERSHIP_INVALID");
    }
    return cloudinaryClient.uploader.destroy(normalizedPublicId, {
      invalidate: true,
      resource_type: options.resourceType || "image",
      type: "upload",
    });
  }

  return Object.freeze({ createUploadSignature, deleteOwnedAsset });
}

module.exports = {
  ALLOWED_MEDIA_FORMATS,
  ALLOWED_MEDIA_PURPOSES,
  FORBIDDEN_CLIENT_FIELDS,
  MAX_UPLOAD_SIZE_BYTES,
  MediaConfigurationError,
  MediaValidationError,
  buildOwnedMediaFolder,
  createCloudinaryMedia,
  normalizeUploadMetadata,
  resolveCloudinaryConfiguration,
};
