"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  ensureVisitEvaluation,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const { sendQuoteInMeetro } = require("../server/authorization/quoteDeliveryService");
const { completeEvaluation } = require("../server/authorization/evaluationService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.WORK_PREPARATION_DATABASE_URL;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV }),
  };
}

async function expectPgCode(pool, code, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(action(client), (error) => error?.code === code);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function insertCommand(db, jobId, actorId, commandName, scope, key = randomUUID()) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_work_preparation_command_idempotency (
       id, job_id, actor_participant_id, command_name, command_scope,
       idempotency_key, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, jobId, actorId, commandName, scope, key, hash(`${commandName}:${scope}:${key}`)]
  );
  return { id, key };
}

async function createAcceptedQuote(pool, identities, fixture, suffix) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completed = await completeEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis: "Reviewed the synthetic Work Preparation fixture by phone.",
    idempotencyKey: `work-preparation-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(completed.ok, true, completed.code);
  const created = await createDraftQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    idempotencyKey: `work-preparation-quote-${suffix}`,
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
      description: "Synthetic accepted work with total-only-safe preparation",
      quantity: 1,
      unitAmountMinor: 10000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `work-preparation-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `work-preparation-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  const delivered = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `work-preparation-deliver-${suffix}`,
    logger: quiet,
  });
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await approveIssuedQuote({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `work-preparation-approve-${suffix}`,
    logger: quiet,
  });
  assert.equal(approved.ok, true, approved.code);
  const result = await pool.query(
    `SELECT decisions.id AS decision_id, decisions.quote_id,
       decisions.issued_quote_version, decisions.job_id,
       decisions.relationship_id, decisions.decision,
       decisions.issued_integrity_hash, decisions.customer_participant_id,
       versions.currency, jobs.job_request_id,
       (SELECT id FROM participant_role_assignments
        WHERE participant_id = $2 AND job_id = decisions.job_id
          AND role = 'PRIMARY_PROFESSIONAL' AND valid_until IS NULL
        ORDER BY created_at ASC LIMIT 1) AS professional_role_assignment_id,
       (SELECT scope_item_id FROM canonical_quote_scope_item_snapshots
        WHERE quote_id = decisions.quote_id
          AND quote_version = decisions.issued_quote_version
        ORDER BY sequence ASC LIMIT 1) AS scope_item_id
     FROM canonical_quote_customer_decisions decisions
     INNER JOIN canonical_quote_versions versions
       ON versions.quote_id = decisions.quote_id
       AND versions.version = decisions.issued_quote_version
       AND versions.job_id = decisions.job_id
     INNER JOIN jobs ON jobs.id = decisions.job_id
     WHERE decisions.quote_id = $1`,
    [issued.quote.id, fixture.professionalParticipantId]
  );
  return result.rows[0];
}

async function insertPlan(db, source, professionalId, commandId, overrides = {}) {
  const values = {
    id: randomUUID(),
    jobId: source.job_id,
    requestId: Number(source.job_request_id),
    relationshipId: Number(source.relationship_id),
    quoteId: source.quote_id,
    quoteVersion: Number(source.issued_quote_version),
    decisionId: source.decision_id,
    customerId: source.customer_participant_id,
    currency: source.currency,
    integrityHash: source.issued_integrity_hash,
    professionalId,
    roleAssignmentId: source.professional_role_assignment_id,
    commandId,
    ...overrides,
  };
  await db.query(
    `INSERT INTO canonical_work_preparation_plans (
       id, job_id, job_request_id, relationship_id, quote_id,
       issued_quote_version, approved_customer_decision_id,
       customer_participant_id, commercial_currency, source_integrity_hash,
       created_by_professional_participant_id, created_by_role_assignment_id,
       created_command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [values.id, values.jobId, values.requestId, values.relationshipId,
      values.quoteId, values.quoteVersion, values.decisionId, values.customerId,
      values.currency, values.integrityHash, values.professionalId,
      values.roleAssignmentId, values.commandId]
  );
  return values;
}

async function insertPlanVersion(db, plan, actorId, commandId, version, state = "PLANNING") {
  await db.query(
    `INSERT INTO canonical_work_preparation_plan_versions (
       plan_id, version, job_id, relationship_id, planning_state,
       work_start_policy, recorded_by_participant_id,
       command_idempotency_id, integrity_hash
     ) VALUES ($1,$2,$3,$4,$5,'REQUIRED_ITEMS_READY',$6,$7,$8)`,
    [plan.id, version, plan.jobId, plan.relationshipId, state, actorId,
      commandId, hash(`${plan.id}:${version}`)]
  );
}

async function insertItem(db, plan, actorId, source, options = {}) {
  const command = await insertCommand(
    db, plan.jobId, actorId, "work_preparation.plan.revise",
    `plan:${plan.id}:item:${randomUUID()}`
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO canonical_work_preparation_items (
       id, plan_id, job_id, relationship_id, created_by_participant_id,
       created_command_idempotency_id
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, plan.id, plan.jobId, plan.relationshipId, actorId, command.id]
  );
  const values = {
    sequence: options.sequence ?? 1,
    kind: options.kind ?? "MATERIAL",
    description: options.description ?? "Operational material preparation",
    quantity: options.quantity ?? 2,
    unit: options.unit ?? "each",
    provider: options.provider ?? "BUSINESS",
    commercial: options.commercial ?? "NOT_CUSTOMER_BILLABLE",
    visibility: options.visibility,
    required: options.required ?? true,
    estimate: options.estimate ?? 2500,
    estimateCurrency: options.estimateCurrency ?? "USD",
    lineage: options.lineage ?? "ACCEPTED_SCOPE_ELABORATION",
    sourceQuoteId: options.sourceQuoteId ?? source.quote_id,
    sourceQuoteVersion: options.sourceQuoteVersion ?? Number(source.issued_quote_version),
    sourceScopeId: options.sourceScopeId ?? null,
  };
  if (values.provider === "CUSTOMER") {
    values.commercial = options.commercial ?? "CUSTOMER_SUPPLIED";
    values.estimate = options.estimate ?? null;
    values.estimateCurrency = options.estimateCurrency ?? null;
  }
  await db.query(
    `INSERT INTO canonical_work_preparation_item_snapshots (
       plan_id, plan_version, item_id, job_id, relationship_id, sequence,
       item_kind, description, quantity, unit, provider_responsibility,
       commercial_treatment, visibility, required_for_work_start,
       internal_estimated_cost_minor, internal_cost_currency, source_lineage,
       source_quote_id, source_quote_version, source_scope_item_id,
       recorded_by_participant_id, command_idempotency_id
     ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,'BUSINESS_ONLY'),
       $13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [plan.id, id, plan.jobId, plan.relationshipId, values.sequence, values.kind,
      values.description, values.quantity, values.unit, values.provider,
      values.commercial, values.visibility ?? null, values.required, values.estimate,
      values.estimateCurrency, values.lineage, values.sourceQuoteId,
      values.sourceQuoteVersion, values.sourceScopeId, actorId, command.id]
  );
  return { id, ...values };
}

test(
  "disposable PostgreSQL certifies Migration 60 Work Preparation integrity and replay",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300001_create_professional_subscription_foundation.sql");
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, migrations.length);

      const empty = await pool.query(
        `SELECT
          (SELECT count(*) FROM canonical_work_preparation_plans)::integer AS plans,
          (SELECT count(*) FROM canonical_work_preparation_plan_versions)::integer AS versions,
          (SELECT count(*) FROM canonical_work_preparation_items)::integer AS items,
          (SELECT count(*) FROM canonical_work_preparation_item_snapshots)::integer AS snapshots,
          (SELECT count(*) FROM canonical_material_purchase_records)::integer AS purchases,
          (SELECT count(*) FROM canonical_material_purchase_corrections)::integer AS corrections,
          (SELECT count(*) FROM canonical_work_preparation_events)::integer AS events,
          (SELECT count(*) FROM canonical_work_preparation_evidence_references)::integer AS evidence,
          (SELECT count(*) FROM canonical_work_preparation_command_idempotency)::integer AS commands,
          (SELECT count(*) FROM canonical_pre_work_deposit_obligations)::integer AS obligations,
          (SELECT count(*) FROM schema_migrations)::integer AS ledger`
      );
      assert.deepEqual(empty.rows[0], {
        plans: 0, versions: 0, items: 0, snapshots: 0, purchases: 0,
        corrections: 0, events: 0, evidence: 0, commands: 0,
        obligations: 0, ledger: migrations.length,
      });

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-a`);
      const crossFixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-b`);
      const source = await createAcceptedQuote(pool, identities, fixture, `${suffix}-a`);
      const crossSource = await createAcceptedQuote(pool, identities, crossFixture, `${suffix}-b`);

      const createCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.plan.create", `job:${fixture.jobId}`);
      const plan = await insertPlan(pool, source, fixture.professionalParticipantId, createCommand.id);

      const duplicateCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.plan.create", `job:${fixture.jobId}:duplicate`);
      await expectPgCode(pool, "23505", (client) =>
        insertPlan(client, source, fixture.professionalParticipantId, duplicateCommand.id)
      );

      const crossCommand = await insertCommand(pool, crossFixture.jobId,
        crossFixture.professionalParticipantId, "work_preparation.plan.create", `job:${crossFixture.jobId}:cross`);
      await expectPgCode(pool, "23503", (client) =>
        insertPlan(client, crossSource, crossFixture.professionalParticipantId, crossCommand.id, {
          jobId: crossFixture.jobId,
          requestId: Number(crossSource.job_request_id),
          relationshipId: Number(source.relationship_id),
          roleAssignmentId: crossSource.professional_role_assignment_id,
        })
      );

      const versionOneCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.plan.revise", `plan:${plan.id}:v1`);
      await insertPlanVersion(pool, plan, fixture.professionalParticipantId, versionOneCommand.id, 1);
      const versionThreeCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.plan.revise", `plan:${plan.id}:v3`);
      await expectPgCode(pool, "23514", (client) =>
        insertPlanVersion(client, plan, fixture.professionalParticipantId, versionThreeCommand.id, 3)
      );

      const businessItem = await insertItem(pool, plan, fixture.professionalParticipantId, source);
      const customerItem = await insertItem(pool, plan, fixture.professionalParticipantId, source, {
        sequence: 2, provider: "CUSTOMER", description: "Customer-provided cabinet hardware",
      });
      assert.ok(customerItem.id);

      for (const invalid of [
        { provider: "UNKNOWN", sequence: 3 },
        { commercial: "AMBIGUOUS", sequence: 3 },
        { kind: "SUPPLY", sequence: 3 },
        { visibility: "PUBLIC", sequence: 3 },
      ]) {
        await expectPgCode(pool, "23514", (client) =>
          insertItem(client, plan, fixture.professionalParticipantId, source, invalid)
        );
      }

      await expectPgCode(pool, "23503", (client) =>
        insertItem(client, plan, fixture.professionalParticipantId, source, {
          sequence: 3,
          lineage: "QUOTE_SCOPE_ITEM",
          sourceQuoteId: crossSource.quote_id,
          sourceQuoteVersion: Number(crossSource.issued_quote_version),
          sourceScopeId: crossSource.scope_item_id,
          commercial: "INCLUDED_IN_ACCEPTED_TOTAL",
        })
      );

      const purchaseCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.purchase.record", `item:${businessItem.id}:purchase`);
      const purchaseId = randomUUID();
      await pool.query(
        `INSERT INTO canonical_material_purchase_records (
          id, job_id, relationship_id, plan_id, basis_plan_version, item_id,
          quantity, unit, internal_cost_minor, internal_cost_currency, vendor,
          purchased_at, deposit_gate_type, recorded_by_participant_id,
          command_idempotency_id
        ) VALUES ($1,$2,$3,$4,1,$5,2,'each',2000,'USD','Fixture Vendor',
          '2026-08-28T14:00:00Z','NO_DEPOSIT_REQUIRED',$6,$7)`,
        [purchaseId, plan.jobId, plan.relationshipId, plan.id, businessItem.id,
          fixture.professionalParticipantId, purchaseCommand.id]
      );
      const privacy = await pool.query(
        `SELECT visibility, internal_cost_minor, internal_cost_currency
         FROM canonical_material_purchase_records WHERE id = $1`, [purchaseId]
      );
      assert.deepEqual(privacy.rows[0], {
        visibility: "BUSINESS_ONLY", internal_cost_minor: "2000", internal_cost_currency: "USD",
      });

      const customerPurchaseCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.purchase.record", `item:${customerItem.id}:invalid-purchase`);
      await expectPgCode(pool, "23514", (client) => client.query(
        `INSERT INTO canonical_material_purchase_records (
          id, job_id, relationship_id, plan_id, basis_plan_version, item_id,
          quantity, unit, purchased_at, deposit_gate_type,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,$3,$4,1,$5,1,'each',CURRENT_TIMESTAMP,
          'NO_DEPOSIT_REQUIRED',$6,$7)`,
        [randomUUID(), plan.jobId, plan.relationshipId, plan.id, customerItem.id,
          fixture.professionalParticipantId, customerPurchaseCommand.id]
      ));

      const crossPurchaseCommand = await insertCommand(pool, crossFixture.jobId,
        crossFixture.professionalParticipantId, "work_preparation.purchase.record",
        `item:${businessItem.id}:cross-job`);
      await expectPgCode(pool, "23514", (client) => client.query(
        `INSERT INTO canonical_material_purchase_records (
          id, job_id, relationship_id, plan_id, basis_plan_version, item_id,
          quantity, unit, purchased_at, deposit_gate_type,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,$3,$4,1,$5,1,'each',CURRENT_TIMESTAMP,
          'NO_DEPOSIT_REQUIRED',$6,$7)`,
        [randomUUID(), crossFixture.jobId, Number(crossSource.relationship_id),
          plan.id, businessItem.id, crossFixture.professionalParticipantId,
          crossPurchaseCommand.id]
      ));

      const depositCommandId = randomUUID();
      const depositCommandKey = randomUUID();
      await pool.query(
        `INSERT INTO canonical_pre_work_payment_command_idempotency (
          id, job_id, actor_type, actor_participant_id, command_name,
          command_scope, idempotency_key, request_fingerprint
        ) VALUES ($1,$2,'PARTICIPANT',$3,'deposit.materialize',$4,$5,$6)`,
        [depositCommandId, plan.jobId, source.customer_participant_id,
          `decision:${source.decision_id}`, depositCommandKey,
          hash(`deposit:${source.decision_id}:${depositCommandKey}`)]
      );
      const obligationId = randomUUID();
      await pool.query(
        `INSERT INTO canonical_pre_work_deposit_obligations (
          id, job_id, job_request_id, relationship_id, quote_id,
          issued_quote_version, customer_decision_id, customer_participant_id,
          currency, quote_total_minor, deposit_rule_type,
          deposit_percent_basis_points, required_minor, source_integrity_hash,
          effective_at, created_by_participant_id, created_command_idempotency_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,10000,'PERCENT',5000,5000,$10,
          CURRENT_TIMESTAMP,$8,$11)`,
        [obligationId, plan.jobId, plan.requestId, plan.relationshipId,
          source.quote_id, Number(source.issued_quote_version), source.decision_id,
          source.customer_participant_id, source.currency,
          source.issued_integrity_hash, depositCommandId]
      );
      await pool.query(
        `INSERT INTO canonical_pre_work_deposit_versions (
          obligation_id, version, job_id, relationship_id, currency, state,
          required_minor, applied_minor, remaining_minor,
          recorded_by_participant_id, command_idempotency_id, integrity_hash
        ) VALUES ($1,1,$2,$3,$4,'SATISFIED',5000,5000,0,$5,$6,$7)`,
        [obligationId, plan.jobId, plan.relationshipId, source.currency,
          source.customer_participant_id, depositCommandId,
          hash(`satisfied:${obligationId}`)]
      );
      const satisfiedPurchaseCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.purchase.record",
        `item:${businessItem.id}:satisfied-purchase`);
      const satisfiedPurchaseId = randomUUID();
      await pool.query(
        `INSERT INTO canonical_material_purchase_records (
          id, job_id, relationship_id, plan_id, basis_plan_version, item_id,
          quantity, unit, purchased_at, deposit_gate_type,
          deposit_obligation_id, deposit_obligation_version,
          deposit_obligation_state, deposit_currency,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,$3,$4,1,$5,1,'each',CURRENT_TIMESTAMP,'SATISFIED',
          $6,1,'SATISFIED',$7,$8,$9)`,
        [satisfiedPurchaseId, plan.jobId, plan.relationshipId, plan.id,
          businessItem.id, obligationId, source.currency,
          fixture.professionalParticipantId, satisfiedPurchaseCommand.id]
      );
      const satisfiedGate = await pool.query(
        `SELECT deposit_gate_type, deposit_obligation_id,
          deposit_obligation_version, deposit_obligation_state
         FROM canonical_material_purchase_records WHERE id = $1`,
        [satisfiedPurchaseId]
      );
      assert.deepEqual(satisfiedGate.rows[0], {
        deposit_gate_type: "SATISFIED",
        deposit_obligation_id: obligationId,
        deposit_obligation_version: 1,
        deposit_obligation_state: "SATISFIED",
      });
      const readinessRequirement = await pool.query(
        `SELECT required_for_work_start FROM canonical_work_preparation_item_snapshots
         WHERE plan_id = $1 AND plan_version = 1 AND item_id = $2`,
        [plan.id, businessItem.id]
      );
      assert.equal(readinessRequirement.rows[0].required_for_work_start, true);

      const badCostCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.purchase.record", `item:${businessItem.id}:bad-cost`);
      await expectPgCode(pool, "23514", (client) => client.query(
        `INSERT INTO canonical_material_purchase_records (
          id, job_id, relationship_id, plan_id, basis_plan_version, item_id,
          quantity, unit, internal_cost_minor, purchased_at, deposit_gate_type,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,$3,$4,1,$5,1,'each',100,CURRENT_TIMESTAMP,
          'NO_DEPOSIT_REQUIRED',$6,$7)`,
        [randomUUID(), plan.jobId, plan.relationshipId, plan.id, businessItem.id,
          fixture.professionalParticipantId, badCostCommand.id]
      ));

      const badGateCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.purchase.record", `item:${businessItem.id}:bad-gate`);
      await expectPgCode(pool, "23514", (client) => client.query(
        `INSERT INTO canonical_material_purchase_records (
          id, job_id, relationship_id, plan_id, basis_plan_version, item_id,
          quantity, unit, purchased_at, deposit_gate_type,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,$3,$4,1,$5,1,'each',CURRENT_TIMESTAMP,'DUE',$6,$7)`,
        [randomUUID(), plan.jobId, plan.relationshipId, plan.id, businessItem.id,
          fixture.professionalParticipantId, badGateCommand.id]
      ));

      const correctionCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.purchase.correct", `purchase:${purchaseId}:correction`);
      const correctionId = randomUUID();
      await pool.query(
        `INSERT INTO canonical_material_purchase_corrections (
          id, purchase_id, job_id, relationship_id, plan_id, basis_plan_version,
          item_id, reversed_quantity, reversed_internal_cost_minor,
          reason_category, reason, corrected_at, recorded_by_participant_id,
          command_idempotency_id
        ) VALUES ($1,$2,$3,$4,$5,1,$6,0.5,500,'RETURN',
          'One fixture unit returned','2026-08-28T15:00:00Z',$7,$8)`,
        [correctionId, purchaseId, plan.jobId, plan.relationshipId, plan.id,
          businessItem.id, fixture.professionalParticipantId, correctionCommand.id]
      );
      const overCorrectionCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.purchase.correct", `purchase:${purchaseId}:over`);
      await expectPgCode(pool, "23514", (client) => client.query(
        `INSERT INTO canonical_material_purchase_corrections (
          id, purchase_id, job_id, relationship_id, plan_id, basis_plan_version,
          item_id, reversed_quantity, reversed_internal_cost_minor,
          reason_category, reason, corrected_at, recorded_by_participant_id,
          command_idempotency_id
        ) VALUES ($1,$2,$3,$4,$5,1,$6,2,0,'RETURN','Too much',CURRENT_TIMESTAMP,$7,$8)`,
        [randomUUID(), purchaseId, plan.jobId, plan.relationshipId, plan.id,
          businessItem.id, fixture.professionalParticipantId, overCorrectionCommand.id]
      ));

      const eventOneCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.preparation.record", `plan:${plan.id}:event:1`);
      const eventOneId = randomUUID();
      await pool.query(
        `INSERT INTO canonical_work_preparation_events (
          id, plan_id, plan_version, item_id, job_id, relationship_id,
          event_sequence, event_type, readiness_dimension,
          resulting_readiness_state, purchase_id, deposit_gate_type,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,1,$3,$4,$5,1,'PURCHASE_RECORDED','ACQUISITION',
          'PURCHASED',$6,'NO_DEPOSIT_REQUIRED',$7,$8)`,
        [eventOneId, plan.id, businessItem.id, plan.jobId, plan.relationshipId,
          purchaseId, fixture.professionalParticipantId, eventOneCommand.id]
      );
      const eventTwoCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.customer_item.receive", `plan:${plan.id}:event:2`);
      const eventTwoId = randomUUID();
      await pool.query(
        `INSERT INTO canonical_work_preparation_events (
          id, plan_id, plan_version, item_id, job_id, relationship_id,
          event_sequence, previous_event_id, event_type, readiness_dimension,
          resulting_readiness_state, visibility, deposit_gate_type,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,1,$3,$4,$5,2,$6,'CUSTOMER_ITEM_RECEIVED','ACQUISITION',
          'READY','CUSTOMER_VISIBLE','NO_DEPOSIT_REQUIRED',$7,$8)`,
        [eventTwoId, plan.id, customerItem.id, plan.jobId, plan.relationshipId,
          eventOneId, fixture.professionalParticipantId, eventTwoCommand.id]
      );
      const sequenceCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.preparation.record", `plan:${plan.id}:event:4`);
      await expectPgCode(pool, "23514", (client) => client.query(
        `INSERT INTO canonical_work_preparation_events (
          id, plan_id, plan_version, job_id, relationship_id, event_sequence,
          previous_event_id, event_type, readiness_dimension,
          resulting_readiness_state, deposit_gate_type,
          recorded_by_participant_id, command_idempotency_id
        ) VALUES ($1,$2,1,$3,$4,4,$5,'PREPARATION_READY','PREPARATION',
          'READY','NO_DEPOSIT_REQUIRED',$6,$7)`,
        [randomUUID(), plan.id, plan.jobId, plan.relationshipId, eventTwoId,
          fixture.professionalParticipantId, sequenceCommand.id]
      ));

      const evidenceCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.evidence.attach", `purchase:${purchaseId}:receipt`);
      await pool.query(
        `INSERT INTO canonical_work_preparation_evidence_references (
          id, plan_id, job_id, relationship_id, purchase_id, evidence_type,
          reference_namespace, reference_id, recorded_by_participant_id,
          command_idempotency_id
        ) VALUES ($1,$2,$3,$4,$5,'PURCHASE_RECEIPT','governed_media','receipt-1',$6,$7)`,
        [randomUUID(), plan.id, plan.jobId, plan.relationshipId, purchaseId,
          fixture.professionalParticipantId, evidenceCommand.id]
      );
      const duplicateEvidenceCommand = await insertCommand(pool, fixture.jobId,
        fixture.professionalParticipantId, "work_preparation.evidence.attach", `purchase:${purchaseId}:receipt-copy`);
      await expectPgCode(pool, "23505", (client) => client.query(
        `INSERT INTO canonical_work_preparation_evidence_references (
          id, plan_id, job_id, relationship_id, purchase_id, evidence_type,
          reference_namespace, reference_id, recorded_by_participant_id,
          command_idempotency_id
        ) VALUES ($1,$2,$3,$4,$5,'PURCHASE_RECEIPT','governed_media','receipt-1',$6,$7)`,
        [randomUUID(), plan.id, plan.jobId, plan.relationshipId, purchaseId,
          fixture.professionalParticipantId, duplicateEvidenceCommand.id]
      ));

      const duplicateKey = randomUUID();
      await insertCommand(pool, fixture.jobId, fixture.professionalParticipantId,
        "work_preparation.plan.revise", "duplicate-scope", duplicateKey);
      await expectPgCode(pool, "23505", (client) => insertCommand(
        client, fixture.jobId, fixture.professionalParticipantId,
        "work_preparation.plan.revise", "duplicate-scope", duplicateKey
      ));

      await expectPgCode(pool, "55000", (client) => client.query(
        `UPDATE canonical_material_purchase_records SET vendor = 'Rewritten' WHERE id = $1`,
        [purchaseId]
      ));
      await expectPgCode(pool, "55000", (client) => client.query(
        `DELETE FROM canonical_work_preparation_plans WHERE id = $1`, [plan.id]
      ));

      const unchanged = await pool.query(
        `SELECT
          (SELECT count(*) FROM canonical_invoices)::integer AS invoices,
          (SELECT count(*) FROM canonical_invoice_payments)::integer AS invoice_payments,
          (SELECT count(*) FROM canonical_visits)::integer AS visits,
          (SELECT count(*) FROM canonical_work_activities)::integer AS work_activities,
          (SELECT count(*) FROM lifecycle_authority_grants
            WHERE capability LIKE 'work_preparation.%')::integer AS material_grants,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('canonical_quotes','canonical_invoices','canonical_visits','canonical_work_activities')
              AND column_name LIKE '%material_purchase%'
          ) AS adjacent_material_columns`
      );
      assert.deepEqual(unchanged.rows[0], {
        invoices: 0, invoice_payments: 0, visits: 0, work_activities: 0,
        material_grants: 0, adjacent_material_columns: false,
      });
      const financialAuthority = await pool.query(
        `SELECT state, required_minor, applied_minor, remaining_minor
         FROM canonical_pre_work_deposit_versions
         WHERE obligation_id = $1 AND version = 1`,
        [obligationId]
      );
      assert.deepEqual(financialAuthority.rows[0], {
        state: "SATISFIED", required_minor: "5000", applied_minor: "5000",
        remaining_minor: "0",
      });

      const replay = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replay.success, true, JSON.stringify(replay));
      assert.equal(replay.skipped.length, migrations.length);
    } finally {
      await pool.end();
    }
  }
);
