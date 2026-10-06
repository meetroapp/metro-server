"use strict";
const test=require("node:test");const assert=require("node:assert/strict");const fs=require("node:fs");const path=require("node:path");
const {getMigrationFiles}=require("../scripts/run-migrations");
const root=path.join(__dirname,"..");
test("migration 112 is schema-only and preserves exact 111 checksum/inventory position",()=>{
  const files=getMigrationFiles();assert.equal(files.length,112);
  assert.equal(files[110].checksum,"d7039c4f413aab49bbce57c706e34dba2925c69ba3e6a53ba2a1e9664cfc2b74");
  assert.equal(files[111].filename,"202610060002_create_stripe_connect_onboarding_event_authority.sql");
  const sql=files[111].sql;
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS /g)||[]).length,3);
  const topLevel=sql.replace(/\$\$[\s\S]*?\$\$/g,"");
  assert.doesNotMatch(topLevel,/^\s*(?:BEGIN|COMMIT|ROLLBACK|INSERT INTO|UPDATE |DELETE FROM|TRUNCATE|ALTER TABLE)\b/im);
  assert.doesNotMatch(sql,/AccountSession|onboarding_url|client_secret|professional_subscription|canonical_(?:invoice|pre_work|visit)/);
  assert.match(sql,/CHECK \(event_domain = 'ACCOUNT_LIFECYCLE'\)/);assert.match(sql,/stale_after > last_retrieved_at/);
  assert.doesNotMatch(sql,/stale_after.*interval '15 minutes'/);
});
test("new Connect foundation stays unimported by runtime and public R2 remains all COMING_SOON",()=>{
  const scan=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?scan(path.join(dir,e.name)):e.name.endsWith(".js")?[path.join(dir,e.name)]:[]);
  for(const file of [path.join(root,"index.js"),...scan(path.join(root,"server"))]){
    if(path.basename(file).startsWith("stripeConnect"))continue;
    assert.doesNotMatch(fs.readFileSync(file,"utf8"),/require\([^\n]*stripeConnect/);
  }
  const {getConnectedServiceProviders}=require("../server/integrations/connectedServicesRegistry");
  assert.deepEqual(getConnectedServiceProviders().map(p=>p.status),Array(4).fill("COMING_SOON"));
  for(const file of scan(path.join(root,"server","integrations")).filter(f=>path.basename(f).startsWith("stripeConnect"))){
    assert.doesNotMatch(fs.readFileSync(file,"utf8"),/professional_subscription|canonical_(?:invoice|pre_work|visit)|process\.env|setInterval|fetch\(/);
  }
});
