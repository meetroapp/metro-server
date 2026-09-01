"use strict";

const {
  ARCHIVE_MIGRATION,
} = require("./manifest");
const {
  readCatalog,
  readLedger,
  readPreservation,
  tableExists,
} = require("./fingerprints");
const { OPERATIONAL_ZERO_TABLES } = require("./prestate");

async function readTargetMarkerState(client, markers) {
  const relations = markers.relations.length
    ? (await client.query(
        `SELECT relname AS marker
           FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relname = ANY($1::text[])`,
        [markers.relations]
      )).rows.map(({ marker }) => marker)
    : [];
  const columns = markers.columns.length
    ? (await client.query(
        `SELECT table_name || '.' || column_name AS marker
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name || '.' || column_name = ANY($1::text[])`,
        [markers.columns]
      )).rows.map(({ marker }) => marker)
    : [];
  return Object.freeze({
    expected: markers.count,
    present: new Set([...relations, ...columns]).size,
  });
}

async function readOperationalCounts(client) {
  const counts = {};
  for (const table of OPERATIONAL_ZERO_TABLES) {
    if (!(await tableExists(client, table))) continue;
    counts[table] = Number((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count);
  }
  return counts;
}

async function readOwnerMembership(client) {
  if (!(await tableExists(client, "business_team_memberships"))) return null;
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM contractor_profiles) AS businesses,
      count(*) FILTER (WHERE memberships.role = 'OWNER' AND memberships.status = 'ACTIVE')::int AS owners,
      count(*) FILTER (WHERE memberships.role <> 'OWNER')::int AS non_owners,
      count(*) FILTER (
        WHERE memberships.role = 'OWNER'
          AND memberships.user_id <> profiles.user_id
      )::int AS unrelated_owners,
      (
        SELECT count(*)::int
          FROM (
            SELECT contractor_profile_id
              FROM business_team_memberships
             WHERE role = 'OWNER' AND status = 'ACTIVE'
             GROUP BY contractor_profile_id
            HAVING count(*) > 1
          ) duplicates
      ) AS duplicate_owners
    FROM business_team_memberships memberships
    JOIN contractor_profiles profiles ON profiles.id = memberships.contractor_profile_id
  `);
  const row = result.rows[0];
  return Object.freeze({
    businesses: Number(row.businesses),
    owners: Number(row.owners),
    nonOwners: Number(row.non_owners),
    unrelatedOwners: Number(row.unrelated_owners),
    duplicateOwners: Number(row.duplicate_owners),
  });
}

async function readSnapshot(client, markers, { postconditions = false } = {}) {
  const version = await client.query("SHOW server_version");
  const ledger = await readLedger(client);
  const archiveLedger = ledger.find(({ filename }) => filename === ARCHIVE_MIGRATION.filename) || null;
  const snapshot = {
    postgresVersion: version.rows[0].server_version,
    ledger,
    archiveLedger,
    catalog: await readCatalog(client),
    preservation: await readPreservation(client),
    targetMarkers: await readTargetMarkerState(client, markers),
  };
  if (postconditions) {
    snapshot.operationalCounts = await readOperationalCounts(client);
    snapshot.ownerMembership = await readOwnerMembership(client);
  }
  return snapshot;
}

module.exports = Object.freeze({
  readOperationalCounts,
  readOwnerMembership,
  readSnapshot,
  readTargetMarkerState,
});
