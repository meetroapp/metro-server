"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  quoteDraftServiceInternals: {
    emergencyLegacyEmptyDraftShell,
    promoteEmergencyLegacyEmptyDraft,
    workingQuoteConversion,
  },
} = require(
  "../server/authorization/quoteDraftService"
);

const QUOTE =
  "ef1afb14-0926-421a-991b-07c6ca5ac66e";

const JOB =
  "6f40641c-2f06-4971-aeaa-65598ba777b1";

const PARTICIPANT =
  "1d77be90-f147-496d-a470-d21c759ec4af";

function terms(overrides = {}) {
  return {
    schemaVersion: 1,
    paymentTerms: "Balance due on completion",
    estimatedDuration: "",
    customerNotes: "",
    agreement: {
      exclusions: [],
      additionalWorkTerms: "",
      hiddenConditionsTerms: "",
      diagnosticTerms: "",
      customerResponsibilities: "",
      warrantyTerms: "",
      cancellationTerms: "",
      acceptanceTerms: "",
      preauthorizedAdditionalWorkLimit: "",
    },
    ...overrides,
  };
}

function shell(overrides = {}) {
  const customerTermsSnapshot = terms();

  return {
    id: QUOTE,
    jobId: JOB,
    requestId: null,
    relationshipId: 362,
    issuerParticipantId: PARTICIPANT,
    parentQuoteId: null,
    lineageType: null,
    lineageReasonCategory: null,
    status: "DRAFT",
    issuedAt: null,
    currency: "USD",
    currentVersion: 1,
    materialsSubtotalMinor: 0,
    laborServiceSubtotalMinor: 0,
    totalMinor: 0,
    scopeItemCount: 0,
    conditions: [],
    exclusions: [],
    customerTermsSnapshot,
    integrityVersion: 2,
    scopeItems: [],
    versions: [{
      version: 1,
      status: "DRAFT",
      currency: "USD",
      materialsSubtotalMinor: 0,
      laborServiceSubtotalMinor: 0,
      totalMinor: 0,
      scopeItemCount: 0,
      conditions: [],
      exclusions: [],
      customerTermsSnapshot,
      issuedAt: null,
      integrityVersion: 2,
    }],
    decisionState: null,
    decisionVersion: null,
    decidedAt: null,
    documentNumber: null,
    sourceBusinessDocument: null,
    customerParty: null,
    customerSnapshot: null,
    approval: null,
    ...overrides,
  };
}

function workingContent(overrides = {}) {
  return {
    customerName: "Liam Molina",
    projectTitle:
      "Emergency Plumbing: Outside main waterline is leaking water",
    projectDescription:
      "Replace broken pipe and new shutoff valve installation is recommended.",
    materialItems: [],
    laborItems: [{
      id: "shutoff",
      description: "Shut-off valve replacement",
      total: "350.00",
    }],
    lineItems: [],
    totalOverride: "",
    currency: "USD",
    paymentTerms:
      "Balance due on completion",
    estimatedDuration: "",
    notes: "",
    agreement: {
      exclusions: [],
    },
    ...overrides,
  };
}

test(
  "exact retired Emergency zero-scope V1 Draft is promotable",
  () => {
    assert.equal(
      emergencyLegacyEmptyDraftShell(
        shell(),
        1
      ),
      true
    );
  }
);

test(
  "empty-shell promotion requires the exact retired payment terms",
  () => {
    const alternateTerms = terms({
      paymentTerms: "Net 30",
    });

    const candidate = shell({
      customerTermsSnapshot: alternateTerms,
    });

    candidate.versions = [{
      ...candidate.versions[0],
      customerTermsSnapshot: alternateTerms,
    }];

    assert.equal(
      emergencyLegacyEmptyDraftShell(
        candidate,
        1
      ),
      false
    );
  }
);

test(
  "populated revised mapped issued or decided Quotes cannot use empty-shell promotion",
  () => {
    const variants = [
      shell({
        totalMinor: 1,
      }),
      shell({
        currentVersion: 2,
      }),
      shell({
        parentQuoteId:
          "11111111-1111-4111-8111-111111111111",
      }),
      shell({
        sourceBusinessDocument: {
          documentId:
            "22222222-2222-4222-8222-222222222222",
          documentVersion: 1,
        },
      }),
      shell({
        status: "ISSUED",
        issuedAt:
          "2026-09-29T20:00:00.000Z",
      }),
      shell({
        decisionState: "APPROVED",
        decisionVersion: 1,
        decidedAt:
          "2026-09-29T20:00:00.000Z",
      }),
      shell({
        approval: {
          id:
            "33333333-3333-4333-8333-333333333333",
        },
      }),
      shell({
        customerTermsSnapshot: terms({
          estimatedDuration: "2 days",
        }),
      }),
    ];

    for (const candidate of variants) {
      assert.equal(
        emergencyLegacyEmptyDraftShell(
          candidate,
          1
        ),
        false
      );
    }
  }
);

test(
  "promotion preserves Quote UUID and creates canonical V2 without inserting a second Quote",
  async () => {
    const conversion =
      workingQuoteConversion(
        workingContent()
      );

    assert.equal(
      conversion.error,
      undefined
    );

    assert.equal(
      conversion.totals.totalMinor,
      35000
    );

    const calls = [];

    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params });

        if (
          sql.includes(
            "UPDATE commercial_authority_aggregates"
          )
        ) {
          assert.equal(params[0], QUOTE);
          assert.equal(params[1], 2);
          assert.equal(params[2], 1);

          return {
            rows: [{ id: QUOTE }],
          };
        }

        if (
          sql.includes(
            "UPDATE canonical_quotes"
          )
        ) {
          assert.equal(params[0], QUOTE);
          assert.equal(params[1], "USD");

          return {
            rows: [{ id: QUOTE }],
          };
        }

        if (
          sql.includes(
            "INSERT INTO canonical_quote_scope_items"
          )
        ) {
          assert.equal(params[1], QUOTE);
          assert.equal(params[2], JOB);
          assert.equal(
            params[3],
            PARTICIPANT
          );

          return { rows: [] };
        }

        if (
          sql.includes(
            "INSERT INTO canonical_quote_versions"
          )
        ) {
          assert.equal(params[0], QUOTE);
          assert.equal(params[1], 2);
          assert.equal(params[2], JOB);
          assert.equal(params[4], "USD");
          assert.equal(params[7], 35000);
          assert.equal(params[8], 1);

          return {
            rows: [{
              integrity_hash:
                "a".repeat(64),
            }],
          };
        }

        if (
          sql.includes(
            "INSERT INTO canonical_quote_scope_item_snapshots"
          )
        ) {
          assert.equal(params[0], QUOTE);
          assert.equal(params[1], 2);
          assert.equal(params[4], JOB);

          return { rows: [] };
        }

        throw new Error(
          `Unexpected SQL: ${sql.slice(0, 120)}`
        );
      },
    };

    const promoted =
      await promoteEmergencyLegacyEmptyDraft({
        client,
        quote: shell(),
        conversion,
        jobId: JOB,
        actorParticipantId:
          PARTICIPANT,
      });

    assert.equal(
      promoted.error,
      undefined
    );

    assert.equal(
      promoted.quoteId,
      QUOTE
    );

    assert.equal(
      promoted.previousVersion,
      1
    );

    assert.equal(
      promoted.nextVersion,
      2
    );

    assert.equal(
      promoted.snapshots.length,
      1
    );

    assert.equal(
      promoted.version.totals.totalMinor,
      35000
    );

    assert.equal(
      calls.some(({ sql }) =>
        /INSERT INTO canonical_quotes\s*\(/.test(sql)
      ),
      false
    );
  }
);

test(
  "promotion rejects zero-value working content",
  async () => {
    const conversion =
      workingQuoteConversion(
        workingContent({
          laborItems: [{
            description:
              "Shut-off valve replacement",
            total: "0.00",
          }],
        })
      );

    const client = {
      query() {
        throw new Error(
          "database must not be reached"
        );
      },
    };

    const result =
      await promoteEmergencyLegacyEmptyDraft({
        client,
        quote: shell(),
        conversion,
        jobId: JOB,
        actorParticipantId:
          PARTICIPANT,
      });

    assert.equal(
      result.error.code,
      "EMERGENCY_WORKING_QUOTE_CONTENT_CONFLICT"
    );
  }
);

test(
  "Emergency import branch promotes only the exact empty shell and retains ordinary conflict protection",
  () => {
    const source = readFileSync(
      join(
        __dirname,
        "..",
        "server",
        "authorization",
        "quoteDraftService.js"
      ),
      "utf8"
    );

    const start = source.indexOf(
      "if (emergencyOrigin && emergencyDraft)"
    );

    const end = source.indexOf(
      "const existing = await client.query(",
      start
    );

    const branch =
      source.slice(start, end);

    assert.ok(start >= 0);
    assert.ok(end > start);

    assert.match(
      branch,
      /emergencyLegacyEmptyDraftShell/
    );

    assert.match(
      branch,
      /promoteEmergencyLegacyEmptyDraft/
    );

    assert.match(
      branch,
      /EMERGENCY_WORKING_QUOTE_CONTENT_CONFLICT/
    );

    assert.match(
      branch,
      /canonical_quote_business_document_sources/
    );

    assert.match(
      branch,
      /QUOTE_EVIDENCE_TYPES\.SCOPE_ADDED/
    );

    assert.doesNotMatch(
      branch,
      /INSERT INTO canonical_quotes\s*\(/
    );
  }
);
