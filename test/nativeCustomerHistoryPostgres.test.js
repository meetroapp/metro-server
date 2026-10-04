"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Client } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const fixture = require("./helpers/emergencyLifecycleFixture");
const dispatch = require("../server/emergency/emergencyDispatchService");
const { ensureEmergencySelectionJob } = require("../server/emergency/emergencyJobFoundationService");
const native = require("../server/workflow/nativeCustomerHistoryService");
const { createVisitLifecycleFixture } = require("./helpers/visitLifecycleFixture");

const url = process.env.NATIVE_CUSTOMER_DATABASE_URL;
const read = (pool, actor, profile, homeowner) => ({ pool, authenticatedActor: { id: actor },
  contractorProfileId: profile, homeownerUserId: homeowner });

test("native Meetro Customer History uses exact canonical completed Emergency provenance", { skip: !url }, async t => {
  assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const pool = fixture.transactionalFacade(client);
    const f = await fixture.fixture(client, pool);
    const own = read(pool, f.professional, f.profile, f.homeowner);
    const before = await native.listNativeCustomerHistory(own);
    assert.equal(before.ok, true);
    assert.equal(before.nativeCustomerHistory.jobs[0].jobId, f.job);
    assert.equal(before.nativeCustomerHistory.jobs[0].completionState, "ACTIVE");
    assert.equal((await native.listNativeCustomerHistory(read(pool, f.professional, f.profile, f.outsider))).status, 404);
    assert.equal((await native.listNativeCustomers({ pool, authenticatedActor: { id: f.outsider }, contractorProfileId: f.profile })).status, 404);

    await fixture.completedEvaluation(f);
    const quote = await fixture.issuedQuote(f);
    fixture.success(await fixture.send(f, quote));
    fixture.success(await fixture.decide(f, quote));
    fixture.success(await fixture.start(f));
    fixture.success(await dispatch.completeEmergencyWork({ pool, authenticatedUserId: f.professional, emergencyRequestId: f.request }));

    await t.test("exact owner directory, unpaid completed history and Job detail", async () => {
      const directory = await native.listNativeCustomers({ pool, authenticatedActor: { id: f.professional }, contractorProfileId: f.profile });
      assert.equal(directory.ok, true, directory.code);
      assert.deepEqual(directory.nativeCustomers.customers[0].subject, { kind: "MEETRO_ACCOUNT", contractorProfileId: f.profile, homeownerUserId: f.homeowner });
      assert.equal(directory.nativeCustomers.customers[0].completedJobCount, 1);
      const history = await native.listNativeCustomerHistory(own);
      assert.equal(history.nativeCustomerHistory.jobs[0].jobId, f.job);
      assert.equal(history.nativeCustomerHistory.jobs[0].sourceType, "emergency_request");
      assert.deepEqual(history.nativeCustomerHistory.jobs[0].approvedQuote, { currency: "USD", totalMinor: 10000 });
      const detail = await native.getNativeCustomerJobHistory({ ...own, jobId: f.job });
      assert.equal(detail.nativeCustomerJobHistory.job.jobId, f.job);
      assert.equal(detail.nativeCustomerJobHistory.job.serviceTitle, "Emergency leak");
      assert.equal((await native.getNativeCustomerJobHistory({ ...read(pool, f.professional, f.profile, f.outsider), jobId: f.job })).status, 404);
      assert.equal((await native.getNativeCustomerJobHistory({ ...own, jobId: randomUUID() })).status, 404);
      assert.equal((await native.listNativeCustomerHistory({ ...own, cursor: "not-a-cursor" })).status, 400);
      assert.equal((await native.listNativeCustomerHistory({ ...own, contractorProfileId: f.profile + 1 })).status, 404);
    });

    await t.test("normal relationship and Conversation closure preserve history", async () => {
      await client.query("SAVEPOINT closed_history");
      try {
        await client.query("UPDATE request_relationships SET status = 'closed' WHERE id = $1", [f.relationship]);
        await client.query("UPDATE conversations SET status = 'closed' WHERE id = $1", [f.conversation]);
        assert.equal((await native.listNativeCustomerHistory(own)).nativeCustomerHistory.jobs[0].jobId, f.job);
      } finally { await client.query("ROLLBACK TO SAVEPOINT closed_history"); }
    });

    await t.test("explicit role revocation denies history while routine expiration does not", async () => {
      const role = (await client.query(`SELECT role.id, role.participant_id FROM participant_role_assignments role
        JOIN relationship_participants participant ON participant.id = role.participant_id
        WHERE role.job_id = $1 AND role.role = 'PRIMARY_PROFESSIONAL'`, [f.job])).rows[0];
      const customer = (await client.query(`SELECT id FROM relationship_participants WHERE job_id = $1 AND user_id = $2`, [f.job, f.homeowner])).rows[0];
      await client.query("SAVEPOINT expired_history");
      try {
        await client.query(`INSERT INTO participant_role_assignments
          (id, participant_id, job_id, role, assigned_by_participant_id, valid_from, valid_until,
           source_evidence_type, source_evidence_reference, idempotency_key)
          VALUES ($1, $2, $3, 'PRIMARY_PROFESSIONAL', $4,
            CURRENT_TIMESTAMP - interval '2 days', CURRENT_TIMESTAMP - interval '1 day',
            'emergency_selection', $5, $6)`,
        [randomUUID(), role.participant_id, f.job, customer.id,
          `emergency:${f.request}:selection:${f.relationship}`, randomUUID()]);
        assert.equal((await native.listNativeCustomerHistory(own)).nativeCustomerHistory.jobs[0].jobId, f.job);
      } finally { await client.query("ROLLBACK TO SAVEPOINT expired_history"); }
      await client.query("SAVEPOINT revoked_history");
      try {
        await client.query(`INSERT INTO participant_role_revocations
          (id, role_assignment_id, job_id, revoked_by_participant_id, revocation_reason,
            source_evidence_type, source_evidence_reference, idempotency_key)
          VALUES ($1, $2, $3, $4, 'Security denial', 'test', 'task63j4c', $5)`,
        [randomUUID(), role.id, f.job, customer.id, randomUUID()]);
        assert.equal((await native.listNativeCustomerHistory(own)).status, 404);
      } finally { await client.query("ROLLBACK TO SAVEPOINT revoked_history"); }
    });

    await t.test("ordinary selection and Emergency group only for the exact authenticated subject", async () => {
      const ordinaryPool = { ...pool,
        async query(sql, values) {
          const result = await pool.query(sql, values);
          if (/^BEGIN\b/.test(sql)) await client.query("SET CONSTRAINTS ALL DEFERRED");
          return result;
        },
        async connect() { return ordinaryPool; },
      };
      const ordinary = await createVisitLifecycleFixture(ordinaryPool,
        { homeownerId: f.homeowner, professionalId: f.professional }, randomUUID());
      await client.query(`INSERT INTO canonical_job_completion_records
        (id, job_id, version, completed_by_participant_id, workstream_count, work_item_count,
         customer_update_count, evidence_snapshot, integrity_hash, completed_at)
        VALUES ($1, $2, 1, $3, 1, 0, 0, '{}'::jsonb, $4, CURRENT_TIMESTAMP)`,
      [randomUUID(), ordinary.jobId, ordinary.professionalParticipantId, "a".repeat(64)]);
      const directory = await native.listNativeCustomers({ pool, authenticatedActor: { id: f.professional }, contractorProfileId: f.profile });
      assert.equal(directory.nativeCustomers.customers.length, 1);
      assert.equal(directory.nativeCustomers.customers[0].completedJobCount, 2);
      assert.deepEqual(directory.nativeCustomers.customers[0].sourceTypes, ["emergency_request", "ordinary_request_selection"]);
      const history = await native.listNativeCustomerHistory(own);
      assert.deepEqual(new Set(history.nativeCustomerHistory.jobs.map(row => row.jobId)), new Set([f.job, ordinary.jobId]));
      assert.equal((await native.getNativeCustomerJobHistory({ ...own, jobId: ordinary.jobId })).ok, true);
      const first = await native.listNativeCustomerHistory({ ...own, limit: 1 });
      assert.equal(first.nativeCustomerHistory.jobs.length, 1);
      const cursor = first.nativeCustomerHistory.pagination.nextCursor;
      assert.ok(cursor);
      const secondPage = await native.listNativeCustomerHistory({ ...own, limit: 1, cursor });
      assert.equal(secondPage.nativeCustomerHistory.jobs.length, 1);
      assert.notEqual(secondPage.nativeCustomerHistory.jobs[0].jobId, first.nativeCustomerHistory.jobs[0].jobId);
      assert.equal((await native.listNativeCustomerHistory({ ...own, homeownerUserId: f.outsider, cursor })).status, 400);
      assert.equal((await native.listNativeCustomerHistory({ ...own, contractorProfileId: f.profile + 1, cursor })).status, 400);
    });

    await t.test("same display name remains separate and repeated reads perform no writes", async () => {
      const second = await fixture.fixture(client, pool, { dispatchToArrival: false });
      const directory = await native.listNativeCustomers({ pool, authenticatedActor: { id: f.professional }, contractorProfileId: f.profile });
      assert.equal(directory.nativeCustomers.customers.length, 1);
      const secondDirectory = await native.listNativeCustomers({ pool, authenticatedActor: { id: second.professional }, contractorProfileId: second.profile });
      assert.equal(secondDirectory.nativeCustomers.customers.length, 1);
      assert.equal(secondDirectory.nativeCustomers.customers[0].displayName, directory.nativeCustomers.customers[0].displayName);
      assert.notEqual(secondDirectory.nativeCustomers.customers[0].subject.homeownerUserId, f.homeowner);
      const tables = ["business_contacts", "business_customer_relationships", "job_customer_parties", "canonical_job_completion_records"];
      const counts = async () => {
        const result = [];
        for (const table of tables) result.push((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
        return result;
      };
      const baseline = await counts();
      await native.listNativeCustomers({ pool, authenticatedActor: { id: f.professional }, contractorProfileId: f.profile });
      await native.listNativeCustomerHistory(own);
      await native.getNativeCustomerJobHistory({ ...own, jobId: f.job });
      assert.deepEqual(await counts(), baseline);
    });

    await t.test("same homeowner is isolated across two exact contractor profiles", async () => {
      const otherBusiness = await fixture.fixture(client, pool, { dispatchToArrival: false });
      const emergency = (await client.query(`INSERT INTO emergency_requests
        (homeowner_id, category, service_domain, service_specialty, title, location_text, status, assigned_at)
        VALUES ($1, 'plumbing', 'home_services', 'plumbing_repair', 'Second business repair',
          'Test location', 'assigned', CURRENT_TIMESTAMP) RETURNING *`, [f.homeowner])).rows[0];
      const relationship = (await client.query(`INSERT INTO request_relationships
        (post_id, emergency_request_id, homeowner_id, contractor_id, professional_user_id, status)
        VALUES (NULL, $1, $2, $3, $4, 'active') RETURNING *`,
      [emergency.id, f.homeowner, otherBusiness.profile, otherBusiness.professional])).rows[0];
      const conversation = (await client.query(`INSERT INTO conversations
        (relationship_id, homeowner_id, contractor_id, professional_user_id)
        VALUES ($1, $2, $3, $4) RETURNING id`,
      [relationship.id, f.homeowner, otherBusiness.profile, otherBusiness.professional])).rows[0];
      const created = await ensureEmergencySelectionJob({ client, emergencyRequest: emergency, relationship,
        logger: { info() {}, warn() {} } });
      const second = { ...otherBusiness, homeowner: f.homeowner, request: emergency.id,
        relationship: relationship.id, conversation: conversation.id, job: created.job.id, pool };
      fixture.success(await dispatch.markEmergencyEnRoute({ pool, authenticatedUserId: second.professional, emergencyRequestId: second.request }));
      fixture.success(await dispatch.markEmergencyArrived({ pool, authenticatedUserId: second.professional, emergencyRequestId: second.request }));
      await fixture.completedEvaluation(second);
      const quote = await fixture.issuedQuote(second);
      fixture.success(await fixture.send(second, quote));
      fixture.success(await fixture.decide(second, quote));
      fixture.success(await fixture.start(second));
      fixture.success(await dispatch.completeEmergencyWork({ pool, authenticatedUserId: second.professional, emergencyRequestId: second.request }));
      const firstHistory = await native.listNativeCustomerHistory(own);
      const secondHistory = await native.listNativeCustomerHistory(read(pool, second.professional, second.profile, f.homeowner));
      assert.ok(firstHistory.nativeCustomerHistory.jobs.some(row => row.jobId === f.job));
      assert.ok(!firstHistory.nativeCustomerHistory.jobs.some(row => row.jobId === second.job));
      assert.deepEqual(secondHistory.nativeCustomerHistory.jobs.map(row => row.jobId), [second.job]);
      assert.equal((await native.getNativeCustomerJobHistory({ ...own, jobId: second.job })).status, 404);
      assert.equal((await native.getNativeCustomerJobHistory({ ...read(pool, second.professional, second.profile, f.homeowner), jobId: f.job })).status, 404);
    });

    await t.test("same-name different homeowners under one business remain separate subjects", async () => {
      const otherHomeowner = (await client.query(`INSERT INTO users
        (username, email, password_hash, role, account_type)
        VALUES ('homeowner', $1, 'test-hash', 'homeowner', 'homeowner') RETURNING id`,
      [`${randomUUID()}@example.test`])).rows[0].id;
      const emergency = (await client.query(`INSERT INTO emergency_requests
        (homeowner_id, category, service_domain, service_specialty, title, location_text, status, assigned_at)
        VALUES ($1, 'plumbing', 'home_services', 'plumbing_repair', 'Other homeowner repair',
          'Test location', 'assigned', CURRENT_TIMESTAMP) RETURNING *`, [otherHomeowner])).rows[0];
      const relationship = (await client.query(`INSERT INTO request_relationships
        (post_id, emergency_request_id, homeowner_id, contractor_id, professional_user_id, status)
        VALUES (NULL, $1, $2, $3, $4, 'active') RETURNING *`,
      [emergency.id, otherHomeowner, f.profile, f.professional])).rows[0];
      await client.query(`INSERT INTO conversations
        (relationship_id, homeowner_id, contractor_id, professional_user_id)
        VALUES ($1, $2, $3, $4)`, [relationship.id, otherHomeowner, f.profile, f.professional]);
      const otherJob = await ensureEmergencySelectionJob({ client, emergencyRequest: emergency, relationship,
        logger: { info() {}, warn() {} } });
      const directory = await native.listNativeCustomers({ pool, authenticatedActor: { id: f.professional }, contractorProfileId: f.profile });
      const rows = directory.nativeCustomers.customers.filter(row => row.displayName === "homeowner");
      assert.equal(rows.length, 2);
      assert.deepEqual(new Set(rows.map(row => row.subject.homeownerUserId)), new Set([f.homeowner, otherHomeowner]));
      const otherHistory = await native.listNativeCustomerHistory(read(pool, f.professional, f.profile, otherHomeowner));
      assert.deepEqual(otherHistory.nativeCustomerHistory.jobs.map(row => row.jobId), [otherJob.job.id]);
      assert.deepEqual(otherHistory.nativeCustomerHistory.jobs.map(row => row.completionState), ["ACTIVE"]);
    });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
