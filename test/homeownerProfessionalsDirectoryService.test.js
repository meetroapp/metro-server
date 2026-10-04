"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  listHomeownerProfessionals,
} = require("../server/relationships/homeownerProfessionalsDirectoryService");

function fakePool() {
  const calls = [];

  return {
    calls,

    async query(sql, values) {
      calls.push({ sql, values });

      if (sql.includes("homeowner_professionals_directory:saved")) {
        return {
          rows: [
            {
              saved_professional_id:
                "11111111-1111-4111-8111-111111111111",
              contractor_profile_id: 21,
              professional_user_id: 201,
              saved_at: "2026-09-15T20:00:00.000Z",
              business_name: "Saved Plumbing",
              category: "Plumbing",
              image_url: "https://example.test/saved.jpg",
              worked_with: false,
            },
            {
              saved_professional_id:
                "22222222-2222-4222-8222-222222222222",
              contractor_profile_id: 22,
              professional_user_id: 202,
              saved_at: "2026-09-14T20:00:00.000Z",
              business_name: "Repeat Electric",
              category: "Electrical",
              image_url: "",
              worked_with: true,
            },
          ],
        };
      }

      if (sql.includes("homeowner_professionals_directory:worked_with")) {
        return {
          rows: [
            {
              meetro_relationship_id:
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              contractor_profile_id: 22,
              professional_user_id: 202,
              established_at: "2026-08-01T12:00:00.000Z",
              last_selected_at: "2026-09-10T15:00:00.000Z",
              request_count: 3,
              job_count: 2,
              business_name: "Repeat Electric",
              category: "Electrical",
              image_url: "",
              is_saved: true,
            },
          ],
        };
      }

      throw new Error("Unexpected test query.");
    },
  };
}

test("lists Saved and Worked With as separate homeowner collections", async () => {
  const pool = fakePool();

  const result = await listHomeownerProfessionals({
    pool,
    homeownerUserId: 77,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.code, "HOMEOWNER_PROFESSIONALS_LISTED");

  assert.equal(result.saved.length, 2);
  assert.equal(result.workedWith.length, 1);

  assert.deepEqual(result.saved[0], {
    savedProfessionalId:
      "11111111-1111-4111-8111-111111111111",
    contractorProfileId: 21,
    professionalUserId: 201,
    businessName: "Saved Plumbing",
    category: "Plumbing",
    imageUrl: "https://example.test/saved.jpg",
    savedAt: "2026-09-15T20:00:00.000Z",
    workedWith: false,
  });

  assert.deepEqual(result.workedWith[0], {
    meetroRelationshipId:
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    contractorProfileId: 22,
    professionalUserId: 202,
    businessName: "Repeat Electric",
    category: "Electrical",
    imageUrl: "",
    establishedAt: "2026-08-01T12:00:00.000Z",
    lastSelectedAt: "2026-09-10T15:00:00.000Z",
    requestCount: 3,
    jobCount: 2,
    saved: true,
  });
});

test("directory reads are scoped to the authenticated homeowner", async () => {
  const pool = fakePool();

  await listHomeownerProfessionals({
    pool,
    homeownerUserId: 77,
  });

  assert.equal(pool.calls.length, 2);

  for (const call of pool.calls) {
    assert.deepEqual(call.values, [77]);
    assert.match(call.sql, /homeowner_user_id\s*=\s*\$1/);
  }
});

test("Worked With derives from exact Meetro selection history, not private business customer data", async () => {
  const pool = fakePool();

  await listHomeownerProfessionals({
    pool,
    homeownerUserId: 77,
  });

  const worked = pool.calls.find((call) =>
    call.sql.includes("homeowner_professionals_directory:worked_with")
  );

  assert.ok(worked);

  assert.match(
    worked.sql,
    /FROM meetro_customer_business_relationships relationships/
  );

  assert.match(
    worked.sql,
    /relationships\.established_from_request_selection_id/
  );

  assert.match(
    worked.sql,
    /origin_selection\.selected_by_user_id\s*=\s*relationships\.homeowner_user_id/
  );

  assert.match(
    worked.sql,
    /history_selections\.selected_by_user_id\s*=\s*relationships\.homeowner_user_id/
  );

  assert.match(
    worked.sql,
    /history_selections\.contractor_id\s*=\s*relationships\.contractor_profile_id/
  );

  assert.match(
    worked.sql,
    /history_selections\.professional_user_id\s*=\s*relationships\.professional_user_id/
  );

  assert.match(
    worked.sql,
    /jobs\.source_request_selection_id\s*=\s*history_selections\.id/
  );

  assert.match(
    worked.sql,
    /jobs\.source_type\s*=\s*'ordinary_request_selection'/
  );

  assert.doesNotMatch(worked.sql, /job_customer_parties/i);
  assert.doesNotMatch(worked.sql, /business_contact_id/i);
  assert.doesNotMatch(worked.sql, /business_customer_relationship_id/i);
  assert.doesNotMatch(worked.sql, /email_normalized/i);
  assert.doesNotMatch(worked.sql, /phone_normalized/i);
});

test("legacy selection history counts even when no lifecycle Job exists", async () => {
  const pool = fakePool();

  const result = await listHomeownerProfessionals({
    pool,
    homeownerUserId: 77,
  });

  assert.equal(result.workedWith[0].requestCount, 3);
  assert.equal(result.workedWith[0].jobCount, 2);
  assert.ok(
    result.workedWith[0].requestCount >
      result.workedWith[0].jobCount
  );
});

test("Saved Professional does not imply Worked With authority", async () => {
  const pool = fakePool();

  const result = await listHomeownerProfessionals({
    pool,
    homeownerUserId: 77,
  });

  assert.equal(result.saved[0].workedWith, false);
  assert.equal(result.saved[1].workedWith, true);

  assert.equal(
    result.saved[1].contractorProfileId,
    result.workedWith[0].contractorProfileId
  );

  assert.equal(
    result.saved[1].professionalUserId,
    result.workedWith[0].professionalUserId
  );
});

test("invalid homeowner identity fails before database reads", async () => {
  const pool = fakePool();

  const result = await listHomeownerProfessionals({
    pool,
    homeownerUserId: "invalid",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, "HOMEOWNER_ID_INVALID");
  assert.equal(pool.calls.length, 0);
});
