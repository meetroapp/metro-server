"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
} = require("./helpers/visitLifecycleFixture");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.EVALUATION_REMOTE_PROVENANCE_DATABASE_URL;
const migrationName =
  "202608260001_create_evaluation_remote_provenance.sql";
const hash = "a".repeat(64);

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

async function expectRejection(
  pool,
  statement,
  values,
  expectedCodes = null,
  expectedConstraint = null
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      client.query(statement, values),
      (error) =>
        error &&
        (!expectedCodes ||
          (Array.isArray(expectedCodes)
            ? expectedCodes.includes(error.code)
            : error.code === expectedCodes)) &&
        (!expectedConstraint || error.constraint === expectedConstraint)
    );
    await client.query("ROLLBACK");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The assertion failure remains authoritative.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createEvaluationRecord(
  pool,
  identities,
  fixture,
  {
    status = "completed",
    currentVersion = status === "completed" ? 2 : 1,
    completedVersions = status === "completed" ? [2] : [],
  } = {}
) {
  const evaluationId = randomUUID();
  const relationship = await pool.query(
    `SELECT source_request_relationship_id AS relationship_id
     FROM jobs WHERE id = $1`,
    [fixture.jobId]
  );
  const relationshipId = Number(relationship.rows[0].relationship_id);
  await pool.query(
    `INSERT INTO commercial_authority_aggregates (
       id, aggregate_type, owning_engine, source_context_type,
       ordinary_request_id, relationship_id, source_owner_user_id,
       created_by_user_id, current_version
     ) VALUES (
       $1, 'evaluation', 'authorization_engine', 'ordinary_request',
       $2, $3, $4, $5, $6
     )`,
    [
      evaluationId,
      fixture.requestId,
      relationshipId,
      identities.homeownerId,
      identities.professionalId,
      currentVersion,
    ]
  );
  await pool.query(
    `INSERT INTO canonical_evaluations (
       id, relationship_id, professional_user_id, status, completed_at
     ) VALUES (
       $1, $2, $3, $4,
       CASE WHEN $4 = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
     )`,
    [evaluationId, relationshipId, identities.professionalId, status]
  );
  for (let version = 1; version <= currentVersion; version += 1) {
    const versionStatus = completedVersions.includes(version)
      ? "completed"
      : "draft";
    await pool.query(
      `INSERT INTO canonical_evaluation_versions (
         evaluation_id, version, status, observations, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        evaluationId,
        version,
        versionStatus,
        `Disposable Evaluation version ${version}`,
        identities.professionalId,
      ]
    );
  }
  await pool.query(
    `INSERT INTO canonical_evaluation_job_subjects (
       evaluation_id, job_id, job_request_id, relationship_id
     ) VALUES ($1, $2, $3, $4)`,
    [evaluationId, fixture.jobId, fixture.requestId, relationshipId]
  );
  return { evaluationId, relationshipId, currentVersion };
}

async function createCompletionCommand(
  pool,
  identities,
  evaluationId,
  {
    commandName = "evaluation.complete",
    commandEvaluationId = evaluationId,
    completed = true,
    actorUserId = identities.professionalId,
    completedAt = null,
  } = {}
) {
  const commandId = randomUUID();
  await pool.query(
    `INSERT INTO commercial_command_idempotency (
       id, actor_user_id, command_name, command_scope, idempotency_key,
       request_fingerprint, aggregate_id, result_reference, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       CASE WHEN $7 THEN $8::uuid ELSE NULL END,
       CASE WHEN $7 THEN '{"ok":true}'::jsonb ELSE NULL END,
       CASE WHEN $7 THEN COALESCE($9::timestamptz, CURRENT_TIMESTAMP) ELSE NULL END
     )`,
    [
      commandId,
      actorUserId,
      commandName,
      `evaluation:${commandEvaluationId}`,
      randomUUID(),
      hash,
      completed,
      commandEvaluationId,
      completedAt,
    ]
  );
  return commandId;
}

async function completionTimestamp(pool, commandId) {
  const result = await pool.query(
    `SELECT completed_at FROM commercial_command_idempotency WHERE id = $1`,
    [commandId]
  );
  return result.rows[0].completed_at;
}

async function professionalAuthorityRows(pool, fixture) {
  const assignments = await pool.query(
    `SELECT id
     FROM participant_role_assignments
     WHERE participant_id = $1
       AND job_id = $2
       AND role = 'PRIMARY_PROFESSIONAL'
     ORDER BY created_at ASC, id ASC`,
    [fixture.professionalParticipantId, fixture.jobId]
  );
  const grants = await pool.query(
    `SELECT id
     FROM lifecycle_authority_grants
     WHERE grantee_participant_id = $1
       AND job_id = $2
       AND capability = 'evaluation.perform'
     ORDER BY created_at ASC, id ASC`,
    [fixture.professionalParticipantId, fixture.jobId]
  );
  return {
    assignmentIds: assignments.rows.map(({ id }) => id),
    grantIds: grants.rows.map(({ id }) => id),
  };
}

async function revokeProfessionalAuthority(
  pool,
  fixture,
  { revokeRole = false, revokeGrants = true, revokedAt = null } = {}
) {
  const authority = await professionalAuthorityRows(pool, fixture);
  if (revokeRole) {
    for (const assignmentId of authority.assignmentIds) {
      await pool.query(
        `INSERT INTO participant_role_revocations (
           id, role_assignment_id, job_id, revoked_by_participant_id,
           revocation_reason, source_evidence_type, source_evidence_reference,
           idempotency_key, revoked_at
         ) VALUES (
           $1, $2, $3, $4, 'Synthetic authority timeline test',
           'remote_provenance_test', $5, $6,
           COALESCE($7::timestamptz, CURRENT_TIMESTAMP)
         )`,
        [
          randomUUID(),
          assignmentId,
          fixture.jobId,
          fixture.homeownerParticipantId,
          `role-revocation:${assignmentId}`,
          randomUUID(),
          revokedAt,
        ]
      );
    }
  }
  if (revokeGrants) {
    for (const grantId of authority.grantIds) {
      await pool.query(
        `INSERT INTO lifecycle_authority_grant_revocations (
           id, authority_grant_id, job_id, revoked_by_participant_id,
           revocation_reason, source_evidence_type, source_evidence_reference,
           idempotency_key, revoked_at
         ) VALUES (
           $1, $2, $3, $4, 'Synthetic authority timeline test',
           'remote_provenance_test', $5, $6,
           COALESCE($7::timestamptz, CURRENT_TIMESTAMP)
         )`,
        [
          randomUUID(),
          grantId,
          fixture.jobId,
          fixture.homeownerParticipantId,
          `grant-revocation:${grantId}`,
          randomUUID(),
          revokedAt,
        ]
      );
    }
  }
  return authority;
}

async function addEvaluationGrant(
  pool,
  fixture,
  { validFrom = null, validUntil = null } = {}
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO lifecycle_authority_grants (
       id, grantee_participant_id, grantor_participant_id, job_id,
       capability, scope_type, scope_job_id, valid_from, valid_until,
       source_evidence_type, source_evidence_reference, idempotency_key
     ) VALUES (
       $1, $2, $3, $4, 'evaluation.perform', 'job', $4,
       COALESCE($5::timestamptz, CURRENT_TIMESTAMP), $6::timestamptz,
       'remote_provenance_test', $7, $8
     )`,
    [
      id,
      fixture.professionalParticipantId,
      fixture.homeownerParticipantId,
      fixture.jobId,
      validFrom,
      validUntil,
      `evaluation-grant:${id}`,
      randomUUID(),
    ]
  );
  return id;
}

async function createRemoteScenario(
  pool,
  identities,
  suffix,
  { commandOptions = {} } = {}
) {
  const fixture = await createVisitLifecycleFixture(pool, identities, suffix);
  const evaluation = await createEvaluationRecord(pool, identities, fixture);
  const commandId = await createCompletionCommand(
    pool,
    identities,
    evaluation.evaluationId,
    commandOptions
  );
  return {
    fixture,
    evaluation,
    commandId,
    candidate: remoteInsert({
      evaluationId: evaluation.evaluationId,
      evaluationVersion: evaluation.currentVersion,
      jobId: fixture.jobId,
      professionalParticipantId: fixture.professionalParticipantId,
      commandId,
    }),
  };
}

function remoteInsert(values = {}) {
  const row = {
    id: values.id || randomUUID(),
    evaluationId: values.evaluationId,
    evaluationVersion: values.evaluationVersion,
    jobId: values.jobId,
    professionalParticipantId: values.professionalParticipantId,
    method: values.method || "VIDEO",
    basis:
      values.basis === undefined
        ? "The professional reviewed the project with the customer by video."
        : values.basis,
    commandId: values.commandId,
  };
  return {
    statement: `INSERT INTO canonical_evaluation_remote_provenance (
      id, evaluation_id, evaluation_version, job_id,
      professional_participant_id, assessment_method, assessment_basis,
      completion_command_idempotency_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    values: [
      row.id,
      row.evaluationId,
      row.evaluationVersion,
      row.jobId,
      row.professionalParticipantId,
      row.method,
      row.basis,
      row.commandId,
    ],
  };
}

async function insertVisitCommand(pool, fixture, commandName, scope) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO canonical_visit_command_idempotency (
       id, actor_participant_id, job_id, command_name, command_scope,
       idempotency_key, request_fingerprint, result_reference, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, CURRENT_TIMESTAMP)`,
    [
      id,
      fixture.professionalParticipantId,
      fixture.jobId,
      commandName,
      scope,
      randomUUID(),
      hash,
    ]
  );
  return id;
}

async function createCompletedVisit(pool, fixture, label) {
  const visitId = randomUUID();
  const proposedCommandId = await insertVisitCommand(
    pool,
    fixture,
    "visit.propose",
    `${label}:propose`
  );
  const completedCommandId = await insertVisitCommand(
    pool,
    fixture,
    "visit.complete",
    `${label}:complete`
  );
  await pool.query(
    `INSERT INTO canonical_visits (
       id, job_id, purpose, created_by_participant_id,
       created_command_idempotency_id
     ) VALUES ($1, $2, 'EVALUATION', $3, $4)`,
    [
      visitId,
      fixture.jobId,
      fixture.professionalParticipantId,
      proposedCommandId,
    ]
  );
  await pool.query(
    `INSERT INTO canonical_visit_versions (
       visit_id, version, job_id, state, scheduled_start_at,
       scheduled_end_at, time_zone, location_mode,
       completed_at, recorded_by_participant_id, command_idempotency_id,
       integrity_hash
     ) VALUES (
       $1, 1, $2, 'PROPOSED', '2026-09-01T14:00:00.000Z',
       '2026-09-01T15:00:00.000Z', 'America/New_York',
       'JOB_SERVICE_LOCATION', NULL, $3, $4, $5
     ), (
       $1, 2, $2, 'COMPLETED', '2026-09-01T14:00:00.000Z',
       '2026-09-01T15:00:00.000Z', 'America/New_York',
       'JOB_SERVICE_LOCATION', CURRENT_TIMESTAMP, $3, $6, $5
     )`,
    [
      visitId,
      fixture.jobId,
      fixture.professionalParticipantId,
      proposedCommandId,
      hash,
      completedCommandId,
    ]
  );
  await pool.query(
    `INSERT INTO canonical_visit_events (
       id, visit_id, visit_version, previous_visit_version, job_id,
       event_type, visit_state, recorded_by_participant_id,
       command_idempotency_id
     ) VALUES (
       $1, $2, 1, NULL, $3, 'VISIT_PROPOSED', 'PROPOSED', $4, $5
     ), (
       $6, $2, 2, 1, $3, 'VISIT_COMPLETED', 'COMPLETED', $4, $7
     )`,
    [
      randomUUID(),
      visitId,
      fixture.jobId,
      fixture.professionalParticipantId,
      proposedCommandId,
      randomUUID(),
      completedCommandId,
    ]
  );
  const linkCommandId = await insertVisitCommand(
    pool,
    fixture,
    "visit.link_evaluation",
    `${label}:link`
  );
  return { visitId, linkCommandId };
}

function physicalLinkInsert(visit, evaluation, fixture) {
  return {
    statement: `INSERT INTO canonical_visit_evaluation_links (
      visit_id, job_id, evaluation_id, linked_by_participant_id,
      command_idempotency_id
    ) VALUES ($1, $2, $3, $4, $5) RETURNING visit_id`,
    values: [
      visit.visitId,
      fixture.jobId,
      evaluation.evaluationId,
      fixture.professionalParticipantId,
      visit.linkCommandId,
    ],
  };
}

async function runProvenanceRace(
  pool,
  { isolationLevel, raceRemote, racePhysical, evaluationId }
) {
  const remoteClient = await pool.connect();
  const physicalClient = await pool.connect();
  let raceOutcome;
  try {
    await remoteClient.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    await physicalClient.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const remoteIsolation = await remoteClient.query("SHOW transaction_isolation");
    const physicalIsolation = await physicalClient.query("SHOW transaction_isolation");
    const remoteSnapshot = await remoteClient.query(
      `SELECT txid_current_snapshot()::text AS snapshot,
         (SELECT count(*)::integer
          FROM canonical_evaluation_provenance_claims
          WHERE evaluation_id = $1) AS claims`,
      [evaluationId]
    );
    const physicalSnapshot = await physicalClient.query(
      `SELECT txid_current_snapshot()::text AS snapshot,
         (SELECT count(*)::integer
          FROM canonical_evaluation_provenance_claims
          WHERE evaluation_id = $1) AS claims`,
      [evaluationId]
    );
    assert.equal(remoteSnapshot.rows[0].claims, 0);
    assert.equal(physicalSnapshot.rows[0].claims, 0);

    const remoteAttempt = remoteClient
      .query(raceRemote.statement, raceRemote.values)
      .then(() => ({ path: "remote", ok: true }))
      .catch((error) => ({
        path: "remote",
        ok: false,
        code: error.code,
        constraint: error.constraint || null,
      }));
    const physicalAttempt = physicalClient
      .query(racePhysical.statement, racePhysical.values)
      .then(() => ({ path: "physical", ok: true }))
      .catch((error) => ({
        path: "physical",
        ok: false,
        code: error.code,
        constraint: error.constraint || null,
      }));
    const first = await Promise.race([remoteAttempt, physicalAttempt]);
    assert.equal(first.ok, true);
    if (first.path === "remote") {
      await remoteClient.query("COMMIT");
    } else {
      await physicalClient.query("COMMIT");
    }
    const second = await (first.path === "remote"
      ? physicalAttempt
      : remoteAttempt);
    assert.equal(second.ok, false);
    assert.ok(["23505", "23514", "40001"].includes(second.code));
    if (second.path === "remote") {
      await remoteClient.query("ROLLBACK");
    } else {
      await physicalClient.query("ROLLBACK");
    }
    const committed = await pool.query(
      `SELECT
         (SELECT count(*) FROM canonical_evaluation_remote_provenance
           WHERE evaluation_id = $1)::integer AS remote,
         (SELECT count(*) FROM canonical_visit_evaluation_links
           WHERE evaluation_id = $1)::integer AS physical,
         (SELECT count(*) FROM canonical_evaluation_provenance_claims
           WHERE evaluation_id = $1)::integer AS claims`,
      [evaluationId]
    );
    assert.equal(committed.rows[0].remote + committed.rows[0].physical, 1);
    assert.equal(committed.rows[0].claims, 1);
    raceOutcome = {
      isolation: remoteIsolation.rows[0].transaction_isolation,
      physicalIsolation: physicalIsolation.rows[0].transaction_isolation,
      snapshotsEstablishedBeforeAttempts: true,
      remoteSnapshot: remoteSnapshot.rows[0].snapshot,
      physicalSnapshot: physicalSnapshot.rows[0].snapshot,
      winner: first.path,
      rejected: second.path,
      code: second.code,
      constraint: second.constraint,
      committed: committed.rows[0],
    };
  } finally {
    try {
      await remoteClient.query("ROLLBACK");
    } catch {}
    try {
      await physicalClient.query("ROLLBACK");
    } catch {}
    remoteClient.release();
    physicalClient.release();
  }
  return raceOutcome;
}

async function counts(pool) {
  const result = await pool.query(
    `SELECT
      (SELECT count(*) FROM users)::integer AS users,
      (SELECT count(*) FROM jobs)::integer AS jobs,
      (SELECT count(*) FROM canonical_evaluations)::integer AS evaluations,
      (SELECT count(*) FROM canonical_evaluation_versions)::integer AS evaluation_versions,
      (SELECT count(*) FROM canonical_visits)::integer AS visits,
      (SELECT count(*) FROM canonical_visit_evaluation_links)::integer AS visit_links,
      (SELECT count(*) FROM lifecycle_authority_grants)::integer AS grants`
  );
  return result.rows[0];
}

test(
  "migration 57 enforces immutable exact remote Evaluation provenance",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const migrationIndex = migrations.findIndex(
        ({ filename }) => filename === migrationName
      );
      assert.equal(migrationIndex, 56);
      const baseline = await runMigrationCollection(
        pool,
        migrations.slice(0, migrationIndex),
        targetMetadata()
      );
      assert.equal(baseline.success, true, baseline.errorCode);
      assert.equal(baseline.applied.length, 56);

      const identities = await createVisitTestIdentities(pool, suffix);
      const historicalJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-historical`
      );
      const historicalEvaluation = await createEvaluationRecord(
        pool,
        identities,
        historicalJob
      );
      const historicalCommand = await createCompletionCommand(
        pool,
        identities,
        historicalEvaluation.evaluationId
      );
      const historicalPhysicalJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-historical-physical`
      );
      const historicalPhysicalEvaluation = await createEvaluationRecord(
        pool,
        identities,
        historicalPhysicalJob
      );
      const historicalPhysicalCommand = await createCompletionCommand(
        pool,
        identities,
        historicalPhysicalEvaluation.evaluationId
      );
      const historicalPhysicalVisit = await createCompletedVisit(
        pool,
        historicalPhysicalJob,
        `${suffix}:historical-physical`
      );
      const historicalPhysicalLink = physicalLinkInsert(
        historicalPhysicalVisit,
        historicalPhysicalEvaluation,
        historicalPhysicalJob
      );
      await pool.query(
        historicalPhysicalLink.statement,
        historicalPhysicalLink.values
      );
      const before = await counts(pool);
      const historicalBefore = await pool.query(
        `SELECT status, completed_at FROM canonical_evaluations WHERE id = $1`,
        [historicalEvaluation.evaluationId]
      );

      const migration = migrations[migrationIndex];
      const upgraded = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata()
      );
      assert.equal(upgraded.success, true, upgraded.errorCode);
      assert.deepEqual(upgraded.applied, [migrationName]);

      const ledger = await pool.query(
        `SELECT count(*)::integer AS count,
           max(filename) FILTER (WHERE filename = $1) AS migration
         FROM schema_migrations`,
        [migrationName]
      );
      assert.deepEqual(ledger.rows[0], {
        count: 57,
        migration: migrationName,
      });
      assert.deepEqual(await counts(pool), before);
      const unsolicited = await pool.query(
        `SELECT
           (SELECT count(*) FROM canonical_evaluation_remote_provenance)::integer
             AS remote,
           (SELECT count(*) FROM canonical_evaluation_provenance_claims)::integer
             AS claims`
      );
      assert.deepEqual(unsolicited.rows[0], { remote: 0, claims: 0 });
      const historicalAfter = await pool.query(
        `SELECT status, completed_at FROM canonical_evaluations WHERE id = $1`,
        [historicalEvaluation.evaluationId]
      );
      assert.deepEqual(historicalAfter.rows, historicalBefore.rows);
      console.log(
        "REMOTE_PROVENANCE_NO_BACKFILL",
        JSON.stringify({
          ledgerBefore: 56,
          ledgerAfter: ledger.rows[0].count,
          before,
          after: await counts(pool),
          remoteProvenanceRows: unsolicited.rows[0].remote,
          provenanceClaimRows: unsolicited.rows[0].claims,
          historicalEvaluationPreserved:
            JSON.stringify(historicalAfter.rows) ===
            JSON.stringify(historicalBefore.rows),
        })
      );

      const remoteAfterHistoricalPhysical = remoteInsert({
        evaluationId: historicalPhysicalEvaluation.evaluationId,
        evaluationVersion: historicalPhysicalEvaluation.currentVersion,
        jobId: historicalPhysicalJob.jobId,
        professionalParticipantId:
          historicalPhysicalJob.professionalParticipantId,
        commandId: historicalPhysicalCommand,
      });
      await expectRejection(
        pool,
        remoteAfterHistoricalPhysical.statement,
        remoteAfterHistoricalPhysical.values,
        "23514"
      );
      const historicalPhysicalClaim = await pool.query(
        `SELECT count(*)::integer AS count
         FROM canonical_evaluation_provenance_claims
         WHERE evaluation_id = $1`,
        [historicalPhysicalEvaluation.evaluationId]
      );
      assert.equal(historicalPhysicalClaim.rows[0].count, 0);

      const baseRemote = {
        evaluationId: historicalEvaluation.evaluationId,
        evaluationVersion: historicalEvaluation.currentVersion,
        jobId: historicalJob.jobId,
        professionalParticipantId: historicalJob.professionalParticipantId,
        commandId: historicalCommand,
      };
      for (const method of [
        "PHONE",
        "VIDEO",
        "CUSTOMER_PHOTOS",
        "DOCUMENT_REVIEW",
        "OTHER_REMOTE",
      ]) {
        const candidate = remoteInsert({ ...baseRemote, method });
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(candidate.statement, candidate.values);
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }

      for (const [method, basis, codes] of [
        ["IN_PERSON", "Invalid method", "23514"],
        ["VIDEO", "", "23514"],
        ["VIDEO", "   ", "23514"],
        ["VIDEO", `x${"a".repeat(2000)}`, "23514"],
        ["VIDEO", " leading whitespace", "23514"],
      ]) {
        const candidate = remoteInsert({ ...baseRemote, method, basis });
        await expectRejection(
          pool,
          candidate.statement,
          candidate.values,
          codes
        );
      }

      for (const version of [1, 99]) {
        const candidate = remoteInsert({
          ...baseRemote,
          evaluationVersion: version,
        });
        await expectRejection(
          pool,
          candidate.statement,
          candidate.values,
          ["23514", "23503"]
        );
      }

      const draftJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-draft`
      );
      const draftEvaluation = await createEvaluationRecord(
        pool,
        identities,
        draftJob,
        { status: "draft", currentVersion: 1, completedVersions: [] }
      );
      const draftCommand = await createCompletionCommand(
        pool,
        identities,
        draftEvaluation.evaluationId
      );
      const draftCandidate = remoteInsert({
        evaluationId: draftEvaluation.evaluationId,
        evaluationVersion: 1,
        jobId: draftJob.jobId,
        professionalParticipantId: draftJob.professionalParticipantId,
        commandId: draftCommand,
      });
      await expectRejection(
        pool,
        draftCandidate.statement,
        draftCandidate.values,
        "23514"
      );

      const nonCurrentJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-noncurrent`
      );
      const nonCurrentEvaluation = await createEvaluationRecord(
        pool,
        identities,
        nonCurrentJob,
        { status: "completed", currentVersion: 2, completedVersions: [1, 2] }
      );
      const nonCurrentCommand = await createCompletionCommand(
        pool,
        identities,
        nonCurrentEvaluation.evaluationId
      );
      const nonCurrentCandidate = remoteInsert({
        evaluationId: nonCurrentEvaluation.evaluationId,
        evaluationVersion: 1,
        jobId: nonCurrentJob.jobId,
        professionalParticipantId: nonCurrentJob.professionalParticipantId,
        commandId: nonCurrentCommand,
      });
      await expectRejection(
        pool,
        nonCurrentCandidate.statement,
        nonCurrentCandidate.values,
        "23514"
      );

      for (const overrides of [
        { jobId: draftJob.jobId },
        { professionalParticipantId: historicalJob.homeownerParticipantId },
        { commandId: randomUUID() },
      ]) {
        const candidate = remoteInsert({ ...baseRemote, ...overrides });
        await expectRejection(
          pool,
          candidate.statement,
          candidate.values,
          ["23514", "23503"]
        );
      }

      const incompleteCommand = await createCompletionCommand(
        pool,
        identities,
        historicalEvaluation.evaluationId,
        { completed: false }
      );
      const wrongActionCommand = await createCompletionCommand(
        pool,
        identities,
        historicalEvaluation.evaluationId,
        { commandName: "evaluation.draft.update" }
      );
      const wrongEvaluationCommand = await createCompletionCommand(
        pool,
        identities,
        draftEvaluation.evaluationId
      );
      for (const commandId of [
        incompleteCommand,
        wrongActionCommand,
        wrongEvaluationCommand,
      ]) {
        const candidate = remoteInsert({ ...baseRemote, commandId });
        await expectRejection(
          pool,
          candidate.statement,
          candidate.values,
          "23514"
        );
      }

      const validThenRevoked = await createRemoteScenario(
        pool,
        identities,
        `${suffix}-valid-then-revoked`
      );
      const validCompletionAt = await completionTimestamp(
        pool,
        validThenRevoked.commandId
      );
      await pool.query("SELECT pg_sleep(0.02)");
      await revokeProfessionalAuthority(pool, validThenRevoked.fixture, {
        revokeRole: true,
        revokeGrants: true,
      });
      const revokedAfter = await pool.query(
        `SELECT
           (SELECT min(revoked_at)
            FROM participant_role_revocations
            WHERE job_id = $1) AS role_revoked_at,
           (SELECT min(revoked_at)
            FROM lifecycle_authority_grant_revocations
            WHERE job_id = $1) AS grant_revoked_at`,
        [validThenRevoked.fixture.jobId]
      );
      assert.ok(revokedAfter.rows[0].role_revoked_at > validCompletionAt);
      assert.ok(revokedAfter.rows[0].grant_revoked_at > validCompletionAt);
      await pool.query(
        validThenRevoked.candidate.statement,
        validThenRevoked.candidate.values
      );

      const grantedAfterFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-granted-after`
      );
      const grantedAfterEvaluation = await createEvaluationRecord(
        pool,
        identities,
        grantedAfterFixture
      );
      await revokeProfessionalAuthority(pool, grantedAfterFixture);
      await pool.query("SELECT pg_sleep(0.02)");
      const grantedAfterCommand = await createCompletionCommand(
        pool,
        identities,
        grantedAfterEvaluation.evaluationId
      );
      const grantedAfterCompletionAt = await completionTimestamp(
        pool,
        grantedAfterCommand
      );
      await pool.query("SELECT pg_sleep(0.02)");
      const postCompletionGrantId = await addEvaluationGrant(
        pool,
        grantedAfterFixture
      );
      const postCompletionGrant = await pool.query(
        `SELECT valid_from FROM lifecycle_authority_grants WHERE id = $1`,
        [postCompletionGrantId]
      );
      assert.ok(
        postCompletionGrant.rows[0].valid_from > grantedAfterCompletionAt
      );
      const grantedAfterCandidate = remoteInsert({
        evaluationId: grantedAfterEvaluation.evaluationId,
        evaluationVersion: grantedAfterEvaluation.currentVersion,
        jobId: grantedAfterFixture.jobId,
        professionalParticipantId:
          grantedAfterFixture.professionalParticipantId,
        commandId: grantedAfterCommand,
      });
      await expectRejection(
        pool,
        grantedAfterCandidate.statement,
        grantedAfterCandidate.values,
        "23514"
      );

      const revokedBeforeFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-revoked-before`
      );
      const revokedBeforeEvaluation = await createEvaluationRecord(
        pool,
        identities,
        revokedBeforeFixture
      );
      await revokeProfessionalAuthority(pool, revokedBeforeFixture);
      await pool.query("SELECT pg_sleep(0.02)");
      const revokedBeforeCommand = await createCompletionCommand(
        pool,
        identities,
        revokedBeforeEvaluation.evaluationId
      );
      const revokedBeforeCandidate = remoteInsert({
        evaluationId: revokedBeforeEvaluation.evaluationId,
        evaluationVersion: revokedBeforeEvaluation.currentVersion,
        jobId: revokedBeforeFixture.jobId,
        professionalParticipantId:
          revokedBeforeFixture.professionalParticipantId,
        commandId: revokedBeforeCommand,
      });
      await expectRejection(
        pool,
        revokedBeforeCandidate.statement,
        revokedBeforeCandidate.values,
        "23514"
      );

      const expiredBeforeFixture = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-expired-before`
      );
      const expiredBeforeEvaluation = await createEvaluationRecord(
        pool,
        identities,
        expiredBeforeFixture
      );
      await revokeProfessionalAuthority(pool, expiredBeforeFixture);
      const expiringGrant = await pool.query(
        `SELECT CURRENT_TIMESTAMP AS valid_from,
           CURRENT_TIMESTAMP + interval '20 milliseconds' AS valid_until`
      );
      await addEvaluationGrant(pool, expiredBeforeFixture, {
        validFrom: expiringGrant.rows[0].valid_from,
        validUntil: expiringGrant.rows[0].valid_until,
      });
      await pool.query("SELECT pg_sleep(0.04)");
      const expiredBeforeCommand = await createCompletionCommand(
        pool,
        identities,
        expiredBeforeEvaluation.evaluationId
      );
      const expiredBeforeCandidate = remoteInsert({
        evaluationId: expiredBeforeEvaluation.evaluationId,
        evaluationVersion: expiredBeforeEvaluation.currentVersion,
        jobId: expiredBeforeFixture.jobId,
        professionalParticipantId:
          expiredBeforeFixture.professionalParticipantId,
        commandId: expiredBeforeCommand,
      });
      await expectRejection(
        pool,
        expiredBeforeCandidate.statement,
        expiredBeforeCandidate.values,
        "23514"
      );

      const wrongActor = await createRemoteScenario(
        pool,
        identities,
        `${suffix}-wrong-actor`,
        { commandOptions: { actorUserId: identities.homeownerId } }
      );
      await expectRejection(
        pool,
        wrongActor.candidate.statement,
        wrongActor.candidate.values,
        "23514"
      );
      console.log(
        "REMOTE_PROVENANCE_AUTHORITY_TIMELINE",
        JSON.stringify({
          validAtCompletionRevokedLater: "accepted",
          grantedOnlyAfterCompletion: "rejected",
          revokedBeforeCompletion: "rejected",
          expiredBeforeCompletion: "rejected",
          wrongActor: "rejected",
        })
      );

      const valid = remoteInsert(baseRemote);
      const validResult = await pool.query(valid.statement, valid.values);
      assert.equal(validResult.rows.length, 1);
      const exact = await pool.query(
        `SELECT evaluation_id, evaluation_version, job_id,
           professional_participant_id, assessment_method,
           completion_command_idempotency_id
         FROM canonical_evaluation_remote_provenance
         WHERE evaluation_id = $1`,
        [historicalEvaluation.evaluationId]
      );
      assert.deepEqual(exact.rows[0], {
        evaluation_id: historicalEvaluation.evaluationId,
        evaluation_version: 2,
        job_id: historicalJob.jobId,
        professional_participant_id: historicalJob.professionalParticipantId,
        assessment_method: "VIDEO",
        completion_command_idempotency_id: historicalCommand,
      });

      const duplicateEvaluationCommand = await createCompletionCommand(
        pool,
        identities,
        historicalEvaluation.evaluationId
      );
      const duplicate = remoteInsert({
        ...baseRemote,
        id: randomUUID(),
        commandId: duplicateEvaluationCommand,
      });
      await expectRejection(
        pool,
        duplicate.statement,
        duplicate.values,
        "23505",
        "evaluation_remote_provenance_evaluation_key"
      );

      const duplicateCommandJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-duplicate-command`
      );
      const duplicateCommandEvaluation = await createEvaluationRecord(
        pool,
        identities,
        duplicateCommandJob
      );
      const duplicateCommandCandidate = remoteInsert({
        evaluationId: duplicateCommandEvaluation.evaluationId,
        evaluationVersion: duplicateCommandEvaluation.currentVersion,
        jobId: duplicateCommandJob.jobId,
        professionalParticipantId:
          duplicateCommandJob.professionalParticipantId,
        commandId: historicalCommand,
      });
      const duplicateCommandClient = await pool.connect();
      try {
        await duplicateCommandClient.query("BEGIN");
        await duplicateCommandClient.query(
          `ALTER TABLE canonical_evaluation_remote_provenance
           DISABLE TRIGGER evaluation_remote_provenance_validate_insert`
        );
        await assert.rejects(
          duplicateCommandClient.query(
            duplicateCommandCandidate.statement,
            duplicateCommandCandidate.values
          ),
          (error) =>
            error?.code === "23505" &&
            error?.constraint === "evaluation_remote_provenance_command_key"
        );
        await duplicateCommandClient.query("ROLLBACK");
      } catch (error) {
        try {
          await duplicateCommandClient.query("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        duplicateCommandClient.release();
      }
      console.log(
        "REMOTE_PROVENANCE_UNIQUENESS",
        JSON.stringify({
          duplicateEvaluationConstraint:
            "evaluation_remote_provenance_evaluation_key",
          duplicateCommandConstraint:
            "evaluation_remote_provenance_command_key",
        })
      );
      await expectRejection(
        pool,
        `UPDATE canonical_evaluation_remote_provenance
         SET assessment_basis = 'Changed after completion.'
         WHERE evaluation_id = $1`,
        [historicalEvaluation.evaluationId],
        "55000"
      );
      await expectRejection(
        pool,
        `DELETE FROM canonical_evaluation_remote_provenance
         WHERE evaluation_id = $1`,
        [historicalEvaluation.evaluationId],
        "55000"
      );
      await expectRejection(
        pool,
        `UPDATE canonical_evaluation_provenance_claims
         SET provenance_kind = 'PHYSICAL'
         WHERE evaluation_id = $1`,
        [historicalEvaluation.evaluationId],
        "55000"
      );
      await expectRejection(
        pool,
        `DELETE FROM canonical_evaluation_provenance_claims
         WHERE evaluation_id = $1`,
        [historicalEvaluation.evaluationId],
        "55000"
      );

      const physicalFirstJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-physical-first`
      );
      const physicalFirstEvaluation = await createEvaluationRecord(
        pool,
        identities,
        physicalFirstJob
      );
      const physicalFirstCommand = await createCompletionCommand(
        pool,
        identities,
        physicalFirstEvaluation.evaluationId
      );
      const physicalFirstVisit = await createCompletedVisit(
        pool,
        physicalFirstJob,
        `${suffix}:physical-first`
      );
      const physicalFirstLink = physicalLinkInsert(
        physicalFirstVisit,
        physicalFirstEvaluation,
        physicalFirstJob
      );
      await pool.query(physicalFirstLink.statement, physicalFirstLink.values);
      const remoteAfterPhysical = remoteInsert({
        evaluationId: physicalFirstEvaluation.evaluationId,
        evaluationVersion: 2,
        jobId: physicalFirstJob.jobId,
        professionalParticipantId: physicalFirstJob.professionalParticipantId,
        commandId: physicalFirstCommand,
      });
      await expectRejection(
        pool,
        remoteAfterPhysical.statement,
        remoteAfterPhysical.values,
        "23514"
      );

      const remoteFirstJob = await createVisitLifecycleFixture(
        pool,
        identities,
        `${suffix}-remote-first`
      );
      const remoteFirstEvaluation = await createEvaluationRecord(
        pool,
        identities,
        remoteFirstJob
      );
      const remoteFirstCommand = await createCompletionCommand(
        pool,
        identities,
        remoteFirstEvaluation.evaluationId
      );
      const remoteFirst = remoteInsert({
        evaluationId: remoteFirstEvaluation.evaluationId,
        evaluationVersion: 2,
        jobId: remoteFirstJob.jobId,
        professionalParticipantId: remoteFirstJob.professionalParticipantId,
        commandId: remoteFirstCommand,
      });
      await pool.query(remoteFirst.statement, remoteFirst.values);
      const remoteFirstVisit = await createCompletedVisit(
        pool,
        remoteFirstJob,
        `${suffix}:remote-first`
      );
      const physicalAfterRemote = physicalLinkInsert(
        remoteFirstVisit,
        remoteFirstEvaluation,
        remoteFirstJob
      );
      await expectRejection(
        pool,
        physicalAfterRemote.statement,
        physicalAfterRemote.values,
        "23514"
      );

      for (const isolationLevel of ["READ COMMITTED", "REPEATABLE READ"]) {
        const raceLabel = isolationLevel.toLowerCase().replaceAll(" ", "-");
        const raceJob = await createVisitLifecycleFixture(
          pool,
          identities,
          `${suffix}-race-${raceLabel}`
        );
        const raceEvaluation = await createEvaluationRecord(
          pool,
          identities,
          raceJob
        );
        const raceCommand = await createCompletionCommand(
          pool,
          identities,
          raceEvaluation.evaluationId
        );
        const raceVisit = await createCompletedVisit(
          pool,
          raceJob,
          `${suffix}:race:${raceLabel}`
        );
        const raceRemote = remoteInsert({
          evaluationId: raceEvaluation.evaluationId,
          evaluationVersion: 2,
          jobId: raceJob.jobId,
          professionalParticipantId: raceJob.professionalParticipantId,
          commandId: raceCommand,
        });
        const racePhysical = physicalLinkInsert(
          raceVisit,
          raceEvaluation,
          raceJob
        );
        const raceOutcome = await runProvenanceRace(pool, {
          isolationLevel,
          raceRemote,
          racePhysical,
          evaluationId: raceEvaluation.evaluationId,
        });
        console.log(
          isolationLevel === "READ COMMITTED"
            ? "REMOTE_PROVENANCE_READ_COMMITTED_CONCURRENCY"
            : "REMOTE_PROVENANCE_REPEATABLE_READ_CONCURRENCY",
          JSON.stringify(raceOutcome)
        );
      }

      const replay = await runMigrationCollection(
        pool,
        [migration],
        targetMetadata()
      );
      assert.equal(replay.success, true, replay.errorCode);
      assert.deepEqual(replay.applied, []);
      assert.deepEqual(replay.skipped, [migrationName]);
      const finalLedger = await pool.query(
        `SELECT count(*)::integer AS count FROM schema_migrations`
      );
      assert.equal(finalLedger.rows[0].count, 57);
      console.log(
        "REMOTE_PROVENANCE_REPLAY",
        JSON.stringify({
          applied: replay.applied,
          skipped: replay.skipped,
          ledger: finalLedger.rows[0].count,
        })
      );
    } finally {
      await pool.end();
    }
  }
);
