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
const {
  sendQuoteInMeetro,
} = require("../server/authorization/quoteDeliveryService");
const {
  completeEvaluation,
} = require("../server/authorization/evaluationService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.PRE_WORK_PAYMENT_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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

async function createAcceptedQuote(pool, identities, fixture, suffix) {
  const evaluation = await ensureVisitEvaluation(pool, identities, fixture, suffix);
  const completedEvaluation = await completeEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    evaluationId: evaluation.id,
    expectedVersion: 1,
    completionMode: "REMOTE",
    assessmentMethod: "PHONE",
    assessmentBasis:
      "Reviewed the synthetic pre-work deposit authority fixture with the customer by phone.",
    idempotencyKey: `pre-work-evaluation-complete-${suffix}`,
    logger: quiet,
  });
  assert.equal(completedEvaluation.ok, true, completedEvaluation.code);
  const created = await createDraftQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    idempotencyKey: `pre-work-quote-create-${suffix}`,
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
      description: "Synthetic pre-work payment authority",
      quantity: 1,
      unitAmountMinor: 10000,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `pre-work-quote-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `pre-work-quote-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  const delivered = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `pre-work-quote-deliver-${suffix}`,
    logger: quiet,
  });
  assert.equal(delivered.ok, true, delivered.code);
  const approved = await approveIssuedQuote({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    quoteId: issued.quote.id,
    expectedIssuedVersion: issued.quote.currentVersion,
    idempotencyKey: `pre-work-quote-approve-${suffix}`,
    logger: quiet,
  });
  assert.equal(approved.ok, true, approved.code);

  const source = await pool.query(
    `SELECT decisions.id AS customer_decision_id,
       decisions.quote_id, decisions.issued_quote_version,
       decisions.job_id, decisions.relationship_id,
       decisions.decision, decisions.issued_integrity_hash,
       decisions.customer_participant_id, decisions.decided_at,
       versions.currency, versions.total_minor,
       jobs.job_request_id
     FROM canonical_quote_customer_decisions decisions
     INNER JOIN canonical_quote_versions versions
       ON versions.quote_id = decisions.quote_id
       AND versions.version = decisions.issued_quote_version
       AND versions.job_id = decisions.job_id
     INNER JOIN jobs ON jobs.id = decisions.job_id
     WHERE decisions.quote_id = $1`,
    [issued.quote.id]
  );
  return source.rows[0];
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
       quote_id, issued_quote_version, customer_decision_id,
       customer_decision, customer_participant_id, currency,
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

test(
  "disposable PostgreSQL certifies Migration 59 financial integrity without backfill",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      assert.equal(migrations.length, 64);
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, JSON.stringify(migrated));
      assert.equal(migrated.applied.length, 64);

      const empty = await pool.query(
        `SELECT
           (SELECT count(*) FROM canonical_pre_work_deposit_obligations)::integer AS obligations,
           (SELECT count(*) FROM canonical_pre_work_deposit_versions)::integer AS versions,
           (SELECT count(*) FROM canonical_pre_work_payment_receipts)::integer AS receipts,
           (SELECT count(*) FROM canonical_pre_work_payment_allocations)::integer AS allocations,
           (SELECT count(*) FROM canonical_pre_work_payment_allocation_reversals)::integer AS reversals,
           (SELECT count(*) FROM canonical_pre_work_deposit_events)::integer AS events,
           (SELECT count(*) FROM canonical_pre_work_payment_command_idempotency)::integer AS commands,
           (SELECT count(*) FROM schema_migrations)::integer AS ledger`
      );
      assert.deepEqual(empty.rows[0], {
        obligations: 0,
        versions: 0,
        receipts: 0,
        allocations: 0,
        reversals: 0,
        events: 0,
        commands: 0,
        ledger: 64,
      });

      const identities = await createVisitTestIdentities(pool, suffix);
      const fixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-a`);
      const crossFixture = await createVisitLifecycleFixture(pool, identities, `${suffix}-b`);
      const source = await createAcceptedQuote(pool, identities, fixture, `${suffix}-a`);
      const crossSource = await createAcceptedQuote(
        pool,
        identities,
        crossFixture,
        `${suffix}-b`
      );

      const materialize = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.homeownerParticipantId,
        commandName: "deposit.materialize",
        scope: `decision:${source.customer_decision_id}`,
      });
      const obligation = await insertObligation(pool, source, materialize.id);
      await insertVersion(pool, obligation, materialize.id, {
        version: 1,
        state: "DUE",
        appliedMinor: 0,
        remainingMinor: obligation.requiredMinor,
        actorId: fixture.homeownerParticipantId,
      });
      await insertEvent(pool, obligation, materialize.id, {
        version: 1,
        previousVersion: null,
        eventType: "DEPOSIT_OBLIGATION_CREATED",
        state: "DUE",
        actorId: fixture.homeownerParticipantId,
      });

      const duplicateCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.homeownerParticipantId,
        commandName: "deposit.materialize",
        scope: `decision:${source.customer_decision_id}:duplicate`,
      });
      await expectPgCode(pool, "23505", (client) =>
        insertObligation(client, source, duplicateCommand.id)
      );

      for (const overrides of [
        { requiredMinor: 0 },
        {
          ruleType: "PERCENT",
          percentBasisPoints: 7500,
          fixedMinor: 7500,
          requiredMinor: 7500,
        },
        { currency: "usd" },
        { quoteId: source.quote_id },
      ]) {
        const command = await insertCommand(pool, {
          jobId: crossFixture.jobId,
          participantId: crossFixture.homeownerParticipantId,
          commandName: "deposit.materialize",
          scope: `invalid:${randomUUID()}`,
        });
        const expectedCode = overrides.quoteId ? "23503" : "23514";
        await expectPgCode(pool, expectedCode, (client) =>
          insertObligation(client, crossSource, command.id, overrides)
        );
      }

      const crossMaterialize = await insertCommand(pool, {
        jobId: crossFixture.jobId,
        participantId: crossFixture.homeownerParticipantId,
        commandName: "deposit.materialize",
        scope: `decision:${crossSource.customer_decision_id}`,
      });
      const crossObligation = await insertObligation(
        pool,
        crossSource,
        crossMaterialize.id
      );

      const receiptOneCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        commandName: "deposit.payment.record",
        scope: `obligation:${obligation.id}:receipt:1`,
      });
      const receiptOne = await insertReceipt(pool, source, receiptOneCommand.id, {
        amountMinor: 2000,
        evidenceSource: "MANUAL_EXTERNAL",
        normalizedMethod: "COMMUNITY_CREDIT_UNION_APP",
        displayMethod: "Business preferred transfer app",
        externalReference: "manual-confirmation-1",
        actorId: fixture.professionalParticipantId,
      });
      const allocationOneCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        commandName: "deposit.payment.allocate",
        scope: `receipt:${receiptOne.id}:obligation:${obligation.id}`,
      });
      const allocationOne = await insertAllocation(
        pool,
        source,
        obligation,
        receiptOne,
        allocationOneCommand.id,
        2000,
        fixture.professionalParticipantId
      );
      await insertVersion(pool, obligation, allocationOneCommand.id, {
        version: 2,
        state: "PARTIALLY_SATISFIED",
        appliedMinor: 2000,
        remainingMinor: obligation.requiredMinor - 2000,
        actorId: fixture.professionalParticipantId,
      });
      await insertEvent(pool, obligation, allocationOneCommand.id, {
        version: 2,
        previousVersion: 1,
        eventType: "DEPOSIT_PAYMENT_ALLOCATED",
        state: "PARTIALLY_SATISFIED",
        receiptId: receiptOne.id,
        allocationId: allocationOne.id,
        actorId: fixture.professionalParticipantId,
      });

      const receiptTwoCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        commandName: "deposit.payment.record",
        scope: `obligation:${obligation.id}:receipt:2`,
      });
      const receiptTwo = await insertReceipt(pool, source, receiptTwoCommand.id, {
        amountMinor: obligation.requiredMinor - 1500,
        evidenceSource: "MANUAL_EXTERNAL",
        normalizedMethod: "CHECK",
        displayMethod: "Check",
        externalReference: "manual-confirmation-2",
        actorId: fixture.professionalParticipantId,
      });
      const allocationTwoCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        commandName: "deposit.payment.allocate",
        scope: `receipt:${receiptTwo.id}:obligation:${obligation.id}`,
      });
      const allocationTwo = await insertAllocation(
        pool,
        source,
        obligation,
        receiptTwo,
        allocationTwoCommand.id,
        obligation.requiredMinor - 2000,
        fixture.professionalParticipantId
      );
      await insertVersion(pool, obligation, allocationTwoCommand.id, {
        version: 3,
        state: "SATISFIED",
        appliedMinor: obligation.requiredMinor,
        remainingMinor: 0,
        actorId: fixture.professionalParticipantId,
      });
      await insertEvent(pool, obligation, allocationTwoCommand.id, {
        version: 3,
        previousVersion: 2,
        eventType: "DEPOSIT_PAYMENT_ALLOCATED",
        state: "SATISFIED",
        receiptId: receiptTwo.id,
        allocationId: allocationTwo.id,
        actorId: fixture.professionalParticipantId,
      });

      const unapplied = await pool.query(
        `SELECT receipts.gross_amount_minor - COALESCE(sum(allocations.allocated_minor), 0)
           AS unapplied_minor
         FROM canonical_pre_work_payment_receipts receipts
         LEFT JOIN canonical_pre_work_payment_allocations allocations
           ON allocations.receipt_id = receipts.id
         WHERE receipts.id = $1
         GROUP BY receipts.id, receipts.gross_amount_minor`,
        [receiptTwo.id]
      );
      assert.equal(Number(unapplied.rows[0].unapplied_minor), 500);

      const processorCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        externalActor: "processor:test-provider",
        commandName: "deposit.payment.record",
        scope: `processor-receipt:${randomUUID()}`,
      });
      const processorReceipt = await insertReceipt(pool, source, processorCommand.id, {
        amountMinor: 100,
        evidenceSource: "PROCESSOR",
        normalizedMethod: "FUTURE_PROCESSOR_CARD",
        displayMethod: "Processor card",
        externalReference: `provider-event-${randomUUID()}`,
        actorId: null,
      });
      assert.ok(processorReceipt.id);

      const mismatchCommand = await insertCommand(pool, {
        jobId: crossFixture.jobId,
        participantId: crossFixture.professionalParticipantId,
        commandName: "deposit.payment.allocate",
        scope: `cross-job:${randomUUID()}`,
      });
      await expectPgCode(pool, "23503", (client) =>
        client.query(
          `INSERT INTO canonical_pre_work_payment_allocations (
             id, receipt_id, obligation_id, job_id, relationship_id,
             currency, allocated_minor, recorded_by_participant_id,
             command_idempotency_id, integrity_hash
           ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)`,
          [
            randomUUID(),
            receiptOne.id,
            crossObligation.id,
            crossSource.job_id,
            Number(crossSource.relationship_id),
            crossSource.currency,
            crossFixture.professionalParticipantId,
            mismatchCommand.id,
            hash("cross-job-allocation"),
          ]
        )
      );

      const invalidReversalCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        commandName: "deposit.payment.reverse",
        scope: `invalid-reversal:${randomUUID()}`,
      });
      await expectPgCode(pool, "23503", (client) =>
        client.query(
          `INSERT INTO canonical_pre_work_payment_allocation_reversals (
             id, allocation_id, receipt_id, obligation_id, job_id,
             relationship_id, currency, reversed_minor, reversal_effect,
             reason_category, reason, reversed_at,
             recorded_by_participant_id, command_idempotency_id, integrity_hash
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1,
             'RECEIPT_REVERSAL', 'REFUND', 'Incorrect receipt identity',
             '2026-08-28T13:00:00.000Z', $8, $9, $10)`,
          [
            randomUUID(),
            allocationOne.id,
            receiptTwo.id,
            obligation.id,
            source.job_id,
            Number(source.relationship_id),
            source.currency,
            fixture.professionalParticipantId,
            invalidReversalCommand.id,
            hash("invalid-reversal"),
          ]
        )
      );

      const reversalCommand = await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        commandName: "deposit.payment.reverse",
        scope: `allocation:${allocationTwo.id}:refund`,
      });
      const reversalId = randomUUID();
      await pool.query(
        `INSERT INTO canonical_pre_work_payment_allocation_reversals (
           id, allocation_id, receipt_id, obligation_id, job_id,
           relationship_id, currency, reversed_minor, reversal_effect,
           reason_category, reason, reversed_at,
           recorded_by_participant_id, command_idempotency_id, integrity_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1000,
           'RECEIPT_REVERSAL', 'REFUND', 'Verified external refund',
           '2026-08-28T13:00:00.000Z', $8, $9, $10)`,
        [
          reversalId,
          allocationTwo.id,
          receiptTwo.id,
          obligation.id,
          source.job_id,
          Number(source.relationship_id),
          source.currency,
          fixture.professionalParticipantId,
          reversalCommand.id,
          hash(`reversal:${reversalId}`),
        ]
      );
      await insertVersion(pool, obligation, reversalCommand.id, {
        version: 4,
        state: "PARTIALLY_SATISFIED",
        appliedMinor: obligation.requiredMinor - 1000,
        remainingMinor: 1000,
        actorId: fixture.professionalParticipantId,
      });
      await insertEvent(pool, obligation, reversalCommand.id, {
        version: 4,
        previousVersion: 3,
        eventType: "DEPOSIT_PAYMENT_REVERSED",
        state: "PARTIALLY_SATISFIED",
        receiptId: receiptTwo.id,
        allocationId: allocationTwo.id,
        reversalId,
        actorId: fixture.professionalParticipantId,
      });

      const duplicateKey = randomUUID();
      await insertCommand(pool, {
        jobId: fixture.jobId,
        participantId: fixture.professionalParticipantId,
        commandName: "deposit.payment.record",
        scope: "duplicate-command-scope",
        key: duplicateKey,
      });
      await expectPgCode(pool, "23505", (client) =>
        insertCommand(client, {
          jobId: fixture.jobId,
          participantId: fixture.professionalParticipantId,
          commandName: "deposit.payment.record",
          scope: "duplicate-command-scope",
          key: duplicateKey,
        })
      );

      await expectPgCode(pool, "55000", (client) =>
        client.query(
          `UPDATE canonical_pre_work_payment_receipts
           SET display_method = 'Rewritten' WHERE id = $1`,
          [receiptOne.id]
        )
      );
      await expectPgCode(pool, "55000", (client) =>
        client.query(
          `DELETE FROM canonical_pre_work_deposit_obligations WHERE id = $1`,
          [obligation.id]
        )
      );

      const latest = await pool.query(
        `SELECT state, required_minor, applied_minor, remaining_minor
         FROM canonical_pre_work_deposit_versions
         WHERE obligation_id = $1 ORDER BY version DESC LIMIT 1`,
        [obligation.id]
      );
      assert.deepEqual(latest.rows[0], {
        state: "PARTIALLY_SATISFIED",
        required_minor: String(obligation.requiredMinor),
        applied_minor: String(obligation.requiredMinor - 1000),
        remaining_minor: "1000",
      });

      const adjacent = await pool.query(
        `SELECT
           (SELECT count(*) FROM canonical_invoice_payments)::integer AS invoice_payments,
           (SELECT count(*) FROM canonical_visits)::integer AS visits,
           (SELECT count(*) FROM lifecycle_authority_grants
             WHERE scope_type = 'approved_work')::integer AS approved_work_grants,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name IN ('canonical_visits', 'canonical_invoice_payments')
               AND column_name LIKE '%deposit%'
           ) AS adjacent_deposit_columns`
      );
      assert.deepEqual(adjacent.rows[0], {
        invoice_payments: 0,
        visits: 0,
        approved_work_grants: 0,
        adjacent_deposit_columns: false,
      });

      const replay = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(replay.success, true, JSON.stringify(replay));
      assert.equal(replay.skipped.length, 64);
    } finally {
      await pool.end();
    }
  }
);
