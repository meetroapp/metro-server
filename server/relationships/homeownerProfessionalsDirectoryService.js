"use strict";

function requirePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function iso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function serializeProfessionalIdentity(row = {}) {
  return {
    contractorProfileId: positiveInteger(row.contractor_profile_id),
    professionalUserId: positiveInteger(row.professional_user_id),
    businessName: cleanText(row.business_name),
    category: cleanText(row.category),
    imageUrl: cleanText(row.image_url),
  };
}

function serializeSavedProfessional(row = {}) {
  return {
    savedProfessionalId: cleanText(row.saved_professional_id),
    ...serializeProfessionalIdentity(row),
    savedAt: iso(row.saved_at),
    workedWith: row.worked_with === true,
  };
}

function serializeWorkedWithProfessional(row = {}) {
  return {
    meetroRelationshipId: cleanText(row.meetro_relationship_id),
    ...serializeProfessionalIdentity(row),
    establishedAt: iso(row.established_at),
    lastSelectedAt: iso(row.last_selected_at),
    requestCount: nonNegativeInteger(row.request_count),
    jobCount: nonNegativeInteger(row.job_count),
    saved: row.is_saved === true,
  };
}

async function listHomeownerProfessionals({
  pool,
  homeownerUserId,
} = {}) {
  requirePool(pool);

  const actorUserId = positiveInteger(homeownerUserId);

  if (!actorUserId) {
    return {
      ok: false,
      status: 400,
      code: "HOMEOWNER_ID_INVALID",
      message: "A valid homeowner identity is required.",
    };
  }

  const savedResult = await pool.query(
    `
    /* homeowner_professionals_directory:saved */
    SELECT
      saved.id AS saved_professional_id,
      saved.contractor_profile_id,
      saved.professional_user_id,
      saved.saved_at,
      profiles.business_name,
      profiles.category,
      profiles.image_url,
      EXISTS (
        SELECT 1
        FROM meetro_customer_business_relationships relationships
        WHERE relationships.homeowner_user_id =
              saved.homeowner_user_id
          AND relationships.contractor_profile_id =
              saved.contractor_profile_id
          AND relationships.professional_user_id =
              saved.professional_user_id
      ) AS worked_with
    FROM homeowner_saved_professionals saved
    INNER JOIN contractor_profiles profiles
      ON profiles.id = saved.contractor_profile_id
     AND profiles.user_id = saved.professional_user_id
    WHERE saved.homeowner_user_id = $1
      AND saved.status = 'SAVED'
    ORDER BY saved.saved_at DESC, saved.id ASC
    `,
    [actorUserId]
  );

  const workedWithResult = await pool.query(
    `
    /* homeowner_professionals_directory:worked_with */
    SELECT
      relationships.id AS meetro_relationship_id,
      relationships.contractor_profile_id,
      relationships.professional_user_id,
      origin_selection.selected_at AS established_at,
      profiles.business_name,
      profiles.category,
      profiles.image_url,
      MAX(history_selections.selected_at) AS last_selected_at,
      COUNT(DISTINCT history_selections.id)::integer AS request_count,
      COUNT(DISTINCT jobs.id)::integer AS job_count,
      EXISTS (
        SELECT 1
        FROM homeowner_saved_professionals saved
        WHERE saved.homeowner_user_id =
              relationships.homeowner_user_id
          AND saved.contractor_profile_id =
              relationships.contractor_profile_id
          AND saved.professional_user_id =
              relationships.professional_user_id
          AND saved.status = 'SAVED'
      ) AS is_saved
    FROM meetro_customer_business_relationships relationships
    INNER JOIN contractor_profiles profiles
      ON profiles.id = relationships.contractor_profile_id
     AND profiles.user_id = relationships.professional_user_id
    INNER JOIN request_selections origin_selection
      ON origin_selection.id =
         relationships.established_from_request_selection_id
     AND origin_selection.selected_by_user_id =
         relationships.homeowner_user_id
     AND origin_selection.contractor_id =
         relationships.contractor_profile_id
     AND origin_selection.professional_user_id =
         relationships.professional_user_id
    LEFT JOIN request_selections history_selections
      ON history_selections.selected_by_user_id =
         relationships.homeowner_user_id
     AND history_selections.contractor_id =
         relationships.contractor_profile_id
     AND history_selections.professional_user_id =
         relationships.professional_user_id
    LEFT JOIN jobs
      ON jobs.source_type = 'ordinary_request_selection'
     AND jobs.source_request_selection_id =
         history_selections.id
     AND jobs.source_request_relationship_id =
         history_selections.request_relationship_id
     AND jobs.job_request_id =
         history_selections.post_id
    WHERE relationships.homeowner_user_id = $1
    GROUP BY
      relationships.id,
      relationships.contractor_profile_id,
      relationships.professional_user_id,
      relationships.homeowner_user_id,
      origin_selection.selected_at,
      profiles.business_name,
      profiles.category,
      profiles.image_url
    ORDER BY
      COALESCE(
        MAX(history_selections.selected_at),
        origin_selection.selected_at
      ) DESC,
      relationships.id ASC
    `,
    [actorUserId]
  );

  return {
    ok: true,
    status: 200,
    code: "HOMEOWNER_PROFESSIONALS_LISTED",
    saved: savedResult.rows.map(serializeSavedProfessional),
    workedWith: workedWithResult.rows.map(
      serializeWorkedWithProfessional
    ),
  };
}

module.exports = {
  listHomeownerProfessionals,
  serializeSavedProfessional,
  serializeWorkedWithProfessional,
};
