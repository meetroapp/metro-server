"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-request-photo-tests";
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
  REQUEST_PHOTO_MAX_COUNT,
  normalizeRequestPhoto,
  normalizeRequestPhotoCollection,
} = require("../server/media/requestPhoto");

const TEST_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro/production",
});

function media(index = 1, overrides = {}) {
  return {
    secure_url:
      `https://res.cloudinary.com/test-cloud/image/upload/v172000000${index}/meetro/production/users/7/request-photos/photo-${index}.png`,
    public_id: `meetro/production/users/7/request-photos/photo-${index}`,
    resource_type: "image",
    format: "png",
    bytes: 1024 + index,
    width: 640,
    height: 480,
    version: 1720000000 + index,
    uploaded_at: "2026-07-19T18:00:00.000Z",
    ...overrides,
  };
}

function payload(index = 1, overrides = {}) {
  return {
    purpose: "request-photo",
    media: media(index, overrides),
  };
}

function createMediaService() {
  const deletions = [];
  return {
    deletions,
    createUploadSignature(body, ownership) {
      return {
        cloudName: "test-cloud",
        apiKey: "test-api-key",
        timestamp: 1720000000,
        signature: "signed",
        folder: `meetro/production/users/${ownership.userId}/request-photos`,
        allowedParameters: {
          maxFileSizeBytes: MAX_UPLOAD_SIZE_BYTES,
          allowedFormats: ["jpg", "jpeg", "png", "webp"],
        },
      };
    },
    async deleteOwnedAsset(publicId, options) {
      deletions.push({ publicId, options });
      return { result: "ok" };
    },
  };
}

function createPool({ failInsert = false } = {}) {
  const calls = [];
  const user = {
    id: 7,
    email: "owner@example.test",
    role: "user",
    token_version: 0,
  };
  return {
    calls,
    user,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql === "SELECT id, email, role, token_version FROM users WHERE id = $1") {
        return { rows: Number(values[0]) === user.id ? [user] : [] };
      }
      if (sql.startsWith("INSERT INTO posts")) {
        if (failInsert) throw new Error("database unavailable test detail");
        return {
          rows: [{
            id: 301,
            user_id: user.id,
            title: values[1],
            description: values[2],
            category: values[3],
            location: values[4],
            image_url: values[5],
            request_photos: JSON.parse(values[6]),
            created_at: "2026-07-19T18:00:00.000Z",
          }],
        };
      }
      throw new Error(`Unexpected request photo query: ${sql}`);
    },
  };
}

function getHandlers(method, path) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
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

async function invoke(method, path, { pool = createPool(), body, mediaService = createMediaService(), token } = {}) {
  app.locals.pool = pool;
  app.locals.cloudinaryMedia = mediaService;
  const req = {
    app,
    body: body || {},
    params: {},
    headers: {
      authorization: token || `Bearer ${createToken(pool.user)}`,
    },
    user: pool.user,
  };
  const res = createResponse();
  try {
    for (const handler of getHandlers(method, path)) {
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
    return { res, pool, mediaService };
  } finally {
    delete app.locals.pool;
    delete app.locals.cloudinaryMedia;
  }
}

test("request-photo metadata validates owned folder, format, size, and count", () => {
  const normalized = normalizeRequestPhoto(payload(1), {
    env: TEST_ENV,
    userId: 7,
  });
  assert.equal(normalized.purpose, "request-photo");
  assert.equal(normalized.created_by_user_id, 7);

  assert.throws(
    () => normalizeRequestPhoto(payload(1, {
      public_id: "meetro/production/users/8/request-photos/photo-1",
    }), { env: TEST_ENV, userId: 7 }),
    MediaValidationError
  );
  assert.throws(
    () => normalizeRequestPhoto(payload(1, {
      secure_url: "https://example.test/photo.png",
    }), { env: TEST_ENV, userId: 7 }),
    MediaValidationError
  );
  assert.throws(
    () => normalizeRequestPhoto(payload(1, {
      format: "gif",
      secure_url: "https://res.cloudinary.com/test-cloud/image/upload/v1/meetro/production/users/7/request-photos/photo-1.gif",
    }), { env: TEST_ENV, userId: 7 }),
    MediaValidationError
  );
  assert.throws(
    () => normalizeRequestPhotoCollection(
      Array.from({ length: REQUEST_PHOTO_MAX_COUNT + 1 }, (_, index) => payload(index + 1)),
      { env: TEST_ENV, userId: 7 }
    ),
    MediaValidationError
  );
});

test("request-photo signatures use the authenticated homeowner folder", async () => {
  const { res } = await invoke("post", "/media/upload-signature", {
    body: {
      purpose: "request-photo",
      fileName: "request.png",
      contentType: "image/png",
      fileSizeBytes: 1024,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.upload.folder, "meetro/production/users/7/request-photos");
  assert.doesNotMatch(JSON.stringify(res.body), /test-api-secret/);
});

test("owned request photos persist in order and derive compatibility image URL", async () => {
  const { res, pool } = await invoke("post", "/posts", {
    body: {
      title: "Leaking window",
      description: "Water around the sill",
      category: "handyman",
      location: "Cape Coral",
      request_photos: [payload(1), payload(2)],
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.post.image_url, media(1).secure_url);
  assert.deepEqual(
    res.body.post.request_photos.map((item) => item.display_order),
    [0, 1]
  );
  const insert = pool.calls.find((call) => call.sql.startsWith("INSERT INTO posts"));
  assert.equal(JSON.parse(insert.values[6])[1].public_id, media(2).public_id);
});

test("foreign request photos and arbitrary URLs are rejected before persistence", async () => {
  const foreign = await invoke("post", "/posts", {
    body: {
      title: "Leaking window",
      request_photos: [payload(1, {
        public_id: "meetro/production/users/8/request-photos/photo-1",
      })],
    },
  });
  assert.equal(foreign.res.statusCode, 400);
  assert.equal(foreign.pool.calls.some((call) => call.sql.startsWith("INSERT INTO posts")), false);

  const arbitrary = await invoke("post", "/posts", {
    body: {
      title: "Leaking window",
      image_url: "https://example.test/unsafe.jpg",
    },
  });
  assert.equal(arbitrary.res.statusCode, 400);
  assert.equal(arbitrary.res.body.code, "GOVERNED_MEDIA_REFERENCE_REQUIRED");
});

test("post persistence failure cleans uploaded request photos", async () => {
  const mediaService = createMediaService();
  const { res } = await invoke("post", "/posts", {
    pool: createPool({ failInsert: true }),
    mediaService,
    body: {
      title: "Leaking window",
      request_photos: [payload(1), payload(2)],
    },
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(
    mediaService.deletions.map((item) => item.publicId),
    [media(1).public_id, media(2).public_id]
  );
});

test("request-photo cleanup is authenticated and owner-scoped", async () => {
  const mediaService = createMediaService();
  const { res } = await invoke("post", "/media/request-photo/cleanup", {
    mediaService,
    body: payload(1),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, "REQUEST_PHOTO_CLEANED");
  assert.equal(mediaService.deletions[0].publicId, media(1).public_id);

  const foreign = await invoke("post", "/media/request-photo/cleanup", {
    body: payload(1, {
      public_id: "meetro/production/users/8/request-photos/photo-1",
    }),
  });
  assert.equal(foreign.res.statusCode, 400);
});
