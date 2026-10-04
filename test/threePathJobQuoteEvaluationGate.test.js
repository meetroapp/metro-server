"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const service =
  require("../server/authorization/quoteDraftService");

const source = readFileSync(
  join(
    __dirname,
    "..",
    "server",
    "authorization",
    "quoteDraftService.js"
  ),
  "utf8"
);

const JOB_ID =
  "11111111-1111-4111-8111-111111111111";

const PARTICIPANT_ID =
  "22222222-2222-4222-8222-222222222222";

const BUSINESS_SOURCE_ID =
  "33333333-3333-4333-8333-333333333333";

function gateSource() {
  const start =
    source.indexOf(
      "async function requireSavedEvaluation("
    );

  const end =
    source.indexOf(
      "async function requireCustomerQuoteAuthority(",
      start
    );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return source.slice(start, end);
}

function logger() {
  return {
    warn() {},
    info() {},
    error() {},
  };
}

function allowingClient(calls) {
  return {
    async query(sql, values) {
      calls.push({ sql, values });

      return {
        rows: [{
          id:
            "44444444-4444-4444-8444-444444444444",
          status: "completed",
          evaluation_version: 2,
        }],
      };
    },
  };
}

test("009D-2B keeps Quick Quote business_document Evaluation bypass", async () => {
  let queried = false;

  const result =
    await service.quoteDraftServiceInternals
      .requireSavedEvaluation({
        client: {
          async query() {
            queried = true;
            throw new Error(
              "Quick Quote must not query Evaluation"
            );
          },
        },
        context: {
          job_source_type:
            "business_document",
        },
        logger: logger(),
      });

  assert.equal(result, null);
  assert.equal(queried, false);
});

test("009D-2B marketplace Quote gate binds exact ordinary Evaluation Job identity", async () => {
  const calls = [];

  const result =
    await service.quoteDraftServiceInternals
      .requireSavedEvaluation({
        client: allowingClient(calls),
        context: {
          job_id: JOB_ID,
          job_source_type:
            "ordinary_request_selection",
          source_context_type:
            "ordinary_request",
          job_request_id: 71,
          relationship_id: 81,
          actor_user_id: 91,
          actor_participant_id:
            PARTICIPANT_ID,
          business_customer_job_source_id:
            null,
        },
        logger: logger(),
      });

  assert.equal(result, null);
  assert.equal(calls.length, 1);

  assert.deepEqual(
    calls[0].values.slice(0, 3),
    [
      JOB_ID,
      91,
      PARTICIPANT_ID,
    ]
  );

  assert.equal(
    calls[0].values[4],
    "ordinary_request"
  );

  assert.equal(
    calls[0].values[5],
    "ordinary_request_selection"
  );

  assert.equal(calls[0].values[6], 71);
  assert.equal(calls[0].values[7], 81);
  assert.equal(calls[0].values[8], null);
});

test("009D-2B repeat Meetro Quote gate uses fresh Request and Relationship without Request Selection", async () => {
  const calls = [];

  const result =
    await service.quoteDraftServiceInternals
      .requireSavedEvaluation({
        client: allowingClient(calls),
        context: {
          job_id: JOB_ID,
          job_source_type:
            "existing_customer_request",
          source_context_type:
            "ordinary_request",
          job_request_id: 72,
          relationship_id: 82,
          actor_user_id: 92,
          actor_participant_id:
            PARTICIPANT_ID,
          business_customer_job_source_id:
            null,
        },
        logger: logger(),
      });

  assert.equal(result, null);
  assert.equal(calls.length, 1);

  assert.equal(
    calls[0].values[4],
    "ordinary_request"
  );

  assert.equal(
    calls[0].values[5],
    "existing_customer_request"
  );

  assert.equal(calls[0].values[6], 72);
  assert.equal(calls[0].values[7], 82);
  assert.equal(calls[0].values[8], null);

  /*
   * The shared gate is allowed to name
   * ordinary_request_selection because marketplace and repeat
   * Meetro use the same source-aware query.
   *
   * Repeat Meetro must not REQUIRE a Request Selection row or
   * source_request_selection_id.
   */
  assert.doesNotMatch(
    calls[0].sql,
    /(?:FROM|JOIN)\s+request_selections\b|source_request_selection_id/i
  );
});

test("009D-2B business_customer Quote gate binds exact external Evaluation Job source with no Request identity", async () => {
  const calls = [];

  const result =
    await service.quoteDraftServiceInternals
      .requireSavedEvaluation({
        client: allowingClient(calls),
        context: {
          job_id: JOB_ID,
          job_source_type:
            "business_customer",
          source_context_type:
            "business_customer",
          job_request_id: null,
          relationship_id: null,
          actor_user_id: 93,
          actor_participant_id:
            PARTICIPANT_ID,
          business_customer_job_source_id:
            BUSINESS_SOURCE_ID,
        },
        logger: logger(),
      });

  assert.equal(result, null);
  assert.equal(calls.length, 1);

  assert.equal(
    calls[0].values[4],
    "business_customer"
  );

  assert.equal(
    calls[0].values[5],
    "business_customer"
  );

  assert.equal(calls[0].values[6], null);
  assert.equal(calls[0].values[7], null);

  assert.equal(
    calls[0].values[8],
    BUSINESS_SOURCE_ID
  );
});

test("009D-2B requires canonical Evaluation itself to be completed regardless of Visit state", () => {
  const body = gateSource();

  assert.match(
    body,
    /evaluations\.status = 'completed'/
  );

  assert.match(
    body,
    /versions\.status = evaluations\.status/
  );

  assert.match(
    body,
    /completed_visit\.state = 'COMPLETED'/
  );

  assert.doesNotMatch(
    body,
    /completed_visit\.state = 'SCHEDULED'/
  );

  assert.match(
    body,
    /canonical_evaluation_remote_provenance/
  );

  assert.match(
    body,
    /completion_command\.command_name =\s*'evaluation\.complete'/
  );
});

test("009D-2B accepts exactly the physical-or-remote provenance branches and does not make Visit completion equal Evaluation completion", () => {
  const body = gateSource();

  assert.match(
    body,
    /visit_links\.evaluation_id IS NOT NULL[\s\S]*?completed_visit\.state = 'COMPLETED'[\s\S]*?remote\.id IS NULL/
  );

  assert.match(
    body,
    /remote\.id IS NOT NULL[\s\S]*?completion_command\.id IS NOT NULL[\s\S]*?visit_links\.evaluation_id IS NULL/
  );

  const evaluationStatus =
    body.indexOf(
      "evaluations.status = 'completed'"
    );

  const completedVisit =
    body.indexOf(
      "completed_visit.state = 'COMPLETED'"
    );

  assert.notEqual(evaluationStatus, -1);
  assert.notEqual(completedVisit, -1);
  assert.notEqual(
    evaluationStatus,
    completedVisit
  );
});

test("009D-2B fails closed when completed Evaluation evidence is absent", async () => {
  const result =
    await service.quoteDraftServiceInternals
      .requireSavedEvaluation({
        client: {
          async query() {
            return { rows: [] };
          },
        },
        context: {
          job_id: JOB_ID,
          job_source_type:
            "business_customer",
          source_context_type:
            "business_customer",
          job_request_id: null,
          relationship_id: null,
          actor_user_id: 93,
          actor_participant_id:
            PARTICIPANT_ID,
          business_customer_job_source_id:
            BUSINESS_SOURCE_ID,
        },
        logger: logger(),
      });

  assert.equal(result.status, 409);
  assert.equal(
    result.code,
    "QUOTE_EVALUATION_REQUIRED"
  );
});

test("009D-2B fails closed for an invalid mixed source identity", async () => {
  let queried = false;

  const result =
    await service.quoteDraftServiceInternals
      .requireSavedEvaluation({
        client: {
          async query() {
            queried = true;
            return { rows: [] };
          },
        },
        context: {
          job_id: JOB_ID,
          job_source_type:
            "business_customer",
          source_context_type:
            "business_customer",
          job_request_id: 999,
          relationship_id: null,
          actor_user_id: 93,
          actor_participant_id:
            PARTICIPANT_ID,
          business_customer_job_source_id:
            BUSINESS_SOURCE_ID,
        },
        logger: logger(),
      });

  assert.equal(queried, false);
  assert.equal(result.status, 409);
  assert.equal(
    result.code,
    "QUOTE_EVALUATION_REQUIRED"
  );
});


test("009D-2B PostgreSQL binds nullable ordinary source identity with explicit integer parameter types", () => {
  const body = gateSource();

  for (const expression of [
    /\$7::integer IS NOT NULL/,
    /\$8::integer IS NOT NULL/,
    /\$7::integer IS NULL/,
    /\$8::integer IS NULL/,
    /aggregates\.ordinary_request_id = \$7::integer/,
    /aggregates\.relationship_id = \$8::integer/,
    /subjects\.job_request_id = \$7::integer/,
    /subjects\.relationship_id = \$8::integer/,
    /evaluations\.relationship_id[\s\S]*IS NOT DISTINCT FROM \$8::integer/,
  ]) {
    assert.match(body, expression);
  }

  assert.match(
    body,
    /aggregates\.business_customer_job_source_id = \$9::uuid/
  );

  assert.match(
    body,
    /subjects\.business_customer_job_source_id = \$9::uuid/
  );
});
