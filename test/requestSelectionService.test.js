"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  COMMAND_NAME,
  IMPLEMENTATION_MILESTONE_ID,
  createSelectionFingerprint,
  listHomeownerProfessionalResponses,
  selectProfessionalResponse,
  validateSelectionIdempotencyKey,
  validateSelectionPayload,
} = require("../server/relationships/requestSelectionService");
const {
  createRequestSelectionFake,
} = require("./helpers/requestSelectionFake");

function select(fake, overrides = {}) {
  return selectProfessionalResponse({
    pool: fake.pool,
    authenticatedActor: { id: 7 },
    postId: 41,
    responseId: 901,
    payload: {},
    idempotencyKey: "request-selection:test-command",
    ...overrides,
  });
}

test("selection atomically creates one canonical selection and exact conversation", async () => {
  const fake = createRequestSelectionFake();
  const result = await select(fake);

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.code, "REQUEST_SELECTION_CREATED");
  assert.equal(result.privacy_stage, 3);
  assert.equal(result.response.status, "selected");
  assert.equal(result.relationship.status, "active");
  assert.equal(result.conversation.status, "active");
  assert.equal(result.response.current_version, 2);
  assert.equal(result.relationship.current_version, 2);

  assert.equal(fake.state.selections.length, 1);
  assert.equal(fake.state.conversations.length, 1);
  assert.equal(fake.state.participants.length, 2);
  assert.deepEqual(
    fake.state.participants.map((row) => row.participant_role).sort(),
    ["homeowner", "professional"]
  );
  assert.equal(fake.state.selectionEvidence.length, 1);
  assert.equal(fake.state.idempotency.length, 1);
  assert.ok(fake.state.idempotency[0].completed_at);
  assert.equal(
    fake.state.selectionEvidence[0].implementation_milestone_id,
    IMPLEMENTATION_MILESTONE_ID
  );
  assert.deepEqual(
    {
      response:
        `${fake.state.selectionEvidence[0].previous_response_status}->` +
        fake.state.selectionEvidence[0].new_response_status,
      relationship:
        `${fake.state.selectionEvidence[0].previous_relationship_status}->` +
        fake.state.selectionEvidence[0].new_relationship_status,
    },
    {
      response: "submitted->selected",
      relationship: "pending->active",
    }
  );
  assert.equal(
    IMPLEMENTATION_MILESTONE_ID,
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-3"
  );

  const selection = fake.state.selections[0];
  const conversation = fake.state.conversations[0];
  assert.equal(
    String(selection.conversation_id),
    String(conversation.id)
  );
  assert.equal(
    String(conversation.request_selection_id),
    String(selection.id)
  );
  assert.equal(
    String(conversation.relationship_id),
    String(selection.request_relationship_id)
  );

  assert.deepEqual(fake.state.messages, []);
  assert.deepEqual(fake.state.workflowEvents, []);
  const sql = fake.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(
    sql,
    /INSERT INTO (?:messages|workflow_events|quotes|invoices|payments|projects)/i
  );
});

test("selection preserves a PostgreSQL BIGINT professional response identity", async () => {
  const responseId = "9007199254740993";
  const fake = createRequestSelectionFake();
  fake.state.responses[0].id = responseId;
  fake.state.relationships[0].professional_response_id = responseId;

  const result = await select(fake, { responseId });

  assert.equal(result.ok, true);
  assert.equal(result.response.id, responseId);
  assert.equal(result.selection.response_id, responseId);
  assert.equal(fake.state.selections[0].professional_response_id, responseId);
});

test("lifecycle-v2 selection bootstraps one Job from the canonical selection", async () => {
  const fake = createRequestSelectionFake({
    request: {
      id: 41,
      user_id: 7,
      title: "Dishwasher issue",
      status: "open",
      lifecycle_contract_version: 2,
    },
  });
  const bootstrapCalls = [];
  const result = await select(fake, {
    lifecycleJobBootstrap: async (input) => {
      bootstrapCalls.push(input);
      return {
        created: true,
        job: { id: "11111111-1111-4111-8111-111111111111" },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].request.lifecycle_contract_version, 2);
  assert.equal(String(bootstrapCalls[0].selection.id), String(result.selection.id));
  assert.equal(bootstrapCalls[0].relationship.id, result.relationship.id);
  assert.equal(result.lifecycleJob.id, "11111111-1111-4111-8111-111111111111");
});

test("lifecycle Job bootstrap failure rolls back selection, relationship, and conversation", async () => {
  const fake = createRequestSelectionFake({
    request: {
      id: 41,
      user_id: 7,
      title: "Dishwasher issue",
      status: "open",
      lifecycle_contract_version: 2,
    },
  });
  const before = JSON.stringify(fake.state);

  await assert.rejects(
    select(fake, {
      lifecycleJobBootstrap: async () => {
        throw new Error("synthetic lifecycle bootstrap failure");
      },
    }),
    /synthetic lifecycle bootstrap failure/
  );
  assert.equal(JSON.stringify(fake.state), before);
});

test("selection closes every competing submitted response without a conversation", async () => {
  const fake = createRequestSelectionFake();
  await select(fake);

  const selected = fake.state.responses.find((row) => row.id === "901");
  const competitor = fake.state.responses.find((row) => row.id === "902");
  const selectedRelationship = fake.state.relationships.find(
    (row) => row.id === 501
  );
  const competingRelationship = fake.state.relationships.find(
    (row) => row.id === 502
  );

  assert.equal(selected.status, "selected");
  assert.equal(selectedRelationship.status, "active");
  assert.equal(competitor.status, "not_selected");
  assert.equal(competingRelationship.status, "closed");
  assert.equal(
    competingRelationship.closure_reason,
    "other_professional_selected"
  );
  assert.equal(fake.state.versions.length, 2);
  assert.equal(fake.state.responseEvidence.length, 2);
  assert.equal(
    fake.state.responseEvidence.every((row) => row.idempotency_id === null),
    true
  );
  assert.deepEqual(
    fake.state.responseEvidence.map((row) => row.event_type).sort(),
    [
      "professional_response_not_selected",
      "professional_response_selected",
    ]
  );
  assert.equal(
    fake.state.conversations.some((conversation) =>
      Number(conversation.relationship_id) === 502
    ),
    false
  );
});

test("same command key replays the exact result without duplicate authority", async () => {
  const fake = createRequestSelectionFake();
  const first = await select(fake);
  const replay = await select(fake);

  assert.equal(replay.ok, true);
  assert.equal(replay.code, "REQUEST_SELECTION_REPLAYED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.selection.id, first.selection.id);
  assert.equal(replay.conversation.id, first.conversation.id);
  assert.equal(fake.state.selections.length, 1);
  assert.equal(fake.state.conversations.length, 1);
  assert.equal(fake.state.selectionEvidence.length, 1);
  assert.equal(fake.state.idempotency.length, 1);
});

test("different key for the selected response returns existing authority without writes", async () => {
  const fake = createRequestSelectionFake();
  const first = await select(fake);
  const existing = await select(fake, {
    idempotencyKey: "request-selection:second-command",
  });

  assert.equal(existing.ok, true);
  assert.equal(existing.code, "REQUEST_SELECTION_EXISTS");
  assert.equal(existing.resultClassification, "existing");
  assert.equal(existing.selection.id, first.selection.id);
  assert.equal(fake.state.idempotency.length, 1);
  assert.equal(fake.state.selectionEvidence.length, 1);
});

test("different response after selection conflicts without changing sole authority", async () => {
  const fake = createRequestSelectionFake();
  await select(fake);
  const before = JSON.stringify(fake.state);
  const conflict = await select(fake, {
    responseId: 902,
    idempotencyKey: "request-selection:different-response",
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "REQUEST_SELECTION_ALREADY_EXISTS");
  assert.equal(JSON.stringify(fake.state), before);
});

test("same key with changed canonical response identity conflicts", async () => {
  const fake = createRequestSelectionFake();
  await select(fake);
  const before = JSON.stringify(fake.state);
  const conflict = await select(fake, { responseId: 902 });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "REQUEST_SELECTION_IDEMPOTENCY_CONFLICT");
  assert.equal(JSON.stringify(fake.state), before);
});

test("homeowner ownership, request state, and response identity fail closed", async (t) => {
  const cases = [
    {
      name: "unauthenticated",
      overrides: { authenticatedActor: {} },
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    },
    {
      name: "cross-owner",
      overrides: { authenticatedActor: { id: 8 } },
      status: 404,
      code: "REQUEST_NOT_FOUND",
    },
    {
      name: "missing response",
      overrides: { responseId: 999 },
      status: 404,
      code: "PROFESSIONAL_RESPONSE_NOT_FOUND",
    },
    {
      name: "closed request",
      fake: createRequestSelectionFake({
        request: { id: 41, user_id: 7, title: "Closed", status: "closed" },
      }),
      status: 409,
      code: "REQUEST_NOT_SELECTABLE",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fake = item.fake || createRequestSelectionFake();
      const before = JSON.stringify(fake.state);
      const result = await select(fake, item.overrides || {});
      assert.equal(result.ok, false);
      assert.equal(result.status, item.status);
      assert.equal(result.code, item.code);
      assert.equal(JSON.stringify(fake.state), before);
    });
  }
});

test("legacy, orphaned, malformed, and premature-conversation authority requires reconciliation", async (t) => {
  const cases = [
    {
      name: "legacy relationship",
      fake: createRequestSelectionFake({
        responses: [],
        relationships: [{
          id: 500,
          post_id: 41,
          emergency_request_id: null,
          homeowner_id: 7,
          contractor_id: 80,
          professional_user_id: 9,
          status: "pending",
          professional_response_id: null,
          ordinary_authority_source: "legacy",
          current_version: 1,
        }],
      }),
    },
    {
      name: "profile ownership mismatch",
      fake: createRequestSelectionFake({
        profiles: [{
          id: 80,
          user_id: 99,
          business_name: "Mismatch",
        }],
        responses: [{
          id: "901",
          post_id: 41,
          request_relationship_id: 501,
          homeowner_id: 7,
          contractor_id: 80,
          professional_user_id: 9,
          status: "submitted",
          introduction_text: "Mismatch",
          current_version: 1,
          content_fingerprint: "a".repeat(64),
        }],
        relationships: [{
          id: 501,
          post_id: 41,
          emergency_request_id: null,
          homeowner_id: 7,
          contractor_id: 80,
          professional_user_id: 9,
          status: "pending",
          professional_response_id: "901",
          ordinary_authority_source: "professional_response",
          current_version: 1,
        }],
      }),
    },
    {
      name: "premature conversation",
      fake: createRequestSelectionFake({
        conversations: [{
          id: 800,
          relationship_id: 501,
          homeowner_id: 7,
          contractor_id: 80,
          professional_user_id: 9,
          status: "active",
          request_selection_id: null,
        }],
      }),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const before = JSON.stringify(item.fake.state);
      const result = await select(item.fake);
      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.equal(
        result.code,
        "REQUEST_SELECTION_RECONCILIATION_REQUIRED"
      );
      assert.equal(JSON.stringify(item.fake.state), before);
    });
  }
});

test("every injected transactional failure rolls back all selection authority", async (t) => {
  const stages = [
    "selection_insert",
    "response_transition",
    "relationship_activation",
    "competing_response_disposition",
    "conversation_creation",
    "participant_creation",
    "evidence_creation",
    "idempotency_completion",
    "deferred_validation",
    "before_commit",
  ];

  for (const stage of stages) {
    await t.test(stage, async () => {
      const fake = createRequestSelectionFake();
      const before = JSON.stringify(fake.state);
      await assert.rejects(
        select(fake, {
          failureInjector(currentStage) {
            if (currentStage === stage) {
              throw new Error(`Injected ${stage} failure`);
            }
          },
        }),
        new RegExp(`Injected ${stage} failure`)
      );
      assert.equal(JSON.stringify(fake.state), before);
    });
  }
});

test("homeowner response projection distinguishes submitted, selected, and not selected truth", async () => {
  const fake = createRequestSelectionFake();
  const before = await listHomeownerProfessionalResponses({
    pool: fake.pool,
    authenticatedActor: { id: 7 },
    postId: 41,
  });

  assert.equal(before.ok, true);
  assert.equal(before.responses.length, 2);
  assert.equal(before.responses.every((row) => row.selection_eligible), true);
  assert.equal(before.responses.every((row) => !row.conversation_available), true);

  const selection = await select(fake);
  const after = await listHomeownerProfessionalResponses({
    pool: fake.pool,
    authenticatedActor: { id: 7 },
    postId: 41,
  });
  const selected = after.responses.find((row) => row.id === "901");
  const notSelected = after.responses.find((row) => row.id === "902");

  assert.equal(selected.status, "selected");
  assert.equal(selected.relationship_status, "active");
  assert.equal(selected.selected, true);
  assert.equal(selected.conversation_available, true);
  assert.equal(selected.conversation_id, selection.conversation.id);
  assert.equal(notSelected.status, "not_selected");
  assert.equal(notSelected.relationship_status, "closed");
  assert.equal(notSelected.selected, false);
  assert.equal(notSelected.conversation_available, false);
  assert.equal(notSelected.conversation_id, null);
  assert.equal(after.responses.every((row) => !row.selection_eligible), true);
});

test("homeowner response list is owner-scoped and reveals no protected location or contact fields", async () => {
  const fake = createRequestSelectionFake();
  const missing = await listHomeownerProfessionalResponses({
    pool: fake.pool,
    authenticatedActor: { id: 8 },
    postId: 41,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  const visible = await listHomeownerProfessionalResponses({
    pool: fake.pool,
    authenticatedActor: { id: 7 },
    postId: 41,
  });
  const serialized = JSON.stringify(visible);
  for (const prohibited of [
    "location",
    "unit_number",
    "access_notes",
    "gate_code",
    "email",
    "phone",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(prohibited, "i"));
  }
});

test("command inputs reject browser-authored identity and malformed idempotency", () => {
  assert.deepEqual(validateSelectionPayload(undefined), { valid: true });
  assert.deepEqual(validateSelectionPayload({}), { valid: true });
  assert.equal(validateSelectionPayload({ conversationId: 1 }).valid, false);
  assert.equal(validateSelectionPayload([]).valid, false);
  assert.equal(validateSelectionIdempotencyKey("").valid, false);
  assert.equal(validateSelectionIdempotencyKey("spaces are unsafe").valid, false);
  assert.equal(
    validateSelectionIdempotencyKey("request-selection:valid-key").valid,
    true
  );
  assert.equal(COMMAND_NAME, "request_selection.select");
});

test("selection fingerprints are stable and exact-response sensitive", () => {
  const first = createSelectionFingerprint({ postId: 41, responseId: 901 });
  const same = createSelectionFingerprint({ responseId: 901, postId: 41 });
  const different = createSelectionFingerprint({ postId: 41, responseId: 902 });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, different);
});
