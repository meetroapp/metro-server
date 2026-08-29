"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  createVisitWorkstream,
  ensureVisitEvaluation,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  completeEvaluation,
} = require("../server/authorization/evaluationService");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  createDerivedDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  sendQuoteInMeetro,
} = require("../server/authorization/quoteDeliveryService");
const {
  createWorkActivity,
  progressWorkActivity,
} = require("../server/workflow/workstreamService");
const {
  activateApprovedWorkVisitAuthority,
} = require("../server/workflow/approvedWorkVisitService");
const {
  confirmVisit,
  proposeVisit,
  startVisit,
} = require("../server/workflow/visitService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.APPROVED_WORK_EXECUTION_DATABASE_URL;
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV }),
  };
}

async function expectPgCode(pool, expectedCodes, action, { deferred = false } = {}) {
  const codes = new Set(Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      async () => {
        await action(client);
        if (deferred) await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      },
      (error) => codes.has(error?.code),
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function insertExecutionCommand(
  db,
  fixture,
  commandName,
  scope,
  key = randomUUID(),
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_approved_work_execution_command_idempotency (
       id, job_id, actor_participant_id, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, fixture.jobId, fixture.professionalParticipantId, commandName, scope,
      key, sha(`${commandName}:${scope}:${key}`)]
  );
  return { id, key };
}

async function loadDecisionSource(pool, decisionId, professionalParticipantId) {
  const result = await pool.query(
    `SELECT decisions.id AS decision_id, decisions.quote_id,
       decisions.issued_quote_version, decisions.job_id,
       decisions.relationship_id, decisions.decision,
       decisions.issued_integrity_hash, decisions.customer_participant_id,
       versions.currency, jobs.job_request_id,
       roles.id AS professional_role_assignment_id,
       snapshots.scope_item_id
     FROM canonical_quote_customer_decisions decisions
     INNER JOIN canonical_quote_versions versions
       ON versions.quote_id = decisions.quote_id
       AND versions.version = decisions.issued_quote_version
       AND versions.job_id = decisions.job_id
     INNER JOIN jobs ON jobs.id = decisions.job_id
     INNER JOIN participant_role_assignments roles
       ON roles.participant_id = $2 AND roles.job_id = decisions.job_id
       AND roles.role = 'PRIMARY_PROFESSIONAL'
       AND roles.valid_until IS NULL
     LEFT JOIN LATERAL (
       SELECT scope_item_id
       FROM canonical_quote_scope_item_snapshots
       WHERE quote_id = decisions.quote_id
         AND quote_version = decisions.issued_quote_version
         AND included_in_total = TRUE
       ORDER BY sequence ASC LIMIT 1
     ) snapshots ON TRUE
     WHERE decisions.id = $1
     ORDER BY roles.created_at ASC LIMIT 1`,
    [decisionId, professionalParticipantId]
  );
  return result.rows[0];
}

async function createSupplementalDecision(pool, identities, fixture, parent, suffix) {
  const created = await createDerivedDraftQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    parentQuoteId: parent.quote_id,
    expectedIssuedVersion: Number(parent.issued_quote_version),
    lineageType: "SUPPLEMENTAL_QUOTE",
    reasonCategory: "SUPPLEMENTAL_WORK",
    idempotencyKey: `execution-supplemental-create-${suffix}`,
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
      description: "Supplemental approved execution scope",
      quantity: 1,
      unitAmountMinor: 2500,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `execution-supplemental-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `execution-supplemental-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  const delivered = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `execution-supplemental-deliver-${suffix}`,
    logger: quiet,
  });
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await approveIssuedQuote({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `execution-supplemental-approve-${suffix}`,
    logger: quiet,
  });
  assert.equal(approved.ok, true, approved.code);
  const decision = await pool.query(
    `SELECT id FROM canonical_quote_customer_decisions WHERE quote_id = $1`,
    [issued.quote.id]
  );
  return loadDecisionSource(
    pool,
    decision.rows[0].id,
    fixture.professionalParticipantId
  );
}

async function createRootDecision(pool, identities, fixture, suffix) {
  const created = await createDraftQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    idempotencyKey: `execution-root-create-${suffix}`,
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
      description: "Approved execution authority test scope",
      quantity: 1,
      unitAmountMinor: 10000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `execution-root-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `execution-root-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  const delivered = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `execution-root-deliver-${suffix}`,
    logger: quiet,
  });
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await approveIssuedQuote({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `execution-root-approve-${suffix}`,
    logger: quiet,
  });
  assert.equal(approved.ok, true, approved.code);
  const decision = await pool.query(
    `SELECT id FROM canonical_quote_customer_decisions WHERE quote_id = $1`,
    [issued.quote.id]
  );
  return loadDecisionSource(
    pool, decision.rows[0].id, fixture.professionalParticipantId
  );
}

async function completeFixtureEvaluation(pool, identities, fixture, suffix) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completed = await completeEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis: "Reviewed the synthetic execution authority fixture by phone.",
    idempotencyKey: `execution-evaluation-complete-${suffix}`,
    logger: quiet,
  });
  assert.equal(completed.ok, true, completed.code);
}

async function insertExecution(db, fixture, source, scope, overrides = {}) {
  const command = await insertExecutionCommand(
    db,
    fixture,
    "approved_work.execution.materialize",
    scope,
  );
  const values = {
    id: randomUUID(),
    jobId: source.job_id,
    requestId: Number(source.job_request_id),
    relationshipId: Number(source.relationship_id),
    quoteId: source.quote_id,
    quoteVersion: Number(source.issued_quote_version),
    decisionId: source.decision_id,
    currency: source.currency,
    integrity: source.issued_integrity_hash,
    customerId: source.customer_participant_id,
    professionalId: fixture.professionalParticipantId,
    roleAssignmentId: source.professional_role_assignment_id,
    commandId: command.id,
    ...overrides,
  };
  await db.query(
    `INSERT INTO canonical_approved_work_executions (
       id, job_id, job_request_id, relationship_id, quote_id,
       issued_quote_version, approved_customer_decision_id,
       commercial_currency, source_integrity_hash, customer_participant_id,
       created_by_professional_participant_id, created_by_role_assignment_id,
       created_command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [values.id, values.jobId, values.requestId, values.relationshipId,
      values.quoteId, values.quoteVersion, values.decisionId, values.currency,
      values.integrity, values.customerId, values.professionalId,
      values.roleAssignmentId, values.commandId]
  );
  return values;
}

async function insertExecutionVersion(db, fixture, execution, version, state, successorId = null) {
  const commandName = state === "ACTIVE"
    ? "approved_work.execution.materialize"
    : state === "SUPERSEDED"
      ? "approved_work.execution.supersede"
      : "approved_work.execution.close";
  const command = await insertExecutionCommand(
    db,
    fixture,
    commandName,
    `execution:${execution.id}:version:${version}:${randomUUID()}`,
  );
  await db.query(
    `INSERT INTO canonical_approved_work_execution_versions (
       execution_id, version, job_id, relationship_id,
       customer_participant_id, state, successor_execution_id,
       recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [execution.id, version, execution.jobId, execution.relationshipId,
      execution.customerId, state, successorId, fixture.professionalParticipantId,
      command.id, sha(`${execution.id}:${version}:${state}:${successorId || ""}`)]
  );
}

async function grantExecutionRuntime(db, fixture, execution) {
  for (const capability of ["approved_work.execution.manage", "approved_work.execute"]) {
    await db.query(
      `INSERT INTO lifecycle_authority_grants (
         id, grantee_participant_id, grantor_participant_id, job_id,
         capability, scope_type, scope_job_id,
         scope_approved_quote_decision_id, scope_approved_quote_decision,
         source_evidence_type, source_evidence_reference, idempotency_key
       ) VALUES ($1,$2,$2,$3,$4,'approved_work',$3,$5,'APPROVED',
         'canonical_approved_work_execution',$6,$7)`,
      [randomUUID(), fixture.professionalParticipantId, fixture.jobId,
        capability, execution.decisionId, execution.id,
        `execution-runtime-grant:${execution.id}:${capability}`]
    );
  }
}

async function bindWorkstream(db, fixture, execution, workstreamId, scope) {
  const command = await insertExecutionCommand(
    db,
    fixture,
    "approved_work.execution.bind_workstream",
    scope,
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_approved_work_execution_workstreams (
       id, execution_id, workstream_id, job_id, relationship_id,
       bound_by_professional_participant_id, bound_by_role_assignment_id,
       command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, execution.id, workstreamId, execution.jobId, execution.relationshipId,
      fixture.professionalParticipantId, execution.roleAssignmentId, command.id]
  );
  return id;
}

async function createActivity(pool, identities, fixture, workstreamId, type, statement) {
  const result = await createWorkActivity({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    workstreamId,
    activityType: type,
    statement,
    customerVisible: false,
    idempotencyKey: `execution-activity-${randomUUID()}`,
    logger: quiet,
  });
  assert.equal(result.ok, true, result.code);
  return result.activity;
}

async function classifyActivity(db, fixture, execution, activity, values = {}) {
  const command = await insertExecutionCommand(
    db,
    fixture,
    values.commandName || "approved_work.execution.classify_activity",
    values.scope || `activity:${activity.id}:classification:${randomUUID()}`,
  );
  const classification = values.classification || "EXECUTION";
  const executionId = values.executionId === undefined
    ? classification === "EXECUTION" ? execution?.id : null
    : values.executionId;
  const scopeBasis = values.scopeBasis === undefined
    ? classification === "EXECUTION" ? "DECISION_WIDE" : null
    : values.scopeBasis;
  await db.query(
    `INSERT INTO canonical_work_activity_execution_classifications (
       activity_id, classified_activity_version, workstream_id, job_id,
       relationship_id, classification, execution_id, scope_basis,
       source_quote_id, source_quote_version, source_scope_item_id,
       source_scope_included_in_total, classified_by_participant_id,
       command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [activity.id, values.activityVersion || activity.currentVersion,
      values.workstreamId || activity.workstreamId, fixture.jobId,
      values.relationshipId || execution?.relationshipId,
      classification, executionId, scopeBasis,
      values.sourceQuoteId ?? null, values.sourceQuoteVersion ?? null,
      values.sourceScopeItemId ?? null, values.sourceScopeIncluded ?? null,
      fixture.professionalParticipantId, command.id]
  );
}

async function insertActivityStart(db, fixture, execution, activity, version, scope) {
  const command = await insertExecutionCommand(
    db,
    fixture,
    "approved_work.execution.start.record",
    scope,
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_approved_work_execution_start_events (
       id, execution_id, job_id, relationship_id,
       approved_customer_decision_id, source_type, source_activity_id,
       source_activity_version, source_workstream_id,
       source_activity_classification, source_activity_status, started_at,
       recorded_by_participant_id, command_idempotency_id, integrity_hash
     ) VALUES ($1,$2,$3,$4,$5,'EXECUTION_ACTIVITY',$6,$7,$8,
       'EXECUTION','IN_PROGRESS',$9,$10,$11,$12)`,
    [id, execution.id, execution.jobId, execution.relationshipId,
      execution.decisionId, activity.id, version, activity.workstreamId,
      new Date("2026-09-01T13:00:00.000Z"), fixture.professionalParticipantId,
      command.id, sha(`${execution.id}:${activity.id}:${version}`)]
  );
  return id;
}

async function insertVisitStart(db, fixture, execution, visit, scope, overrides = {}) {
  const command = await insertExecutionCommand(
    db,
    fixture,
    "approved_work.execution.start.record",
    scope,
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_approved_work_execution_start_events (
       id, execution_id, job_id, relationship_id,
       approved_customer_decision_id, source_type, source_visit_id,
       source_visit_version, source_visit_purpose, source_visit_state,
       started_at, recorded_by_participant_id, command_idempotency_id,
       integrity_hash, source_activity_id
     ) VALUES ($1,$2,$3,$4,$5,'APPROVED_WORK_VISIT',$6,$7,$8,$9,
       $10,$11,$12,$13,$14)`,
    [id, execution.id, execution.jobId, execution.relationshipId,
      execution.decisionId, visit.id, visit.currentVersion,
      overrides.purpose || "APPROVED_WORK", overrides.state || "STARTED",
      new Date("2026-09-01T13:00:00.000Z"), fixture.professionalParticipantId,
      command.id, sha(`${execution.id}:${visit.id}:${visit.currentVersion}`),
      overrides.activityId ?? null]
  );
  return id;
}

async function insertWorkPreparationCommand(db, fixture, name, scope) {
  const id = randomUUID();
  const key = randomUUID();
  await db.query(
    `INSERT INTO canonical_work_preparation_command_idempotency (
       id, job_id, actor_participant_id, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, fixture.jobId, fixture.professionalParticipantId, name, scope, key,
      sha(`${name}:${scope}:${key}`)]
  );
  return id;
}

async function createWorkPreparationPlan(db, fixture, source) {
  const commandId = await insertWorkPreparationCommand(
    db, fixture, "work_preparation.plan.create", `plan:create:${randomUUID()}`
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_work_preparation_plans (
       id, job_id, job_request_id, relationship_id, quote_id,
       issued_quote_version, approved_customer_decision_id,
       customer_participant_id, commercial_currency, source_integrity_hash,
       created_by_professional_participant_id, created_by_role_assignment_id,
       created_command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, fixture.jobId, Number(source.job_request_id), Number(source.relationship_id),
      source.quote_id, Number(source.issued_quote_version), source.decision_id,
      source.customer_participant_id, source.currency, source.issued_integrity_hash,
      fixture.professionalParticipantId, source.professional_role_assignment_id,
      commandId]
  );
  return { id, jobId: fixture.jobId, relationshipId: Number(source.relationship_id) };
}

async function insertWorkPreparationVersion(db, fixture, plan, version, policy) {
  const commandId = await insertWorkPreparationCommand(
    db, fixture, "work_preparation.plan.revise",
    `plan:${plan.id}:version:${version}:${randomUUID()}`
  );
  await db.query(
    `INSERT INTO canonical_work_preparation_plan_versions (
       plan_id, version, job_id, relationship_id, planning_state,
       work_start_policy, recorded_by_participant_id,
       command_idempotency_id, integrity_hash
     ) VALUES ($1,$2,$3,$4,'PLANNED',$5,$6,$7,$8)`,
    [plan.id, version, plan.jobId, plan.relationshipId, policy,
      fixture.professionalParticipantId, commandId,
      sha(`${plan.id}:${version}:${policy}`)]
  );
}

async function createWorkPreparationItem(db, fixture, plan) {
  const commandId = await insertWorkPreparationCommand(
    db, fixture, "work_preparation.plan.revise",
    `plan:${plan.id}:item:${randomUUID()}`
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_work_preparation_items (
       id, plan_id, job_id, relationship_id, created_by_participant_id,
       created_command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, plan.id, plan.jobId, plan.relationshipId,
      fixture.professionalParticipantId, commandId]
  );
  return id;
}

async function insertRequiredSnapshot(db, fixture, plan, source, itemId, version) {
  const commandId = await insertWorkPreparationCommand(
    db, fixture, "work_preparation.plan.revise",
    `plan:${plan.id}:snapshot:${version}:${randomUUID()}`
  );
  await db.query(
    `INSERT INTO canonical_work_preparation_item_snapshots (
       plan_id, plan_version, item_id, job_id, relationship_id, sequence,
       item_kind, description, quantity, unit, provider_responsibility,
       commercial_treatment, required_for_work_start,
       internal_estimated_cost_minor, internal_cost_currency, source_lineage,
       source_quote_id, source_quote_version, source_scope_item_id,
       recorded_by_participant_id, command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,1,'MATERIAL','Required test material',1,'each',
       'BUSINESS','NOT_CUSTOMER_BILLABLE',TRUE,100,'USD',
       'ACCEPTED_SCOPE_ELABORATION',$6,$7,NULL,$8,$9)`,
    [plan.id, version, itemId, plan.jobId, plan.relationshipId,
      source.quote_id, Number(source.issued_quote_version),
      fixture.professionalParticipantId, commandId]
  );
}

test(
  "disposable PostgreSQL certifies Migration 61 execution authority integrity and replay",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 61);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, 61);

      const empty = await pool.query(
        `SELECT
          (SELECT count(*) FROM canonical_approved_work_executions)::integer AS executions,
          (SELECT count(*) FROM canonical_approved_work_execution_versions)::integer AS versions,
          (SELECT count(*) FROM canonical_approved_work_execution_workstreams)::integer AS bindings,
          (SELECT count(*) FROM canonical_work_activity_execution_classifications)::integer AS classifications,
          (SELECT count(*) FROM canonical_approved_work_execution_start_events)::integer AS starts,
          (SELECT count(*) FROM canonical_approved_work_execution_command_idempotency)::integer AS commands,
          (SELECT count(*) FROM lifecycle_authority_grants
             WHERE capability LIKE 'approved_work.execution%')::integer AS grants,
          (SELECT count(*) FROM schema_migrations)::integer AS ledger`
      );
      assert.deepEqual(empty.rows[0], {
        executions: 0, versions: 0, bindings: 0, classifications: 0,
        starts: 0, commands: 0, grants: 0, ledger: 61,
      });
      const capabilities = await pool.query(
        `SELECT capability FROM lifecycle_capabilities
         WHERE capability IN ('approved_work.execution.manage','approved_work.execute')
         ORDER BY capability`
      );
      assert.deepEqual(capabilities.rows.map((row) => row.capability), [
        "approved_work.execute",
        "approved_work.execution.manage",
      ]);

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-primary`);
      await completeFixtureEvaluation(pool, identities, fixture, `${suffix}-primary`);
      const sourceA = await createRootDecision(
        pool, identities, fixture, `${suffix}-primary`
      );
      const sourceB = await createSupplementalDecision(
        pool, identities, fixture, sourceA, suffix
      );

      const crossIdentities = await createVisitTestIdentities(pool, `${suffix}-cross`);
      const crossFixture = await createVisitLifecycleFixture(
        pool, crossIdentities, `${suffix}-cross`
      );
      await completeFixtureEvaluation(
        pool, crossIdentities, crossFixture, `${suffix}-cross`
      );
      const crossSource = await createRootDecision(
        pool, crossIdentities, crossFixture, `${suffix}-cross`
      );

      await expectPgCode(pool, "23503", (db) =>
        insertExecution(db, fixture, sourceA, `execution:cross-link:${suffix}`, {
          jobId: crossFixture.jobId,
          requestId: Number(crossSource.job_request_id),
          relationshipId: Number(crossSource.relationship_id),
        })
      );

      const executionA = await insertExecution(
        pool, fixture, sourceA, `execution:A:${suffix}`
      );
      const executionB = await insertExecution(
        pool, fixture, sourceB, `execution:B:${suffix}`
      );
      const executionCross = await insertExecution(
        pool, crossFixture, crossSource, `execution:cross:${suffix}`
      );
      await insertExecutionVersion(pool, fixture, executionA, 1, "ACTIVE");
      await insertExecutionVersion(pool, fixture, executionB, 1, "ACTIVE");
      await insertExecutionVersion(pool, crossFixture, executionCross, 1, "ACTIVE");
      await grantExecutionRuntime(pool, fixture, executionA);

      await expectPgCode(pool, "23505", (db) =>
        insertExecution(db, fixture, sourceA, `execution:A:duplicate:${suffix}`)
      );
      await expectPgCode(pool, "23514", (db) =>
        insertExecutionVersion(db, fixture, executionA, 3, "CLOSED")
      );
      await expectPgCode(pool, ["23514", "23503"], (db) =>
        insertExecutionVersion(db, fixture, executionA, 2, "SUPERSEDED", executionA.id)
      );
      await expectPgCode(pool, "23503", (db) =>
        insertExecutionVersion(
          db, fixture, executionA, 2, "SUPERSEDED", executionCross.id
        )
      );

      const workstreamA1 = await createVisitWorkstream(
        pool, identities, fixture, `${suffix}-a`, 1
      );
      const workstreamA2 = await createVisitWorkstream(
        pool, identities, fixture, `${suffix}-a`, 2
      );
      const workstreamB = await createVisitWorkstream(
        pool, identities, fixture, `${suffix}-b`, 3
      );
      const unboundWorkstream = await createVisitWorkstream(
        pool, identities, fixture, `${suffix}-unbound`, 4
      );
      const crossWorkstream = await createVisitWorkstream(
        pool, crossIdentities, crossFixture, `${suffix}-cross`, 1
      );
      await bindWorkstream(pool, fixture, executionA, workstreamA1.id, `bind:a1:${suffix}`);
      await bindWorkstream(pool, fixture, executionA, workstreamA2.id, `bind:a2:${suffix}`);
      await bindWorkstream(pool, fixture, executionB, workstreamB.id, `bind:b:${suffix}`);
      assert.equal(
        Number((await pool.query(
          `SELECT count(*) FROM canonical_approved_work_execution_workstreams
           WHERE execution_id = $1`, [executionA.id]
        )).rows[0].count),
        2
      );
      await expectPgCode(pool, "23505", (db) =>
        bindWorkstream(db, fixture, executionB, workstreamA1.id, `bind:duplicate:${suffix}`)
      );
      await expectPgCode(pool, "23503", (db) =>
        bindWorkstream(db, fixture, executionA, crossWorkstream.id, `bind:cross:${suffix}`)
      );

      const activityDecisionWide = await createActivity(
        pool, identities, fixture, workstreamA1.id,
        "REPAIR", "Execute accepted cabinet repair"
      );
      const activityScope = await createActivity(
        pool, identities, fixture, workstreamA2.id,
        "INSTALLATION", "Execute exact accepted scope item"
      );
      const activityNonExecution = await createActivity(
        pool, identities, fixture, workstreamA2.id,
        "INSPECTION", "Administrative inspection record"
      );
      const activityUnbound = await createActivity(
        pool, identities, fixture, unboundWorkstream.id,
        "PLANNING", "Legacy-compatible unbound planning activity"
      );
      const activityWrongExecution = await createActivity(
        pool, identities, fixture, workstreamA1.id,
        "REPAIR", "Reject classification against another approved execution"
      );
      assert.equal(
        Number((await pool.query(
          `SELECT count(*) FROM canonical_work_activity_execution_classifications
           WHERE activity_id = $1`, [activityUnbound.id]
        )).rows[0].count),
        0
      );

      await classifyActivity(pool, fixture, executionA, activityDecisionWide);
      await classifyActivity(pool, fixture, executionA, activityScope, {
        scopeBasis: "QUOTE_SCOPE_ITEM",
        sourceQuoteId: sourceA.quote_id,
        sourceQuoteVersion: Number(sourceA.issued_quote_version),
        sourceScopeItemId: sourceA.scope_item_id,
        sourceScopeIncluded: true,
      });
      await classifyActivity(pool, fixture, null, activityNonExecution, {
        classification: "NON_EXECUTION",
        relationshipId: executionA.relationshipId,
      });

      await expectPgCode(pool, "23505", (db) =>
        classifyActivity(db, fixture, executionA, activityDecisionWide)
      );
      await expectPgCode(pool, "23503", (db) =>
        classifyActivity(db, fixture, executionA, activityUnbound)
      );
      await expectPgCode(pool, "23503", (db) =>
        classifyActivity(db, fixture, executionB, activityWrongExecution, {
          executionId: executionB.id,
        })
      );
      await expectPgCode(pool, "23514", (db) =>
        classifyActivity(db, fixture, executionA, activityUnbound, {
          classification: "NON_EXECUTION",
          executionId: executionA.id,
          scopeBasis: null,
        })
      );
      await expectPgCode(pool, "23514", (db) =>
        classifyActivity(db, fixture, executionA, activityUnbound, {
          classification: "NON_EXECUTION",
          executionId: null,
          scopeBasis: "QUOTE_SCOPE_ITEM",
          sourceQuoteId: sourceA.quote_id,
          sourceQuoteVersion: Number(sourceA.issued_quote_version),
          sourceScopeItemId: sourceA.scope_item_id,
          sourceScopeIncluded: true,
        })
      );
      const crossVersion = Number(sourceA.issued_quote_version) + 1;
      await expectPgCode(pool, ["23503", "23514"], (db) =>
        classifyActivity(db, fixture, executionA, activityUnbound, {
          workstreamId: workstreamA1.id,
          scopeBasis: "QUOTE_SCOPE_ITEM",
          sourceQuoteId: sourceA.quote_id,
          sourceQuoteVersion: crossVersion,
          sourceScopeItemId: sourceA.scope_item_id,
          sourceScopeIncluded: true,
        })
      );

      const progressed = await progressWorkActivity({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        workstreamId: workstreamA1.id,
        activityId: activityDecisionWide.id,
        expectedVersion: activityDecisionWide.currentVersion,
        targetStatus: "IN_PROGRESS",
        approvedWorkExecutionId: executionA.id,
        expectedExecutionVersion: 1,
        idempotencyKey: `execution-activity-start-${suffix}`,
        logger: quiet,
      });
      assert.equal(progressed.ok, true, progressed.code);
      assert.equal(progressed.approvedWorkStart.ready, true);
      await expectPgCode(pool, "23505", (db) =>
        insertActivityStart(
          db, fixture, executionA, progressed.activity,
          progressed.activity.currentVersion, `start:activity:duplicate:${suffix}`
        )
      );
      await expectPgCode(pool, ["23503", "23514"], (db) =>
        insertActivityStart(
          db, fixture, executionA, activityNonExecution,
          activityNonExecution.currentVersion, `start:non-execution:${suffix}`
        )
      );

      const activated = await activateApprovedWorkVisitAuthority({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        quoteId: sourceA.quote_id,
        idempotencyKey: `execution-visit-activate-${suffix}`,
        logger: quiet,
      });
      assert.equal(activated.ok, true, activated.code);
      const proposed = await proposeVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        purpose: "APPROVED_WORK",
        approvedQuoteDecisionId: sourceA.decision_id,
        workstreamIds: [workstreamA1.id],
        scheduledStartAt: "2026-09-01T13:00:00.000Z",
        scheduledEndAt: "2026-09-01T14:00:00.000Z",
        timeZone: "America/New_York",
        locationMode: "JOB_SERVICE_LOCATION",
        idempotencyKey: `execution-visit-propose-${suffix}`,
        clock: () => new Date("2026-08-30T12:00:00.000Z"),
        logger: quiet,
      });
      assert.equal(proposed.ok, true, proposed.code);
      const confirmed = await confirmVisit({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
        visitId: proposed.visit.id,
        expectedVersion: proposed.visit.currentVersion,
        idempotencyKey: `execution-visit-confirm-${suffix}`,
        clock: () => new Date("2026-08-30T12:05:00.000Z"),
        logger: quiet,
      });
      assert.equal(confirmed.ok, true, confirmed.code);
      const started = await startVisit({
        pool,
        authenticatedActor: { id: identities.professionalId },
        jobId: fixture.jobId,
        visitId: confirmed.visit.id,
        expectedVersion: confirmed.visit.currentVersion,
        acknowledgeScheduleVariance: false,
        approvedWorkExecutionId: executionA.id,
        expectedExecutionVersion: 1,
        idempotencyKey: `execution-visit-start-${suffix}`,
        clock: () => new Date("2026-09-01T13:00:00.000Z"),
        logger: quiet,
      });
      assert.equal(started.ok, true, started.code);
      assert.equal(started.approvedWorkStart.ready, true);
      assert.equal(
        Number((await pool.query(
          `SELECT count(*) FROM canonical_approved_work_execution_start_events
           WHERE execution_id = $1`, [executionA.id]
        )).rows[0].count),
        2
      );
      await expectPgCode(pool, "23505", (db) =>
        insertVisitStart(
          db, fixture, executionA, started.visit, `start:visit:duplicate:${suffix}`
        )
      );
      await expectPgCode(pool, "23514", (db) =>
        insertVisitStart(
          db, fixture, executionA, started.visit, `start:mixed:${suffix}`,
          { activityId: activityDecisionWide.id }
        )
      );

      const evaluationCommand = async (name, scope) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO canonical_visit_command_idempotency (
             id, actor_participant_id, job_id, command_name, command_scope,
             idempotency_key, request_fingerprint
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, fixture.professionalParticipantId, fixture.jobId, name, scope,
            randomUUID(), sha(`${name}:${scope}`)]
        );
        return id;
      };
      const evaluationVisitId = randomUUID();
      const evaluationCreateCommand = await evaluationCommand(
        "visit.propose", `evaluation-visit:${suffix}:create`
      );
      await pool.query(
        `INSERT INTO canonical_visits (
           id, job_id, purpose, created_by_participant_id,
           created_command_idempotency_id
         ) VALUES ($1,$2,'EVALUATION',$3,$4)`,
        [evaluationVisitId, fixture.jobId, fixture.professionalParticipantId,
          evaluationCreateCommand]
      );
      const evaluationStartCommand = await evaluationCommand(
        "visit.start", `evaluation-visit:${suffix}:start`
      );
      await pool.query(
        `INSERT INTO canonical_visit_versions (
           visit_id, version, job_id, state, scheduled_start_at,
           scheduled_end_at, time_zone, location_mode, started_at,
           recorded_by_participant_id, command_idempotency_id, integrity_hash
         ) VALUES ($1,1,$2,'STARTED','2026-09-01T13:00:00Z',
           '2026-09-01T14:00:00Z','America/New_York','JOB_SERVICE_LOCATION',
           '2026-09-01T13:00:00Z',$3,$4,$5)`,
        [evaluationVisitId, fixture.jobId, fixture.professionalParticipantId,
          evaluationStartCommand, sha(`evaluation:${evaluationVisitId}`)]
      );
      const evaluationVisit = { id: evaluationVisitId, currentVersion: 1 };
      await expectPgCode(pool, "23503", (db) =>
        insertVisitStart(
          db, fixture, executionA, evaluationVisit,
          `start:evaluation-rejected:${suffix}`
        )
      );

      await expectPgCode(pool, ["55000", "P0001", "23514"], (db) =>
        db.query(
          `UPDATE canonical_work_activity_execution_classifications
           SET classification = 'NON_EXECUTION' WHERE activity_id = $1`,
          [activityDecisionWide.id]
        )
      );
      await expectPgCode(pool, ["55000", "P0001", "23514"], (db) =>
        db.query(
          `DELETE FROM canonical_approved_work_execution_start_events
           WHERE execution_id = $1`,
          [executionA.id]
        )
      );

      const duplicateKey = randomUUID();
      await insertExecutionCommand(
        pool, fixture, "approved_work.execution.close",
        `execution:${executionA.id}:duplicate-command`, duplicateKey
      );
      await expectPgCode(pool, "23505", (db) =>
        insertExecutionCommand(
          db, fixture, "approved_work.execution.close",
          `execution:${executionA.id}:duplicate-command`, duplicateKey
        )
      );

      await insertExecutionVersion(
        pool, fixture, executionA, 2, "SUPERSEDED", executionB.id
      );
      await expectPgCode(pool, "23514", (db) =>
        insertExecutionVersion(
          db, fixture, executionB, 2, "SUPERSEDED", executionA.id
        )
      );
      await insertExecutionVersion(pool, fixture, executionB, 2, "CLOSED");
      await insertExecutionVersion(pool, crossFixture, executionCross, 2, "CLOSED");

      const plan = await createWorkPreparationPlan(pool, fixture, sourceA);
      await insertWorkPreparationVersion(pool, fixture, plan, 1, "NONE");
      const itemId = await createWorkPreparationItem(pool, fixture, plan);
      await expectPgCode(
        pool,
        "23514",
        (db) => insertRequiredSnapshot(db, fixture, plan, sourceA, itemId, 1),
        { deferred: true },
      );
      await insertWorkPreparationVersion(
        pool, fixture, plan, 2, "REQUIRED_ITEMS_READY"
      );
      await insertWorkPreparationVersion(
        pool, fixture, plan, 3, "REQUIRED_ITEMS_READY"
      );
      await insertRequiredSnapshot(pool, fixture, plan, sourceA, itemId, 3);
      await pool.query("SET CONSTRAINTS ALL IMMEDIATE");
      const policies = await pool.query(
        `SELECT version, work_start_policy,
          (SELECT count(*) FROM canonical_work_preparation_item_snapshots snapshots
           WHERE snapshots.plan_id = versions.plan_id
             AND snapshots.plan_version = versions.version
             AND snapshots.required_for_work_start = TRUE)::integer AS required_count
         FROM canonical_work_preparation_plan_versions versions
         WHERE versions.plan_id = $1 ORDER BY version`,
        [plan.id]
      );
      assert.deepEqual(policies.rows, [
        { version: 1, work_start_policy: "NONE", required_count: 0 },
        { version: 2, work_start_policy: "REQUIRED_ITEMS_READY", required_count: 0 },
        { version: 3, work_start_policy: "REQUIRED_ITEMS_READY", required_count: 1 },
      ]);

      const baseColumns = await pool.query(
        `SELECT
          EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'canonical_work_activities'
              AND column_name LIKE '%execution%') AS activity_changed,
          EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'canonical_workstreams'
              AND column_name LIKE '%execution%') AS workstream_changed,
          EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'canonical_pre_work_deposit_versions'
              AND column_name LIKE '%execution%') AS deposit_changed`
      );
      assert.deepEqual(baseColumns.rows[0], {
        activity_changed: false,
        workstream_changed: false,
        deposit_changed: false,
      });

      const replay = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replay.success, true, JSON.stringify(replay));
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.skipped.length, 61);
    } finally {
      await pool.end();
    }
  }
);
