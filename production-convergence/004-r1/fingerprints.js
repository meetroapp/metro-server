"use strict";

const base = require("../004/fingerprints");

function ownerEligibilityFingerprint(rows) {
  const normalized = rows
    .map(({ contractorProfileId, userId, userPresent }) => ({
      contractorProfileId: Number(contractorProfileId),
      userId: Number(userId),
      userPresent: userPresent === true,
    }))
    .sort((left, right) =>
      left.contractorProfileId - right.contractorProfileId || left.userId - right.userId
    );
  return base.sha256(normalized.map(({ contractorProfileId, userId, userPresent }) =>
    `${contractorProfileId}:${userId}:${userPresent ? 1 : 0}`
  ).join("\n"));
}

async function readOwnerBackfillEligibility(client) {
  const result = await client.query(`
    SELECT profiles.id AS contractor_profile_id,
           profiles.user_id,
           (users.id IS NOT NULL) AS user_present
      FROM contractor_profiles profiles
      LEFT JOIN users ON users.id = profiles.user_id
     ORDER BY profiles.id, profiles.user_id
  `);
  const rows = result.rows.map(({ contractor_profile_id, user_id, user_present }) => ({
    contractorProfileId: Number(contractor_profile_id),
    userId: Number(user_id),
    userPresent: user_present === true,
  }));
  return Object.freeze({
    profileCount: rows.length,
    eligibleProfileCount: rows.filter(({ userPresent }) => userPresent).length,
    ineligibleProfileCount: rows.filter(({ userPresent }) => !userPresent).length,
    eligibilityFingerprint: ownerEligibilityFingerprint(rows),
  });
}

module.exports = Object.freeze({
  ...base,
  ownerEligibilityFingerprint,
  readOwnerBackfillEligibility,
});
