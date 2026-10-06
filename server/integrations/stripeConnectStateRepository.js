"use strict";
const { transaction, assertScope } = require("./stripeConnectOperationRepository");
const { projectState, FRESH_MS, RECONCILE_MS } = require("./stripeConnectState");
const { API_VERSION } = require("./stripeConnectProvider");
async function load(database, scope, connectionId) {
  assertScope(scope);
  return (await database.query(`SELECT r.*,c.provider_account_id,c.provider_environment,c.contractor_profile_id
    FROM business_provider_connection_readiness r JOIN business_provider_connections c ON c.id=r.connection_id
    WHERE r.connection_id=$1 AND r.provider_scope_id=$2 AND c.contractor_profile_id=$3 AND c.provider_environment=$4`,
  [connectionId, scope.providerScopeId, scope.businessId, scope.environment])).rows[0] || null;
}
async function invalidate(client, connectionId, providerScopeId, terminal = null, now = new Date()) {
  return (await client.query(`UPDATE business_provider_connection_readiness SET invalidated_at=$3,
    invalidation_generation=invalidation_generation+1,next_reconcile_at=$3,
    verification_status=CASE WHEN $4::text IS NOT NULL THEN 'TERMINAL' ELSE verification_status END,
    closed=CASE WHEN $4='CLOSED' THEN TRUE ELSE closed END,
    deauthorized=CASE WHEN $4='DEAUTHORIZED' THEN TRUE ELSE deauthorized END
    WHERE connection_id=$1 AND provider_scope_id=$2 RETURNING *`, [connectionId, providerScopeId, now, terminal])).rows[0] || null;
}
async function claim(pool, scope, connectionId, now = new Date()) {
  assertScope(scope);
  return transaction(pool, async client => {
    const row = (await client.query(`SELECT r.*,c.provider_account_id,c.provider_environment,c.contractor_profile_id,o.creation_intent
      FROM business_provider_connection_readiness r JOIN business_provider_connections c ON c.id=r.connection_id
      JOIN business_provider_connection_operations o ON o.connection_id=c.id
      WHERE r.connection_id=$1 AND r.provider_scope_id=$2 AND c.contractor_profile_id=$3 AND c.provider_environment=$4
      AND o.operation_status='SUCCEEDED' AND o.provider_scope_id=$2 FOR UPDATE OF r`,
    [connectionId, scope.providerScopeId, scope.businessId, scope.environment])).rows[0];
    if (!row || (row.lease_expires_at && now < new Date(row.lease_expires_at))) return null;
    const lease = (await client.query(`UPDATE business_provider_connection_readiness SET lease_generation=lease_generation+1,
      lease_expires_at=$2::timestamptz+interval '2 minutes',attempt_count=attempt_count+1
      WHERE connection_id=$1 RETURNING *`, [connectionId, now])).rows[0];
    return { ...row, ...lease };
  });
}
async function lockCommit(client, scope, claimRow, event, now) {
  // Same lock order as webhook ingress: event -> readiness -> connection.
  if (event) {
    const e = (await client.query(`SELECT *,clock_timestamp() AS authority_clock FROM business_provider_events WHERE id=$1 AND provider_scope_id=$2 FOR UPDATE`, [event.id, scope.providerScopeId])).rows[0];
    if (!e || e.connection_id !== claimRow.connection_id || e.processing_status !== "PROCESSING" ||
      Number(e.lease_generation) !== Number(event.lease_generation) || now >= new Date(e.lease_expires_at) || new Date(e.authority_clock) >= new Date(e.lease_expires_at)) return null;
  }
  const row = (await client.query(`SELECT r.*,clock_timestamp() AS authority_clock FROM business_provider_connection_readiness r
    JOIN business_provider_connections c ON c.id=r.connection_id WHERE r.connection_id=$1 AND r.provider_scope_id=$2
    AND c.contractor_profile_id=$3 AND c.provider_environment=$4 AND c.provider_account_id=$5 FOR UPDATE OF r`,
    [claimRow.connection_id, scope.providerScopeId,scope.businessId,scope.environment,claimRow.provider_account_id])).rows[0];
  if (!row || Number(row.lease_generation) !== Number(claimRow.lease_generation) ||
    Number(row.invalidation_generation) !== Number(claimRow.invalidation_generation) || now >= new Date(row.lease_expires_at) ||
    new Date(row.authority_clock) >= new Date(row.lease_expires_at)) return null;
  return row;
}
async function commit(pool, scope, claimRow, facts, { event = null, now = new Date(), jitterMs = 0 } = {}) {
  assertScope(scope);
  if (!Number.isInteger(jitterMs) || jitterMs < 0 || jitterMs > 30000) throw new Error("STRIPE_CONNECT_INVALID_JITTER");
  return transaction(pool, async client => {
    const previous = await lockCommit(client, scope, claimRow, event, now);
    if (!previous) return false;
    const terminal = previous.verification_status === "TERMINAL" || facts.closed || facts.deauthorized;
    const preserved = { ...facts, closed: previous.closed || facts.closed, deauthorized: previous.deauthorized || facts.deauthorized };
    const deadline = preserved.future_requirements_due_at ? new Date(preserved.future_requirements_due_at).getTime() : Infinity;
    // A fresh retrieval has already observed an elapsed deadline. Resume the
    // normal cadence instead of repeatedly selecting immediately due work.
    const next = new Date(Math.min(now.getTime()+RECONCILE_MS+jitterMs,deadline > now.getTime() ? deadline : Infinity));
    const result = (await client.query(`UPDATE business_provider_connection_readiness SET
      verification_status=$3,merchant_applied=$4,card_payments_status=$5,payouts_status=$6,
      requirements_currently_due_count=$7,requirements_past_due_count=$8,blocking_error_count=$9,
      future_requirements_due_at=$10,responsibilities_match=$11,scope_match=$12,closed=$13,deauthorized=$14,
      last_retrieved_at=$15,stale_after=$16,invalidated_at=NULL,last_error_code=NULL,
      last_successful_event_ledger_id=COALESCE($17,last_successful_event_ledger_id),next_reconcile_at=$18,lease_expires_at=NULL
      WHERE connection_id=$1 AND provider_scope_id=$2 RETURNING *`,
    [claimRow.connection_id, scope.providerScopeId, terminal ? "TERMINAL" : "VERIFIED",
      preserved.merchant_applied,preserved.card_payments_status,preserved.payouts_status,
      preserved.requirements_currently_due_count,preserved.requirements_past_due_count,preserved.blocking_error_count,
      preserved.future_requirements_due_at,preserved.responsibilities_match,preserved.scope_match,preserved.closed,preserved.deauthorized,
      now,new Date(now.getTime()+FRESH_MS),event?.id ?? null,next])).rows[0];
    const connection = { provider: "STRIPE_PAYMENTS", provider_environment: scope.environment,
      contractor_profile_id: scope.businessId, provider_account_id: claimRow.provider_account_id };
    const state = projectState({ enabled: true, connection, readiness: result, scope, now });
    const bound = await client.query(`UPDATE business_provider_connections SET connection_status=$5,last_verified_at=$6
      WHERE id=$1 AND contractor_profile_id=$2 AND provider_environment=$3 AND provider_account_id=$4 RETURNING id`,
    [claimRow.connection_id,scope.businessId,scope.environment,claimRow.provider_account_id,state.status,now]);
    if (!bound.rowCount) throw new Error("STRIPE_CONNECT_BINDING_CONFLICT");
    if (event) await client.query(`UPDATE business_provider_events SET processing_status='PROCESSED',processed_at=$2,
      lease_expires_at=NULL,next_attempt_at=NULL,last_error_code=NULL,retrieval_api_version=$3 WHERE id=$1`, [event.id,now,API_VERSION]);
    return result;
  });
}
async function failed(pool, scope, claimRow, { event = null, code = "PROVIDER_UNAVAILABLE", now = new Date(), jitterMs = 0, retryAfterMs = 0 } = {}) {
  assertScope(scope);
  if (!["PROVIDER_UNAVAILABLE", "ACCOUNT_SHAPE_UNSUPPORTED", "ACCOUNT_SCOPE_MISMATCH"].includes(code)) code = "PROVIDER_UNAVAILABLE";
  return transaction(pool, async client => {
    const previous = await lockCommit(client, scope, claimRow, event, now);
    if (!previous) return false;
    const delays = [60000,300000,900000,3600000,21600000];
    const retryAfter = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 21600000 ? retryAfterMs : 0;
    const jitter = Number.isInteger(jitterMs) && jitterMs >= 0 && jitterMs <= 30000 ? jitterMs : 0;
    const next = new Date(now.getTime()+Math.max(retryAfter,delays[Math.min(Math.max(Number(previous.attempt_count)-1,0),delays.length-1)])+jitter);
    await client.query(`UPDATE business_provider_connection_readiness SET
      verification_status=CASE WHEN verification_status='TERMINAL' THEN 'TERMINAL' ELSE 'FAILED' END,
      last_error_code=$3,next_reconcile_at=$4,lease_expires_at=NULL
      WHERE connection_id=$1 AND provider_scope_id=$2`, [claimRow.connection_id,scope.providerScopeId,code,next]);
    await client.query(`UPDATE business_provider_connections SET connection_status='UNAVAILABLE'
      WHERE id=$1 AND contractor_profile_id=$2 AND provider_environment=$3 AND provider_account_id=$4`,
    [claimRow.connection_id,scope.businessId,scope.environment,claimRow.provider_account_id]);
    if (event) await client.query(`UPDATE business_provider_events SET processing_status=$2,
      last_error_code=$3,next_attempt_at=$4,lease_expires_at=NULL WHERE id=$1`,
    [event.id,now-new Date(event.first_received_at)>=86400000 ? "REVIEW_REQUIRED" : "RETRY",code,next]);
    return true;
  });
}
module.exports = { load, invalidate, claim, commit, failed };
