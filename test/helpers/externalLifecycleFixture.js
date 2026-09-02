"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const service = require("../../server/authorization/quoteDraftService");
const depositService = require("../../server/finance/preWorkDepositService");
const quiet = { info() {}, warn() {}, error() {} };
async function createWorkingQuote({
  pool,
  userId,
  contractorProfileId,
  mode,
  businessContactId = null,
  customerRelationshipId = null,
  documentNumber,
}) {
  const draftId = randomUUID();

  const documentOnly =
    mode === "DOCUMENT_ONLY";

  const content = {
    customerName: documentOnly
      ? "Document Only Runtime Customer"
      : "Working Draft Contact Name",
    customerEmail: documentOnly
      ? "document.only.runtime@example.test"
      : "working-copy@example.test",
    customerPhone: documentOnly
      ? "239-555-0202"
      : "239-555-0999",
    customerAddress: documentOnly
      ? "456 Document Only Avenue, Cape Coral, FL"
      : "999 Working Draft Lane, Cape Coral, FL",
    companyName: documentOnly
      ? "Document Only Runtime LLC"
      : "",
    projectTitle:
      `${mode} external approval runtime certification`,
    projectDescription:
      "Install customer-approved ceiling fan and verify operation.",
    materialItems: [
      {
        id: "material-1",
        name: "Ceiling fan",
        total: "90.00",
      },
    ],
    laborItems: [
      {
        id: "labor-1",
        description: "Ceiling fan installation",
        total: "180.00",
      },
    ],
    lineItems: [],
    totalOverride: "",
    currency: "USD",
    depositMode: "PERCENT",
    depositPercent: "50",
    terms: "50% deposit required before scheduling.",
    paymentTerms:
      "50% deposit required before scheduling.",
    estimatedDuration: "2 hours",
    notes: "",
    agreement: {
      exclusions: [],
    },
  };

  await pool.query(
    `INSERT INTO business_document_working_drafts (
       id,
       contractor_profile_id,
       created_by_user_id,
       job_id,
       document_type,
       draft_reference,
       document_number,
       content,
       workspace_context,
       business_contact_id,
       business_customer_relationship_id
     )
     VALUES (
       $1,
       $2,
       $3,
       NULL,
       'QUOTE',
       $4,
       $5,
       $6::jsonb,
       '{}'::jsonb,
       $7,
       $8
     )`,
    [
      draftId,
      contractorProfileId,
      userId,
      `D2-${mode}-${draftId.slice(0, 8)}`,
      documentNumber,
      JSON.stringify(content),
      businessContactId,
      customerRelationshipId,
    ]
  );

  return {
    draftId,
    content,
  };
}


async function createExternalLifecycleFixture(pool, mode) {
  const suffix = randomUUID();
  const user = await pool.query(`INSERT INTO users (username,email,password_hash,business_name,business_category,role,account_type)
    VALUES ('Lifecycle Professional',$1,'test-only','Lifecycle Business','Testing','handyman','professional') RETURNING id`,
    [`external-${suffix}@example.test`]);
  const userId = Number(user.rows[0].id);
  const profile = await pool.query(`INSERT INTO contractor_profiles (user_id,business_name,category)
    VALUES ($1,'Lifecycle Business','Testing') RETURNING id`, [userId]);
  const contractorProfileId = Number(profile.rows[0].id);
  let businessContactId = null, customerRelationshipId = null;
  if (mode === "EXTERNAL_CONTACT") {
    const contact = await pool.query(`INSERT INTO business_contacts
      (contractor_profile_id,created_by_user_id,party_type,display_name,email,address_text)
      VALUES ($1,$2,'PERSON','Canonical Runtime Customer','external@example.test','123 Contact Street') RETURNING id`,
      [contractorProfileId,userId]);
    businessContactId = contact.rows[0].id;
    const relationship = await pool.query(`INSERT INTO business_customer_relationships
      (contractor_profile_id,business_contact_id,established_by_user_id) VALUES ($1,$2,$3) RETURNING id`,
      [contractorProfileId,businessContactId,userId]);
    customerRelationshipId = relationship.rows[0].id;
  }
  const { draftId } = await createWorkingQuote({ pool,userId,contractorProfileId,mode,
    businessContactId,customerRelationshipId,documentNumber:'Q-1' });
  const base = { pool, authenticatedActor:{id:userId},logger:quiet };
  const imported = await service.importBusinessDocumentDraftQuote({ ...base,draftId,expectedDocumentVersion:1,
    idempotencyKey:`external-import-${suffix}` });
  assert.equal(imported.ok,true,imported.code);
  const jobId = imported.quote.jobId, quoteId = imported.quote.id;
  const issued = await service.issueQuote({...base,quoteId,expectedVersion:imported.quote.currentVersion,
    idempotencyKey:`external-issue-${suffix}`});
  assert.equal(issued.ok,true,issued.code);
  const issuance = (await pool.query(`SELECT issued_at FROM canonical_quote_issuances WHERE quote_id=$1`,[quoteId])).rows[0];
  const approvalCommand = {...base,quoteId,expectedIssuedVersion:issued.quote.currentVersion,evidenceMethod:'PHONE',
    approvedAt:new Date(issuance.issued_at).toISOString(),evidenceReference:'Customer phone acceptance',
    evidenceNote:'Customer approved the exact issued Quote.',idempotencyKey:`external-approve-${suffix}`};
  const approved = await service.recordExternalQuoteApproval(approvalCommand);
  assert.equal(approved.ok,true,approved.code);
  const approval = (await pool.query(`SELECT * FROM canonical_quote_approvals WHERE quote_id=$1`,[quoteId])).rows[0];
  const participant = (await pool.query(`SELECT id FROM relationship_participants WHERE job_id=$1`,[jobId])).rows[0];
  return {...base,mode,suffix,userId,contractorProfileId,jobId,quoteId,quoteApprovalId:approval.id,
    issuedVersion:issued.quote.currentVersion,professionalParticipantId:participant.id,approvalCommand,
    userCount:(await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count};
}

async function payExternalDeposit(fixture, amountMinor, expectedVersion) {
  const command = { pool:fixture.pool,authenticatedActor:fixture.authenticatedActor,logger:quiet,
    jobId:fixture.jobId,amountMinor,currency:'USD',normalizedMethod:'EXTERNAL_TRANSFER',displayMethod:'External transfer',
    externalReference:`payment-${fixture.suffix}-${expectedVersion}`,receivedAt:new Date().toISOString(),
    expectedVersion,idempotencyKey:`external-pay-${fixture.suffix}-${expectedVersion}` };
  const result=await depositService.confirmDepositReceived(command);
  assert.equal(result.ok,true,result.code);
  return {result,command};
}

async function assertNoExternalCustomerAuthority(fixture) {
  const {pool,jobId,professionalParticipantId}=fixture;
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count,fixture.userCount);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM alerts WHERE source_entity_id=$1 OR destination_payload->>'jobId'=$1 OR source_entity_id IN (SELECT id::text FROM canonical_visits WHERE job_id=$1::uuid)`,[jobId])).rows[0].count,0);
  const job=(await pool.query(`SELECT * FROM jobs WHERE id=$1`,[jobId])).rows[0];
  assert.equal(job.source_type,'business_document');
  assert.equal(job.job_request_id,null);
  assert.equal(job.source_request_relationship_id,null);
  const participants=(await pool.query(`SELECT id FROM relationship_participants WHERE job_id=$1`,[jobId])).rows;
  assert.deepEqual(participants,[{id:professionalParticipantId}]);
  for (const sql of [
    `SELECT count(*)::int AS count FROM canonical_quote_customer_decisions WHERE job_id=$1`,
    `SELECT count(*)::int AS count FROM participant_role_assignments WHERE job_id=$1 AND role='CUSTOMER_REPRESENTATIVE'`,
    `SELECT count(*)::int AS count FROM lifecycle_authority_grants WHERE job_id=$1 AND capability IN ('visit.confirm','visit.change_request','quote.approve','quote.decline')`,
  ]) assert.equal((await pool.query(sql,[jobId])).rows[0].count,0);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM conversations WHERE professional_user_id=$1`,[fixture.userId])).rows[0].count,0);
}
module.exports={createExternalLifecycleFixture,payExternalDeposit,assertNoExternalCustomerAuthority,quiet};
