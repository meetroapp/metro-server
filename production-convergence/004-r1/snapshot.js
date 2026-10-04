"use strict";

const baseSnapshot = require("../004/snapshot");
const { readOwnerBackfillEligibility, tableExists } = require("./fingerprints");

async function readOwnerMembership(client) {
  if (!(await tableExists(client, "business_team_memberships"))) return null;
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM contractor_profiles) AS businesses,
      (SELECT count(*)::int
         FROM contractor_profiles profiles
         JOIN users ON users.id = profiles.user_id) AS eligible_businesses,
      (SELECT count(*)::int
         FROM contractor_profiles profiles
         LEFT JOIN users ON users.id = profiles.user_id
        WHERE users.id IS NULL) AS ineligible_businesses,
      count(*) FILTER (WHERE memberships.role = 'OWNER' AND memberships.status = 'ACTIVE')::int AS owners,
      count(*) FILTER (WHERE memberships.role <> 'OWNER')::int AS non_owners,
      count(*) FILTER (
        WHERE memberships.role = 'OWNER'
          AND memberships.user_id <> profiles.user_id
      )::int AS unrelated_owners,
      (SELECT count(*)::int
         FROM contractor_profiles profiles
         LEFT JOIN business_team_memberships memberships
           ON memberships.contractor_profile_id = profiles.id
        WHERE memberships.id IS NULL) AS businesses_without_membership,
      (SELECT count(*)::int
         FROM (
           SELECT contractor_profile_id
             FROM business_team_memberships
            WHERE role = 'OWNER' AND status = 'ACTIVE'
            GROUP BY contractor_profile_id
           HAVING count(*) > 1
         ) duplicates) AS duplicate_owners
    FROM business_team_memberships memberships
    JOIN contractor_profiles profiles
      ON profiles.id = memberships.contractor_profile_id
  `);
  const row = result.rows[0];
  return Object.freeze({
    businesses: Number(row.businesses),
    eligibleBusinesses: Number(row.eligible_businesses),
    ineligibleBusinesses: Number(row.ineligible_businesses),
    owners: Number(row.owners),
    businessesWithoutMembership: Number(row.businesses_without_membership),
    duplicateOwners: Number(row.duplicate_owners),
    nonOwners: Number(row.non_owners),
    unrelatedOwners: Number(row.unrelated_owners),
  });
}

async function readSnapshot(client, markers, { postconditions = false } = {}) {
  const snapshot = await baseSnapshot.readSnapshot(client, markers, { postconditions });
  snapshot.ownerBackfillEligibility = await readOwnerBackfillEligibility(client);
  if (postconditions) snapshot.ownerMembership = await readOwnerMembership(client);
  return snapshot;
}

module.exports = Object.freeze({
  ...baseSnapshot,
  readOwnerMembership,
  readSnapshot,
});
