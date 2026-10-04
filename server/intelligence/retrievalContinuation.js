"use strict";

const { isPlainObject } = require("./intelligenceGatewayContracts");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORDS = 10;
function invalid() { throw Object.assign(new Error("This conversation context is unavailable. Reopen the record or search again."), { code: "intelligence_continuation_invalid" }); }
async function loadRetrievalContinuation(base, value) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !["reference", "index"].includes(key)) || !UUID.test(value.reference || "") ||
    (Object.hasOwn(value, "index") && (!Number.isInteger(value.index) || value.index < 0 || value.index >= MAX_RECORDS))) invalid();
  // A result UUID is a lookup handle, never permission. No new credential or
  // unsigned caller-supplied record list is accepted. Expiry uses database time.
  let result;
  try { result = await base.pool.query(`/* companion_retrieval:continuation */
    SELECT result_payload FROM intelligence_operation_idempotency
    WHERE id=$1 AND actor_user_id=$2 AND authority_scope=$3
      AND operation='companion.converse' AND status='completed'
      AND completed_at > CURRENT_TIMESTAMP - INTERVAL '15 minutes'
      AND completed_at <= CURRENT_TIMESTAMP LIMIT 1`,
  [value.reference, base.authenticatedActor.id, `user:${base.authenticatedActor.id}`]); } catch { throw Object.assign(new Error("Conversation retrieval is temporarily unavailable."), { code: "intelligence_retrieval_unavailable" }); }
  const resolution = result.rows[0]?.result_payload?.resolution;
  if (!resolution || resolution.version !== 1 || resolution.audience !== base.authenticatedActor.role || !Array.isArray(resolution.records) || resolution.records.length > MAX_RECORDS) invalid();
  if (Object.hasOwn(value, "index")) {
    const selected = resolution.records[value.index];
    if (!selected) invalid();
    return [selected];
  }
  return resolution.records;
}
module.exports = { loadRetrievalContinuation, MAX_RECORDS };
