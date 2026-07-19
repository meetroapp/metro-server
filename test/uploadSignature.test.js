"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-media-signatures";

const { app, createToken } = require("../index");
const {
  MAX_UPLOAD_SIZE_BYTES,
  createCloudinaryMedia,
} = require("../server/media/cloudinary");

const CLOUDINARY_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro/production",
});

function createCloudinaryClient() {
  const signatures = [];
  return {
    signatures,
    config() {},
    utils: {
      api_sign_request(parameters) {
        signatures.push(parameters);
        return "generated-signature";
      },
    },
    uploader: { async destroy() { return { result: "ok" }; } },
  };
}

function createPool({ includeBusiness = true } = {}) {
  const user = {
    id: 7,
    email: "owner@example.test",
    role: "professional",
    token_version: 0,
  };
  const calls = [];
  return {
    user,
    calls,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql.includes("FROM users") && sql.includes("token_version")) {
        return { rows: Number(values[0]) === user.id ? [user] : [] };
      }
      if (sql.includes("FROM contractor_profiles") && sql.includes("WHERE user_id = $1")) {
        return { rows: includeBusiness ? [{ id: 91 }] : [] };
      }
      throw new Error(`Unexpected media query: ${sql}`);
    },
  };
}

function getHandlers() {
  const layer = app.router.stack.find(
    (item) => item.route?.path === "/media/upload-signature" && item.route.methods.post
  );
  assert.ok(layer, "POST /media/upload-signature must be registered");
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

async function invoke({ pool, token, body, cloudinaryMedia } = {}) {
  app.locals.pool = pool;
  if (cloudinaryMedia) app.locals.cloudinaryMedia = cloudinaryMedia;
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

function validBody(overrides = {}) {
  return {
    purpose: "personal_profile",
    fileName: "portrait.jpg",
    contentType: "image/jpeg",
    fileSizeBytes: 2048,
    ...overrides,
  };
}

function createMedia(client = createCloudinaryClient()) {
  return createCloudinaryMedia({
    env: CLOUDINARY_ENV,
    cloudinaryClient: client,
    now: () => 1_720_000_000_000,
  });
}

test("media foundation exposes signatures only and no upload endpoint", () => {
  const mediaRoutes = app.router.stack
    .filter((item) => String(item.route?.path || "").startsWith("/media/"))
    .map((item) => ({
      path: item.route.path,
      methods: Object.keys(item.route.methods).sort(),
    }));
  assert.deepEqual(mediaRoutes, [{
    path: "/media/upload-signature",
    methods: ["post"],
  }]);
});

test("upload signatures require a valid authenticated session", async () => {
  const result = await invoke({
    pool: createPool(),
    body: validBody(),
    cloudinaryMedia: createMedia(),
  });
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "AUTHENTICATION_REQUIRED");
});

test("personal profile signature derives its folder from authenticated identity", async () => {
  const pool = createPool();
  const result = await invoke({
    pool,
    token: createToken(pool.user),
    body: validBody(),
    cloudinaryMedia: createMedia(),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.upload.folder, "meetro/production/users/7/profile");
  assert.equal(result.body.upload.signature, "generated-signature");
  assert.equal(result.body.upload.cloudName, "test-cloud");
  assert.equal(result.body.upload.apiKey, "test-api-key");
  assert.equal(result.body.upload.allowedParameters.maxFileSizeBytes, MAX_UPLOAD_SIZE_BYTES);
  assert.doesNotMatch(JSON.stringify(result.body), /test-api-secret/);
});

test("business logo signatures use only the authenticated owner's contractor profile", async () => {
  const pool = createPool();
  const logo = await invoke({
    pool,
    token: createToken(pool.user),
    body: validBody({
      purpose: "business-logo",
      fileName: "logo.png",
      contentType: "image/png",
    }),
    cloudinaryMedia: createMedia(),
  });

  assert.equal(logo.body.upload.folder, "meetro/production/businesses/logos/91");
  assert.equal(
    pool.calls.filter((call) => call.sql.includes("FROM contractor_profiles")).length,
    1
  );
});

test("business cover and legacy business profile signatures are not enabled", async () => {
  const pool = createPool();
  const profile = await invoke({
    pool,
    token: createToken(pool.user),
    body: validBody({
      purpose: "business_profile",
      fileName: "logo.png",
      contentType: "image/png",
    }),
    cloudinaryMedia: createMedia(),
  });
  const cover = await invoke({
    pool,
    token: createToken(pool.user),
    body: validBody({
      purpose: "business_cover",
      fileName: "cover.webp",
      contentType: "image/webp",
    }),
    cloudinaryMedia: createMedia(),
  });

  assert.equal(profile.statusCode, 400);
  assert.equal(profile.body.code, "MEDIA_PURPOSE_NOT_ENABLED");
  assert.equal(cover.statusCode, 400);
  assert.equal(cover.body.code, "MEDIA_PURPOSE_NOT_ENABLED");
});

test("invalid purposes, formats, sizes, and ownership fields are rejected before signing", async () => {
  const pool = createPool();
  const client = createCloudinaryClient();
  const media = createMedia(client);
  const invalidBodies = [
    validBody({ purpose: "project_upload" }),
    validBody({ fileName: "vector.svg", contentType: "image/svg+xml" }),
    validBody({ fileSizeBytes: MAX_UPLOAD_SIZE_BYTES + 1 }),
    validBody({ folder: "client/chosen" }),
    validBody({ timestamp: 1 }),
    validBody({ contractorProfileId: 500 }),
  ];

  for (const body of invalidBodies) {
    const result = await invoke({
      pool,
      token: createToken(pool.user),
      body,
      cloudinaryMedia: media,
    });
    assert.equal(result.statusCode, 400);
  }
  assert.equal(client.signatures.length, 0);
});

test("missing business ownership and missing configuration fail closed", async () => {
  const pool = createPool({ includeBusiness: false });
  const noOwner = await invoke({
    pool,
    token: createToken(pool.user),
    body: validBody({ purpose: "business-logo" }),
    cloudinaryMedia: createMedia(),
  });
  assert.equal(noOwner.statusCode, 404);
  assert.equal(noOwner.body.code, "MEDIA_OWNER_INVALID");

  const missingConfiguration = await invoke({
    pool,
    token: createToken(pool.user),
    body: validBody(),
  });
  assert.equal(missingConfiguration.statusCode, 503);
  assert.equal(missingConfiguration.body.code, "MEDIA_SERVICE_UNAVAILABLE");
});

test("API secret is never returned or logged", async () => {
  const pool = createPool();
  const logs = [];
  const originalError = console.error;
  console.error = (...values) => logs.push(values);
  try {
    const result = await invoke({
      pool,
      token: createToken(pool.user),
      body: validBody(),
      cloudinaryMedia: createMedia(),
    });
    assert.equal(result.statusCode, 200);
    assert.doesNotMatch(JSON.stringify(result.body), /test-api-secret/);
    assert.doesNotMatch(JSON.stringify(logs), /test-api-secret/);

    const failure = await invoke({
      pool,
      token: createToken(pool.user),
      body: validBody(),
      cloudinaryMedia: {
        createUploadSignature() {
          throw new Error("test-api-secret");
        },
      },
    });
    assert.equal(failure.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(failure.body), /test-api-secret/);
    assert.doesNotMatch(JSON.stringify(logs), /test-api-secret/);
  } finally {
    console.error = originalError;
  }
});
