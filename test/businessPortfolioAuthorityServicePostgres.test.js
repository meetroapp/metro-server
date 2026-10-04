"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");

const {
  PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
} = require("../server/portfolio/businessPortfolioContract");
const {
  adoptLegacyPortfolioProject,
  archivePortfolioProject,
  createPortfolioProject,
  listOwnedPortfolioProjects,
  listPublicPortfolioProjects,
  publishPortfolioProject,
  reorderPortfolioProjects,
  setPortfolioFeature,
  updatePortfolioProject,
} = require("../server/portfolio/businessPortfolioAuthorityService");
const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const databaseUrl = process.env.BUSINESS_PORTFOLIO_COMMAND_DATABASE_URL;
const migrationSql = readFileSync(
  join(
    __dirname,
    "..",
    "migrations",
    "202608120001_create_business_portfolio_authority_foundation.sql"
  ),
  "utf8"
);
const TEST_ENV = Object.freeze({
  CLOUDINARY_CLOUD_NAME: "demo",
  CLOUDINARY_API_KEY: "portfolio-test-key",
  CLOUDINARY_API_SECRET: "portfolio-test-secret",
  CLOUDINARY_UPLOAD_FOLDER: "meetro-test",
});
const PRIVACY_CONFIRMATION = Object.freeze({
  version: PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
  confirmed: true,
});

function governedMedia(contractorId, suffix, displayOrder = 0) {
  const publicId = `meetro-test/businesses/${contractorId}/portfolio/${suffix}`;
  return {
    purpose: "business-portfolio",
    public_id: publicId,
    secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.jpg`,
    resource_type: "image",
    format: "jpg",
    bytes: 2048,
    width: 1280,
    height: 720,
    version: 1,
    uploaded_at: "2026-08-12T12:00:00.000Z",
    display_order: displayOrder,
    lifecycle_state: "attached",
  };
}

async function seedLegacyProjects(pool) {
  const media101 = governedMedia(10, "legacy-governed");
  const media105 = governedMedia(10, "invalid-order", 4);
  const media201 = governedMedia(20, "foreign-governed");
  await pool.query(`
    INSERT INTO users (id) VALUES (1), (2);
    INSERT INTO contractor_profiles (id, user_id)
    VALUES (10, 1), (20, 2);
  `);
  await pool.query(
    `
    INSERT INTO contractor_projects (
      id, contractor_id, title, description, image_url, image_urls, created_at
    ) VALUES
      (101, 10, 'Legacy governed', 'Eligible governed legacy content.', $1, $2::jsonb, '2026-08-01T00:00:00Z'),
      (102, 10, 'Legacy media', 'Legacy media cannot be published.', $3, $4::jsonb, '2026-08-02T00:00:00Z'),
      (103, 10, 'Archive legacy', 'Explicit legacy archive path.', '', '[]'::jsonb, '2026-08-03T00:00:00Z'),
      (104, 10, 'Zero image', 'A Draft with no image.', '', '[]'::jsonb, '2026-08-04T00:00:00Z'),
      (105, 10, 'Invalid order', 'A Draft with invalid image order.', $5, $6::jsonb, '2026-08-05T00:00:00Z'),
      (201, 20, 'Foreign governed', 'Owned by another contractor.', $7, $8::jsonb, '2026-08-06T00:00:00Z')
    `,
    [
      media101.secure_url,
      JSON.stringify([media101]),
      "https://legacy.example.test/customer-property.jpg",
      JSON.stringify(["https://legacy.example.test/customer-property.jpg"]),
      media105.secure_url,
      JSON.stringify([media105]),
      media201.secure_url,
      JSON.stringify([media201]),
    ]
  );
}

async function activeProjectVersions(pool, contractorId = 10) {
  const result = await pool.query(
    `
    SELECT id, version
    FROM contractor_projects
    WHERE contractor_id = $1
      AND publication_state IS DISTINCT FROM 'ARCHIVED'
    ORDER BY display_order ASC NULLS LAST, id ASC
    `,
    [contractorId]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    expected_version: Number(row.version),
  }));
}

test(
  "Portfolio commands enforce lifecycle, privacy, ownership, ordering, feature, and audit authority",
  { skip: !databaseUrl },
  async (t) => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });

    try {
      await pool.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE contractor_profiles (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE contractor_projects (
          id SERIAL PRIMARY KEY,
          contractor_id INTEGER NOT NULL
            REFERENCES contractor_profiles(id) ON DELETE CASCADE,
          title TEXT,
          description TEXT,
          image_url TEXT,
          image_urls JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await seedLegacyProjects(pool);
      await pool.query(migrationSql);

      await t.test("legacy, Draft, and Archived projects are excluded from public reads", async () => {
        const before = await listPublicPortfolioProjects({ pool, contractorId: 10 });
        assert.equal(before.ok, true);
        assert.deepEqual(before.projects, []);

        const owner = await listOwnedPortfolioProjects({
          pool,
          authenticatedActor: { id: 1 },
        });
        assert.equal(owner.projects.length, 5);
        assert.ok(owner.projects.every((project) => project.migration_review_required));
        assert.ok(owner.projects.every((project) => project.publication_state === null));
        assert.ok(owner.projects.every((project) => project.actions.canAdoptAsDraft));
      });

      await t.test("legacy projects require explicit NULL to Draft or Archived adoption", async () => {
        const draft = await adoptLegacyPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 1, target_state: "DRAFT" },
        });
        assert.equal(draft.ok, true);
        assert.equal(draft.project.publication_state, "DRAFT");
        assert.equal(draft.project.version, 2);

        const archived = await adoptLegacyPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 103,
          payload: { expected_version: 1, target_state: "ARCHIVED" },
        });
        assert.equal(archived.ok, true);
        assert.equal(archived.project.publication_state, "ARCHIVED");
        assert.equal(archived.project.display_order, null);

        const invalid = await adoptLegacyPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 2, target_state: "ARCHIVED" },
        });
        assert.equal(invalid.code, "PORTFOLIO_LEGACY_TRANSITION_INVALID");

        for (const projectId of [102, 104, 105]) {
          const result = await adoptLegacyPortfolioProject({
            pool,
            authenticatedActor: { id: 1 },
            projectId,
            payload: { expected_version: 1, target_state: "DRAFT" },
          });
          assert.equal(result.ok, true);
        }
      });

      let firstNewProject;
      let secondPublishedProject;
      await t.test("new projects are Draft and owner/cross-owner authority is enforced", async () => {
        const created = await createPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          payload: {
            contractor_id: 10,
            title: "New governed project",
            description: "A governed project created through canonical authority.",
            portfolio_media: [governedMedia(10, "new-governed")],
          },
          env: TEST_ENV,
        });
        assert.equal(created.ok, true);
        assert.equal(created.status, 201);
        assert.equal(created.project.publication_state, "DRAFT");
        assert.equal(created.project.version, 1);
        firstNewProject = created.project;

        const crossOwner = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 201,
          payload: { expected_version: 1, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        assert.equal(crossOwner.status, 404);
        assert.equal(crossOwner.code, "PORTFOLIO_PROJECT_NOT_FOUND");
      });

      await t.test("publication requires eligibility, complete consent, and current version", async () => {
        const missingConsent = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: {
            expected_version: 2,
            privacy_confirmation: {
              version: PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
              confirmed: false,
            },
          },
        });
        assert.equal(missingConsent.code, "PORTFOLIO_PRIVACY_CONFIRMATION_REQUIRED");

        const stale = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 1, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        assert.equal(stale.code, "PORTFOLIO_VERSION_CONFLICT");

        const legacyMedia = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 102,
          payload: { expected_version: 2, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        assert.equal(legacyMedia.code, "PORTFOLIO_LEGACY_MEDIA_INELIGIBLE");

        const zeroImage = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 104,
          payload: { expected_version: 2, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        assert.equal(zeroImage.code, "PORTFOLIO_IMAGE_REQUIRED");

        const invalidOrder = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 105,
          payload: { expected_version: 2, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        assert.equal(invalidOrder.code, "PORTFOLIO_MEDIA_ORDER_INVALID");

        const published = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 2, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        assert.equal(published.ok, true);
        assert.equal(published.project.publication_state, "PUBLISHED");
        assert.equal(published.project.version, 3);
        assert.equal(published.project.privacy_confirmation.current, true);

        const publicResult = await listPublicPortfolioProjects({ pool, contractorId: 10 });
        assert.deepEqual(publicResult.projects.map(({ id }) => id), [101]);
        assert.deepEqual(Object.keys(publicResult.projects[0]), [
          "id",
          "contractor_id",
          "title",
          "description",
          "image_url",
          "image_urls",
          "created_at",
        ]);
      });

      await t.test("published edits require fresh exact-content confirmation and record new evidence", async () => {
        const missingFreshConsent = await updatePortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 3, description: "Changed without fresh consent." },
          env: TEST_ENV,
        });
        assert.equal(
          missingFreshConsent.code,
          "PORTFOLIO_PRIVACY_CONFIRMATION_REQUIRED"
        );

        const updated = await updatePortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: {
            expected_version: 3,
            description: "Updated public content with fresh privacy confirmation.",
            privacy_confirmation: PRIVACY_CONFIRMATION,
          },
          env: TEST_ENV,
        });
        assert.equal(updated.ok, true);
        assert.equal(updated.project.publication_state, "PUBLISHED");
        assert.equal(updated.project.version, 4);
        assert.equal(updated.project.privacy_confirmation.current, true);

        const events = await pool.query(
          `SELECT from_state, to_state, project_version
           FROM contractor_project_publication_events
           WHERE project_id = 101
           ORDER BY project_version ASC`
        );
        assert.deepEqual(events.rows, [
          { from_state: null, to_state: "DRAFT", project_version: 2 },
          { from_state: "DRAFT", to_state: "PUBLISHED", project_version: 3 },
          { from_state: "PUBLISHED", to_state: "PUBLISHED", project_version: 4 },
        ]);
      });

      await t.test("feature authority is Published-only, singular, and order-independent", async () => {
        const second = await createPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          payload: {
            contractor_id: 10,
            title: "Second published project",
            description: "Second governed project for feature authority.",
            portfolio_media: [governedMedia(10, "second-published")],
          },
          env: TEST_ENV,
        });
        const secondPublished = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: second.project.id,
          payload: { expected_version: 1, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        secondPublishedProject = secondPublished.project;

        const draftFeature = await setPortfolioFeature({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 102,
          payload: { expected_version: 2 },
          featured: true,
        });
        assert.equal(draftFeature.code, "PORTFOLIO_FEATURE_REQUIRES_PUBLISHED");

        const firstOrder = (await pool.query(
          "SELECT display_order FROM contractor_projects WHERE id = 101"
        )).rows[0].display_order;
        const firstFeature = await setPortfolioFeature({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 4 },
          featured: true,
        });
        assert.equal(firstFeature.project.is_featured, true);

        const secondFeature = await setPortfolioFeature({
          pool,
          authenticatedActor: { id: 1 },
          projectId: secondPublishedProject.id,
          payload: { expected_version: 2 },
          featured: true,
        });
        assert.equal(secondFeature.project.is_featured, true);
        assert.deepEqual(secondFeature.unfeatured_project_ids, [101]);
        assert.equal(secondFeature.unfeatured_projects[0].is_featured, false);
        assert.equal(secondFeature.unfeatured_projects[0].version, 6);
        const featureTruth = await pool.query(
          `SELECT id, is_featured, display_order, version
           FROM contractor_projects
           WHERE id IN (101, $1)
           ORDER BY id ASC`,
          [secondPublishedProject.id]
        );
        assert.equal(featureTruth.rows.filter((row) => row.is_featured).length, 1);
        assert.equal(
          featureTruth.rows.find((row) => row.id === 101).display_order,
          firstOrder
        );

        const unfeatured = await setPortfolioFeature({
          pool,
          authenticatedActor: { id: 1 },
          projectId: secondPublishedProject.id,
          payload: { expected_version: 3 },
          featured: false,
        });
        assert.equal(unfeatured.project.publication_state, "PUBLISHED");
        assert.equal(unfeatured.project.is_featured, false);
      });

      await t.test("archive preserves content/media, clears feature, removes public visibility, and is immutable", async () => {
        const featureAgain = await setPortfolioFeature({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 6 },
          featured: true,
        });
        assert.equal(featureAgain.project.is_featured, true);
        const before = await pool.query(
          "SELECT title, description, image_url, image_urls FROM contractor_projects WHERE id = 101"
        );
        const archived = await archivePortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 7 },
        });
        assert.equal(archived.ok, true);
        assert.equal(archived.project.publication_state, "ARCHIVED");
        assert.equal(archived.project.is_featured, false);
        assert.equal(archived.project.display_order, null);
        const after = await pool.query(
          "SELECT title, description, image_url, image_urls FROM contractor_projects WHERE id = 101"
        );
        assert.deepEqual(after.rows[0], before.rows[0]);

        const publicResult = await listPublicPortfolioProjects({ pool, contractorId: 10 });
        assert.equal(publicResult.projects.some(({ id }) => id === 101), false);

        const immutable = await updatePortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 101,
          payload: { expected_version: 8, title: "Forbidden archive edit" },
          env: TEST_ENV,
        });
        assert.equal(immutable.code, "PORTFOLIO_PROJECT_IMMUTABLE");

        const draftArchive = await archivePortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: 104,
          payload: { expected_version: 2 },
        });
        assert.equal(draftArchive.project.publication_state, "ARCHIVED");
      });

      await t.test("reorder requires exact active membership and current per-project versions", async () => {
        const third = await createPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          payload: {
            contractor_id: 10,
            title: "Third published project",
            description: "Third governed project for deterministic public ordering.",
            portfolio_media: [governedMedia(10, "third-published")],
          },
          env: TEST_ENV,
        });
        const thirdPublished = await publishPortfolioProject({
          pool,
          authenticatedActor: { id: 1 },
          projectId: third.project.id,
          payload: { expected_version: 1, privacy_confirmation: PRIVACY_CONFIRMATION },
        });
        assert.equal(thirdPublished.ok, true);

        const membership = await activeProjectVersions(pool);
        const duplicate = await reorderPortfolioProjects({
          pool,
          authenticatedActor: { id: 1 },
          payload: {
            contractor_id: 10,
            projects: [membership[0], membership[0]],
          },
        });
        assert.equal(duplicate.code, "PORTFOLIO_REORDER_DUPLICATE");

        const omission = await reorderPortfolioProjects({
          pool,
          authenticatedActor: { id: 1 },
          payload: { contractor_id: 10, projects: membership.slice(1) },
        });
        assert.equal(omission.code, "PORTFOLIO_REORDER_MEMBERSHIP_INVALID");

        const foreign = await reorderPortfolioProjects({
          pool,
          authenticatedActor: { id: 1 },
          payload: {
            contractor_id: 10,
            projects: [...membership.slice(1), { id: 201, expected_version: 1 }],
          },
        });
        assert.equal(foreign.code, "PORTFOLIO_REORDER_MEMBERSHIP_INVALID");

        const staleMembership = membership.map((project, index) =>
          index === 0
            ? { ...project, expected_version: project.expected_version + 1 }
            : project
        );
        const stale = await reorderPortfolioProjects({
          pool,
          authenticatedActor: { id: 1 },
          payload: { contractor_id: 10, projects: staleMembership },
        });
        assert.equal(stale.code, "PORTFOLIO_VERSION_CONFLICT");

        const reversed = [...membership].reverse();
        const reordered = await reorderPortfolioProjects({
          pool,
          authenticatedActor: { id: 1 },
          payload: { contractor_id: 10, projects: reversed },
        });
        assert.equal(reordered.ok, true);
        assert.deepEqual(
          reordered.projects.map(({ id, display_order }) => ({ id, display_order })),
          reversed.map(({ id }, display_order) => ({ id, display_order }))
        );

        const owner = await listOwnedPortfolioProjects({
          pool,
          authenticatedActor: { id: 1 },
        });
        const ownerActiveIds = owner.projects
          .filter(({ publication_state }) => publication_state !== "ARCHIVED")
          .map(({ id }) => id);
        assert.deepEqual(ownerActiveIds, reversed.map(({ id }) => id));

        const publicResult = await listPublicPortfolioProjects({ pool, contractorId: 10 });
        const expectedPublicIds = reversed
          .map(({ id }) => id)
          .filter((id) => [secondPublishedProject.id, thirdPublished.project.id].includes(id));
        assert.deepEqual(publicResult.projects.map(({ id }) => id), expectedPublicIds);

        const concurrentMembership = await activeProjectVersions(pool);
        const rotated = [
          ...concurrentMembership.slice(1),
          concurrentMembership[0],
        ];
        const [concurrentLeft, concurrentRight] = await Promise.all([
          reorderPortfolioProjects({
            pool,
            authenticatedActor: { id: 1 },
            payload: { contractor_id: 10, projects: rotated },
          }),
          reorderPortfolioProjects({
            pool,
            authenticatedActor: { id: 1 },
            payload: {
              contractor_id: 10,
              projects: [...concurrentMembership].reverse(),
            },
          }),
        ]);
        assert.equal(
          [concurrentLeft, concurrentRight].filter((result) => result.ok).length,
          1
        );
        assert.equal(
          [concurrentLeft, concurrentRight]
            .filter((result) => !result.ok)[0].code,
          "PORTFOLIO_VERSION_CONFLICT"
        );
      });

      await t.test("audit evidence is canonical, actor-scoped, and append-only", async () => {
        const events = await pool.query(
          `
          SELECT project_id, actor_user_id, project_version, from_state, to_state,
                 privacy_confirmation_version, privacy_content_digest
          FROM contractor_project_publication_events
          ORDER BY project_id ASC, project_version ASC
          `
        );
        assert.ok(events.rows.length >= 10);
        assert.ok(events.rows.every((event) => event.actor_user_id === 1));
        assert.ok(events.rows.some((event) =>
          event.project_id === 103 && event.from_state === null && event.to_state === "ARCHIVED"
        ));
        assert.ok(events.rows.some((event) =>
          event.project_id === 104 && event.from_state === "DRAFT" && event.to_state === "ARCHIVED"
        ));
        assert.ok(events.rows.some((event) =>
          event.project_id === 101 && event.from_state === "PUBLISHED" && event.to_state === "PUBLISHED"
        ));
        assert.ok(events.rows
          .filter((event) => event.to_state === "PUBLISHED")
          .every((event) =>
            event.privacy_confirmation_version === PORTFOLIO_PRIVACY_CONFIRMATION_VERSION &&
            /^[0-9a-f]{64}$/.test(event.privacy_content_digest)
          ));

        await assert.rejects(
          pool.query(
            "UPDATE contractor_project_publication_events SET actor_user_id = 2 WHERE id = (SELECT MIN(id) FROM contractor_project_publication_events)"
          ),
          (error) => error?.code === "55000"
        );
      });
    } finally {
      await pool.end();
    }
  }
);
