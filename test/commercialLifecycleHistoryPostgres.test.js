"use strict";

const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");
const { getVisit, listVisits } = require("../server/workflow/visitService");
const { getProfessionalSchedule } = require("../server/workflow/professionalScheduleService");
const { activateApprovedWorkVisitAuthority } = require("../server/workflow/approvedWorkVisitService");
const { getWorkPreparation, reviseWorkPreparation } = require("../server/workflow/workPreparationService");
const { getApprovedWorkExecution } = require("../server/workflow/approvedWorkExecutionService");
const { hasActiveLifecycleGrant } = require("../server/authorization/lifecycleAuthorityService");
const { quiet } = require("./helpers/visitLifecycleFixture");
const databaseUrl = process.env.COMMERCIAL_LIFECYCLE_HISTORY_DATABASE_URL;
const sha = (value) => createHash("sha256").update(value).digest("hex");

// This target must be a fresh disposable copy of the certified ledger-79
// marketplace fixture. The original certificate database is never mutated.
test("migrations 80–81 preserve historical marketplace rows and extend legacy roots", { skip: !databaseUrl }, async (t) => {
  const database = assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  assert.deepEqual((await pool.query("SELECT max(id)::int AS max, count(*)::int AS count FROM schema_migrations")).rows[0], { max: 79, count: 79 });
  const legacy = (await pool.query(`SELECT v.id AS visit_id, v.job_id, v.approved_quote_decision_id,
    a.id AS quote_approval_id, a.quote_id, a.issued_quote_version, a.issued_integrity_hash,
    d.customer_participant_id, j.job_request_id, j.source_request_relationship_id AS relationship_id,
    p.id AS professional_participant_id, p.user_id, r.id AS role_id, q.currency
    FROM canonical_visits v JOIN canonical_quote_approvals a ON a.customer_decision_id=v.approved_quote_decision_id
    JOIN canonical_quote_customer_decisions d ON d.id=a.customer_decision_id
    JOIN jobs j ON j.id=v.job_id
    JOIN participant_role_assignments r ON r.job_id=v.job_id AND r.role='PRIMARY_PROFESSIONAL'
    JOIN relationship_participants p ON p.id=r.participant_id
    JOIN canonical_quote_versions q ON q.quote_id=a.quote_id AND q.version=a.issued_quote_version
    WHERE v.purpose='APPROVED_WORK' AND v.quote_approval_id IS NULL LIMIT 1`)).rows[0];
  assert.ok(legacy);
  const planId = randomUUID(), executionId = randomUUID();
  // Genuine marketplace provenance, inserted under the pre-81 contract.
  for (const [domain, id, commandName] of [
    ["work_preparation", planId, "work_preparation.plan.create"],
    ["approved_work_execution", executionId, "approved_work.execution.materialize"],
  ]) {
    const commandId = randomUUID();
    await pool.query(`INSERT INTO canonical_${domain}_command_idempotency
      (id,job_id,actor_participant_id,command_name,command_scope,idempotency_key,request_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [commandId,legacy.job_id,legacy.professional_participant_id,commandName,
      `history:${id}`,randomUUID(),sha(id)]);
    const root = domain === "work_preparation" ? "canonical_work_preparation_plans" : "canonical_approved_work_executions";
    await pool.query(`INSERT INTO ${root} (id,job_id,job_request_id,relationship_id,quote_id,issued_quote_version,
      approved_customer_decision_id,customer_participant_id,commercial_currency,source_integrity_hash,
      created_by_professional_participant_id,created_by_role_assignment_id,created_command_idempotency_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id,legacy.job_id,legacy.job_request_id,
      legacy.relationship_id,legacy.quote_id,legacy.issued_quote_version,legacy.approved_quote_decision_id,
      legacy.customer_participant_id,legacy.currency,legacy.issued_integrity_hash,legacy.professional_participant_id,
      legacy.role_id,commandId]);
    if (domain === "work_preparation") {
      await pool.query(`INSERT INTO canonical_work_preparation_plan_versions (plan_id,version,job_id,relationship_id,
        planning_state,work_start_policy,recorded_by_participant_id,command_idempotency_id,integrity_hash)
        VALUES ($1,1,$2,$3,'PLANNING','REQUIRED_ITEMS_READY',$4,$5,$6)`,
        [id,legacy.job_id,legacy.relationship_id,legacy.professional_participant_id,commandId,sha(`plan:${id}`)]);
    } else {
      await pool.query(`INSERT INTO canonical_approved_work_execution_versions (execution_id,version,job_id,relationship_id,
        customer_participant_id,state,recorded_by_participant_id,command_idempotency_id,integrity_hash)
        VALUES ($1,1,$2,$3,$4,'ACTIVE',$5,$6,$7)`,
        [id,legacy.job_id,legacy.relationship_id,legacy.customer_participant_id,legacy.professional_participant_id,commandId,sha(`execution:${id}`)]);
    }
  }
  for (const capability of ["work_preparation.plan.read", "work_preparation.plan.write", "approved_work.execution.manage", "approved_work.execute"]) {
    await pool.query(`INSERT INTO lifecycle_authority_grants (id,grantee_participant_id,grantor_participant_id,job_id,
      capability,scope_type,scope_job_id,scope_approved_quote_decision_id,scope_approved_quote_decision,
      scope_quote_approval_id,scope_quote_approval_source,source_evidence_type,source_evidence_reference,idempotency_key)
      VALUES ($1,$2,$2,$3,$4,'approved_work',$3,$5,'APPROVED',$6,'MEETRO_CUSTOMER','historical_test_fixture',$7,$8)`,
      [randomUUID(),legacy.professional_participant_id,legacy.job_id,capability,legacy.approved_quote_decision_id,
        legacy.quote_approval_id,executionId,randomUUID()]);
  }
  const tables = ["canonical_approved_work_visit_authority_activations", "lifecycle_authority_grants", "canonical_visits",
    "canonical_visit_versions", "canonical_visit_events", "canonical_work_preparation_plans", "canonical_work_preparation_plan_versions",
    "canonical_approved_work_executions", "canonical_approved_work_execution_versions", "canonical_quote_approvals",
    "canonical_pre_work_deposit_obligations", "canonical_pre_work_deposit_versions", "canonical_pre_work_payment_allocations"];
  async function snapshot() {
    const result = {};
    for (const table of tables) result[table] = (await pool.query(`SELECT
      (to_jsonb(row) - 'quote_approval_id' - 'approval_source') AS evidence FROM ${table} row
      ORDER BY (to_jsonb(row) - 'quote_approval_id' - 'approval_source')::text`)).rows;
    return result;
  }
  const before = await snapshot();
  const migrations = getMigrationFiles();
  const migrated = await runMigrationCollection(pool,migrations,{target:"local-test",database});
  assert.equal(migrated.success,true,JSON.stringify(migrated.failed));
  assert.equal(migrated.applied.length,2);
  assert.deepEqual(await snapshot(),before);
  const replay = await runMigrationCollection(pool,migrations,{target:"local-test",database});
  assert.equal(replay.applied.length,0);
  assert.equal(replay.skipped.length,83);
  assert.deepEqual(replay.failed,[]);
  const base = { pool, authenticatedActor:{id:Number(legacy.user_id)}, jobId:legacy.job_id, logger:quiet };
  assert.equal((await getVisit({...base,visitId:legacy.visit_id})).visit.id,legacy.visit_id);
  assert.equal((await listVisits(base)).ok,true);
  assert.equal((await getProfessionalSchedule({pool,authenticatedActor:base.authenticatedActor})).ok,true);
  assert.equal(await hasActiveLifecycleGrant({client:pool,participantId:legacy.professional_participant_id,
    jobId:legacy.job_id,quoteApprovalId:legacy.quote_approval_id,capability:"visit.propose",allowJobScope:false}),true);
  const activated = await activateApprovedWorkVisitAuthority({...base,quoteId:legacy.quote_id,idempotencyKey:randomUUID()});
  assert.equal(activated.code,"APPROVED_WORK_VISIT_AUTHORITY_ALREADY_ACTIVE");
  const prep = await getWorkPreparation(base);
  assert.equal(prep.ok,true,prep.code);
  assert.equal(prep.workPreparation.source.quoteApprovalId,legacy.quote_approval_id);
  const execution = await getApprovedWorkExecution({...base,executionId});
  assert.equal(execution.ok,true,execution.code);
  assert.equal(execution.execution.source.quoteApprovalId,legacy.quote_approval_id);
  const revised = await reviseWorkPreparation({...base,planId,expectedVersion:1,planningState:"PLANNED",
    workStartPolicy:"NONE",items:[],idempotencyKey:randomUUID()});
  assert.equal(revised.ok,true,revised.code);
  assert.deepEqual((await pool.query(`SELECT version,quote_approval_id,approval_source FROM canonical_work_preparation_plan_versions
    WHERE plan_id=$1 ORDER BY version`,[planId])).rows, [
    {version:1,quote_approval_id:null,approval_source:null},
    {version:2,quote_approval_id:legacy.quote_approval_id,approval_source:"MEETRO_CUSTOMER"},
  ]);
  for (const table of ["canonical_approved_work_visit_authority_activations", "canonical_visits", "canonical_work_preparation_plans", "canonical_approved_work_executions"]) {
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE job_id=$1 AND quote_approval_id IS NOT NULL`,[legacy.job_id])).rows[0].count,0);
  }
});
