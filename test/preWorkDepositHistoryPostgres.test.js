"use strict";
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");
// Seed pre-78 records with the actual pre-generalization application code.
// Keep its module cache isolated: assertions after upgrade use current runtime.
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const historicalModules = new Map();
function historicalRequire(relative) {
  const filename = path.resolve(root, relative);
  if (historicalModules.has(filename)) return historicalModules.get(filename).exports;
  const source = execFileSync("git", ["show", `4819151546087e495cd116d6283c74bd16f7f63d:${path.relative(root, filename)}`], { cwd: root, encoding: "utf8" });
  const module = new Module(filename);
  module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  historicalModules.set(filename, module);
  const normalRequire = module.require.bind(module);
  module.require = request => {
    if (request.startsWith(".")) {
      const resolved = Module._resolveFilename(request, module);
      if (resolved.startsWith(root + path.sep) && !resolved.includes("node_modules") && resolved.endsWith(".js")) return historicalRequire(path.relative(root, resolved));
    }
    return normalRequire(request);
  };
  module._compile(source, filename); return module.exports;
}
const { createVisitTestIdentities, createVisitLifecycleFixture, ensureVisitEvaluation, quiet } = process.env.PRE_WORK_DEPOSIT_HISTORY_DATABASE_URL
  ? historicalRequire("test/helpers/visitLifecycleFixture.js") : {};
const { createDraftQuote, addDraftScopeItem, issueQuote } = process.env.PRE_WORK_DEPOSIT_HISTORY_DATABASE_URL
  ? historicalRequire("server/authorization/quoteDraftService.js") : {};
const { completeEvaluation } = process.env.PRE_WORK_DEPOSIT_HISTORY_DATABASE_URL
  ? historicalRequire("server/authorization/evaluationService.js") : {};
const { sendQuoteInMeetro } = process.env.PRE_WORK_DEPOSIT_HISTORY_DATABASE_URL
  ? historicalRequire("server/authorization/quoteDeliveryService.js") : {};
const { getProfessionalDepositStatus, confirmDepositReceived, reverseDepositAllocation, materializePreWorkDepositObligation } = require("../server/finance/preWorkDepositService");
const hash = value => createHash("sha256").update(String(value)).digest("hex");

// Minimal synthetic marketplace evidence using the pre-78 insert contract.
// No live customer data or disabled triggers are used.
const depositTerms = Object.freeze({
  schemaVersion: 1,
  paymentTerms: "75% deposit; balance due on completion.",
  estimatedDuration: "1 day",
  customerNotes: "",
  agreement: Object.freeze({
    exclusions: [],
    additionalWorkTerms: "Written customer approval is required.",
    hiddenConditionsTerms: "Hidden conditions require a revised Quote.",
    diagnosticTerms: "Diagnostic work is limited to the stated scope.",
    customerResponsibilities: "Provide safe site access.",
    warrantyTerms: "One-year workmanship warranty.",
    cancellationTerms: "Cancellation terms apply as stated.",
    acceptanceTerms: "Approval accepts this exact issued Quote.",
    preauthorizedAdditionalWorkLimit: "$0",
  }),
});

async function createIssuedDepositQuote(pool, identities, fixture, suffix) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completed = await completeEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis: "Reviewed the synthetic deposit fixture with the customer by phone.",
    idempotencyKey: `deposit-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(completed.ok, true, completed.code);
  const created = await createDraftQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    customerTermsSnapshot: depositTerms,
    idempotencyKey: `deposit-quote-create-${suffix}`,
    logger: quiet,
  });
  assert.equal(created.ok, true, created.code);
  const scoped = await addDraftScopeItem({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: created.quote.currentVersion,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: "Synthetic approved work",
      quantity: 1,
      unitAmountMinor: 68000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `deposit-quote-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `deposit-quote-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  return {
    issuedVersion: issued.quote.currentVersion,
    quoteId: issued.quote.id,
  };
}

async function createDeliveredDepositQuote(pool, identities, fixture, suffix) {
  const issued = await createIssuedDepositQuote(pool, identities, fixture, suffix);
  const delivered = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: issued.quoteId,
    expectedIssuedVersion: issued.issuedVersion,
    idempotencyKey: `deposit-quote-deliver-${suffix}`,
    logger: quiet,
  });
  assert.equal(delivered.ok, true, delivered.code);
  return issued;
}

async function insertLegacyApprovedDecision(pool, identities, fixture, quote) {
  const source = await pool.query(
    `SELECT canonical_quotes.relationship_id,
       issuances.source_snapshot_integrity_hash,
       customer.id AS customer_participant_id,
       grants.id AS authority_grant_id
     FROM canonical_quotes
     INNER JOIN canonical_quote_issuances issuances
       ON issuances.quote_id = canonical_quotes.id
       AND issuances.job_id = canonical_quotes.job_id
       AND issuances.quote_version = $2
     INNER JOIN request_relationships relationships
       ON relationships.id = canonical_quotes.relationship_id
     INNER JOIN relationship_participants customer
       ON customer.job_id = canonical_quotes.job_id
       AND customer.request_relationship_id = canonical_quotes.relationship_id
       AND customer.user_id = relationships.homeowner_id
     INNER JOIN lifecycle_authority_grants grants
       ON grants.grantee_participant_id = customer.id
       AND grants.job_id = canonical_quotes.job_id
       AND grants.capability = 'quote.approve'
       AND grants.valid_from <= CURRENT_TIMESTAMP
       AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
     LEFT JOIN lifecycle_authority_grant_revocations revocations
       ON revocations.authority_grant_id = grants.id
     WHERE canonical_quotes.id = $1
       AND canonical_quotes.job_id = $3
       AND revocations.id IS NULL
     LIMIT 1`,
    [quote.quoteId, quote.issuedVersion, fixture.jobId]
  );
  assert.ok(source.rows[0]);
  const commandId = randomUUID();
  const decisionId = randomUUID();
  await pool.query(
    `INSERT INTO commercial_command_idempotency (
       id, actor_user_id, command_name, command_scope,
       idempotency_key, request_fingerprint, aggregate_id,
       result_reference, completed_at
     ) VALUES ($1, $2, 'quote.customer.approve', $3, $4, $5, $6,
       $7::jsonb, CURRENT_TIMESTAMP)`,
    [
      commandId,
      identities.homeownerId,
      `quote:${quote.quoteId}:customer-decision`,
      `legacy-decision-${decisionId}`,
      "b".repeat(64),
      quote.quoteId,
      JSON.stringify({ code: "LEGACY_APPROVED_DECISION_FIXTURE", quoteId: quote.quoteId }),
    ]
  );
  await pool.query(
    `INSERT INTO canonical_quote_customer_decisions (
       id, quote_id, issued_quote_version, job_id, relationship_id,
       customer_participant_id, authority_grant_id, decision,
       idempotency_id, issued_integrity_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED', $8, $9)`,
    [
      decisionId,
      quote.quoteId,
      quote.issuedVersion,
      fixture.jobId,
      Number(source.rows[0].relationship_id),
      source.rows[0].customer_participant_id,
      source.rows[0].authority_grant_id,
      commandId,
      source.rows[0].source_snapshot_integrity_hash,
    ]
  );

  const approvalId = randomUUID();
  const approval = await pool.query(
    `INSERT INTO canonical_quote_approvals (
       id,
       quote_id,
       issued_quote_version,
       job_id,
       approval_source,
       decision,
       customer_decision_id,
       external_approval_evidence_id,
       issued_integrity_hash,
       approved_at
     )
     SELECT
       $1,
       decisions.quote_id,
       decisions.issued_quote_version,
       decisions.job_id,
       'MEETRO_CUSTOMER',
       'APPROVED',
       decisions.id,
       NULL,
       decisions.issued_integrity_hash,
       decisions.decided_at
     FROM canonical_quote_customer_decisions decisions
     WHERE decisions.id = $2
     RETURNING id`,
    [approvalId, decisionId]
  );

  assert.equal(
    approval.rowCount,
    1,
    "Legacy approved decision fixture requires canonical Quote approval provenance."
  );

  return decisionId;
}

async function insertCommand(pool, {
  jobId,
  participantId = null,
  externalActor = null,
  commandName,
  scope,
  key = randomUUID(),
}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO canonical_pre_work_payment_command_idempotency (
       id, job_id, actor_type, actor_participant_id,
       actor_external_reference, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      jobId,
      participantId ? "PARTICIPANT" : "PROCESSOR",
      participantId,
      externalActor,
      commandName,
      scope,
      key,
      hash(`${commandName}:${scope}:${key}`),
    ]
  );
  return { id, key };
}

async function insertObligation(pool, source, commandId, overrides = {}) {
  const requiredMinor = overrides.requiredMinor ?? Math.round(Number(source.total_minor) * 0.75);
  const values = {
    id: randomUUID(),
    jobId: source.job_id,
    jobRequestId: Number(source.job_request_id),
    relationshipId: Number(source.relationship_id),
    quoteId: source.quote_id,
    quoteVersion: Number(source.issued_quote_version),
    quoteApprovalId: source.quote_approval_id,
    approvalSource: source.approval_source,
    decisionId: source.customer_decision_id,
    decision: source.decision,
    customerParticipantId: source.customer_participant_id,
    currency: source.currency,
    quoteTotalMinor: Number(source.total_minor),
    ruleType: "PERCENT",
    percentBasisPoints: 7500,
    fixedMinor: null,
    requiredMinor,
    sourceHash: source.issued_integrity_hash,
    effectiveAt: source.decided_at,
    creatorId: source.customer_participant_id,
    commandId,
    ...overrides,
  };
  await pool.query(
    `INSERT INTO canonical_pre_work_deposit_obligations (
       id, job_id, job_request_id, relationship_id,
       quote_id, issued_quote_version,
       customer_decision_id, customer_decision,
       customer_participant_id, currency,
       quote_total_minor, deposit_rule_type,
       deposit_percent_basis_points, deposit_fixed_minor,
       required_minor, source_integrity_hash, effective_at,
       created_by_participant_id, created_command_idempotency_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19
     )`,
    [
      values.id,
      values.jobId,
      values.jobRequestId,
      values.relationshipId,
      values.quoteId,
      values.quoteVersion,
      values.decisionId,
      values.decision,
      values.customerParticipantId,
      values.currency,
      values.quoteTotalMinor,
      values.ruleType,
      values.percentBasisPoints,
      values.fixedMinor,
      values.requiredMinor,
      values.sourceHash,
      values.effectiveAt,
      values.creatorId,
      values.commandId,
    ]
  );
  return values;
}

async function insertVersion(pool, obligation, commandId, {
  version,
  state,
  appliedMinor,
  remainingMinor,
  actorId,
}) {
  await pool.query(
    `INSERT INTO canonical_pre_work_deposit_versions (
       obligation_id, version, job_id, relationship_id, currency,
       state, required_minor, applied_minor, remaining_minor,
       recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      obligation.id,
      version,
      obligation.jobId,
      obligation.relationshipId,
      obligation.currency,
      state,
      obligation.requiredMinor,
      appliedMinor,
      remainingMinor,
      actorId,
      commandId,
      hash(`deposit-version:${obligation.id}:${version}:${state}`),
    ]
  );
}

async function insertEvent(pool, obligation, commandId, {
  version,
  previousVersion,
  eventType,
  state,
  receiptId = null,
  allocationId = null,
  reversalId = null,
  actorId,
}) {
  await pool.query(
    `INSERT INTO canonical_pre_work_deposit_events (
       id, obligation_id, obligation_version, previous_obligation_version,
       job_id, event_type, obligation_state, receipt_id, allocation_id,
       reversal_id, recorded_by_participant_id, command_idempotency_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      randomUUID(),
      obligation.id,
      version,
      previousVersion,
      obligation.jobId,
      eventType,
      state,
      receiptId,
      allocationId,
      reversalId,
      actorId,
      commandId,
    ]
  );
}

async function insertReceipt(pool, source, commandId, {
  amountMinor,
  evidenceSource = "MANUAL_EXTERNAL",
  normalizedMethod = null,
  displayMethod = null,
  externalReference = null,
  actorId = null,
}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO canonical_pre_work_payment_receipts (
       id, job_id, relationship_id, gross_amount_minor, currency,
       evidence_source, normalized_method, display_method,
       external_reference, received_at, recorded_by_participant_id,
       command_idempotency_id, integrity_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       '2026-08-28T12:00:00.000Z', $10, $11, $12)`,
    [
      id,
      source.job_id,
      Number(source.relationship_id),
      amountMinor,
      source.currency,
      evidenceSource,
      normalizedMethod,
      displayMethod,
      externalReference,
      actorId,
      commandId,
      hash(`receipt:${id}:${amountMinor}`),
    ]
  );
  return { id, amountMinor };
}

async function insertAllocation(pool, source, obligation, receipt, commandId, amountMinor, actorId) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO canonical_pre_work_payment_allocations (
       id, receipt_id, obligation_id, job_id, relationship_id,
       currency, allocated_minor, recorded_by_participant_id,
       command_idempotency_id, integrity_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      receipt.id,
      obligation.id,
      source.job_id,
      Number(source.relationship_id),
      source.currency,
      amountMinor,
      actorId,
      commandId,
      hash(`allocation:${id}:${amountMinor}`),
    ]
  );
  return { id, amountMinor };
}


const historyUrl = process.env.PRE_WORK_DEPOSIT_HISTORY_DATABASE_URL;
const freshUrl = process.env.PRE_WORK_DEPOSIT_FRESH_DATABASE_URL;
const tables = ["canonical_pre_work_deposit_obligations", "canonical_pre_work_deposit_versions",
  "canonical_pre_work_payment_receipts", "canonical_pre_work_payment_allocations",
  "canonical_pre_work_payment_allocation_reversals", "canonical_pre_work_deposit_events",
  "canonical_pre_work_payment_command_idempotency", "canonical_quote_customer_decisions",
  "canonical_quote_approvals", "canonical_quotes", "canonical_quote_versions", "canonical_quote_issuances"];
async function snapshot(pool) {
  const result = {};
  for (const table of tables) {
    const evidence = table === "canonical_pre_work_deposit_obligations"
      ? "to_jsonb(r) - 'quote_approval_id' - 'approval_source'" : "to_jsonb(r)";
    result[table] = (await pool.query(`SELECT (${evidence}) AS evidence FROM ${table} r ORDER BY (${evidence})::text`)).rows;
  }
  return result;
}
async function rejectWrite(pool, action, code) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await assert.rejects(action(c), e => e.code === code); await c.query("ROLLBACK"); }
  finally { c.release(); }
}
async function certifyLedger(pool, migrations) {
  const rows = (await pool.query("SELECT filename,checksum FROM schema_migrations ORDER BY filename")).rows;
  assert.deepEqual(rows, migrations.map(({ filename, checksum }) => ({ filename, checksum })));
}

test("migration 78 preserves historical deposits and payments through ledger 81", { skip: !historyUrl }, async t => {
  const database = assertSafeTestDatabaseUrl(historyUrl, { nodeEnv: process.env.NODE_ENV });
  const pool = new Pool({ connectionString: historyUrl }); t.after(() => pool.end());
  const migrations = getMigrationFiles(), target = { target: "local-test", database };
  const baseline = await runMigrationCollection(pool, migrations.slice(0, 77), target);
  assert.equal(baseline.success, true); assert.equal(baseline.applied.length, 77);
  const suffix = randomUUID(), identities = await createVisitTestIdentities(pool, suffix);
  const fixture = await createVisitLifecycleFixture(pool, identities, suffix);
  const quote = await createDeliveredDepositQuote(pool, identities, fixture, suffix);
  const decisionId = await insertLegacyApprovedDecision(pool, identities, fixture, quote);
  const source = (await pool.query(`SELECT d.id AS customer_decision_id,d.quote_id,d.issued_quote_version,
    d.job_id,d.relationship_id,d.decision,d.issued_integrity_hash,d.customer_participant_id,d.decided_at,
    a.id AS quote_approval_id,a.approval_source,v.currency,v.total_minor,j.job_request_id
    FROM canonical_quote_customer_decisions d JOIN canonical_quote_approvals a ON a.customer_decision_id=d.id
    JOIN canonical_quote_versions v ON v.quote_id=d.quote_id AND v.version=d.issued_quote_version
    JOIN jobs j ON j.id=d.job_id WHERE d.id=$1`, [decisionId])).rows[0];
  const actorId = fixture.homeownerParticipantId;
  const cmd = await insertCommand(pool, {jobId:fixture.jobId,participantId:actorId,commandName:"deposit.materialize",scope:`decision:${decisionId}`});
  const obligation = await insertObligation(pool, source, cmd.id);
  await insertVersion(pool, obligation, cmd.id, {version:1,state:"DUE",appliedMinor:0,remainingMinor:obligation.requiredMinor,actorId});
  await insertEvent(pool, obligation, cmd.id, {version:1,previousVersion:null,eventType:"DEPOSIT_OBLIGATION_CREATED",state:"DUE",actorId});
  const pay = await insertCommand(pool, {jobId:fixture.jobId,participantId:actorId,commandName:"deposit.payment.record",scope:`obligation:${obligation.id}:payments`});
  const receipt = await insertReceipt(pool,source,pay.id,{amountMinor:1000,normalizedMethod:"CASH",actorId});
  const allocationCmd = await insertCommand(pool,{jobId:fixture.jobId,participantId:actorId,commandName:"deposit.payment.allocate",scope:`obligation:${obligation.id}:allocation`});
  const allocation = await insertAllocation(pool,source,obligation,receipt,allocationCmd.id,1000,actorId);
  await insertVersion(pool,obligation,allocationCmd.id,{version:2,state:"PARTIALLY_SATISFIED",appliedMinor:1000,remainingMinor:obligation.requiredMinor-1000,actorId});
  await insertEvent(pool,obligation,allocationCmd.id,{version:2,previousVersion:1,eventType:"DEPOSIT_PAYMENT_ALLOCATED",state:"PARTIALLY_SATISFIED",receiptId:receipt.id,allocationId:allocation.id,actorId});
  const before = await snapshot(pool);
  const triggers = (await pool.query(`SELECT t.tgname,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function
    FROM pg_trigger t WHERE t.tgrelid='canonical_pre_work_deposit_obligations'::regclass AND t.tgname='canonical_pre_work_deposit_obligations_append_only'`)).rows;
  assert.equal(triggers.length,1); assert.match(triggers[0].function,/55000/);
  // Original migration-78 ADD COLUMN + UPDATE, before any corrected migration.
  await rejectWrite(pool, async c => {
    await c.query("ALTER TABLE canonical_pre_work_deposit_obligations ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT");
    await c.query(`UPDATE canonical_pre_work_deposit_obligations obligations
      SET quote_approval_id=approvals.id,approval_source=approvals.approval_source
      FROM canonical_quote_approvals approvals WHERE obligations.customer_decision_id IS NOT NULL
      AND approvals.customer_decision_id=obligations.customer_decision_id AND approvals.quote_id=obligations.quote_id
      AND approvals.issued_quote_version=obligations.issued_quote_version AND approvals.job_id=obligations.job_id
      AND approvals.issued_integrity_hash=obligations.source_integrity_hash`);
  }, "55000");
  assert.deepEqual(await snapshot(pool),before);
  const upgraded = await runMigrationCollection(pool,migrations,target);
  assert.equal(upgraded.success,true,JSON.stringify(upgraded)); assert.equal(upgraded.applied.length,4);
  assert.deepEqual(upgraded.failed,[]); await certifyLedger(pool,migrations);
  assert.deepEqual(await snapshot(pool),before);
  assert.deepEqual((await pool.query("SELECT quote_approval_id,approval_source FROM canonical_pre_work_deposit_obligations WHERE id=$1",[obligation.id])).rows[0],{quote_approval_id:null,approval_source:null});
  const afterTriggers = (await pool.query(`SELECT t.tgname,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function
    FROM pg_trigger t WHERE t.tgrelid='canonical_pre_work_deposit_obligations'::regclass AND t.tgname='canonical_pre_work_deposit_obligations_append_only'`)).rows;
  assert.deepEqual(afterTriggers,triggers);
  await rejectWrite(pool,c=>c.query("UPDATE canonical_pre_work_deposit_obligations SET quote_approval_id=$1,approval_source='MEETRO_CUSTOMER' WHERE id=$2",[source.quote_approval_id,obligation.id]),"55000");
  // Old insert shape is rejected for NEW rows, even though genuine old rows retain NULLs.
  await rejectWrite(pool,c=>insertObligation(c,source,cmd.id),"P0001");
  const base = {pool,authenticatedActor:{id:identities.professionalId},jobId:fixture.jobId,logger:quiet};
  const read = await getProfessionalDepositStatus(base); assert.equal(read.ok,true,read.code);
  assert.equal(read.deposit.obligationId,obligation.id); assert.equal(read.deposit.appliedMinor,1000);
  const materialized = await materializePreWorkDepositObligation({...base,idempotencyKey:randomUUID()});
  assert.equal(materialized.ok,true,materialized.code); assert.equal(materialized.deposit.obligationId,obligation.id);
  const reversed = await reverseDepositAllocation({...base,allocationId:allocation.id,amountMinor:500,
    reasonCategory:"CORRECTION",reason:"Synthetic historical correction",expectedVersion:2,idempotencyKey:randomUUID()});
  assert.equal(reversed.ok,true,reversed.code);
  const paid = await confirmDepositReceived({...base,amountMinor:obligation.requiredMinor-500,currency:"USD",normalizedMethod:"CASH",
    receivedAt:new Date().toISOString(),expectedVersion:3,idempotencyKey:randomUUID()});
  assert.equal(paid.ok,true,paid.code); assert.equal(paid.deposit.state,"SATISFIED");
  const appended = await snapshot(pool);
  for (const table of tables) for (const row of before[table]) assert(appended[table].some(r=>JSON.stringify(r)===JSON.stringify(row)),`${table} historical row changed`);
  const replay = await runMigrationCollection(pool,migrations,target);
  assert.equal(replay.applied.length,0); assert.equal(replay.skipped.length,82); assert.deepEqual(replay.failed,[]);
  t.diagnostic(JSON.stringify({originalFailure:"55000",applied:upgraded.applied,ledger:81,replay:{applied:0,skipped:81,failed:[]},
    historicalCounts:Object.fromEntries(tables.map(table=>[table,before[table].length])),historicalSha256:hash(JSON.stringify(before)),historicalUnchanged:true,legacyRuntimeReadPaymentReversal:true}));
});

test("corrected migration 78 supports a fresh install through ledger 81", { skip: !freshUrl }, async t => {
  const database=assertSafeTestDatabaseUrl(freshUrl,{nodeEnv:process.env.NODE_ENV});
  const pool=new Pool({connectionString:freshUrl});t.after(()=>pool.end());
  const migrations=getMigrationFiles(),target={target:"local-test",database};
  const result=await runMigrationCollection(pool,migrations,target);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.applied.length,82);
  await certifyLedger(pool,migrations);const replay=await runMigrationCollection(pool,migrations,target);
  assert.equal(replay.applied.length,0);assert.equal(replay.skipped.length,82);assert.deepEqual(replay.failed,[]);
  t.diagnostic(JSON.stringify({freshApplied:81,ledger:81,replay:{applied:0,skipped:81,failed:[]}}));
});
