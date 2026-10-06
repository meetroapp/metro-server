"use strict";
const { randomUUID } = require("node:crypto");
const { requireOwner, failure } = require("./stripeConnectAuthority");
const operations = require("./stripeConnectOperationRepository");
const readiness = require("./stripeConnectStateRepository");
const { reconcile } = require("./stripeConnectReconciliationService");
const { projectState, fresh } = require("./stripeConnectState");
const { API_VERSION } = require("./stripeConnectProvider");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function scopeFor(authority, config, provider) {
  const scope = { businessId: authority.business.businessId,environment: config?.environment,providerScopeId: config?.providerScopeId };
  operations.assertScope(scope);
  if (provider?.isFakeProvider !== true || provider.apiVersion !== API_VERSION || provider.providerScopeId !== scope.providerScopeId) throw new Error("STRIPE_CONNECT_FAKE_PROVIDER_REQUIRED");
  return scope;
}
async function onboard({ pool, authenticatedActor, config, provider, command, idempotencyKey, now = new Date() } = {}) {
  const authority = await requireOwner({ pool,authenticatedActor,command });
  if (!authority.ok) return authority;
  if (!UUID.test(idempotencyKey || "") || !["CONNECT", "CONTINUE"].includes(command.intent)) return failure(400,"STRIPE_CONNECT_INVALID_COMMAND");
  const scope = scopeFor(authority,config,provider);
  let connection = await operations.load(pool,scope);
  if (command.intent === "CONTINUE" && !connection?.provider_account_id) return failure(409,"STRIPE_CONNECT_BOUND_ACCOUNT_REQUIRED");
  if (!connection?.provider_account_id) {
    if (!config.countryCurrencies || !Object.hasOwn(config.countryCurrencies,command.country)) return failure(400,"STRIPE_CONNECT_COUNTRY_REQUIRED");
    const reserved = await operations.reserve(pool,scope,{ country: command.country,currency: config.countryCurrencies[command.country],actorUserId: authority.actorUserId });
    const lease = await operations.claim(pool,scope,reserved.operation.id,now);
    if (!lease) {
      connection = await operations.load(pool,scope);
      if (!connection?.provider_account_id) return failure(["AMBIGUOUS","RECOVERY_REQUIRED","REJECTED_NO_ACCOUNT"].includes(connection?.operation_status) ? 409 : 202,"STRIPE_CONNECT_SETUP_PENDING_OR_RECOVERY");
    } else {
      const dispatchAuthority = await requireOwner({ pool,authenticatedActor,command });
      if (!dispatchAuthority.ok || dispatchAuthority.business.businessId !== scope.businessId) {
        // No call dispatched. Retain the frozen operation rather than rotate keys.
        await operations.uncertain(pool,scope,lease,false,now);
        return dispatchAuthority.ok ? failure(409,"STRIPE_CONNECT_AUTHORITY_CHANGED") : dispatchAuthority;
      }
      let account;
      try { account = await provider.createAccount(lease.creation_intent,lease.stripe_idempotency_key); }
      catch (error) {
        await operations.uncertain(pool,scope,lease,error?.definitiveNoAccount === true,now);
        return failure(503,"STRIPE_CONNECT_CREATION_UNCERTAIN");
      }
      // Persistence/correlation failures do not become a new provider attempt.
      await operations.complete(pool,scope,lease,account,now);
      connection = await operations.load(pool,scope);
    }
  } else if (command.country !== undefined) {
    return failure(409,"STRIPE_CONNECT_COUNTRY_FROZEN");
  }
  const verified = await reconcile({ pool,provider,scope,connectionId: connection.id,now });
  if (!verified.ok) return failure(verified.code === "RECONCILIATION_PENDING" ? 202 : 503,verified.code);
  const state = projectState({ enabled: true,connection,scope,readiness: await readiness.load(pool,scope,connection.id),now });
  if (state.status === "CONNECTED") return { ok: true,status: 200,code: "ALREADY_CONNECTED",provider: "STRIPE_PAYMENTS",state: state.status };
  if (state.status === "UNAVAILABLE") return failure(503,"STRIPE_CONNECT_ACCOUNT_UNAVAILABLE");
  if (["VERIFICATION_PENDING","PROVIDER_REVIEW_REQUIRED"].includes(state.reason)) {
    return { ok: true,status: 200,code: state.reason,provider: "STRIPE_PAYMENTS",state: state.status };
  }
  const linkAuthority = await requireOwner({ pool,authenticatedActor,command });
  if (!linkAuthority.ok || linkAuthority.business.businessId !== scope.businessId) return failure(403,"STRIPE_CONNECT_OWNER_REQUIRED");
  try {
    // URLs come only from trusted server config; returned fake link stays transient.
    const link = await provider.createOnboardingLink(connection.provider_account_id,config.callbacks,randomUUID());
    return { ok: true,status: 200,code: "ONBOARDING_READY",provider: "STRIPE_PAYMENTS",state: state.status,
      action: "OPEN_STRIPE_ONBOARDING",onboardingUrl: link.url,expiresAt: link.expires_at };
  } catch { return failure(503,"STRIPE_CONNECT_LINK_UNAVAILABLE"); }
}
async function refresh({ pool, authenticatedActor, config, provider, now = new Date() } = {}) {
  const authority = await requireOwner({ pool,authenticatedActor,command: { intent: "REFRESH" } });
  if (!authority.ok) return authority;
  const scope = scopeFor(authority,config,provider);
  const connection = await operations.load(pool,scope);
  if (!connection?.provider_account_id) return failure(409,"STRIPE_CONNECT_BOUND_ACCOUNT_REQUIRED");
  const cached = await readiness.load(pool,scope,connection.id);
  if (Number(cached?.attempt_count)>0 && now-new Date(cached.updated_at)<30000) return { ok: true,status: 202,code: "RECONCILIATION_COALESCED" };
  const result = await reconcile({ pool,provider,scope,connectionId: connection.id,now });
  return { ok: result.ok,status: result.ok ? 200 : result.code === "RECONCILIATION_PENDING" ? 202 : 503,code: result.code };
}
module.exports = { onboard, refresh };
