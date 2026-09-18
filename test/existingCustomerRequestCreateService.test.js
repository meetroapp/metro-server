"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  createJobRequest,
  createJobRequestFingerprint,
} = require("../server/requests/jobRequestCreateService");

const {
  validateRequestPayload,
} = require("../server/requests/requestLifecycle");

const HOMEOWNER_ID = 7;
const PROFESSIONAL_ID = 9;
const CONTRACTOR_PROFILE_ID = 80;

const RELATIONSHIP_ID =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const OTHER_RELATIONSHIP_ID =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const IDEMPOTENCY_KEY =
  "11111111-1111-4111-8111-111111111111";

function requestPayload(overrides = {}) {
  return {
    title: "Paint the guest room",
    description:
      "Fresh request for a new guest room painting project.",
    category: "painting",
    request_category: "painting",
    service_domain: "home_services",
    service_specialty: "painting",
    location: "Cape Coral, FL 33904",
    location_intake_mode: "exact_on_file",
    service_address_line1: "123 Palm Ave",
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    unit_number: "",
    access_notes: "",
    request_photos: [],
    request_origin: "existing_customer_request",
    source_meetro_relationship_id: RELATIONSHIP_ID,
    ...overrides,
  };
}

function createPool({
  relationshipHomeownerId = HOMEOWNER_ID,
  relationshipId = RELATIONSHIP_ID,
} = {}) {
  const state = {
    posts: [],
    idempotency: [],
    relationships: [],
    conversations: [],
    jobs: [],
    jobParticipants: [],
    jobRoles: [],
    jobGrants: [],
    concerns: [],
    leadProfileReads: 0,
  };

  let snapshot = null;

  const relationship = {
    id: relationshipId,
    homeowner_user_id: relationshipHomeownerId,
    contractor_profile_id: CONTRACTOR_PROFILE_ID,
    professional_user_id: PROFESSIONAL_ID,
  };

  const pool = {
    async query(text, values = []) {
      const sql = String(text)
        .replace(/\s+/g, " ")
        .trim();

      if (sql === "BEGIN") {
        snapshot = JSON.parse(JSON.stringify(state));
        return { rows: [] };
      }

      if (sql === "COMMIT") {
        snapshot = null;
        return { rows: [] };
      }

      if (sql === "ROLLBACK") {
        if (snapshot) {
          for (const key of Object.keys(state)) {
            state[key] = snapshot[key];
          }
        }
        snapshot = null;
        return { rows: [] };
      }

      if (
        sql.includes(
          "request_service_authority:authenticated_account"
        )
      ) {
        return {
          rows: [
            {
              id: HOMEOWNER_ID,
              account_type: "homeowner",
              role: "homeowner",
            },
          ],
        };
      }

      if (
        sql.includes(
          "job_request_create:existing_customer_authority"
        )
      ) {
        const [requestedRelationshipId, actorUserId] =
          values;

        return {
          rows:
            requestedRelationshipId === relationship.id &&
            Number(actorUserId) ===
              Number(relationship.homeowner_user_id)
              ? [relationship]
              : [],
        };
      }

      if (
        sql.includes(
          "existing_customer_request:create_relationship"
        )
      ) {
        const [
          postId,
          homeownerId,
          contractorId,
          professionalUserId,
          sourceMeetroRelationshipId,
        ] = values;

        const conflict = state.relationships.find(
          (row) =>
            Number(row.post_id) === Number(postId) &&
            Number(row.contractor_id) ===
              Number(contractorId)
        );

        if (conflict) {
          const exact =
            Number(conflict.homeowner_id) ===
              Number(homeownerId) &&
            Number(conflict.professional_user_id) ===
              Number(professionalUserId) &&
            conflict.professional_response_id == null &&
            conflict.ordinary_authority_source ===
              "existing_customer_request" &&
            conflict.source_meetro_relationship_id ===
              sourceMeetroRelationshipId;

          return {
            rows: exact
              ? [
                  {
                    ...conflict,
                    created: false,
                  },
                ]
              : [],
          };
        }

        const row = {
          id: state.relationships.length + 501,
          post_id: postId,
          emergency_request_id: null,
          homeowner_id: homeownerId,
          contractor_id: contractorId,
          professional_user_id:
            professionalUserId,
          status: "active",
          introduction_text: "",
          professional_response_id: null,
          ordinary_authority_source:
            "existing_customer_request",
          current_version: 1,
          closure_reason: null,
          source_meetro_relationship_id:
            sourceMeetroRelationshipId,
          responded_at:
            "2026-09-16T10:00:00.000Z",
          accepted_at:
            "2026-09-16T10:00:00.000Z",
          created_at:
            "2026-09-16T10:00:00.000Z",
          updated_at:
            "2026-09-16T10:00:00.000Z",
        };

        state.relationships.push(row);

        return {
          rows: [
            {
              ...row,
              created: true,
            },
          ],
        };
      }

      if (
        sql.includes(
          "FROM request_relationships"
        ) &&
        sql.includes(
          "status = 'active'"
        ) &&
        sql.includes("FOR UPDATE")
      ) {
        return {
          rows: state.relationships
            .filter(
              (row) =>
                Number(row.id) ===
                  Number(values[0]) &&
                row.status === "active"
            )
            .slice(0, 1),
        };
      }

      if (
        sql.includes("WITH inserted AS") &&
        sql.includes(
          "INSERT INTO conversations"
        )
      ) {
        const [
          relationshipId,
          homeownerId,
          contractorId,
          professionalUserId,
        ] = values;

        const existing =
          state.conversations.find(
            (row) =>
              Number(row.relationship_id) ===
              Number(relationshipId)
          );

        if (existing) {
          return {
            rows: [
              {
                ...existing,
                created: false,
              },
            ],
          };
        }

        const row = {
          id: state.conversations.length + 801,
          relationship_id: relationshipId,
          homeowner_id: homeownerId,
          contractor_id: contractorId,
          professional_user_id:
            professionalUserId,
          request_selection_id: null,
          status: "active",
          homeowner_archived_at: null,
          professional_archived_at: null,
          closed_at: null,
          created_at:
            "2026-09-16T10:00:00.000Z",
          updated_at:
            "2026-09-16T10:00:00.000Z",
        };

        state.conversations.push(row);

        return {
          rows: [
            {
              ...row,
              created: true,
            },
          ],
        };
      }

      if (
        sql.includes(
          "INSERT INTO conversation_participant_state"
        )
      ) {
        return {
          rows: [],
          rowCount: 2,
        };
      }

      if (
        sql.includes(
          "existing_customer_job:concern_precondition"
        )
      ) {
        return {
          rows:
            state.concerns.length > 0
              ? [{ id: state.concerns[0].id }]
              : [],
        };
      }

      if (
        sql.includes(
          "existing_customer_job:existing"
        )
      ) {
        const existing = state.jobs.find(
          (row) =>
            Number(row.job_request_id) ===
              Number(values[0]) &&
            Number(
              row.source_request_relationship_id
            ) === Number(values[1])
        );

        if (!existing) {
          return { rows: [] };
        }

        const homeowner =
          state.jobParticipants.find(
            (row) =>
              row.job_id === existing.id &&
              Number(row.user_id) ===
                Number(values[2])
          );

        const professional =
          state.jobParticipants.find(
            (row) =>
              row.job_id === existing.id &&
              Number(row.user_id) ===
                Number(values[3])
          );

        return {
          rows: [
            {
              ...existing,
              homeowner_participant_id:
                homeowner?.id || null,
              professional_participant_id:
                professional?.id || null,
            },
          ],
        };
      }

      if (
        sql.includes(
          "existing_customer_job:insert_job"
        )
      ) {
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

      if (
        sql.includes(
          "existing_customer_job:insert_participants"
        )
      ) {
        const rows = [
          {
            id: values[0],
            job_id: values[1],
            request_relationship_id:
              values[2],
            user_id: values[3],
          },
          {
            id: values[4],
            job_id: values[1],
            request_relationship_id:
              values[2],
            user_id: values[6],
          },
        ];

        state.jobParticipants.push(...rows);

        return { rows };
      }

      if (
        sql.includes(
          "existing_customer_job:insert_roles"
        )
      ) {
        state.jobRoles.push(
          {
            participant_id: values[1],
            role:
              "CUSTOMER_REPRESENTATIVE",
          },
          {
            participant_id: values[6],
            role:
              "PRIMARY_PROFESSIONAL",
          }
        );

        return { rows: [] };
      }

      if (
        sql.includes(
          "existing_customer_job:customer_capabilities"
        ) ||
        sql.includes(
          "existing_customer_job:professional_capabilities"
        ) ||
        sql.includes(
          "existing_customer_job:evaluation_visit_capabilities"
        )
      ) {
        return {
          rows: (values[0] || []).map(
            (capability) => ({
              capability,
            })
          ),
        };
      }

      if (
        sql.includes(
          "existing_customer_job:insert_grant"
        ) ||
        sql.includes(
          "existing_customer_job:insert_evaluation_visit_grant"
        )
      ) {
        state.jobGrants.push({
          participant_id: values[1],
          capability: values[4],
        });

        return { rows: [] };
      }

      if (
        sql.includes(
          "job_request_create:idempotency_reserve"
        )
      ) {
        const [
          id,
          actorUserId,
          commandName,
          commandScope,
          key,
          fingerprint,
        ] = values;

        const existing = state.idempotency.find(
          (row) =>
            Number(row.actor_user_id) ===
              Number(actorUserId) &&
            row.command_name === commandName &&
            row.command_scope === commandScope &&
            row.idempotency_key === key
        );

        if (existing) return { rows: [] };

        const row = {
          id,
          actor_user_id: actorUserId,
          command_name: commandName,
          command_scope: commandScope,
          idempotency_key: key,
          request_fingerprint: fingerprint,
          post_id: null,
          completed_at: null,
        };

        state.idempotency.push(row);
        return { rows: [row] };
      }

      if (
        sql.includes(
          "job_request_create:idempotency_existing"
        )
      ) {
        const [
          actorUserId,
          commandName,
          commandScope,
          key,
        ] = values;

        return {
          rows: state.idempotency
            .filter(
              (row) =>
                Number(row.actor_user_id) ===
                  Number(actorUserId) &&
                row.command_name === commandName &&
                row.command_scope === commandScope &&
                row.idempotency_key === key
            )
            .slice(0, 1),
        };
      }

      if (
        sql.includes("job_request_create:insert_post")
      ) {
        const id = state.posts.length + 1;

        const row = {
          id,
          user_id: values[0],
          title: values[1],
          description: values[2],
          category: values[3],
          request_category: values[4],
          service_domain: values[5],
          service_specialty: values[6],
          location: values[7],
          unit_number: values[8],
          access_notes: values[9],
          status: "open",
          image_url: values[10],
          request_photos: JSON.parse(values[11] || "[]"),
          location_intake_mode: values[12],
          location_normalization_status: values[13],
          service_address_line1: values[14],
          service_city: values[15],
          service_region: values[16],
          service_postal_code: values[17],
          service_country_code: values[18],
          discovery_area_label: values[19],
          lifecycle_contract_version:
            Number(values[20] || 1),
          request_origin: values[21],
          target_contractor_profile_id: values[22],
          target_professional_user_id: values[23],
          source_meetro_relationship_id: values[24],
          created_at:
            "2026-09-16T10:00:00.000Z",
          updated_at:
            "2026-09-16T10:00:00.000Z",
          cancelled_at: null,
        };

        state.posts.push(row);
        return { rows: [row] };
      }

      if (sql.includes("reported_concern:create")) {
        const row = {
          id: values[0],
          job_request_id: values[1],
          reporter_user_id: values[2],
          original_text: values[3],
          source_evidence_id: values[4],
          sequence: values[5],
          integrity_hash: values[6],
          reported_at:
            "2026-09-16T10:00:00.000Z",
          created_at:
            "2026-09-16T10:00:00.000Z",
        };

        state.concerns.push(row);
        return { rows: [row] };
      }

      if (
        sql.includes(
          "job_request_create:idempotency_complete"
        )
      ) {
        const [id, postId] = values;

        const row = state.idempotency.find(
          (item) => item.id === id
        );

        if (!row || row.completed_at) {
          return { rows: [] };
        }

        row.post_id = postId;
        row.completed_at =
          "2026-09-16T10:00:01.000Z";

        return { rows: [row] };
      }

      if (
        sql.includes("job_request_create:owned_post")
      ) {
        return {
          rows: state.posts
            .filter(
              (row) =>
                Number(row.id) === Number(values[0]) &&
                Number(row.user_id) ===
                  Number(values[1])
            )
            .slice(0, 1),
        };
      }

      if (
        sql.includes(
          "opportunity_alert:eligible_professional_profiles"
        )
      ) {
        state.leadProfileReads += 1;
        return { rows: [] };
      }

      throw new Error(
        `Unexpected query: ${sql}`
      );
    },

    async connect() {
      return {
        query: (...args) => pool.query(...args),
        release() {},
      };
    },
  };

  return {
    pool,
    state,
  };
}

function lifecycleV2Env() {
  return {
    JOB_LIFECYCLE_V2_ENABLED: "true",
    JOB_LIFECYCLE_V2_READINESS:
      "MC-JOB-LIFECYCLE-004B",
  };
}

test("validator accepts only relationship ID as browser repeat-customer authority", () => {
  const valid = validateRequestPayload(
    requestPayload()
  );

  assert.equal(valid.ok, true);
  assert.equal(
    valid.request.request_origin,
    "existing_customer_request"
  );
  assert.equal(
    valid.request.source_meetro_relationship_id,
    RELATIONSHIP_ID
  );

  const missing = validateRequestPayload(
    requestPayload({
      source_meetro_relationship_id: "",
    })
  );

  assert.equal(missing.ok, false);
  assert.equal(
    missing.code,
    "EXISTING_CUSTOMER_RELATIONSHIP_REQUIRED"
  );

  const marketplaceSpoof = validateRequestPayload(
    requestPayload({
      request_origin: "marketplace",
    })
  );

  assert.equal(marketplaceSpoof.ok, false);
  assert.equal(
    marketplaceSpoof.code,
    "MARKETPLACE_REQUEST_SOURCE_INVALID"
  );

  for (const forbidden of [
    "target_contractor_profile_id",
    "target_professional_user_id",
    "contractorProfileId",
    "professionalUserId",
  ]) {
    const result = validateRequestPayload(
      requestPayload({
        [forbidden]:
          forbidden.includes("professional") ? 9 : 80,
      })
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      "UNSUPPORTED_REQUEST_FIELDS"
    );
  }
});

test("fingerprint distinguishes marketplace from exact existing-customer provenance", () => {
  const existingA =
    createJobRequestFingerprint({
      request: requestPayload(),
    });

  const existingB =
    createJobRequestFingerprint({
      request: requestPayload({
        source_meetro_relationship_id:
          OTHER_RELATIONSHIP_ID,
      }),
    });

  const marketplace =
    createJobRequestFingerprint({
      request: {
        ...requestPayload(),
        request_origin: "marketplace",
        source_meetro_relationship_id: null,
      },
    });

  assert.notEqual(existingA, existingB);
  assert.notEqual(existingA, marketplace);
});

test("existing-customer create resolves exact professional server-side and persists only resolved target authority", async () => {
  const fixture = createPool();

  const result = await createJobRequest({
    pool: fixture.pool,
    authenticatedActor: {
      id: HOMEOWNER_ID,
    },
    payload: requestPayload(),
    idempotencyKey: IDEMPOTENCY_KEY,
    env: lifecycleV2Env(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(
    result.code,
    "JOB_REQUEST_CREATED"
  );

  assert.equal(
    result.post.request_origin,
    "existing_customer_request"
  );
  assert.equal(
    result.post.source_meetro_relationship_id,
    RELATIONSHIP_ID
  );

  assert.equal(
    Object.hasOwn(
      result.post,
      "target_contractor_profile_id"
    ),
    false
  );

  assert.equal(
    Object.hasOwn(
      result.post,
      "target_professional_user_id"
    ),
    false
  );

  assert.equal(fixture.state.posts.length, 1);

  const stored = fixture.state.posts[0];

  assert.equal(
    stored.request_origin,
    "existing_customer_request"
  );
  assert.equal(
    stored.target_contractor_profile_id,
    CONTRACTOR_PROFILE_ID
  );
  assert.equal(
    stored.target_professional_user_id,
    PROFESSIONAL_ID
  );
  assert.equal(
    stored.source_meetro_relationship_id,
    RELATIONSHIP_ID
  );

  assert.equal(
    fixture.state.concerns.length,
    1
  );

  assert.equal(
    fixture.state.leadProfileReads,
    0
  );

  assert.equal(
    fixture.state.relationships.length,
    1
  );

  assert.equal(
    fixture.state.relationships[0]
      .ordinary_authority_source,
    "existing_customer_request"
  );

  assert.equal(
    fixture.state.relationships[0]
      .professional_response_id,
    null
  );

  assert.equal(
    fixture.state.relationships[0]
      .source_meetro_relationship_id,
    RELATIONSHIP_ID
  );

  assert.equal(
    fixture.state.conversations.length,
    1
  );

  assert.equal(
    fixture.state.conversations[0]
      .request_selection_id,
    null
  );

  assert.equal(
    result.relationship.authoritySource,
    "existing_customer_request"
  );

  assert.equal(
    result.relationship.status,
    "active"
  );

  assert.equal(
    result.conversation.status,
    "active"
  );

  assert.equal(
    result.job.sourceType,
    "existing_customer_request"
  );

  assert.equal(
    fixture.state.jobs.length,
    1
  );

  assert.equal(
    fixture.state.jobs[0]
      .source_request_selection_id,
    null
  );

  assert.equal(
    fixture.state.jobs[0]
      .source_request_relationship_id,
    fixture.state.relationships[0].id
  );

  assert.equal(
    fixture.state.jobs[0]
      .contractor_profile_id,
    null
  );

  assert.equal(
    fixture.state.jobParticipants.length,
    2
  );
});

test("relationship must belong to the authenticated homeowner", async () => {
  const fixture = createPool({
    relationshipHomeownerId: 8,
  });

  const result = await createJobRequest({
    pool: fixture.pool,
    authenticatedActor: {
      id: HOMEOWNER_ID,
    },
    payload: requestPayload(),
    idempotencyKey: IDEMPOTENCY_KEY,
    env: lifecycleV2Env(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(
    result.code,
    "EXISTING_CUSTOMER_RELATIONSHIP_NOT_FOUND"
  );

  assert.equal(fixture.state.posts.length, 0);
  assert.equal(
    fixture.state.idempotency.length,
    0
  );
  assert.equal(fixture.state.concerns.length, 0);
  assert.equal(
    fixture.state.leadProfileReads,
    0
  );
});

test("unknown relationship fails before idempotency reservation", async () => {
  const fixture = createPool();

  const result = await createJobRequest({
    pool: fixture.pool,
    authenticatedActor: {
      id: HOMEOWNER_ID,
    },
    payload: requestPayload({
      source_meetro_relationship_id:
        OTHER_RELATIONSHIP_ID,
    }),
    idempotencyKey: IDEMPOTENCY_KEY,
    env: lifecycleV2Env(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(
    result.code,
    "EXISTING_CUSTOMER_RELATIONSHIP_NOT_FOUND"
  );

  assert.equal(fixture.state.posts.length, 0);
  assert.equal(
    fixture.state.idempotency.length,
    0
  );
});

test("exact retry replays the same targeted request without another post", async () => {
  const fixture = createPool();

  const input = {
    pool: fixture.pool,
    authenticatedActor: {
      id: HOMEOWNER_ID,
    },
    payload: requestPayload(),
    idempotencyKey: IDEMPOTENCY_KEY,
    env: lifecycleV2Env(),
  };

  const first =
    await createJobRequest(input);

  const replay =
    await createJobRequest(input);

  assert.equal(first.ok, true);
  assert.equal(first.status, 201);

  assert.equal(replay.ok, true);
  assert.equal(replay.status, 200);
  assert.equal(
    replay.code,
    "JOB_REQUEST_REPLAYED"
  );
  assert.equal(
    replay.replayed,
    true
  );

  assert.equal(
    replay.post.id,
    first.post.id
  );

  assert.equal(fixture.state.posts.length, 1);
  assert.equal(
    fixture.state.idempotency.length,
    1
  );
  assert.equal(
    fixture.state.leadProfileReads,
    0
  );
});

test("same idempotency key cannot be reused for another Meetro relationship", async () => {
  const fixture = createPool();

  const first = await createJobRequest({
    pool: fixture.pool,
    authenticatedActor: {
      id: HOMEOWNER_ID,
    },
    payload: requestPayload(),
    idempotencyKey: IDEMPOTENCY_KEY,
    env: lifecycleV2Env(),
  });

  assert.equal(first.ok, true);

  const changed = await createJobRequest({
    pool: fixture.pool,
    authenticatedActor: {
      id: HOMEOWNER_ID,
    },
    payload: requestPayload({
      source_meetro_relationship_id:
        OTHER_RELATIONSHIP_ID,
    }),
    idempotencyKey: IDEMPOTENCY_KEY,
    env: lifecycleV2Env(),
  });

  /*
   * The second relationship is not owned/known in this fixture,
   * so source authority fails before command reservation/replay.
   * This is intentionally stronger than allowing the idempotency
   * layer to discover a browser-supplied authority conflict.
   */
  assert.equal(changed.ok, false);
  assert.equal(
    changed.code,
    "EXISTING_CUSTOMER_RELATIONSHIP_NOT_FOUND"
  );

  assert.equal(fixture.state.posts.length, 1);
  assert.equal(
    fixture.state.idempotency.length,
    1
  );
});

test("runtime source contains no Saved Professional or business-private customer authority", () => {
  const source = readFileSync(
    "server/requests/jobRequestCreateService.js",
    "utf8"
  );

  assert.match(
    source,
    /FROM meetro_customer_business_relationships relationships/
  );

  assert.match(
    source,
    /relationships\.id = \$1[\s\S]*relationships\.homeowner_user_id = \$2/
  );

  assert.doesNotMatch(
    source,
    /homeowner_saved_professionals/
  );

  assert.doesNotMatch(
    source,
    /business_contacts/
  );

  assert.doesNotMatch(
    source,
    /business_customer_relationships/
  );
});

test("existing-customer creation skips marketplace lead projection", () => {
  const source = readFileSync(
    "server/requests/jobRequestCreateService.js",
    "utf8"
  );

  assert.match(
    source,
    /if \(request\.request_origin === "marketplace"\) \{[\s\S]*projectNewLeadAlertsWithClient/
  );
});

test("runtime delegates governed direct communication and lifecycle Job without fabricating Professional Response or Request Selection authority", () => {
  const source = readFileSync(
    "server/requests/jobRequestCreateService.js",
    "utf8"
  );

  assert.match(
    source,
    /establishExistingCustomerRequestConversation/
  );

  assert.match(
    source,
    /bootstrapExistingCustomerRequestJob/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO professional_responses/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO request_selections/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO jobs/
  );
});
