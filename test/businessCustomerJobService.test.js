"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const {
  BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
  BUSINESS_CUSTOMER_PROFESSIONAL_CAPABILITIES,
  createBusinessCustomerJob,
  businessCustomerJobInternals,
} = require(
  "../server/relationships/businessCustomerJobService"
);

const RELATIONSHIP_ID =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CONTACT_ID =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function idFactory() {
  return IDS.shift();
}

function fakePool({
  activeCustomerRole = true,
  contactStatus = "ACTIVE",
} = {}) {
  const calls = [];
  const state = {
    source: null,
    job: null,
    participant: null,
    party: null,
    grants: [],
  };

  return {
    calls,
    state,

    async query(sql, values = []) {
      const text = String(sql);
      const operation =
        businessCustomerJobInternals.tag(
          text
        );

      calls.push({
        operation,
        values,
      });

      if (
        text === "BEGIN" ||
        text === "COMMIT" ||
        text === "ROLLBACK"
      ) {
        return {
          rows: [],
          rowCount: 0,
        };
      }

      if (
        operation ===
        "load_relationship"
      ) {
        return {
          rows: [{
            id: RELATIONSHIP_ID,
            contractor_profile_id: 80,
            business_contact_id:
              CONTACT_ID,
            professional_user_id: 7,
            customer_name:
              "External Customer",
            contact_status:
              contactStatus,
            active_customer_role:
              activeCustomerRole,
          }],
        };
      }

      if (
        operation ===
        "reserve_command"
      ) {
        return {
          rows: [{
            id:
              "44444444-4444-4444-8444-444444444444",
          }],
        };
      }

      if (
        operation ===
        "insert_source"
      ) {
        state.source = {
          id: values[0],
          contractor_profile_id:
            values[1],
          business_contact_id:
            values[2],
          business_customer_relationship_id:
            values[3],
          created_by_user_id:
            values[4],
          project_title:
            values[5],
          project_description:
            values[6],
          location_state:
            values[7],
        };

        return {
          rows: [state.source],
        };
      }

      if (
        operation ===
        "insert_job"
      ) {
        state.job = {
          id: values[0],
          created_by_user_id:
            values[1],
          lifecycle_contract_version: 2,
          source_type:
            "business_customer",
          contractor_profile_id:
            values[2],
          business_contact_id:
            values[3],
          business_customer_relationship_id:
            values[4],
          source_business_customer_job_id:
            values[5],
          job_request_id: null,
          source_request_selection_id:
            null,
          source_request_relationship_id:
            null,
          originating_business_document_id:
            null,
        };

        return {
          rows: [state.job],
        };
      }

      if (
        operation ===
        "insert_participant"
      ) {
        state.participant = {
          id: values[0],
          job_id: values[1],
          user_id: values[2],
          request_relationship_id:
            null,
          source_evidence_type:
            "business_customer",
          source_evidence_reference:
            values[3],
        };

        return {
          rows: [
            state.participant,
          ],
        };
      }

      if (
        operation ===
        "insert_role"
      ) {
        return {
          rows: [],
          rowCount: 1,
        };
      }

      if (
        operation ===
        "capabilities"
      ) {
        return {
          rows: values[0].map(
            (capability) => ({
              capability,
            })
          ),
        };
      }

      if (
        operation ===
          "insert_grant" ||
        operation ===
          "insert_evaluation_visit_grant"
      ) {
        state.grants.push({
          participantId:
            values[1],
          jobId:
            values[2],
          capability:
            values[3],
          evidence:
            values[4],
        });

        return {
          rows: [],
          rowCount: 1,
        };
      }

      if (
        operation ===
        "insert_customer_party"
      ) {
        state.party = {
          job_id: values[0],
          contractor_profile_id:
            values[1],
          business_contact_id:
            values[2],
          business_customer_relationship_id:
            values[3],
          linked_by_user_id:
            values[4],
        };

        return {
          rows: [state.party],
          rowCount: 1,
        };
      }

      if (
        operation ===
        "finish_command"
      ) {
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
  "creates one pre-Quote business customer Job with professional-only authority",
  async () => {
    const pool = fakePool();

    const ids = [...IDS];

    const result =
      await createBusinessCustomerJob({
        pool,
        authenticatedActor: {
          id: 7,
        },
        relationshipId:
          RELATIONSHIP_ID,
        payload: {
          projectTitle:
            "Kitchen faucet replacement",
          projectDescription:
            "Inspect existing fixture and replace faucet.",
          serviceLocation: {
            mode: "STRUCTURED",
            addressLine1:
              "123 Example St",
            unitNumber: "B",
            city: "Cape Coral",
            region: "FL",
            postalCode: "33990",
            countryCode: "US",
          },
        },
        idempotencyKey:
          "55555555-5555-4555-8555-555555555555",
        idFactory:
          () => ids.shift(),
        logger: {
          info() {},
        },
      });

    assert.equal(
      result.ok,
      true
    );

    assert.equal(
      result.job.sourceType,
      "business_customer"
    );

    assert.equal(
      pool.state.job
        .job_request_id,
      null
    );

    assert.equal(
      pool.state.job
        .source_request_selection_id,
      null
    );

    assert.equal(
      pool.state.job
        .source_request_relationship_id,
      null
    );

    assert.equal(
      pool.state.job
        .originating_business_document_id,
      null
    );

    assert.equal(
      pool.state.job
        .business_contact_id,
      CONTACT_ID
    );

    assert.equal(
      pool.state.party
        .business_customer_relationship_id,
      RELATIONSHIP_ID
    );

    assert.equal(
      pool.state.participant
        .source_evidence_type,
      "business_customer"
    );

    assert.equal(
      pool.state.participant
        .request_relationship_id,
      null
    );

    assert.equal(
      pool.state.grants.length,
      new Set([
        ...BUSINESS_CUSTOMER_PROFESSIONAL_CAPABILITIES,
        ...BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
      ]).size
    );

    for (
      const capability of
        BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES
    ) {
      assert.equal(
        pool.state.grants.some(
          (grant) =>
            grant.capability ===
              capability
        ),
        true,
        capability
      );
    }

    assert.equal(
      result.job.project
        .serviceLocation
        .addressLine1,
      "123 Example St"
    );
  }
);

test(
  "Contact address is never substituted for Job service location",
  async () => {
    const normalized =
      businessCustomerJobInternals
        .normalizeLocation(undefined);

    assert.equal(
      normalized.valid,
      true
    );

    assert.equal(
      normalized.value.state,
      "UNSPECIFIED"
    );

    assert.equal(
      businessCustomerJobInternals
        .serviceLocationProjection(
          normalized.value
        ),
      null
    );
  }
);

test(
  "invalid location shape fails before database access",
  async () => {
    const pool = fakePool();

    const result =
      await createBusinessCustomerJob({
        pool,
        authenticatedActor: {
          id: 7,
        },
        relationshipId:
          RELATIONSHIP_ID,
        payload: {
          projectTitle:
            "Test Job",
          serviceLocation: {
            mode: "STRUCTURED",
            city: "Cape Coral",
          },
        },
        idempotencyKey:
          "66666666-6666-4666-8666-666666666666",
      });

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      result.code,
      "BUSINESS_CUSTOMER_JOB_CONTENT_INVALID"
    );

    assert.equal(
      pool.calls.length,
      0
    );
  }
);

test(
  "inactive Customer role fails closed before command reservation",
  async () => {
    const pool = fakePool({
      activeCustomerRole: false,
    });

    const ids = [...IDS];

    const result =
      await createBusinessCustomerJob({
        pool,
        authenticatedActor: {
          id: 7,
        },
        relationshipId:
          RELATIONSHIP_ID,
        payload: {
          projectTitle:
            "Test Job",
        },
        idempotencyKey:
          "77777777-7777-4777-8777-777777777777",
        idFactory:
          () => ids.shift(),
      });

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      result.code,
      "BUSINESS_CUSTOMER_JOB_CUSTOMER_INACTIVE"
    );

    assert.equal(
      pool.calls.some(
        (call) =>
          call.operation ===
          "reserve_command"
      ),
      false
    );
  }
);

test(
  "browser supplies relationship and project facts but not business ownership or professional identity",
  () => {
    const source =
      String(
        createBusinessCustomerJob
      );

    assert.match(
      source,
      /business_customer_relationships/
    );

    assert.match(
      source,
      /contractor_profiles/
    );

    assert.doesNotMatch(
      source,
      /input\.payload\.contractorProfileId/
    );

    assert.doesNotMatch(
      source,
      /input\.payload\.professionalUserId/
    );

    assert.doesNotMatch(
      source,
      /input\.payload\.businessContactId/
    );
  }
);
