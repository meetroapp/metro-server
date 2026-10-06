"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONNECTED_SERVICES_READ_ROLES,
  getConnectedServices,
} = require("../server/integrations/connectedServicesService");

function poolWith(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("Connected Services read authority is limited to active Owner and Manager roles", () => {
  assert.deepEqual(CONNECTED_SERVICES_READ_ROLES, [
    "OWNER",
    "MANAGER",
  ]);
});

test("authenticated Owner receives the exact provider-neutral Coming Soon projection", async () => {
  const pool = poolWith([
    {
      contractor_profile_id: 42,
      role: "OWNER",
      business_name: "Lantern Services",
    },
  ]);

  const result = await getConnectedServices({
    pool,
    authenticatedActor: { id: 7 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "CONNECTED_SERVICES_LOADED");
  assert.equal(result.contractVersion, 1);
  assert.deepEqual(result.business, {
    businessId: 42,
    displayName: "Lantern Services",
    role: "OWNER",
  });
  assert.equal(result.providers.length, 4);
  assert.equal(
    result.providers.every(
      ({ status }) => status === "COMING_SOON"
    ),
    true
  );

  assert.equal(pool.calls.length, 1);
  assert.match(
    pool.calls[0].sql,
    /business_team_memberships/
  );
  assert.match(pool.calls[0].sql, /status = 'ACTIVE'/);
  assert.match(
    pool.calls[0].sql,
    /role IN \('OWNER', 'MANAGER'\)/
  );
  assert.deepEqual(pool.calls[0].params, [7]);
});

test("missing authentication fails before database access", async () => {
  const pool = poolWith([]);

  const result = await getConnectedServices({
    pool,
    authenticatedActor: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "AUTHENTICATION_REQUIRED");
  assert.equal(pool.calls.length, 0);
});

test("non-manager Business roles cannot read Connected Services", async () => {
  const pool = poolWith([]);

  const result = await getConnectedServices({
    pool,
    authenticatedActor: { id: 21 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(
    result.code,
    "CONNECTED_SERVICES_BUSINESS_AUTHORITY_REQUIRED"
  );
});

test("multiple manageable Businesses fail closed until exact Business selection exists", async () => {
  const pool = poolWith([
    {
      contractor_profile_id: 42,
      role: "OWNER",
      business_name: "Business A",
    },
    {
      contractor_profile_id: 99,
      role: "MANAGER",
      business_name: "Business B",
    },
  ]);

  const result = await getConnectedServices({
    pool,
    authenticatedActor: { id: 7 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(
    result.code,
    "CONNECTED_SERVICES_BUSINESS_SELECTION_REQUIRED"
  );
});

test("shared authority extraction preserves Manager and rejects injected non-manager rows", async () => {
  const shared = require("../server/integrations/connectedServicesBusinessAuthority");
  for (const role of ["MANAGER", "BOOKKEEPER_FINANCE", "FIELD_EMPLOYEE"]) {
    const rows = [{ contractor_profile_id: 42, role, business_name: "Business" }];
    const publicResult = await getConnectedServices({ pool: poolWith(rows), authenticatedActor: { id: 7 } });
    const internal = await shared.getConnectedServicesBusinessAuthority({ pool: poolWith(rows), authenticatedActor: { id: 7 } });
    assert.equal(publicResult.ok, role === "MANAGER");
    if (publicResult.ok) assert.deepEqual(publicResult.business, internal.business);
    else assert.deepEqual(publicResult, internal);
  }
});

test("R2 ignores requested Business and persisted/subscription state and keeps exact provider projection", async () => {
  const { getConnectedServiceProviders } = require("../server/integrations/connectedServicesRegistry");
  const pool = poolWith([{ contractor_profile_id: 42, role: "OWNER", business_name: " Business " }]);
  const result = await getConnectedServices({
    pool, authenticatedActor: { id: 7 }, businessId: 99,
    body: { businessId: 99 }, query: { businessId: 99 },
    connection: { status: "CONNECTED" }, subscription: { stripe_customer_id: "cus_fixture" },
  });
  assert.deepEqual(result, {
    ok: true, status: 200, code: "CONNECTED_SERVICES_LOADED", contractVersion: 1,
    business: { businessId: 42, displayName: "Business", role: "OWNER" },
    providers: getConnectedServiceProviders(),
  });
  assert.equal(pool.calls.length, 1);
  assert.doesNotMatch(pool.calls[0].sql, /business_provider_connections|professional_subscription/);
});
