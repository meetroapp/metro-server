"use strict";

const {
  MediaConfigurationError,
  MediaValidationError,
  createCloudinaryMedia,
} = require("../media/cloudinary");
const {
  normalizePortfolioCollection,
  safelyDeletePortfolioMedia,
} = require("../media/businessPortfolio");
const {
  PORTFOLIO_DESCRIPTION_MAX_LENGTH,
  PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
  PORTFOLIO_PUBLICATION_STATES,
  PORTFOLIO_TITLE_MAX_LENGTH,
  parsePortfolioMedia,
  portfolioMediaUrl,
  portfolioPublicationDigest,
  portfolioPublicationEligibility,
  serializeOwnedPortfolioProject,
  serializePublicPortfolioProject,
} = require("./businessPortfolioContract");

const OWNER_PROJECT_FIELDS = `
  contractor_projects.id,
  contractor_projects.contractor_id,
  contractor_projects.title,
  contractor_projects.description,
  contractor_projects.image_url,
  contractor_projects.image_urls,
  contractor_projects.created_at,
  contractor_projects.publication_state,
  contractor_projects.display_order,
  contractor_projects.is_featured,
  contractor_projects.privacy_confirmation_version,
  contractor_projects.privacy_content_digest,
  contractor_projects.privacy_confirmed_at,
  contractor_projects.privacy_confirmed_by_user_id,
  contractor_projects.published_at,
  contractor_projects.archived_at,
  contractor_projects.featured_at,
  contractor_projects.updated_at,
  contractor_projects.version
`;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function exactObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return exactObject(value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function normalizedText(value, maximum, fieldCode) {
  if (value === undefined) return { supplied: false, value: "" };
  if (typeof value !== "string") {
    return { error: failure(400, fieldCode, "Portfolio text is invalid.") };
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    return { error: failure(400, fieldCode, "Portfolio text is invalid.") };
  }
  return { supplied: true, value: normalized };
}

function validateExpectedVersion(payload) {
  const expectedVersion = positiveInteger(payload?.expected_version);
  return expectedVersion
    ? { ok: true, expectedVersion }
    : failure(400, "PORTFOLIO_EXPECTED_VERSION_REQUIRED", "The current project version is required.");
}

function validatePrivacyConfirmation(value) {
  if (
    !hasOnlyKeys(value, new Set(["version", "confirmed"])) ||
    value.version !== PORTFOLIO_PRIVACY_CONFIRMATION_VERSION ||
    value.confirmed !== true
  ) {
    return failure(
      400,
      "PORTFOLIO_PRIVACY_CONFIRMATION_REQUIRED",
      "Current Portfolio privacy confirmation is required."
    );
  }
  return { ok: true };
}

function mediaFailure(error) {
  if (error instanceof MediaConfigurationError) {
    return failure(503, "MEDIA_SERVICE_UNAVAILABLE", "Media uploads are temporarily unavailable.");
  }
  if (error instanceof MediaValidationError) {
    return failure(
      error.code === "MEDIA_OWNER_INVALID" ? 404 : 400,
      error.code,
      "Portfolio media is invalid."
    );
  }
  return null;
}

async function loadOwnedProject(client, projectId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT ${OWNER_PROJECT_FIELDS}
    FROM contractor_projects
    INNER JOIN contractor_profiles
      ON contractor_profiles.id = contractor_projects.contractor_id
    WHERE contractor_projects.id = $1
      AND contractor_profiles.user_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF contractor_projects" : ""}
    `,
    [projectId, actorUserId]
  );
  return result.rows[0] || null;
}

function projectPublicIds(media) {
  return new Set(
    parsePortfolioMedia(media)
      .filter((item) => item && typeof item === "object" && item.public_id)
      .map((item) => String(item.public_id))
  );
}

async function cleanupPortfolioAssets({
  mediaService,
  env,
  contractorId,
  publicIds,
  code,
}) {
  if (!publicIds.length || !contractorId) return;
  let service = mediaService;
  if (!service) {
    try {
      service = createCloudinaryMedia({ env });
    } catch {
      console.error("Business portfolio media cleanup failed", { code });
      return;
    }
  }
  await Promise.all(
    publicIds.map((publicId) =>
      safelyDeletePortfolioMedia(service, publicId, contractorId, code)
    )
  );
}

async function insertPublicationEvent(client, {
  project,
  actorUserId,
  fromState,
  toState,
}) {
  await client.query(
    `
    INSERT INTO contractor_project_publication_events (
      project_id,
      contractor_id,
      actor_user_id,
      project_version,
      from_state,
      to_state,
      privacy_confirmation_version,
      privacy_content_digest,
      transitioned_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
    `,
    [
      project.id,
      project.contractor_id,
      actorUserId,
      project.version,
      fromState,
      toState,
      project.privacy_confirmation_version,
      project.privacy_content_digest,
    ]
  );
}

async function listOwnedPortfolioProjects({ pool, authenticatedActor } = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  if (!actorUserId) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  const result = await pool.query(
    `
    SELECT ${OWNER_PROJECT_FIELDS}
    FROM contractor_projects
    INNER JOIN contractor_profiles
      ON contractor_profiles.id = contractor_projects.contractor_id
    WHERE contractor_profiles.user_id = $1
    ORDER BY contractor_projects.display_order ASC NULLS LAST,
             contractor_projects.id ASC
    `,
    [actorUserId]
  );
  return {
    ok: true,
    status: 200,
    code: "BUSINESS_PORTFOLIO_LOADED",
    projects: result.rows.map(serializeOwnedPortfolioProject),
  };
}

async function listPublicPortfolioProjects({ pool, contractorId: rawContractorId } = {}) {
  const contractorId = positiveInteger(rawContractorId);
  if (!contractorId) {
    return failure(400, "INVALID_CONTRACTOR_ID", "A valid contractor ID is required.");
  }
  const result = await pool.query(
    `
    SELECT id,
           contractor_id,
           title,
           description,
           image_url,
           image_urls,
           created_at
    FROM contractor_projects
    WHERE contractor_id = $1
      AND publication_state = 'PUBLISHED'
    ORDER BY display_order ASC NULLS LAST, id ASC
    `,
    [contractorId]
  );
  return {
    ok: true,
    status: 200,
    projects: result.rows.map(serializePublicPortfolioProject),
  };
}

async function createPortfolioProject({
  pool,
  authenticatedActor,
  payload,
  env = process.env,
  mediaService = null,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!hasOnlyKeys(payload, new Set(["contractor_id", "title", "description", "portfolio_media"]))) {
    return failure(400, "UNSUPPORTED_PORTFOLIO_FIELDS", "One or more Portfolio fields are unsupported.");
  }
  const contractorId = positiveInteger(payload.contractor_id);
  if (!contractorId) return failure(400, "INVALID_CONTRACTOR_ID", "A valid contractor ID is required.");
  const title = normalizedText(payload.title, PORTFOLIO_TITLE_MAX_LENGTH, "PORTFOLIO_TITLE_INVALID");
  const description = normalizedText(
    payload.description,
    PORTFOLIO_DESCRIPTION_MAX_LENGTH,
    "PORTFOLIO_DESCRIPTION_INVALID"
  );
  if (title.error) return title.error;
  if (description.error) return description.error;
  if (!Array.isArray(payload.portfolio_media)) {
    return failure(400, "MEDIA_COLLECTION_INVALID", "Portfolio media is invalid.");
  }

  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  let normalizedMedia = [];
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const owner = await client.query(
      `
      SELECT id
      FROM contractor_profiles
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [contractorId, actorUserId]
    );
    if (!owner.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "PORTFOLIO_PROJECT_NOT_FOUND", "The Portfolio project was not found.");
    }
    normalizedMedia = normalizePortfolioCollection(payload.portfolio_media, {
      env,
      contractorProfileId: contractorId,
      existing: [],
      allowLegacy: false,
    });
    const order = await client.query(
      `
      SELECT COALESCE(MAX(display_order), -1) + 1 AS next_display_order
      FROM contractor_projects
      WHERE contractor_id = $1
        AND publication_state IS DISTINCT FROM 'ARCHIVED'
      `,
      [contractorId]
    );
    const imageUrl = normalizedMedia.map(portfolioMediaUrl).find(Boolean) || "";
    const inserted = await client.query(
      `
      INSERT INTO contractor_projects (
        contractor_id,
        title,
        description,
        image_url,
        image_urls,
        publication_state,
        display_order,
        is_featured,
        updated_at,
        version
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, 'DRAFT', $6, FALSE, CURRENT_TIMESTAMP, 1)
      RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "")}
      `,
      [
        contractorId,
        title.value,
        description.value,
        imageUrl,
        JSON.stringify(normalizedMedia),
        Number(order.rows[0]?.next_display_order || 0),
      ]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      status: 201,
      code: "BUSINESS_PORTFOLIO_CREATED",
      project: serializeOwnedPortfolioProject(inserted.rows[0]),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    try {
      await cleanupPortfolioAssets({
        mediaService,
        env,
        contractorId,
        publicIds: [...projectPublicIds(normalizedMedia)],
        code: "NEW_PORTFOLIO_MEDIA_CLEANUP_FAILED",
      });
    } catch {
      // The primary persistence failure remains authoritative.
    }
    return mediaFailure(error) || Promise.reject(error);
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

async function updatePortfolioProject({
  pool,
  authenticatedActor,
  projectId: rawProjectId,
  payload,
  env = process.env,
  mediaService = null,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const projectId = positiveInteger(rawProjectId);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!projectId) return failure(400, "INVALID_PORTFOLIO_PROJECT_ID", "A valid project ID is required.");
  if (!hasOnlyKeys(payload, new Set([
    "title", "description", "portfolio_media", "expected_version", "privacy_confirmation",
  ]))) {
    return failure(400, "UNSUPPORTED_PORTFOLIO_FIELDS", "One or more Portfolio fields are unsupported.");
  }
  const versionValidation = validateExpectedVersion(payload);
  if (!versionValidation.ok) return versionValidation;
  const title = normalizedText(payload.title, PORTFOLIO_TITLE_MAX_LENGTH, "PORTFOLIO_TITLE_INVALID");
  const description = normalizedText(
    payload.description,
    PORTFOLIO_DESCRIPTION_MAX_LENGTH,
    "PORTFOLIO_DESCRIPTION_INVALID"
  );
  if (title.error) return title.error;
  if (description.error) return description.error;
  if (payload.portfolio_media !== undefined && !Array.isArray(payload.portfolio_media)) {
    return failure(400, "MEDIA_COLLECTION_INVALID", "Portfolio media is invalid.");
  }
  if (!title.supplied && !description.supplied && payload.portfolio_media === undefined) {
    return failure(400, "PORTFOLIO_UPDATE_REQUIRED", "At least one Portfolio value must change.");
  }

  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  let existing = null;
  let nextMedia = [];
  let newlyReferencedIds = [];
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    existing = await loadOwnedProject(client, projectId, actorUserId, { lock: true });
    if (!existing) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "PORTFOLIO_PROJECT_NOT_FOUND", "The Portfolio project was not found.");
    }
    if (![PORTFOLIO_PUBLICATION_STATES.DRAFT, PORTFOLIO_PUBLICATION_STATES.PUBLISHED]
      .includes(existing.publication_state)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_PROJECT_IMMUTABLE", "This Portfolio project cannot be edited.");
    }
    if (Number(existing.version) !== versionValidation.expectedVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_VERSION_CONFLICT", "The Portfolio project changed before this command.");
    }

    const currentMedia = parsePortfolioMedia(existing.image_urls);
    nextMedia = payload.portfolio_media === undefined
      ? currentMedia
      : normalizePortfolioCollection(payload.portfolio_media, {
          env,
          contractorProfileId: existing.contractor_id,
          existing: currentMedia,
          allowLegacy: true,
        });
    const nextTitle = title.supplied ? title.value : String(existing.title || "");
    const nextDescription = description.supplied
      ? description.value
      : String(existing.description || "");
    const changed =
      nextTitle !== String(existing.title || "") ||
      nextDescription !== String(existing.description || "") ||
      JSON.stringify(nextMedia) !== JSON.stringify(currentMedia);
    if (!changed) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(400, "PORTFOLIO_UPDATE_REQUIRED", "At least one Portfolio value must change.");
    }

    const currentIds = projectPublicIds(currentMedia);
    const nextIds = projectPublicIds(nextMedia);
    newlyReferencedIds = [...nextIds].filter((publicId) => !currentIds.has(publicId));
    const nextRow = {
      ...existing,
      title: nextTitle,
      description: nextDescription,
      image_urls: nextMedia,
    };
    let privacyVersion = null;
    let privacyDigest = null;
    if (existing.publication_state === PORTFOLIO_PUBLICATION_STATES.PUBLISHED) {
      const eligibility = portfolioPublicationEligibility(nextRow);
      if (!eligibility.eligible) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return failure(409, eligibility.reasons[0], "Published Portfolio content must remain eligible.");
      }
      const privacy = validatePrivacyConfirmation(payload.privacy_confirmation);
      if (!privacy.ok) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return privacy;
      }
      privacyVersion = PORTFOLIO_PRIVACY_CONFIRMATION_VERSION;
      privacyDigest = portfolioPublicationDigest(nextRow);
    } else if (payload.privacy_confirmation !== undefined) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(400, "PORTFOLIO_PRIVACY_CONFIRMATION_NOT_APPLICABLE", "Draft edits do not record publication consent.");
    }

    const imageUrl = nextMedia.map(portfolioMediaUrl).find(Boolean) || "";
    const updated = await client.query(
      `
      UPDATE contractor_projects
      SET title = $1,
          description = $2,
          image_url = $3,
          image_urls = $4::jsonb,
          privacy_confirmation_version = $5,
          privacy_content_digest = $6,
          privacy_confirmed_at = CASE WHEN $5::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
          privacy_confirmed_by_user_id = CASE WHEN $5::text IS NULL THEN NULL ELSE $7::integer END,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = $8
        AND contractor_id = $9
        AND version = $10
      RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "")}
      `,
      [
        nextTitle,
        nextDescription,
        imageUrl,
        JSON.stringify(nextMedia),
        privacyVersion,
        privacyDigest,
        actorUserId,
        projectId,
        existing.contractor_id,
        versionValidation.expectedVersion,
      ]
    );
    const project = updated.rows[0];
    if (!project) throw new Error("PORTFOLIO_VERSION_UPDATE_FAILED");
    if (existing.publication_state === PORTFOLIO_PUBLICATION_STATES.PUBLISHED) {
      await insertPublicationEvent(client, {
        project,
        actorUserId,
        fromState: PORTFOLIO_PUBLICATION_STATES.PUBLISHED,
        toState: PORTFOLIO_PUBLICATION_STATES.PUBLISHED,
      });
    }
    await client.query("COMMIT");
    transactionStarted = false;

    const removedIds = [...projectPublicIds(currentMedia)]
      .filter((publicId) => !projectPublicIds(nextMedia).has(publicId));
    await cleanupPortfolioAssets({
      mediaService,
      env,
      contractorId: existing.contractor_id,
      publicIds: removedIds,
      code: "REMOVED_PORTFOLIO_MEDIA_DELETE_FAILED",
    });
    return {
      ok: true,
      status: 200,
      code: "BUSINESS_PORTFOLIO_UPDATED",
      project: serializeOwnedPortfolioProject(project),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    try {
      await cleanupPortfolioAssets({
        mediaService,
        env,
        contractorId: existing?.contractor_id,
        publicIds: newlyReferencedIds,
        code: "NEW_PORTFOLIO_MEDIA_CLEANUP_FAILED",
      });
    } catch {
      // The primary persistence failure remains authoritative.
    }
    return mediaFailure(error) || Promise.reject(error);
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

async function adoptLegacyPortfolioProject({
  pool,
  authenticatedActor,
  projectId: rawProjectId,
  payload,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const projectId = positiveInteger(rawProjectId);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!projectId) return failure(400, "INVALID_PORTFOLIO_PROJECT_ID", "A valid project ID is required.");
  if (!hasOnlyKeys(payload, new Set(["expected_version", "target_state"]))) {
    return failure(400, "UNSUPPORTED_PORTFOLIO_FIELDS", "One or more Portfolio fields are unsupported.");
  }
  const versionValidation = validateExpectedVersion(payload);
  if (!versionValidation.ok) return versionValidation;
  if (![PORTFOLIO_PUBLICATION_STATES.DRAFT, PORTFOLIO_PUBLICATION_STATES.ARCHIVED]
    .includes(payload.target_state)) {
    return failure(400, "PORTFOLIO_LEGACY_TARGET_INVALID", "Legacy projects may become Draft or Archived only.");
  }

  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const owner = await client.query(
      `
      SELECT contractor_profiles.id
      FROM contractor_profiles
      INNER JOIN contractor_projects
        ON contractor_projects.contractor_id = contractor_profiles.id
      WHERE contractor_projects.id = $1
        AND contractor_profiles.user_id = $2
      LIMIT 1
      FOR UPDATE OF contractor_profiles
      `,
      [projectId, actorUserId]
    );
    if (!owner.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "PORTFOLIO_PROJECT_NOT_FOUND", "The Portfolio project was not found.");
    }
    const existing = await loadOwnedProject(client, projectId, actorUserId, { lock: true });
    if (existing.publication_state !== null) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_LEGACY_TRANSITION_INVALID", "The project is not awaiting legacy review.");
    }
    if (Number(existing.version) !== versionValidation.expectedVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_VERSION_CONFLICT", "The Portfolio project changed before this command.");
    }
    const archived = payload.target_state === PORTFOLIO_PUBLICATION_STATES.ARCHIVED;
    const updated = await client.query(
      `
      UPDATE contractor_projects
      SET publication_state = $1,
          archived_at = CASE WHEN $1 = 'ARCHIVED' THEN CURRENT_TIMESTAMP ELSE NULL END,
          display_order = CASE WHEN $1 = 'ARCHIVED' THEN NULL ELSE display_order END,
          is_featured = FALSE,
          featured_at = NULL,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = $2 AND contractor_id = $3 AND version = $4
      RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "")}
      `,
      [payload.target_state, projectId, existing.contractor_id, versionValidation.expectedVersion]
    );
    const project = updated.rows[0];
    await insertPublicationEvent(client, {
      project,
      actorUserId,
      fromState: null,
      toState: payload.target_state,
    });
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      status: 200,
      code: archived ? "PORTFOLIO_PROJECT_ARCHIVED" : "PORTFOLIO_LEGACY_ADOPTED_AS_DRAFT",
      project: serializeOwnedPortfolioProject(project),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

async function publishPortfolioProject({
  pool,
  authenticatedActor,
  projectId: rawProjectId,
  payload,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const projectId = positiveInteger(rawProjectId);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!projectId) return failure(400, "INVALID_PORTFOLIO_PROJECT_ID", "A valid project ID is required.");
  if (!hasOnlyKeys(payload, new Set(["expected_version", "privacy_confirmation"]))) {
    return failure(400, "UNSUPPORTED_PORTFOLIO_FIELDS", "One or more Portfolio fields are unsupported.");
  }
  const versionValidation = validateExpectedVersion(payload);
  if (!versionValidation.ok) return versionValidation;
  const privacy = validatePrivacyConfirmation(payload.privacy_confirmation);
  if (!privacy.ok) return privacy;

  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const existing = await loadOwnedProject(client, projectId, actorUserId, { lock: true });
    if (!existing) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "PORTFOLIO_PROJECT_NOT_FOUND", "The Portfolio project was not found.");
    }
    if (existing.publication_state !== PORTFOLIO_PUBLICATION_STATES.DRAFT) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_PUBLICATION_TRANSITION_INVALID", "Only Draft projects may be published.");
    }
    if (Number(existing.version) !== versionValidation.expectedVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_VERSION_CONFLICT", "The Portfolio project changed before this command.");
    }
    const eligibility = portfolioPublicationEligibility(existing);
    if (!eligibility.eligible) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, eligibility.reasons[0], "The Draft is not eligible for publication.");
    }
    const digest = portfolioPublicationDigest(existing);
    const updated = await client.query(
      `
      UPDATE contractor_projects
      SET publication_state = 'PUBLISHED',
          privacy_confirmation_version = $1,
          privacy_content_digest = $2,
          privacy_confirmed_at = CURRENT_TIMESTAMP,
          privacy_confirmed_by_user_id = $3,
          published_at = CURRENT_TIMESTAMP,
          archived_at = NULL,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = $4 AND contractor_id = $5 AND version = $6
      RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "")}
      `,
      [
        PORTFOLIO_PRIVACY_CONFIRMATION_VERSION,
        digest,
        actorUserId,
        projectId,
        existing.contractor_id,
        versionValidation.expectedVersion,
      ]
    );
    const project = updated.rows[0];
    await insertPublicationEvent(client, {
      project,
      actorUserId,
      fromState: PORTFOLIO_PUBLICATION_STATES.DRAFT,
      toState: PORTFOLIO_PUBLICATION_STATES.PUBLISHED,
    });
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      status: 200,
      code: "PORTFOLIO_PROJECT_PUBLISHED",
      project: serializeOwnedPortfolioProject(project),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

async function archivePortfolioProject({
  pool,
  authenticatedActor,
  projectId: rawProjectId,
  payload,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const projectId = positiveInteger(rawProjectId);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!projectId) return failure(400, "INVALID_PORTFOLIO_PROJECT_ID", "A valid project ID is required.");
  if (!hasOnlyKeys(payload, new Set(["expected_version"]))) {
    return failure(400, "UNSUPPORTED_PORTFOLIO_FIELDS", "One or more Portfolio fields are unsupported.");
  }
  const versionValidation = validateExpectedVersion(payload);
  if (!versionValidation.ok) return versionValidation;

  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const existing = await loadOwnedProject(client, projectId, actorUserId, { lock: true });
    if (!existing) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "PORTFOLIO_PROJECT_NOT_FOUND", "The Portfolio project was not found.");
    }
    if (![null, PORTFOLIO_PUBLICATION_STATES.DRAFT, PORTFOLIO_PUBLICATION_STATES.PUBLISHED]
      .includes(existing.publication_state)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_PROJECT_IMMUTABLE", "Archived projects are immutable.");
    }
    if (Number(existing.version) !== versionValidation.expectedVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_VERSION_CONFLICT", "The Portfolio project changed before this command.");
    }
    const updated = await client.query(
      `
      UPDATE contractor_projects
      SET publication_state = 'ARCHIVED',
          archived_at = CURRENT_TIMESTAMP,
          display_order = NULL,
          is_featured = FALSE,
          featured_at = NULL,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = $1 AND contractor_id = $2 AND version = $3
      RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "")}
      `,
      [projectId, existing.contractor_id, versionValidation.expectedVersion]
    );
    const project = updated.rows[0];
    await insertPublicationEvent(client, {
      project,
      actorUserId,
      fromState: existing.publication_state,
      toState: PORTFOLIO_PUBLICATION_STATES.ARCHIVED,
    });
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      status: 200,
      code: "PORTFOLIO_PROJECT_ARCHIVED",
      project: serializeOwnedPortfolioProject(project),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

async function setPortfolioFeature({
  pool,
  authenticatedActor,
  projectId: rawProjectId,
  payload,
  featured,
} = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  const projectId = positiveInteger(rawProjectId);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  if (!projectId) return failure(400, "INVALID_PORTFOLIO_PROJECT_ID", "A valid project ID is required.");
  if (!hasOnlyKeys(payload, new Set(["expected_version"]))) {
    return failure(400, "UNSUPPORTED_PORTFOLIO_FIELDS", "One or more Portfolio fields are unsupported.");
  }
  const versionValidation = validateExpectedVersion(payload);
  if (!versionValidation.ok) return versionValidation;

  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const owner = await client.query(
      `
      SELECT contractor_profiles.id
      FROM contractor_profiles
      INNER JOIN contractor_projects
        ON contractor_projects.contractor_id = contractor_profiles.id
      WHERE contractor_projects.id = $1
        AND contractor_profiles.user_id = $2
      LIMIT 1
      FOR UPDATE OF contractor_profiles
      `,
      [projectId, actorUserId]
    );
    if (!owner.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "PORTFOLIO_PROJECT_NOT_FOUND", "The Portfolio project was not found.");
    }
    const existing = await loadOwnedProject(client, projectId, actorUserId, { lock: true });
    if (existing.publication_state !== PORTFOLIO_PUBLICATION_STATES.PUBLISHED) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_FEATURE_REQUIRES_PUBLISHED", "Only published projects may be featured.");
    }
    if (Number(existing.version) !== versionValidation.expectedVersion) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_VERSION_CONFLICT", "The Portfolio project changed before this command.");
    }
    if (existing.is_featured === featured) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, featured ? "PORTFOLIO_ALREADY_FEATURED" : "PORTFOLIO_NOT_FEATURED", "Feature state is unchanged.");
    }

    let cleared = [];
    if (featured) {
      const clearedResult = await client.query(
        `
        UPDATE contractor_projects
        SET is_featured = FALSE,
            featured_at = NULL,
            updated_at = CURRENT_TIMESTAMP,
            version = version + 1
        WHERE contractor_id = $1
          AND id <> $2
          AND is_featured = TRUE
        RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "")}
        `,
        [existing.contractor_id, projectId]
      );
      cleared = clearedResult.rows;
    }
    const updated = await client.query(
      `
      UPDATE contractor_projects
      SET is_featured = $1,
          featured_at = CASE WHEN $1::boolean THEN CURRENT_TIMESTAMP ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = $2 AND contractor_id = $3 AND version = $4
      RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "")}
      `,
      [featured, projectId, existing.contractor_id, versionValidation.expectedVersion]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      status: 200,
      code: featured ? "PORTFOLIO_PROJECT_FEATURED" : "PORTFOLIO_PROJECT_UNFEATURED",
      project: serializeOwnedPortfolioProject(updated.rows[0]),
      unfeatured_project_ids: cleared.map((row) => Number(row.id)),
      unfeatured_projects: cleared.map(serializeOwnedPortfolioProject),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

function validateReorderPayload(payload) {
  if (!hasOnlyKeys(payload, new Set(["contractor_id", "projects"]))) {
    return failure(400, "PORTFOLIO_REORDER_INVALID", "Portfolio reorder details are invalid.");
  }
  const contractorId = positiveInteger(payload.contractor_id);
  if (!contractorId || !Array.isArray(payload.projects) || payload.projects.length === 0) {
    return failure(400, "PORTFOLIO_REORDER_INVALID", "Portfolio reorder details are invalid.");
  }
  const projects = payload.projects.map((project) => {
    if (!hasOnlyKeys(project, new Set(["id", "expected_version"]))) return null;
    const id = positiveInteger(project.id);
    const expectedVersion = positiveInteger(project.expected_version);
    return id && expectedVersion ? { id, expected_version: expectedVersion } : null;
  });
  if (projects.some((project) => !project)) {
    return failure(400, "PORTFOLIO_REORDER_INVALID", "Portfolio reorder details are invalid.");
  }
  if (new Set(projects.map(({ id }) => id)).size !== projects.length) {
    return failure(400, "PORTFOLIO_REORDER_DUPLICATE", "Portfolio reorder contains duplicate projects.");
  }
  return { ok: true, contractorId, projects };
}

async function reorderPortfolioProjects({ pool, authenticatedActor, payload } = {}) {
  const actorUserId = positiveInteger(authenticatedActor?.id);
  if (!actorUserId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  const validation = validateReorderPayload(payload);
  if (!validation.ok) return validation;

  const client = typeof pool?.connect === "function" ? await pool.connect() : pool;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const owner = await client.query(
      `SELECT id FROM contractor_profiles WHERE id = $1 AND user_id = $2 LIMIT 1 FOR UPDATE`,
      [validation.contractorId, actorUserId]
    );
    if (!owner.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(404, "PORTFOLIO_PROJECT_NOT_FOUND", "The Portfolio projects were not found.");
    }
    const active = await client.query(
      `
      SELECT id, version
      FROM contractor_projects
      WHERE contractor_id = $1
        AND publication_state IS DISTINCT FROM 'ARCHIVED'
      ORDER BY display_order ASC NULLS LAST, id ASC
      FOR UPDATE
      `,
      [validation.contractorId]
    );
    const actualIds = new Set(active.rows.map((row) => Number(row.id)));
    const suppliedIds = new Set(validation.projects.map(({ id }) => id));
    if (
      actualIds.size !== suppliedIds.size ||
      [...actualIds].some((id) => !suppliedIds.has(id))
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(
        409,
        "PORTFOLIO_REORDER_MEMBERSHIP_INVALID",
        "The complete active Portfolio membership is required."
      );
    }
    const versions = new Map(active.rows.map((row) => [Number(row.id), Number(row.version)]));
    if (validation.projects.some((project) => versions.get(project.id) !== project.expected_version)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return failure(409, "PORTFOLIO_VERSION_CONFLICT", "A Portfolio project changed before reorder.");
    }

    await client.query(
      `
      UPDATE contractor_projects
      SET display_order = NULL
      WHERE contractor_id = $1
        AND publication_state IS DISTINCT FROM 'ARCHIVED'
      `,
      [validation.contractorId]
    );
    const ordered = validation.projects.map((project, displayOrder) => ({
      ...project,
      display_order: displayOrder,
    }));
    const updated = await client.query(
      `
      UPDATE contractor_projects AS project
      SET display_order = input.display_order,
          updated_at = CURRENT_TIMESTAMP,
          version = project.version + 1
      FROM jsonb_to_recordset($1::jsonb)
        AS input(id INTEGER, expected_version INTEGER, display_order INTEGER)
      WHERE project.id = input.id
        AND project.contractor_id = $2
        AND project.version = input.expected_version
        AND project.publication_state IS DISTINCT FROM 'ARCHIVED'
      RETURNING ${OWNER_PROJECT_FIELDS.replaceAll("contractor_projects.", "project.")}
      `,
      [JSON.stringify(ordered), validation.contractorId]
    );
    if (updated.rows.length !== ordered.length) throw new Error("PORTFOLIO_REORDER_UPDATE_FAILED");
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      status: 200,
      code: "PORTFOLIO_PROJECTS_REORDERED",
      projects: updated.rows
        .sort((left, right) => Number(left.display_order) - Number(right.display_order) || Number(left.id) - Number(right.id))
        .map(serializeOwnedPortfolioProject),
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    }
    throw error;
  } finally {
    if (client && client !== pool && typeof client.release === "function") client.release();
  }
}

module.exports = {
  OWNER_PROJECT_FIELDS,
  adoptLegacyPortfolioProject,
  archivePortfolioProject,
  createPortfolioProject,
  listOwnedPortfolioProjects,
  listPublicPortfolioProjects,
  loadOwnedProject,
  publishPortfolioProject,
  reorderPortfolioProjects,
  setPortfolioFeature,
  updatePortfolioProject,
  validatePrivacyConfirmation,
  validateReorderPayload,
};
