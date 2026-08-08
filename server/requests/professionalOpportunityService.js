"use strict";

function requireDatabasePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
}

const OPPORTUNITY_COLUMNS = `
  posts.id,
  posts.user_id,
  posts.title,
  posts.description,
  posts.category,
  posts.request_category,
  posts.service_domain,
  posts.service_specialty,
  posts.location,
  posts.location_intake_mode,
  posts.location_normalization_status,
  posts.service_address_line1,
  posts.service_city,
  posts.service_region,
  posts.service_postal_code,
  posts.service_country_code,
  posts.discovery_area_label,
  posts.unit_number,
  posts.access_notes,
  posts.status,
  posts.created_at,
  posts.updated_at,
  posts.image_url,
  posts.request_photos
`;

function unavailableResponseProjection(request) {
  return {
    ...request,
    has_responded: false,
    professional_response_id: null,
    response_status: null,
    relationship_status: null,
    submitted_at: null,
    response_submission_available: false,
  };
}

function availableResponseProjection(request) {
  return {
    ...request,
    has_responded: false,
    professional_response_id: null,
    response_status: null,
    relationship_status: null,
    submitted_at: null,
    response_submission_available: true,
  };
}

function canonicalResponseProjection(request, row) {
  const linked = Boolean(
    row &&
      String(row.professional_response_id || "") &&
      String(row.relationship_response_id) ===
        String(row.professional_response_id) &&
      Number(row.relationship_post_id) === Number(row.post_id) &&
      Number(row.response_post_id) === Number(row.post_id) &&
      Number(row.relationship_contractor_id) === Number(row.contractor_id) &&
      Number(row.relationship_professional_user_id) ===
        Number(row.professional_user_id) &&
      Number(row.relationship_homeowner_id) ===
        Number(row.response_homeowner_id) &&
      row.relationship_emergency_request_id == null &&
      row.ordinary_authority_source === "professional_response" &&
      row.conversation_exists !== true &&
      row.response_status === "submitted" &&
      row.relationship_status === "pending" &&
      Number(row.relationship_current_version) ===
        Number(row.response_current_version)
  );

  if (!linked) return unavailableResponseProjection(request);

  return {
    ...request,
    has_responded: true,
    professional_response_id: row.professional_response_id,
    response_status: row.response_status,
    relationship_status: row.relationship_status,
    submitted_at: row.submitted_at,
    response_submission_available: false,
  };
}

async function listProfessionalOpportunities({
  pool,
  professionalUserId,
  professionalCanSeeRequest,
}) {
  requireDatabasePool(pool);

  if (typeof professionalCanSeeRequest !== "function") {
    throw new TypeError("professionalCanSeeRequest is required.");
  }

  const profileResult = await pool.query(
    `
    SELECT id, user_id, category, profile_details
    FROM contractor_profiles
    WHERE user_id = $1
    ORDER BY id ASC
    LIMIT 2
    `,
    [professionalUserId]
  );

  if (profileResult.rows.length === 0) {
    return {
      ok: false,
      status: 403,
      code: "PROFESSIONAL_PROFILE_REQUIRED",
      message: "A business profile is required to view request opportunities.",
    };
  }

  if (profileResult.rows.length > 1) {
    return {
      ok: false,
      status: 409,
      code: "PROFESSIONAL_PROFILE_AMBIGUOUS",
      message: "A single business profile is required to view request opportunities.",
    };
  }

  const profile = profileResult.rows[0];
  const candidateResult = await pool.query(
    `
    SELECT ${OPPORTUNITY_COLUMNS}
    FROM posts
    WHERE posts.status = 'open'
      AND posts.user_id <> $1
      AND posts.location_normalization_status = 'normalized'
      AND NOT EXISTS (
        SELECT 1
        FROM request_selections
        WHERE request_selections.post_id = posts.id
          AND request_selections.ended_at IS NULL
      )
    ORDER BY posts.created_at DESC
    `,
    [professionalUserId]
  );

  const eligibleRequests = candidateResult.rows.filter((request) =>
    professionalCanSeeRequest(profile, request)
  );

  if (eligibleRequests.length === 0) {
    return { ok: true, opportunities: [] };
  }

  const responseStateResult = await pool.query(
    `
    SELECT
      request_relationships.post_id,
      request_relationships.id AS relationship_id,
      request_relationships.professional_response_id
        AS relationship_response_id,
      request_relationships.post_id AS relationship_post_id,
      request_relationships.emergency_request_id
        AS relationship_emergency_request_id,
      request_relationships.contractor_id
        AS relationship_contractor_id,
      request_relationships.homeowner_id
        AS relationship_homeowner_id,
      request_relationships.professional_user_id
        AS relationship_professional_user_id,
      request_relationships.status AS relationship_status,
      request_relationships.ordinary_authority_source,
      request_relationships.current_version
        AS relationship_current_version,
      professional_responses.id AS professional_response_id,
      professional_responses.post_id AS response_post_id,
      professional_responses.homeowner_id AS response_homeowner_id,
      professional_responses.contractor_id,
      professional_responses.professional_user_id,
      professional_responses.status AS response_status,
      professional_responses.current_version AS response_current_version,
      professional_responses.submitted_at,
      EXISTS (
        SELECT 1
        FROM conversations
        WHERE conversations.relationship_id = request_relationships.id
      ) AS conversation_exists
    FROM request_relationships
    LEFT JOIN professional_responses
      ON professional_responses.id =
        request_relationships.professional_response_id
      AND professional_responses.request_relationship_id =
        request_relationships.id
    WHERE request_relationships.post_id = ANY($1::int[])
      AND request_relationships.emergency_request_id IS NULL
      AND request_relationships.contractor_id = $2
      AND request_relationships.professional_user_id = $3
    ORDER BY request_relationships.post_id ASC,
      request_relationships.id ASC
    `,
    [eligibleRequests.map((request) => request.id), profile.id, professionalUserId]
  );

  const rowsByRequest = new Map();
  for (const row of responseStateResult.rows) {
    const requestId = Number(row.post_id);
    const existing = rowsByRequest.get(requestId) || [];
    existing.push(row);
    rowsByRequest.set(requestId, existing);
  }

  const opportunities = eligibleRequests.map((request) => {
    const rows = rowsByRequest.get(Number(request.id)) || [];
    if (rows.length === 0) return availableResponseProjection(request);
    if (rows.length !== 1) return unavailableResponseProjection(request);

    const row = rows[0];
    if (!row.professional_response_id) {
      return unavailableResponseProjection(request);
    }

    return canonicalResponseProjection(request, row);
  });

  return { ok: true, opportunities };
}

module.exports = {
  listProfessionalOpportunities,
};
