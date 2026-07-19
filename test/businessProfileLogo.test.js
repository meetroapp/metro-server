"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-business-logo-tests";
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
process.env.CLOUDINARY_API_KEY = "test-api-key";
process.env.CLOUDINARY_API_SECRET = "test-api-secret";
process.env.CLOUDINARY_UPLOAD_FOLDER = "meetro/production";

const { app, createToken } = require("../index");
const {
  MAX_UPLOAD_SIZE_BYTES,
  MediaValidationError,
} = require("../server/media/cloudinary");
const {
  normalizeBusinessLogo,
  persistBusinessProfileLogo,
} = require("../server/profile/businessProfileLogo");

const TEST_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro/production",
});

function validMedia(overrides = {}) {
  return {
    secure_url:
      "https://res.cloudinary.com/test-cloud/image/upload/v1720000000/meetro/production/businesses/logos/91/logo.jpg",
    public_id: "meetro/production/businesses/logos/91/logo",
    resource_type: "image",
    format: "jpg",
    bytes: 2048,
    width: 640,
    height: 640,
    version: 1720000000,
    uploaded_at: "2026-07-19T12:00:00.000Z",
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    purpose: "business-logo",
    media: validMedia(overrides),
  };
}

function createMediaService() {
  const deletions = [];
  return {
    deletions,
    async deleteOwnedAsset(publicId, options) {
      deletions.push({ publicId, options });
      return { result: "ok" };
    },
  };
}

function createProfile({ oldMedia = null } = {}) {
  return {
    id: 91,
    user_id: 7,
    business_name: "Trusted Home Services",
    category: "Home Services",
    phone: "555-0100",
    location: "Orlando, FL",
    bio: "Repairs and maintenance.",
    image_url: oldMedia?.secure_url || "",
    profile_details: {
      service_area: "Greater Orlando",
      business_hours: "Monday-Friday 8-5",
      service_specialties: ["door_repair_replacement"],
      available_now: true,
      dispatch_ready: false,
      logo_media: oldMedia || undefined,
    },
    created_at: "2026-07-14T12:00:00.000Z",
  };
}

function createPool({ profile = createProfile(), failUpdate = false } = {}) {
  const calls = [];
  const user = {
    id: 7,
    email: "owner@example.test",
    role: "professional",
    token_version: 0,
  };
  return {
    calls,
    user,
    profile,
    async connect() { return this; },
    release() {},
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql === "SELECT id, email, role, token_version FROM users WHERE id = $1") {
        return { rows: Number(values[0]) === user.id ? [user] : [] };
      }
      if (sql.startsWith("SELECT * FROM contractor_profiles WHERE user_id = $1")) {
        return { rows: profile && Number(values[0]) === user.id ? [profile] : [] };
      }
      if (sql.startsWith("UPDATE contractor_profiles SET image_url")) {
        if (failUpdate) throw new Error("database unavailable test detail");
        if (!profile || Number(values[2]) !== profile.id || Number(values[3]) !== user.id) {
          return { rows: [] };
        }
        profile.image_url = values[0];
        profile.profile_details = JSON.parse(values[1]);
        return { rows: [{ ...profile }] };
      }
      throw new Error(`Unexpected business logo query: ${sql}`);
    },
  };
}

function getHandlers() {
  const layer = app.router.stack.find(
    (item) => item.route?.path === "/contractor-profile/logo" && item.route.methods.put
  );
  assert.ok(layer);
  return layer.route.stack.map((item) => item.handle);
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
  };
}

async function invoke({ pool, token, body, mediaService } = {}) {
  app.locals.pool = pool;
  app.locals.cloudinaryMedia = mediaService || createMediaService();
  const req = {
    app,
    body: body || {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const res = createResponse();
  try {
    for (const handler of getHandlers()) {
      if (res.finished) break;
      if (handler.length < 3) {
        await handler(req, res);
      } else {
        await new Promise((resolve, reject) => {
          const next = (error) => error ? reject(error) : resolve();
          Promise.resolve(handler(req, res, next)).then(() => {
            if (res.finished) resolve();
          }, reject);
        });
      }
    }
    return res;
  } finally {
    delete app.locals.pool;
    delete app.locals.cloudinaryMedia;
  }
}

test("business logo metadata persistence requires authentication", async () => {
  const result = await invoke({ pool: createPool(), body: validPayload() });
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "AUTHENTICATION_REQUIRED");
});

test("business logo metadata enforces owned Cloudinary folder and media constraints", () => {
  const invalid = [
    validPayload({ public_id: "meetro/production/businesses/logos/92/logo" }),
    validPayload({ secure_url: "https://example.com/logo.jpg" }),
    validPayload({ resource_type: "raw" }),
    validPayload({ format: "gif", secure_url: "https://res.cloudinary.com/test-cloud/image/upload/v1/meetro/production/businesses/logos/91/logo.gif" }),
    validPayload({ bytes: MAX_UPLOAD_SIZE_BYTES + 1 }),
    { purpose: "business_profile", media: validMedia() },
    { purpose: "business-logo", media: { public_id: "missing-fields" } },
  ];
  for (const payload of invalid) {
    assert.throws(
      () => normalizeBusinessLogo(payload, {
        env: TEST_ENV,
        contractorProfileId: 91,
      }),
      MediaValidationError
    );
  }
});

test("authenticated business logo persistence stores canonical metadata and URL", async () => {
  const pool = createPool();
  const mediaService = createMediaService();
  const result = await invoke({
    pool,
    token: createToken(pool.user),
    body: validPayload(),
    mediaService,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.code, "BUSINESS_LOGO_UPDATED");
  assert.equal(result.body.profile.image_url, validMedia().secure_url);
  assert.equal(pool.profile.profile_details.logo_media.public_id, validMedia().public_id);
  assert.equal(mediaService.deletions.length, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /test-api-secret/);
});

test("replacement persists before deleting the previous owned logo", async () => {
  const oldMedia = validMedia({
    secure_url:
      "https://res.cloudinary.com/test-cloud/image/upload/v1710000000/meetro/production/businesses/logos/91/old.jpg",
    public_id: "meetro/production/businesses/logos/91/old",
    version: 1710000000,
  });
  const pool = createPool({ profile: createProfile({ oldMedia }) });
  const mediaService = createMediaService();
  const result = await persistBusinessProfileLogo({
    pool,
    userId: 7,
    payload: validPayload(),
    env: TEST_ENV,
    mediaService,
  });
  assert.equal(result.media.public_id, validMedia().public_id);
  assert.equal(mediaService.deletions[0].publicId, oldMedia.public_id);
  assert.ok(
    pool.calls.findIndex((call) => call.sql === "COMMIT") <
      pool.calls.length
  );
});

test("persistence failure rolls back and cleans the newly uploaded business logo", async () => {
  const pool = createPool({ failUpdate: true });
  const mediaService = createMediaService();
  await assert.rejects(
    persistBusinessProfileLogo({
      pool,
      userId: 7,
      payload: validPayload(),
      env: TEST_ENV,
      mediaService,
    })
  );
  assert.equal(pool.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(mediaService.deletions[0].publicId, validMedia().public_id);
});

test("missing owned business profile rejects without claiming persistence", async () => {
  const pool = createPool({ profile: null });
  const result = await invoke({
    pool,
    token: createToken(pool.user),
    body: validPayload(),
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.code, "MEDIA_OWNER_INVALID");
});

test("business logo cleanup failures do not leak secrets", async () => {
  const pool = createPool({ failUpdate: true });
  const logs = [];
  const originalError = console.error;
  console.error = (...values) => logs.push(values);
  try {
    await assert.rejects(
      persistBusinessProfileLogo({
        pool,
        userId: 7,
        payload: validPayload(),
        env: TEST_ENV,
        mediaService: {
          async deleteOwnedAsset() { throw new Error("test-api-secret"); },
        },
      })
    );
    assert.doesNotMatch(JSON.stringify(logs), /test-api-secret/);
  } finally {
    console.error = originalError;
  }
});
