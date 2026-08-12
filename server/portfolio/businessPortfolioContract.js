"use strict";

const { createHash } = require("node:crypto");

const PORTFOLIO_PUBLICATION_STATES = Object.freeze({
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  ARCHIVED: "ARCHIVED",
});
const PORTFOLIO_PRIVACY_CONFIRMATION_VERSION = "portfolio-publication-v1";
const PORTFOLIO_TITLE_MAX_LENGTH = 160;
const PORTFOLIO_DESCRIPTION_MAX_LENGTH = 4000;

function parsePortfolioMedia(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function portfolioMediaUrl(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  return String(item.secure_url || item.legacy_url || "").trim();
}

function isGovernedPortfolioMedia(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (item.legacy_url) return false;
  return (
    item.purpose === "business-portfolio" &&
    String(item.public_id || "").trim().length > 0 &&
    /^https:\/\/res\.cloudinary\.com\//.test(String(item.secure_url || "")) &&
    item.resource_type === "image" &&
    String(item.format || "").trim().length > 0 &&
    Number.isSafeInteger(Number(item.bytes)) && Number(item.bytes) > 0 &&
    Number.isSafeInteger(Number(item.width)) && Number(item.width) > 0 &&
    Number.isSafeInteger(Number(item.height)) && Number(item.height) > 0 &&
    Number.isSafeInteger(Number(item.version)) && Number(item.version) > 0 &&
    Number(item.display_order) === index &&
    item.lifecycle_state === "attached"
  );
}

function canonicalPortfolioMediaIdentity(item, index) {
  return {
    purpose: String(item.purpose),
    public_id: String(item.public_id),
    secure_url: String(item.secure_url),
    resource_type: String(item.resource_type),
    format: String(item.format),
    bytes: Number(item.bytes),
    width: Number(item.width),
    height: Number(item.height),
    version: Number(item.version),
    display_order: index,
    lifecycle_state: String(item.lifecycle_state),
  };
}

function portfolioPublicationDigest(row = {}) {
  const media = parsePortfolioMedia(row.image_urls);
  const canonical = {
    privacy_confirmation_version: PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
    title: String(row.title || ""),
    description: String(row.description || ""),
    ordered_media: media.map(canonicalPortfolioMediaIdentity),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function portfolioPublicationEligibility(row = {}) {
  const reasons = [];
  const title = String(row.title || "").trim();
  const description = String(row.description || "").trim();
  const media = parsePortfolioMedia(row.image_urls);

  if (!title || title.length > PORTFOLIO_TITLE_MAX_LENGTH) {
    reasons.push("PORTFOLIO_TITLE_INELIGIBLE");
  }
  if (!description || description.length > PORTFOLIO_DESCRIPTION_MAX_LENGTH) {
    reasons.push("PORTFOLIO_DESCRIPTION_INELIGIBLE");
  }
  if (media.length === 0) reasons.push("PORTFOLIO_IMAGE_REQUIRED");
  if (media.some((item) => typeof item === "string" || item?.legacy_url)) {
    reasons.push("PORTFOLIO_LEGACY_MEDIA_INELIGIBLE");
  }
  if (media.length > 0 && !media.every(isGovernedPortfolioMedia)) {
    reasons.push("PORTFOLIO_MEDIA_ORDER_INVALID");
  }
  return Object.freeze({ eligible: reasons.length === 0, reasons });
}

function serializeOwnedPortfolioMedia(item, index) {
  if (typeof item === "string") {
    return {
      legacy_url: item,
      secure_url: item,
      display_order: index,
      lifecycle_state: "legacy",
    };
  }
  const source = item && typeof item === "object" && !Array.isArray(item)
    ? item
    : {};
  return {
    purpose: source.purpose,
    public_id: source.public_id,
    secure_url: source.secure_url,
    resource_type: source.resource_type,
    format: source.format,
    bytes: source.bytes,
    width: source.width,
    height: source.height,
    version: source.version,
    uploaded_at: source.uploaded_at,
    display_order: index,
    lifecycle_state: source.lifecycle_state,
  };
}

function serializePublicPortfolioProject(row = {}) {
  const urls = parsePortfolioMedia(row.image_urls)
    .map(portfolioMediaUrl)
    .filter(Boolean);
  return {
    id: row.id,
    contractor_id: row.contractor_id,
    title: row.title,
    description: row.description,
    image_url: urls[0] || row.image_url || "",
    image_urls: urls,
    created_at: row.created_at,
  };
}

function portfolioPrivacyStatus(row = {}) {
  const confirmed = Boolean(
    row.privacy_confirmation_version &&
    row.privacy_content_digest &&
    row.privacy_confirmed_at
  );
  const current = confirmed &&
    row.privacy_confirmation_version === PORTFOLIO_PRIVACY_CONFIRMATION_VERSION &&
    row.privacy_content_digest === portfolioPublicationDigest(row);
  return {
    version: row.privacy_confirmation_version || null,
    confirmed,
    current,
    confirmed_at: row.privacy_confirmed_at || null,
  };
}

function portfolioActions(row = {}) {
  const state = row.publication_state || null;
  const archived = state === PORTFOLIO_PUBLICATION_STATES.ARCHIVED;
  const published = state === PORTFOLIO_PUBLICATION_STATES.PUBLISHED;
  const draft = state === PORTFOLIO_PUBLICATION_STATES.DRAFT;
  const legacy = state === null;
  const publishable = portfolioPublicationEligibility(row).eligible;

  return {
    canAdoptAsDraft: legacy,
    canEdit: draft || published,
    canPublish: draft && publishable,
    canArchive: !archived,
    canFeature: published && !row.is_featured,
    canUnfeature: published && row.is_featured === true,
    canReorder: !archived,
  };
}

function serializeOwnedPortfolioProject(row = {}) {
  const stored = parsePortfolioMedia(row.image_urls);
  return {
    ...serializePublicPortfolioProject(row),
    portfolio_media: stored.map(serializeOwnedPortfolioMedia),
    publication_state: row.publication_state || null,
    migration_review_required: row.publication_state == null,
    display_order:
      row.display_order === null || row.display_order === undefined
        ? null
        : Number(row.display_order),
    is_featured: row.is_featured === true,
    privacy_confirmation: portfolioPrivacyStatus(row),
    published_at: row.published_at || null,
    archived_at: row.archived_at || null,
    featured_at: row.featured_at || null,
    updated_at: row.updated_at || null,
    version: Number(row.version || 1),
    actions: portfolioActions(row),
  };
}

module.exports = {
  PORTFOLIO_DESCRIPTION_MAX_LENGTH,
  PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
  PORTFOLIO_PUBLICATION_STATES,
  PORTFOLIO_TITLE_MAX_LENGTH,
  isGovernedPortfolioMedia,
  parsePortfolioMedia,
  portfolioActions,
  portfolioMediaUrl,
  portfolioPrivacyStatus,
  portfolioPublicationDigest,
  portfolioPublicationEligibility,
  serializeOwnedPortfolioMedia,
  serializeOwnedPortfolioProject,
  serializePublicPortfolioProject,
};
