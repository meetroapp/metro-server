"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  customerHistoryRecordInternals,
} = require(
  "../server/workflow/jobCompletionService"
);

const source = readFileSync(
  join(
    __dirname,
    "..",
    "server",
    "workflow",
    "jobCompletionService.js"
  ),
  "utf8"
);

const QUOTE_ID =
  "11111111-1111-4111-8111-111111111111";

const VISIT_ID =
  "22222222-2222-4222-8222-222222222222";

const FINDING_ID =
  "33333333-3333-4333-8333-333333333333";

const RECOMMENDATION_ID =
  "44444444-4444-4444-8444-444444444444";

test(
  "customer History deposit projection excludes private payment authority fields",
  () => {
    const result =
      customerHistoryRecordInternals
        .customerHistoryDepositProjection(
          {
            quote_id: QUOTE_ID,
            state: "SATISFIED",
            currency: "USD",
            required_minor: 5000,
            applied_minor: 5000,
            remaining_minor: 0,
            source_integrity_hash:
              "private-hash",
          },
          [{
            gross_amount_minor: 5000,
            applied_minor: 5000,
            currency: "USD",
            method: "Card",
            received_at:
              "2026-09-20T14:00:00.000Z",
            external_reference:
              "private-reference",
          }]
        );

    assert.deepEqual(
      Object.keys(result),
      [
        "quoteId",
        "state",
        "currency",
        "requiredMinor",
        "appliedMinor",
        "remainingMinor",
        "payments",
      ]
    );

    assert.doesNotMatch(
      JSON.stringify(result),
      /integrity|external_reference|private-hash|private-reference/i
    );
  }
);

test(
  "customer History media permits only attached Cloudinary presentation URLs",
  () => {
    const valid =
      customerHistoryRecordInternals
        .customerHistoryMediaProjection({
          media_id:
            "meetro/request/photo-1",
          secure_url:
            "https://res.cloudinary.com/demo/image/upload/photo.jpg",
          format: "jpg",
          uploaded_at:
            "2026-09-20T12:00:00.000Z",
        });

    assert.equal(
      valid.category,
      "REQUEST_PHOTO"
    );

    assert.equal(
      customerHistoryRecordInternals
        .customerHistoryMediaProjection({
          media_id: "unsafe",
          secure_url:
            "javascript:alert(1)",
          format: "jpg",
          uploaded_at:
            "2026-09-20T12:00:00.000Z",
        }),
      null
    );
  }
);

test(
  "customer History Visit projection exposes presentation only",
  () => {
    const visit =
      customerHistoryRecordInternals
        .customerHistoryVisitProjection({
          visit_id: VISIT_ID,
          purpose: "EVALUATION",
          state: "COMPLETED",
          scheduled_start_at:
            "2026-09-20T13:00:00.000Z",
          scheduled_end_at:
            "2026-09-20T14:00:00.000Z",
          time_zone:
            "America/New_York",
          location_mode:
            "ON_SITE",
          completed_at:
            "2026-09-20T14:00:00.000Z",
          created_at:
            "2026-09-19T12:00:00.000Z",
          private_notes:
            "server only",
        });

    assert.equal(
      visit.visitId,
      VISIT_ID
    );

    assert.doesNotMatch(
      JSON.stringify(visit),
      /private_notes|server only/
    );
  }
);

test(
  "Emergency assessment projection keeps customer-safe finding and recommendation fields",
  () => {
    const assessment =
      customerHistoryRecordInternals
        .customerHistoryAssessmentProjection(
          {
            status: "completed",
            completed_at:
              "2026-09-20T15:00:00.000Z",
            created_at:
              "2026-09-20T13:00:00.000Z",
            updated_at:
              "2026-09-20T15:00:00.000Z",
            internal_notes:
              "private",
          },
          [{
            id: FINDING_ID,
            statement:
              "Valve is leaking",
            resolution_state:
              "RESOLVED",
            created_at:
              "2026-09-20T13:10:00.000Z",
            updated_at:
              "2026-09-20T14:00:00.000Z",
          }],
          [{
            id: RECOMMENDATION_ID,
            finding_id:
              FINDING_ID,
            statement:
              "Replace shut-off valve",
            status: "ACCEPTED",
            created_at:
              "2026-09-20T13:20:00.000Z",
            updated_at:
              "2026-09-20T14:10:00.000Z",
          }]
        );

    assert.equal(
      assessment.evaluation.status,
      "COMPLETE"
    );

    assert.equal(
      assessment.findings[0].statement,
      "Valve is leaking"
    );

    assert.doesNotMatch(
      JSON.stringify(assessment),
      /internal_notes|private/
    );
  }
);

test(
  "preserved record SQL remains customer-visible and read-only",
  () => {
    const start =
      source.indexOf(
        "const CUSTOMER_HISTORY_DEPOSIT_STATES"
      );

    const end =
      source.indexOf(
        "async function getHistoryDetail(",
        start
      );

    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const body =
      source.slice(start, end);

    assert.match(
      body,
      /current\.customer_visible\s*=\s*TRUE/
    );

    assert.match(
      body,
      /current\.confirmation_state\s*=\s*'CONFIRMED'/
    );

    assert.match(
      body,
      /'request-photo'/
    );

    assert.match(
      body,
      /canonical_pre_work_deposit_obligations/
    );

    assert.match(
      body,
      /canonical_visits/
    );

    assert.match(
      body,
      /source_context_type\s*=\s*'emergency_request'/
    );

    assert.doesNotMatch(
      body,
      /\b(?:INSERT|UPDATE|DELETE)\b/i
    );
  }
);

test(
  "historyRecords attach only to customer detail",
  () => {
    const start =
      source.indexOf(
        "async function getHistoryDetail("
      );

    const end =
      source.indexOf(
        "const getProfessionalJobHistory",
        start
      );

    const body =
      source.slice(start, end);

    assert.match(
      body,
      /audience === "customer"[\s\S]*loadCustomerHistoryRecords/
    );

    assert.match(
      body,
      /audience === "customer"[\s\S]*historyRecords/
    );
  }
);
