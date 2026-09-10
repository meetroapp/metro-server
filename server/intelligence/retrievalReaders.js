"use strict";

const { loadConversationContext } = require("./conversationContext");
const { getProfessionalQuotes } = require("../authorization/professionalQuotesService");
const { listVisits } = require("../workflow/visitService");
const { getProfessionalDepositStatus } = require("../finance/preWorkDepositService");

const CANDIDATE_LIMIT = 40;
// Candidate selection is deliberately weaker than disclosure authorization:
// only actor-scoped IDs/labels enter memory, and every result is read again by
// the domain's existing exact authorization reader before matching/disclosure.
const JOB_SCOPE = `
  FROM jobs j
  LEFT JOIN posts p ON p.id=j.job_request_id
  LEFT JOIN request_relationships r ON r.id=j.source_request_relationship_id
    AND r.post_id=j.job_request_id
  LEFT JOIN users customer ON customer.id=r.homeowner_id
  LEFT JOIN contractor_profiles business ON business.id=j.contractor_profile_id
  LEFT JOIN business_document_working_drafts source ON source.id=j.originating_business_document_id
  WHERE j.lifecycle_contract_version=2 AND (
    ($2='professional' AND ((r.professional_user_id=$1 AND r.status='active')
      OR (j.source_type='business_document' AND business.user_id=$1))
      AND EXISTS (SELECT 1 FROM relationship_participants participant
        WHERE participant.job_id=j.id AND participant.user_id=$1))
    OR ($2='homeowner' AND r.homeowner_id=$1 AND p.user_id=$1))`;
const JOB_LABEL = `COALESCE(p.title, source.content->>'projectTitle', 'Job')`;
const JOB_NAME = `COALESCE(customer.username, source.content->>'customerName', '')`;

function unavailable() { return Object.assign(new Error("Authorized retrieval is temporarily unavailable. Please retry."), { code: "intelligence_retrieval_unavailable" }); }
function safeMiss(error) { return error?.code === "intelligence_context_invalid"; }

async function discoverCandidates({ pool, authenticatedActor }, query) {
  const role = authenticatedActor.role;
  if (!["professional", "homeowner"].includes(role)) return { candidates: [], truncated: false };
  // Input is parameterized. SQL metacharacters in names are literal characters.
  const term = query.id || query.number || query.name || "";
  const pattern = `%${String(term).replace(/[\\%_]/g, "\\$&")}%`;
  const values = [authenticatedActor.id, role, pattern, CANDIDATE_LIMIT + 1];
  const filter = (expression) => {
    const normalized = query.name ? `regexp_replace(lower(${expression}), '[^[:alnum:]]+', ' ', 'g')` : `lower(${expression})`;
    return `($3='%%' OR ${normalized} LIKE lower($3))`;
  };
  let sql;
  if (query.type === "JOB") {
    sql = `SELECT j.id, ${JOB_LABEL} AS title, ${JOB_NAME} AS name ${JOB_SCOPE}
      AND ${filter(`concat_ws(' ',j.id::text,${JOB_LABEL},${JOB_NAME})`)} ORDER BY j.id LIMIT $4`;
  } else if (query.type === "JOB_REQUEST") {
    // Same ownership as GET /posts and GET /posts/:id, now with a bounded page.
    sql = `SELECT p.id, p.title, '' AS name FROM posts p WHERE p.user_id=$1
      AND $2 IN ('homeowner','professional') AND ${filter("concat_ws(' ',p.id::text,p.title)")} ORDER BY p.id LIMIT $4`;
  } else if (query.type === "CUSTOMER_RELATIONSHIP") {
    if (role !== "professional") return { candidates: [], truncated: false };
    sql = `SELECT r.id, c.display_name AS name, c.company_name AS title
      FROM business_customer_relationships r JOIN contractor_profiles b ON b.id=r.contractor_profile_id
      JOIN business_contacts c ON c.id=r.business_contact_id AND c.contractor_profile_id=b.id
      WHERE b.user_id=$1 AND $2='professional' AND ${filter("concat_ws(' ',r.id::text,c.display_name,c.company_name)")}
      ORDER BY r.id LIMIT $4`;
  } else if (query.type === "CONVERSATION") {
    sql = `SELECT c.id, p.title, u.username AS name FROM conversations c
      JOIN request_relationships r ON r.id=c.relationship_id
        AND r.homeowner_id=c.homeowner_id AND r.professional_user_id=c.professional_user_id
      LEFT JOIN posts p ON p.id=r.post_id LEFT JOIN users u ON u.id=c.homeowner_id
      WHERE (($2='professional' AND c.professional_user_id=$1 AND r.professional_user_id=$1)
        OR ($2='homeowner' AND c.homeowner_id=$1 AND r.homeowner_id=$1))
      AND ${filter("concat_ws(' ',c.id::text,p.title,u.username)")} ORDER BY c.id LIMIT $4`;
  } else if (["QUOTE", "INVOICE", "EVALUATION"].includes(query.type)) {
    const table = query.type === "QUOTE" ? "canonical_quotes" : query.type === "INVOICE" ? "canonical_invoices" : "canonical_evaluation_job_subjects";
    const idColumn = query.type === "EVALUATION" ? "evaluation_id" : "id";
    const number = query.type === "INVOICE" ? "record.invoice_number" : query.type === "QUOTE" ? "number_source.document_number" : "NULL::text";
    const numberJoin = query.type === "QUOTE" ? "LEFT JOIN canonical_quote_business_document_sources number_source ON number_source.quote_id=record.id" : "";
    // Join only scoped Jobs; exact Quote/Invoice/Evaluation reads recheck their
    // own permissions/delivery rules before even a result label is exposed.
    sql = `WITH scoped_jobs AS (SELECT j.id, ${JOB_LABEL} AS title, ${JOB_NAME} AS name ${JOB_SCOPE})
      SELECT record.${idColumn} AS id, jobs.id AS job_id, jobs.title, jobs.name, ${number} AS number
      FROM ${table} record JOIN scoped_jobs jobs ON jobs.id=record.job_id ${numberJoin}
      WHERE ${filter(`concat_ws(' ',record.${idColumn}::text,jobs.title,jobs.name,regexp_replace(COALESCE(${number},''),'[ -]','','g'))`)}
      ORDER BY record.${idColumn} LIMIT $4`;
  } else return { candidates: [], truncated: false };
  let result;
  try { result = await pool.query(`/* companion_retrieval:candidates:${query.type} */ ${sql}`, values); }
  catch { throw unavailable(); }
  let candidates = result.rows.slice(0, CANDIDATE_LIMIT).map((row) => ({
    record: { type: query.type, id: String(row.id) }, name: String(row.name || "").slice(0, 100), title: String(row.title || "").slice(0, 120), number: row.number || "",
  }));
  let truncated = result.rows.length > CANDIDATE_LIMIT;
  if (["QUOTE", "INVOICE"].includes(query.type) && role === "professional") {
    // Saved Files have a different identity and never become issued authority.
    let docs;
    try { docs = await pool.query(`/* companion_retrieval:working_documents */
      SELECT d.id,d.document_number AS number,d.content->>'customerName' AS name,d.content->>'projectTitle' AS title
      FROM business_document_working_drafts d JOIN contractor_profiles b ON b.id=d.contractor_profile_id
      WHERE b.user_id=$1 AND d.document_type=$2 AND d.draft_status='WORKING_DRAFT'
        AND ${filter("concat_ws(' ',d.id::text,regexp_replace(d.document_number,'[ -]','','g'),d.content->>'customerName',d.content->>'projectTitle')")}
        AND NOT EXISTS (SELECT 1 FROM canonical_quote_business_document_sources s WHERE s.source_document_id=d.id)
      ORDER BY d.id LIMIT $4`, [authenticatedActor.id, query.type, pattern, CANDIDATE_LIMIT + 1]); } catch { throw unavailable(); }
    candidates.push(...docs.rows.slice(0, CANDIDATE_LIMIT).map((row) => ({ record: { type: "DOCUMENT_DRAFT", id: String(row.id) }, name: row.name || "", title: row.title || "", number: row.number || "" })));
    truncated ||= candidates.length > CANDIDATE_LIMIT || docs.rows.length > CANDIDATE_LIMIT;
    candidates = candidates.slice(0, CANDIDATE_LIMIT);
  }
  return { candidates, truncated };
}

async function readAuthorizedRecord(base, pointer) {
  try { return await loadConversationContext({ context: { record: pointer }, runtimeContext: base }); }
  catch (error) { if (safeMiss(error)) return null; throw unavailable(); }
}

async function readVisits(base, jobId) {
  const result = await listVisits({ ...base, jobId });
  if (!result.ok) {
    if (result.status >= 500) throw unavailable();
    return null;
  }
  return result.visits;
}
async function readDeposit(base, jobId) {
  if (base.authenticatedActor.role !== "professional") return null;
  const result = await getProfessionalDepositStatus({ ...base, jobId });
  if (!result.ok && result.status >= 500) throw unavailable();
  return result.ok ? result.deposit : null;
}
// Reuse the queue's delivered-version/fingerprint law. ISSUED alone does not
// prove that a Quote is waiting on a customer's decision.
async function readWaitingQuotes(base) {
  if (base.authenticatedActor.role !== "professional") return null;
  try {
    const result = await getProfessionalQuotes({ ...base, classification: "waiting_on_customer", limit: CANDIDATE_LIMIT });
    if (!result.ok) { if (result.status >= 500) throw unavailable(); return null; }
    return { ids: result.quotes.map((quote) => quote.id), truncated: result.pagination.hasMore };
  } catch { throw unavailable(); }
}
module.exports = { discoverCandidates, readAuthorizedRecord, readVisits, readDeposit, readWaitingQuotes, CANDIDATE_LIMIT, unavailable };
