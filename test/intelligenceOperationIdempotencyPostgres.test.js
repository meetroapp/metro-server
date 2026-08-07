"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  executeIdempotentIntelligenceOperation,
} = require("../server/intelligence/intelligenceOperationIdempotencyService");
const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const databaseUrl = process.env.INTELLIGENCE_IDEMPOTENCY_DATABASE_URL;

test(
  "local PostgreSQL certifies durable replay, conflict, constraints, and concurrent ownership",
  { skip: !databaseUrl },
  async () => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const email = `intelligence-idempotency-${randomUUID()}@example.test`;
    let actorUserId;

    try {
      const user = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ($1, $2, $3, 'homeowner', 'homeowner')
        RETURNING id
        `,
        ["intelligence-certification", email, "test-only-hash"]
      );
      actorUserId = user.rows[0].id;

      const idempotencyKey = randomUUID();
      let providerCalls = 0;
      let usageCalls = 0;
      let releaseProvider;
      let signalProviderStarted;
      const providerStarted = new Promise((resolve) => {
        signalProviderStarted = resolve;
      });
      const providerGate = new Promise((resolve) => {
        releaseProvider = resolve;
      });
      const operation = {
        pool,
        authenticatedActor: { id: actorUserId },
        operation: "intelligence.certification",
        idempotencyKey,
        semanticInput: {
          locale: "en",
          structuredContext: { topic: "local-certification" },
          authorization: "not-persisted",
        },
        executeProvider: async () => {
          providerCalls += 1;
          signalProviderStarted();
          await providerGate;
          return { answer: "Bounded normalized certification result" };
        },
        finalizeUsage: async () => {
          usageCalls += 1;
          return { ok: true, classification: "test_recorded" };
        },
      };

      const owner = executeIdempotentIntelligenceOperation(operation);
      await providerStarted;
      const duplicate = await executeIdempotentIntelligenceOperation(operation);
      releaseProvider();
      const completed = await owner;
      const replay = await executeIdempotentIntelligenceOperation(operation);
      const conflict = await executeIdempotentIntelligenceOperation({
        ...operation,
        semanticInput: { locale: "es", structuredContext: { topic: "changed" } },
      });

      assert.equal(duplicate.code, "INTELLIGENCE_OPERATION_IN_PROGRESS");
      assert.equal(completed.code, "INTELLIGENCE_OPERATION_COMPLETED");
      assert.equal(replay.code, "INTELLIGENCE_OPERATION_REPLAYED");
      assert.equal(conflict.code, "INTELLIGENCE_OPERATION_CONFLICT");
      assert.equal(providerCalls, 1);
      assert.equal(usageCalls, 1);
      assert.equal(replay.operationId, completed.operationId);
      assert.deepEqual(replay.result, completed.result);

      const persisted = await pool.query(
        `
        SELECT *
        FROM intelligence_operation_idempotency
        WHERE id = $1
        `,
        [completed.operationId]
      );
      const row = persisted.rows[0];
      assert.equal(row.actor_user_id, actorUserId);
      assert.equal(row.authority_scope, `user:${actorUserId}`);
      assert.equal(row.status, "completed");
      assert.equal(row.provider_execution_state, "succeeded");
      assert.equal(row.usage_state, "finalized");
      assert.equal(row.usage_classification, "test_recorded");
      assert.ok(row.started_at);
      assert.ok(row.completed_at);
      assert.equal(row.failed_at, null);
      assert.equal(JSON.stringify(row).includes("not-persisted"), false);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await assert.rejects(
          client.query(
            `
            UPDATE intelligence_operation_idempotency
            SET status = 'invalid-status'
            WHERE id = $1
            `,
            [completed.operationId]
          ),
          /check constraint/i
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      const afterRollback = await pool.query(
        "SELECT status FROM intelligence_operation_idempotency WHERE id = $1",
        [completed.operationId]
      );
      assert.equal(afterRollback.rows[0].status, "completed");
    } finally {
      if (actorUserId) {
        await pool.query(
          "DELETE FROM intelligence_operation_idempotency WHERE actor_user_id = $1",
          [actorUserId]
        );
        await pool.query("DELETE FROM users WHERE id = $1", [actorUserId]);
      }
      await pool.end();
    }
  }
);
