"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BOOTSTRAP_CAPABILITIES,
  CUSTOMER_BOOTSTRAP_CAPABILITIES,
  CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
  PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
  PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
  bootstrapLifecycleJob,
} = require("../server/workflow/jobFoundationService");
const {
  MANAGEMENT_CAPABILITIES,
  assignParticipantRole,
  createLifecycleAuthorityGrant,
  hasActiveLifecycleGrant,
  revokeLifecycleAuthorityGrant,
  revokeParticipantRole,
} = require("../server/authorization/lifecycleAuthorityService");

function tag(sql) {
  return String(sql).match(/(?:job_foundation|lifecycle_authority):([a-z_]+)/)?.[1] || "";
}

function createBootstrapClient({
  concernExists = true,
  customerCapabilities = [...CUSTOMER_BOOTSTRAP_CAPABILITIES],
  professionalCapabilities = [...PROFESSIONAL_BOOTSTRAP_CAPABILITIES],
  evaluationVisitCapabilities = [
    ...new Set([
      ...CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
      ...PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
    ]),
  ],
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
    async query(text, values = []) {
      const operation = tag(text);
      calls.push({ operation, values });
      if (operation === "concern_precondition") {
        return { rows: concernExists ? [{ id: "concern-1" }] : [] };
      }
      if (operation === "insert_job") {
        const row = {
          id: values[0],
          job_request_id: values[1],
          source_request_selection_id: values[2],
          source_request_relationship_id: values[3],
          created_by_user_id: values[4],
          lifecycle_contract_version: 2,
        };
        state.jobs.push(row);
        return { rows: [row] };
      }
      if (operation === "insert_participants") {
        const rows = [
          { id: values[0], job_id: values[1], request_relationship_id: values[2], user_id: values[3] },
          { id: values[4], job_id: values[1], request_relationship_id: values[2], user_id: values[6] },
        ];
        state.participants.push(...rows);
        return { rows };
      }
      if (operation === "insert_roles") {
        state.roles.push(
          { id: values[0], participant_id: values[1], job_id: values[2], role: "CUSTOMER_REPRESENTATIVE", assigned_by: values[1] },
          { id: values[5], participant_id: values[6], job_id: values[2], role: "PRIMARY_PROFESSIONAL", assigned_by: values[1] }
        );
        return { rows: [] };
      }
      if (operation === "professional_capabilities") {
        return {
          rows: professionalCapabilities.map((capability) => ({ capability })),
        };
      }
      if (operation === "customer_capabilities") {
        return {
          rows: customerCapabilities.map((capability) => ({ capability })),
        };
      }
      if (operation === "evaluation_visit_capabilities") {
        return {
          rows: evaluationVisitCapabilities.map((capability) => ({ capability })),
        };
      }
      if (operation === "insert_grant") {
        state.grants.push({
          id: values[0],
          grantee_participant_id: values[1],
          grantor_participant_id: values[2],
          job_id: values[3],
          capability: values[4],
          scope_type: "job",
        });
        return { rows: [] };
      }
      if (operation === "insert_evaluation_visit_grant") {
        state.grants.push({
          id: values[0],
          grantee_participant_id: values[1],
          grantor_participant_id: values[2],
          job_id: values[3],
          capability: values[4],
          scope_type: "evaluation_visit",
        });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${String(text)}`);
    },
  };
}

function bootstrapInput(client, overrides = {}) {
  return {
    client,
    request: { id: 41, user_id: 7, lifecycle_contract_version: 2 },
    selection: { id: "701" },
    relationship: { id: 501 },
    professionalUserId: 9,
    logger: { info() {} },
    ...overrides,
  };
}

test("canonical selection bootstraps one Job, two known participants, roles, and narrow grants", async () => {
  const client = createBootstrapClient();
  const result = await bootstrapLifecycleJob(bootstrapInput(client));

  assert.equal(result.created, true);
  assert.equal(client.state.jobs.length, 1);
  assert.equal(client.state.jobs[0].job_request_id, 41);
  assert.equal(client.state.jobs[0].source_request_relationship_id, 501);
  assert.equal(client.state.participants.length, 2);
  assert.deepEqual(client.state.participants.map((row) => row.user_id), [7, 9]);
  assert.deepEqual(client.state.roles.map((row) => row.role), [
    "CUSTOMER_REPRESENTATIVE",
    "PRIMARY_PROFESSIONAL",
  ]);
  assert.equal(client.state.grants.length, 41);
  assert.deepEqual(
    [...new Set(client.state.grants.map((row) => row.capability))].sort(),
    [
      ...new Set([
        ...BOOTSTRAP_CAPABILITIES,
        ...CUSTOMER_BOOTSTRAP_CAPABILITIES,
        ...PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
        ...CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
        ...PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
      ]),
    ].sort()
  );
  assert.deepEqual(
    client.state.grants
      .filter((row) => row.grantee_participant_id === client.state.participants[1].id)
      .map((row) => row.capability)
      .filter((capability) => PROFESSIONAL_BOOTSTRAP_CAPABILITIES.includes(capability)),
    [...PROFESSIONAL_BOOTSTRAP_CAPABILITIES]
  );
  assert.equal(
    client.state.grants.some(
      (row) =>
        row.grantee_participant_id === client.state.participants[0].id &&
        PROFESSIONAL_BOOTSTRAP_CAPABILITIES.includes(row.capability) &&
        !CUSTOMER_BOOTSTRAP_CAPABILITIES.includes(row.capability)
    ),
    false
  );
  assert.deepEqual(
    client.state.grants
      .filter((row) => row.scope_type === "evaluation_visit")
      .map((row) => row.capability)
      .sort(),
    [
      ...CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
      ...PROFESSIONAL_EVALUATION_VISIT_CAPABILITIES,
    ].sort()
  );
  assert.equal(
    client.state.grants.some((row) => /payment|procurement|invoice/.test(row.capability)),
    false
  );
  assert.deepEqual(
    client.state.grants
      .filter((row) => row.grantee_participant_id === client.state.participants[0].id)
      .map((row) => row.capability)
      .filter((capability) => CUSTOMER_BOOTSTRAP_CAPABILITIES.includes(capability)),
    [...CUSTOMER_BOOTSTRAP_CAPABILITIES]
  );
  assert.equal(
    client.state.grants.some((row) =>
      row.grantee_participant_id === client.state.participants[0].id &&
      row.capability === "quote.revise"
    ),
    false
  );
});

test("legacy selection creates no Job and v2 fails closed without concern truth", async () => {
  const legacyClient = createBootstrapClient();
  const legacy = await bootstrapLifecycleJob(bootstrapInput(legacyClient, {
    request: { id: 41, user_id: 7, lifecycle_contract_version: 1 },
  }));
  assert.equal(legacy.created, false);
  assert.equal(legacyClient.calls.length, 0);

  const missingConcernClient = createBootstrapClient({ concernExists: false });
  await assert.rejects(
    bootstrapLifecycleJob(bootstrapInput(missingConcernClient)),
    /requires preserved Reported Concern truth/
  );
  assert.deepEqual(missingConcernClient.state.jobs, []);
});

test("bootstrap does not fabricate lifecycle grants before their capability migrations", async () => {
  const client = createBootstrapClient({
    customerCapabilities: [],
    professionalCapabilities: [],
    evaluationVisitCapabilities: [],
  });
  await bootstrapLifecycleJob(bootstrapInput(client));
  assert.equal(client.state.grants.length, 6);
  assert.equal(
    client.state.grants.some((row) =>
      PROFESSIONAL_BOOTSTRAP_CAPABILITIES.includes(row.capability)
    ),
    false
  );
});

function createAuthorityClient({
  actorParticipant = true,
  grants = [],
  revokedGrantIds = [],
  now = "2026-08-09T12:00:00.000Z",
} = {}) {
  const inserts = [];
  return {
    inserts,
    async query(text, values = []) {
      const operation = tag(text);
      if (operation === "actor_participant") {
        return {
          rows: actorParticipant
            ? [{ id: "11111111-1111-4111-8111-111111111111", job_id: values[1], user_id: values[0] }]
            : [],
        };
      }
      if (operation === "active_grant") {
        const [participantId, capability, jobId, concernId, at] = values;
        const effective = new Date(at || now).getTime();
        const match = grants.find((grant) =>
          grant.grantee_participant_id === participantId &&
          grant.capability === capability &&
          grant.job_id === jobId &&
          !revokedGrantIds.includes(grant.id) &&
          new Date(grant.valid_from || "2026-01-01T00:00:00.000Z").getTime() <= effective &&
          (!grant.valid_until || new Date(grant.valid_until).getTime() > effective) &&
          (grant.scope_type === "job" ||
            (grant.scope_type === "reported_concern" && grant.scope_concern_id === concernId))
        );
        return { rows: match ? [{ id: match.id }] : [] };
      }
      inserts.push({ operation, values });
      return { rows: [{ id: values[0] }] };
    },
  };
}

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_ID = "11111111-1111-4111-8111-111111111111";
const CONCERN_ID = "33333333-3333-4333-8333-333333333333";

test("grant evaluation fails for revocation, expiry, scope mismatch, and role-only authority", async () => {
  const grant = {
    id: "grant-1",
    grantee_participant_id: PARTICIPANT_ID,
    capability: "reported_concern.clarify",
    job_id: JOB_ID,
    scope_type: "reported_concern",
    scope_concern_id: CONCERN_ID,
  };

  assert.equal(await hasActiveLifecycleGrant({
    client: createAuthorityClient({ grants: [grant] }),
    participantId: PARTICIPANT_ID,
    capability: grant.capability,
    jobId: JOB_ID,
    concernId: CONCERN_ID,
  }), true);
  assert.equal(await hasActiveLifecycleGrant({
    client: createAuthorityClient({ grants: [grant], revokedGrantIds: [grant.id] }),
    participantId: PARTICIPANT_ID,
    capability: grant.capability,
    jobId: JOB_ID,
    concernId: CONCERN_ID,
  }), false);
  assert.equal(await hasActiveLifecycleGrant({
    client: createAuthorityClient({ grants: [{ ...grant, valid_until: "2026-08-08T00:00:00.000Z" }] }),
    participantId: PARTICIPANT_ID,
    capability: grant.capability,
    jobId: JOB_ID,
    concernId: CONCERN_ID,
  }), false);
  assert.equal(await hasActiveLifecycleGrant({
    client: createAuthorityClient({ grants: [grant] }),
    participantId: PARTICIPANT_ID,
    capability: grant.capability,
    jobId: JOB_ID,
    concernId: "44444444-4444-4444-8444-444444444444",
  }), false);
  assert.equal(await hasActiveLifecycleGrant({
    client: createAuthorityClient(),
    participantId: PARTICIPANT_ID,
    capability: "quote.approve",
    jobId: JOB_ID,
  }), false);
});

test("client-facing management functions deny role and grant mutation without explicit grants", async () => {
  const client = createAuthorityClient();
  const common = {
    client,
    authenticatedActor: { id: 7 },
    jobId: JOB_ID,
    sourceEvidenceType: "governed_command",
    sourceEvidenceReference: "test",
    idempotencyKey: "test-command",
  };
  const role = await assignParticipantRole({
    ...common,
    participantId: PARTICIPANT_ID,
    role: "SITE_OCCUPANT",
    logger: { warn() {} },
  });
  const roleRevocation = await revokeParticipantRole({
    ...common,
    roleAssignmentId: "66666666-6666-4666-8666-666666666666",
    revocationReason: "Test denial",
    logger: { warn() {} },
  });
  const grant = await createLifecycleAuthorityGrant({
    ...common,
    granteeParticipantId: PARTICIPANT_ID,
    capability: "participant.read",
    logger: { warn() {} },
  });
  const revocation = await revokeLifecycleAuthorityGrant({
    ...common,
    authorityGrantId: "55555555-5555-4555-8555-555555555555",
    revocationReason: "Test denial",
    logger: { warn() {} },
  });

  assert.equal(role.code, "LIFECYCLE_AUTHORITY_REQUIRED");
  assert.equal(roleRevocation.code, "LIFECYCLE_AUTHORITY_REQUIRED");
  assert.equal(grant.code, "LIFECYCLE_AUTHORITY_REQUIRED");
  assert.equal(revocation.code, "LIFECYCLE_AUTHORITY_REQUIRED");
  assert.deepEqual(client.inserts, []);
  assert.deepEqual(Object.values(MANAGEMENT_CAPABILITIES).sort(), [
    "authority.grant.create",
    "authority.grant.revoke",
    "participant.role.assign",
    "participant.role.revoke",
  ]);
});
