"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-portfolio-media";

const {
  MediaValidationError,
} = require("../server/media/cloudinary");
const {
  normalizeBusinessPortfolioMedia,
  normalizePortfolioCollection,
  persistPortfolioProject,
  serializeOwnedPortfolioProject,
  serializePublicPortfolioProject,
} = require("../server/media/businessPortfolio");

const TEST_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro/production",
});

function media(index, overrides = {}) {
  return {
    secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v172000000${index}/meetro/production/businesses/91/portfolio/photo-${index}.png`,
    public_id: `meetro/production/businesses/91/portfolio/photo-${index}`,
    resource_type: "image",
    format: "png",
    bytes: 1000 + index,
    width: 640,
    height: 480,
    version: 1720000000 + index,
    uploaded_at: "2026-07-19T18:00:00.000Z",
    ...overrides,
  };
}

function payload(index, overrides = {}) {
  return {
    purpose: "business-portfolio",
    media: media(index, overrides),
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

function createPool({ currentProject = null, failWrite = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("SELECT id FROM contractor_profiles") && sql.includes("id = $1")) {
        return Number(values[0]) === 91 && Number(values[1]) === 7
          ? { rows: [{ id: 91 }] }
          : { rows: [] };
      }
      if (sql.includes("SELECT contractor_projects.*") && sql.includes("JOIN contractor_profiles")) {
        return currentProject && Number(values[1]) === 7
          ? { rows: [currentProject] }
          : { rows: [] };
      }
      if (sql.startsWith("INSERT INTO contractor_projects")) {
        if (failWrite) throw new Error("database unavailable private detail");
        return {
          rows: [{
            id: 501,
            contractor_id: values[0],
            title: values[1],
            description: values[2],
            image_url: values[3],
            image_urls: JSON.parse(values[4]),
          }],
        };
      }
      if (sql.startsWith("UPDATE contractor_projects")) {
        if (failWrite) throw new Error("database unavailable private detail");
        return {
          rows: [{
            ...currentProject,
            title: values[0],
            description: values[1],
            image_url: values[2],
            image_urls: JSON.parse(values[3]),
          }],
        };
      }
      throw new Error(`Unexpected portfolio media query: ${sql}`);
    },
  };
}

test("portfolio metadata validates purpose, owner folder, file type, size, and order", () => {
  const normalized = normalizePortfolioCollection([payload(2), payload(1)], {
    env: TEST_ENV,
    contractorProfileId: 91,
  });
  assert.deepEqual(normalized.map((item) => item.display_order), [0, 1]);
  assert.deepEqual(normalized.map((item) => item.public_id), [
    media(2).public_id,
    media(1).public_id,
  ]);

  for (const invalid of [
    payload(1, { public_id: "meetro/production/businesses/92/portfolio/photo-1" }),
    payload(1, { format: "gif" }),
    payload(1, { bytes: 11 * 1024 * 1024 }),
    { purpose: "business-logo", media: media(1) },
  ]) {
    assert.throws(
      () => normalizeBusinessPortfolioMedia(invalid, {
        env: TEST_ENV,
        contractorProfileId: 91,
      }),
      MediaValidationError
    );
  }
  assert.throws(
    () => normalizePortfolioCollection([payload(1), payload(1)], {
      env: TEST_ENV,
      contractorProfileId: 91,
    }),
    (error) => error.code === "MEDIA_DUPLICATE_ASSET"
  );
});

test("portfolio creation stores canonical ordered metadata and compatibility URLs", async () => {
  const pool = createPool();
  const result = await persistPortfolioProject({
    pool,
    userId: 7,
    contractorId: 91,
    title: "Kitchen refresh",
    description: "Cabinet and tile work",
    portfolioMedia: [payload(2), payload(1)],
    env: TEST_ENV,
    mediaService: createMediaService(),
  });
  assert.equal(result.image_url, media(2).secure_url);
  assert.deepEqual(result.image_urls, [media(2).secure_url, media(1).secure_url]);
  assert.deepEqual(result.portfolio_media.map((item) => item.display_order), [0, 1]);
});

test("portfolio update preserves order and deletes removed assets only after commit", async () => {
  const currentProject = {
    id: 501,
    contractor_id: 91,
    title: "Original",
    description: "Original",
    image_url: media(1).secure_url,
    image_urls: [
      normalizeBusinessPortfolioMedia(payload(1), { env: TEST_ENV, contractorProfileId: 91 }),
      normalizeBusinessPortfolioMedia(payload(2), { env: TEST_ENV, contractorProfileId: 91 }),
    ],
  };
  const mediaService = createMediaService();
  const result = await persistPortfolioProject({
    pool: createPool({ currentProject }),
    userId: 7,
    projectId: 501,
    title: "Reordered",
    description: "Updated",
    portfolioMedia: [payload(2), payload(3)],
    env: TEST_ENV,
    mediaService,
  });
  assert.deepEqual(result.image_urls, [media(2).secure_url, media(3).secure_url]);
  assert.deepEqual(mediaService.deletions.map((item) => item.publicId), [media(1).public_id]);
});

test("portfolio update remains committed when old asset cleanup is unavailable", async () => {
  const currentProject = {
    id: 501,
    contractor_id: 91,
    image_url: media(1).secure_url,
    image_urls: [
      normalizeBusinessPortfolioMedia(payload(1), { env: TEST_ENV, contractorProfileId: 91 }),
    ],
  };
  const result = await persistPortfolioProject({
    pool: createPool({ currentProject }),
    userId: 7,
    projectId: 501,
    title: "Committed",
    description: "Cleanup deferred",
    portfolioMedia: [payload(2)],
    env: TEST_ENV,
    mediaService: {
      async deleteOwnedAsset() {
        throw new Error("provider unavailable private detail");
      },
    },
  });
  assert.equal(result.title, "Committed");
  assert.deepEqual(result.image_urls, [media(2).secure_url]);
});

test("portfolio persistence failure rolls back and cleans only newly uploaded owned media", async () => {
  const mediaService = createMediaService();
  await assert.rejects(
    persistPortfolioProject({
      pool: createPool({ failWrite: true }),
      userId: 7,
      contractorId: 91,
      title: "Failure",
      description: "Failure",
      portfolioMedia: [payload(1), payload(2)],
      env: TEST_ENV,
      mediaService,
    })
  );
  assert.deepEqual(
    mediaService.deletions.map((item) => item.publicId),
    [media(1).public_id, media(2).public_id]
  );
});

test("cross-user project updates fail before mutation", async () => {
  const pool = createPool({ currentProject: null });
  await assert.rejects(
    persistPortfolioProject({
      pool,
      userId: 8,
      projectId: 501,
      title: "Unauthorized",
      description: "Unauthorized",
      portfolioMedia: [payload(1)],
      env: TEST_ENV,
      mediaService: createMediaService(),
    }),
    (error) => error.code === "MEDIA_OWNER_INVALID"
  );
  assert.equal(pool.calls.some((call) => call.sql.startsWith("UPDATE contractor_projects")), false);
});

test("public portfolio serialization exposes URLs while owner serialization restores metadata", () => {
  const row = {
    id: 501,
    image_url: media(1).secure_url,
    image_urls: [
      normalizeBusinessPortfolioMedia(payload(1), { env: TEST_ENV, contractorProfileId: 91 }),
      "https://legacy.example.test/project.jpg",
    ],
  };
  const publicProject = serializePublicPortfolioProject(row);
  assert.deepEqual(publicProject.image_urls, [
    media(1).secure_url,
    "https://legacy.example.test/project.jpg",
  ]);
  assert.doesNotMatch(JSON.stringify(publicProject), /public_id/);
  const ownedProject = serializeOwnedPortfolioProject(row);
  assert.equal(ownedProject.portfolio_media[0].public_id, media(1).public_id);
  assert.equal(ownedProject.portfolio_media[1].lifecycle_state, "legacy");
});
