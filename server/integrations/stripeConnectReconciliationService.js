"use strict";
const repository = require("./stripeConnectStateRepository");
const { normalizeAccount } = require("./stripeConnectState");
const { API_VERSION } = require("./stripeConnectProvider");
const { assertScope } = require("./stripeConnectOperationRepository");
async function reconcile({ pool, provider, scope, connectionId, event = null, now = new Date(), jitterMs = 0 } = {}) {
  assertScope(scope);
  if (provider?.isFakeProvider !== true || provider.providerScopeId !== scope.providerScopeId || provider.apiVersion !== API_VERSION) throw new Error("STRIPE_CONNECT_FAKE_PROVIDER_REQUIRED");
  const lease = await repository.claim(pool,scope,connectionId,now);
  if (!lease) return { ok: false, code: "RECONCILIATION_PENDING" };
  let normalized;
  try {
    const account = await provider.retrieveAccount(lease.provider_account_id);
    normalized = normalizeAccount(account,{ accountId: lease.provider_account_id, environment: scope.environment,
      country: lease.creation_intent.country,currency: lease.creation_intent.currency,apiVersion: API_VERSION });
  } catch (error) {
    await repository.failed(pool,scope,lease,{ event,now,code: "PROVIDER_UNAVAILABLE",jitterMs,retryAfterMs:error?.retryAfterMs });
    return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  }
  if (!normalized.valid) {
    await repository.failed(pool,scope,lease,{ event,now,code: normalized.code,jitterMs });
    return { ok: false, code: normalized.code };
  }
  const result = await repository.commit(pool,scope,lease,normalized.facts,{ event,now,jitterMs });
  return result ? { ok: true, code: "ACCOUNT_RECONCILED" } : { ok: false, code: "RECONCILIATION_CONFLICT" };
}
// Internal work selector only; no timer, scheduler, router or bootstrap import.
async function dueConnections(pool, { providerScopeId, environment }, now = new Date(), limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("STRIPE_CONNECT_INVALID_LIMIT");
  return (await pool.query(`SELECT c.id AS connection_id,c.contractor_profile_id AS business_id FROM business_provider_connection_readiness r
    JOIN business_provider_connections c ON c.id=r.connection_id WHERE r.provider_scope_id=$1 AND c.provider_environment=$2
    AND r.next_reconcile_at <= $3 AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= $3)
    ORDER BY r.next_reconcile_at,r.connection_id LIMIT $4`, [providerScopeId,environment,now,limit])).rows;
}
module.exports = { reconcile, dueConnections };
