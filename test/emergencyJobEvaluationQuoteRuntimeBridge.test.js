"use strict";

const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const test =
  require("node:test");

const quoteService =
  require(
    "../server/authorization/quoteDraftService"
  );

const evaluation =
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "authorization",
      "evaluationService.js"
    ),
    "utf8"
  );

const quote =
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "authorization",
      "quoteDraftService.js"
    ),
    "utf8"
  );

const foundation =
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "emergency",
      "emergencyJobFoundationService.js"
    ),
    "utf8"
  );

const JOB_ID =
  "11111111-1111-4111-8111-111111111111";

const PARTICIPANT_ID =
  "22222222-2222-4222-8222-222222222222";

test(
  "Emergency Job grants professional Evaluation and Quote preparation without Work, payment, or customer decision authority",
  () => {
    for (const capability of [
      "evaluation.perform",
      "quote.create",
      "quote.read",
      "quote.scope.manage",
      "quote.issue",
    ]) {
      assert.match(
        foundation,
        new RegExp(
          capability.replace(
            ".",
            "\\."
          )
        )
      );
    }

    for (const forbidden of [
      "work_activity.create",
      "approved_work",
      "invoice",
      "payment",
      "deposit",
      "quote.approve",
      "quote.decline",
    ]) {
      assert.doesNotMatch(
        foundation,
        new RegExp(
          forbidden,
          "i"
        )
      );
    }
  }
);

test(
  "Emergency Evaluation is Job-bound internally while public Evaluation source remains emergency_request",
  () => {
    assert.match(
      evaluation,
      /INSERT INTO canonical_evaluation_job_subjects/
    );

    assert.match(
      evaluation,
      /source_evidence_type =\s*'emergency_selection'/
    );

    assert.match(
      evaluation,
      /jobs\.source_emergency_request_id/
    );

    assert.match(
      evaluation,
      /jobs\.source_request_relationship_id/
    );

    assert.doesNotMatch(
      evaluation,
      /type:\s*"emergency_job"/
    );

    assert.match(
      evaluation,
      /type:\s*"emergency_request"/
    );
  }
);

test(
  "Emergency onsite Evaluation completion remains governed by confirmed dispatch arrival",
  () => {
    assert.match(
      evaluation,
      /context\.job_source_type ===\s*"emergency_request"/
    );

    assert.match(
      evaluation,
      /Emergency onsite Evaluation completion is governed by confirmed arrival/
    );

    assert.match(
      evaluation,
      /emergency_requests\.arrived_at/
    );
  }
);

test(
  "Emergency Draft Quote uses a separate gate without changing the existing shared gate contract",
  () => {
    const createStart =
      quote.indexOf(
        "async function createDraftQuote"
      );

    const createEnd =
      quote.indexOf(
        "async function addDraftScopeItem",
        createStart
      );

    const createBlock =
      quote.slice(
        createStart,
        createEnd
      );

    assert.match(
      createBlock,
      /requireEmergencyJobEvaluation/
    );

    assert.doesNotMatch(
      createBlock,
      /requireSavedEvaluation/
    );

    assert.ok(
      createBlock.indexOf(
        "requireEmergencyJobEvaluation"
      ) <
      createBlock.indexOf(
        "reserveIdempotency"
      )
    );
  }
);

test(
  "Emergency Evaluation gate binds exact completed Evaluation, Job, relationship, request, participant and arrival",
  async () => {
    const calls = [];

    const context = {
      job_id:
        JOB_ID,
      job_source_type:
        "emergency_request",
      source_context_type:
        "emergency_request",
      job_request_id:
        null,
      relationship_id:
        151,
      actor_user_id:
        9,
      actor_participant_id:
        PARTICIPANT_ID,
      job_emergency_request_id:
        41,
      business_customer_job_source_id:
        null,
      job_business_customer_job_source_id:
        null,
    };

    const allowed =
      await quoteService
        .quoteDraftServiceInternals
        .requireEmergencyJobEvaluation({
          client: {
            async query(
              sql,
              values
            ) {
              calls.push({
                sql,
                values,
              });

              return {
                rows: [
                  {
                    id:
                      "33333333-3333-4333-8333-333333333333",
                    status:
                      "completed",
                    evaluation_version:
                      2,
                  },
                ],
              };
            },
          },

          context,

          logger: {
            warn() {},
          },
        });

    assert.equal(
      allowed,
      null
    );

    assert.equal(
      calls.length,
      1
    );

    assert.deepEqual(
      calls[0].values,
      [
        JOB_ID,
        9,
        PARTICIPANT_ID,
        151,
        41,
        "authorization_engine",
      ]
    );

    for (const proof of [
      /aggregates\.emergency_request_id =\s*\$5::integer/,
      /subjects\.emergency_request_id =\s*\$5::integer/,
      /jobs\.source_emergency_request_id =\s*\$5::integer/,
      /jobs\.source_request_relationship_id =\s*\$4::integer/,
      /relationships\.status =\s*'active'/,
      /professional_participant\.source_evidence_type =\s*'emergency_selection'/,
      /emergency_source\.arrived_at[\s\S]*IS NOT NULL/,
      /evaluations\.status =\s*'completed'/,
    ]) {
      assert.match(
        calls[0].sql,
        proof
      );
    }
  }
);

test(
  "Emergency Evaluation gate fails closed when completed Evaluation evidence is absent",
  async () => {
    const warnings = [];

    const blocked =
      await quoteService
        .quoteDraftServiceInternals
        .requireEmergencyJobEvaluation({
          client: {
            async query() {
              return {
                rows: [],
              };
            },
          },

          context: {
            job_id:
              JOB_ID,
            job_source_type:
              "emergency_request",
            source_context_type:
              "emergency_request",
            job_request_id:
              null,
            relationship_id:
              151,
            actor_user_id:
              9,
            actor_participant_id:
              PARTICIPANT_ID,
            job_emergency_request_id:
              41,
            business_customer_job_source_id:
              null,
            job_business_customer_job_source_id:
              null,
          },

          logger: {
            warn(
              message,
              evidence
            ) {
              warnings.push({
                message,
                evidence,
              });
            },
          },
        });

    assert.equal(
      blocked.status,
      409
    );

    assert.equal(
      blocked.code,
      "QUOTE_EVALUATION_REQUIRED"
    );

    assert.equal(
      warnings.length,
      1
    );
  }
);

test(
  "Task 3B does not change Emergency Start Work service",
  () => {
    assert.doesNotMatch(
      evaluation,
      /startEmergencyWork/
    );

    assert.doesNotMatch(
      quote,
      /startEmergencyWork/
    );
  }
);
