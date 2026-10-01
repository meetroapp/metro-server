"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-profile-image-tests";
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
  DEFAULT_PROFILE_PHOTO_DISPLAY,
  normalizePersonalProfileDisplay,
  normalizePersonalProfileImage,
  persistPersonalProfileDisplay,
  persistPersonalProfileImage,
  projectPersonalProfileDisplay,
} = require("../server/profile/personalProfileImage");

const TEST_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro/production",
});

function validMedia(overrides = {}) {
  return {
    secure_url:
      "https://res.cloudinary.com/test-cloud/image/upload/v1720000000/meetro/production/users/7/profile/avatar.jpg",
    public_id: "meetro/production/users/7/profile/avatar",
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
    purpose: "personal_profile",
    media: validMedia(overrides),
  };
}

function validDisplay(overrides = {}) {
  return {
    version: 1,
    focus_x: 0.5,
    focus_y: 0.5,
    zoom: 1,
    ...overrides,
  };
}

function validDisplayPayload(overrides = {}) {
  return {
    purpose: "personal_profile",
    display: validDisplay(overrides),
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

function createPool({ oldMedia = null, failUpdate = false } = {}) {
  const calls = [];
  const user = {
    id: 7,
    username: "Media Owner",
    email: "owner@example.test",
    role: "homeowner",
    account_type: "homeowner",
    business_name: "",
    business_category: "",
    profile_photo_url: oldMedia?.secure_url || "",
    profile_photo_details: oldMedia || {},
    token_version: 0,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const pool = {
    calls,
    user,
    async connect() { return this; },
    release() {},
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT id, email, role, token_version FROM users")) {
        return { rows: Number(values[0]) === user.id ? [user] : [] };
      }
      if (sql.startsWith("SELECT profile_photo_details FROM users")) {
        return {
          rows:
            Number(values[0]) === user.id
              ? [{ profile_photo_details: user.profile_photo_details }]
              : [],
        };
      }

      if (sql.startsWith("SELECT profile_photo_url, profile_photo_details FROM users")) {
        return {
          rows:
            Number(values[0]) === user.id
              ? [{
                  profile_photo_url: user.profile_photo_url,
                  profile_photo_details: user.profile_photo_details,
                }]
              : [],
        };
      }
      if (sql.startsWith("UPDATE users SET profile_photo_url")) {
        if (failUpdate) throw new Error("database unavailable test detail");
        user.profile_photo_url = values[0];
        user.profile_photo_details = JSON.parse(values[1]);
        return { rows: [{ ...user }] };
      }

      if (sql.startsWith("UPDATE users SET profile_photo_details")) {
        if (failUpdate) throw new Error("database unavailable test detail");
        user.profile_photo_details = JSON.parse(values[0]);
        return { rows: [{ ...user }] };
      }

      if (
        sql.includes("SELECT users.id, users.username") &&
        sql.includes("users.profile_photo_details")
      ) {
        return {
          rows: [{
            ...user,
            contractor_profile_id: null,
            has_business_profile: false,
          }],
        };
      }
      throw new Error(`Unexpected profile image query: ${sql}`);
    },
  };
  return pool;
}

function getHandlers(
  pathName = "/auth/profile-photo",
  method = "put"
) {
  const layer = app.router.stack.find(
    (item) =>
      item.route?.path === pathName &&
      item.route.methods[method]
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

async function invoke({
  pool,
  token,
  body,
  mediaService,
  pathName = "/auth/profile-photo",
  method = "put",
} = {}) {
  app.locals.pool = pool;
  app.locals.cloudinaryMedia = mediaService || createMediaService();
  const req = {
    app,
    body: body || {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const res = createResponse();
  try {
    for (const handler of getHandlers(pathName, method)) {
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

test("personal profile image persistence requires authentication", async () => {
  const result = await invoke({ pool: createPool(), body: validPayload() });
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "AUTHENTICATION_REQUIRED");
});

test("personal profile image metadata enforces Cloudinary ownership and media constraints", () => {
  const invalid = [
    validPayload({ public_id: "meetro/production/users/8/profile/avatar" }),
    validPayload({ secure_url: "https://example.com/avatar.jpg" }),
    validPayload({ resource_type: "raw" }),
    validPayload({ format: "gif", secure_url: "https://res.cloudinary.com/test-cloud/image/upload/v1/meetro/production/users/7/profile/avatar.gif" }),
    validPayload({ bytes: MAX_UPLOAD_SIZE_BYTES + 1 }),
    { purpose: "personal_profile", media: { public_id: "missing-fields" } },
  ];
  for (const payload of invalid) {
    assert.throws(
      () => normalizePersonalProfileImage(payload, { env: TEST_ENV, userId: 7 }),
      MediaValidationError
    );
  }
});

test("authenticated persistence stores canonical metadata and compatibility URL", async () => {
  const pool = createPool();
  const mediaService = createMediaService();
  const result = await invoke({
    pool,
    token: createToken(pool.user),
    body: validPayload(),
    mediaService,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.code, "PROFILE_IMAGE_UPDATED");
  assert.equal(result.body.user.profile_photo_url, validMedia().secure_url);
  assert.equal(pool.user.profile_photo_details.public_id, validMedia().public_id);
  assert.deepEqual(
    pool.user.profile_photo_details.display,
    DEFAULT_PROFILE_PHOTO_DISPLAY
  );
  assert.deepEqual(
    result.body.user.profile_photo_display,
    DEFAULT_PROFILE_PHOTO_DISPLAY
  );
  assert.equal(mediaService.deletions.length, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /test-api-secret/);
});

test("replacement persists before deleting the old owned asset", async () => {
  const oldMedia = validMedia({
    secure_url: "https://res.cloudinary.com/test-cloud/image/upload/v1710000000/meetro/production/users/7/profile/old.jpg",
    public_id: "meetro/production/users/7/profile/old",
    version: 1710000000,
  });
  const pool = createPool({ oldMedia });
  const mediaService = createMediaService();
  const result = await persistPersonalProfileImage({
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

test("persistence failure rolls back and cleans the newly uploaded orphan", async () => {
  const pool = createPool({ failUpdate: true });
  const mediaService = createMediaService();
  await assert.rejects(
    persistPersonalProfileImage({
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

test("database connection failure also cleans the newly uploaded orphan", async () => {
  const mediaService = createMediaService();
  await assert.rejects(
    persistPersonalProfileImage({
      pool: { async connect() { throw new Error("connection failed"); } },
      userId: 7,
      payload: validPayload(),
      env: TEST_ENV,
      mediaService,
    })
  );
  assert.equal(mediaService.deletions[0].publicId, validMedia().public_id);
});

test("cleanup failures are normalized without logging secrets", async () => {
  const pool = createPool({ failUpdate: true });
  const logs = [];
  const originalError = console.error;
  console.error = (...values) => logs.push(values);
  try {
    await assert.rejects(
      persistPersonalProfileImage({
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


test("personal profile display normalization is strict and bounded", () => {
  assert.deepEqual(
    normalizePersonalProfileDisplay(validDisplayPayload()),
    DEFAULT_PROFILE_PHOTO_DISPLAY
  );

  assert.deepEqual(
    normalizePersonalProfileDisplay(
      validDisplayPayload({
        focus_x: 0,
        focus_y: 1,
        zoom: 4,
      })
    ),
    {
      version: 1,
      focus_x: 0,
      focus_y: 1,
      zoom: 4,
    }
  );

  const invalid = [
    {},
    { purpose: "other", display: validDisplay() },
    validDisplayPayload({ version: 2 }),
    validDisplayPayload({ focus_x: -0.01 }),
    validDisplayPayload({ focus_x: 1.01 }),
    validDisplayPayload({ focus_y: -0.01 }),
    validDisplayPayload({ focus_y: 1.01 }),
    validDisplayPayload({ zoom: 0.99 }),
    validDisplayPayload({ zoom: 4.01 }),
    validDisplayPayload({ zoom: "2" }),
    {
      purpose: "personal_profile",
      display: {
        ...validDisplay(),
        extra: true,
      },
    },
  ];

  for (const payload of invalid) {
    assert.throws(
      () => normalizePersonalProfileDisplay(payload),
      MediaValidationError
    );
  }
});

test("stored personal profile display projects safe defaults for legacy or malformed state", () => {
  assert.deepEqual(
    projectPersonalProfileDisplay({}),
    DEFAULT_PROFILE_PHOTO_DISPLAY
  );

  assert.deepEqual(
    projectPersonalProfileDisplay({
      public_id: "owned",
      display: {
        version: 1,
        focus_x: 0.2,
        focus_y: 0.8,
        zoom: 2.25,
      },
    }),
    {
      version: 1,
      focus_x: 0.2,
      focus_y: 0.8,
      zoom: 2.25,
    }
  );

  assert.deepEqual(
    projectPersonalProfileDisplay({
      display: {
        version: 1,
        focus_x: 99,
        focus_y: 0.5,
        zoom: 1,
      },
    }),
    DEFAULT_PROFILE_PHOTO_DISPLAY
  );
});

test("personal profile display persistence preserves exact media authority", async () => {
  const oldMedia = validMedia({
    display: {
      version: 1,
      focus_x: 0.5,
      focus_y: 0.5,
      zoom: 1,
    },
  });

  const pool = createPool({ oldMedia });

  const beforeUrl = pool.user.profile_photo_url;
  const beforePublicId = pool.user.profile_photo_details.public_id;

  const result = await persistPersonalProfileDisplay({
    pool,
    userId: pool.user.id,
    payload: validDisplayPayload({
      focus_x: 0.31,
      focus_y: 0.42,
      zoom: 1.75,
    }),
  });

  assert.equal(pool.user.profile_photo_url, beforeUrl);
  assert.equal(
    pool.user.profile_photo_details.public_id,
    beforePublicId
  );
  assert.deepEqual(
    pool.user.profile_photo_details.display,
    {
      version: 1,
      focus_x: 0.31,
      focus_y: 0.42,
      zoom: 1.75,
    }
  );
  assert.deepEqual(
    result.user.profile_photo_display,
    pool.user.profile_photo_details.display
  );
});

test("personal profile display route requires authentication and existing photo authority", async () => {
  const authenticatedPool = createPool({
    oldMedia: validMedia(),
  });

  const unauthenticated = await invoke({
    pool: authenticatedPool,
    body: validDisplayPayload(),
    pathName: "/auth/profile-photo/display",
    method: "patch",
  });

  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(
    unauthenticated.body.code,
    "AUTHENTICATION_REQUIRED"
  );

  const noPhotoPool = createPool();

  const missingPhoto = await invoke({
    pool: noPhotoPool,
    token: createToken(noPhotoPool.user),
    body: validDisplayPayload(),
    pathName: "/auth/profile-photo/display",
    method: "patch",
  });

  assert.equal(missingPhoto.statusCode, 409);
  assert.equal(
    missingPhoto.body.code,
    "PROFILE_IMAGE_REQUIRED"
  );
});

test("authenticated personal profile display route returns only safe display projection", async () => {
  const pool = createPool({
    oldMedia: validMedia(),
  });

  const result = await invoke({
    pool,
    token: createToken(pool.user),
    body: validDisplayPayload({
      focus_x: 0.28,
      focus_y: 0.34,
      zoom: 2,
    }),
    pathName: "/auth/profile-photo/display",
    method: "patch",
  });

  assert.equal(result.statusCode, 200);
  assert.equal(
    result.body.code,
    "PROFILE_DISPLAY_UPDATED"
  );

  assert.deepEqual(
    result.body.profile_photo_display,
    {
      version: 1,
      focus_x: 0.28,
      focus_y: 0.34,
      zoom: 2,
    }
  );

  assert.deepEqual(
    result.body.user.profile_photo_display,
    result.body.profile_photo_display
  );

  assert.equal(
    Object.hasOwn(
      result.body.user,
      "profile_photo_details"
    ),
    false
  );

  assert.doesNotMatch(
    JSON.stringify(result.body),
    /public_id/
  );
});

test("/auth/me safely projects display framing without exposing canonical media metadata", async () => {
  const pool = createPool({
    oldMedia: validMedia({
      display: {
        version: 1,
        focus_x: 0.4,
        focus_y: 0.2,
        zoom: 1.5,
      },
    }),
  });

  const result = await invoke({
    pool,
    token: createToken(pool.user),
    pathName: "/auth/me",
    method: "get",
  });

  assert.equal(result.statusCode, 200);

  assert.deepEqual(
    result.body.user.profile_photo_display,
    {
      version: 1,
      focus_x: 0.4,
      focus_y: 0.2,
      zoom: 1.5,
    }
  );

  assert.equal(
    Object.hasOwn(
      result.body.user,
      "profile_photo_details"
    ),
    false
  );

  assert.doesNotMatch(
    JSON.stringify(result.body),
    /public_id/
  );
});

test("profile image migration is additive and preserves the compatibility URL", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/202607190001_add_user_profile_photo_details.sql"),
    "utf8"
  );
  assert.match(sql, /ALTER TABLE users/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS profile_photo_details JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.doesNotMatch(sql, /DROP|TRUNCATE|DELETE|RENAME|profile_photo_url\s*=/i);
});
