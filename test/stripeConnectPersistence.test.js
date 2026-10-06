"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes, createHmac, timingSafeEqual } = require("node:crypto");
const operations = require("../server/integrations/stripeConnectOperationRepository");
const { createProvider, API_VERSION } = require("../server/integrations/stripeConnectProvider");

function account({ id = "acct_fixture", ready = true, metadata = {} } = {}) {
  return { id,object: "v2.core.account",livemode: false,closed: false,applied_configurations: ["merchant"],dashboard: "full",
    identity: { country: "us" },defaults: { currency: "usd",responsibilities: { fees_collector: "stripe",losses_collector: "stripe",requirements_collector: "stripe" } },
    configuration: { merchant: { applied: true,capabilities: { card_payments: { status: ready ? "active" : "pending" },stripe_balance: { payouts: { status: ready ? "active" : "pending" } } } } },
    requirements: { entries: [] },future_requirements: { entries: [] },metadata };
}
function fakeProvider({ scopeId = "platform_fixture/sandbox_fixture", ready = true } = {}) {
  const memory = new Map(); const calls = { create: 0,physicalCreations: 0,retrieve: 0,link: 0 };
  // Synthetic signature material is generated in memory, never written/logged.
  const material = randomBytes(32);
  const signature = (body,seconds) => `${seconds}.${createHmac("sha256",material).update(String(seconds)).update(".").update(body).digest("hex")}`;
  const hooks = { account: null,create: null,retrieve: null };
  function verify(body,header) {
    const [seconds,digest] = header.split(".");
    if (!/^\d+$/.test(seconds) || !/^[0-9a-f]{64}$/.test(digest || "") || Math.abs(Date.now()/1000-Number(seconds))>300) throw new Error("INVALID_SIGNATURE");
    const expected = signature(body,seconds).split(".")[1];
    if (!timingSafeEqual(Buffer.from(digest,"hex"),Buffer.from(expected,"hex"))) throw new Error("INVALID_SIGNATURE");
    return JSON.parse(body);
  }
  const client = { isFakeProvider: true,v2: { core: {
    accounts: {
      async create(params,options) {
        calls.create++;
        if (!memory.has(options.idempotencyKey)) { calls.physicalCreations++; memory.set(options.idempotencyKey,account({ ready,metadata: params.metadata })); }
        const result = structuredClone(memory.get(options.idempotencyKey)); hooks.account = result;
        if (hooks.create) await hooks.create(params,options,result);
        return result;
      },
      async retrieve(id) { calls.retrieve++; if (hooks.retrieve) return hooks.retrieve(id); return structuredClone(hooks.account || account({ id,ready })); },
    },
    accountLinks: { async create() { calls.link++; return { url: "https://example.invalid/onboarding",expires_at: 1 }; } },
  } },parseEventNotification: verify,webhooks: { constructEvent: verify } };
  return { provider: createProvider({ fakeClient: client,providerScopeId: scopeId }),client,calls,hooks,
    sign: body => signature(body,Math.floor(Date.now()/1000)),signAt: signature };
}
async function harness(t) {
  const socket = process.env.MEETRO_CONNECT_CERT_SOCKET;
  if (!socket) { t.skip("requires explicit isolated local PostgreSQL certification socket"); return null; }
  const actual = fs.realpathSync(socket);
  assert.match(actual,/^\/private\/tmp\/meetro-r3-step4-pg-[A-Za-z0-9_-]+\/socket$/);
  const { Pool } = require("pg");
  const schema = "connect_cert_"+randomUUID().replaceAll("-","");
  const pool = new Pool({ host: actual,port: 55432,user: "meetro_step4",database: "meetro_test_stripe_connect_r3_step4",options: `-c search_path=${schema},public`,max: 10 });
  t.after(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY);
    CREATE TABLE contractor_profiles(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),business_name TEXT);
    CREATE TABLE business_team_memberships(id SERIAL PRIMARY KEY,contractor_profile_id INTEGER REFERENCES contractor_profiles(id),
      user_id INTEGER REFERENCES users(id),role TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users VALUES (1),(2),(3),(4);
    INSERT INTO contractor_profiles VALUES (10,1,'Fixture Business'),(20,3,'Other Fixture');
    INSERT INTO business_team_memberships(contractor_profile_id,user_id,role,status) VALUES
      (10,1,'OWNER','ACTIVE'),(10,2,'MANAGER','ACTIVE'),(10,3,'OWNER','ACTIVE'),(10,4,'FIELD_EMPLOYEE','ACTIVE');`);
  for (const name of ["202610060001_create_business_provider_connection_authority.sql","202610060002_create_stripe_connect_onboarding_event_authority.sql"]) {
    await pool.query(fs.readFileSync(path.join(__dirname,"..","migrations",name),"utf8"));
  }
  const scope = { businessId: 10,environment: "TEST",providerScopeId: "platform_fixture/sandbox_fixture" };
  const config = { environment: scope.environment,providerScopeId: scope.providerScopeId,countryCurrencies: { us: "usd" },
    callbacks: { returnUrl: "https://example.invalid/return",refreshUrl: "https://example.invalid/refresh" },applicationId: "ca_fixture" };
  const fake = fakeProvider();
  return { pool,scope,config,now: new Date(),...fake };
}
async function bind(h,now = h.now) {
  const reserved = await operations.reserve(h.pool,h.scope,{ country: "us",currency: "usd",actorUserId: 1 });
  const lease = await operations.claim(h.pool,h.scope,reserved.operation.id,now);
  const created = await h.provider.createAccount(lease.creation_intent,lease.stripe_idempotency_key);
  await operations.complete(h.pool,h.scope,lease,created,now);
  return { connection: await operations.load(h.pool,h.scope),lease,account: created };
}
module.exports = { account,fakeProvider,harness,bind };

if (require.main === module) {
  test("PostgreSQL enforces frozen intent, account binding, no-delete and monotonic fences", async t => {
    const h = await harness(t); if (!h) return;
    const b = await bind(h);
    for (const sql of [
      `UPDATE business_provider_connection_operations SET creation_intent=creation_intent || '{"contact_email":"forbidden"}'`,
      `UPDATE business_provider_connection_operations SET stripe_idempotency_key=gen_random_uuid()`,
      `UPDATE business_provider_connection_operations SET replay_deadline_at=replay_deadline_at+interval '1 day'`,
      `UPDATE business_provider_connection_operations SET lease_generation=0`,
      `UPDATE business_provider_connections SET provider_account_id='acct_other'`,
      `DELETE FROM business_provider_connection_operations`,
      `DELETE FROM business_provider_connection_readiness`,
    ]) await assert.rejects(h.pool.query(sql));
    assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM business_provider_connection_operations")).rows[0].n,1);
    assert.equal((await operations.load(h.pool,h.scope)).provider_account_id,b.account.id);
  });
  test("PostgreSQL rejects non-Owner operations, cross-Business scope, TEST/LIVE rebind", async t => {
    const h = await harness(t); if (!h) return;
    await assert.rejects(operations.reserve(h.pool,h.scope,{ country: "us",currency: "usd",actorUserId: 2 }));
    await bind(h);
    await assert.rejects(operations.reserve(h.pool,{ ...h.scope,environment: "LIVE" },{ country: "us",currency: "usd",actorUserId: 1 }));
    await assert.rejects(operations.reserve(h.pool,{ ...h.scope,providerScopeId: "other_scope" },{ country: "us",currency: "usd",actorUserId: 1 }));
    assert.equal(await operations.load(h.pool,{ ...h.scope,businessId: 20 }),null);
  });
  test("PostgreSQL rejects raw/financial event domains and forged event binding", async t => {
    const h = await harness(t); if (!h) return; const b = await bind(h);
    const events = require("../server/integrations/stripeConnectEventRepository");
    const receipt = { providerScopeId: h.scope.providerScopeId,environment: "TEST",eventId: "evt_fixture",accountId: b.account.id,
      type: "v2.core.account.updated",format: "THIN",apiVersion: null,context: null,relatedType: "v2.core.account",relatedId: b.account.id,
      hash: "a".repeat(64),accepted: true,terminal: null };
    const event = (await events.receive(h.pool,receipt,h.now)).row;
    await assert.rejects(h.pool.query("UPDATE business_provider_events SET event_domain='PAYMENT_LIFECYCLE'"));
    await assert.rejects(h.pool.query("UPDATE business_provider_events SET provider_account_id='acct_other'"));
    await assert.rejects(h.pool.query("UPDATE business_provider_events SET payload_sha256=$1",["b".repeat(64)]));
    await assert.rejects(h.pool.query("DELETE FROM business_provider_events"));
    assert.equal(event.connection_id,b.connection.id);
  });
}
