"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { requireOwner } = require("../server/integrations/stripeConnectAuthority");
function db(rows) { return { async query(sql,args) { assert.match(sql,/role IN \('OWNER', 'MANAGER'\)/); assert.deepEqual(args,[7]); return { rows }; } }; }
test("Owner gate preserves unauthenticated, absent/inactive, Manager and ambiguity responses",async () => {
  assert.equal((await requireOwner({})).status,401);
  const call = rows => requireOwner({ pool: db(rows),authenticatedActor: { id: 7 },command: { intent: "CONNECT",country: "us" } });
  assert.equal((await call([])).status,403);
  assert.equal((await call([{ contractor_profile_id: 10,role: "MANAGER" }])).status,403);
  assert.equal((await call([{ contractor_profile_id: 10,role: "OWNER" },{ contractor_profile_id: 20,role: "MANAGER" }])).status,409);
  assert.equal((await call([{ contractor_profile_id: 10,role: "OWNER" }])).ok,true);
});
test("command cannot select merchant authority, mode, return URL or readiness",async () => {
  for (const key of ["businessId","accountId","provider","environment","status","customerId","returnUrl","capability"]) {
    const result = await requireOwner({ pool: db([{ contractor_profile_id: 10,role: "OWNER" }]),authenticatedActor: { id: 7 },command: { intent: "CONNECT",country: "us",[key]: "override" } });
    assert.equal(result.status,400);
  }
  for (const command of [{ intent: "CONTINUE",country: "us" },{ intent: "CONNECT",country: "US" },null,[]]) {
    assert.equal((await requireOwner({ pool: db([{ contractor_profile_id: 10,role: "OWNER" }]),authenticatedActor: { id: 7 },command })).status,400);
  }
});
