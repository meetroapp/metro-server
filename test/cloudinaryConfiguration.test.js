"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ALLOWED_MEDIA_FORMATS,
  MAX_UPLOAD_SIZE_BYTES,
  MediaConfigurationError,
  MediaValidationError,
  createCloudinaryMedia,
  normalizeUploadMetadata,
  resolveCloudinaryConfiguration,
} = require("../server/media/cloudinary");

const VALID_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro/production",
});

function createFakeCloudinary() {
  const calls = { config: [], signatures: [], destroys: [] };
  return {
    calls,
    config(value) { calls.config.push(value); },
    utils: {
      api_sign_request(parameters, secret) {
        calls.signatures.push({ parameters, secret });
        return "signed-upload-request";
      },
    },
    uploader: {
      async destroy(publicId, options) {
        calls.destroys.push({ publicId, options });
        return { result: "ok" };
      },
    },
  };
}

test("Cloudinary configuration requires every server-owned environment value", () => {
  for (const key of Object.keys(VALID_ENV)) {
    const env = { ...VALID_ENV };
    delete env[key];
    assert.throws(
      () => resolveCloudinaryConfiguration(env),
      (error) => error instanceof MediaConfigurationError &&
        error.code === "MEDIA_CONFIGURATION_MISSING"
    );
  }
  assert.throws(
    () => resolveCloudinaryConfiguration({
      ...VALID_ENV,
      CLOUDINARY_UPLOAD_FOLDER: "../untrusted",
    }),
    (error) => error.code === "MEDIA_UPLOAD_FOLDER_INVALID"
  );
});

test("Cloudinary initializes from environment without exposing its secret", () => {
  const client = createFakeCloudinary();
  const media = createCloudinaryMedia({
    env: VALID_ENV,
    cloudinaryClient: client,
    now: () => 1_720_000_000_000,
  });
  const upload = media.createUploadSignature({
    purpose: "personal_profile",
    fileName: "portrait.webp",
    contentType: "image/webp",
    fileSizeBytes: 1024,
  }, { userId: 42 });

  assert.equal(client.calls.config[0].api_secret, VALID_ENV.CLOUDINARY_API_SECRET);
  assert.equal(client.calls.signatures[0].secret, VALID_ENV.CLOUDINARY_API_SECRET);
  assert.equal(upload.folder, "meetro/production/users/42/profile");
  assert.equal(upload.signature, "signed-upload-request");
  assert.equal(upload.allowedParameters.maxFileSizeBytes, MAX_UPLOAD_SIZE_BYTES);
  assert.deepEqual(upload.allowedParameters.allowedFormats, ALLOWED_MEDIA_FORMATS);
  assert.doesNotMatch(JSON.stringify(upload), /test-api-secret/);
});

test("media metadata accepts only approved image formats and ten megabytes", () => {
  assert.equal(normalizeUploadMetadata({
    purpose: "business_cover",
    fileName: "cover.jpeg",
    contentType: "image/jpeg",
    fileSizeBytes: MAX_UPLOAD_SIZE_BYTES,
  }).extension, "jpeg");

  for (const [fileName, contentType] of [
    ["image.svg", "image/svg+xml"],
    ["animation.gif", "image/gif"],
    ["photo.heic", "image/heic"],
    ["program.exe", "application/octet-stream"],
    ["mismatch.png", "image/jpeg"],
  ]) {
    assert.throws(
      () => normalizeUploadMetadata({
        purpose: "personal_profile",
        fileName,
        contentType,
        fileSizeBytes: 100,
      }),
      (error) => error instanceof MediaValidationError &&
        error.code === "MEDIA_FILE_TYPE_INVALID"
    );
  }

  assert.throws(
    () => normalizeUploadMetadata({
      purpose: "personal_profile",
      fileName: "portrait.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: MAX_UPLOAD_SIZE_BYTES + 1,
    }),
    (error) => error.code === "MEDIA_FILE_TOO_LARGE"
  );
});

test("deletion helper remains server-only and owner-folder constrained", async () => {
  const client = createFakeCloudinary();
  const media = createCloudinaryMedia({ env: VALID_ENV, cloudinaryClient: client });
  const deletionOptions = {
    purpose: "personal_profile",
    ownership: { userId: 42 },
  };
  await media.deleteOwnedAsset(
    "meetro/production/users/42/profile/asset",
    deletionOptions
  );
  assert.equal(client.calls.destroys.length, 1);
  await assert.rejects(
    media.deleteOwnedAsset(
      "meetro/production/users/99/profile/asset",
      deletionOptions
    ),
    (error) => error.code === "MEDIA_ASSET_OWNERSHIP_INVALID"
  );
});
