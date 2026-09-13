"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcileJobCustomerParty, ensureJobCustomerParty, loadEvidence } = require("../server/relationships/jobCustomerPartyReconciliationService");
const { businessDocumentDraftInternals: { sqlStore: drafts } } = require("../server/documents/businessDocumentDraftService");
const { createCustomerPartyHandlers } = require("../server/relationships/customerParties");

const JOB = "072c8736-5d97-4253-ba3e-dd1bce281a20";
const SECOND_JOB = "172c8736-5d97-4253-ba3e-dd1bce281a20";
const CONTACT = "0c3c3c09-2ba8-4bd6-a001-0524984e467a";
const RELATIONSHIP = "e9bb9da5-7cc9-4c3a-b4d3-814a7a020a43";
const OTHER_RELATIONSHIP = "a9bb9da5-7cc9-4c3a-b4d3-814a7a020a43";
const DOCUMENT = "ccda1240-b24e-4f10-b06f-3908c6641773";
const proposedParty = { businessContactId: CONTACT, customerRelationshipId: RELATIONSHIP, contractorProfileId: 7 };
const evidence = (overrides = {}) => ({ job_id: JOB, contractor_profile_id: "7", business_contact_id: CONTACT,
  business_customer_relationship_id: RELATIONSHIP, authority_valid: true, supports_link: true, ...overrides });

function database({ rows = [], authorized = true, owned = true, existing = null, racing = null, failSave = false } = {}) {
  let document = { id: DOCUMENT, job_id: JOB, contractor_profile_id: 7, document_type: "QUOTE", document_number: "Q-0000001",
    version: 1, created_at: "2026-08-27T17:39:01.931Z", updated_at: "2026-08-27T17:39:01.931Z" };
  const links = new Map(existing ? [[JOB, existing]] : []);
  const calls = [];
  let before;
  const pool = { links, calls, async query(sql, values = []) {
    calls.push({ sql, values });
    const result = (items = []) => ({ rows: items });
    if (sql === "BEGIN") { before = new Map(links); return result(); }
    if (sql === "ROLLBACK") { links.clear(); for (const entry of before) links.set(...entry); return result(); }
    if (sql === "COMMIT") return result();
    if (sql.includes("customer_party:lock_reconciliation_job")) return result([{ id: values[0] }]);
    if (sql.includes("business_document_numbering:job_owner")) return result(authorized ? [{ contractor_profile_id: 7 }] : []);
    if (sql.includes("customer_party:reconciliation_evidence")) return result([
      ...rows.filter((row) => row.job_id === values[0]),
      ...(links.has(values[0]) ? [evidence(links.get(values[0]))] : []),
    ]);
    if (sql.includes("customer_party:load_owned")) return result(owned && values[1] === 7 && values[2] === CONTACT && values[3] === RELATIONSHIP ? [evidence()] : []);
    if (sql.includes("customer_party:reconcile_job")) {
      if (racing) links.set(values[0], racing);
      if (links.has(values[0])) return result();
      const row = evidence({ job_id: values[0], contractor_profile_id: values[1], created_at: "2026-09-13T12:00:00Z" });
      links.set(values[0], row); return result([row]);
    }
    if (sql.includes("customer_party:reconciled_existing")) return result([links.get(values[0])]);
    if (sql.includes("business_document:reserve_command")) return result([{ id: DOCUMENT }]);
    if (sql.includes("business_document:cancel_command")) return result();
    if (sql.includes("business_document:load_owned_business_context")) return result([document]);
    if (sql.includes("business_document_numbering:allocate")) return result([{ number_prefix: "Q", number_width: 7, last_number: 1 }]);
    if (sql.includes("business_document:create")) {
      if (failSave) throw new Error("save failed");
      document = { ...document, job_id: values[3], business_contact_id: values[9], business_customer_relationship_id: values[10] };
      return result();
    }
    if (sql.includes("business_document:update")) {
      if (failSave) throw new Error("save failed");
      document = { ...document, job_id: values[2], business_contact_id: values[6], business_customer_relationship_id: values[7], version: 2 };
      return result();
    }
    if (sql.includes("business_document:load_owned")) return result([document]);
    if (/business_document:(load_photos|detach_photos|finish_command)/.test(sql)) return result();
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  return pool;
}
function reconcile(pool, overrides = {}) { return reconcileJobCustomerParty({ pool, authenticatedActor: { id: 15 }, jobId: JOB, ...overrides }); }
const mutations = (pool) => pool.calls.filter(({ sql }) => /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/.test(sql));

test("old Job with exact durable evidence reconciles by inserting only its Job customer party", async () => {
  const pool = database({ rows: [evidence(), evidence()] });
  const result = await reconcile(pool);
  assert.equal(result.status, 201);
  assert.equal(result.customerParty.jobId, JOB);
  assert.equal(result.customerParty.customerRelationshipId, RELATIONSHIP);
  assert.equal(pool.links.size, 1);
  assert.equal(mutations(pool).length, 1);
  assert.match(mutations(pool)[0].sql, /INSERT INTO job_customer_parties/);
});

test("existing correct link and repeated reconciliation are idempotent", async () => {
  const pool = database({ existing: evidence() });
  const first = await reconcile(pool);
  const second = await reconcile(pool);
  assert.equal(first.status, 200);
  assert.deepEqual(first, second);
  assert.equal(pool.links.size, 1);
});

for (const [name, extra] of [
  ["no durable evidence", {}], ["matching name alone", { customerName: "Antony Guzman" }],
  ["matching email alone", { customerEmail: "customer@example.test" }],
  ["matching phone alone", { customerPhone: "5550100" }],
  ["marketplace homeowner identity alone", { homeownerId: 12, requestRelationshipId: 345 }],
]) test(`${name} cannot fabricate a customer link`, async () => {
  const pool = database();
  Object.assign(pool, extra);
  assert.equal((await reconcile(pool)).code, "CUSTOMER_PARTY_DURABLE_EVIDENCE_REQUIRED");
  assert.equal(mutations(pool).length, 0);
});

for (const [name, options] of [
  ["cross-business evidence", { rows: [evidence({ contractor_profile_id: "8" })] }],
  ["Contact owned by another business", { rows: [evidence()], owned: false }],
  ["competing Customer Relationship", { rows: [evidence(), evidence({ business_customer_relationship_id: OTHER_RELATIONSHIP })] }],
  ["existing different Job assignment", { rows: [evidence()], existing: evidence({ business_customer_relationship_id: OTHER_RELATIONSHIP }) }],
  ["invalid canonical source authority", { rows: [evidence({ authority_valid: false })] }],
  ["partial customer tuple", { rows: [evidence({ business_contact_id: null })] }],
]) test(`${name} fails closed before insertion`, async () => {
  const pool = database(options);
  assert.equal((await reconcile(pool)).code, "CUSTOMER_PARTY_EVIDENCE_CONFLICT");
  assert.equal(mutations(pool).length, 0);
});

test("mutable working draft alone is not proof", async () => {
  const pool = database({ rows: [evidence({ supports_link: false })] });
  assert.equal((await reconcile(pool)).code, "CUSTOMER_PARTY_DURABLE_EVIDENCE_REQUIRED");
  assert.equal(mutations(pool).length, 0);
});

test("concurrent competing explicit link is never overwritten", async () => {
  const competing = evidence({ business_customer_relationship_id: OTHER_RELATIONSHIP });
  const pool = database({ rows: [evidence()], racing: competing });
  assert.equal((await reconcile(pool)).status, 409);
  assert.equal(pool.links.get(JOB), competing);
});

test("unauthorized actor cannot read candidate evidence or insert linkage", async () => {
  const pool = database({ authorized: false });
  assert.equal((await reconcile(pool)).status, 403);
  assert.equal(pool.calls.some(({ sql }) => sql.includes("reconciliation_evidence")), false);
  assert.equal(mutations(pool).length, 0);
});

test("reconciliation rejects client customer identity and invalid Job inputs before querying", async () => {
  const pool = database();
  for (const payload of [{ businessContactId: CONTACT }, { customerRelationshipId: RELATIONSHIP }, { customerName: "Antony" }, [], null]) {
    assert.equal((await reconcile(pool, { payload })).status, 400);
  }
  assert.equal((await reconcile(pool, { jobId: "invalid" })).status, 400);
  assert.equal((await reconcile(pool, { authenticatedActor: null })).status, 401);
  assert.equal(pool.calls.length, 0);
});

test("external and repeat Jobs retain the same exact saved customer relationship", async () => {
  const pool = database({ rows: [evidence(), evidence({ job_id: SECOND_JOB })] });
  const first = await reconcile(pool);
  const second = await reconcile(pool, { jobId: SECOND_JOB });
  assert.equal(first.customerParty.customerRelationshipId, second.customerParty.customerRelationshipId);
  assert.notEqual(first.customerParty.jobId, second.customerParty.jobId);
  assert.equal(pool.links.size, 2);
});

function save(pool, operation = "update") {
  return drafts[operation]({ pool, actorUserId: 15, contractorProfileId: 7,
    draftId: DOCUMENT, expectedVersion: 1,
    command: { actorUserId: 15, operation: operation.toUpperCase(), key: DOCUMENT, hash: "a".repeat(64) },
    draft: { id: DOCUMENT, jobId: JOB, documentType: "QUOTE", paymentRequirementId: null,
      customerParty: proposedParty, customerPartyMode: "LINK", workspace: {}, content: {}, photos: [] },
  });
}
for (const operation of ["create", "update"]) {
  test(`${operation} with an explicit saved customer links its exact existing Job in the same transaction`, async () => {
    const pool = database();
    const result = await save(pool, operation);
    assert.equal(result.kind, operation === "create" ? "created" : "updated");
    assert.equal(result.document.customerParty.customerRelationshipId, RELATIONSHIP);
    assert.equal(pool.links.get(JOB).business_contact_id, CONTACT);
    assert.equal(pool.calls.at(-1).sql, "COMMIT");
  });
  test(`${operation} cannot save a competing Job customer assignment`, async () => {
    const pool = database({ existing: evidence({ business_customer_relationship_id: OTHER_RELATIONSHIP }) });
    assert.equal((await save(pool, operation)).kind, "customer_party_conflict");
    assert.equal(pool.calls.some(({ sql }) => sql.includes(`business_document:${operation} */`)), false);
    assert.equal(pool.links.get(JOB).business_customer_relationship_id, OTHER_RELATIONSHIP);
  });
  test(`${operation} failure rolls back the proposed Job link`, async () => {
    const pool = database({ failSave: true });
    await assert.rejects(save(pool, operation), /save failed/);
    assert.equal(pool.links.size, 0);
    assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
  });
}

test("completed receipts qualify only via exact canonical Quote source, document, Job, actor and profile", () => {
  const source = String(loadEvidence);
  assert.match(source, /c\.document_draft_id = s\.source_document_id/);
  assert.match(source, /c\.response_json->>'id' = s\.source_document_id::text/);
  assert.match(source, /c\.completed_at IS NOT NULL/);
  assert.match(source, /q\.job_id = s\.job_id/);
  assert.match(source, /c\.actor_user_id = profiles\.user_id/);
  assert.match(source, /'contractorProfileId' = s\.contractor_profile_id::text/);
  assert.doesNotMatch(source, /customerName|customerEmail|customerPhone|homeowner_id|ILIKE|similarity/);
});

test("reconcile HTTP handler rejects customer IDs rather than ignoring them", async () => {
  const pool = database();
  const handler = createCustomerPartyHandlers({ getPool: () => pool, sendPublicDatabaseError: () => { throw new Error("unexpected"); } }).reconcileJob;
  const res = { setHeader() {}, status(status) { this.statusCode = status; return this; }, json(body) { this.body = body; return this; } };
  await handler({ user: { id: 15 }, params: { jobId: JOB }, body: { businessContactId: CONTACT } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.length, 0);
});

test("internal proposed customer still requires canonical Job owner and owned tuple", async () => {
  const pool = database({ owned: false });
  assert.equal((await ensureJobCustomerParty(pool, { jobId: JOB, actorUserId: 15, proposedParty })).kind, "evidence_conflict");
  assert.equal(mutations(pool).length, 0);
});
