"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  canonicalIntelligenceEngineRegistry,
} = require("../server/intelligence/intelligenceEngineRegistry");
const {
  canonicalIntelligenceOperationRegistry,
} = require("../server/intelligence/intelligenceOperationRegistry");
const {
  INTELLIGENCE_COMPANION_ROUTE,
  registerIntelligenceRoutes,
} = require("../server/intelligence/intelligenceRoutes");
const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const databaseUrl = process.env.INTELLIGENCE_GATEWAY_DATABASE_URL;

function response() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    headers: new Map(),
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.finished = true; return this; },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
  };
}

async function runHandlers(handlers, req, res) {
  for (const handler of handlers) {
    if (res.finished) break;
    if (handler.length < 3) {
      await handler(req, res);
      continue;
    }
    await new Promise((resolve, reject) => {
      const next = (error) => error ? reject(error) : resolve();
      Promise.resolve(handler(req, res, next)).then(
        () => { if (res.finished) resolve(); },
        reject
      );
    });
  }
}

test(
  "PostgreSQL certifies job_request.interpret route, replay, conflict, and concurrent ownership",
  { skip: !databaseUrl },
  async () => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const email = `intelligence-gateway-${randomUUID()}@example.test`;
    let actorUserId;

    try {
      const user = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ($1, $2, $3, 'homeowner', 'homeowner')
        RETURNING id
        `,
        ["intelligence-gateway-certification", email, "test-only-hash"]
      );
      actorUserId = user.rows[0].id;

      let providerCalls = 0;
      let usageCalls = 0;
      let releaseProvider;
      let markProviderStarted;
      const providerStarted = new Promise((resolve) => {
        markProviderStarted = resolve;
      });
      const providerGate = new Promise((resolve) => {
        releaseProvider = resolve;
      });
      const providers = {
        job_request: {
          async complete() {
            providerCalls += 1;
            markProviderStarted();
            await providerGate;
            return {
              schemaVersion: 1,
              summary: "The sink cabinet may have water damage from a plumbing leak.",
              draftPatch: {
                fields: [{
                  path: "job.title",
                  value: "Repair water-damaged sink cabinet",
                  provenance: "assistant_suggested",
                  confidence: 0.84,
                  uncertainty: "assistant_suggested",
                  requiresConfirmation: true,
                }],
              },
              clarifications: [{
                question: "Has the leak already been repaired?",
                fieldPath: "details.additionalNotes",
              }],
              warnings: [],
            };
          },
        },
      };
      const registrations = [];
      registerIntelligenceRoutes({
        app: {
          post(path, ...handlers) {
            registrations.push({ path, handlers });
          },
        },
        authMiddleware(req, _res, next) {
          req.user = { id: actorUserId, role: "homeowner" };
          next();
        },
        getPool: () => pool,
        operationRegistry: canonicalIntelligenceOperationRegistry,
        engineRegistry: canonicalIntelligenceEngineRegistry,
        providers,
        usageFinalizer: async () => {
          usageCalls += 1;
          return { ok: true, classification: "test_recorded" };
        },
      });
      assert.equal(registrations[0].path, INTELLIGENCE_COMPANION_ROUTE);

      const idempotencyKey = randomUUID();
      const request = (text = "The cabinet under my sink is swollen from a leak.") => ({
        headers: { "idempotency-key": idempotencyKey },
        body: {
          operation: "job_request.interpret",
          capability: "job_request.interpret",
          locale: "en-US",
          context: {
            draft: {
              version: 1,
              job: { title: "", description: "" },
              service: {
                category: "",
                requestCategory: "",
                domain: "",
                specialty: "",
              },
              location: { affectedArea: "kitchen" },
              timing: { urgency: "", desiredTiming: "", availability: "" },
              details: { measurements: "", expectations: "", additionalNotes: "" },
              fieldState: [],
              photosAttached: false,
            },
          },
          input: { text },
        },
      });
      const invoke = async (req) => {
        const res = response();
        await runHandlers(registrations[0].handlers, req, res);
        return res;
      };

      const owner = invoke(request());
      await providerStarted;
      const duplicate = await invoke(request());
      releaseProvider();
      const completed = await owner;
      const replay = await invoke(request());
      const conflict = await invoke(request("Water is now actively leaking."));

      assert.equal(duplicate.body.code, "INTELLIGENCE_OPERATION_IN_PROGRESS");
      assert.equal(completed.body.code, "INTELLIGENCE_OPERATION_COMPLETED");
      assert.equal(replay.body.code, "INTELLIGENCE_OPERATION_REPLAYED");
      assert.equal(conflict.body.code, "INTELLIGENCE_OPERATION_CONFLICT");
      assert.equal(providerCalls, 1);
      assert.equal(usageCalls, 1);
      assert.equal(completed.body.operation, "job_request.interpret");
      assert.equal(
        completed.body.result.draftPatch.fields[0].value,
        "Repair water-damaged sink cabinet"
      );
      assert.equal(completed.body.result.validation.status, "accepted");
      assert.deepEqual(replay.body.result, completed.body.result);
      assert.deepEqual(replay.body.usage, {
        state: "finalized",
        classification: "test_recorded",
      });

      const persisted = await pool.query(
        `
        SELECT *
        FROM intelligence_operation_idempotency
        WHERE id = $1
        `,
        [completed.body.operationId]
      );
      const row = persisted.rows[0];
      assert.equal(row.actor_user_id, actorUserId);
      assert.equal(row.authority_scope, `user:${actorUserId}`);
      assert.equal(row.operation, "job_request.interpret");
      assert.equal(row.status, "completed");
      assert.equal(row.provider_execution_state, "succeeded");
      assert.equal(row.usage_state, "finalized");
      assert.equal(row.usage_classification, "test_recorded");
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
