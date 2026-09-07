"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { businessDocumentDraftInternals: { sqlStore } } = require("../server/documents/businessDocumentDraftService");

// Transactional query double exercises the production SQL store and allocator.
// No migration or database is opened by these tests.
function database({ failAt = "" } = {}) {
  let state = { lastNumber: 2, rows: {}, commands: {}, photos: {} };
  let before;
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const operation = sql.match(/\/\* ([^*]+) \*\//)?.[1] || sql;
      calls.push({ operation, sql, values });
      if (operation === "BEGIN") { before = structuredClone(state); return { rows: [] }; }
      if (operation === "ROLLBACK") { state = before; before = null; return { rows: [] }; }
      if (operation === failAt) throw new Error(`injected ${operation} failure`);
      if (operation === "COMMIT") { before = null; return { rows: [] }; }
      const result = (rows = []) => ({ rows });
      if (operation === "business_document_numbering:profile_owner") return result([{ contractor_profile_id: 10 }]);
      if (operation === "business_document:reserve_command") {
        const key = `${values[1]}:${values[2]}`;
        if (state.commands[key]) return result();
        state.commands[key] = { id: key, request_hash: values[3] };
        return result([{ id: key }]);
      }
      if (operation === "business_document:load_command") return result([state.commands[`${values[1]}:${values[2]}`]]);
      if (operation === "business_document:cancel_command") { delete state.commands[values[0]]; return result(); }
      if (operation === "business_document:finish_command") {
        state.commands[values[0]].response_json = JSON.parse(values[2]);
        return result();
      }
      if (operation === "business_document_numbering:allocate") {
        assert.ok(before, "allocation must run inside the document transaction");
        state.lastNumber++;
        return result([{ number_prefix: "Q", number_width: 7, last_number: state.lastNumber }]);
      }
      if (operation === "business_document:create") {
        assert.ok(before, "document insert must share the allocation transaction");
        assert.ok(!Object.values(state.rows).some((row) => row.document_number === values[6]), "number uniqueness includes archived history");
        state.rows[values[0]] = {
          id: values[0], contractor_profile_id: values[1], created_by_user_id: values[2], job_id: values[3],
          document_type: values[4], draft_reference: values[5], document_number: values[6],
          content: JSON.parse(values[7]), workspace_context: JSON.parse(values[8]),
          draft_status: "WORKING_DRAFT", version: 1,
          created_at: "2026-09-07T12:00:00Z", updated_at: "2026-09-07T12:00:00Z",
        };
        return result();
      }
      if (["business_document:load_owned", "business_document:load_owned_business_context"].includes(operation)) {
        assert.match(sql, /drafts.draft_status = 'WORKING_DRAFT'/);
        const row = state.rows[values[0]];
        return result(row?.draft_status === "WORKING_DRAFT" && values[1] === 1 ? [row] : []);
      }
      if (operation === "business_document:load_photos") return result(state.photos[values[0]] || []);
      if (operation === "business_document:detach_photos") return result();
      if (operation === "business_document:update") {
        const row = state.rows[values[0]];
        assert.equal(row.document_number, values[5]);
        row.content = JSON.parse(values[3]); row.version++;
        return result();
      }
      if (operation === "business_document:archive_working_draft") {
        assert.match(sql, /version = version \+ 1/);
        const row = state.rows[values[0]];
        row.draft_status = "ARCHIVED"; row.version++;
        return result([{ id: row.id }]);
      }
      if (operation === "business_document:list") {
        assert.match(sql, /drafts.draft_status = 'WORKING_DRAFT'/);
        return result(Object.values(state.rows).filter((row) => row.draft_status === "WORKING_DRAFT"));
      }
      throw new Error(`Unexpected SQL: ${operation}`);
    },
    release() { calls.push({ operation: "release" }); },
  };
  return { pool: { async connect() { return client; }, query: client.query }, calls, state: () => state };
}

function createInput(db, id = "draft-1", key = "save-1") {
  return {
    pool: db.pool, actorUserId: 1, contractorProfileId: 10,
    command: { actorUserId: 1, operation: "CREATE", key, hash: "hash" },
    draft: { id, documentType: "QUOTE", reference: `internal-${id}`, jobId: null, customerParty: null,
      workspace: {}, content: { customerName: "Bob", projectTitle: "Repair" }, photos: [] },
  };
}

test("first explicit CREATE allocates Q-0000003 and commits exact document atomically", async () => {
  const db = database();
  const input = createInput(db);
  const saved = await sqlStore.create(input);
  assert.equal(saved.document.documentNumber, "Q-0000003");
  assert.equal(db.state().lastNumber, 3);
  assert.equal(db.state().rows["draft-1"].document_number, "Q-0000003");
  const operations = db.calls.map((call) => call.operation);
  assert.ok(operations.indexOf("BEGIN") < operations.indexOf("business_document_numbering:allocate"));
  assert.ok(operations.indexOf("business_document_numbering:allocate") < operations.indexOf("business_document:create"));
  assert.ok(operations.indexOf("business_document:create") < operations.indexOf("COMMIT"));
  const replay = await sqlStore.create(input);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.document.documentNumber, "Q-0000003");
  assert.equal(db.state().lastNumber, 3);
});

for (const failAt of ["business_document:create", "business_document:detach_photos", "business_document:finish_command", "COMMIT"]) {
  test(`failed save at ${failAt} rolls back document, command and counter`, async () => {
    const db = database({ failAt });
    await assert.rejects(sqlStore.create(createInput(db)), /injected/);
    assert.equal(db.state().lastNumber, 2);
    assert.deepEqual(db.state().rows, {});
    assert.deepEqual(db.state().commands, {});
    assert.ok(db.calls.some((call) => call.operation === "ROLLBACK"));
    assert.equal(db.calls.at(-1).operation, "release");
  });
}

test("update retains the exact official number without further allocation", async () => {
  const db = database();
  const input = createInput(db);
  await sqlStore.create(input);
  const result = await sqlStore.update({ ...input, draftId: "draft-1", expectedVersion: 1,
    command: { ...input.command, operation: "UPDATE", key: "edit-1" },
    draft: { ...input.draft, content: { customerName: "Bob", projectTitle: "Edited" } } });
  assert.equal(result.document.version, 2);
  assert.equal(result.document.documentNumber, "Q-0000003");
  assert.equal(db.state().lastNumber, 3);
});

test("archive retains history and number, hides from list/get/edit/replay, and never decrements", async () => {
  const db = database();
  const input = createInput(db);
  await sqlStore.create(input);
  db.state().photos["draft-1"] = [{ public_id: "retained-photo" }];
  const removal = await sqlStore.delete({ pool: db.pool, actorUserId: 1, draftId: "draft-1", expectedVersion: 1 });
  assert.equal(removal.deletedDraftId, "draft-1");
  assert.equal(db.state().rows["draft-1"].draft_status, "ARCHIVED");
  assert.equal(db.state().rows["draft-1"].document_number, "Q-0000003");
  assert.equal(db.state().rows["draft-1"].content.customerName, "Bob");
  assert.equal(db.state().photos["draft-1"].length, 1);
  assert.equal(db.state().lastNumber, 3);
  assert.equal(await sqlStore.get({ pool: db.pool, actorUserId: 1, draftId: "draft-1" }), null);
  assert.deepEqual(await sqlStore.list({ pool: db.pool, actorUserId: 1, query: {} }), []);
  assert.equal((await sqlStore.create(input)).kind, "not_found");
  assert.equal((await sqlStore.update({ ...input, draftId: "draft-1", expectedVersion: 2,
    command: { ...input.command, operation: "UPDATE", key: "edit" } })).kind, "not_found");
  const next = await sqlStore.create(createInput(db, "draft-2", "save-2"));
  assert.equal(next.document.documentNumber, "Q-0000004");
  assert.equal(db.state().rows["draft-1"].document_number, "Q-0000003");
  assert.ok(!db.calls.some((call) => /delete_(working_draft|photo_associations)/.test(call.operation)));
});

test("archive migration preserves unique numbers and prevents hard delete or archived mutation", () => {
  const sql = readFileSync(`${__dirname}/../migrations/202609070001_archive_numbered_business_document_drafts.sql`, "utf8");
  const numbering = readFileSync(`${__dirname}/../migrations/202608230001_add_business_document_numbers.sql`, "utf8");
  assert.match(sql, /CHECK \(draft_status IN \('WORKING_DRAFT', 'ARCHIVED'\)\)/);
  assert.match(sql, /CHECK \(draft_status <> 'ARCHIVED' OR document_number IS NOT NULL\)/);
  assert.match(sql, /IF TG_OP = 'DELETE' THEN[\s\S]*OLD.document_number IS NOT NULL[\s\S]*RAISE EXCEPTION/);
  assert.match(sql, /IF OLD.draft_status = 'ARCHIVED' THEN[\s\S]*RAISE EXCEPTION/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(sql, /DROP INDEX|DROP TRIGGER|UPDATE business_document_number_sequences|nextval\(/i);
  assert.match(numbering, /CREATE UNIQUE INDEX[\s\S]*document_number[\s\S]*WHERE document_number IS NOT NULL/);
  assert.match(numbering, /preserve_business_document_number_trigger/);
});
