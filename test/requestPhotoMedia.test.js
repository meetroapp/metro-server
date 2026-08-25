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

function requestBody(overrides = {}) {
  return {
    title: "Leaking window",
    description: "Water around the sill",
    category: "handyman",
    request_category: "handyman",
    service_domain: "home_services",
    service_specialty: "handyman",
    location: "Cape Coral",
    location_intake_mode: "exact_on_file",
    service_address_line1: "123 Palm Ave",
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    ...overrides,
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
  const idempotency = [];
  const user = {
    id: 7,
    email: "owner@example.test",
    role: "homeowner",
    account_type: "homeowner",
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
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("request_service_authority:authenticated_account")) {
        return { rows: Number(values[0]) === user.id ? [user] : [] };
      }
      if (sql.includes("job_request_create:idempotency_reserve")) {
        const [id, actorUserId, commandName, commandScope, key, fingerprint] = values;
        const row = {
          id,
          actor_user_id: actorUserId,
          command_name: commandName,
          command_scope: commandScope,
          idempotency_key: key,
          request_fingerprint: fingerprint,
          post_id: null,
          completed_at: null,
        };
        idempotency.push(row);
        return { rows: [row] };
      }
      if (sql.includes("job_request_create:idempotency_complete")) {
        const row = idempotency.find((item) => item.id === values[0]);
        row.post_id = values[1];
        row.result_classification = values[2];
        row.result_reference = JSON.parse(values[3]);
        row.completed_at = "2026-08-07T12:00:00.000Z";
        return { rows: [row] };
      }
      if (sql.includes("job_request_create:insert_post") || sql.startsWith("INSERT INTO posts")) {
        if (failInsert) throw new Error("database unavailable test detail");
        return {
          rows: [{
            id: 301,
            user_id: user.id,
            title: values[1],
            description: values[2],
            category: values[3],
            request_category: values[4],
            service_domain: values[5],
            service_specialty: values[6],
            location: values[7],
            unit_number: values[8],
            access_notes: values[9],
            status: "open",
            image_url: values[10],
            request_photos: JSON.parse(values[11]),
            location_intake_mode: values[12],
            location_normalization_status: values[13],
            service_address_line1: values[14],
            service_city: values[15],
            service_region: values[16],
            service_postal_code: values[17],
            service_country_code: values[18],
            discovery_area_label: values[19],
            created_at: "2026-07-19T18:00:00.000Z",
            updated_at: "2026-07-19T18:00:00.000Z",
          }],
        };
      }
      throw new Error(`Unexpected request photo query: ${sql}`);
    },
  };
}

function canonicalPhoto(index = 1, overrides = {}) {
  return normalizeRequestPhoto(payload(index, overrides), {
    env: TEST_ENV,
    userId: 7,
  });
}

function createUpdatePool({
  existingPhotos = [canonicalPhoto(1), canonicalPhoto(2)],
  found = true,
  failUpdate = false,
} = {}) {
  const calls = [];
  const user = {
    id: 7,
    email: "owner@example.test",
    role: "user",
    token_version: 0,
  };
  const baseRow = {
    id: 301,
    user_id: user.id,
    title: "Leaking window",
    description: "Water around the sill",
    category: "handyman",
    request_category: "handyman",
    service_domain: "home_services",
    service_specialty: "handyman",
    location: "Cape Coral",
    unit_number: "",
    access_notes: "",
    status: "open",
    image_url: existingPhotos[0]?.secure_url || null,
    request_photos: existingPhotos,
    created_at: "2026-07-19T18:00:00.000Z",
    updated_at: "2026-07-19T18:00:00.000Z",
    cancelled_at: null,
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
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.startsWith("SELECT id, title") && sql.includes("FOR UPDATE")) {
        return { rows: found && Number(values[1]) === user.id ? [baseRow] : [] };
      }
      if (sql.startsWith("UPDATE posts")) {
        if (failUpdate) throw new Error("request update failed");
        const replacesPhotos = values[6] === true;
        const requestPhotos = replacesPhotos
          ? JSON.parse(values[7])
          : existingPhotos;
        return {
          rows: [{
            ...baseRow,
            title: values[0] ? values[1] : baseRow.title,
            description: values[2] ? values[3] : baseRow.description,
            location: values[4] ? values[5] : baseRow.location,
            request_photos: requestPhotos,
            image_url: replacesPhotos ? values[8] : baseRow.image_url,
            updated_at: "2026-07-19T19:00:00.000Z",
          }],
        };
      }
      throw new Error(`Unexpected request photo update query: ${sql}`);
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
    headers: new Map(),
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
  };
}

async function invoke(method, path, { pool = createPool(), body, mediaService = createMediaService(), token, params = {}, headers = {} } = {}) {
  app.locals.pool = pool;
  app.locals.cloudinaryMedia = mediaService;
  const req = {
    app,
    body: body || {},
    params,
    headers: {
      authorization: token || `Bearer ${createToken(pool.user)}`,
      ...headers,
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
    headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" },
    body: requestBody({
      request_photos: [payload(1), payload(2)],
    }),
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.post.image_url, media(1).secure_url);
  assert.deepEqual(
    res.body.post.request_photos.map((item) => item.display_order),
    [0, 1]
  );
  const insert = pool.calls.find((call) => call.sql.includes("job_request_create:insert_post"));
  assert.equal(JSON.parse(insert.values[11])[1].public_id, media(2).public_id);
});

test("foreign request photos and arbitrary URLs are rejected before persistence", async () => {
  const foreign = await invoke("post", "/posts", {
    headers: { "idempotency-key": "22222222-2222-4222-8222-222222222222" },
    body: requestBody({
      request_photos: [payload(1, {
        public_id: "meetro/production/users/8/request-photos/photo-1",
      })],
    }),
  });
  assert.equal(foreign.res.statusCode, 400);
  assert.equal(foreign.pool.calls.some((call) => call.sql.startsWith("INSERT INTO posts")), false);

  const arbitrary = await invoke("post", "/posts", {
    headers: { "idempotency-key": "33333333-3333-4333-8333-333333333333" },
    body: requestBody({
      image_url: "https://example.test/unsafe.jpg",
    }),
  });
  assert.equal(arbitrary.res.statusCode, 400);
  assert.equal(arbitrary.res.body.code, "GOVERNED_MEDIA_REFERENCE_REQUIRED");
});

test("post persistence failure cleans uploaded request photos", async () => {
  const mediaService = createMediaService();
  const { res } = await invoke("post", "/posts", {
    pool: createPool({ failInsert: true }),
    mediaService,
    headers: { "idempotency-key": "44444444-4444-4444-8444-444444444444" },
    body: requestBody({
      request_photos: [payload(1), payload(2)],
    }),
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

test("request-photo update omission preserves existing collection exactly", async () => {
  const existingPhotos = [canonicalPhoto(1), canonicalPhoto(2)];
  const pool = createUpdatePool({ existingPhotos });
  const mediaService = createMediaService();
  const { res } = await invoke("put", "/posts/:id", {
    pool,
    mediaService,
    params: { id: "301" },
    body: { title: "Updated leaking window" },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.post.request_photos, existingPhotos);
  assert.equal(mediaService.deletions.length, 0);
  const update = pool.calls.find((call) => call.sql.startsWith("UPDATE posts"));
  assert.equal(update.values[6], false);
});

test("request-photo update replaces, reorders, and returns canonical order", async () => {
  const pool = createUpdatePool();
  const { res, pool: usedPool } = await invoke("put", "/posts/:id", {
    pool,
    params: { id: "301" },
    body: {
      request_photos: [payload(2), payload(1)],
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.post.request_photos.map((item) => item.public_id),
    [media(2).public_id, media(1).public_id]
  );
  assert.deepEqual(
    res.body.post.request_photos.map((item) => item.display_order),
    [0, 1]
  );
  assert.equal(res.body.post.image_url, media(2).secure_url);
  const update = usedPool.calls.find((call) => call.sql.startsWith("UPDATE posts"));
  assert.equal(update.values[6], true);
  assert.equal(JSON.parse(update.values[7])[0].public_id, media(2).public_id);
});

test("request-photo update clears all photos and deletes removed media after persistence", async () => {
  const existingPhotos = [canonicalPhoto(1), canonicalPhoto(2)];
  const pool = createUpdatePool({ existingPhotos });
  const mediaService = createMediaService();
  const { res } = await invoke("put", "/posts/:id", {
    pool,
    mediaService,
    params: { id: "301" },
    body: { request_photos: [] },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.post.request_photos, []);
  assert.equal(res.body.post.image_url, "");
  assert.deepEqual(
    mediaService.deletions.map((item) => item.publicId),
    [media(1).public_id, media(2).public_id]
  );
  const updateIndex = pool.calls.findIndex((call) => call.sql.startsWith("UPDATE posts"));
  const commitIndex = pool.calls.findIndex((call) => call.sql === "COMMIT");
  assert.ok(updateIndex >= 0);
  assert.ok(commitIndex > updateIndex);
});

test("request-photo update rejects malformed duplicate excessive and foreign media", async () => {
  const excessive = await invoke("put", "/posts/:id", {
    pool: createUpdatePool(),
    params: { id: "301" },
    body: {
      request_photos: Array.from(
        { length: REQUEST_PHOTO_MAX_COUNT + 1 },
        (_, index) => payload(index + 1)
      ),
    },
  });
  assert.equal(excessive.res.statusCode, 400);

  const duplicate = await invoke("put", "/posts/:id", {
    pool: createUpdatePool(),
    params: { id: "301" },
    body: { request_photos: [payload(1), payload(1)] },
  });
  assert.equal(duplicate.res.statusCode, 400);

  const foreign = await invoke("put", "/posts/:id", {
    pool: createUpdatePool(),
    params: { id: "301" },
    body: {
      request_photos: [payload(1, {
        public_id: "meetro/production/users/8/request-photos/photo-1",
      })],
    },
  });
  assert.equal(foreign.res.statusCode, 400);

  const invalid = await invoke("put", "/posts/:id", {
    pool: createUpdatePool(),
    params: { id: "301" },
    body: {
      request_photos: [payload(1, { bytes: 0 })],
    },
  });
  assert.equal(invalid.res.statusCode, 400);
});

test("request-photo update rejects cross-owner or non-open requests before persistence", async () => {
  const pool = createUpdatePool({ found: false });
  const { res } = await invoke("put", "/posts/:id", {
    pool,
    params: { id: "301" },
    body: { request_photos: [payload(1)] },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "REQUEST_NOT_FOUND");
  assert.equal(
    pool.calls.some((call) => call.sql.startsWith("UPDATE posts")),
    false
  );
});

test("request-photo update persistence failure does not delete retained existing media", async () => {
  const pool = createUpdatePool({ failUpdate: true });
  const mediaService = createMediaService();
  const { res } = await invoke("put", "/posts/:id", {
    pool,
    mediaService,
    params: { id: "301" },
    body: { request_photos: [payload(1), payload(3)] },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(mediaService.deletions.length, 0);
  assert.equal(pool.calls.some((call) => call.sql === "ROLLBACK"), true);
});

test("request-photo removed-media cleanup failure does not reverse canonical persistence", async () => {
  const pool = createUpdatePool();
  const mediaService = {
    deletions: [],
    async deleteOwnedAsset(publicId) {
      this.deletions.push(publicId);
      throw new Error("cleanup unavailable");
    },
  };
  const { res } = await invoke("put", "/posts/:id", {
    pool,
    mediaService,
    params: { id: "301" },
    body: { request_photos: [payload(1)] },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, "REQUEST_UPDATED");
  assert.deepEqual(res.body.post.request_photos.map((item) => item.public_id), [
    media(1).public_id,
  ]);
  assert.deepEqual(mediaService.deletions, [media(2).public_id]);
});
