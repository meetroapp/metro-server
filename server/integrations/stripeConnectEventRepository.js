"use strict";
const { transaction } = require("./stripeConnectOperationRepository");
const readiness = require("./stripeConnectStateRepository");
async function receive(pool, receipt, now = new Date()) {
  return transaction(pool, async client => {
    // Provider identity, not caller metadata, selects a known Business binding.
    const binding = receipt.accepted ? (await client.query(`SELECT c.id FROM business_provider_connections c
      JOIN business_provider_connection_operations o ON o.connection_id=c.id
      WHERE c.provider='STRIPE_PAYMENTS' AND c.provider_environment=$1 AND c.provider_account_id=$2
      AND o.provider_scope_id=$3 AND o.operation_status='SUCCEEDED'`,
    [receipt.environment,receipt.accountId,receipt.providerScopeId])).rows[0] : null;
    const status = receipt.accepted ? binding ? "RECEIVED" : "QUARANTINED" : receipt.quarantine ? "QUARANTINED" : "IGNORED";
    const inserted = await client.query(`INSERT INTO business_provider_events
      (provider_scope_id,provider_environment,provider_event_id,provider_account_id,connection_id,event_type,payload_format,livemode,
       event_api_version,provider_context,related_object_type,related_object_id,payload_sha256,processing_status,first_received_at,last_received_at,next_attempt_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$15)
      ON CONFLICT (provider,provider_scope_id,provider_environment,provider_event_id) DO NOTHING RETURNING *`,
    [receipt.providerScopeId,receipt.environment,receipt.eventId,receipt.accountId,binding?.id ?? null,receipt.type,receipt.format,
      receipt.environment==="LIVE",receipt.apiVersion,receipt.context,receipt.relatedType,receipt.relatedId,receipt.hash,status,now]);
    if (!inserted.rowCount) {
      const existing = (await client.query(`SELECT * FROM business_provider_events WHERE provider_scope_id=$1
        AND provider_environment=$2 AND provider_event_id=$3 FOR UPDATE`, [receipt.providerScopeId,receipt.environment,receipt.eventId])).rows[0];
      const conflict = existing.payload_sha256 !== receipt.hash;
      const row = (await client.query(`UPDATE business_provider_events SET last_received_at=GREATEST(last_received_at,$2),
        processing_status=CASE WHEN $3 THEN 'QUARANTINED' ELSE processing_status END,
        last_error_code=CASE WHEN $3 THEN 'PAYLOAD_CONFLICT' ELSE last_error_code END,
        lease_generation=lease_generation+CASE WHEN $3 THEN 1 ELSE 0 END,
        lease_expires_at=CASE WHEN $3 THEN NULL ELSE lease_expires_at END WHERE id=$1 RETURNING *`, [existing.id,now,conflict])).rows[0];
      if (conflict && existing.connection_id) await readiness.invalidate(client,existing.connection_id,receipt.providerScopeId,null,now);
      return { row, duplicate: true, conflict };
    }
    const row = inserted.rows[0];
    if (binding) {
      await readiness.invalidate(client,binding.id,receipt.providerScopeId,receipt.terminal,now);
      // Terminal negative authority may block immediately, never satisfy a payment.
      if (receipt.terminal) await client.query(`UPDATE business_provider_connections SET connection_status='UNAVAILABLE' WHERE id=$1`, [binding.id]);
    }
    return { row, duplicate: false, conflict: false };
  });
}
async function claim(pool, { providerScopeId, environment, eventId }, now = new Date()) {
  return (await pool.query(`UPDATE business_provider_events SET processing_status='PROCESSING',attempt_count=attempt_count+1,
    lease_generation=lease_generation+1,lease_expires_at=$4::timestamptz+interval '2 minutes'
    WHERE provider_scope_id=$1 AND provider_environment=$2 AND provider_event_id=$3 AND connection_id IS NOT NULL
    AND processing_status IN ('RECEIVED','RETRY','PROCESSING') AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
    AND (lease_expires_at IS NULL OR lease_expires_at <= $4) RETURNING *`, [providerScopeId,environment,eventId,now])).rows[0] || null;
}
async function retry(pool, row, now = new Date()) {
  return (await pool.query(`UPDATE business_provider_events SET processing_status='RETRY',next_attempt_at=$4::timestamptz+interval '1 minute',
    last_error_code='RECONCILIATION_CONFLICT',lease_expires_at=NULL
    WHERE id=$1 AND provider_scope_id=$2 AND lease_generation=$3 AND processing_status='PROCESSING' RETURNING *`,
  [row.id,row.provider_scope_id,row.lease_generation,now])).rows[0] || null;
}
module.exports = { receive, claim, retry };
