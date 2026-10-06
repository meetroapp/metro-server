"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const repository = require("../server/integrations/businessProviderConnectionRepository");
const sql = fs.readFileSync(path.join(__dirname, "../migrations/202610060001_create_business_provider_connection_authority.sql"), "utf8");

test("governed migration preserves Business FK and database pair/account uniqueness", () => {
  assert.match(sql, /REFERENCES contractor_profiles\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE \(contractor_profile_id, provider\)/);
  assert.match(sql, /UNIQUE INDEX[\s\S]*\(provider, provider_environment, provider_account_id\)/);
  assert.match(sql, /WHERE provider_account_id IS NOT NULL/);
  assert.match(sql, /provider_environment IN \('TEST', 'LIVE'\)/);
  assert.match(sql, /connection_status IN \('NOT_CONNECTED', 'CONNECTED', 'NEEDS_ATTENTION', 'UNAVAILABLE'\)/);
  assert.match(sql, /provider_account_id !~\* '\^cus_'/);
  assert.match(sql, /connection_status <> 'CONNECTED'[\s\S]*provider_account_id IS NOT NULL AND last_verified_at IS NOT NULL/);
  assert.doesNotMatch(sql, /professional_subscription|canonical_(?:quote|invoice|pre_work|visit)/);
});

test("governed update/delete guards prevent ownership/context/rebind/history erasure", () => {
  for (const field of ["id", "contractor_profile_id", "provider", "provider_environment", "created_at"]) {
    assert.ok(sql.includes(`NEW.${field} IS DISTINCT FROM OLD.${field}`));
  }
  assert.match(sql, /OLD.provider_account_id IS NOT NULL[\s\S]*NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id/);
  assert.match(sql, /NEW.last_verified_at IS NULL OR NEW.last_verified_at < OLD.last_verified_at/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /TG_OP = 'DELETE'[\s\S]*RAISE EXCEPTION/);
  assert.match(sql, /NEW.version := OLD.version \+ 1/);
  assert.match(sql, /NEW.updated_at := CURRENT_TIMESTAMP/);
});

test("repository parameters isolate Business/provider/environment on every operation", async () => {
  const calls = [];
  const database = { async query(query, params) { calls.push({ query, params }); return { rows: [] }; } };
  const scope = { businessId: 42, provider: "opaque' OR true --", providerEnvironment: "TEST" };
  const connection = { providerAccountId: "merchant_fixture", status: "NOT_CONNECTED", lastVerifiedAt: null };
  assert.equal(await repository.findConnection(database, scope), null);
  await repository.createConnection(database, scope, connection);
  assert.equal(await repository.updateConnection(database, scope, connection, 3), null);
  for (const call of calls) {
    assert.deepEqual(call.params.slice(0, 3), [42, scope.provider, "TEST"]);
    assert.equal(call.query.includes(scope.provider), false);
    assert.match(call.query, /business_provider_connections/);
    assert.doesNotMatch(call.query, /professional_subscription|canonical_quote|deposit|invoice/);
  }
  for (const index of [0, 2]) {
    assert.match(calls[index].query, /contractor_profile_id = \$1 AND provider = \$2/);
    assert.match(calls[index].query, /provider_environment = \$3/);
  }
  assert.equal(calls[2].params[6], 3);
});

test("migration runner discovers exactly one timestamped foundation without runner edits", () => {
  const { getMigrationFiles } = require("../scripts/run-migrations");
  const matches = getMigrationFiles().filter(({ filename }) => filename === "202610060001_create_business_provider_connection_authority.sql");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sql, sql);
  assert.equal(matches[0].checksum.length, 64);
});

test.skip("live PostgreSQL constraint/rollback certification deferred: no existing disposable provisioning harness; migration remains unapplied", () => {});
