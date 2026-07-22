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
  posts.status,
  posts.created_at,
  posts.updated_at,
  posts.image_url,
  posts.request_photos
`;

async function materializeProfessionalOpportunities({
  pool,
  professionalUserId,
  professionalCanSeeRequest,
}) {
  requireDatabasePool(pool);

  if (typeof professionalCanSeeRequest !== "function") {
    throw new TypeError("professionalCanSeeRequest is required.");
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  try {
    await client.query("BEGIN");

    const profileResult = await client.query(
      `
      SELECT id, user_id, category, profile_details
      FROM contractor_profiles
      WHERE user_id = $1
      ORDER BY id ASC
      LIMIT 1
      FOR SHARE
      `,
      [professionalUserId]
    );

    if (profileResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 403,
        code: "PROFESSIONAL_PROFILE_REQUIRED",
        message: "A business profile is required to view request opportunities.",
      };
    }

    const profile = profileResult.rows[0];
    const candidateResult = await client.query(
      `
      SELECT ${OPPORTUNITY_COLUMNS}
      FROM posts
      WHERE posts.status = 'open'
        AND posts.user_id <> $1
      ORDER BY posts.created_at DESC
      `,
      [professionalUserId]
    );
    const candidateIds = candidateResult.rows
      .filter((request) => professionalCanSeeRequest(profile, request))
      .map((request) => request.id);

    if (candidateIds.length === 0) {
      await client.query("COMMIT");
      return { ok: true, opportunities: [] };
    }

    const lockedResult = await client.query(
      `
      SELECT ${OPPORTUNITY_COLUMNS}
      FROM posts
      WHERE posts.id = ANY($2::integer[])
        AND posts.status = 'open'
        AND posts.user_id <> $1
      ORDER BY posts.created_at DESC
      FOR UPDATE
      `,
      [professionalUserId, candidateIds]
    );
    const eligibleRequests = lockedResult.rows.filter((request) =>
      professionalCanSeeRequest(profile, request)
    );

    if (eligibleRequests.length === 0) {
      await client.query("COMMIT");
      return { ok: true, opportunities: [] };
    }

    const eligibleIds = eligibleRequests.map((request) => request.id);
    const identityResult = await client.query(
      `
      WITH eligible_posts AS (
        SELECT posts.id, posts.user_id
        FROM posts
        WHERE posts.id = ANY($3::integer[])
          AND posts.status = 'open'
          AND posts.user_id <> $1
      ),
      materialized_relationships AS (
        INSERT INTO request_relationships
        (
          post_id,
          homeowner_id,
          contractor_id,
          professional_user_id,
          status,
          introduction_text
        )
        SELECT
          eligible_posts.id,
          eligible_posts.user_id,
          $2,
          $1,
          'active',
          ''
        FROM eligible_posts
        ON CONFLICT (post_id, contractor_id)
        DO UPDATE SET
          status = CASE
            WHEN request_relationships.status IN ('pending', 'active')
              THEN 'active'
            ELSE request_relationships.status
          END,
          updated_at = CASE
            WHEN request_relationships.status = 'pending'
              THEN CURRENT_TIMESTAMP
            ELSE request_relationships.updated_at
          END
        WHERE request_relationships.homeowner_id = EXCLUDED.homeowner_id
          AND request_relationships.professional_user_id = EXCLUDED.professional_user_id
        RETURNING
          id,
          post_id,
          homeowner_id,
          contractor_id,
          professional_user_id,
          status
      ),
      active_relationships AS (
        SELECT *
        FROM materialized_relationships
        WHERE status = 'active'
      ),
      materialized_conversations AS (
        INSERT INTO conversations
        (
          relationship_id,
          homeowner_id,
          contractor_id,
          professional_user_id,
          status
        )
        SELECT
          active_relationships.id,
          active_relationships.homeowner_id,
          active_relationships.contractor_id,
          active_relationships.professional_user_id,
          'active'
        FROM active_relationships
        ON CONFLICT (relationship_id)
        DO UPDATE SET updated_at = conversations.updated_at
        WHERE conversations.homeowner_id = EXCLUDED.homeowner_id
          AND conversations.contractor_id = EXCLUDED.contractor_id
          AND conversations.professional_user_id = EXCLUDED.professional_user_id
        RETURNING id, relationship_id
      )
      SELECT
        active_relationships.post_id,
        materialized_conversations.id AS conversation_id
      FROM active_relationships
      JOIN materialized_conversations
        ON materialized_conversations.relationship_id = active_relationships.id
      `,
      [professionalUserId, profile.id, eligibleIds]
    );

    const conversationIds = new Map(
      identityResult.rows.map((row) => [
        Number(row.post_id),
        Number(row.conversation_id),
      ])
    );
    const opportunities = eligibleRequests
      .map((request) => ({
        ...request,
        conversation_id: conversationIds.get(Number(request.id)) ?? null,
      }))
      .filter((request) => Number.isSafeInteger(request.conversation_id));

    await client.query("COMMIT");
    return { ok: true, opportunities };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original operation error.
    }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

module.exports = {
  materializeProfessionalOpportunities,
};
