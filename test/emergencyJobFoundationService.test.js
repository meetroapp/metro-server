"use strict";

const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const test =
  require("node:test");

const {
  ensureEmergencySelectionJob,
} = require(
  "../server/emergency/emergencyJobFoundationService"
);

const REQUEST_ID = 41;
const HOMEOWNER_ID = 7;
const RELATIONSHIP_ID = 151;
const CONTRACTOR_ID = 80;
const PROFESSIONAL_ID = 9;

function emergencyRequest(
  overrides = {}
) {
  return {
    id: REQUEST_ID,
    homeowner_id:
      HOMEOWNER_ID,
    status: "assigned",
    ...overrides,
  };
}

function relationship(
  overrides = {}
) {
  return {
    id: RELATIONSHIP_ID,
    post_id: null,
    emergency_request_id:
      REQUEST_ID,
    homeowner_id:
      HOMEOWNER_ID,
    contractor_id:
      CONTRACTOR_ID,
    professional_user_id:
      PROFESSIONAL_ID,
    status: "active",
    ...overrides,
  };
}

function fakeClient({
  existing = false,
  capabilityAvailable = true,
} = {}) {
  const calls = [];

  const state = {
    job: existing
      ? {
          id:
            "11111111-1111-4111-8111-111111111111",
          source_type:
            "emergency_request",
          source_emergency_request_id:
            REQUEST_ID,
          source_request_relationship_id:
            RELATIONSHIP_ID,
          created_by_user_id:
            HOMEOWNER_ID,
          homeowner_participant_id:
            "22222222-2222-4222-8222-222222222222",
          professional_participant_id:
            "33333333-3333-4333-8333-333333333333",
        }
      : null,

    participants: [],
    roles: 0,
    grants: [],
  };

  return {
    calls,
    state,

    async query(
      sql,
      values = []
    ) {
      const text =
        String(sql);

      calls.push({
        sql: text,
        values,
      });

      if (
        text.includes(
          "emergency_job_foundation:existing"
        )
      ) {
        return {
          rows: state.job
            ? [
                {
                  ...state.job,
                },
              ]
            : [],
        };
      }

      if (
        text.includes(
          "emergency_job_foundation:insert_job"
        )
      ) {
        state.job = {
          id: values[0],
          job_request_id: null,
          source_request_selection_id:
            null,
          source_request_relationship_id:
            values[1],
          created_by_user_id:
            values[2],
          lifecycle_contract_version:
            2,
          source_type:
            "emergency_request",
          contractor_profile_id:
            null,
          business_contact_id:
            null,
          business_customer_relationship_id:
            null,
          originating_business_document_id:
            null,
          source_business_customer_job_id:
            null,
          source_emergency_request_id:
            values[3],
        };

        return {
          rows: [
            {
              ...state.job,
            },
          ],
        };
      }

      if (
        text.includes(
          "emergency_job_foundation:insert_participants"
        )
      ) {
        state.participants = [
          {
            id: values[0],
            job_id: values[1],
            request_relationship_id:
              values[2],
            user_id: values[3],
            source_evidence_type:
              "emergency_selection",
            source_evidence_reference:
              values[6],
          },
          {
            id: values[4],
            job_id: values[1],
            request_relationship_id:
              values[2],
            user_id: values[5],
            source_evidence_type:
              "emergency_selection",
            source_evidence_reference:
              values[6],
          },
        ];

        return {
          rows:
            state.participants.map(
              (row) => ({
                ...row,
              })
            ),
        };
      }

      if (
        text.includes(
          "emergency_job_foundation:insert_roles"
        )
      ) {
        state.roles += 2;

        return {
          rows: [],
          rowCount: 2,
        };
      }

      if (
        text.includes(
          "emergency_job_foundation:capability"
        )
      ) {
        return {
          rows:
            capabilityAvailable
              ? (
                  Array.isArray(values[0])
                    ? values[0]
                    : []
                ).map(
                  (capability) => ({
                    capability,
                  })
                )
              : [],
        };
      }

      if (
        text.includes(
          "emergency_job_foundation:insert_grant"
        )
      ) {
        state.grants.push({
          grantee:
            values[1],
          grantor:
            values[2],
          jobId:
            values[3],
          capability:
            values[4],
          evidence:
            values[5],
          key:
            values[6],
        });

        return {
          rows: [],
          rowCount: 1,
        };
      }

      throw new Error(
        `Unexpected query: ${text}`
      );
    },
  };
}

test(
  "selected Emergency creates one canonical Job with two authenticated participants and governed Evaluation and Quote-preparation authority",
  async () => {
    const client =
      fakeClient();

    const result =
      await ensureEmergencySelectionJob({
        client,
        emergencyRequest:
          emergencyRequest(),
        relationship:
          relationship(),
        logger: {
          info() {},
        },
      });

    assert.equal(
      result.created,
      true
    );

    assert.equal(
      result.job.source_type,
      "emergency_request"
    );

    assert.equal(
      result.job
        .source_emergency_request_id,
      REQUEST_ID
    );

    assert.equal(
      result.job
        .source_request_relationship_id,
      RELATIONSHIP_ID
    );

    assert.equal(
      result.job
        .created_by_user_id,
      HOMEOWNER_ID
    );

    assert.equal(
      result.job.job_request_id,
      null
    );

    assert.equal(
      result.job
        .source_request_selection_id,
      null
    );

    assert.equal(
      result.job
        .contractor_profile_id,
      null
    );

    assert.deepEqual(
      client.state.participants
        .map(
          (participant) =>
            participant.user_id
        )
        .sort(
          (a, b) => a - b
        ),
      [
        HOMEOWNER_ID,
        PROFESSIONAL_ID,
      ].sort(
        (a, b) => a - b
      )
    );

    assert.equal(
      client.state.roles,
      2
    );

    assert.equal(
      client.state.grants.length,
      8
    );

    const professionalCapabilities =
      client.state.grants
        .filter(
          (grant) =>
            grant.grantee ===
            client.state.participants[1].id
        )
        .map(
          (grant) =>
            grant.capability
        )
        .sort();

    assert.deepEqual(
      professionalCapabilities,
      [
        "evaluation.perform",
        "participant.read",
        "quote.create",
        "quote.issue",
        "quote.read",
        "quote.revise",
        "quote.scope.manage",
      ].sort()
    );

    const allSql =
      client.calls
        .map(
          (call) =>
            call.sql
        )
        .join("\n");

    assert.doesNotMatch(
      allSql,
      /canonical_quotes|invoice|payment|deposit|workstream|work_activity/i
    );
  }
);

test(
  "Emergency Job materialization is idempotent and does not duplicate an existing exact source",
  async () => {
    const client =
      fakeClient({
        existing: true,
      });

    const result =
      await ensureEmergencySelectionJob({
        client,
        emergencyRequest:
          emergencyRequest(),
        relationship:
          relationship(),
        logger: {
          info() {},
        },
      });

    assert.equal(
      result.created,
      false
    );

    assert.equal(
      result.job
        .source_emergency_request_id,
      REQUEST_ID
    );

    assert.equal(
      client.calls.some(
        (call) =>
          call.sql.includes(
            "insert_job"
          )
      ),
      false
    );
  }
);

test(
  "pre-selection, wrong-relationship, and wrong-homeowner authority fail before a Job write",
  async () => {
    for (const input of [
      {
        emergencyRequest:
          emergencyRequest({
            status:
              "ready_for_distribution",
          }),
        relationship:
          relationship(),
      },
      {
        emergencyRequest:
          emergencyRequest(),
        relationship:
          relationship({
            status: "pending",
          }),
      },
      {
        emergencyRequest:
          emergencyRequest(),
        relationship:
          relationship({
            emergency_request_id:
              999,
          }),
      },
      {
        emergencyRequest:
          emergencyRequest(),
        relationship:
          relationship({
            homeowner_id: 999,
          }),
      },
    ]) {
      const client =
        fakeClient();

      await assert.rejects(
        ensureEmergencySelectionJob({
          client,
          ...input,
          logger: {
            info() {},
          },
        }),
        /exact selected Emergency relationship/
      );

      assert.equal(
        client.calls.length,
        0
      );
    }
  }
);

test(
  "Emergency Job bootstrap fails closed when participant.read is unavailable",
  async () => {
    const client =
      fakeClient({
        capabilityAvailable:
          false,
      });

    await assert.rejects(
      ensureEmergencySelectionJob({
        client,
        emergencyRequest:
          emergencyRequest(),
        relationship:
          relationship(),
        logger: {
          info() {},
        },
      }),
      /lifecycle authority is unavailable/
    );
  }
);

test(
  "homeowner selection transaction materializes the Emergency Job before commit on both selection paths",
  () => {
    const source =
      fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "server",
          "emergency",
          "emergencySelectionService.js"
        ),
        "utf8"
      );

    assert.match(
      source,
      /require\("\.\/emergencyJobFoundationService"\)/
    );

    assert.equal(
      (
        source.match(
          /ensureEmergencySelectionJob\(\{/g
        ) || []
      ).length,
      2
    );

    const firstCall =
      source.indexOf(
        "await ensureEmergencySelectionJob({"
      );

    const firstCommit =
      source.indexOf(
        'await client.query("COMMIT")',
        firstCall
      );

    assert.ok(
      firstCall >= 0
    );

    assert.ok(
      firstCommit >
        firstCall
    );

    const secondCall =
      source.indexOf(
        "await ensureEmergencySelectionJob({",
        firstCall + 1
      );

    const secondCommit =
      source.indexOf(
        'await client.query("COMMIT")',
        secondCall
      );

    assert.ok(
      secondCall >
        firstCall
    );

    assert.ok(
      secondCommit >
        secondCall
    );
  }
);
