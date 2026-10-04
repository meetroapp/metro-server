"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getBusinessDocumentNumbering,
  initializeBusinessDocumentNumbering,
  businessDocumentNumberingInternals: {
    allocateDocumentNumber,
    formatDocumentNumber,
    parsePreviousDocumentNumber,
    requestedConfiguration,
    sameConfiguration,
    sequenceProjection,
  },
} = require("../server/documents/businessDocumentNumberingService");

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function rowFrom(configuration, documentType) {
  return {
    contractor_profile_id: 10,
    document_type: documentType,
    number_prefix: configuration.prefix,
    number_width: configuration.width,
    initial_last_number: configuration.initialLastNumber,
    last_number: configuration.initialLastNumber,
    initialization_mode: configuration.mode,
    initialization_source: configuration.source,
    initialized_at: "2026-08-23T12:00:00.000Z",
    initialized_by_user_id: 1,
    first_allocated_at: null,
    updated_at: "2026-08-23T12:00:00.000Z",
  };
}

function memoryStore({ owner = { kind: "resolved", contractorProfileId: 10 } } = {}) {
  const rows = new Map();
  return {
    rows,
    async resolveBusinessOwner(_pool, _actorUserId, jobId) {
      if (jobId && jobId !== JOB_ID) return { kind: "job_unavailable" };
      return owner;
    },
    async getState({ contractorProfileId, documentType }) {
      return rows.get(`${contractorProfileId}:${documentType}`) || null;
    },
    async initialize({ contractorProfileId, documentType, configuration }) {
      const key = `${contractorProfileId}:${documentType}`;
      const existing = rows.get(key);
      if (existing) {
        return sameConfiguration(existing, configuration)
          ? { kind: "existing", row: existing }
          : { kind: "configuration_conflict" };
      }
      const row = rowFrom(configuration, documentType);
      rows.set(key, row);
      return { kind: "initialized", row };
    },
  };
}

test("previous-number parsing normalizes prefix, preserves width, and rejects malformed authority", () => {
  assert.deepEqual(parsePreviousDocumentNumber("BG-0001019"), {
    prefix: "BG",
    width: 7,
    lastNumber: 1019,
    previousDocumentNumber: "BG-0001019",
  });
  assert.deepEqual(parsePreviousDocumentNumber(" acme-0099 "), {
    prefix: "ACME",
    width: 4,
    lastNumber: 99,
    previousDocumentNumber: "ACME-0099",
  });
  for (const malformed of ["BG1019", "B_G-001", "TOO-LONG-001", "BG-", "BG-1234567890123", 1019]) {
    assert.equal(parsePreviousDocumentNumber(malformed), null);
  }
});

test("START_NEW defaults and continued width produce truthful next-number previews", () => {
  const quote = requestedConfiguration("QUOTE", "START_NEW");
  const invoice = requestedConfiguration("INVOICE", "START_NEW");
  const continued = requestedConfiguration("QUOTE", "CONTINUE_EXISTING", "ACME-0099");
  assert.deepEqual(quote, {
    prefix: "Q", width: 7, initialLastNumber: 0,
    mode: "START_NEW", source: "PROFESSIONAL_EXPLICIT",
  });
  assert.deepEqual(invoice, {
    prefix: "INV", width: 7, initialLastNumber: 0,
    mode: "START_NEW", source: "PROFESSIONAL_EXPLICIT",
  });
  assert.equal(
    sequenceProjection(rowFrom(quote, "QUOTE"), "QUOTE").nextNumberPreview,
    "Q-0000001"
  );
  assert.equal(
    sequenceProjection(rowFrom(invoice, "INVOICE"), "INVOICE").nextNumberPreview,
    "INV-0000001"
  );
  assert.equal(
    sequenceProjection(rowFrom(continued, "QUOTE"), "QUOTE").nextNumberPreview,
    "ACME-0100"
  );
  assert.equal(formatDocumentNumber("ACME", 4, 10000), "ACME-10000");
});

test("governed initialization supports START_NEW, continuation, safe replay, and conflict rejection", async () => {
  const store = memoryStore();
  const start = await initializeBusinessDocumentNumbering({
    pool: {}, authenticatedActor: { id: 1 }, store,
    payload: { documentType: "QUOTE", jobId: null, mode: "START_NEW" },
  });
  assert.equal(start.status, 201);
  assert.equal(start.numbering.nextNumberPreview, "Q-0000001");

  const replay = await initializeBusinessDocumentNumbering({
    pool: {}, authenticatedActor: { id: 1 }, store,
    payload: { documentType: "QUOTE", jobId: null, mode: "START_NEW" },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.code, "BUSINESS_DOCUMENT_NUMBERING_ALREADY_INITIALIZED");
  assert.equal(replay.numbering.lastNumber, 0);

  const conflict = await initializeBusinessDocumentNumbering({
    pool: {}, authenticatedActor: { id: 1 }, store,
    payload: {
      documentType: "QUOTE",
      jobId: null,
      mode: "CONTINUE_EXISTING",
      previousDocumentNumber: "BG-0001019",
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "BUSINESS_DOCUMENT_NUMBERING_ALREADY_INITIALIZED");

  const continuedStore = memoryStore();
  const continued = await initializeBusinessDocumentNumbering({
    pool: {}, authenticatedActor: { id: 1 }, store: continuedStore,
    payload: {
      documentType: "QUOTE",
      jobId: JOB_ID,
      mode: "CONTINUE_EXISTING",
      previousDocumentNumber: "BG-0001019",
    },
  });
  assert.equal(continued.status, 201);
  assert.equal(continued.numbering.prefix, "BG");
  assert.equal(continued.numbering.width, 7);
  assert.equal(continued.numbering.lastNumber, 1019);
  assert.equal(continued.numbering.nextNumberPreview, "BG-0001020");
});

test("numbering state maps profile ambiguity and malformed supplied fields without weakening validation", async () => {
  const ambiguous = await getBusinessDocumentNumbering({
    pool: {}, authenticatedActor: { id: 1 },
    query: { documentType: "QUOTE", jobId: null },
    store: memoryStore({ owner: { kind: "profile_ambiguous" } }),
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.code, "BUSINESS_DOCUMENT_PROFILE_AMBIGUOUS");

  const malformed = await initializeBusinessDocumentNumbering({
    pool: {}, authenticatedActor: { id: 1 }, store: memoryStore(),
    payload: {
      documentType: "QUOTE",
      jobId: null,
      mode: "CONTINUE_EXISTING",
      previousDocumentNumber: "not-a-number",
    },
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.code, "BUSINESS_DOCUMENT_PREVIOUS_NUMBER_INVALID");
});

test("allocation atomically updates only a preconfigured sequence and reports setup/exhaustion", async () => {
  const allocatedCalls = [];
  const allocated = await allocateDocumentNumber({
    async query(sql, values) {
      allocatedCalls.push({ sql, values });
      return {
        rows: [{ number_prefix: "BG", number_width: 7, last_number: "1020" }],
      };
    },
  }, 10, "QUOTE");
  assert.deepEqual(allocated, { kind: "allocated", documentNumber: "BG-0001020" });
  assert.equal(allocatedCalls.length, 1);
  assert.match(allocatedCalls[0].sql, /UPDATE business_document_number_sequences/);
  assert.doesNotMatch(allocatedCalls[0].sql, /INSERT INTO business_document_number_sequences/);
  assert.deepEqual(allocatedCalls[0].values, [10, "QUOTE"]);

  const setupRequired = await allocateDocumentNumber({
    calls: 0,
    async query() {
      this.calls += 1;
      return { rows: [] };
    },
  }, 10, "INVOICE");
  assert.deepEqual(setupRequired, { kind: "setup_required" });

  let calls = 0;
  const exhausted = await allocateDocumentNumber({
    async query() {
      calls += 1;
      return calls === 1
        ? { rows: [] }
        : { rows: [{ last_number: "999999999999" }] };
    },
  }, 10, "QUOTE");
  assert.deepEqual(exhausted, { kind: "exhausted" });
});
