"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listHomeownerEmergencyResponses,
} = require("../server/relationships/requestRelationshipService");
const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

function createPool(results = []) {
  const calls = [];

  return {
    calls,
    async query(text, values) {
      calls.push({
        text: String(text).replace(/\s+/g, " ").trim(),
        values,
      });

      const result = results[calls.length - 1];
      if (result instanceof Error) {
        throw result;
      }

      return result || { rows: [] };
    },
  };
}

function relationship(status, id) {
  return {
    id,
    emergency_request_id: 41,
    status,
    responded_at: `responded-${id}`,
    created_at: `created-${id}`,
    accepted_at: status === "active" ? `accepted-${id}` : null,
    declined_at: status === "declined" ? `declined-${id}` : null,
    withdrawn_at: status === "withdrawn" ? `withdrawn-${id}` : null,
    closed_at: status === "closed" ? `closed-${id}` : null,
    business_name: `Business ${id}`,
    professional_category: "electrical",
    business_image_url: null,
    service_specialties: ["emergency_wiring"],
    canonical_conversation_exists: status === "active",
  };
}

test("invalid Emergency IDs fail before database access", async () => {
  for (const emergencyRequestId of [
    "",
    "0",
    "-1",
    "1.5",
    "41abc",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const pool = createPool();
    const result = await listHomeownerEmergencyResponses({
      pool,
      homeownerUserId: 7,
      emergencyRequestId,
    });

    assert.deepEqual(result, {
      ok: false,
      status: 400,
      code: "INVALID_EMERGENCY_REQUEST_ID",
      message: "A valid Emergency request ID is required.",
    });
    assert.equal(pool.calls.length, 0);
  }
});

test("retrieval validates its database dependency safely", async () => {
  await assert.rejects(
    listHomeownerEmergencyResponses({
      pool: null,
      homeownerUserId: 7,
      emergencyRequestId: 41,
    }),
    {
      name: "TypeError",
      message: "A database pool or client is required.",
    }
  );
});

test("owned Emergency lookup is identity-scoped and missing or cross-owner access is nondisclosing", async () => {
  const pool = createPool([{ rows: [] }]);
  const result = await listHomeownerEmergencyResponses({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: "41",
  });

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    code: "EMERGENCY_REQUEST_NOT_FOUND",
    message: "The Emergency request was not found.",
  });
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /^SELECT /i);
  assert.match(pool.calls[0].text, /FROM emergency_requests/i);
  assert.match(pool.calls[0].text, /WHERE id = \$1/i);
  assert.match(pool.calls[0].text, /homeowner_id = \$2/i);
  assert.deepEqual(pool.calls[0].values, [41, 7]);
});

test("owned Emergency with no responses returns an authoritative empty list", async () => {
  const emergencyRequest = {
    id: 41,
    status: "ready_for_distribution",
  };
  const pool = createPool([
    { rows: [emergencyRequest] },
    { rows: [] },
  ]);

  const result = await listHomeownerEmergencyResponses({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    code: "EMERGENCY_RESPONSES_FOUND",
    emergencyRequest,
    responses: [],
  });
});

test("retrieval returns every governed state from the Emergency source in deterministic order", async () => {
  const responses = [
    relationship("pending", 151),
    relationship("active", 152),
    relationship("declined", 153),
    relationship("withdrawn", 154),
    relationship("closed", 155),
  ];
  const pool = createPool([
    {
      rows: [
        {
          id: 41,
          status: "ready_for_distribution",
        },
      ],
    },
    { rows: responses },
  ]);

  const result = await listHomeownerEmergencyResponses({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.responses.map((response) => response.status),
    ["pending", "active", "declined", "withdrawn", "closed"]
  );

  const query = pool.calls[1];
  assert.deepEqual(query.values, [41, 7]);
  assert.match(
    query.text,
    /request_relationships\.emergency_request_id = \$1/i
  );
  assert.match(query.text, /request_relationships\.post_id IS NULL/i);
  assert.match(
    query.text,
    /request_relationships\.homeowner_id = \$2/i
  );
  assert.doesNotMatch(
    query.text,
    /request_relationships\.status\s*=/i
  );
  assert.match(
    query.text,
    /responded_at ASC NULLS LAST,\s*request_relationships\.created_at ASC,\s*request_relationships\.id ASC/i
  );
  assert.match(
    query.text,
    /EXISTS \( SELECT 1 FROM conversations WHERE conversations\.relationship_id = request_relationships\.id \)/i
  );
});

test("retrieval selects only governed business display and relationship state", async () => {
  const pool = createPool([
    { rows: [{ id: 41, status: "ready_for_distribution" }] },
    { rows: [relationship("pending", 151)] },
  ]);

  await listHomeownerEmergencyResponses({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  const query = pool.calls[1].text;
  assert.match(query, /contractor_profiles\.business_name/i);
  assert.match(
    query,
    /contractor_profiles\.category AS professional_category/i
  );
  assert.match(
    query,
    /profile_details->'service_specialties'/i
  );
  assert.match(
    query,
    /contractor_profiles\.image_url AS business_image_url/i
  );
  assert.doesNotMatch(
    query,
    /professional_user_id|contractor_profiles\.user_id|email|phone|location_text|unit_number|access_notes|safety/i
  );
  assert.doesNotMatch(
    query,
    /professional_responses|professional_response_id|ordinary_authority_source|response_status|response_current_version/i
  );
});

test("retrieval is SELECT-only and references no transition or conversation creation helper", async () => {
  const pool = createPool([
    { rows: [{ id: 41, status: "ready_for_distribution" }] },
    { rows: [] },
  ]);

  await listHomeownerEmergencyResponses({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.equal(pool.calls.length, 2);
  for (const call of pool.calls) {
    assert.match(call.text, /^SELECT /i);
    assert.doesNotMatch(
      call.text,
      /\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b|FOR UPDATE/i
    );
  }

  const source = String(listHomeownerEmergencyResponses);
  assert.doesNotMatch(
    source,
    /ensureConversation|ensureConversationWithClient/
  );
  assert.doesNotMatch(
    source,
    /transition|notification|visibility|message creation/i
  );
});

test("database failures propagate unchanged for route normalization", async () => {
  const privateError = new Error(
    "postgres://private-host/emergency-responses"
  );
  const pool = createPool([privateError]);

  await assert.rejects(
    listHomeownerEmergencyResponses({
      pool,
      homeownerUserId: 7,
      emergencyRequestId: 41,
    }),
    (error) => error === privateError
  );
});

test(
  "production Emergency homeowner-response SQL executes against local PostgreSQL",
  async (context) => {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      context.skip("A disposable local PostgreSQL test database is required.");
      return;
    }

    assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    });

    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 3000,
    });

    const readCounts = async () => {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM professional_responses)::integer
            AS professional_responses,
          (SELECT COUNT(*) FROM request_selections)::integer
            AS request_selections,
          (SELECT COUNT(*) FROM conversations)::integer
            AS conversations,
          (SELECT COUNT(*) FROM messages)::integer AS messages,
          (SELECT COUNT(*) FROM workflow_events)::integer
            AS workflow_events
      `);

      return result.rows[0];
    };

    const readFixture = async () => {
      const result = await pool.query(`
        SELECT
          emergency_requests.id AS emergency_request_id,
          emergency_requests.homeowner_id,
          emergency_requests.status AS emergency_status,
          request_relationships.id AS relationship_id,
          request_relationships.status AS relationship_status,
          request_relationships.professional_response_id,
          request_relationships.ordinary_authority_source
        FROM emergency_requests
        INNER JOIN request_relationships
          ON request_relationships.emergency_request_id =
            emergency_requests.id
        WHERE request_relationships.post_id IS NULL
        ORDER BY
          emergency_requests.id ASC,
          request_relationships.id ASC
        LIMIT 1
      `);

      return result.rows[0];
    };

    try {
      const fixtureBefore = await readFixture();
      assert.ok(fixtureBefore, "an existing Emergency fixture is required");
      assert.equal(fixtureBefore.professional_response_id, null);
      assert.equal(fixtureBefore.ordinary_authority_source, null);

      const countsBefore = await readCounts();
      const result = await listHomeownerEmergencyResponses({
        pool,
        homeownerUserId: fixtureBefore.homeowner_id,
        emergencyRequestId: fixtureBefore.emergency_request_id,
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 200);
      assert.equal(result.code, "EMERGENCY_RESPONSES_FOUND");
      assert.equal(
        result.emergencyRequest.status,
        fixtureBefore.emergency_status
      );

      const response = result.responses.find(
        (row) => String(row.id) === String(fixtureBefore.relationship_id)
      );
      assert.ok(response);
      assert.equal(response.status, fixtureBefore.relationship_status);
      assert.equal(
        response.emergency_request_id,
        fixtureBefore.emergency_request_id
      );
      assert.equal(Object.hasOwn(response, "professional_response_id"), false);
      assert.equal(Object.hasOwn(response, "ordinary_authority_source"), false);
      assert.equal(Object.hasOwn(response, "response_id"), false);
      assert.equal(Object.hasOwn(response, "response_status"), false);

      assert.deepEqual(await readFixture(), fixtureBefore);
      assert.deepEqual(await readCounts(), countsBefore);
    } finally {
      await pool.end();
    }
  }
);
