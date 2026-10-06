"use strict";

// Persistence only. The internal service supplies authorized Business scope.
const COLUMNS = `id, contractor_profile_id, provider, provider_environment,
  provider_account_id, connection_status, last_verified_at,
  created_at, updated_at, version`;

async function findConnection(database, { businessId, provider, providerEnvironment }) {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM business_provider_connections
      WHERE contractor_profile_id = $1 AND provider = $2
        AND provider_environment = $3`,
    [businessId, provider, providerEnvironment]
  );
  return result.rows[0] || null;
}

async function createConnection(database, scope, connection) {
  const result = await database.query(
    `INSERT INTO business_provider_connections
       (contractor_profile_id, provider, provider_environment,
        provider_account_id, connection_status, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
    [scope.businessId, scope.provider, scope.providerEnvironment,
      connection.providerAccountId, connection.status, connection.lastVerifiedAt]
  );
  return result.rows[0];
}

async function updateConnection(database, scope, connection, expectedVersion) {
  const result = await database.query(
    `UPDATE business_provider_connections
        SET provider_account_id = $4, connection_status = $5,
            last_verified_at = $6
      WHERE contractor_profile_id = $1 AND provider = $2
        AND provider_environment = $3 AND version = $7
        AND (provider_account_id IS NULL OR provider_account_id = $4)
        AND (last_verified_at IS NULL OR last_verified_at <= $6)
      RETURNING ${COLUMNS}`,
    [scope.businessId, scope.provider, scope.providerEnvironment,
      connection.providerAccountId, connection.status,
      connection.lastVerifiedAt, expectedVersion]
  );
  return result.rows[0] || null;
}

module.exports = { findConnection, createConnection, updateConnection };
