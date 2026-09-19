"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { Client } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getMigrationFiles } = require("../scripts/run-migrations");
const { ensureEmergencySelectionJob } = require("../server/emergency/emergencyJobFoundationService");
const dispatch = require("../server/emergency/emergencyDispatchService");
const evaluation = require("../server/authorization/evaluationService");
const quotes = require("../server/authorization/quoteDraftService");
const delivery = require("../server/authorization/quoteDeliveryService");
const deposits = require("../server/finance/preWorkDepositService");
const emergency = require("../server/emergency/emergencyCommercialContext");
const url = process.env.EMERGENCY_TASK4_DATABASE_URL;
const quiet = { info() {}, warn() {} };
const migrationName = "202609190003_generalize_emergency_pre_work_authority.sql";
const migration = readFileSync(join(__dirname, "..", "migrations", migrationName), "utf8");

function success(result) {
  assert.equal(result.ok === true || result.success === true, true, JSON.stringify(result));
  return result;
}

// All schema, fixtures, and service transactions live inside one outer ROLLBACK.
// Service transaction boundaries are mapped to savepoints, never real commits.
function transactionalFacade(client) {
  const sql = [];
  const facade = {
    sql,
    async query(text, values) {
      sql.push(text);
      if (/^BEGIN\b/.test(text)) return client.query("SAVEPOINT service_transaction");
      if (text === "COMMIT") return client.query("RELEASE SAVEPOINT service_transaction");
      if (text === "ROLLBACK") {
        await client.query("ROLLBACK TO SAVEPOINT service_transaction");
        return client.query("RELEASE SAVEPOINT service_transaction");
      }
      return client.query(text, values);
    },
    async connect() { return facade; },
    release() {},
  };
  return facade;
}

async function fixture(client, pool) {
  const ids = {};
  for (const kind of ["homeowner", "professional", "outsider"]) {
    ids[kind] = (await client.query(`INSERT INTO users (username, email, password_hash, role, account_type)
      VALUES ($1, $2, 'test-hash', $3, $4) RETURNING id`,
    [kind, `${randomUUID()}@example.test`, kind === 'professional' ? 'handyman' : 'homeowner', kind === 'professional' ? 'professional' : 'homeowner'])).rows[0].id;
  }
  ids.profile = (await client.query(`INSERT INTO contractor_profiles (user_id, business_name, category, location)
    VALUES ($1, 'Emergency Test Professional', 'plumbing', 'Test location') RETURNING id`, [ids.professional])).rows[0].id;
  const request = (await client.query(`INSERT INTO emergency_requests
    (homeowner_id, category, service_domain, service_specialty, title, location_text, status, assigned_at)
    VALUES ($1, 'plumbing', 'home_services', 'plumbing_repair', 'Emergency leak', 'Test location', 'assigned', CURRENT_TIMESTAMP) RETURNING *`, [ids.homeowner])).rows[0];
  const relationship = (await client.query(`INSERT INTO request_relationships
    (post_id, emergency_request_id, homeowner_id, contractor_id, professional_user_id, status)
    VALUES (NULL, $1, $2, $3, $4, 'active') RETURNING *`, [request.id, ids.homeowner, ids.profile, ids.professional])).rows[0];
  ids.conversation = (await client.query(`INSERT INTO conversations
    (relationship_id, homeowner_id, contractor_id, professional_user_id)
    VALUES ($1, $2, $3, $4) RETURNING id`, [relationship.id, ids.homeowner, ids.profile, ids.professional])).rows[0].id;
  const job = await ensureEmergencySelectionJob({ client, emergencyRequest: request, relationship, logger: quiet });
  const f = { ...ids, request: request.id, relationship: relationship.id, job: job.job.id, pool };
  success(await dispatch.markEmergencyEnRoute({ pool, authenticatedUserId: ids.professional, emergencyRequestId: request.id }));
  success(await dispatch.markEmergencyArrived({ pool, authenticatedUserId: ids.professional, emergencyRequestId: request.id }));
  return f;
}
function start(f, actor = f.professional) {
  return dispatch.startEmergencyWork({ pool: f.pool, authenticatedUserId: actor, emergencyRequestId: f.request });
}
async function completedEvaluation(f) {
  const created = success(await evaluation.createEvaluation({
    pool: f.pool, authenticatedActor: { id: f.professional },
    sourceContext: { type: "emergency_request", emergencyRequestId: f.request, relationshipId: f.relationship },
    content: { serviceType: "plumbing_repair", evaluationContext: "emergency_request",
      observations: "Supply seal is leaking.", findings: [{ summary: "Failed seal", severity: "high", customerShareable: true }],
      scopeRecommendations: ["Replace seal."], diagnosisSummary: "Failed seal" },
    expectedVersion: 0, idempotencyKey: randomUUID(),
  }));
  success(await evaluation.completeEvaluation({ pool: f.pool, authenticatedActor: { id: f.professional },
    evaluationId: created.aggregate.id, expectedVersion: created.aggregate.version,
    idempotencyKey: randomUUID() }));
}
async function issuedQuote(f, paymentTerms = "Balance due on completion") {
  const created = success(await quotes.createDraftQuote({ pool: f.pool, authenticatedActor: { id: f.professional },
    jobId: f.job, currency: "USD", customerTermsSnapshot: { schemaVersion: 1, paymentTerms,
      estimatedDuration: "1 day", customerNotes: "", agreement: { exclusions: [], additionalWorkTerms: "Written approval required.",
        hiddenConditionsTerms: "Revised Quote required.", diagnosticTerms: "Stated scope only.", customerResponsibilities: "Provide access.",
        warrantyTerms: "One year.", cancellationTerms: "As agreed.", acceptanceTerms: "Accepts issued Quote.", preauthorizedAdditionalWorkLimit: "$0" } },
    idempotencyKey: randomUUID(), logger: quiet }));
  const scoped = success(await quotes.addDraftScopeItem({ pool: f.pool, authenticatedActor: { id: f.professional },
    quoteId: created.quote.id, expectedVersion: created.quote.currentVersion,
    item: { classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE",
      description: "Replace seal", quantity: 1, unitAmountMinor: 10000, source: { type: "MANUAL_PROFESSIONAL" } },
    idempotencyKey: randomUUID(), logger: quiet }));
  return success(await quotes.issueQuote({ pool: f.pool, authenticatedActor: { id: f.professional },
    quoteId: created.quote.id, expectedVersion: scoped.quote.currentVersion, idempotencyKey: randomUUID(), logger: quiet })).quote;
}
function decide(f, quote, decision = "APPROVED", actor = f.homeowner) {
  return (decision === "APPROVED" ? quotes.approveIssuedQuote : quotes.declineIssuedQuote)({ pool: f.pool,
    authenticatedActor: { id: actor }, quoteId: quote.id, expectedIssuedVersion: quote.currentVersion,
    idempotencyKey: randomUUID(), logger: quiet });
}
function send(f, quote) {
  return delivery.sendQuoteInMeetro({ pool: f.pool, authenticatedActor: { id: f.professional }, quoteId: quote.id,
    expectedIssuedVersion: quote.currentVersion, idempotencyKey: randomUUID(), logger: quiet });
}
function pay(f, amount, expectedVersion) {
  return deposits.confirmDepositReceived({ pool: f.pool, authenticatedActor: { id: f.professional }, jobId: f.job,
    amountMinor: amount, currency: "USD", normalizedMethod: "BUSINESS_TRANSFER_APP", displayMethod: "Business transfer app",
    receivedAt: "2026-09-18T12:00:00.000Z", externalReference: randomUUID(), expectedVersion, idempotencyKey: randomUUID(), logger: quiet });
}

test("Task 4 rollback-only PostgreSQL migration and Emergency commercial workflow", { skip: !url }, async t => {
  assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    assert.equal((await client.query("SELECT to_regclass('jobs') AS existing")).rows[0].existing, null, "Use an empty disposable local test database");
    let foreignKeysBefore;
    const foreignKeys = () => client.query(`SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'canonical_pre_work_%' ORDER BY 1, 2`);
    for (const file of getMigrationFiles()) {
      if (file.filename === migrationName) foreignKeysBefore = (await foreignKeys()).rows;
      try { await client.query(readFileSync(join(__dirname, "..", "migrations", file.filename), "utf8")); }
      catch (error) { throw new Error(`${file.filename}: ${error.message}`, { cause: error }); }
    }
    assert.deepEqual((await foreignKeys()).rows, foreignKeysBefore);
    const pool = transactionalFacade(client);
    async function scenario(name, fn) {
      await t.test(name, async () => {
        await client.query("SAVEPOINT scenario");
        try { await fn(await fixture(client, pool)); }
        finally { await client.query("ROLLBACK TO SAVEPOINT scenario"); }
      });
    }
    await scenario("missing Evaluation and missing approval block the previous direct Start Work bypass", async f => {
      assert.equal((await start(f)).code, "EMERGENCY_EVALUATION_REQUIRED_BEFORE_WORK");
      assert.equal((await quotes.createDraftQuote({ pool, authenticatedActor: { id: f.professional }, jobId: f.job, currency: "USD",
        idempotencyKey: randomUUID(), logger: quiet })).code, "QUOTE_EVALUATION_REQUIRED");
      await completedEvaluation(f);
      assert.equal((await start(f)).code, "EMERGENCY_APPROVED_QUOTE_REQUIRED_BEFORE_WORK");
    });
    await scenario("issued delivered Quote can be read and approved only by exact homeowner; no deposit unlocks work", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f);
      assert.equal((await quotes.getCustomerIssuedQuote({ pool, authenticatedActor: { id: f.homeowner }, quoteId: quote.id })).code, "QUOTE_UNAVAILABLE");
      success(await send(f, quote));
      success(await quotes.getCustomerIssuedQuote({ pool, authenticatedActor: { id: f.homeowner }, quoteId: quote.id }));
      assert.equal((await decide(f, quote, "APPROVED", f.outsider)).code, "QUOTE_UNAVAILABLE");
      assert.equal((await decide(f, quote, "DECLINED", f.professional)).code, "QUOTE_UNAVAILABLE");
      success(await decide(f, quote));
      const approval = (await client.query("SELECT * FROM canonical_quote_approvals WHERE quote_id = $1", [quote.id])).rows[0];
      assert.equal(approval.approval_source, "MEETRO_CUSTOMER");
      assert.equal(approval.external_approval_evidence_id, null);
      assert.equal((await client.query("SELECT count(*)::integer AS count FROM canonical_pre_work_deposit_obligations")).rows[0].count, 0);
      assert.equal((await start(f)).code, "EMERGENCY_WORK_STARTED");
      assert.equal((await start(f)).code, "EMERGENCY_WORK_ALREADY_STARTED");
      for (const table of ["posts", "request_selections", "canonical_visits"]) {
        assert.equal((await client.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
      }
      const message = (await client.query("SELECT * FROM messages WHERE quote_id = $1 AND message_type = 'quote_shared'", [quote.id])).rows[0];
      assert.equal(message.conversation_id, f.conversation);
      assert.equal(message.sender_id, f.professional);
      assert.equal(message.receiver_id, f.homeowner);
      assert.equal(message.workflow_payload.job.title, "Emergency leak");
    });
    await scenario("required deposit materializes exact approval; due and partial block; satisfied permits work", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f, "50% deposit");
      success(await send(f, quote));
      success(await decide(f, quote));
      const source = (await client.query("SELECT * FROM canonical_pre_work_deposit_obligations WHERE job_id = $1", [f.job])).rows[0];
      assert.equal(source.job_request_id, null);
      assert.equal(source.relationship_id, f.relationship);
      assert.equal(source.approval_source, "MEETRO_CUSTOMER");
      assert.equal((await start(f)).code, "EMERGENCY_DEPOSIT_REQUIRED_BEFORE_WORK");
      await client.query("SAVEPOINT missing_obligation");
      await client.query("CREATE TEMP TABLE canonical_pre_work_deposit_obligations (LIKE public.canonical_pre_work_deposit_obligations)");
      assert.equal((await start(f)).code, "EMERGENCY_DEPOSIT_REQUIRED_BEFORE_WORK");
      await client.query("ROLLBACK TO SAVEPOINT missing_obligation");
      assert.equal(success(await pay(f, 2000, 1)).deposit.state, "PARTIALLY_SATISFIED");
      assert.equal((await start(f)).code, "EMERGENCY_DEPOSIT_REQUIRED_BEFORE_WORK");
      assert.equal(success(await pay(f, 3000, 2)).deposit.state, "SATISFIED");
      assert.equal((await start(f)).code, "EMERGENCY_WORK_STARTED");
    });
    await scenario("mismatched relationship, professional, homeowner and conversation fail closed", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f);
      success(await send(f, quote));
      for (const [table, column, value, id] of [
        ["conversations", "homeowner_id", f.outsider, f.conversation],
        ["request_relationships", "professional_user_id", f.outsider, f.relationship],
        ["request_relationships", "homeowner_id", f.outsider, f.relationship],
        ["request_relationships", "status", "closed", f.relationship],
      ]) {
        await client.query("SAVEPOINT mismatch");
        await client.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [value, id]);
        assert.equal((await decide(f, quote)).code, "QUOTE_UNAVAILABLE");
        assert.equal((await send(f, quote)).ok, false);
        assert.equal((await start(f)).success, false);
        await client.query("ROLLBACK TO SAVEPOINT mismatch");
      }
      assert.equal(await emergency.loadEmergencyProfessionalContext(client, { jobId: f.job, actorId: f.outsider }), null);
      const grants = (await client.query(`SELECT participants.user_id, grants.capability FROM lifecycle_authority_grants grants
        JOIN relationship_participants participants ON participants.id = grants.grantee_participant_id WHERE grants.job_id = $1`, [f.job])).rows;
      assert.deepEqual(grants.filter(row => row.user_id === f.professional).map(row => row.capability).sort(),
        ["evaluation.perform", "participant.read", "quote.create", "quote.issue", "quote.read", "quote.revise", "quote.scope.manage"]);
      assert.deepEqual(grants.filter(row => row.user_id === f.homeowner).map(row => row.capability).sort(),
        ["participant.read", "quote.approve", "quote.decline", "quote.read_customer"]);
    });
    await scenario("approval source rejects wrong decision participant, relationship, version, hash and external evidence", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f);
      success(await send(f, quote)); success(await decide(f, quote));
      const professional = (await client.query("SELECT id FROM relationship_participants WHERE job_id = $1 AND user_id = $2", [f.job, f.professional])).rows[0].id;
      for (const [table, column, value] of [
        ["canonical_quote_customer_decisions", "customer_participant_id", professional],
        ["canonical_quote_customer_decisions", "relationship_id", f.relationship + 100],
        ["canonical_quote_customer_decisions", "issued_quote_version", 999],
        ["canonical_quote_customer_decisions", "issued_integrity_hash", "b".repeat(64)],
        ["canonical_quote_approvals", "approval_source", "EXTERNAL_EVIDENCE"],
        ["canonical_quote_approvals", "external_approval_evidence_id", randomUUID()],
        ["canonical_quote_versions", "integrity_hash", "b".repeat(64)],
        ["canonical_quote_issuances", "issuer_participant_id", randomUUID()],
        ["canonical_quote_issuances", "source_snapshot_integrity_hash", "b".repeat(64)],
        ["canonical_quotes", "emergency_request_id", f.request + 100],
        ["canonical_quotes", "relationship_id", f.relationship + 100],
        ["canonical_quotes", "job_request_id", 100],
        ["canonical_quotes", "business_customer_job_source_id", randomUUID()],
      ]) {
        await client.query("SAVEPOINT corrupt_source");
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table})`);
        await client.query(`INSERT INTO ${table} SELECT * FROM public.${table}`);
        await client.query(`UPDATE ${table} SET ${column} = $1`, [value]);
        assert.equal(await emergency.loadEmergencyQuoteApprovalSource(client, { jobId: f.job }), null, `${table}.${column}`);
        assert.equal((await start(f)).code, "EMERGENCY_APPROVED_QUOTE_REQUIRED_BEFORE_WORK");
        await client.query("ROLLBACK TO SAVEPOINT corrupt_source");
      }
      const external = await quotes.recordExternalQuoteApproval({ pool, authenticatedActor: { id: f.professional },
        quoteId: quote.id, expectedIssuedVersion: quote.currentVersion, evidenceMethod: "IN_PERSON",
        approvedAt: "2026-09-18T12:00:00.000Z", idempotencyKey: randomUUID(), logger: quiet });
      assert.equal(external.ok, false);
    });
    await scenario("customer participant selection evidence and active role are required", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f);
      success(await send(f, quote));
      await client.query("CREATE TEMP TABLE relationship_participants (LIKE public.relationship_participants)");
      await client.query("INSERT INTO relationship_participants SELECT * FROM public.relationship_participants");
      for (const [column, value] of [["source_evidence_type", "request_selection"], ["request_relationship_id", f.relationship + 100]]) {
        await client.query("SAVEPOINT bad_participant");
        await client.query(`UPDATE relationship_participants SET ${column} = $1 WHERE user_id = $2`, [value, f.homeowner]);
        assert.equal((await decide(f, quote)).code, "QUOTE_UNAVAILABLE");
        await client.query("ROLLBACK TO SAVEPOINT bad_participant");
      }
      await client.query(`INSERT INTO participant_role_revocations
        (id, role_assignment_id, job_id, revoked_by_participant_id, revocation_reason, source_evidence_type, source_evidence_reference, idempotency_key)
        SELECT $1, roles.id, roles.job_id, roles.participant_id, 'Test revocation', 'emergency_selection', 'test', $2
        FROM participant_role_assignments roles WHERE roles.job_id = $3 AND roles.role = 'CUSTOMER_REPRESENTATIVE'`,
      [randomUUID(), randomUUID(), f.job]);
      assert.equal((await decide(f, quote)).code, "QUOTE_UNAVAILABLE");
    });
    await scenario("delivery repairs pre-Task-4 customer grants exactly once", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f);
      // A pre-Task-4 Job has only participant.read. Simulate it in an isolated
      // savepoint by shadowing the grants table; production history stays append-only.
      await client.query("CREATE TEMP TABLE lifecycle_authority_grants (LIKE public.lifecycle_authority_grants INCLUDING ALL)");
      await client.query(`INSERT INTO lifecycle_authority_grants SELECT grants.* FROM public.lifecycle_authority_grants grants
        JOIN relationship_participants participants ON participants.id = grants.grantee_participant_id
        WHERE participants.user_id <> $1 OR grants.capability = 'participant.read'`, [f.homeowner]);
      success(await send(f, quote));
      success(await quotes.getCustomerIssuedQuote({ pool, authenticatedActor: { id: f.homeowner }, quoteId: quote.id }));
      const before = (await client.query("SELECT count(*)::int AS count FROM lifecycle_authority_grants")).rows[0].count;
      success(await send(f, quote));
      assert.equal((await client.query("SELECT count(*)::int AS count FROM lifecycle_authority_grants")).rows[0].count, before);
      const grant = (await client.query("SELECT * FROM lifecycle_authority_grants WHERE job_id = $1 AND capability = 'quote.approve'", [f.job])).rows[0];
      assert.equal(grant.source_evidence_type, "emergency_selection");
      assert.equal((await client.query("SELECT user_id FROM relationship_participants WHERE id = $1", [grant.grantee_participant_id])).rows[0].user_id, f.homeowner);
    });
    await scenario("revoked homeowner approval grant is never restored by Quote delivery", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f);
      const grant = (await client.query("SELECT * FROM lifecycle_authority_grants WHERE job_id = $1 AND capability = 'quote.approve'", [f.job])).rows[0];
      await client.query(`INSERT INTO lifecycle_authority_grant_revocations
        (id, authority_grant_id, job_id, revoked_by_participant_id, revocation_reason, source_evidence_type, source_evidence_reference, idempotency_key)
        VALUES ($1, $2, $3, $4, 'Test revocation', 'emergency_selection', 'test', $5)`,
      [randomUUID(), grant.id, f.job, grant.grantee_participant_id, randomUUID()]);
      success(await send(f, quote));
      assert.equal((await decide(f, quote)).code, "QUOTE_UNAVAILABLE");
      assert.equal((await client.query("SELECT count(*)::int AS count FROM lifecycle_authority_grants WHERE job_id = $1 AND capability = 'quote.approve'", [f.job])).rows[0].count, 1);
    });
    await scenario("migration 103 validates Emergency obligations and every payment ledger; preserves all existing FKs", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f, "50% deposit");
      success(await send(f, quote)); success(await decide(f, quote));
      success(await pay(f, 2000, 1));
      // Re-running the migration validates real historical Emergency rows without writes.
      const counts = await client.query(`SELECT (SELECT count(*) FROM canonical_pre_work_deposit_obligations) AS obligations,
        (SELECT count(*) FROM canonical_pre_work_payment_receipts) AS receipts`);
      await client.query(migration);
      assert.deepEqual((await client.query(`SELECT (SELECT count(*) FROM canonical_pre_work_deposit_obligations) AS obligations,
        (SELECT count(*) FROM canonical_pre_work_payment_receipts) AS receipts`)).rows, counts.rows);
      await client.query("CREATE TEMP TABLE obligation_probe (LIKE canonical_pre_work_deposit_obligations INCLUDING CONSTRAINTS)");
      await client.query(`CREATE TRIGGER probe_origin BEFORE INSERT ON obligation_probe FOR EACH ROW
        EXECUTE FUNCTION assert_pre_work_deposit_obligation_job_origin()`);
      const obligation = (await client.query("SELECT * FROM canonical_pre_work_deposit_obligations WHERE job_id = $1", [f.job])).rows[0];
      const insertProbe = row => client.query(`INSERT INTO obligation_probe SELECT * FROM jsonb_populate_record(NULL::obligation_probe, $1::jsonb)`, [JSON.stringify(row)]);
      await insertProbe(obligation);
      async function rejects(action) {
        await client.query("SAVEPOINT rejection");
        try { await assert.rejects(action, /Emergency|source_shape|source does not match|Unsupported/); }
        finally { await client.query("ROLLBACK TO SAVEPOINT rejection"); }
      }
      for (const overrides of [{ relationship_id: f.relationship + 100 }, { relationship_id: null },
        { job_request_id: 123 }, { approval_source: "EXTERNAL_EVIDENCE" }, { customer_decision_id: null }, { customer_participant_id: null }]) {
        await rejects(() => insertProbe({ ...obligation, ...overrides }));
      }
      await client.query("CREATE TEMP TABLE ledger_probe (job_id uuid, relationship_id integer)");
      await client.query(`CREATE TRIGGER probe_origin BEFORE INSERT ON ledger_probe FOR EACH ROW
        EXECUTE FUNCTION assert_pre_work_payment_relationship_job_origin()`);
      await client.query("INSERT INTO ledger_probe VALUES ($1, $2)", [f.job, f.relationship]);
      for (const relationship of [null, f.relationship + 100]) {
        await rejects(() => client.query("INSERT INTO ledger_probe VALUES ($1, $2)", [f.job, relationship]));
      }
      // Shadow only Job rows to exercise trigger rejection independently of the
      // already-strict immutable Job constraints. All probes disappear on rollback.
      await client.query("CREATE TEMP TABLE jobs (LIKE public.jobs)");
      await client.query("INSERT INTO jobs SELECT * FROM public.jobs");
      await client.query("SET LOCAL search_path = pg_temp, public");
      await client.query(migration);
      for (const [column, value] of [["job_request_id", 123], ["source_request_selection_id", 123],
        ["source_emergency_request_id", f.request + 100], ["source_request_relationship_id", f.relationship + 100],
        ["contractor_profile_id", f.profile], ["business_contact_id", randomUUID()], ["business_customer_relationship_id", randomUUID()],
        ["originating_business_document_id", randomUUID()], ["source_business_customer_job_id", randomUUID()]]) {
        await client.query("SAVEPOINT malformed_job");
        await client.query(`UPDATE jobs SET ${column} = $1 WHERE id = $2`, [value, f.job]);
        await rejects(() => insertProbe(obligation));
        await rejects(() => client.query("INSERT INTO ledger_probe VALUES ($1, $2)", [f.job, f.relationship]));
        await rejects(() => client.query(migration));
        await client.query("ROLLBACK TO SAVEPOINT malformed_job");
      }
      await client.query("CREATE TEMP TABLE canonical_pre_work_deposit_obligations (LIKE public.canonical_pre_work_deposit_obligations)");
      await client.query("INSERT INTO canonical_pre_work_deposit_obligations SELECT * FROM public.canonical_pre_work_deposit_obligations");
      for (const [column, value] of [["job_request_id", 123], ["relationship_id", f.relationship + 100]]) {
        await client.query("SAVEPOINT malformed_history");
        await client.query(`UPDATE canonical_pre_work_deposit_obligations SET ${column} = $1`, [value]);
        await rejects(() => client.query(migration));
        await client.query("ROLLBACK TO SAVEPOINT malformed_history");
      }
    });
    await scenario("unverified approved deposit terms remain blocked", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f, "Deposit due on approval");
      success(await send(f, quote)); success(await decide(f, quote));
      assert.equal((await start(f)).code, "EMERGENCY_DEPOSIT_TERMS_UNVERIFIED");
    });
    await scenario("declined Quote cannot unlock work", async f => {
      await completedEvaluation(f);
      const quote = await issuedQuote(f);
      success(await send(f, quote)); success(await decide(f, quote, "DECLINED"));
      assert.equal((await start(f)).code, "EMERGENCY_APPROVED_QUOTE_REQUIRED_BEFORE_WORK");
      assert.equal((await client.query("SELECT count(*)::integer AS count FROM canonical_quote_approvals")).rows[0].count, 0);
    });
  } finally {
    await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT to_regclass('jobs') AS existing")).rows[0].existing, null);
    await client.end();
  }
});
