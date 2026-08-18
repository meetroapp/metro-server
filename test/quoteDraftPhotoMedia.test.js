"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  QUOTE_DRAFT_PHOTO_MAX_COUNT,
  QUOTE_DRAFT_PHOTO_PURPOSE,
  createQuoteDraftPhotoCleanupHandler,
  normalizeQuoteDraftPhoto,
  normalizeQuoteDraftPhotoCollection,
  safelyDeleteQuoteDraftPhoto,
} = require("../server/media/quoteDraftPhoto");

const ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro/production",
});

function media(index = 1, contractorProfileId = 91) {
  const publicId =
    `meetro/production/businesses/${contractorProfileId}/quote-drafts/photo-${index}`;

  return {
    secure_url:
      `https://res.cloudinary.com/test-cloud/image/upload/v172000000${index}/${publicId}.jpg`,
    public_id: publicId,
    resource_type: "image",
    format: "jpg",
    bytes: 2048,
    width: 1200,
    height: 900,
    version: 1720000000 + index,
    uploaded_at: "2026-08-18T10:00:00.000Z",
  };
}

function payload(index = 1, contractorProfileId = 91) {
  return {
    purpose: QUOTE_DRAFT_PHOTO_PURPOSE,
    media: media(index, contractorProfileId),
    display_order: index - 1,
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("quote-draft-photo metadata stays business-owned private and transient", () => {
  const normalized = normalizeQuoteDraftPhoto(payload(), {
    env: ENV,
    contractorProfileId: 91,
  });

  assert.equal(normalized.purpose, "quote-draft-photo");
  assert.equal(normalized.contractor_profile_id, 91);
  assert.equal(normalized.lifecycle_state, "draft_transient");
  assert.equal(normalized.customer_visible_by_default, false);
  assert.match(
    normalized.public_id,
    /^meetro\/production\/businesses\/91\/quote-drafts\//
  );
});

test("quote-draft-photo rejects foreign ownership and invalid purpose", () => {
  assert.throws(
    () =>
      normalizeQuoteDraftPhoto(payload(1, 99), {
        env: ENV,
        contractorProfileId: 91,
      }),
    (error) => error.code === "MEDIA_ASSET_OWNERSHIP_INVALID"
  );

  assert.throws(
    () =>
      normalizeQuoteDraftPhoto(
        { ...payload(), purpose: "request-photo" },
        {
          env: ENV,
          contractorProfileId: 91,
        }
      ),
    (error) => error.code === "MEDIA_PURPOSE_INVALID"
  );
});

test("quote-draft-photo collection enforces max count and unique assets", () => {
  assert.equal(
    normalizeQuoteDraftPhotoCollection(
      [payload(1), payload(2)],
      {
        env: ENV,
        contractorProfileId: 91,
      }
    ).length,
    2
  );

  assert.throws(
    () =>
      normalizeQuoteDraftPhotoCollection(
        Array.from(
          { length: QUOTE_DRAFT_PHOTO_MAX_COUNT + 1 },
          (_, index) => payload(index + 1)
        ),
        {
          env: ENV,
          contractorProfileId: 91,
        }
      ),
    (error) => error.code === "MEDIA_COUNT_EXCEEDED"
  );

  assert.throws(
    () =>
      normalizeQuoteDraftPhotoCollection(
        [payload(1), payload(1)],
        {
          env: ENV,
          contractorProfileId: 91,
        }
      ),
    (error) => error.code === "MEDIA_DUPLICATE_ASSET"
  );
});

test("quote-draft-photo deletion remains business-folder constrained", async () => {
  const calls = [];
  const mediaService = {
    async deleteOwnedAsset(publicId, options) {
      calls.push({ publicId, options });
      return { result: "ok" };
    },
  };

  const removed = await safelyDeleteQuoteDraftPhoto(
    mediaService,
    media().public_id,
    91
  );

  assert.equal(removed, true);
  assert.deepEqual(calls, [
    {
      publicId:
        "meetro/production/businesses/91/quote-drafts/photo-1",
      options: {
        purpose: "quote-draft-photo",
        ownership: { contractorProfileId: 91 },
        resourceType: "image",
      },
    },
  ]);
});

test("quote-draft-photo cleanup derives ownership from authenticated business", async () => {
  const deletes = [];

  const pool = {
    async query(sql, values) {
      assert.match(String(sql), /FROM contractor_profiles/);
      assert.deepEqual(values, [7]);
      return { rows: [{ id: 91 }] };
    },
  };

  const handler = createQuoteDraftPhotoCleanupHandler({
    getPool: () => pool,
    env: ENV,
  });

  const req = {
    user: { id: 7 },
    body: payload(),
    app: {
      locals: {
        cloudinaryMedia: {
          async deleteOwnedAsset(publicId, options) {
            deletes.push({ publicId, options });
            return { result: "ok" };
          },
        },
      },
    },
  };

  const res = response();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.code, "QUOTE_DRAFT_PHOTO_CLEANED");
  assert.equal(deletes.length, 1);
});

test("quote-draft-photo cleanup fails closed without business ownership", async () => {
  const handler = createQuoteDraftPhotoCleanupHandler({
    getPool: () => ({
      async query() {
        return { rows: [] };
      },
    }),
    env: ENV,
  });

  const req = {
    user: { id: 7 },
    body: payload(),
    app: { locals: {} },
  };

  const res = response();
  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "MEDIA_OWNER_INVALID");
});
