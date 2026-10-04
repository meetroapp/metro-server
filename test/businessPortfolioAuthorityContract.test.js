"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
  portfolioPublicationDigest,
  portfolioPublicationEligibility,
  serializeOwnedPortfolioProject,
  serializePublicPortfolioProject,
} = require("../server/portfolio/businessPortfolioContract");

function governedMedia(index = 0, suffix = "one") {
  return {
    purpose: "business-portfolio",
    public_id: `meetro-test/businesses/10/portfolio/${suffix}`,
    secure_url: `https://res.cloudinary.com/demo/image/upload/v1/meetro-test/businesses/10/portfolio/${suffix}.jpg`,
    resource_type: "image",
    format: "jpg",
    bytes: 1000,
    width: 800,
    height: 600,
    version: 1,
    uploaded_at: "2026-08-12T12:00:00.000Z",
    display_order: index,
    lifecycle_state: "attached",
  };
}

function project(overrides = {}) {
  return {
    id: 101,
    contractor_id: 10,
    title: "Governed kitchen project",
    description: "Cabinet and tile work without private customer details.",
    image_url: governedMedia().secure_url,
    image_urls: [governedMedia()],
    created_at: "2026-08-12T12:00:00.000Z",
    publication_state: "DRAFT",
    display_order: 0,
    is_featured: false,
    privacy_confirmation_version: null,
    privacy_content_digest: null,
    privacy_confirmed_at: null,
    privacy_confirmed_by_user_id: null,
    published_at: null,
    archived_at: null,
    featured_at: null,
    updated_at: "2026-08-12T12:00:00.000Z",
    version: 1,
    future_sentinel_column: "must-not-leak",
    ...overrides,
  };
}

test("public and owner Portfolio DTOs are explicit and keep private authority evidence internal", () => {
  const row = project();
  const publicProject = serializePublicPortfolioProject(row);
  const ownerProject = serializeOwnedPortfolioProject(row);

  assert.deepEqual(Object.keys(publicProject), [
    "id",
    "contractor_id",
    "title",
    "description",
    "image_url",
    "image_urls",
    "created_at",
  ]);
  assert.deepEqual(Object.keys(ownerProject), [
    ...Object.keys(publicProject),
    "portfolio_media",
    "publication_state",
    "migration_review_required",
    "display_order",
    "is_featured",
    "privacy_confirmation",
    "published_at",
    "archived_at",
    "featured_at",
    "updated_at",
    "version",
    "actions",
  ]);
  assert.doesNotMatch(
    JSON.stringify(publicProject),
    /public_id|privacy_|publication_state|future_sentinel_column/
  );
  assert.doesNotMatch(
    JSON.stringify(ownerProject),
    /privacy_content_digest|privacy_confirmed_by_user_id|future_sentinel_column/
  );
});

test("publication eligibility requires bounded content and contiguous governed media", () => {
  assert.equal(portfolioPublicationEligibility(project()).eligible, true);
  assert.deepEqual(
    portfolioPublicationEligibility(project({ title: "" })).reasons,
    ["PORTFOLIO_TITLE_INELIGIBLE"]
  );
  assert.deepEqual(
    portfolioPublicationEligibility(project({ description: "" })).reasons,
    ["PORTFOLIO_DESCRIPTION_INELIGIBLE"]
  );
  assert.deepEqual(
    portfolioPublicationEligibility(project({ image_urls: [] })).reasons,
    ["PORTFOLIO_IMAGE_REQUIRED"]
  );
  const legacy = portfolioPublicationEligibility(project({
    image_urls: ["https://legacy.example.test/customer-property.jpg"],
  }));
  assert.equal(legacy.eligible, false);
  assert.ok(legacy.reasons.includes("PORTFOLIO_LEGACY_MEDIA_INELIGIBLE"));
  const invalidOrder = portfolioPublicationEligibility(project({
    image_urls: [governedMedia(4)],
  }));
  assert.equal(invalidOrder.eligible, false);
  assert.ok(invalidOrder.reasons.includes("PORTFOLIO_MEDIA_ORDER_INVALID"));
});

test("privacy digest is tied to exact title, description, and ordered governed media", () => {
  const first = project({ image_urls: [governedMedia(0, "one"), governedMedia(1, "two")] });
  const reordered = project({ image_urls: [governedMedia(0, "two"), governedMedia(1, "one")] });

  assert.match(portfolioPublicationDigest(first), /^[0-9a-f]{64}$/);
  assert.notEqual(portfolioPublicationDigest(first), portfolioPublicationDigest(reordered));
  assert.notEqual(
    portfolioPublicationDigest(first),
    portfolioPublicationDigest({ ...first, description: `${first.description} Updated.` })
  );
});

test("owner action projection is truthful for legacy, Draft, Published, and Archived states", () => {
  const legacy = serializeOwnedPortfolioProject(project({ publication_state: null }));
  assert.deepEqual(legacy.actions, {
    canAdoptAsDraft: true,
    canEdit: false,
    canPublish: false,
    canArchive: true,
    canFeature: false,
    canUnfeature: false,
    canReorder: true,
  });

  const draft = serializeOwnedPortfolioProject(project());
  assert.deepEqual(draft.actions, {
    canAdoptAsDraft: false,
    canEdit: true,
    canPublish: true,
    canArchive: true,
    canFeature: false,
    canUnfeature: false,
    canReorder: true,
  });

  const digest = portfolioPublicationDigest(project());
  const published = serializeOwnedPortfolioProject(project({
    publication_state: "PUBLISHED",
    privacy_confirmation_version: PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
    privacy_content_digest: digest,
    privacy_confirmed_at: "2026-08-12T12:05:00.000Z",
    published_at: "2026-08-12T12:05:00.000Z",
  }));
  assert.equal(published.privacy_confirmation.current, true);
  assert.deepEqual(published.actions, {
    canAdoptAsDraft: false,
    canEdit: true,
    canPublish: false,
    canArchive: true,
    canFeature: true,
    canUnfeature: false,
    canReorder: true,
  });

  const featured = serializeOwnedPortfolioProject(project({
    publication_state: "PUBLISHED",
    is_featured: true,
  }));
  assert.equal(featured.actions.canFeature, false);
  assert.equal(featured.actions.canUnfeature, true);

  const archived = serializeOwnedPortfolioProject(project({
    publication_state: "ARCHIVED",
    display_order: null,
    archived_at: "2026-08-12T12:10:00.000Z",
  }));
  assert.deepEqual(archived.actions, {
    canAdoptAsDraft: false,
    canEdit: false,
    canPublish: false,
    canArchive: false,
    canFeature: false,
    canUnfeature: false,
    canReorder: false,
  });
});
