"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const {
  selectHomeownerAvailableEmergencyProfessional,
} = require(
  "../server/emergency/emergencySelectionService"
);

function normalizedSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim();
}

function emergency(overrides = {}) {
  return {
    id: 41,
    homeowner_id: 7,
    category: "home_repair",
    service_domain: "home_services",
    service_specialty:
      "electrical",
    title:
      "Partial power outage",
    description:
      "Several rooms have lost power.",
    location_text:
      "Cape Coral, FL",
    status:
      "ready_for_distribution",
    requested_at:
      "requested",
    created_at:
      "created",
    updated_at:
      "updated",
    assigned_at: null,
    expired_at: null,
    disposition: "continue",
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: 80,
    user_id: 9,
    business_name:
      "Cape Electric",
    category: "electrical",
    image_url: "",
    profile_details: {
      service_specialties: [
        "electrical",
      ],
      service_area:
        "Cape Coral",
      city:
        "Cape Coral",
      postal_code:
        "33904",
      available_now: true,
      dispatch_ready: true,
    },
    ...overrides,
  };
}

function directRelationship(
  overrides = {}
) {
  return {
    id: 151,
    post_id: null,
    emergency_request_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    emergency_authority_source:
      "available_now_direct_select",
    status: "active",
    responded_at: null,
    created_at: "created",
    accepted_at: "accepted",
    declined_at: null,
    withdrawn_at: null,
    closed_at: null,
    updated_at: "updated",
    ...overrides,
  };
}

function responseRelationship(
  overrides = {}
) {
  return directRelationship({
    emergency_authority_source:
      "professional_response",
    status: "pending",
    responded_at: "responded",
    accepted_at: null,
    ...overrides,
  });
}

function createPool({
  emergencyRows = [emergency()],
  exactRelationshipRows = [],
  profileRows = [profile()],
  activeRows = [],
  competingRows = [
    { id: 301 },
    { id: 302 },
  ],
  insertedRows = [
    directRelationship(),
  ],
  assignedRows = [
    {
      id: 41,
      homeowner_id: 7,
      status: "assigned",
      assigned_at: "assigned",
      updated_at:
        "assigned-updated",
    },
  ],
  throwOn,
} = {}) {
  const calls = [];

  const client = {
    released: false,

    async query(sql, values = []) {
      const source =
        normalizedSql(sql);

      calls.push({
        sql: source,
        values,
      });

      if (
        throwOn &&
        source.includes(throwOn)
      ) {
        throw new Error(
          "private persistence failure"
        );
      }

      if (
        source === "BEGIN" ||
        source === "COMMIT" ||
        source === "ROLLBACK"
      ) {
        return { rows: [] };
      }

      if (
        source.includes(
          "FROM emergency_requests"
        )
      ) {
        return {
          rows: emergencyRows,
        };
      }

      if (
        source.includes(
          "FROM request_relationships"
        ) &&
        source.includes(
          "contractor_id = $2"
        )
      ) {
        return {
          rows:
            exactRelationshipRows,
        };
      }

      if (
        source.includes(
          "FROM contractor_profiles"
        )
      ) {
        return {
          rows: profileRows,
        };
      }

      if (
        source.includes(
          "FROM request_relationships"
        ) &&
        source.includes(
          "status = 'active'"
        )
      ) {
        return {
          rows: activeRows,
        };
      }

      if (
        source.startsWith(
          "UPDATE request_relationships"
        )
      ) {
        return {
          rows: competingRows,
        };
      }

      if (
        source.startsWith(
          "INSERT INTO request_relationships"
        )
      ) {
        return {
          rows: insertedRows,
        };
      }

      if (
        source.startsWith(
          "UPDATE emergency_requests"
        )
      ) {
        return {
          rows: assignedRows,
        };
      }

      throw new Error(
        `Unexpected query: ${source}`
      );
    },

    release() {
      this.released = true;
    },
  };

  const pool = {
    calls,

    async query() {
      throw new Error(
        "Pool query should not be used directly."
      );
    },

    async connect() {
      return client;
    },

    client,
  };

  return pool;
}

function conversationResult() {
  return {
    ok: true,
    conversation: {
      id: 91,
      relationship_id: 151,
      status: "active",
    },
  };
}

test(
  "invalid request and professional IDs fail before database access",
  async () => {
    const pool =
      createPool();

    for (const args of [
      {
        emergencyRequestId:
          "invalid",
        contractorProfileId: 80,
      },
      {
        emergencyRequestId: 41,
        contractorProfileId:
          "invalid",
      },
    ]) {
      const result =
        await selectHomeownerAvailableEmergencyProfessional({
          pool,
          homeownerUserId: 7,
          ...args,
        });

      assert.equal(
        result.ok,
        false
      );

      assert.equal(
        result.status,
        400
      );
    }

    assert.equal(
      pool.calls.length,
      0
    );
  }
);

test(
  "successful direct selection creates truthful active provenance and reuses canonical downstream authority",
  async () => {
    const pool =
      createPool();

    const conversationCalls = [];
    const jobCalls = [];

    const result =
      await selectHomeownerAvailableEmergencyProfessional({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
        contractorProfileId: 80,

        async ensureConversation(
          args
        ) {
          conversationCalls.push(
            args
          );
          return conversationResult();
        },

        async ensureSelectionJob(
          args
        ) {
          jobCalls.push(args);
          return {
            ok: true,
          };
        },
      });

    assert.equal(
      result.ok,
      true
    );

    assert.equal(
      result.code,
      "EMERGENCY_AVAILABLE_PROFESSIONAL_SELECTED"
    );

    assert.equal(
      result.alreadySelected,
      false
    );

    assert.equal(
      result.declinedResponseCount,
      2
    );

    const insert =
      pool.calls.find(
        ({ sql }) =>
          sql.startsWith(
            "INSERT INTO request_relationships"
          )
      );

    assert.ok(insert);

    assert.match(
      insert.sql,
      /'available_now_direct_select'/
    );

    assert.match(
      insert.sql,
      /'active'/
    );

    assert.match(
      insert.sql,
      /NULL, CURRENT_TIMESTAMP/
    );

    assert.deepEqual(
      insert.values,
      [41, 7, 80, 9]
    );

    const profileLock =
      pool.calls.find(
        ({ sql }) =>
          sql.includes(
            "FROM contractor_profiles"
          )
      );

    assert.match(
      profileLock.sql,
      /FOR SHARE/
    );

    assert.equal(
      conversationCalls.length,
      1
    );

    assert.equal(
      jobCalls.length,
      1
    );

    assert.equal(
      pool.client.released,
      true
    );

    assert.ok(
      pool.calls.some(
        ({ sql }) =>
          sql === "COMMIT"
      )
    );
  }
);

test(
  "availability is revalidated at selection time and stale cards fail before relationship mutation",
  async () => {
    const stale = profile({
      profile_details: {
        ...profile()
          .profile_details,
        available_now: false,
      },
    });

    const pool =
      createPool({
        profileRows: [stale],
      });

    const result =
      await selectHomeownerAvailableEmergencyProfessional({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
        contractorProfileId: 80,
      });

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      result.status,
      409
    );

    assert.equal(
      result.code,
      "EMERGENCY_PROFESSIONAL_NO_LONGER_AVAILABLE"
    );

    assert.equal(
      pool.calls.some(
        ({ sql }) =>
          sql.startsWith(
            "INSERT INTO request_relationships"
          )
      ),
      false
    );

    assert.equal(
      pool.calls.some(
        ({ sql }) =>
          sql.startsWith(
            "UPDATE emergency_requests"
          )
      ),
      false
    );
  }
);

test(
  "a professional response that arrives before selection is never converted into direct-select authority",
  async () => {
    const pool =
      createPool({
        exactRelationshipRows: [
          responseRelationship(),
        ],
      });

    const result =
      await selectHomeownerAvailableEmergencyProfessional({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
        contractorProfileId: 80,
      });

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      result.status,
      409
    );

    assert.equal(
      result.code,
      "EMERGENCY_PROFESSIONAL_RESPONSE_AVAILABLE"
    );

    assert.equal(
      pool.calls.some(
        ({ sql }) =>
          sql.startsWith(
            "INSERT INTO request_relationships"
          )
      ),
      false
    );
  }
);

test(
  "same direct-selected professional replay is idempotent after assignment",
  async () => {
    const pool =
      createPool({
        emergencyRows: [
          emergency({
            status: "assigned",
            assigned_at:
              "assigned",
          }),
        ],
        exactRelationshipRows: [
          directRelationship(),
        ],
      });

    let jobCount = 0;

    const result =
      await selectHomeownerAvailableEmergencyProfessional({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
        contractorProfileId: 80,

        async ensureConversation() {
          return conversationResult();
        },

        async ensureSelectionJob() {
          jobCount += 1;
          return {
            ok: true,
          };
        },
      });

    assert.equal(
      result.ok,
      true
    );

    assert.equal(
      result.code,
      "EMERGENCY_AVAILABLE_PROFESSIONAL_ALREADY_SELECTED"
    );

    assert.equal(
      result.alreadySelected,
      true
    );

    assert.equal(
      jobCount,
      1
    );

    assert.equal(
      pool.calls.some(
        ({ sql }) =>
          sql.startsWith(
            "INSERT INTO request_relationships"
          )
      ),
      false
    );
  }
);

test(
  "assigned to another authority fails closed",
  async () => {
    const pool =
      createPool({
        emergencyRows: [
          emergency({
            status: "assigned",
          }),
        ],
        exactRelationshipRows: [],
      });

    const result =
      await selectHomeownerAvailableEmergencyProfessional({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
        contractorProfileId: 80,
      });

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      result.code,
      "EMERGENCY_REQUEST_ALREADY_ASSIGNED"
    );
  }
);

test(
  "transaction failures roll back and release",
  async () => {
    const pool =
      createPool({
        throwOn:
          "INSERT INTO request_relationships",
      });

    await assert.rejects(
      () =>
        selectHomeownerAvailableEmergencyProfessional({
          pool,
          homeownerUserId: 7,
          emergencyRequestId: 41,
          contractorProfileId: 80,
        }),
      /private persistence failure/
    );

    assert.ok(
      pool.calls.some(
        ({ sql }) =>
          sql === "ROLLBACK"
      )
    );

    assert.equal(
      pool.client.released,
      true
    );
  }
);
