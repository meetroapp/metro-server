"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { executeIntelligenceGateway } = require("../server/intelligence/intelligenceGateway");
const { createIntelligenceOperationRepositoryFake } = require("./helpers/intelligenceOperationFake");
const { boundedFacts } = require("../server/intelligence/conversationContext");
const { parseRetrievalIntent, matchRank } = require("../server/intelligence/retrievalIntent");
const { discoverCandidates, readAuthorizedRecord } = require("../server/intelligence/retrievalReaders");
const { scheduledVisit } = require("../server/intelligence/retrievalAnswers");
const { loadRetrievalContinuation } = require("../server/intelligence/retrievalContinuation");
const NOW = "2026-09-09T22:00:00Z";
function job(name, title, extra = {}) { return { record: { type: "JOB", id: randomUUID() }, name, title, owner: 41, role: "professional", facts: { stage: { code: "WORK_IN_PROGRESS", label: "Work in progress" }, ...extra } }; }
function fixture(records = [job("Anthony Guzman", "Cabinet repair")]) {
  const provider = [], reads = [], searches = [], diagnostics = [], repository = createIntelligenceOperationRepositoryFake();
  const visits = new Map(), deposits = new Map();
  const pool = { async query(sql, values) {
    assert.match(sql, /companion_retrieval:continuation/);
    assert.match(sql, /actor_user_id=\$2 AND authority_scope=\$3/);
    assert.match(sql, /INTERVAL '15 minutes'/);
    const row = [...repository.records.values()].find((r) => r.id === values[0] && r.actor_user_id === values[1] && r.authority_scope === values[2] && r.status === "completed" && Date.now() - Date.parse(r.completed_at) < 900000);
    return { rows: row ? [row] : [] };
  } };
  const services = {
    async discoverCandidates(base, query) { searches.push(query); return { candidates: records.filter((r) => r.record.type === query.type || ["QUOTE", "INVOICE"].includes(query.type) && r.record.type === "DOCUMENT_DRAFT").filter((r) => r.owner === base.authenticatedActor.id && r.role === base.authenticatedActor.role), truncated: false }; },
    async readAuthorizedRecord(base, pointer) { reads.push(pointer); const row = records.find((r) => r.record.id === pointer.id && r.record.type === pointer.type && r.owner === base.authenticatedActor.id && r.role === base.authenticatedActor.role); return row ? { type: pointer.type, id: pointer.id, facts: boundedFacts(row.facts) } : null; },
    async readVisits(_base, id) { return visits.get(id) || []; },
    async readWaitingQuotes() { return { ids: records.filter((r) => r.facts.classification === "WAITING_ON_CUSTOMER").map((r) => r.record.id), truncated: false }; },
    async readDeposit(_base, id) { return deposits.get(id) || null; },
  };
  return { records, provider, reads, searches, diagnostics, repository, visits, deposits, services,
    run(message, context = {}, overrides = {}) { return executeIntelligenceGateway({ pool, repository, retrievalServices: services, retrievalClock: () => NOW, onDiagnostics: (value) => diagnostics.push(value), authenticatedActor: { id: 41, role: "professional" }, idempotencyKey: randomUUID(), body: { operation: "companion.converse", capability: "companion.converse", locale: "en-US", input: { message }, context: { retrieval: { version: 1 }, ...context } }, providers: { workflow_assistance: { async complete(request) { provider.push(request); return { schemaVersion: 1, text: "A bounded explanation from the authorized record." }; } } }, ...overrides }); },
  };
}
function noMutation(result) { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.directMutationAllowed, false); assert.equal(result.result.authorityClassification, "CONVERSATIONAL_NON_CANONICAL"); assert.equal(result.result.schemaVersion, 1); for (const key of ["actions", "patch", "command", "route"]) assert.equal(Object.hasOwn(result.result, key), false); }
function visit(extra = {}) { return { id: randomUUID(), state: "SCHEDULED", scheduledStartAt: "2026-09-10T13:00:00Z", timeZone: "America/New_York", ...extra }; }

test("opt-in context-free conversation keeps provider behavior without searching", async () => { const f = fixture(); const r = await f.run("Why might this outlet have no power?"); noMutation(r); assert.equal(r.result.resolution.status, "NO_RECORD_REQUIRED"); assert.equal(f.provider.length, 1); assert.deepEqual(f.searches, []); });
for (const message of ["What time is Anthony Guzman's job?", "When is Anthony's job?"]) test(`authorized schedule without provider: ${message}`, async () => { const f = fixture(); f.visits.set(f.records[0].record.id, [visit()]); const r = await f.run(message); noMutation(r); assert.match(r.result.text, /9:00 AM/); assert.equal(r.result.resolution.status, "RESOLVED"); assert.equal(r.result.resolution.providerInvoked, false); assert.equal(f.provider.length, 0); assert.equal(f.diagnostics[0].providerExecutionCount, 0); });
for (const [message, expected] of [["What jobs do I have tomorrow?", 1], ["What is scheduled today?", 0], ["Do I have anything Friday morning?", 0]]) test(`calendar query ${message}`, async () => { const f = fixture(); f.visits.set(f.records[0].record.id, [visit()]); const r = await f.run(message); noMutation(r); assert.equal(r.result.resolution.records.length, expected); assert.equal(f.provider.length, 0); });
test("next job uses earliest confirmed future visit", async () => { const f = fixture([job("Anthony", "Cabinets"), job("Paul", "Windows")]); f.visits.set(f.records[0].record.id, [visit({ scheduledStartAt: "2026-09-10T17:00:00Z" })]); f.visits.set(f.records[1].record.id, [visit()]); const r = await f.run("What's my next job?"); noMutation(r); assert.match(r.result.text, /Paul/); assert.equal(r.result.resolution.records.length, 1); });
test("today/tomorrow use canonical visit timezone at UTC date boundary", () => { const v = visit({ timeZone: "America/Los_Angeles", scheduledStartAt: "2026-09-10T07:30:00Z" }); const now = new Date("2026-09-10T02:00:00Z"); assert.equal(scheduledVisit(v, parseRetrievalIntent("What is scheduled tomorrow?"), now), true); assert.equal(scheduledVisit(v, parseRetrievalIntent("What is scheduled today?"), now), false); });
test("day arithmetic survives daylight saving time changes", () => { assert.equal(scheduledVisit(visit({ scheduledStartAt: "2026-03-08T13:00:00Z" }), parseRetrievalIntent("What is scheduled tomorrow?"), new Date("2026-03-08T02:00:00Z")), true); });
for (const patch of [{ state: "PROPOSED" }, { state: "CANCELLED" }, { timeZone: "bogus" }, { scheduledStartAt: "broken" }]) test(`unconfirmed/invalid schedule not asserted ${JSON.stringify(patch)}`, () => { assert.equal(scheduledVisit(visit(patch), parseRetrievalIntent("What is scheduled tomorrow?"), new Date(NOW)), false); });
test("active/in-progress aggregate excludes completed Jobs", async () => { const f = fixture([job("Anthony", "Repair"), job("Paul", "Done", { stage: { code: "JOB_COMPLETED", label: "Completed" } })]); const r = await f.run("Which jobs are still in progress?"); noMutation(r); assert.equal(r.result.resolution.records.length, 1); assert.match(r.result.text, /in progress/); assert.equal(f.provider.length, 0); });
test("exact Job deictic context wins without search", async () => { const f = fixture(); const r = await f.run("What's happening here?", { record: f.records[0].record }); noMutation(r); assert.equal(f.searches.length, 0); assert.equal(r.result.resolution.records[0].record.id, f.records[0].record.id); });
test("explicit different customer intentionally searches after exact authorization", async () => { const f = fixture([job("Anthony Guzman", "Cabinet"), job("Paul Becker", "Window")]); const r = await f.run("What's the status of the Becker job?", { record: f.records[0].record }); noMutation(r); assert.equal(r.result.resolution.records[0].record.id, f.records[1].record.id); assert.equal(f.reads[0].id, f.records[0].record.id); });
test("unknown exact context is never silently replaced by name search", async () => { const f = fixture(); const r = await f.run("When is Anthony's job?", { record: { type: "JOB", id: randomUUID() } }); noMutation(r); assert.equal(r.result.resolution.status, "SAFE_NOT_FOUND"); assert.equal(f.searches.length, 0); });
test("bounded exact UUID discovery", async () => { const f = fixture(); const r = await f.run(`What's the status of job ${f.records[0].record.id}?`); noMutation(r); assert.equal(r.result.resolution.records[0].record.id, f.records[0].record.id); });
for (const facts of [{ status: "ISSUED", decisionState: "APPROVED" }, { status: "ISSUED", approval: { id: randomUUID(), source: "EXTERNAL_EVIDENCE" } }]) test(`Quote approval comes from canonical evidence ${JSON.stringify(facts)}`, async () => { const row = { ...job("Anthony", "Windows", facts), record: { type: "QUOTE", id: randomUUID() }, number: "Q-000123" }; const f = fixture([row]); const r = await f.run("Is Q-000123 approved?"); noMutation(r); assert.match(r.result.text, /APPROVED/); assert.equal(f.provider.length, 0); });
test("Quote waiting for approval excludes approved records", async () => { const make = (decisionState) => ({ ...job("Customer", "Quote", { status: "ISSUED", decisionState, classification: decisionState ? "APPROVED" : "WAITING_ON_CUSTOMER" }), record: { type: "QUOTE", id: randomUUID() } }); const f = fixture([make(null), make("APPROVED")]); const r = await f.run("What Quote is waiting for approval?"); noMutation(r); assert.equal(r.result.resolution.records.length, 1); });
for (const [status, balance] of [["PAID", 0], ["PARTIALLY_PAID", 2000]]) test(`Invoice ${status} is read without provider`, async () => { const row = { ...job("Anthony", "Invoice", { status, balanceMinor: balance, currency: "USD" }), record: { type: "INVOICE", id: randomUUID() } }; const f = fixture([row]); const r = await f.run("Is this Invoice paid?", { record: row.record }); noMutation(r); assert.match(r.result.text, new RegExp(status)); assert.equal(f.provider.length, 0); });
test("working document cannot claim invoice payment or Quote approval", async () => { const row = { ...job("Anthony", "Draft", { status: "WORKING_DRAFT", total: 100 }), record: { type: "DOCUMENT_DRAFT", id: randomUUID() } }; const f = fixture([row]); for (const question of ["Is this Invoice paid?", "Is this Quote approved?"]) { const r = await f.run(question, { record: row.record }); noMutation(r); assert.match(r.result.text, /not|not established/); } });
test("canonical outstanding deposit amount remains distinct from quote scope", async () => { const f = fixture(); f.deposits.set(f.records[0].record.id, { state: "PARTIALLY_SATISFIED", remainingMinor: 5000, currency: "USD" }); const r = await f.run("Has Anthony paid the deposit?"); noMutation(r); assert.match(r.result.text, /50.00 remaining/); assert.equal(f.provider.length, 0); });
test("outstanding deposit aggregate excludes satisfied and unknown obligations", async () => { const f = fixture([job("Anthony", "Windows"), job("Paul", "Doors")]); f.deposits.set(f.records[0].record.id, { state: "DUE", remainingMinor: 9000, currency: "USD" }); const r = await f.run("Which jobs are still waiting for a deposit?"); noMutation(r); assert.equal(r.result.resolution.records.length, 1); });
test("reasoning invokes provider once with only the authorized bounded record", async () => { const f = fixture([job("Anthony Guzman", "Cabinet", { description: "Repair cabinet", secret: "DO_NOT_SEND", email: "DO_NOT_SEND" }), job("Paul", "DO_NOT_SEND")]); const r = await f.run("What should I prepare for Anthony's job based on the scope?"); noMutation(r); assert.equal(f.provider.length, 1); assert.equal(r.result.resolution.providerInvoked, true); assert.doesNotMatch(JSON.stringify(f.provider), /DO_NOT_SEND|resolution|continuation/); assert.equal(f.provider[0].authorizedRecord.id, f.records[0].record.id); });
test("two Johns require authorized bounded clarification", async () => { const f = fixture([job("John Smith", "Bathroom"), job("John Rivera", "AC")]); const r = await f.run("What time is John's job?"); noMutation(r); assert.equal(r.result.resolution.status, "AMBIGUOUS"); assert.equal(r.result.resolution.records.length, 2); assert.equal(f.provider.length, 0); });
test("normalized exact name wins over a longer substring candidate", async () => { const f = fixture([job("John", "Bath"), job("John Smith", "AC")]); const r = await f.run("What's the status of John's job?"); noMutation(r); assert.equal(r.result.resolution.records[0].name, "John"); });
test("ambiguity choices capped at five", async () => { const f = fixture(Array.from({ length: 9 }, (_, i) => job(`John ${i}`, `Repair ${i}`))); const r = await f.run("When is John's job?"); noMutation(r); assert.equal(r.result.resolution.records.length, 5); assert.equal(r.result.resolution.truncated, true); });
test("truncated candidate universe cannot claim a unique target", async () => { const f = fixture(); f.services.discoverCandidates = async () => ({ candidates: f.records, truncated: true }); const r = await f.run("When is Anthony's job?"); noMutation(r); assert.equal(r.result.resolution.status, "AMBIGUOUS"); });
test("aggregate results capped at ten with honest coverage", async () => { const f = fixture(Array.from({ length: 13 }, (_, i) => job(`Customer ${i}`, `Repair ${i}`))); const r = await f.run("Which jobs are in progress?"); noMutation(r); assert.equal(r.result.resolution.records.length, 10); assert.match(r.result.text, /bounded result/); });
for (const role of ["professional", "homeowner"]) test(`${role} cannot resolve another actor's name or document`, async () => { const row = { ...job("Foreign Customer", "Secret title"), owner: 99, role }; const f = fixture([row]); const r = await f.run("What's the status of Foreign Customer's job?", {}, { authenticatedActor: { id: 41, role } }); noMutation(r); assert.equal(r.result.resolution.status, "NOT_FOUND"); assert.doesNotMatch(JSON.stringify(r.result), /Secret title/); assert.equal(f.provider.length, 0); });
test("candidate leakage cannot bypass exact domain authorization", async () => { const f = fixture([{ ...job("Foreign", "secret"), owner: 99 }]); f.services.discoverCandidates = async () => ({ candidates: f.records, truncated: false }); const r = await f.run("What's the status of Foreign's job?"); noMutation(r); assert.equal(r.result.resolution.records.length, 0); assert.doesNotMatch(JSON.stringify(r.result), /secret/); });
test("homeowner cannot resolve professional Customer Relationship", async () => { const row = { ...job("Anthony", "Private relationship"), record: { type: "CUSTOMER_RELATIONSHIP", id: randomUUID() } }; const f = fixture([row]); const r = await f.run("Summarize this customer relationship", { record: row.record }, { authenticatedActor: { id: 41, role: "homeowner" } }); noMutation(r); assert.equal(r.result.resolution.status, "SAFE_NOT_FOUND"); });
test("result ledger continuation reauthorizes the same record", async () => { const f = fixture(); const first = await f.run("What's the status of Anthony's job?"); const r = await f.run("What should I bring for that job?", { retrieval: { version: 1, continuation: { reference: first.operationId } } }); noMutation(r); assert.equal(r.result.resolution.records[0].record.id, f.records[0].record.id); assert.equal(f.reads.length, 2); assert.equal(f.searches.length, 1); });
test("aggregate continuity resolves a named member without global search", async () => { const f = fixture([job("Anthony", "Windows"), job("Paul", "Doors")]); const first = await f.run("Which jobs are in progress?"); const r = await f.run("What is Anthony's job for?", { retrieval: { version: 1, continuation: { reference: first.operationId } } }); noMutation(r); assert.equal(r.result.resolution.records[0].record.id, f.records[0].record.id); assert.equal(f.searches.length, 1); });
test("ambiguous follow-up requires selection and selection reauthorizes", async () => { const f = fixture([job("John Smith", "Bathroom"), job("John Rivera", "AC")]); const first = await f.run("Which jobs are in progress?"); const second = await f.run("What about John?", { retrieval: { version: 1, continuation: { reference: first.operationId } } }); noMutation(second); assert.equal(second.result.resolution.status, "AMBIGUOUS"); const selected = await f.run("Summarize this", { retrieval: { version: 1, continuation: { reference: second.operationId, index: 1 } } }); noMutation(selected); assert.equal(selected.result.resolution.records[0].record.id, second.result.resolution.records[1].record.id); });
for (const kind of ["foreign", "tampered", "expired", "role change", "invalid index"]) test(`continuation ${kind} rejected`, async () => { const f = fixture(); const first = await f.run("What's the status of Anthony's job?"); const continuation = { reference: kind === "tampered" ? randomUUID() : first.operationId, ...(kind === "invalid index" ? { index: 9 } : {}) }; if (kind === "expired") [...f.repository.records.values()][0].completed_at = "2001-01-01T00:00:00Z"; const r = await f.run("Summarize this", { retrieval: { version: 1, continuation } }, kind === "foreign" ? { authenticatedActor: { id: 99, role: "professional" } } : kind === "role change" ? { authenticatedActor: { id: 41, role: "homeowner" } } : {}); assert.equal(r.ok, false); assert.equal(r.code, "INTELLIGENCE_CONTINUATION_INVALID"); assert.equal(f.provider.length, 0); });
test("revoked authority on continuation cannot expose prior labels", async () => { const f = fixture(); const first = await f.run("What's the status of Anthony's job?"); f.records[0].owner = 99; const r = await f.run("Summarize this", { retrieval: { version: 1, continuation: { reference: first.operationId } } }); noMutation(r); assert.equal(r.result.resolution.status, "SAFE_NOT_FOUND"); assert.equal(r.result.resolution.records.length, 0); });
for (const message of ["Move Anthony's job to 2 PM.", "Update Anthony's invoice with what the customer paid.", "Schedule Anthony's job how we discussed."]) test(`operational resolution stops at governed Review boundary: ${message}`, async () => { const row = job("Anthony", "Work"); if (message.includes("invoice")) row.record.type = "INVOICE"; const f = fixture([row]); const r = await f.run(message); noMutation(r); assert.equal(r.result.resolution.reviewRequired, true); assert.equal(f.provider.length, 0); assert.match(r.result.text, /Confirm & Apply/); });
test("ambiguous operation produces clarification, never Review", async () => { const f = fixture([job("John Smith", "Bathroom"), job("John Rivera", "AC")]); const r = await f.run("Move John's job to 2 PM."); noMutation(r); assert.equal(r.result.resolution.status, "AMBIGUOUS"); assert.equal(r.result.resolution.reviewRequired, false); });
test("mixed request has no partial proposal", async () => { const f = fixture(); const r = await f.run("Explain this job and move it to 2 PM", { record: f.records[0].record }); noMutation(r); assert.equal(r.result.resolution.reviewRequired, false); assert.equal(f.provider.length, 0); });
test("deterministic replay does not invoke provider or charge provider usage", async () => { const f = fixture(); const key = randomUUID(); let charges = 0; const options = { idempotencyKey: key, usageFinalizer: async () => { charges++; return { ok: true }; } }; const first = await f.run("What's the status of Anthony's job?", {}, options); const replay = await f.run("What's the status of Anthony's job?", {}, options); noMutation(first); assert.equal(replay.replayed, true); assert.deepEqual(replay.result, first.result); assert.equal(charges, 0); assert.equal(f.provider.length, 0); });
test("retrieval outage cannot fabricate response", async () => { const f = fixture(); f.services.discoverCandidates = async () => { throw Object.assign(new Error("private failure"), { code: "intelligence_retrieval_unavailable" }); }; const r = await f.run("When is Anthony's job?"); assert.equal(r.ok, false); assert.equal(r.code, "INTELLIGENCE_RETRIEVAL_UNAVAILABLE"); assert.equal(f.provider.length, 0); });
test("provider outage after resolution stays a failed request", async () => { const f = fixture(); const r = await f.run("Explain Anthony's job", {}, { providers: {} }); assert.equal(r.ok, false); assert.equal(r.code, "INTELLIGENCE_PROVIDER_UNAVAILABLE"); });
for (const context of [{ retrieval: { version: 2 } }, { retrieval: { version: 1, actorId: 99 } }, { retrieval: { version: 1 }, records: [] }, { retrieval: { version: 1, continuation: { reference: randomUUID(), records: [] } } }]) test(`reject caller authority extension ${JSON.stringify(context)}`, async () => { const f = fixture(); const r = await f.run("Hello", context); assert.equal(r.ok, false); assert.equal(f.provider.length, 0); });

test("production candidate selectors parameterize text, bind actor/role, and cap rows", async () => { for (const role of ["professional", "homeowner"]) for (const type of ["JOB", "JOB_REQUEST", "QUOTE", "INVOICE", "EVALUATION", "CONVERSATION", "CUSTOMER_RELATIONSHIP"]) { const calls = []; await discoverCandidates({ authenticatedActor: { id: 41, role }, pool: { async query(sql, values) { calls.push(sql); assert.match(sql, /^\/\* companion_retrieval:/); assert.match(sql, /LIMIT \$4/); assert.equal(values[0], 41); assert.equal(values[3], 41); assert.doesNotMatch(sql, /DROP TABLE/); return { rows: [] }; } } }, { type, name: "'; DROP TABLE jobs; --" }); assert.equal(calls.length > 0, !(role === "homeowner" && type === "CUSTOMER_RELATIONSHIP")); } });
test("exact owned request production reader rejects other owner without disclosure", async () => { let read = 0; const result = await readAuthorizedRecord({ authenticatedActor: { id: 41, role: "homeowner" }, pool: { async query(sql, values) { read++; assert.match(sql, /WHERE id = \$1 AND user_id = \$2/); assert.deepEqual(values, ["18", 41]); return { rows: [] }; } } }, { type: "JOB_REQUEST", id: "18" }); assert.equal(result, null); assert.equal(read, 1); });
test("Property remains unsupported rather than becoming portfolio authority", async () => { const result = await readAuthorizedRecord({ authenticatedActor: { id: 41, role: "professional" }, pool: { query() { assert.fail("must reject before read"); } } }, { type: "PROPERTY", id: randomUUID() }); assert.equal(result, null); });
test("matching treats wildcard and SQL punctuation as text", () => { assert.equal(matchRank({ record: { id: randomUUID() }, name: "John", title: "Repair" }, { name: "%", id: "", number: "" }), 0); });

for (const [message, type, id, number] of [
  ["Is INV-A1234BCDEF90 paid?", "INVOICE", "", "INVA1234BCDEF90"],
  ["Explain job request 18", "JOB_REQUEST", "18", ""],
  ["Summarize conversation 42", "CONVERSATION", "42", ""],
]) test(`canonical identifier recognition: ${message}`, () => {
  const query = parseRetrievalIntent(message);
  assert.equal(query.type, type); assert.equal(query.id, id); assert.equal(query.number, number);
});
test("this afternoon is a local calendar aggregate, not an invented current record", async () => {
  const f = fixture(); f.visits.set(f.records[0].record.id, [visit({ scheduledStartAt: "2026-09-09T18:00:00Z" })]);
  const r = await f.run("What is scheduled this afternoon?"); noMutation(r);
  assert.equal(r.result.resolution.records.length, 1); assert.equal(f.provider.length, 0);
});
test("operational aggregate never silently selects its first matching Job", async () => {
  const f = fixture([job("Anthony", "Cabinet"), job("Paul", "Windows")]);
  const r = await f.run("Schedule jobs tomorrow"); noMutation(r);
  assert.equal(r.result.resolution.status, "AMBIGUOUS"); assert.equal(r.result.resolution.reviewRequired, false);
});
test("issued but undelivered Quote is not waiting on customer approval", async () => {
  const row = { ...job("Anthony", "Windows", { status: "ISSUED", classification: "DELIVERY_PENDING" }), record: { type: "QUOTE", id: randomUUID() } };
  const f = fixture([row]); const r = await f.run("What Quote is waiting for approval?"); noMutation(r);
  assert.equal(r.result.resolution.records.length, 0); assert.equal(f.provider.length, 0);
});
test("an unauthorized document number and a missing number have indistinguishable public results", async () => {
  const row = { ...job("Foreign", "Private", { status: "ISSUED" }), owner: 99, record: { type: "QUOTE", id: randomUUID() }, number: "Q-000123" };
  const f = fixture([row]); const hidden = await f.run("Is Q-000123 approved?"); const missing = await f.run("Is Q-999999 approved?");
  noMutation(hidden); noMutation(missing); assert.deepEqual(hidden.result, missing.result);
});
test("provider cannot attach record identity or a mutation to resolved reasoning", async () => {
  const f = fixture(); const r = await f.run("Explain Anthony's job", {}, { providers: { workflow_assistance: { async complete() { return { schemaVersion: 1, text: "Changed", record: { id: randomUUID() }, patch: {} }; } } } });
  assert.equal(r.ok, false); assert.equal(r.code, "INTELLIGENCE_RESULT_REJECTED");
});
test("production discovery through real Job authorization/projector performs reads only", async () => {
  const id = randomUUID(), reads = [], repository = createIntelligenceOperationRepositoryFake();
  const pool = { async query(sql, values) {
    reads.push(sql); assert.match(sql.trim(), /^(?:\/\*[\s\S]*?\*\/\s*)?(?:SELECT|WITH|BEGIN|COMMIT|ROLLBACK)\b/);
    if (sql.includes("companion_retrieval:candidates:JOB")) { assert.equal(values[0], 41); return { rows: [{ id, name: "Anthony Guzman", title: "Window repair" }] }; }
    if (sql.includes("live_job:authorized_context")) {
      assert.equal(values[0], id); assert.equal(values[1], 41);
      return { rows: [{ job_id: id, job_request_id: 18, relationship_id: 72, lifecycle_contract_version: 2, job_created_at: NOW,
        relationship_status: "active", selected_professional_user_id: 41, actor_account_type: "professional", actor_participant_id: randomUUID(),
        is_primary_professional: true, conversation_id: 340, active_capabilities: ["participant.read", "reported_concern.read", "evaluation.perform"] }] };
    }
    if (sql.includes("live_job:") || /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    assert.fail("Unexpected SQL in read-only retrieval");
  } };
  const result = await executeIntelligenceGateway({ pool, repository, authenticatedActor: { id: 41, role: "professional" }, idempotencyKey: randomUUID(),
    body: { operation: "companion.converse", capability: "companion.converse", context: { retrieval: { version: 1 } }, input: { message: "What's the status of Anthony Guzman's job?" } },
    providers: { workflow_assistance: { complete() { assert.fail("must not invoke provider"); } } } });
  noMutation(result); assert.match(result.result.text, /Evaluation|evaluation/); assert.equal(result.result.resolution.records[0].record.id, id);
  assert.ok(reads.some((sql) => sql.includes("live_job:authorized_context")));
});
test("production request search reauthorizes ownership before bounded provider context", async () => {
  const calls = [], repository = createIntelligenceOperationRepositoryFake(); let supplied;
  const pool = { async query(sql, values) {
    calls.push(sql); assert.match(sql, /SELECT/); assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
    if (sql.includes("companion_retrieval:candidates:JOB_REQUEST")) { assert.equal(values[0], 41); return { rows: [{ id: 18, title: "Outlet repair", name: "" }] }; }
    assert.match(sql, /WHERE id = \$1 AND user_id = \$2/); assert.deepEqual(values, ["18", 41]);
    return { rows: [{ id: 18, title: "Outlet repair", description: "No power", status: "active", email: "PRIVATE" }] };
  } };
  const r = await executeIntelligenceGateway({ pool, repository, authenticatedActor: { id: 41, role: "homeowner" }, idempotencyKey: randomUUID(),
    body: { operation: "companion.converse", capability: "companion.converse", context: { retrieval: { version: 1 } }, input: { message: "Explain job request 18" } },
    providers: { workflow_assistance: { async complete(request) { supplied = request; return { schemaVersion: 1, text: "This request reports an outlet without power." }; } } } });
  noMutation(r); assert.equal(supplied.authorizedRecord.id, "18"); assert.doesNotMatch(JSON.stringify(supplied), /PRIVATE/); assert.equal(calls.length, 2);
});
test("private Team tables are not a conversation discovery source", async () => {
  let count = 0;
  await discoverCandidates({ authenticatedActor: { id: 41, role: "professional" }, pool: { async query(sql, values) {
    count++; assert.match(sql, /FROM conversations c/); assert.match(sql, /c.professional_user_id=\$1 AND r.professional_user_id=\$1/);
    assert.doesNotMatch(sql, /team_/); assert.equal(values[0], 41); return { rows: [] };
  } } }, { type: "CONVERSATION", name: "Customer" }); assert.equal(count, 1);
});
