"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  completeEvaluation,
  createEvaluation,
  getEvaluation,
  listEvaluationsForEmergencyRequest,
  reviseEvaluation,
  updateEvaluationDraft,
  validateEvaluationContent,
} = require("../server/authorization/evaluationService");

const PROFESSIONAL_ID = 22;
const OTHER_PROFESSIONAL_ID = 33;
const HOMEOWNER_ID = 11;
const EMERGENCY_REQUEST_ID = 92;
const RELATIONSHIP_ID = 72;
const NOW = "2026-08-01T12:00:00.000Z";

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function baseContent(overrides = {}) {
  return {
    serviceType: "plumbing_repair",
    evaluationContext: "emergency_request",
    templateKey: "plumbing_repair_emergency",
    observations: "Water is escaping from the supply connection.",
    measurements: [{ label: "Supply pressure", value: "62", unit: "psi", notes: "Static" }],
    findings: [{ summary: "Connection seal failed.", severity: "high", customerShareable: true }],
    diagnosisSummary: "Failed connection seal.",
    limitations: "Wall cavity not opened.",
    scopeRecommendations: ["Replace the failed seal and pressure test."],
    relevantConditions: ["Water supply isolated before inspection."],
    supportingMediaReferences: [],
    internalNotes: "Confirm replacement fitting stock before return.",
    ...overrides,
  };
}

function commandInput(overrides = {}) {
  return {
    authenticatedActor: { id: PROFESSIONAL_ID },
    sourceContext: {
      type: "emergency_request",
      emergencyRequestId: EMERGENCY_REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    },
    expectedVersion: 0,
    idempotencyKey: "evaluation-create-1",
    content: baseContent(),
    ...overrides,
  };
}

function cloneState(state) {
  return structuredClone(state);
}

function restoreState(state, snapshot) {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, structuredClone(snapshot));
}

function idempotencyKey(actor, command, scope, key) {
  return `${actor}|${command}|${scope}|${key}`;
}

function createPool({
  arrived = true,
  relationshipStatus = "active",
  emergencyStatus = "professional_arrived",
  failAt = "",
} = {}) {
  const state = {
    aggregates: {},
    evaluations: {},
    versions: {},
    evidence: [],
    idempotency: {},
    context: {
      emergency_request_id: EMERGENCY_REQUEST_ID,
      homeowner_id: HOMEOWNER_ID,
      emergency_status: emergencyStatus,
      arrived_at: arrived ? NOW : null,
      relationship_id: RELATIONSHIP_ID,
      relationship_status: relationshipStatus,
      professional_user_id: PROFESSIONAL_ID,
    },
    unrelatedWrites: 0,
  };
  const calls = [];
  let snapshot = null;

  function currentRow(evaluationId) {
    const aggregate = state.aggregates[evaluationId];
    const evaluation = state.evaluations[evaluationId];
    const version = state.versions[`${evaluationId}:${aggregate?.current_version}`];
    if (!aggregate || !evaluation || !version) return null;
    return {
      evaluation_id: evaluationId,
      current_version: aggregate.current_version,
      emergency_request_id: aggregate.emergency_request_id,
      relationship_id: aggregate.relationship_id,
      evaluation_status: evaluation.status,
      evaluation_created_at: evaluation.created_at,
      evaluation_updated_at: evaluation.updated_at,
      completed_at: evaluation.completed_at,
      ...version,
    };
  }

  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params: structuredClone(params) });
      if (sql === "BEGIN") {
        snapshot = cloneState(state);
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        snapshot = null;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (snapshot) restoreState(state, snapshot);
        snapshot = null;
        return { rows: [] };
      }

      if (sql.startsWith("INSERT INTO commercial_command_idempotency")) {
        const [id, actor, command, scope, key, requestFingerprint] = params;
        const mapKey = idempotencyKey(actor, command, scope, key);
        if (state.idempotency[mapKey]) return { rows: [] };
        const row = {
          id,
          actor_user_id: actor,
          command_name: command,
          command_scope: scope,
          idempotency_key: key,
          request_fingerprint: requestFingerprint,
          aggregate_id: null,
          result_reference: null,
          completed_at: null,
        };
        state.idempotency[mapKey] = row;
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT * FROM commercial_command_idempotency")) {
        return { rows: [state.idempotency[idempotencyKey(...params)]].filter(Boolean) };
      }
      if (sql.startsWith("UPDATE commercial_command_idempotency")) {
        if (failAt === "idempotency") return { rows: [] };
        const row = Object.values(state.idempotency).find((item) => item.id === params[0]);
        if (!row || row.completed_at) return { rows: [] };
        row.aggregate_id = params[1];
        row.result_reference = JSON.parse(params[2]);
        row.completed_at = NOW;
        return { rows: [{ id: row.id }] };
      }

      if (sql.includes("FROM emergency_requests AS er") && sql.includes("FOR UPDATE OF er, rr")) {
        const matches =
          Number(params[0]) === EMERGENCY_REQUEST_ID &&
          (params[1] == null || Number(params[1]) === RELATIONSHIP_ID) &&
          Number(params[2]) === PROFESSIONAL_ID &&
          state.context.relationship_status === "active" &&
          state.context.arrived_at &&
          params[3].includes(state.context.emergency_status);
        return { rows: matches ? [structuredClone(state.context)] : [] };
      }
      if (sql.startsWith("SELECT id FROM canonical_evaluations")) {
        const row = Object.values(state.evaluations).find(
          (item) => item.relationship_id === params[0] && item.professional_user_id === params[1]
        );
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (sql.startsWith("INSERT INTO commercial_authority_aggregates")) {
        const [id, owningEngine, emergencyId, relationshipId, homeownerId, actorId] = params;
        const row = {
          id,
          aggregate_type: "evaluation",
          owning_engine: owningEngine,
          source_context_type: "emergency_request",
          emergency_request_id: emergencyId,
          relationship_id: relationshipId,
          source_owner_user_id: homeownerId,
          created_by_user_id: actorId,
          current_version: 1,
          created_at: NOW,
          updated_at: NOW,
        };
        state.aggregates[id] = row;
        return { rows: [structuredClone(row)] };
      }
      if (sql.startsWith("INSERT INTO canonical_evaluations")) {
        const [id, relationshipId, professionalId] = params;
        const row = {
          id,
          relationship_id: relationshipId,
          professional_user_id: professionalId,
          status: "draft",
          created_at: NOW,
          updated_at: NOW,
          completed_at: null,
        };
        state.evaluations[id] = row;
        return { rows: [structuredClone(row)] };
      }
      if (sql.startsWith("INSERT INTO canonical_evaluation_versions")) {
        const [
          evaluationId, version, status, serviceType, evaluationContext,
          templateKey, observations, measurements, findings, diagnosisSummary,
          limitations, scopeRecommendations, relevantConditions, media,
          internalNotes, actorId,
        ] = params;
        const row = {
          evaluation_id: evaluationId,
          version,
          status,
          service_type: serviceType,
          evaluation_context: evaluationContext,
          template_key: templateKey,
          observations,
          measurements: JSON.parse(measurements),
          findings: JSON.parse(findings),
          diagnosis_summary: diagnosisSummary,
          limitations,
          scope_recommendations: JSON.parse(scopeRecommendations),
          relevant_conditions: JSON.parse(relevantConditions),
          supporting_media_references: JSON.parse(media),
          internal_notes: internalNotes,
          created_by_user_id: actorId,
          created_at: NOW,
        };
        state.versions[`${evaluationId}:${version}`] = row;
        return { rows: [structuredClone(row)] };
      }
      if (sql.startsWith("INSERT INTO commercial_authority_evidence")) {
        if (failAt === "evidence") throw new Error("private evidence failure");
        state.evidence.push({
          id: params[0],
          aggregate_id: params[1],
          evidence_type: params[3],
          actor_user_id: params[4],
          relationship_id: params[5],
          previous_version: params[6],
          resulting_version: params[7],
          payload: JSON.parse(params[9]),
          source_command: params[10],
          capability_milestone_id: params[14],
        });
        return { rows: [{ id: params[0] }] };
      }
      if (sql.includes("FROM commercial_authority_aggregates AS a") && sql.includes("WHERE a.id = $1")) {
        const row = currentRow(params[0]);
        const evaluation = state.evaluations[params[0]];
        return {
          rows:
            row && evaluation.professional_user_id === params[1]
              ? [structuredClone(row)]
              : [],
        };
      }
      if (sql.startsWith("UPDATE commercial_authority_aggregates")) {
        const aggregate = state.aggregates[params[0]];
        if (!aggregate || aggregate.current_version !== params[2]) return { rows: [] };
        aggregate.current_version = params[1];
        aggregate.updated_at = NOW;
        return { rows: [structuredClone(aggregate)] };
      }
      if (sql.startsWith("UPDATE canonical_evaluations")) {
        const evaluation = state.evaluations[params[0]];
        const requiredStatus = sql.includes("AND status = 'completed'")
          ? "completed"
          : "draft";
        if (
          !evaluation ||
          evaluation.professional_user_id !== params[1] ||
          evaluation.status !== requiredStatus
        ) {
          return { rows: [] };
        }
        if (sql.includes("status = 'completed'")) {
          evaluation.status = "completed";
          evaluation.completed_at = NOW;
        }
        evaluation.updated_at = NOW;
        return { rows: [structuredClone(evaluation)] };
      }
      if (sql.includes("a.emergency_request_id = $1") && sql.includes("ORDER BY ce.updated_at DESC")) {
        const rows = Object.keys(state.evaluations)
          .map(currentRow)
          .filter(
            (row) =>
              row.emergency_request_id === params[0] &&
              state.evaluations[row.evaluation_id].professional_user_id === params[1]
          );
        return { rows: structuredClone(rows) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  return {
    state,
    calls,
    pool: {
      async connect() { return client; },
      async query(text, params) { return client.query(text, params); },
    },
  };
}

async function createConfirmed(pool, overrides = {}) {
  return createEvaluation(commandInput({ pool, ...overrides }));
}

test("bounded Evaluation content rejects unsupported authority and media fields", () => {
  assert.equal(validateEvaluationContent(baseContent()).content.observations.length > 0, true);
  assert.equal(validateEvaluationContent({ ...baseContent(), price: 500 }).error.code, "INVALID_EVALUATION_CONTENT");
  assert.equal(validateEvaluationContent({ ...baseContent(), supportingMediaReferences: [{ id: "browser-photo" }] }).error.code, "EVALUATION_MEDIA_UNSUPPORTED");
});

test("caller-owned actor, owner, status, version, and timestamp fields are rejected", async () => {
  for (const field of [
    "actorUserId",
    "ownerUserId",
    "professionalUserId",
    "status",
    "currentVersion",
    "createdAt",
  ]) {
    const fixture = createPool();
    const result = await createConfirmed(fixture.pool, { [field]: 999 });
    assert.equal(result.code, "EVALUATION_AUTHORITY_FIELD_REJECTED");
    assert.equal(fixture.calls.length, 0);
  }
});

test("authenticated selected Emergency professional creates server-owned version 1 atomically", async () => {
  const fixture = createPool();
  const result = await createConfirmed(fixture.pool);
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.match(result.evaluation.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.aggregate.version, 1);
  assert.equal(result.aggregate.type, "evaluation");
  assert.equal(result.aggregate.owningEngine, "authorization_engine");
  assert.equal(result.evaluation.status, "draft");
  assert.equal(result.evidence.type, "evaluation_created");
  assert.equal(fixture.state.evidence[0].actor_user_id, PROFESSIONAL_ID);
  assert.equal(fixture.state.evidence[0].capability_milestone_id, "MC-WORKFLOW-002B");
  assert.doesNotMatch(JSON.stringify(fixture.state.evidence[0].payload), /Water|seal|fitting/i);
  assert.equal(fixture.calls.at(-1).sql, "COMMIT");
  assert.equal(fixture.state.unrelatedWrites, 0);
});

test("Emergency creation derives the unique active relationship when the client does not know its ID", async () => {
  const fixture = createPool();
  const result = await createConfirmed(fixture.pool, {
    sourceContext: {
      type: "emergency_request",
      emergencyRequestId: EMERGENCY_REQUEST_ID,
      relationshipId: null,
    },
    idempotencyKey: "evaluation-derived-relationship",
  });
  assert.equal(result.ok, true);
  assert.equal(result.aggregate.sourceContext.relationshipId, RELATIONSHIP_ID);
  assert.equal(fixture.state.aggregates[result.evaluation.id].relationship_id, RELATIONSHIP_ID);
});

test("ordinary context fails closed without selecting relationship semantics", async () => {
  const fixture = createPool();
  const result = await createConfirmed(fixture.pool, {
    sourceContext: { type: "ordinary_request", requestId: 10, relationshipId: 20 },
  });
  assert.equal(result.code, "ORDINARY_EVALUATION_AUTHORITY_UNAVAILABLE");
  assert.equal(fixture.calls.length, 0);
});

test("pre-arrival, inactive, and cross-professional Emergency contexts share unavailable behavior", async () => {
  for (const options of [{ arrived: false }, { relationshipStatus: "pending" }]) {
    const fixture = createPool(options);
    const result = await createConfirmed(fixture.pool);
    assert.equal(result.status, 404);
    assert.equal(result.code, "EVALUATION_UNAVAILABLE");
    assert.deepEqual(fixture.state.aggregates, {});
  }
  const fixture = createPool();
  const result = await createConfirmed(fixture.pool, {
    authenticatedActor: { id: OTHER_PROFESSIONAL_ID },
  });
  assert.equal(result.code, "EVALUATION_UNAVAILABLE");
  const homeowner = await createConfirmed(fixture.pool, {
    authenticatedActor: { id: HOMEOWNER_ID },
    idempotencyKey: "homeowner-create-denied",
  });
  assert.equal(homeowner.code, "EVALUATION_UNAVAILABLE");
});

test("exact idempotent create retry replays while semantic reuse conflicts", async () => {
  const fixture = createPool();
  const first = await createConfirmed(fixture.pool);
  const replay = await createConfirmed(fixture.pool);
  assert.equal(replay.replayed, true);
  assert.equal(replay.evaluation.id, first.evaluation.id);
  assert.equal(Object.keys(fixture.state.evaluations).length, 1);

  const conflict = await createConfirmed(fixture.pool, {
    content: baseContent({ observations: "Different observations." }),
  });
  assert.equal(conflict.code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
});

test("draft updates require expected version and stale writes cannot both succeed", async () => {
  const fixture = createPool();
  const created = await createConfirmed(fixture.pool);
  const missing = await updateEvaluationDraft({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    idempotencyKey: "update-missing-version",
    content: baseContent(),
  });
  assert.equal(missing.code, "EVALUATION_EXPECTED_VERSION_REQUIRED");

  const updated = await updateEvaluationDraft({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 1,
    idempotencyKey: "update-version-1",
    content: baseContent({ observations: "Updated authoritative observations." }),
  });
  assert.equal(updated.aggregate.version, 2);
  assert.equal(updated.evaluation.content.observations, "Updated authoritative observations.");
  const replay = await updateEvaluationDraft({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 1,
    idempotencyKey: "update-version-1",
    content: baseContent({ observations: "Updated authoritative observations." }),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.aggregate.version, 2);

  const stale = await updateEvaluationDraft({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 1,
    idempotencyKey: "concurrent-stale-update",
    content: baseContent({ observations: "Losing concurrent update." }),
  });
  assert.equal(stale.code, "STALE_EVALUATION_VERSION");
  assert.equal(fixture.state.aggregates[created.evaluation.id].current_version, 2);
});

test("completion validates required content and preserves an immutable completed version", async () => {
  const incompleteFixture = createPool();
  const incomplete = await createConfirmed(incompleteFixture.pool, {
    content: baseContent({ observations: "", findings: [], scopeRecommendations: [] }),
  });
  const rejected = await completeEvaluation({
    pool: incompleteFixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: incomplete.evaluation.id,
    expectedVersion: 1,
    idempotencyKey: "complete-incomplete",
  });
  assert.equal(rejected.code, "EVALUATION_INCOMPLETE");
  assert.equal(incompleteFixture.state.aggregates[incomplete.evaluation.id].current_version, 1);

  const fixture = createPool();
  const created = await createConfirmed(fixture.pool);
  const completed = await completeEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 1,
    idempotencyKey: "complete-version-1",
  });
  assert.equal(completed.evaluation.status, "completed");
  assert.equal(completed.aggregate.version, 2);
  assert.equal(completed.evaluation.capabilities.quoteReady, false);
  assert.equal(completed.evaluation.capabilities.authorizationAvailable, false);
  assert.equal(completed.evidence.type, "evaluation_completed");
  const completionReplay = await completeEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 1,
    idempotencyKey: "complete-version-1",
  });
  assert.equal(completionReplay.replayed, true);
  assert.equal(completionReplay.aggregate.version, 2);

  assert.equal(completed.evaluation.capabilities.canEditDraft, false);
  assert.equal(completed.evaluation.capabilities.canRevise, true);

  const draftEdit = await updateEvaluationDraft({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 2,
    idempotencyKey: "edit-completed",
    content: baseContent(),
  });
  assert.equal(draftEdit.code, "EVALUATION_COMPLETED");

  const completedAt = completed.evaluation.completedAt;
  const revised = await reviseEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 2,
    idempotencyKey: "revise-completed-version-2",
    content: baseContent({
      observations:
        "Customer added another condition before the Quote was prepared.",
    }),
  });

  assert.equal(revised.ok, true);
  assert.equal(revised.code, "EVALUATION_REVISED");
  assert.equal(revised.aggregate.version, 3);
  assert.equal(revised.evaluation.status, "completed");
  assert.equal(revised.evaluation.completedAt, completedAt);
  assert.equal(revised.evaluation.capabilities.canEditDraft, false);
  assert.equal(revised.evaluation.capabilities.canRevise, true);
  assert.equal(revised.evidence.type, "evaluation_revised");
  assert.equal(
    fixture.state.evidence.at(-1).source_command,
    "evaluation.revise"
  );
  assert.equal(
    fixture.state.versions[`${created.evaluation.id}:2`].status,
    "completed"
  );
  assert.equal(
    fixture.state.versions[`${created.evaluation.id}:2`].observations,
    baseContent().observations
  );
  assert.equal(
    fixture.state.versions[`${created.evaluation.id}:3`].status,
    "completed"
  );
  assert.equal(
    fixture.state.versions[`${created.evaluation.id}:3`].observations,
    "Customer added another condition before the Quote was prepared."
  );

  const revisionReplay = await reviseEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 2,
    idempotencyKey: "revise-completed-version-2",
    content: baseContent({
      observations:
        "Customer added another condition before the Quote was prepared.",
    }),
  });
  assert.equal(revisionReplay.replayed, true);
  assert.equal(revisionReplay.aggregate.version, 3);

  const staleRevision = await reviseEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 2,
    idempotencyKey: "stale-revision-version-2",
    content: baseContent({
      observations: "Stale revision should not overwrite version 3.",
    }),
  });
  assert.equal(staleRevision.code, "STALE_EVALUATION_VERSION");
  assert.equal(
    fixture.state.aggregates[created.evaluation.id].current_version,
    3
  );
});

test("failed evidence and idempotency completion roll back the aggregate, version, and command together", async () => {
  for (const failAt of ["evidence", "idempotency"]) {
    const fixture = createPool({ failAt });
    await assert.rejects(() => createConfirmed(fixture.pool), /failure|completion/i);
    assert.deepEqual(fixture.state.aggregates, {});
    assert.deepEqual(fixture.state.evaluations, {});
    assert.deepEqual(fixture.state.versions, {});
    assert.deepEqual(fixture.state.evidence, []);
    assert.deepEqual(fixture.state.idempotency, {});
    assert.equal(fixture.calls.at(-1).sql, "ROLLBACK");
  }
});

test("professional reads reconstruct current backend truth and cross-account access does not disclose notes", async () => {
  const fixture = createPool();
  const created = await createConfirmed(fixture.pool);
  const found = await getEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
  });
  assert.equal(found.evaluation.content.internalNotes, baseContent().internalNotes);

  const unavailable = await getEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: OTHER_PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
  });
  assert.deepEqual(unavailable, {
    ok: false,
    status: 404,
    code: "EVALUATION_UNAVAILABLE",
    message: "The Evaluation is unavailable.",
  });
  assert.doesNotMatch(JSON.stringify(unavailable), /stock|seal|water/i);

  const list = await listEvaluationsForEmergencyRequest({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    emergencyRequestId: EMERGENCY_REQUEST_ID,
  });
  assert.equal(list.evaluations.length, 1);
  const otherList = await listEvaluationsForEmergencyRequest({
    pool: fixture.pool,
    authenticatedActor: { id: OTHER_PROFESSIONAL_ID },
    emergencyRequestId: EMERGENCY_REQUEST_ID,
  });
  assert.deepEqual(otherList.evaluations, []);
});

test("service SQL never mutates Workflow, Emergency, relationships, Quote, or Authorization", async () => {
  const fixture = createPool();
  const created = await createConfirmed(fixture.pool);
  await completeEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 1,
    idempotencyKey: "complete-boundary-check",
  });
  await reviseEvaluation({
    pool: fixture.pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    evaluationId: created.evaluation.id,
    expectedVersion: 2,
    idempotencyKey: "revise-boundary-check",
    content: baseContent({
      observations: "Revised documentation only.",
    }),
  });
  const sql = fixture.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM) (?:emergency_requests|request_relationships|workflow_events|quote|authorization)/i);
});
