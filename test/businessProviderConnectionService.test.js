"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { getBusinessProviderConnection: read, recordBusinessProviderConnection: record } = require("../server/integrations/businessProviderConnectionService");

const membership = (id = 42, role = "OWNER") => ({ contractor_profile_id: id, role, business_name: "Fixture Business" });
const stored = (overrides = {}) => ({ id: "fixture-connection", contractor_profile_id: 42, provider: "STRIPE_PAYMENTS", provider_environment: "TEST", provider_account_id: "merchant_fixture", connection_status: "CONNECTED", last_verified_at: "2026-10-01T00:00:00Z", version: 1, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...overrides });
function database({ rows = [membership()], connection = stored(), error = null } = {}) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM business_team_memberships/.test(sql)) return { rows };
    assert.match(sql, /business_provider_connections/);
    assert.doesNotMatch(sql, /professional_subscription|deposit|invoice|canonical_quote|canonical_visit/);
    if (error) throw Object.assign(new Error("suppressed fixture failure"), { code: error });
    return { rows: connection ? [connection] : [] };
  } };
}
const input = (pool, overrides = {}) => ({ pool, authenticatedActor: { id: 7 }, provider: "STRIPE_PAYMENTS", providerEnvironment: "TEST", ...overrides });
const snapshot = (overrides = {}) => ({ providerAccountId: "merchant_fixture", status: "CONNECTED", lastVerifiedAt: "2026-10-01T00:00:00Z", ...overrides });

test("Owner/Manager internal reads use exact Business/provider/environment predicates", async () => {
  for (const role of ["OWNER", "MANAGER"]) {
    const pool = database({ rows: [membership(42, role)] });
    const result = await read(input(pool, { businessId: 99, body: { businessId: 99 }, query: { businessId: 99 } }));
    assert.equal(result.ok, true);
    assert.equal(result.connection.businessId, 42);
    assert.deepEqual(pool.calls[1].params, [42, "STRIPE_PAYMENTS", "TEST"]);
    assert.match(pool.calls[1].sql, /contractor_profile_id = \$1 AND provider = \$2/);
    assert.match(pool.calls[1].sql, /provider_environment = \$3/);
  }
});

test("invalid authentication/no Business/multiple Businesses/non-manager fail before connection access", async () => {
  for (const [actor, rows, status, count] of [
    [null, [membership()], 401, 0], [{ id: 7 }, [], 403, 1],
    [{ id: 7 }, [membership(), membership(99)], 409, 1],
    [{ id: 7 }, [membership(42, "BOOKKEEPER_FINANCE")], 403, 1],
    [{ id: 7 }, [membership(42, "FIELD_EMPLOYEE")], 403, 1],
  ]) {
    const pool = database({ rows });
    const result = await read(input(pool, { authenticatedActor: actor }));
    assert.equal(result.status, status);
    assert.equal(pool.calls.length, count);
  }
});

test("missing connection is null; foreign Business/provider/environment rows fail closed", async () => {
  assert.equal((await read(input(database({ connection: null })))).connection, null);
  for (const overrides of [{ contractor_profile_id: 99 }, { provider: "QUICKBOOKS" }, { provider_environment: "LIVE" }]) {
    const result = await read(input(database({ connection: stored(overrides) })));
    assert.equal(result.ok, false);
    assert.equal(result.code, "BUSINESS_PROVIDER_CONNECTION_INVALID_AUTHORITY");
  }
});

test("supported internal states are preserved without public provider projection", async () => {
  for (const status of ["NOT_CONNECTED", "CONNECTED", "NEEDS_ATTENTION", "UNAVAILABLE"]) {
    const result = await read(input(database({ connection: stored({ connection_status: status }) })));
    assert.equal(result.connection.status, status);
  }
});

test("unsupported provider/environment/status and client-owned fields cannot produce persistence", async () => {
  for (const changes of [
    { provider: "STRIPE" }, { provider: "anything' OR true --" }, { providerEnvironment: "PRODUCTION" },
    { connection: snapshot({ status: "COMING_SOON" }) },
    { connection: snapshot({ status: "PAID" }) },
    { connection: snapshot({ businessId: 99 }) },
    { connection: snapshot({ stripe_customer_id: "cus_fixture" }) },
    { connection: snapshot({ providerAccountId: "cus_fixture" }) },
    { connection: snapshot({ providerAccountId: null }) },
    { connection: snapshot({ lastVerifiedAt: null }) },
    { connection: snapshot({ lastVerifiedAt: "invalid" }) },
    { connection: snapshot({ providerAccountId: "contains spaces" }) },
    { expectedVersion: -1 }, { expectedVersion: "1" },
  ]) {
    const pool = database();
    const result = await record(input(pool, { connection: snapshot(), expectedVersion: 0, ...changes }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(pool.calls.length, 1);
  }
});

test("recording internal facts only writes provider persistence; creates and compare-version updates are scoped", async () => {
  for (const expectedVersion of [0, 1]) {
    const pool = database();
    const result = await record(input(pool, { connection: snapshot(), expectedVersion, body: { businessId: 99 }, query: { businessId: 99 } }));
    assert.equal(result.ok, true);
    assert.equal(result.connection.providerAccountId, "merchant_fixture");
    assert.deepEqual(pool.calls[1].params.slice(0, 3), [42, "STRIPE_PAYMENTS", "TEST"]);
    if (expectedVersion) {
      assert.equal(pool.calls[1].params[6], 1);
      assert.match(pool.calls[1].sql, /version = \$7/);
      assert.match(pool.calls[1].sql, /provider_account_id IS NULL OR provider_account_id = \$4/);
    }
  }
});

test("duplicate/rebind/constraint failures and stale update conflicts are bounded", async () => {
  for (const error of ["23505", "23503", "23514", "P0001"]) {
    const result = await record(input(database({ error }), { connection: snapshot(), expectedVersion: 0 }));
    assert.deepEqual(result, { ok: false, status: 409, code: "BUSINESS_PROVIDER_CONNECTION_CONFLICT", message: "Business provider connection authority is unavailable." });
  }
  const result = await record(input(database({ connection: null }), { connection: snapshot(), expectedVersion: 1 }));
  assert.equal(result.status, 409);
});

test("subscription Customer fields cannot create a merchant from billing data", async () => {
  const pool = database({ connection: null });
  const result = await read(input(pool, { subscription: { stripe_customer_id: "cus_fixture" } }));
  assert.equal(result.connection, null);
  assert.equal(pool.calls.length, 2);
  assert.ok(pool.calls.every(({ sql }) => !/professional_subscription/.test(sql)));
});
