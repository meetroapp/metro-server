"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { API_VERSION, ACCOUNT } = require("./stripeConnectProvider");
const fail = code => { throw new Error(code); };
function assertScope(scope) {
  if (!Number.isSafeInteger(scope?.businessId) || scope.businessId <= 0 ||
    !["TEST", "LIVE"].includes(scope.environment) || typeof scope.providerScopeId !== "string" ||
    !/^[A-Za-z0-9_.:/-]{1,200}$/.test(scope.providerScopeId)) fail("STRIPE_CONNECT_INVALID_SCOPE");
}
async function transaction(pool, work) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function load(database, scope) {
  assertScope(scope);
  const result = await database.query(`SELECT c.*, o.id AS operation_id, o.operation_status
    FROM business_provider_connections c LEFT JOIN business_provider_connection_operations o ON o.connection_id=c.id
    WHERE c.contractor_profile_id=$1 AND c.provider='STRIPE_PAYMENTS' AND c.provider_environment=$2
      AND (o.provider_scope_id IS NULL OR o.provider_scope_id=$3)`, [scope.businessId, scope.environment, scope.providerScopeId]);
  return result.rows[0] || null;
}
async function reserve(pool, scope, { country, currency, actorUserId }) {
  assertScope(scope);
  if (!/^[a-z]{2}$/.test(country || "") || !/^[a-z]{3}$/.test(currency || "") ||
      !Number.isSafeInteger(actorUserId) || actorUserId <= 0) fail("STRIPE_CONNECT_INVALID_INTENT");
  return transaction(pool, async client => {
    await client.query(`INSERT INTO business_provider_connections (contractor_profile_id,provider,provider_environment)
      VALUES ($1,'STRIPE_PAYMENTS',$2) ON CONFLICT (contractor_profile_id,provider) DO NOTHING`, [scope.businessId, scope.environment]);
    const connection = (await client.query(`SELECT * FROM business_provider_connections
      WHERE contractor_profile_id=$1 AND provider='STRIPE_PAYMENTS' FOR UPDATE`, [scope.businessId])).rows[0];
    if (connection.provider_environment !== scope.environment) fail("STRIPE_CONNECT_SCOPE_CONFLICT");
    let operation = (await client.query(`SELECT * FROM business_provider_connection_operations WHERE connection_id=$1`, [connection.id])).rows[0];
    if (operation) {
      if (operation.provider_scope_id !== scope.providerScopeId || operation.creation_intent.country !== country ||
        operation.creation_intent.currency !== currency) fail("STRIPE_CONNECT_INTENT_CONFLICT");
    } else {
      if (connection.provider_account_id) fail("STRIPE_CONNECT_BINDING_WITHOUT_OPERATION");
      const id = randomUUID();
      const intent = { country, currency, dashboard: "full", cardRequested: true, feesCollector: "stripe", lossesCollector: "stripe", operationId: id, connectionId: connection.id };
      const hash = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
      operation = (await client.query(`INSERT INTO business_provider_connection_operations
        (id,connection_id,provider_scope_id,api_version,stripe_idempotency_key,request_sha256,creation_intent,created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, connection.id, scope.providerScopeId, API_VERSION, randomUUID(), hash, intent, actorUserId])).rows[0];
    }
    return { connection, operation };
  });
}
async function claim(pool, scope, operationId, now = new Date()) {
  assertScope(scope);
  return transaction(pool, async client => {
    const operation = (await client.query(`SELECT o.* FROM business_provider_connection_operations o
      JOIN business_provider_connections c ON c.id=o.connection_id
      WHERE o.id=$1 AND o.provider_scope_id=$2 AND c.contractor_profile_id=$3 AND c.provider_environment=$4
      FOR UPDATE OF o`, [operationId, scope.providerScopeId, scope.businessId, scope.environment])).rows[0];
    if (!operation || ["SUCCEEDED", "RECOVERY_REQUIRED", "REJECTED_NO_ACCOUNT"].includes(operation.operation_status)) return null;
    if (operation.replay_deadline_at && now >= new Date(operation.replay_deadline_at)) {
      await client.query(`UPDATE business_provider_connection_operations SET operation_status='RECOVERY_REQUIRED',lease_expires_at=NULL
        WHERE id=$1`, [operation.id]); return null;
    }
    if (operation.lease_expires_at && now < new Date(operation.lease_expires_at)) return null;
    if (operation.next_attempt_at && now < new Date(operation.next_attempt_at)) return null;
    return (await client.query(`UPDATE business_provider_connection_operations SET operation_status='IN_FLIGHT',
      first_dispatched_at=COALESCE(first_dispatched_at,$2),replay_deadline_at=COALESCE(replay_deadline_at,$2::timestamptz+interval '29 days'),
      attempt_count=attempt_count+1,lease_generation=lease_generation+1,lease_expires_at=$2::timestamptz+interval '2 minutes'
      WHERE id=$1 RETURNING *`, [operation.id, now])).rows[0];
  });
}
async function complete(pool, scope, claimRow, account, now = new Date()) {
  assertScope(scope);
  if (account?.object !== "v2.core.account" || !ACCOUNT.test(account.id || "") || account.livemode !== (scope.environment === "LIVE") ||
    account.metadata?.meetro_operation !== claimRow.id || account.metadata?.meetro_connection !== claimRow.connection_id) fail("STRIPE_CONNECT_ACCOUNT_CORRELATION_MISMATCH");
  return transaction(pool, async client => {
    const row = (await client.query(`SELECT o.*,clock_timestamp() AS authority_clock FROM business_provider_connection_operations o
      JOIN business_provider_connections c ON c.id=o.connection_id WHERE o.id=$1 AND o.provider_scope_id=$2
      AND c.contractor_profile_id=$3 AND c.provider_environment=$4 FOR UPDATE OF o`,
      [claimRow.id, scope.providerScopeId,scope.businessId,scope.environment])).rows[0];
    if (!row || row.connection_id !== claimRow.connection_id) fail("STRIPE_CONNECT_OPERATION_CONFLICT");
    if (row.operation_status === "SUCCEEDED") { if (row.provider_account_id !== account.id) fail("STRIPE_CONNECT_ACCOUNT_CONFLICT"); return row; }
    if (row.operation_status !== "IN_FLIGHT" || Number(row.lease_generation) !== Number(claimRow.lease_generation) ||
      now >= new Date(row.lease_expires_at) || new Date(row.authority_clock) >= new Date(row.lease_expires_at)) fail("STRIPE_CONNECT_LEASE_CONFLICT");
    const bound = await client.query(`UPDATE business_provider_connections SET provider_account_id=$2,connection_status='UNAVAILABLE'
      WHERE id=$1 AND contractor_profile_id=$3 AND provider_environment=$4
      AND (provider_account_id IS NULL OR provider_account_id=$2) RETURNING id`, [row.connection_id, account.id, scope.businessId, scope.environment]);
    if (!bound.rowCount) fail("STRIPE_CONNECT_ACCOUNT_CONFLICT");
    const result = (await client.query(`UPDATE business_provider_connection_operations SET operation_status='SUCCEEDED',
      provider_account_id=$2,completed_at=$3,lease_expires_at=NULL,next_attempt_at=NULL,last_error_code=NULL
      WHERE id=$1 RETURNING *`, [row.id, account.id, now])).rows[0];
    await client.query(`INSERT INTO business_provider_connection_readiness (connection_id,provider_scope_id,verification_api_version,next_reconcile_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT (connection_id) DO NOTHING`, [row.connection_id, scope.providerScopeId, API_VERSION, now]);
    return result;
  });
}
async function uncertain(pool, scope, claimRow, definitive = false, now = new Date()) {
  assertScope(scope);
  return (await pool.query(`UPDATE business_provider_connection_operations SET operation_status=$4,
    last_error_code=$5,lease_expires_at=NULL,next_attempt_at=$6
    WHERE id=$1 AND provider_scope_id=$2 AND lease_generation=$3 AND operation_status='IN_FLIGHT'
      AND lease_expires_at > $7 AND lease_expires_at > clock_timestamp()
      AND connection_id IN (SELECT id FROM business_provider_connections WHERE contractor_profile_id=$8 AND provider_environment=$9) RETURNING *`,
  [claimRow.id, scope.providerScopeId, claimRow.lease_generation, definitive ? "REJECTED_NO_ACCOUNT" : "AMBIGUOUS",
    definitive ? "PROVIDER_REJECTED_NO_ACCOUNT" : "PROVIDER_UNCERTAIN", definitive ? null : new Date(now.getTime() + 60000),now,scope.businessId,scope.environment])).rows[0] || null;
}
module.exports = { assertScope, transaction, load, reserve, claim, complete, uncertain };
