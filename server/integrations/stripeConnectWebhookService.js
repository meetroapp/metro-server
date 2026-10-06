"use strict";
const { createHash } = require("node:crypto");
const repository = require("./stripeConnectEventRepository");
const { API_VERSION, ACCOUNT } = require("./stripeConnectProvider");
const { reconcile } = require("./stripeConnectReconciliationService");
const THIN_TYPES = new Set(["v2.core.account.created","v2.core.account.updated","v2.core.account.closed",
  "v2.core.account[configuration.merchant].capability_status_updated","v2.core.account[configuration.merchant].updated",
  "v2.core.account[requirements].updated","v2.core.account[future_requirements].updated","v2.core.account[defaults].updated"]);
const SNAPSHOT_TYPES = new Set(["account.updated","account.application.deauthorized","account.external_account.updated","payout.failed"]);
async function receive({ pool, provider, config, rawBody, signature, format, now = new Date() } = {}) {
  if (provider?.isFakeProvider !== true || provider.providerScopeId !== config?.providerScopeId || !["TEST","LIVE"].includes(config?.environment)) throw new Error("STRIPE_CONNECT_FAKE_PROVIDER_REQUIRED");
  let event;
  try { event = await provider.verifyEvent(rawBody,signature,format); }
  catch { return { ok: false,status: 400,code: "SIGNATURE_OR_ENVELOPE_INVALID" }; }
  const bounded = (v,max) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!bounded(event?.id,255) || !/^[A-Za-z0-9_.-]+$/.test(event.id) || !bounded(event.type,255) ||
    typeof event.livemode !== "boolean" || event.livemode !== (config.environment === "LIVE")) return { ok: false,status: 400,code: "EVENT_SCOPE_INVALID" };
  let accountId, accepted, terminal = null, relatedType = null, relatedId = null;
  if (format === "THIN") {
    if (event.context != null && String(event.context) !== "@self") return { ok: false,status: 400,code: "EVENT_CONTEXT_INVALID" };
    accountId = event.related_object?.id;
    relatedType = event.related_object?.type; relatedId = accountId;
    accepted = THIN_TYPES.has(event.type) && relatedType === "v2.core.account";
    if (event.type === "v2.core.account.closed") terminal = "CLOSED";
  } else if (format === "SNAPSHOT") {
    accountId = event.account; accepted = SNAPSHOT_TYPES.has(event.type) && event.api_version === API_VERSION;
    if (event.type === "account.updated" && event.data?.object?.id !== accountId) return { ok: false,status: 400,code: "EVENT_ACCOUNT_INVALID" };
    if (event.type === "account.application.deauthorized") {
      if (!bounded(config.applicationId,100) || event.data?.object?.id !== config.applicationId) return { ok: false,status: 400,code: "EVENT_APPLICATION_INVALID" };
      terminal = "DEAUTHORIZED";
    }
  } else return { ok: false,status: 400,code: "EVENT_FORMAT_INVALID" };
  if (!ACCOUNT.test(accountId || "") || (relatedType !== null && !bounded(relatedType,100)) ||
    (event.api_version != null && !bounded(event.api_version,100))) return { ok: false,status: 400,code: "EVENT_ACCOUNT_INVALID" };
  try {
    const result = await repository.receive(pool,{ providerScopeId: config.providerScopeId,environment: config.environment,eventId: event.id,
      accountId,type: event.type,format,apiVersion: event.api_version ?? null,context: event.context == null ? null : String(event.context),
      relatedType,relatedId,hash: createHash("sha256").update(rawBody).digest("hex"),accepted,terminal,
      quarantine: format === "SNAPSHOT" && SNAPSHOT_TYPES.has(event.type) && event.api_version !== API_VERSION },now);
    return { ok: true,status: 200,code: result.conflict ? "EVENT_QUARANTINED" : "EVENT_DURABLE" };
  } catch { return { ok: false,status: 503,code: "EVENT_DURABILITY_UNAVAILABLE" }; }
}
async function processEvent({ pool,provider,config,eventId,now = new Date() } = {}) {
  if (provider?.isFakeProvider !== true || provider.providerScopeId !== config?.providerScopeId) throw new Error("STRIPE_CONNECT_FAKE_PROVIDER_REQUIRED");
  const event = await repository.claim(pool,{ providerScopeId: config.providerScopeId,environment: config.environment,eventId },now);
  if (!event) return { ok: false,code: "EVENT_NOT_CLAIMABLE" };
  const connection = (await pool.query(`SELECT contractor_profile_id FROM business_provider_connections
    WHERE id=$1 AND provider='STRIPE_PAYMENTS' AND provider_environment=$2 AND provider_account_id=$3`,
  [event.connection_id,config.environment,event.provider_account_id])).rows[0];
  if (!connection) { await repository.retry(pool,event,now); return { ok: false,code: "EVENT_BINDING_UNAVAILABLE" }; }
  const result = await reconcile({ pool,provider,scope: { businessId: connection.contractor_profile_id,
    environment: config.environment,providerScopeId: config.providerScopeId },connectionId: event.connection_id,event,now });
  if (["RECONCILIATION_PENDING","RECONCILIATION_CONFLICT"].includes(result.code)) await repository.retry(pool,event,now);
  return result;
}
module.exports = { receive, processEvent, THIN_TYPES, SNAPSHOT_TYPES };
