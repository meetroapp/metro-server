"use strict";

// Read-only, narrowly scoped staging audit. Railway credentials stay in memory.
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");
const PROJECT = "10d1facd-6aa6-4052-9897-803396f813c4";
function variables(service) {
  return JSON.parse(execFileSync("railway", ["variable", "list", "--project", PROJECT,
    "--environment", "staging", "--service", service, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
async function main() {
  const app = variables("athletic-rebirth");
  let database;
  for (const service of ["Postgres", "Postgres-pMkW"]) {
    let candidate;
    try { candidate = variables(service); } catch { continue; }
    if (candidate.DATABASE_URL && app.DATABASE_URL &&
        new URL(candidate.DATABASE_URL).hostname === new URL(app.DATABASE_URL).hostname) {
      database = candidate;
      break;
    }
  }
  if (!database?.DATABASE_PUBLIC_URL) throw new Error("STAGING_DATABASE_NOT_VERIFIED");
  const client = new Client({ connectionString: database.DATABASE_PUBLIC_URL,
    options: "-c default_transaction_read_only=on -c statement_timeout=15000", connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const invoice = await client.query(`SELECT i.id,i.job_id,i.invoice_number,i.created_at,
      v.version,v.total_minor,v.paid_minor,v.balance_minor,v.currency
      FROM canonical_invoices i JOIN LATERAL (SELECT * FROM canonical_invoice_versions
      WHERE invoice_id=i.id ORDER BY version DESC LIMIT 1) v ON TRUE WHERE i.invoice_number=$1`, ["INV-937922242CFD"]);
    console.log(JSON.stringify({ invoice: invoice.rows }));
    if (invoice.rows.length !== 1) throw new Error("KNOWN_INVOICE_NOT_UNIQUE");
    const jobId = invoice.rows[0].job_id;
    const job = await client.query(`SELECT j.*,r.contractor_id AS relationship_contractor_profile_id,
      r.professional_user_id,r.homeowner_id,r.status AS request_relationship_status
      FROM jobs j LEFT JOIN request_relationships r ON r.id=j.source_request_relationship_id WHERE j.id=$1`, [jobId]);
    console.log(JSON.stringify({ job: job.rows }));
    for (const table of ["job_customer_parties", "canonical_quote_customer_parties", "canonical_invoice_customer_parties"]) {
      console.log(JSON.stringify({ [table]: (await client.query(`SELECT * FROM ${table} WHERE job_id=$1`, [jobId])).rows }));
    }
    console.log(JSON.stringify({ documents: (await client.query(`SELECT id,job_id,contractor_profile_id,
      business_contact_id,business_customer_relationship_id,document_type,created_at,updated_at
      FROM business_document_working_drafts WHERE job_id=$1 OR id=$2`, [jobId, job.rows[0].originating_business_document_id])).rows }));
    console.log(JSON.stringify({ quotes: (await client.query(`SELECT id,job_id,status,created_at,issued_at FROM canonical_quotes WHERE job_id=$1`, [jobId])).rows }));
    console.log(JSON.stringify({ quoteSources: (await client.query(`SELECT * FROM canonical_quote_business_document_sources WHERE job_id=$1`, [jobId])).rows }));
    console.log(JSON.stringify({ snapshotColumns: (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='canonical_quote_customer_snapshots' ORDER BY ordinal_position`)).rows }));
    console.log(JSON.stringify({ customerSnapshots: (await client.query(`SELECT quote_id,job_id,contractor_profile_id,customer_mode,
      business_contact_id,business_customer_relationship_id,created_at FROM canonical_quote_customer_snapshots WHERE job_id=$1`, [jobId])).rows }));
    console.log(JSON.stringify({ documentCommands: (await client.query(`SELECT id,operation,created_at,completed_at,
      response_json->>'id' AS document_id,response_json->>'jobId' AS job_id,response_json->>'version' AS version,
      response_json->'customerParty' AS customer_party FROM business_document_draft_commands
      WHERE response_json->>'id' IN (SELECT id::text FROM business_document_working_drafts WHERE job_id=$1)
      ORDER BY created_at`, [jobId])).rows }));
    console.log(JSON.stringify({ relationship: (await client.query(`SELECT r.id,r.contractor_profile_id,r.business_contact_id,r.created_at,
      c.created_at AS contact_created_at FROM business_customer_relationships r JOIN business_contacts c ON c.id=r.business_contact_id
      WHERE r.id IN (SELECT business_customer_relationship_id FROM business_document_working_drafts WHERE job_id=$1)`, [jobId])).rows }));
    console.log(JSON.stringify({ completion: (await client.query(`SELECT job_id,status,completed_at FROM canonical_job_completion_records WHERE job_id=$1`, [jobId])).rows }));
    console.log(JSON.stringify({ linkageMigration: (await client.query(`SELECT filename,applied_at FROM schema_migrations WHERE filename LIKE '%customer_party%'`)).rows }));
    const { loadEvidence } = require("../server/relationships/jobCustomerPartyReconciliationService");
    console.log(JSON.stringify({ reconciliationEvidence: await loadEvidence(client, jobId) }));
    await client.query("ROLLBACK");
  } finally { await client.end(); }
}
main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
