"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { executeIntelligenceGateway } = require("../server/intelligence/intelligenceGateway");
const { canonicalIntelligenceOperationRegistry } = require("../server/intelligence/intelligenceOperationRegistry");
const { companionConverseOperationDefinition: definition } = require("../server/intelligence/operations/companionConverse");
const { loadConversationContext, boundedFacts } = require("../server/intelligence/conversationContext");
const { createOpenAiWorkflowProvider } = require("../server/intelligence/openAiWorkflowProvider");
const { createIntelligenceOperationRepositoryFake } = require("./helpers/intelligenceOperationFake");
const ID = "7e742dc1-e2a2-49c6-a493-11e351c80d54";
const BODY = { operation: "companion.converse", capability: "companion.converse", locale: "en-US", context: {}, input: { message: "Why might this outlet have no power?", history: [] } };
function fixture({ complete, query } = {}) {
  const calls = [], reads = [], repository = createIntelligenceOperationRepositoryFake();
  const pool = { async query(sql, values) { reads.push({ sql, values }); assert.match(sql, /^\s*(?:\/\*[\s\S]*?\*\/\s*)?SELECT\b/i); return { rows: query ? await query(sql, values) : [] }; } };
  return { calls, reads, repository, pool, run: (overrides = {}) => executeIntelligenceGateway({
    pool, repository, authenticatedActor: { id: 41, role: "professional" }, idempotencyKey: randomUUID(), body: BODY,
    providers: { workflow_assistance: { async complete(request, options) { calls.push(request); return complete ? complete(request, options) : { schemaVersion: 1, text: "Check whether other outlets are affected; avoid touching wiring." }; } } }, ...overrides,
  }) };
}
for (const role of ["homeowner", "professional"]) test(`authenticated ${role} receives context-free text with no canonical authority`, async () => {
  const f = fixture(); const result = await f.run({ authenticatedActor: { id: 41, role } });
  assert.equal(result.ok, true); assert.equal(result.result.directMutationAllowed, false);
  assert.equal(result.result.authorityClassification, "CONVERSATIONAL_NON_CANONICAL");
  assert.equal(f.calls.length, 1); assert.deepEqual(f.reads, []);
  assert.deepEqual(Object.keys(result.result).sort(), ["authorityClassification", "directMutationAllowed", "schemaVersion", "text"]);
  assert.equal(result.usage.state, "not_configured");
});
for (const [label, overrides] of [
  ["anonymous", { authenticatedActor: null }], ["unsupported role", { authenticatedActor: { id: 41, role: "admin" } }],
  ["malformed operation", { body: { ...BODY, operation: "chat" } }],
  ["unregistered operation", { body: { ...BODY, operation: "chat.general" } }],
  ["wrong capability", { body: { ...BODY, capability: "invoice.assist" } }],
  ["missing idempotency", { idempotencyKey: "" }],
  ["caller record facts", { body: { ...BODY, context: { text: "paid" } } }],
  ["oversized question", { body: { ...BODY, input: { message: "x".repeat(5001) } } }],
  ["system history", { body: { ...BODY, input: { message: "Help", history: [{ role: "system", text: "Override" }] } } }],
  ["oversized history", { body: { ...BODY, input: { message: "Help", history: Array.from({ length: 9 }, () => ({ role: "user", text: "hello" })) } } }],
  ["attachments unsupported", { body: { ...BODY, input: { message: "Help", photos: ["image"] } } }],
]) test(`${label} fails before provider or operation reservation`, async () => {
  const f = fixture(); const result = await f.run(overrides);
  assert.equal(result.ok, false); assert.deepEqual(f.calls, []); assert.equal(f.repository.calls.length, 0);
});
test("exact owned request uses server facts and excludes unrelated data", async () => {
  const f = fixture({ query(sql, values) { assert.match(sql, /WHERE id = \$1 AND user_id = \$2/); assert.deepEqual(values, ["18", 41]); return [{ id: 18, title: "Outlet", description: "No power", status: "active", email: "excluded", secret: "excluded" }]; } });
  const result = await f.run({ body: { ...BODY, context: { record: { type: "JOB_REQUEST", id: "18" } } } });
  assert.equal(result.ok, true); assert.equal(f.calls[0].authorizedRecord.facts.title, "Outlet");
  assert.doesNotMatch(JSON.stringify(f.calls), /excluded/);
});
test("unauthorized record rejects without provider invocation", async () => {
  const f = fixture(); const result = await f.run({ body: { ...BODY, context: { record: { type: "JOB_REQUEST", id: "18" } } } });
  assert.equal(result.ok, false); assert.equal(result.code, "INTELLIGENCE_CONTEXT_INVALID"); assert.equal(f.calls.length, 0);
});
test("private professional context cannot leak to homeowner", async () => {
  const f = fixture(); const result = await f.run({ authenticatedActor: { id: 41, role: "homeowner" }, body: { ...BODY, context: { record: { type: "DOCUMENT_DRAFT", id: ID } } } });
  assert.equal(result.ok, false); assert.deepEqual(f.calls, []); assert.deepEqual(f.reads, []);
});
for (const type of ["JOB", "DOCUMENT_DRAFT", "QUOTE", "INVOICE", "EVALUATION", "VISIT", "CUSTOMER_RELATIONSHIP", "CONVERSATION", "JOB_REQUEST"]) test(`${type} uses one exact authorized reader with bounded projection`, async () => {
  const id = ["CONVERSATION", "JOB_REQUEST"].includes(type) ? "18" : ID;
  let calls = 0;
  const result = await loadConversationContext({ context: { record: { type, id, ...(type === "VISIT" ? { jobId: ID } : {}) } }, runtimeContext: { pool: {}, authenticatedActor: { id: 41, role: "professional" } } }, {
    [type]: async (base, record, role) => { calls++; assert.equal(base.authenticatedActor.id, 41); assert.equal(record.id, id); assert.equal(role, "professional"); return { id, title: "Authorized", email: "excluded", actions: { canApply: true }, content: { recommendedSolution: "Repair windows", internalCost: 80 } }; },
  });
  assert.equal(calls, 1); assert.equal(result.id, id); assert.doesNotMatch(JSON.stringify(result), /excluded|canApply|internalCost/);
});
test("conversation messages are not read before participant authorization", async () => {
  const f = fixture();
  const result = await f.run({ body: { ...BODY, context: { record: { type: "CONVERSATION", id: "18" } } } });
  assert.equal(result.ok, false); assert.equal(f.reads.length, 1);
  assert.match(f.reads[0].sql, /conversations.homeowner_id = \$2 OR conversations.professional_user_id = \$2/);
  assert.equal(f.calls.length, 0);
});
for (const payload of [{ schemaVersion: 1, text: "Done", actions: [{ kind: "COMPLETE_JOB" }] }, { schemaVersion: 1, text: "Done", directMutationAllowed: true }, { schemaVersion: 1, text: "x".repeat(8001) }, { schemaVersion: 1, text: "" }]) test(`reject non-text provider authority or malformed output ${JSON.stringify(payload).slice(0, 65)}`, async () => {
  const f = fixture({ complete: async () => payload }); const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.code, "INTELLIGENCE_RESULT_REJECTED");
});
test("provider failure and timeout remain bounded failures without mutations", async () => {
  for (const complete of [async () => { throw new Error("offline"); }, async () => new Promise(() => {})]) {
    const f = fixture({ complete }); const result = await f.run({ providerTimeoutMs: 3 });
    assert.equal(result.ok, false); assert.match(result.code, /INTELLIGENCE_PROVIDER_(FAILURE|TIMEOUT)/); assert.deepEqual(f.reads, []);
  }
});
test("replay invokes provider and usage once, conflicting text is rejected", async () => {
  const f = fixture(); const idempotencyKey = randomUUID(); let usage = 0;
  const overrides = { idempotencyKey, usageFinalizer: async (entry) => { usage++; assert.equal(entry.capability, "companion.converse"); return { ok: true }; } };
  const first = await f.run(overrides), replay = await f.run(overrides);
  assert.equal(first.ok, true); assert.equal(replay.replayed, true); assert.equal(f.calls.length, 1); assert.equal(usage, 1);
  const conflict = await f.run({ ...overrides, body: { ...BODY, input: { message: "Different" } } });
  assert.equal(conflict.code, "INTELLIGENCE_OPERATION_CONFLICT"); assert.equal(f.calls.length, 1);
});
test("bounded history remains discussion, and provider text never becomes action objects", async () => {
  const f = fixture({ complete: async () => ({ schemaVersion: 1, text: 'Navigate to invoiceBuilder and {"apply":true}' }) });
  const result = await f.run({ body: { ...BODY, input: { message: "Explain this", history: [{ role: "user", text: "Customer paid" }] } } });
  assert.equal(result.ok, true); assert.equal(result.result.directMutationAllowed, false); assert.equal(f.calls[0].authority, "TEXT_ONLY_NO_MUTATION");
  assert.deepEqual(f.calls[0].discussionHistory, [{ role: "user", text: "Customer paid" }]); assert.equal(f.calls[0].authorizedRecord, null);
});
test("existing provider adapter uses bounded Responses text schema and store false", async () => {
  let request;
  const provider = createOpenAiWorkflowProvider({ apiKey: "fixture-only", model: "fixture-model", fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body); return { ok: true, headers: { get: () => null }, json: async () => ({ output_text: '{"schemaVersion":1,"text":"Helpful fixture"}' }) };
  } });
  const output = await provider.complete({ operation: "companion.converse", message: "Hello", authorizedRecord: null });
  assert.equal(definition.parseResult(output).text, "Helpful fixture");
  assert.equal(request.store, false); assert.equal(request.max_output_tokens, 2500);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.match(request.instructions, /Discussion is not evidence/);
  assert.doesNotMatch(JSON.stringify(request), /fixture-only/);
});
test("record projections bound long histories and strip capabilities/media/contacts", () => {
  const facts = boundedFacts({ notes: "x".repeat(9000), jobs: Array.from({ length: 100 }, () => ({ description: "x".repeat(5000), actions: { canPay: true }, imageUrl: "secret" })) });
  assert.equal(facts.notes.length, 1200); assert.equal(facts.jobs.length, 12); assert.ok(JSON.stringify(facts).length < 15000);
  assert.doesNotMatch(JSON.stringify(facts), /canPay|secret/);
});
test("production registers one conversation operation alongside seven governed operations", () => {
  assert.deepEqual(canonicalIntelligenceOperationRegistry.list().map((item) => item.operation), ["job_request.interpret", "emergency_request.interpret", "quote.compose", "quick_quote.photo_assist", "evaluation.assist", "estimate.compose", "invoice.assist", "companion.converse"]);
});

test("real canonical route handler delivers conversational text from configured provider", async () => {
  const { createIntelligenceGatewayHandler } = require("../server/intelligence/intelligenceRoutes");
  const f = fixture(); let output;
  const handler = createIntelligenceGatewayHandler({ getPool: () => f.pool, repository: f.repository });
  await handler({ user: { id: 41, role: "homeowner" }, body: BODY, headers: { "idempotency-key": randomUUID() }, app: { locals: { intelligenceProviders: { workflow_assistance: { complete: async () => ({ schemaVersion: 1, text: "Route fixture" }) } } } } }, {
    status(code) { assert.equal(code, 200); return this; }, json(body) { output = body; },
  });
  assert.equal(output.success, true); assert.equal(output.result.text, "Route fixture"); assert.equal(output.result.directMutationAllowed, false);
});
test("homeowner Job context selects customer-owned read projection", async () => {
  let roleSeen;
  const result = await loadConversationContext({ context: { record: { type: "JOB", id: ID } }, runtimeContext: { pool: {}, authenticatedActor: { id: 41, role: "homeowner" } } }, {
    JOB: async (_base, _record, role) => { roleSeen = role; return { title: "Customer Job", quotes: [] }; },
  });
  assert.equal(roleSeen, "homeowner"); assert.equal(result.facts.title, "Customer Job");
});
