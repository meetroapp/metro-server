"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const service = require("../server/authorization/quoteDraftService");
const { quoteDraftServiceInternals: internals } = service;

const draftId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const contactId = "77777777-7777-4777-8777-777777777777";
const customerRelationshipId = "88888888-8888-4888-8888-888888888888";

function content(overrides = {}) {
  return {
    customerName: "External Customer Display Name",
    projectTitle: "Fan replacement",
    projectDescription: "Replace the fan.",
    materialItems: [{ id: "fan", name: "Fan", total: "89.99" }],
    laborItems: [{ id: "install", description: "Installation", total: "180.00" }],
    lineItems: [],
    totalOverride: "",
    currency: "USD",
    paymentTerms: "",
    estimatedDuration: "",
    notes: "",
    agreement: { exclusions: [] },
    ...overrides,
  };
}

test("working Quote components map deterministically to canonical material and labor scope", () => {
  const result = internals.workingQuoteConversion(content());
  assert.equal(result.error, undefined);
  assert.equal(result.currency, "USD");
  assert.equal(result.totals.totalMinor, 26999);
  assert.deepEqual(
    result.items.map(({ classification, description, lineTotalMinor }) => ({
      classification,
      description,
      lineTotalMinor,
    })),
    [
      { classification: "MATERIAL", description: "Fan", lineTotalMinor: 8999 },
      { classification: "LABOR_SERVICE", description: "Installation", lineTotalMinor: 18000 },
    ]
  );
});

test("project total override becomes one counted scope item without component double-counting", () => {
  const result = internals.workingQuoteConversion(content({
    projectTitle: "Front knee wall reconstruction",
    totalOverride: "$2,650.00",
    subtotal: "269.99",
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, "Front knee wall reconstruction");
  assert.equal(result.items[0].lineTotalMinor, 265000);
  assert.equal(result.totals.totalMinor, 265000);
});

test("explicit labor hours and rate are converted without a second pricing engine", () => {
  const result = internals.workingQuoteConversion(content({
    materialItems: [],
    laborItems: [{ description: "Labor", hours: "8", rate: "75" }],
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.items[0].lineTotalMinor, 60000);
  assert.equal(result.totals.totalMinor, 60000);
});

test("full saved Agreement normalizes through the R1A terms contract", () => {
  const result = internals.workingQuoteConversion(content({
    paymentTerms: " 50% deposit. ",
    estimatedDuration: " 3 days ",
    notes: " Protect landscaping. ",
    exclusions: ["Permit fees"],
    agreement: {
      exclusions: ["Hidden damage"],
      additionalWorkTerms: " Written approval required. ",
      hiddenConditionsTerms: " Hidden conditions require revision. ",
      diagnosticTerms: " Diagnostic work is limited. ",
      customerResponsibilities: " Provide safe access. ",
      warrantyTerms: " One year. ",
      cancellationTerms: " Notice required. ",
      acceptanceTerms: " Applies to this version. ",
      preauthorizedAdditionalWorkLimit: " $150 ",
    },
  }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.customerTermsSnapshot, {
    schemaVersion: 1,
    paymentTerms: "50% deposit.",
    estimatedDuration: "3 days",
    customerNotes: "Protect landscaping.",
    agreement: {
      exclusions: ["Hidden damage", "Permit fees"],
      additionalWorkTerms: "Written approval required.",
      hiddenConditionsTerms: "Hidden conditions require revision.",
      diagnosticTerms: "Diagnostic work is limited.",
      customerResponsibilities: "Provide safe access.",
      warrantyTerms: "One year.",
      cancellationTerms: "Notice required.",
      acceptanceTerms: "Applies to this version.",
      preauthorizedAdditionalWorkLimit: "$150",
    },
  });
  assert.equal(internals.workingQuoteConversion(content()).customerTermsSnapshot, null);
});

test("source fingerprint preserves exact inherited numbers and excludes private workspace", () => {
  const conversion = internals.workingQuoteConversion(content());
  const input = {
    draftId,
    documentVersion: 4,
    jobId,
    documentNumber: "BG-0001020",
    conversion,
  };
  const first = internals.businessDocumentSourceFingerprint(input);
  assert.equal(first, internals.businessDocumentSourceFingerprint(input));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, internals.businessDocumentSourceFingerprint({
    ...input,
    documentNumber: "Q-0000001",
  }));
  const linked = internals.businessDocumentSourceFingerprint({
    ...input,
    customerParty: {
      contractorProfileId: 10,
      businessContactId: contactId,
      customerRelationshipId,
    },
  });
  assert.notEqual(linked, first);
  assert.notEqual(linked, internals.businessDocumentSourceFingerprint({
    ...input,
    customerParty: {
      contractorProfileId: 10,
      businessContactId: "99999999-9999-4999-8999-999999999999",
      customerRelationshipId,
    },
  }));
  assert.equal(JSON.stringify(input).includes("privateReminders"), false);
});

test("unrepresentable adjustments, authority fields, and malformed rows fail closed", () => {
  assert.equal(
    internals.workingQuoteConversion(content({ tax: "15" })).error,
    "UNREPRESENTABLE_WORKING_QUOTE_ADJUSTMENT"
  );
  assert.equal(
    internals.workingQuoteConversion(content({ paidAmount: "1" })).error,
    "UNREPRESENTABLE_WORKING_QUOTE_AUTHORITY"
  );
  assert.equal(
    internals.workingQuoteConversion(content({
      materialItems: [{ name: "Fan", total: "89.99", approvalState: "APPROVED" }],
    })).error,
    "INVALID_WORKING_QUOTE_CONTENT"
  );
});

test("bridge rejects client-owned identity, totals, lifecycle, and customer authority before database access", async () => {
  const pool = { query() { throw new Error("database should not be reached"); } };
  const base = {
    pool,
    authenticatedActor: { id: 7 },
    draftId,
    expectedDocumentVersion: 1,
    idempotencyKey: "bridge-key",
  };
  for (const field of [
    ["documentNumber", "Q-9999999"],
    ["jobId", jobId],
    ["contractorProfileId", 8],
    ["totalMinor", 1],
    ["status", "ISSUED"],
    ["customerDecision", "APPROVED"],
    ["customerUserId", 9],
  ]) {
    const result = await service.importBusinessDocumentDraftQuote({
      ...base,
      [field[0]]: field[1],
    });
    assert.equal(result.code, "QUOTE_AUTHORITY_FIELD_REJECTED");
  }
});

test("bridge source contains no numbering allocation, customer fabrication, or lifecycle side effects", () => {
  const source = readFileSync(
    join(__dirname, "..", "server", "authorization", "quoteDraftService.js"),
    "utf8"
  );
  const bridge = source.slice(
    source.indexOf("async function importBusinessDocumentDraftQuote"),
    source.indexOf("async function createDraftQuote")
  );
  assert.doesNotMatch(bridge, /allocateDocumentNumber|business_document_number_sequences|draft_reference/);
  assert.doesNotMatch(bridge, /INSERT INTO\s+users|INSERT INTO\s+relationship_participants/i);
  assert.doesNotMatch(bridge, /quote\.issue|quote\.customer\.(?:approve|decline)|payment|schedule|job\.complete/i);
  assert.doesNotMatch(bridge, /customerName/);
  for (const intelligenceSource of [
    "operations/quoteCompose.js",
    "operations/workflowAssist.js",
    "operations/quickQuoteAnalysisContinue.js",
    "operations/quickQuotePhotoAssist.js",
  ]) {
    const text = readFileSync(join(__dirname, "..", "server", "intelligence", intelligenceSource), "utf8");
    assert.doesNotMatch(text, /importBusinessDocumentDraftQuote|quote\.draft\.import_business_document/);
  }
});

function createBridgePool({
  documentNumber = "Q-0000001",
  documentType = "QUOTE",
  sourceJobId = jobId,
  sourceVersion = 4,
  existingRoot = false,
  customerParty = null,
} = {}) {
  const participantId = "33333333-3333-4333-8333-333333333333";
  const state = {
    source: {
      id: draftId,
      contractor_profile_id: 10,
      job_id: sourceJobId,
      document_type: documentType,
      draft_status: "WORKING_DRAFT",
      document_number: documentNumber,
      content: content(),
      version: sourceVersion,
      business_contact_id: customerParty?.businessContactId || null,
      business_customer_relationship_id:
        customerParty?.customerRelationshipId || null,
    },
    mapping: null,
    idempotency: new Map(),
    quoteId: null,
    version: null,
    snapshots: [],
    evidenceWrites: 0,
    sourceWrites: 0,
    quoteCustomerParty: null,
    customerPartyWrites: 0,
  };
  const pool = {
    state,
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("/* quote_business_document:load_owned_mapping */")) {
        return { rows: state.mapping ? [state.mapping] : [] };
      }
      if (sql.includes("/* quote_business_document:load_owned_source */")) {
        return { rows: state.source && Number(values[1]) === 1 ? [state.source] : [] };
      }
      if (sql.includes("/* customer_party:load_owned */")) {
        const valid = customerParty &&
          Number(values[0]) === 1 && Number(values[1]) === 10 &&
          values[2] === customerParty.businessContactId &&
          values[3] === customerParty.customerRelationshipId;
        return { rows: valid ? [{
          contractor_profile_id: 10,
          business_contact_id: customerParty.businessContactId,
          business_customer_relationship_id:
            customerParty.customerRelationshipId,
        }] : [] };
      }
      if (sql.includes("FROM jobs") && sql.includes("INNER JOIN posts")) {
        return { rows: [{
          job_id: jobId,
          job_request_id: 41,
          relationship_id: 51,
          lifecycle_contract_version: 2,
          homeowner_user_id: 2,
          relationship_status: "active",
          selected_professional_user_id: 1,
          actor_participant_id: participantId,
          actor_user_id: 1,
          actor_is_primary_professional: true,
        }] };
      }
      if (sql.includes("/* lifecycle_authority:active_grant */")) {
        return { rows: [{ id: "44444444-4444-4444-8444-444444444444" }] };
      }
      if (sql.startsWith("INSERT INTO commercial_command_idempotency")) {
        const identity = `${values[1]}:${values[2]}:${values[3]}:${values[4]}`;
        if (state.idempotency.has(identity)) return { rows: [] };
        const row = {
          id: values[0],
          actor_user_id: values[1],
          command_name: values[2],
          command_scope: values[3],
          idempotency_key: values[4],
          request_fingerprint: values[5],
          aggregate_id: null,
          result_reference: null,
          completed_at: null,
        };
        state.idempotency.set(identity, row);
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT * FROM commercial_command_idempotency")) {
        const identity = `${values[0]}:${values[1]}:${values[2]}:${values[3]}`;
        const row = state.idempotency.get(identity);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("SELECT id FROM canonical_quotes")) {
        return { rows: existingRoot ? [{ id: "55555555-5555-4555-8555-555555555555" }] : [] };
      }
      if (sql.startsWith("INSERT INTO commercial_authority_aggregates")) {
        state.quoteId = values[0];
        return { rows: [{ id: values[0] }] };
      }
      if (sql.startsWith("INSERT INTO canonical_quotes")) {
        return { rows: [{ id: values[0], status: "DRAFT" }] };
      }
      if (sql.includes("/* customer_party:insert_canonical_quote */")) {
        state.customerPartyWrites += 1;
        state.quoteCustomerParty = {
          quote_id: values[0],
          job_id: values[1],
          contractor_profile_id: values[2],
          business_contact_id: values[3],
          business_customer_relationship_id: values[4],
          linked_by_user_id: values[5],
          created_at: "2026-08-24T12:00:00.000Z",
        };
        return { rows: [state.quoteCustomerParty] };
      }
      if (sql.startsWith("INSERT INTO canonical_quote_scope_items")) return { rows: [] };
      if (sql.startsWith("INSERT INTO canonical_quote_versions")) {
        state.version = {
          quote_id: values[0],
          version: values[1],
          job_id: values[2],
          status: values[3],
          currency: values[4],
          materials_subtotal_minor: values[5],
          labor_service_subtotal_minor: values[6],
          total_minor: values[7],
          scope_item_count: values[8],
          conditions_snapshot: JSON.parse(values[9]),
          exclusions_snapshot: JSON.parse(values[10]),
          customer_terms_snapshot: values[11] == null ? null : JSON.parse(values[11]),
          issued_at: values[12],
          integrity_hash: values[14],
          integrity_version: values[15],
          created_at: "2026-08-23T12:00:00.000Z",
        };
        return { rows: [state.version] };
      }
      if (sql.startsWith("INSERT INTO canonical_quote_scope_item_snapshots")) {
        state.snapshots.push({
          quote_id: values[0],
          quote_version: values[1],
          scope_item_id: values[2],
          scope_item_revision: values[3],
          job_id: values[4],
          sequence: values[5],
          classification: values[6],
          scope_semantic: values[7],
          material_responsibility: values[8],
          description: values[9],
          quantity: values[10],
          unit_amount_minor: values[11],
          line_total_minor: values[12],
          included_in_total: values[13],
          source_type: values[14],
          source_version: values[15],
          source_workstream_version: values[16],
          source_finding_id: values[17],
          source_recommendation_id: values[18],
          source_workstream_id: values[19],
          source_activity_id: values[20],
          source_obligation_id: values[21],
          created_at: "2026-08-23T12:00:00.000Z",
        });
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO canonical_quote_business_document_sources")) {
        state.sourceWrites += 1;
        state.mapping = {
          quote_id: values[0],
          job_id: values[1],
          contractor_profile_id: values[2],
          source_document_id: values[3],
          source_document_version: values[4],
          document_number: values[5],
          source_snapshot_integrity_hash: values[6],
          created_by_user_id: values[7],
        };
        return { rows: [{ quote_id: values[0] }] };
      }
      if (sql.startsWith("INSERT INTO commercial_authority_evidence")) {
        state.evidenceWrites += 1;
        return { rows: [{ id: values[0] }] };
      }
      if (sql.includes("FROM canonical_quotes quotes") && sql.includes("business_sources")) {
        const version = state.version;
        return { rows: [{
          id: state.quoteId,
          job_id: jobId,
          job_request_id: 41,
          relationship_id: 51,
          issuer_participant_id: participantId,
          parent_quote_id: null,
          lineage_type: null,
          lineage_reason_category: null,
          status: "DRAFT",
          issued_at: null,
          currency: version.currency,
          current_version: 1,
          materials_subtotal_minor: version.materials_subtotal_minor,
          labor_service_subtotal_minor: version.labor_service_subtotal_minor,
          total_minor: version.total_minor,
          scope_item_count: version.scope_item_count,
          conditions_snapshot: version.conditions_snapshot,
          exclusions_snapshot: version.exclusions_snapshot,
          customer_terms_snapshot: version.customer_terms_snapshot,
          integrity_version: version.integrity_version,
          customer_decision: null,
          customer_decision_quote_version: null,
          customer_decided_at: null,
          business_document_number: state.mapping.document_number,
          business_source_document_id: state.mapping.source_document_id,
          business_source_document_version: state.mapping.source_document_version,
          customer_party_contractor_profile_id:
            state.quoteCustomerParty?.contractor_profile_id || null,
          business_contact_id:
            state.quoteCustomerParty?.business_contact_id || null,
          business_customer_relationship_id:
            state.quoteCustomerParty?.business_customer_relationship_id || null,
          created_at: version.created_at,
          updated_at: version.created_at,
        }] };
      }
      if (sql.startsWith("SELECT * FROM canonical_quote_scope_item_snapshots")) {
        return { rows: state.snapshots };
      }
      if (sql.startsWith("SELECT version, status, currency")) {
        return { rows: [state.version] };
      }
      if (sql.startsWith("UPDATE commercial_command_idempotency")) {
        const row = [...state.idempotency.values()].find(({ id }) => id === values[0]);
        if (!row || row.aggregate_id) return { rows: [] };
        row.aggregate_id = values[1];
        row.result_reference = values[2];
        row.completed_at = "2026-08-23T12:00:00.000Z";
        return { rows: [{ id: row.id }] };
      }
      throw new Error(`Unexpected bridge SQL: ${sql}`);
    },
  };
  return pool;
}

test("governed bridge inherits the exact number, creates one Draft, and replays without duplication", async () => {
  for (const documentNumber of ["Q-0000001", "BG-0001020"]) {
    const pool = createBridgePool({ documentNumber });
    const command = {
      pool,
      authenticatedActor: { id: 1 },
      draftId,
      expectedDocumentVersion: 4,
      idempotencyKey: `bridge-${documentNumber}`,
      logger: { info() {}, warn() {} },
    };
    const created = await service.importBusinessDocumentDraftQuote(command);
    assert.equal(created.ok, true);
    assert.equal(created.code, "BUSINESS_DOCUMENT_DRAFT_QUOTE_IMPORTED");
    assert.equal(created.quote.status, "DRAFT");
    assert.equal(created.quote.documentNumber, documentNumber);
    assert.deepEqual(created.quote.sourceBusinessDocument, {
      documentId: draftId,
      documentVersion: 4,
    });
    assert.equal(created.quote.totalMinor, 26999);
    assert.equal(pool.state.source.draft_status, "WORKING_DRAFT");
    assert.equal(pool.state.sourceWrites, 1);
    assert.equal(pool.state.evidenceWrites, 1);

    const replay = await service.importBusinessDocumentDraftQuote(command);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.quote.id, created.quote.id);
    assert.equal(pool.state.sourceWrites, 1);
    assert.equal(pool.state.evidenceWrites, 1);

    const bounded = await service.importBusinessDocumentDraftQuote({
      ...command,
      idempotencyKey: `${command.idempotencyKey}-different`,
    });
    assert.equal(bounded.code, "BUSINESS_DOCUMENT_QUOTE_ALREADY_CANONICALIZED");
    assert.equal(bounded.quote.id, created.quote.id);
    assert.equal(pool.state.sourceWrites, 1);

    pool.state.source.version = 5;
    pool.state.source.content = content({ totalOverride: "999.00" });
    const afterSourceEdit = await service.importBusinessDocumentDraftQuote({
      ...command,
      idempotencyKey: `${command.idempotencyKey}-after-source-edit`,
    });
    assert.equal(afterSourceEdit.quote.id, created.quote.id);
    assert.equal(afterSourceEdit.quote.totalMinor, 26999);
    assert.equal(afterSourceEdit.quote.sourceBusinessDocument.documentVersion, 4);
    assert.equal(pool.state.sourceWrites, 1);
  }
});

test("governed bridge preserves an explicit source customer party once without changing the Quote snapshot", async () => {
  const pool = createBridgePool({
    customerParty: {
      businessContactId: contactId,
      customerRelationshipId,
    },
  });
  const command = {
    pool,
    authenticatedActor: { id: 1 },
    draftId,
    expectedDocumentVersion: 4,
    idempotencyKey: "bridge-linked-customer-party",
    logger: { info() {}, warn() {} },
  };
  const created = await service.importBusinessDocumentDraftQuote(command);
  assert.equal(created.ok, true);
  assert.deepEqual(created.quote.customerParty, {
    contractorProfileId: 10,
    businessContactId: contactId,
    customerRelationshipId,
  });
  assert.equal(created.quote.totalMinor, 26999);
  assert.equal(pool.state.source.content.customerName, "External Customer Display Name");
  assert.equal(pool.state.customerPartyWrites, 1);

  const replay = await service.importBusinessDocumentDraftQuote(command);
  assert.equal(replay.replayed, true);
  assert.equal(pool.state.customerPartyWrites, 1);
  assert.equal(replay.quote.customerParty.businessContactId, contactId);
  assert.equal(replay.quote.totalMinor, 26999);
});

test("bridge fails closed for unnumbered, Invoice, missing-Job, wrong-owner, stale, and root-conflict sources", async () => {
  const cases = [
    [{ documentNumber: null }, { id: 1 }, 4, "BUSINESS_DOCUMENT_QUOTE_NUMBER_REQUIRED"],
    [{ documentType: "INVOICE" }, { id: 1 }, 4, "BUSINESS_DOCUMENT_QUOTE_REQUIRED"],
    [{ sourceJobId: null }, { id: 1 }, 4, "BUSINESS_DOCUMENT_QUOTE_JOB_REQUIRED"],
    [{}, { id: 2 }, 4, "BUSINESS_DOCUMENT_QUOTE_UNAVAILABLE"],
    [{ sourceVersion: 5 }, { id: 1 }, 4, "STALE_BUSINESS_DOCUMENT_VERSION"],
    [{ existingRoot: true }, { id: 1 }, 4, "ROOT_QUOTE_ALREADY_EXISTS"],
  ];
  for (const [options, actor, expectedDocumentVersion, expectedCode] of cases) {
    const pool = createBridgePool(options);
    const result = await service.importBusinessDocumentDraftQuote({
      pool,
      authenticatedActor: actor,
      draftId,
      expectedDocumentVersion,
      idempotencyKey: `bridge-failure-${expectedCode}`,
      logger: { info() {}, warn() {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, expectedCode);
    assert.equal(pool.state.sourceWrites, 0);
    assert.equal(pool.state.evidenceWrites, 0);
  }
});
