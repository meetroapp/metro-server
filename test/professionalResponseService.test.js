"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  IMPLEMENTATION_MILESTONE_ID,
  createCommandFingerprint,
  submitProfessionalResponse,
} = require("../server/relationships/professionalResponseService");
const {
  createProfessionalResponseFake,
} = require("./helpers/professionalResponseFake");

const canSee = () => true;

function submit(fake, overrides = {}) {
  return submitProfessionalResponse({
    pool: fake.pool,
    authenticatedActor: { id: 9 },
    postId: 41,
    payload: { introduction_text: "I can help with this repair." },
    idempotencyKey: "professional-response:test-command",
    professionalCanSeeRequest: canSee,
    ...overrides,
  });
}

test("canonical submission atomically creates the exact response aggregate", async () => {
  const fake = createProfessionalResponseFake();
  const result = await submit(fake);

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.code, "PROFESSIONAL_RESPONSE_CREATED");
  assert.equal(result.response.status, "submitted");
  assert.equal(result.relationship.status, "pending");
  assert.equal(result.relationship.authority_source, "professional_response");
  assert.equal(fake.state.responses.length, 1);
  assert.equal(fake.state.relationships.length, 1);
  assert.equal(fake.state.versions.length, 1);
  assert.equal(fake.state.evidence.length, 1);
  assert.equal(fake.state.idempotency.length, 1);
  assert.equal(fake.state.idempotency[0].completed_at !== null, true);
  assert.equal(
    String(fake.state.responses[0].request_relationship_id),
    String(fake.state.relationships[0].id)
  );
  assert.equal(
    String(fake.state.relationships[0].professional_response_id),
    String(fake.state.responses[0].id)
  );
  assert.equal(
    fake.state.evidence[0].implementation_milestone_id,
    IMPLEMENTATION_MILESTONE_ID
  );
  assert.equal(
    IMPLEMENTATION_MILESTONE_ID,
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-2C"
  );

  for (const collection of [
    "selections",
    "conversations",
    "participants",
    "messages",
    "workflowEvents",
  ]) {
    assert.deepEqual(fake.state[collection], []);
  }

  const sql = fake.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(sql, /INSERT INTO (?:conversations|conversation_participants|messages|request_selections|workflow_events)/i);
});

test("fingerprints are deterministic, order-independent at the command boundary, and content-sensitive", () => {
  const first = createCommandFingerprint({
    postId: 41,
    contractorId: 80,
    introductionText: "First",
  });
  const same = createCommandFingerprint({
    introductionText: "First",
    contractorId: 80,
    postId: 41,
  });
  const different = createCommandFingerprint({
    postId: 41,
    contractorId: 80,
    introductionText: "Second",
  });

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, different);
});

test("same key retry replays the original pair without duplicate evidence", async () => {
  const fake = createProfessionalResponseFake();
  const first = await submit(fake);
  const replay = await submit(fake);

  assert.equal(first.response.id, replay.response.id);
  assert.equal(replay.code, "PROFESSIONAL_RESPONSE_REPLAYED");
  assert.equal(replay.replayed, true);
  assert.equal(fake.state.responses.length, 1);
  assert.equal(fake.state.relationships.length, 1);
  assert.equal(fake.state.versions.length, 1);
  assert.equal(fake.state.evidence.length, 1);
  assert.equal(fake.state.idempotency.length, 1);
});

test("same key with different canonical content conflicts without writes", async () => {
  const fake = createProfessionalResponseFake();
  await submit(fake);
  const conflict = await submit(fake, {
    payload: { introduction_text: "Materially different response." },
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "PROFESSIONAL_RESPONSE_IDEMPOTENCY_CONFLICT");
  assert.equal(fake.state.responses.length, 1);
  assert.equal(fake.state.evidence.length, 1);
});

test("different key returns existing canonical participation unchanged", async () => {
  const fake = createProfessionalResponseFake();
  const first = await submit(fake);
  const existing = await submit(fake, {
    idempotencyKey: "professional-response:second-command",
    payload: { introduction_text: "A newer attempt is not a new identity." },
  });

  assert.equal(existing.code, "PROFESSIONAL_RESPONSE_EXISTS");
  assert.equal(existing.resultClassification, "existing");
  assert.equal(existing.response.id, first.response.id);
  assert.equal(existing.response.introduction_text, "I can help with this repair.");
  assert.equal(fake.state.responses.length, 1);
  assert.equal(fake.state.evidence.length, 1);
  assert.equal(fake.state.idempotency.length, 2);
  assert.equal(fake.state.idempotency.every((row) => row.completed_at), true);
});

test("concurrent submissions serialize to one canonical aggregate", async () => {
  const fake = createProfessionalResponseFake();
  const [first, second] = await Promise.all([
    submit(fake, { idempotencyKey: "professional-response:concurrent-a" }),
    submit(fake, { idempotencyKey: "professional-response:concurrent-b" }),
  ]);

  assert.deepEqual(
    [first.resultClassification, second.resultClassification].sort(),
    ["created", "existing"]
  );
  assert.equal(first.response.id, second.response.id);
  assert.equal(fake.state.responses.length, 1);
  assert.equal(fake.state.relationships.length, 1);
  assert.equal(fake.state.versions.length, 1);
  assert.equal(fake.state.evidence.length, 1);
});

test("authentication, profile identity, request identity, and eligibility fail closed", async (t) => {
  const cases = [
    {
      name: "unauthenticated",
      fake: createProfessionalResponseFake(),
      overrides: { authenticatedActor: {} },
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    },
    {
      name: "missing profile",
      fake: createProfessionalResponseFake({ profiles: [] }),
      overrides: {},
      status: 403,
      code: "PROFESSIONAL_PROFILE_REQUIRED",
    },
    {
      name: "ambiguous profiles",
      fake: createProfessionalResponseFake({
        profiles: [
          { id: 80, user_id: 9 },
          { id: 81, user_id: 9 },
        ],
      }),
      overrides: {},
      status: 409,
      code: "PROFESSIONAL_PROFILE_AMBIGUOUS",
    },
    {
      name: "missing request",
      fake: createProfessionalResponseFake({ request: null }),
      overrides: { postId: 999 },
      status: 404,
      code: "REQUEST_NOT_AVAILABLE",
    },
    {
      name: "self response",
      fake: createProfessionalResponseFake({ request: {
        id: 41,
        user_id: 9,
        status: "open",
      } }),
      overrides: {},
      status: 403,
      code: "SELF_RESPONSE_NOT_ALLOWED",
    },
    {
      name: "ineligible",
      fake: createProfessionalResponseFake(),
      overrides: { professionalCanSeeRequest: () => false },
      status: 403,
      code: "REQUEST_NOT_ELIGIBLE",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const before = JSON.stringify(item.fake.state);
      const result = await submit(item.fake, item.overrides);
      assert.equal(result.ok, false);
      assert.equal(result.status, item.status);
      assert.equal(result.code, item.code);
      assert.equal(JSON.stringify(item.fake.state), before);
    });
  }
});

test("closed, cancelled, and expired requests reject without aggregate creation", async (t) => {
  for (const status of ["closed", "cancelled", "expired"]) {
    await t.test(status, async () => {
      const fake = createProfessionalResponseFake({ request: {
        id: 41,
        user_id: 7,
        status,
      } });
      const result = await submit(fake);
      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.equal(result.code, "REQUEST_NOT_AVAILABLE");
      assert.equal(fake.state.responses.length, 0);
      assert.equal(fake.state.relationships.length, 0);
    });
  }
});

test("client-supplied identity, lifecycle, timestamps, and fingerprints are rejected", async () => {
  const prohibitedFields = [
    "responseId", "relationshipId", "professionalId", "professionalUserId",
    "contractorId", "businessId", "homeownerId", "requesterId",
    "conversationId", "selectionId", "status", "version", "createdAt",
    "submittedAt", "contentFingerprint",
  ];

  for (const field of prohibitedFields) {
    const fake = createProfessionalResponseFake();
    const result = await submit(fake, {
      payload: {
        introduction_text: "I can help.",
        [field]: "client-controlled",
      },
    });
    assert.equal(result.ok, false, field);
    assert.equal(result.code, "UNSUPPORTED_PROFESSIONAL_RESPONSE_FIELDS", field);
    assert.equal(fake.state.responses.length, 0, field);
  }
});

test("legacy ordinary authority fails closed while Emergency rows remain isolated", async (t) => {
  for (const legacy of [
    { name: "pending", row: { status: "pending" } },
    { name: "active", row: { status: "active" } },
    { name: "duplicate", row: { status: "pending" }, duplicate: true },
  ]) {
    await t.test(legacy.name, async () => {
      const row = {
        id: 51,
        post_id: 41,
        emergency_request_id: null,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        professional_response_id: null,
        ordinary_authority_source: null,
        ...legacy.row,
      };
      const fake = createProfessionalResponseFake({
        relationships: legacy.duplicate ? [row, { ...row, id: 52 }] : [row],
      });
      const result = await submit(fake);
      assert.equal(result.ok, false);
      assert.equal(result.code, "PROFESSIONAL_RESPONSE_RECONCILIATION_REQUIRED");
      assert.equal(fake.state.responses.length, 0);
      assert.equal(fake.state.relationships.length, legacy.duplicate ? 2 : 1);
    });
  }

  await t.test("conversation linked", async () => {
    const fake = createProfessionalResponseFake({
      relationships: [{
        id: 51,
        post_id: 41,
        emergency_request_id: null,
        homeowner_id: 7,
        contractor_id: 82,
        professional_user_id: 10,
        status: "active",
      }],
      conversations: [{ id: 71, relationship_id: 51 }],
    });
    const result = await submit(fake);
    assert.equal(result.code, "REQUEST_SELECTION_STATE_UNRESOLVED");
    assert.equal(fake.state.responses.length, 0);
  });

  await t.test("Emergency excluded", async () => {
    const fake = createProfessionalResponseFake({
      relationships: [{
        id: 61,
        post_id: null,
        emergency_request_id: 91,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        status: "active",
      }],
    });
    const result = await submit(fake);
    assert.equal(result.ok, true);
    assert.equal(fake.state.responses.length, 1);
    assert.equal(fake.state.relationships.length, 2);
    assert.equal(fake.state.relationships[0].emergency_request_id, 91);
  });
});

test("each transactional persistence failure rolls back every canonical object", async (t) => {
  for (const failAt of [
    "insert_response",
    "insert_relationship",
    "insert_version",
    "insert_evidence",
    "idempotency_complete",
    "deferred_validation",
    "commit",
  ]) {
    await t.test(failAt, async () => {
      const fake = createProfessionalResponseFake({ failAt });
      await assert.rejects(() => submit(fake));
      assert.equal(fake.state.responses.length, 0);
      assert.equal(fake.state.relationships.length, 0);
      assert.equal(fake.state.versions.length, 0);
      assert.equal(fake.state.evidence.length, 0);
      assert.equal(fake.state.idempotency.length, 0);
      assert.ok(fake.calls.some((call) => call.sql === "ROLLBACK"));
    });
  }
});
