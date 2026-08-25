"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  REQUEST_SERVICE_ACCOUNT_TYPES,
  REQUEST_SERVICE_AUTHORITY,
  deriveRequestServiceAuthority,
  resolveRequestServiceAuthority,
} = require("../server/requests/requestServiceAuthority");

test("REQUEST_SERVICE derives only from authoritative requester account types", () => {
  assert.deepEqual(REQUEST_SERVICE_ACCOUNT_TYPES, [
    "homeowner",
    "professional",
  ]);
  assert.deepEqual(
    deriveRequestServiceAuthority({ account_type: "homeowner" }),
    {
      authorized: true,
      authority: REQUEST_SERVICE_AUTHORITY,
      accountType: "homeowner",
    }
  );
  assert.deepEqual(
    deriveRequestServiceAuthority({ account_type: "professional" }),
    {
      authorized: true,
      authority: REQUEST_SERVICE_AUTHORITY,
      accountType: "professional",
    }
  );
  assert.equal(
    deriveRequestServiceAuthority({ account_type: "internal" }).authorized,
    false
  );
  assert.equal(
    deriveRequestServiceAuthority({ account_type: "admin" }).authorized,
    false
  );
});

test("legacy homeowner fallback applies only when account type is absent", () => {
  assert.deepEqual(
    deriveRequestServiceAuthority({ role: "homeowner" }),
    {
      authorized: true,
      authority: REQUEST_SERVICE_AUTHORITY,
      accountType: "homeowner",
    }
  );
  assert.equal(
    deriveRequestServiceAuthority({
      role: "homeowner",
      account_type: "internal",
    }).authorized,
    false
  );
  assert.equal(
    deriveRequestServiceAuthority({ role: "professional" }).authorized,
    false
  );
});

test("resolver ignores caller claims and uses the persisted account identity", async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text: String(text), values });
      return {
        rows: [{
          id: 41,
          role: "painting",
          account_type: "professional",
        }],
      };
    },
  };

  const result = await resolveRequestServiceAuthority({
    pool,
    actorUserId: 41,
  });

  assert.deepEqual(result, {
    authorized: true,
    authority: REQUEST_SERVICE_AUTHORITY,
    accountType: "professional",
  });
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].text,
    /request_service_authority:authenticated_account/
  );
  assert.deepEqual(calls[0].values, [41]);
});

test("missing, mismatched, and invalid authenticated identities fail closed", async () => {
  const missing = await resolveRequestServiceAuthority({
    pool: { async query() { return { rows: [] }; } },
    actorUserId: 41,
  });
  const mismatched = await resolveRequestServiceAuthority({
    pool: {
      async query() {
        return {
          rows: [{ id: 99, role: "homeowner", account_type: "homeowner" }],
        };
      },
    },
    actorUserId: 41,
  });
  const invalid = await resolveRequestServiceAuthority({
    pool: { async query() { throw new Error("must not query"); } },
    actorUserId: "not-an-id",
  });

  assert.equal(missing.authorized, false);
  assert.equal(mismatched.authorized, false);
  assert.equal(invalid.authorized, false);
});
