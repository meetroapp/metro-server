"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BOOTSTRAP_CAPABILITIES,
  CUSTOMER_BOOTSTRAP_CAPABILITIES,
  CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
  PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
  PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
  bootstrapExistingCustomerRequestJob,
} = require("../server/workflow/jobFoundationService");

const SOURCE_RELATIONSHIP =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function request(overrides = {}) {
  return {
    id: 41,
    user_id: 7,
    lifecycle_contract_version: 2,
    request_origin:
      "existing_customer_request",
    target_contractor_profile_id: 80,
    target_professional_user_id: 9,
    source_meetro_relationship_id:
      SOURCE_RELATIONSHIP,
    ...overrides,
  };
}

function relationship(overrides = {}) {
  return {
    id: 501,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    professional_response_id: null,
    ordinary_authority_source:
      "existing_customer_request",
    current_version: 1,
    source_meetro_relationship_id:
      SOURCE_RELATIONSHIP,
    ...overrides,
  };
}

function operation(sql) {
  return String(sql).match(
    /existing_customer_job:([a-z_]+)/
  )?.[1] || "";
}

function fakeClient({
  concernExists = true,
} = {}) {
  const state = {
    jobs: [],
    participants: [],
    roles: [],
    grants: [],
  };

  const calls = [];

  return {
    state,
    calls,

    async query(sql, values = []) {
      const op = operation(sql);
      calls.push({ op, values });

      if (op === "concern_precondition") {
        return {
          rows: concernExists
            ? [{ id: "concern-1" }]
            : [],
        };
      }

      if (op === "existing") {
        return { rows: [] };
      }

      if (op === "insert_job") {
        const row = {
          id: values[0],
          job_request_id: values[1],
          source_request_selection_id: null,
          source_request_relationship_id:
            values[2],
          created_by_user_id: values[3],
          lifecycle_contract_version: 2,
          source_type:
            "existing_customer_request",
          contractor_profile_id: null,
          business_contact_id: null,
          business_customer_relationship_id: null,
          originating_business_document_id: null,
        };

        state.jobs.push(row);
        return { rows: [row] };
      }

      if (op === "insert_participants") {
        const rows = [
          {
            id: values[0],
            job_id: values[1],
            request_relationship_id: values[2],
            user_id: values[3],
            source_evidence_type:
              "existing_customer_request",
            source_evidence_reference:
              values[5],
          },
          {
            id: values[4],
            job_id: values[1],
            request_relationship_id: values[2],
            user_id: values[6],
            source_evidence_type:
              "existing_customer_request",
            source_evidence_reference:
              values[5],
          },
        ];

        state.participants.push(...rows);
        return { rows };
      }

      if (op === "insert_roles") {
        state.roles.push(
          {
            participant_id: values[1],
            role:
              "CUSTOMER_REPRESENTATIVE",
            source_evidence_type:
              "existing_customer_request",
          },
          {
            participant_id: values[6],
            role:
              "PRIMARY_PROFESSIONAL",
            source_evidence_type:
              "existing_customer_request",
          }
        );

        return { rows: [] };
      }

      if (
        op === "customer_capabilities" ||
        op === "professional_capabilities" ||
        op === "evaluation_visit_capabilities"
      ) {
        return {
          rows: (values[0] || []).map(
            (capability) => ({ capability })
          ),
        };
      }

      if (
        op === "insert_grant" ||
        op === "insert_evaluation_visit_grant"
      ) {
        state.grants.push({
          participant_id: values[1],
          capability: values[4],
          source_evidence_type:
            "existing_customer_request",
          source_evidence_reference:
            values[5],
          scope_type:
            op === "insert_grant"
              ? "job"
              : "evaluation_visit",
        });

        return { rows: [] };
      }

      throw new Error(
        `Unexpected query: ${String(sql)}`
      );
    },
  };
}

test("direct repeat-customer source bootstraps one lifecycle Job and two authenticated participants", async () => {
  const client = fakeClient();

  const result =
    await bootstrapExistingCustomerRequestJob({
      client,
      request: request(),
      relationship: relationship(),
      logger: { info() {} },
    });

  assert.equal(result.created, true);

  assert.equal(client.state.jobs.length, 1);

  assert.deepEqual(
    {
      request:
        client.state.jobs[0].job_request_id,
      selection:
        client.state.jobs[0]
          .source_request_selection_id,
      relationship:
        client.state.jobs[0]
          .source_request_relationship_id,
      creator:
        client.state.jobs[0]
          .created_by_user_id,
      source:
        client.state.jobs[0].source_type,
      contractor:
        client.state.jobs[0]
          .contractor_profile_id,
    },
    {
      request: 41,
      selection: null,
      relationship: 501,
      creator: 7,
      source:
        "existing_customer_request",
      contractor: null,
    }
  );

  assert.deepEqual(
    client.state.participants.map(
      (row) => row.user_id
    ),
    [7, 9]
  );

  assert.deepEqual(
    client.state.roles.map(
      (row) => row.role
    ),
    [
      "CUSTOMER_REPRESENTATIVE",
      "PRIMARY_PROFESSIONAL",
    ]
  );

  assert.equal(
    client.state.participants.every(
      (row) =>
        row.source_evidence_type ===
        "existing_customer_request"
    ),
    true
  );
});

test("direct Job receives the same narrow authenticated Meetro-customer capability envelope as ordinary work", async () => {
  const client = fakeClient();

  await bootstrapExistingCustomerRequestJob({
    client,
    request: request(),
    relationship: relationship(),
    logger: { info() {} },
  });

  const granted = new Set(
    client.state.grants.map(
      (row) => row.capability
    )
  );

  for (const capability of [
    ...BOOTSTRAP_CAPABILITIES,
    ...CUSTOMER_BOOTSTRAP_CAPABILITIES,
    ...PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
    ...CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
    ...PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
  ]) {
    assert.equal(
      granted.has(capability),
      true,
      capability
    );
  }

  assert.equal(
    client.state.grants.some(
      (row) =>
        /payment|procurement|invoice/.test(
          row.capability
        )
    ),
    false
  );
});

test("fresh request relationship—not the old Worked With relationship—is lifecycle evidence", async () => {
  const client = fakeClient();

  await bootstrapExistingCustomerRequestJob({
    client,
    request: request(),
    relationship: relationship(),
    logger: { info() {} },
  });

  const evidence =
    client.state.participants[0]
      .source_evidence_reference;

  assert.equal(
    evidence,
    "request:41:relationship:501"
  );

  assert.equal(
    evidence.includes(SOURCE_RELATIONSHIP),
    false
  );
});

test("invalid or mismatched source authority fails closed", async () => {
  const client = fakeClient();

  await assert.rejects(
    bootstrapExistingCustomerRequestJob({
      client,
      request: request(),
      relationship: relationship({
        professional_user_id: 10,
      }),
      logger: { info() {} },
    }),
    /source identity is invalid/
  );

  assert.equal(
    client.state.jobs.length,
    0
  );
});

test("lifecycle-v1 existing-customer request does not fabricate a Job", async () => {
  const client = fakeClient();

  const result =
    await bootstrapExistingCustomerRequestJob({
      client,
      request: request({
        lifecycle_contract_version: 1,
      }),
      relationship: relationship(),
      logger: { info() {} },
    });

  assert.equal(result.created, false);
  assert.equal(result.job, null);
  assert.equal(client.calls.length, 0);
});

test("lifecycle-v2 requires preserved Reported Concern truth", async () => {
  const client = fakeClient({
    concernExists: false,
  });

  await assert.rejects(
    bootstrapExistingCustomerRequestJob({
      client,
      request: request(),
      relationship: relationship(),
      logger: { info() {} },
    }),
    /requires preserved Reported Concern truth/
  );

  assert.equal(
    client.state.jobs.length,
    0
  );
});
