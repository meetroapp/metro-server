"use strict";

const { businessDocumentNumberingInternals: { resolveBusinessDocumentOwner } } = require("../documents/businessDocumentNumberingService");
const { customerPartyInternals: { customerPartyProjection, loadOwnedCustomerParty, sameCustomerParty } } = require("./customerPartyService");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A working document alone is mutable presentation. Historical save receipts
// qualify only through the immutable source of an exact canonical Quote.
async function loadEvidence(client, jobId) {
  const result = await client.query(`/* customer_party:reconciliation_evidence */
    SELECT job_id::text, contractor_profile_id::text, business_contact_id::text,
      business_customer_relationship_id::text, TRUE AS supports_link, TRUE AS authority_valid
    FROM job_customer_parties WHERE job_id = $1
    UNION ALL
    SELECT id::text, contractor_profile_id::text, business_contact_id::text,
      business_customer_relationship_id::text, TRUE, source_type = 'business_document'
    FROM jobs WHERE id = $1 AND (business_contact_id IS NOT NULL OR business_customer_relationship_id IS NOT NULL)
    UNION ALL
    SELECT p.job_id::text, p.contractor_profile_id::text, p.business_contact_id::text,
      p.business_customer_relationship_id::text, TRUE, q.job_id = p.job_id
    FROM canonical_quote_customer_parties p JOIN canonical_quotes q ON q.id = p.quote_id
    WHERE p.job_id = $1 OR q.job_id = $1
    UNION ALL
    SELECT p.job_id::text, p.contractor_profile_id::text, p.business_contact_id::text,
      p.business_customer_relationship_id::text, TRUE, i.job_id = p.job_id
    FROM canonical_invoice_customer_parties p JOIN canonical_invoices i ON i.id = p.invoice_id
    WHERE p.job_id = $1 OR i.job_id = $1
    UNION ALL
    SELECT p.job_id::text, p.contractor_profile_id::text, p.business_contact_id::text,
      p.business_customer_relationship_id::text, TRUE, q.job_id = p.job_id
    FROM canonical_quote_customer_snapshots p JOIN canonical_quotes q ON q.id = p.quote_id
    WHERE (p.job_id = $1 OR q.job_id = $1)
      AND (p.business_contact_id IS NOT NULL OR p.business_customer_relationship_id IS NOT NULL)
    UNION ALL
    SELECT c.response_json->>'jobId', c.response_json->'customerParty'->>'contractorProfileId',
      c.response_json->'customerParty'->>'businessContactId',
      c.response_json->'customerParty'->>'customerRelationshipId', TRUE,
      q.job_id = s.job_id AND c.actor_user_id = profiles.user_id
        AND c.response_json->>'jobId' = s.job_id::text
        AND c.response_json->'customerParty'->>'jobId' = s.job_id::text
        AND c.response_json->'customerParty'->>'contractorProfileId' = s.contractor_profile_id::text
    FROM canonical_quote_business_document_sources s
    JOIN canonical_quotes q ON q.id = s.quote_id
    JOIN contractor_profiles profiles ON profiles.id = s.contractor_profile_id
    JOIN business_document_draft_commands c ON c.document_draft_id = s.source_document_id
      AND c.response_json->>'id' = s.source_document_id::text
    WHERE s.job_id = $1 AND c.completed_at IS NOT NULL AND c.operation IN ('CREATE', 'UPDATE')
      AND c.response_json->>'jobId' = $1::text
      AND jsonb_typeof(c.response_json->'customerParty') = 'object'
    UNION ALL
    SELECT job_id::text, contractor_profile_id::text, business_contact_id::text,
      business_customer_relationship_id::text, FALSE, TRUE
    FROM business_document_working_drafts WHERE job_id = $1
      AND (business_contact_id IS NOT NULL OR business_customer_relationship_id IS NOT NULL)`, [jobId]);
  return result.rows;
}

// Caller owns the transaction. Save and reconciliation serialize on the exact Job. The only
// mutation here is an insert into job_customer_parties; a conflict never replaces it.
async function ensureJobCustomerParty(client, { jobId, actorUserId, proposedParty = null }) {
  await client.query("/* customer_party:lock_reconciliation_job */ SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [jobId]);
  const owner = await resolveBusinessDocumentOwner(client, actorUserId, jobId);
  if (owner.kind !== "resolved") return { kind: "authority_denied" };
  const evidence = await loadEvidence(client, jobId);
  let party = proposedParty;
  let proven = Boolean(proposedParty);
  for (const row of evidence) {
    const candidate = customerPartyProjection(row);
    if (row.authority_valid !== true || row.job_id !== jobId ||
        Number(row.contractor_profile_id) !== owner.contractorProfileId ||
        !candidate || !UUID.test(candidate.businessContactId) || !UUID.test(candidate.customerRelationshipId)) {
      return { kind: "evidence_conflict" };
    }
    if (party && !sameCustomerParty(party, candidate)) return { kind: "evidence_conflict" };
    party = candidate;
    proven ||= row.supports_link === true;
  }
  if (!party || !proven) return { kind: "evidence_missing" };
  if (party.contractorProfileId != null && Number(party.contractorProfileId) !== owner.contractorProfileId) {
    return { kind: "evidence_conflict" };
  }
  const owned = await loadOwnedCustomerParty(client, {
    actorUserId, contractorProfileId: owner.contractorProfileId,
    businessContactId: party.businessContactId, customerRelationshipId: party.customerRelationshipId,
  }, { lock: true });
  if (!owned) return { kind: "evidence_conflict" };
  const inserted = await client.query(`/* customer_party:reconcile_job */
    INSERT INTO job_customer_parties (job_id, contractor_profile_id, business_contact_id,
      business_customer_relationship_id, linked_by_user_id)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING RETURNING *`,
  [jobId, owner.contractorProfileId, owned.businessContactId, owned.customerRelationshipId, actorUserId]);
  if (inserted.rows[0]) return { kind: "linked", customerParty: customerPartyProjection(inserted.rows[0]) };
  // Also handles a concurrent explicit link that did not take the Job lock.
  const existing = await client.query("/* customer_party:reconciled_existing */ SELECT * FROM job_customer_parties WHERE job_id = $1 FOR KEY SHARE", [jobId]);
  const linked = customerPartyProjection(existing.rows[0]);
  return sameCustomerParty(linked, owned)
    ? { kind: "existing", customerParty: linked }
    : { kind: "evidence_conflict" };
}

async function reconcileJobCustomerParty({ pool, authenticatedActor, jobId, payload = {} } = {}) {
  const actorUserId = Number(authenticatedActor?.id);
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    return { ok: false, status: 401, code: "AUTHENTICATION_REQUIRED" };
  }
  if (typeof jobId !== "string" || !UUID.test(jobId) || !payload ||
      typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length) {
    return { ok: false, status: 400, code: "CUSTOMER_PARTY_RECONCILIATION_INPUT_INVALID" };
  }
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const result = await ensureJobCustomerParty(client, { jobId: jobId.toLowerCase(), actorUserId });
    await client.query("COMMIT");
    if (result.kind === "authority_denied") return { ok: false, status: 403, code: "CUSTOMER_PARTY_JOB_AUTHORITY_DENIED" };
    if (result.kind === "evidence_missing") return { ok: false, status: 409, code: "CUSTOMER_PARTY_DURABLE_EVIDENCE_REQUIRED" };
    if (result.kind === "evidence_conflict") return { ok: false, status: 409, code: "CUSTOMER_PARTY_EVIDENCE_CONFLICT" };
    return { ok: true, status: result.kind === "linked" ? 201 : 200,
      code: result.kind === "linked" ? "JOB_CUSTOMER_PARTY_RECONCILED" : "JOB_CUSTOMER_PARTY_ALREADY_LINKED",
      customerParty: result.customerParty };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== pool) client.release();
  }
}

module.exports = { reconcileJobCustomerParty, ensureJobCustomerParty, loadEvidence };
