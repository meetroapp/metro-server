"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listAuthorizedProfessionalJobs,
  professionalJobPickerInternals,
} = require("../server/workflow/professionalJobPickerService");

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function eligibleJob(overrides = {}) {
  return {
    job_id: JOB_ID,
    title: "Repair interior wall",
    service_domain: "Home Services",
    service_specialty: "Handyman",
    service_city: "Orlando",
    discovery_area_label: "Orlando, FL",
    customer_name: "Paul Becker",
    source_type: "ordinary_request_selection",
    service_address_line1: "1 Private Street",
    service_postal_code: "32801",
    customer_email: "private@example.com",
    internal_cost_minor: 10000,
    ...overrides,
  };
}

function poolForActor(ownerActorId = 77, rows = [eligibleJob()]) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("professional_job_picker:list")) {
        return { rows: params[0] === ownerActorId ? rows : [] };
      }
      throw new Error(`Unexpected query: ${text.slice(0, 100)}`);
    },
  };
}

test("authorized professional sees an eligible active Job through a read-only projection", async () => {
  const pool = poolForActor();
  const result = await listAuthorizedProfessionalJobs({
    pool,
    authenticatedActor: { id: 77 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "PROFESSIONAL_JOBS_LOADED");
  assert.deepEqual(result.jobs, [{
    jobId: JOB_ID,
    title: "Repair interior wall",
    serviceDomain: "Home Services",
    serviceSpecialty: "Handyman",
    lifecycleStatus: "ACTIVE",
    customerLabel: "Paul Becker",
    city: "Orlando",
    serviceArea: "Orlando, FL",
    sourceLabel: "Job Request",
  }]);
  assert.deepEqual(pool.calls.map(({ text }) => text), [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    pool.calls[1].text,
    "COMMIT",
  ]);
});

test("another professional cannot see an actor-owned eligible Job", async () => {
  const result = await listAuthorizedProfessionalJobs({
    pool: poolForActor(),
    authenticatedActor: { id: 88 },
  });
  assert.deepEqual(result.jobs, []);
});

test("picker SQL excludes revoked PRIMARY_PROFESSIONAL assignments", () => {
  const sql = professionalJobPickerInternals.AUTHORIZED_JOBS_SQL;
  assert.match(sql, /roles\.role = 'PRIMARY_PROFESSIONAL'/);
  assert.match(sql, /roles\.valid_from <= CURRENT_TIMESTAMP/);
  assert.match(sql, /role_revocations\.id IS NULL/);
});

test("picker SQL requires active quote.create and quote.scope.manage grants", () => {
  const sql = professionalJobPickerInternals.AUTHORIZED_JOBS_SQL;
  assert.ok(professionalJobPickerInternals.REQUIRED_CAPABILITIES.includes("quote.create"));
  assert.ok(professionalJobPickerInternals.REQUIRED_CAPABILITIES.includes("quote.scope.manage"));
  assert.match(sql, /unnest\(\$2::text\[\]\)/);
  assert.match(sql, /grants\.capability = required\.capability/);
  assert.match(sql, /grant_revocations\.id IS NULL/);
  assert.match(sql, /grants\.valid_from <= CURRENT_TIMESTAMP/);
});

test("picker SQL also requires quote.read and participant.read", () => {
  assert.ok(professionalJobPickerInternals.REQUIRED_CAPABILITIES.includes("quote.read"));
  assert.ok(professionalJobPickerInternals.REQUIRED_CAPABILITIES.includes("participant.read"));
});

test("picker SQL excludes inactive relationships, ended selections, and completed Jobs", () => {
  const sql = professionalJobPickerInternals.AUTHORIZED_JOBS_SQL;
  assert.match(sql, /relationships\.status = 'active'/);
  assert.match(sql, /selections\.ended_at IS NULL/);
  assert.match(sql, /NOT EXISTS[\s\S]*canonical_job_completion_records/);
});

test("picker read performs zero mutation", async () => {
  const pool = poolForActor();
  await listAuthorizedProfessionalJobs({
    pool,
    authenticatedActor: { id: 77 },
  });
  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
});

test("picker projection excludes exact address and unrelated private data", () => {
  const projection = professionalJobPickerInternals.jobProjection(eligibleJob());
  assert.deepEqual(Object.keys(projection).sort(), [
    "city",
    "customerLabel",
    "jobId",
    "lifecycleStatus",
    "serviceArea",
    "serviceDomain",
    "serviceSpecialty",
    "sourceLabel",
    "title",
  ]);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /Private Street|32801|private@example|internal_cost/i);
});
