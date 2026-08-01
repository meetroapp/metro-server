"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AUTHORITY_SOURCE,
  OWNING_ENGINE,
  advanceCommercialAggregate,
  createCommercialAggregate,
  getCommercialAggregateEvidence,
} = require("../server/authorization/commercialAuthorityService");

const HOMEOWNER_ID = 11;
const PROFESSIONAL_ID = 22;
const OTHER_USER_ID = 33;
const ORDINARY_REQUEST_ID = 91;
const EMERGENCY_REQUEST_ID = 92;
const ORDINARY_RELATIONSHIP_ID = 71;
const EMERGENCY_RELATIONSHIP_ID = 72;

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function cloneMap(map) {
  return new Map(
    Array.from(map.entries(), ([key, value]) => [
      key,
      structuredClone(value),
    ])
  );
}

function createState() {
  return {
    aggregates: new Map(),
    evidence: [],
    idempotency: new Map(),
    relationships: new Map([
      [
        ORDINARY_RELATIONSHIP_ID,
        {
          id: ORDINARY_RELATIONSHIP_ID,
          post_id: ORDINARY_REQUEST_ID,
          emergency_request_id: null,
          homeowner_id: HOMEOWNER_ID,
          professional_user_id: PROFESSIONAL_ID,
        },
      ],
      [
        EMERGENCY_RELATIONSHIP_ID,
        {
          id: EMERGENCY_RELATIONSHIP_ID,
          post_id: null,
          emergency_request_id: EMERGENCY_REQUEST_ID,
          homeowner_id: HOMEOWNER_ID,
          professional_user_id: PROFESSIONAL_ID,
        },
      ],
    ]),
    ordinaryRequests: new Map([
      [ORDINARY_REQUEST_ID, { id: ORDINARY_REQUEST_ID, user_id: HOMEOWNER_ID }],
    ]),
    emergencyRequests: new Map([
      [
        EMERGENCY_REQUEST_ID,
        { id: EMERGENCY_REQUEST_ID, homeowner_id: HOMEOWNER_ID },
      ],
    ]),
  };
}

function stateSnapshot(state) {
  return {
    aggregates: cloneMap(state.aggregates),
    evidence: structuredClone(state.evidence),
    idempotency: cloneMap(state.idempotency),
  };
}

function restoreState(state, snapshot) {
  state.aggregates = snapshot.aggregates;
  state.evidence = snapshot.evidence;
  state.idempotency = snapshot.idempotency;
}

function idempotencyMapKey(actorUserId, commandName, commandScope, key) {
  return [actorUserId, commandName, commandScope, key].join("|");
}

function sourceRow(state, type, sourceId, relationshipId) {
  const source =
    type === "ordinary_request"
      ? state.ordinaryRequests.get(Number(sourceId))
      : state.emergencyRequests.get(Number(sourceId));
  if (!source) return null;

  const owner =
    type === "ordinary_request" ? source.user_id : source.homeowner_id;
  const relationship = state.relationships.get(Number(relationshipId));
  const matches =
    relationship &&
    ((type === "ordinary_request" &&
      relationship.post_id === Number(sourceId) &&
      relationship.emergency_request_id == null) ||
      (type === "emergency_request" &&
        relationship.emergency_request_id === Number(sourceId) &&
        relationship.post_id == null));

  return {
    source_id: Number(sourceId),
    source_owner_user_id: owner,
    relationship_id: matches ? relationship.id : null,
    relationship_homeowner_id: matches ? relationship.homeowner_id : null,
    professional_user_id: matches ? relationship.professional_user_id : null,
  };
}

function createPool({ failAt = null, transactionSnapshots = true } = {}) {
  const state = createState();
  const calls = [];
  let snapshot = null;

  const pool = {
    state,
    calls,
    async query(text, params = []) {
      const sql = normalizeSql(text);
      const placeholderNumbers = Array.from(
        sql.matchAll(/\$(\d+)/g),
        (match) => Number(match[1])
      );
      assert.ok(
        placeholderNumbers.length === 0 ||
          Math.max(...placeholderNumbers) <= params.length,
        `Missing SQL parameter for: ${sql}`
      );
      calls.push({ sql, params: structuredClone(params) });

      if (sql === "BEGIN") {
        snapshot = transactionSnapshots ? stateSnapshot(state) : null;
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
        const [id, actorUserId, commandName, commandScope, key, requestFingerprint] =
          params;
        const mapKey = idempotencyMapKey(
          actorUserId,
          commandName,
          commandScope,
          key
        );
        if (state.idempotency.has(mapKey)) return { rows: [] };
        const row = {
          id,
          actor_user_id: actorUserId,
          command_name: commandName,
          command_scope: commandScope,
          idempotency_key: key,
          request_fingerprint: requestFingerprint,
          aggregate_id: null,
          result_reference: null,
          completed_at: null,
        };
        state.idempotency.set(mapKey, row);
        return { rows: [row] };
      }

      if (
        sql.startsWith("SELECT * FROM commercial_command_idempotency")
      ) {
        const mapKey = idempotencyMapKey(...params);
        return { rows: [state.idempotency.get(mapKey)].filter(Boolean) };
      }

      if (sql.includes("FROM posts AS p")) {
        const row = sourceRow(
          state,
          "ordinary_request",
          params[0],
          params[1]
        );
        return { rows: [row].filter(Boolean) };
      }

      if (sql.includes("FROM emergency_requests AS er")) {
        const row = sourceRow(
          state,
          "emergency_request",
          params[0],
          params[1]
        );
        return { rows: [row].filter(Boolean) };
      }

      if (sql.startsWith("INSERT INTO commercial_authority_aggregates")) {
        if (failAt === "aggregate") throw new Error("private aggregate failure");
        const [
          id,
          aggregateType,
          owningEngine,
          sourceContextType,
          ordinaryRequestId,
          emergencyRequestId,
          relationshipId,
          sourceOwnerUserId,
          createdByUserId,
        ] = params;
        const row = {
          id,
          aggregate_type: aggregateType,
          owning_engine: owningEngine,
          source_context_type: sourceContextType,
          ordinary_request_id: ordinaryRequestId,
          emergency_request_id: emergencyRequestId,
          relationship_id: relationshipId,
          source_owner_user_id: sourceOwnerUserId,
          created_by_user_id: createdByUserId,
          current_version: 1,
          created_at: "2026-08-01T12:00:00.000Z",
          updated_at: "2026-08-01T12:00:00.000Z",
        };
        state.aggregates.set(id, row);
        return { rows: [row] };
      }

      if (
        sql.startsWith("SELECT a.* FROM commercial_authority_aggregates AS a")
      ) {
        const row = state.aggregates.get(params[0]);
        if (!row) return { rows: [] };
        const relationship = state.relationships.get(Number(row.relationship_id));
        const accessible =
          Number(row.source_owner_user_id) === Number(params[1]) ||
          Number(relationship?.professional_user_id) === Number(params[1]);
        return { rows: accessible ? [structuredClone(row)] : [] };
      }

      if (sql.startsWith("UPDATE commercial_authority_aggregates")) {
        const [id, resultingVersion, expectedVersion] = params;
        const row = state.aggregates.get(id);
        if (!row || Number(row.current_version) !== Number(expectedVersion)) {
          return { rows: [] };
        }
        row.current_version = resultingVersion;
        row.updated_at = "2026-08-01T12:01:00.000Z";
        return { rows: [structuredClone(row)] };
      }

      if (sql.startsWith("INSERT INTO commercial_authority_evidence")) {
        if (failAt === "evidence") throw new Error("private evidence failure");
        const creation = params.length === 15;
        const row = {
          id: params[0],
          aggregate_id: params[1],
          aggregate_type: params[2],
          owning_engine: params[3],
          evidence_type: params[4],
          actor_user_id: params[5],
          actor_role: params[6],
          relationship_id: params[7],
          previous_version: creation ? 0 : params[8],
          resulting_version: creation ? 1 : params[9],
          idempotency_id: creation ? params[8] : params[10],
          evidence_payload: JSON.parse(creation ? params[9] : params[11]),
          source_command: creation ? params[10] : params[12],
          governing_charter_id: creation ? params[11] : params[13],
          governing_program_id: creation ? params[12] : params[14],
          implementation_milestone_id: creation ? params[13] : params[15],
          certification_target: creation ? params[14] : params[16],
          occurred_at: "2026-08-01T12:00:01.000Z",
          persisted_at: "2026-08-01T12:00:02.000Z",
        };
        state.evidence.push(row);
        return { rows: [row] };
      }

      if (sql.startsWith("UPDATE commercial_command_idempotency")) {
        if (failAt === "idempotency-completion") {
          throw new Error("private idempotency failure");
        }
        const [reservationId, aggregateId, resultJson] = params;
        const row = Array.from(state.idempotency.values()).find(
          (candidate) => candidate.id === reservationId
        );
        if (!row || row.completed_at) return { rows: [] };
        row.aggregate_id = aggregateId;
        row.result_reference = JSON.parse(resultJson);
        row.completed_at = "2026-08-01T12:00:03.000Z";
        return { rows: [{ id: reservationId }] };
      }

      if (sql.startsWith("SELECT * FROM commercial_authority_evidence")) {
        const rows = state.evidence
          .filter(
            (row) =>
              row.aggregate_id === params[0] &&
              row.aggregate_type === params[1] &&
              row.owning_engine === params[2]
          )
          .sort(
            (left, right) =>
              left.resulting_version - right.resulting_version ||
              left.persisted_at.localeCompare(right.persisted_at) ||
              left.id.localeCompare(right.id)
          );
        return { rows: structuredClone(rows) };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  return pool;
}

function ordinaryCreateInput(pool, overrides = {}) {
  return {
    pool,
    authenticatedActor: { id: HOMEOWNER_ID, role: "client-ignored" },
    aggregateType: "quote",
    sourceContext: {
      type: "ordinary_request",
      requestId: ORDINARY_REQUEST_ID,
      relationshipId: ORDINARY_RELATIONSHIP_ID,
    },
    expectedVersion: 0,
    idempotencyKey: "create-ordinary-1",
    ...overrides,
  };
}

async function createOrdinaryAggregate(pool, overrides = {}) {
  return createCommercialAggregate(ordinaryCreateInput(pool, overrides));
}

test("creation derives actor, owner, engine, version, and evidence on the server", async () => {
  const pool = createPool();
  const result = await createOrdinaryAggregate(pool);

  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.authoritySource, AUTHORITY_SOURCE);
  assert.equal(result.aggregate.owningEngine, OWNING_ENGINE);
  assert.equal(result.aggregate.version, 1);
  assert.deepEqual(result.aggregate.sourceContext, {
    type: "ordinary_request",
    requestId: ORDINARY_REQUEST_ID,
    relationshipId: ORDINARY_RELATIONSHIP_ID,
  });
  assert.equal(result.evidence.actorUserId, HOMEOWNER_ID);
  assert.equal(result.evidence.actorRole, "homeowner");
  assert.equal(result.evidence.previousVersion, 0);
  assert.equal(result.evidence.resultingVersion, 1);
  assert.deepEqual(result.evidence.traceability, {
    governingCharterId: "MC-WORKFLOW-001C",
    governingProgramId: "MC-WORKFLOW-001D",
    implementationMilestoneId: "MC-WORKFLOW-002A",
    certificationTarget: "MC-WORKFLOW-002R",
  });

  const aggregate = Array.from(pool.state.aggregates.values())[0];
  assert.equal(aggregate.source_owner_user_id, HOMEOWNER_ID);
  assert.equal(aggregate.created_by_user_id, HOMEOWNER_ID);
  assert.equal(pool.calls.at(0).sql, "BEGIN");
  assert.equal(pool.calls.at(-1).sql, "COMMIT");
});

test("caller-supplied authority identities are rejected before persistence", async () => {
  const pool = createPool();
  const result = await createOrdinaryAggregate(pool, {
    actorUserId: OTHER_USER_ID,
    owner_user_id: OTHER_USER_ID,
  });

  assert.equal(result.status, 400);
  assert.equal(result.code, "COMMERCIAL_AUTHORITY_INVARIANT_VIOLATION");
  assert.equal(pool.calls.length, 0);

  for (const field of [
    "aggregateId",
    "currentVersion",
    "createdAt",
    "occurredAt",
    "idempotencyId",
    "traceability",
    "confirmed",
    "authoritySource",
  ]) {
    const fieldPool = createPool();
    const fieldResult = await createOrdinaryAggregate(fieldPool, {
      [field]: field === "aggregateId"
        ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        : "client-controlled",
    });
    assert.equal(
      fieldResult.code,
      "COMMERCIAL_AUTHORITY_INVARIANT_VIOLATION",
      field
    );
    assert.equal(fieldPool.calls.length, 0, field);
  }
});

test("ordinary and Emergency source contexts remain explicit and exact", async () => {
  const ordinaryPool = createPool();
  const ordinary = await createOrdinaryAggregate(ordinaryPool);
  assert.equal(ordinary.aggregate.sourceContext.type, "ordinary_request");

  const emergencyPool = createPool();
  const emergency = await createCommercialAggregate({
    pool: emergencyPool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    aggregateType: "evaluation",
    sourceContext: {
      type: "emergency_request",
      emergencyRequestId: EMERGENCY_REQUEST_ID,
      relationshipId: EMERGENCY_RELATIONSHIP_ID,
    },
    idempotencyKey: "create-emergency-1",
  });
  assert.equal(emergency.ok, true);
  assert.equal(emergency.aggregate.sourceContext.type, "emergency_request");
  assert.equal(emergency.evidence.actorRole, "professional");
  const emergencyAggregate = Array.from(
    emergencyPool.state.aggregates.values()
  )[0];
  assert.equal(emergencyAggregate.source_owner_user_id, HOMEOWNER_ID);
  assert.equal(emergencyAggregate.created_by_user_id, PROFESSIONAL_ID);

  const invalid = await createCommercialAggregate({
    ...ordinaryCreateInput(createPool()),
    sourceContext: {
      type: "ordinary_request",
      requestId: ORDINARY_REQUEST_ID,
      emergencyRequestId: EMERGENCY_REQUEST_ID,
    },
  });
  assert.equal(invalid.code, "INVALID_COMMERCIAL_SOURCE_CONTEXT");
});

test("project context fails closed until a canonical Project identity exists", async () => {
  const result = await createCommercialAggregate({
    ...ordinaryCreateInput(createPool()),
    sourceContext: { type: "project", projectId: "not-canonical" },
  });
  assert.equal(result.status, 400);
  assert.equal(result.code, "INVALID_COMMERCIAL_SOURCE_CONTEXT");
});

test("exact idempotent retry returns the first result without duplicate writes", async () => {
  const pool = createPool();
  const first = await createOrdinaryAggregate(pool);
  const retry = await createOrdinaryAggregate(pool);

  assert.deepEqual(retry, first);
  assert.equal(pool.state.aggregates.size, 1);
  assert.equal(pool.state.evidence.length, 1);
  assert.equal(pool.state.idempotency.size, 1);
});

test("same idempotency key with different semantic input conflicts", async () => {
  const pool = createPool();
  const first = await createOrdinaryAggregate(pool);
  assert.equal(first.ok, true);

  const conflict = await createOrdinaryAggregate(pool, {
    aggregateType: "invoice",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(pool.state.aggregates.size, 1);
  assert.equal(pool.state.evidence.length, 1);
});

test("unsupported aggregate, evidence, and source values fail before writes", async () => {
  const aggregatePool = createPool();
  const aggregate = await createOrdinaryAggregate(aggregatePool, {
    aggregateType: "arbitrary_future_type",
  });
  assert.equal(aggregate.code, "INVALID_COMMERCIAL_AGGREGATE_TYPE");
  assert.equal(aggregatePool.calls.length, 0);

  const evidencePool = createPool();
  const evidence = await createOrdinaryAggregate(evidencePool, {
    evidenceType: "free.form.event",
  });
  assert.equal(evidence.code, "INVALID_COMMERCIAL_EVIDENCE_TYPE");
  assert.equal(evidencePool.calls.length, 0);

  const sourcePool = createPool();
  const source = await createOrdinaryAggregate(sourcePool, {
    sourceContext: { type: "ordinary_request", requestId: 0 },
  });
  assert.equal(source.code, "INVALID_COMMERCIAL_SOURCE_CONTEXT");
  assert.equal(sourcePool.calls.length, 0);
});

test("version advancement is monotonic and stale expected versions fail without evidence", async () => {
  const pool = createPool();
  const created = await createOrdinaryAggregate(pool);
  const advanced = await advanceCommercialAggregate({
    pool,
    authenticatedActor: { id: PROFESSIONAL_ID },
    aggregateId: created.aggregate.id,
    expectedVersion: 1,
    idempotencyKey: "advance-1",
  });

  assert.equal(advanced.ok, true);
  assert.equal(advanced.aggregate.version, 2);
  assert.equal(advanced.evidence.previousVersion, 1);
  assert.equal(advanced.evidence.resultingVersion, 2);
  assert.equal(advanced.evidence.actorRole, "professional");

  const stale = await advanceCommercialAggregate({
    pool,
    authenticatedActor: { id: HOMEOWNER_ID },
    aggregateId: created.aggregate.id,
    expectedVersion: 1,
    idempotencyKey: "advance-stale",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "STALE_COMMERCIAL_VERSION");
  assert.equal(pool.state.evidence.length, 2);
  assert.equal(pool.state.idempotency.size, 2);
});

test("exact version-advance retry preserves the original result", async () => {
  const pool = createPool();
  const created = await createOrdinaryAggregate(pool);
  const input = {
    pool,
    authenticatedActor: { id: HOMEOWNER_ID },
    aggregateId: created.aggregate.id,
    expectedVersion: 1,
    idempotencyKey: "advance-exact-retry",
  };

  const first = await advanceCommercialAggregate(input);
  const retry = await advanceCommercialAggregate(input);
  assert.deepEqual(retry, first);
  assert.equal(pool.state.aggregates.get(created.aggregate.id).current_version, 2);
  assert.equal(pool.state.evidence.length, 2);
});

test("concurrent expected-version attempts cannot both advance", async () => {
  const pool = createPool({ transactionSnapshots: false });
  const created = await createOrdinaryAggregate(pool);
  const input = (key) => ({
    pool,
    authenticatedActor: { id: HOMEOWNER_ID },
    aggregateId: created.aggregate.id,
    expectedVersion: 1,
    idempotencyKey: key,
  });

  const results = await Promise.all([
    advanceCommercialAggregate(input("concurrent-a")),
    advanceCommercialAggregate(input("concurrent-b")),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) => result.code === "STALE_COMMERCIAL_VERSION").length,
    1
  );
  assert.equal(pool.state.aggregates.get(created.aggregate.id).current_version, 2);
  assert.equal(pool.state.evidence.length, 2);
});

test("aggregate, evidence, and idempotency roll back together on failure", async () => {
  const pool = createPool({ failAt: "evidence" });

  await assert.rejects(
    createOrdinaryAggregate(pool),
    /private evidence failure/
  );
  assert.equal(pool.state.aggregates.size, 0);
  assert.equal(pool.state.evidence.length, 0);
  assert.equal(pool.state.idempotency.size, 0);
  assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
  assert.equal(pool.calls.some((call) => call.sql === "COMMIT"), false);
});

test("evidence also rolls back when idempotency completion fails", async () => {
  const pool = createPool({ failAt: "idempotency-completion" });

  await assert.rejects(
    createOrdinaryAggregate(pool),
    /private idempotency failure/
  );
  assert.equal(pool.state.aggregates.size, 0);
  assert.equal(pool.state.evidence.length, 0);
  assert.equal(pool.state.idempotency.size, 0);
  assert.equal(pool.calls.at(-1).sql, "ROLLBACK");
});

test("missing and inaccessible aggregates share one nondisclosing contract", async () => {
  const pool = createPool();
  const created = await createOrdinaryAggregate(pool);
  const inaccessible = await getCommercialAggregateEvidence({
    pool,
    authenticatedActor: { id: OTHER_USER_ID },
    aggregateId: created.aggregate.id,
  });
  const missing = await getCommercialAggregateEvidence({
    pool,
    authenticatedActor: { id: OTHER_USER_ID },
    aggregateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });

  assert.deepEqual(inaccessible, missing);
  assert.equal(inaccessible.status, 404);
  assert.equal(inaccessible.code, "COMMERCIAL_AGGREGATE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(inaccessible), /11|22|91|private/i);
});

test("bounded internal read returns deterministic append-only evidence only", async () => {
  const pool = createPool();
  const created = await createOrdinaryAggregate(pool);
  await advanceCommercialAggregate({
    pool,
    authenticatedActor: { id: HOMEOWNER_ID },
    aggregateId: created.aggregate.id,
    expectedVersion: 1,
    idempotencyKey: "read-order-advance",
  });

  pool.state.evidence.reverse();
  const result = await getCommercialAggregateEvidence({
    pool,
    authenticatedActor: { id: HOMEOWNER_ID },
    aggregateId: created.aggregate.id,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.evidence.map((item) => item.resultingVersion),
    [1, 2]
  );
  assert.equal(
    pool.calls.some((call) => /workflow_events/i.test(call.sql)),
    false
  );
  assert.equal(
    pool.calls.some((call) => /UPDATE commercial_authority_evidence/i.test(call.sql)),
    false
  );
});
