"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { createVisitLifecycleFixture, createVisitTestIdentities, quiet } = require("./helpers/visitLifecycleFixture");
const { createExternalLifecycleFixture, payExternalDeposit } = require("./helpers/externalLifecycleFixture");
const { createVisitHandlers } = require("../server/workflow/visits");
const { listVisits, proposeVisit, confirmVisit, startVisit, requestVisitChange, completeVisit, getVisit } = require("../server/workflow/visitService");
const { activateApprovedWorkVisitAuthority } = require("../server/workflow/approvedWorkVisitService");
const { createOrdinaryJobEvaluation } = require("../server/authorization/evaluationService");
const { getProfessionalSchedule } = require("../server/workflow/professionalScheduleService");
const databaseUrl = process.env.JOB_EVALUATION_VISIT_DATABASE_URL;

// Reproduce Jobs selected before evaluation_visit capabilities were registered.
// All Job, selection, participant, role and Evaluation grants are created by the
// real services; only the optional bootstrap capability registry result differs.
function beforeVisitBootstrap(pool) {
  const query = client => (sql, values) => typeof sql === "string" && sql.includes("job_foundation:evaluation_visit_capabilities")
    ? Promise.resolve({ rows: [] }) : client.query(sql, values);
  return { query: query(pool), connect: async () => {
    const client = await pool.connect();
    return { query: query(client), release: () => client.release() };
  } };
}
function response() { return { statusCode: null, body: null, setHeader() {}, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; return this; } }; }

test("Job Evaluation Visit authority works before either Evaluation or Visit exists", { skip: !databaseUrl }, async t => {
  assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  t.after(() => pool.end());
  const identities = await createVisitTestIdentities(pool, randomUUID(), { requesterAccountType: "professional" });
  const fixture = await createVisitLifecycleFixture(beforeVisitBootstrap(pool), identities, randomUUID());
  const base = { pool, authenticatedActor: { id: identities.professionalId }, jobId: fixture.jobId, logger: quiet };
  const customer = { ...base, authenticatedActor: { id: identities.homeownerId } };
  const start = new Date(Date.now() + 3600000).toISOString();
  const proposal = extra => ({ ...base, purpose: "EVALUATION", scheduledStartAt: start, scheduledEndAt: null,
    timeZone: "America/New_York", locationMode: "REMOTE", idempotencyKey: randomUUID(), ...extra });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::integer FROM canonical_visits WHERE job_id=$1) AS visits,
    (SELECT count(*)::integer FROM canonical_evaluation_job_subjects WHERE job_id=$1) AS evaluations,
    (SELECT count(*)::integer FROM lifecycle_authority_grants WHERE job_id=$1 AND capability LIKE 'visit.%') AS visit_grants`, [fixture.jobId])).rows[0];
  await t.test("authenticated GET returns empty Visits and governed proposal action without writing grants", async () => {
    assert.deepEqual(await counts(), { visits: 0, evaluations: 0, visit_grants: 0 });
    const handlers = createVisitHandlers({ getPool: () => pool, sendPublicDatabaseError: ({ error }) => { throw error; } });
    const res = response();
    await handlers.listVisits({ user: base.authenticatedActor, params: { jobId: fixture.jobId } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.visits, []);
    assert.equal(res.body.actions.canPropose, true);
    assert.deepEqual(await counts(), { visits: 0, evaluations: 0, visit_grants: 0 });
    const schedule = await getProfessionalSchedule({ pool, authenticatedActor: base.authenticatedActor, view: "active" });
    assert.equal(schedule.ok, true, schedule.code);
    assert.ok(schedule.schedule.opportunities.some(item => item.jobId === fixture.jobId));
    const customerRead = await listVisits(customer);
    assert.equal(customerRead.ok, true); assert.equal(customerRead.actions.canPropose, false);
  });
  await t.test("wrong professional and other business receive no Job data or commands", async () => {
    for (const id of [identities.outsiderId, (await createVisitTestIdentities(pool, randomUUID())).professionalId]) {
      const denied = await listVisits({ ...base, authenticatedActor: { id } });
      assert.equal(denied.ok, false); assert.ok([403,404].includes(denied.status)); assert.equal(denied.visits, undefined);
      assert.equal((await proposeVisit(proposal({ authenticatedActor: { id } }))).ok, false);
    }
    assert.equal((await proposeVisit(proposal({ authenticatedActor: customer.authenticatedActor }))).status, 403);
  });
  await t.test("malformed and unknown Jobs fail closed", async () => {
    assert.equal((await listVisits({ ...base, jobId: "not-a-job" })).status, 400);
    assert.equal((await listVisits({ ...base, jobId: randomUUID() })).status, 404);
  });
  let proposed, scheduled, started;
  await t.test("same Job can propose its first Evaluation Visit with no Evaluation", async () => {
    proposed = await proposeVisit(proposal());
    assert.equal(proposed.ok, true, proposed.code); assert.equal(proposed.visit.state, "PROPOSED");
    assert.equal(proposed.visit.currentVersion, 1); assert.equal(proposed.visit.evaluationId, null);
    assert.deepEqual(await counts(), { visits: 1, evaluations: 0, visit_grants: 0 });
  });
  await t.test("Evaluation authority cannot authorize FOLLOW_UP or unapproved work", async () => {
    assert.equal((await proposeVisit(proposal({ purpose: "FOLLOW_UP" }))).status, 403);
    assert.equal((await proposeVisit(proposal({ purpose: "APPROVED_WORK" }))).ok, false);
  });
  await t.test("Start remains blocked until opposite-party confirmation", async () => {
    const denied = await startVisit({ ...base, visitId: proposed.visit.id, expectedVersion: 1, idempotencyKey: randomUUID() });
    assert.equal(denied.ok, false);
    assert.equal((await confirmVisit({ ...base, visitId: proposed.visit.id, expectedVersion: 1, idempotencyKey: randomUUID() })).ok, false);
  });
  await t.test("customer alternate time and professional acceptance retain exact versioning", async () => {
    const change = await requestVisitChange({ ...customer, visitId: proposed.visit.id, expectedVersion: 1,
      scheduledStartAt: new Date(Date.parse(start)+60000).toISOString(), scheduledEndAt: null,
      timeZone: "America/New_York", locationMode: "REMOTE", reason: "Please use this time", idempotencyKey: randomUUID() });
    assert.equal(change.ok, true, change.code);
    scheduled = await confirmVisit({ ...base, visitId: proposed.visit.id, expectedVersion: change.visit.currentVersion, idempotencyKey: randomUUID() });
    assert.equal(scheduled.ok, true, scheduled.code); assert.equal(scheduled.visit.state, "SCHEDULED");
  });
  await t.test("stale version does not start Visit; customer cannot start", async () => {
    const command = { ...base, visitId: proposed.visit.id, expectedVersion: 1, idempotencyKey: randomUUID() };
    assert.equal((await startVisit(command)).ok, false);
    assert.equal((await startVisit({ ...command, ...customer, expectedVersion: scheduled.visit.currentVersion })).ok, false);
  });
  await t.test("professional Start enables existing onsite Evaluation creation and history", async () => {
    started = await startVisit({ ...base, visitId: proposed.visit.id, expectedVersion: scheduled.visit.currentVersion,
      idempotencyKey: randomUUID(), clock: () => new Date(scheduled.visit.scheduledStartAt) });
    assert.equal(started.ok, true, started.code); assert.equal(started.visit.state, "STARTED");
    assert.equal(started.visit.currentVersion, scheduled.visit.currentVersion + 1);
    const evaluated = await createOrdinaryJobEvaluation({ ...base, visitId: proposed.visit.id, expectedVersion: 0,
      content: { serviceType: "handyman", evaluationContext: "ordinary_job", observations: "Onsite findings",
        measurements: [], findings: [], diagnosisSummary: "", limitations: "", scopeRecommendations: [],
        relevantConditions: [], supportingMediaReferences: [], internalNotes: "" }, idempotencyKey: randomUUID() });
    assert.equal(evaluated.ok, true, evaluated.code);
    assert.equal((await counts()).evaluations, 1);
    const detail = await getVisit({ ...base, visitId: proposed.visit.id });
    assert.equal(detail.ok, true); assert.ok(detail.visit.history.versions.length >= 3);
    const completed = await completeVisit({ ...base, visitId: proposed.visit.id, expectedVersion: started.visit.currentVersion,
      idempotencyKey: randomUUID(), clock: () => new Date(Date.parse(start)+3600000) });
    assert.equal(completed.ok, true, completed.code);
  });
  await t.test("Schedule history retains the same completed Evaluation Visit", async () => {
    const schedule = await getProfessionalSchedule({ pool, authenticatedActor: base.authenticatedActor, view: "history" });
    assert.equal(schedule.ok, true, schedule.code);
    assert.ok(schedule.schedule.visits.some(item => item.id === proposed.visit.id));
  });
  await t.test("closed Job denies a new Evaluation proposal but preserves history reads", async () => {
    await pool.query(`INSERT INTO canonical_job_completion_records
      (id,job_id,version,completed_by_participant_id,workstream_count,work_item_count,customer_update_count,evidence_snapshot,integrity_hash,completed_at)
      VALUES ($1,$2,1,$3,1,1,0,'{}',$4,CURRENT_TIMESTAMP)`, [randomUUID(),fixture.jobId,fixture.professionalParticipantId,"a".repeat(64)]);
    assert.equal((await listVisits(base)).actions.canPropose, false);
    assert.equal((await proposeVisit(proposal())).code, "EVALUATION_VISIT_SCHEDULING_CLOSED");
  });
  await t.test("explicit revoked Visit grants cannot be replaced by Evaluation authority", async () => {
    const modern = await createVisitLifecycleFixture(pool, identities, randomUUID());
    await pool.query(`INSERT INTO lifecycle_authority_grant_revocations
      (id,authority_grant_id,job_id,revoked_by_participant_id,revocation_reason,source_evidence_type,source_evidence_reference,idempotency_key)
      SELECT gen_random_uuid(),id,$1,$2,'Test revocation','test','r53b',id::text FROM lifecycle_authority_grants
      WHERE job_id=$1 AND grantee_participant_id=$2 AND scope_type='evaluation_visit'`, [modern.jobId,modern.professionalParticipantId]);
    assert.equal((await listVisits({ ...base, jobId: modern.jobId })).status, 403);
    assert.equal((await proposeVisit(proposal({ jobId: modern.jobId }))).status, 403);
  });
  for (const boundary of ["evaluation grant", "professional role", "customer role"]) {
    await t.test(`revoked ${boundary} fails closed without Visit grants`, async () => {
      const f = await createVisitLifecycleFixture(beforeVisitBootstrap(pool), identities, randomUUID());
      if (boundary === "evaluation grant") {
        await pool.query(`INSERT INTO lifecycle_authority_grant_revocations
          (id,authority_grant_id,job_id,revoked_by_participant_id,revocation_reason,source_evidence_type,source_evidence_reference,idempotency_key)
          SELECT gen_random_uuid(),id,$1,$2,'Test revocation','test','r53b',id::text
          FROM lifecycle_authority_grants WHERE job_id=$1 AND capability='evaluation.perform'`, [f.jobId,f.professionalParticipantId]);
      } else {
        await pool.query(`INSERT INTO participant_role_revocations
          (id,role_assignment_id,job_id,revoked_by_participant_id,revocation_reason,source_evidence_type,source_evidence_reference,idempotency_key)
          SELECT gen_random_uuid(),id,$1,$2,'Test revocation','test','r53b',id::text
          FROM participant_role_assignments WHERE job_id=$1 AND role=$3`,
          [f.jobId,f.professionalParticipantId,boundary === "professional role" ? "PRIMARY_PROFESSIONAL" : "CUSTOMER_REPRESENTATIVE"]);
      }
      assert.equal((await listVisits({ ...base, jobId: f.jobId })).status, 403);
      assert.equal((await proposeVisit(proposal({ jobId: f.jobId }))).status, 403);
    });
  }
  await t.test("Approved Work with deposit due stays blocked; paid deposit retains existing proposal", async () => {
    const f = await createExternalLifecycleFixture(pool, "EXTERNAL_CONTACT");
    const work = { pool, authenticatedActor: f.authenticatedActor, jobId: f.jobId, logger: quiet };
    const blocked = await activateApprovedWorkVisitAuthority({ ...work, quoteId: f.quoteId, idempotencyKey: randomUUID() });
    assert.equal(blocked.ok, false);
    const cmd = { ...work, purpose: "APPROVED_WORK", quoteApprovalId: f.quoteApprovalId, scheduledStartAt: start,
      scheduledEndAt: null, timeZone: "America/New_York", locationMode: "JOB_SERVICE_LOCATION", idempotencyKey: randomUUID() };
    assert.equal((await proposeVisit(cmd)).ok, false);
    await payExternalDeposit(f,13500,1);
    assert.equal((await activateApprovedWorkVisitAuthority({ ...work, quoteId: f.quoteId, idempotencyKey: randomUUID() })).ok, true);
    const allowed = await proposeVisit({ ...cmd, idempotencyKey: randomUUID() });
    assert.equal(allowed.ok, true, allowed.code);
  });
});
