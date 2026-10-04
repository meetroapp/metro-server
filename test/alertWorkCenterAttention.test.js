"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  WORK_CENTER_STAGES,
  countWorkCenterAttentionForRecipientWithClient,
  projectWorkCenterAttention,
} = require("../server/alerts/workCenterAttention");
const {
  visitServiceInternals,
} = require("../server/workflow/visitService");

const JOB_A = "072c8736-5d97-4253-ba3e-dd1bce281a20";
const JOB_B = "172c8736-5d97-4253-ba3e-dd1bce281a21";

test("Work Center attention query is recipient-owned active unread canonical Alert truth", async () => {
  let sql = "";
  let params = null;

  const rows = await countWorkCenterAttentionForRecipientWithClient({
    client: {
      async query(text, values) {
        sql = String(text);
        params = values;
        return {
          rows: [
            {
              job_id: JOB_A,
              request_id: 41,
              stage: "evaluation",
              unread_count: 1,
            },
          ],
        };
      },
    },
    recipientUserId: 7,
  });

  assert.deepEqual(params, [7]);
  assert.equal(rows.length, 1);

  assert.match(sql, /alerts:work_center_attention_counts/);
  assert.match(sql, /recipient_user_id = \$1/);
  assert.match(sql, /lifecycle_state = 'active'/);
  assert.match(sql, /read_at IS NULL/);
  assert.match(sql, /archived_at IS NULL/);
  assert.match(sql, /destination_payload \? 'jobId'/);
  assert.match(sql, /safe_payload->>'workCenterStage'/);
  assert.match(sql, /LEFT JOIN canonical_visits/);
  assert.match(sql, /LEFT JOIN jobs/);

  assert.match(sql, /quote\.delivered/);
  assert.match(sql, /quote\.customer_approved/);
  assert.match(sql, /deposit\.required/);
  assert.match(sql, /deposit\.satisfied/);
  assert.match(sql, /visit\.started/);
  assert.match(sql, /visit\.completed/);
});

test("Work Center attention groups one recipient by exact Job and semantic lifecycle stage", () => {
  assert.deepEqual(WORK_CENTER_STAGES, [
    "evaluation",
    "quote",
    "deposit",
    "schedule",
    "work",
    "invoice",
    "completion",
    "review",
  ]);

  assert.deepEqual(
    projectWorkCenterAttention([
      { job_id: JOB_A, request_id: 41, stage: "quote", unread_count: "2" },
      { job_id: JOB_A, request_id: 41, stage: "evaluation", unread_count: "1" },
      { job_id: JOB_A, request_id: 41, stage: "quote", unread_count: "1" },
      { job_id: JOB_B, request_id: 42, stage: "deposit", unread_count: 4 },

      // Fail closed — malformed or unsupported rows never gain attention.
      { job_id: "not-a-job", stage: "quote", unread_count: 100 },
      { job_id: JOB_A, stage: "invented", unread_count: 100 },
      { job_id: JOB_A, stage: "work", unread_count: -1 },
    ]),
    {
      unread: 8,
      byJob: [
        {
          jobId: JOB_A,
          requestId: 41,
          unread: 4,
          stages: [
            { stage: "evaluation", unread: 1 },
            { stage: "quote", unread: 3 },
          ],
        },
        {
          jobId: JOB_B,
          requestId: 42,
          unread: 4,
          stages: [
            { stage: "deposit", unread: 4 },
          ],
        },
      ],
    }
  );
});

test("Visit lifecycle Alert policy includes confirmation, start, completion, change, and cancellation", () => {
  const source = readFileSync(
    join(
      __dirname,
      "..",
      "server",
      "workflow",
      "visitService.js"
    ),
    "utf8"
  );

  for (const marker of [
    'eventType: "visit.proposed"',
    'eventType: "visit.schedule_proposed"',
    'eventType: "visit.change_requested"',
    'eventType: "visit.confirmed"',
    'eventType: "visit.cancelled"',
    'eventType: "visit.started"',
    'eventType: "visit.completed"',
  ]) {
    assert.match(source, new RegExp(
      marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    ));
  }

  assert.match(
    source,
    /VISIT_STARTED[\s\S]*alerts\.schedule\.visitStarted\.title/
  );
  assert.match(
    source,
    /VISIT_COMPLETED[\s\S]*alerts\.schedule\.visitCompleted\.title/
  );
});


test("Visit Work Center stage is derived only from canonical Visit purpose and event", () => {
  const {
    workCenterStageForVisit,
  } = visitServiceInternals;

  assert.equal(
    workCenterStageForVisit("EVALUATION", "VISIT_PROPOSED"),
    "evaluation"
  );
  assert.equal(
    workCenterStageForVisit("EVALUATION", "VISIT_STARTED"),
    "evaluation"
  );
  assert.equal(
    workCenterStageForVisit("EVALUATION", "VISIT_COMPLETED"),
    "evaluation"
  );

  assert.equal(
    workCenterStageForVisit("APPROVED_WORK", "VISIT_PROPOSED"),
    "schedule"
  );
  assert.equal(
    workCenterStageForVisit("APPROVED_WORK", "VISIT_CONFIRMED"),
    "schedule"
  );
  assert.equal(
    workCenterStageForVisit("APPROVED_WORK", "VISIT_STARTED"),
    "work"
  );
  assert.equal(
    workCenterStageForVisit("APPROVED_WORK", "VISIT_COMPLETED"),
    "work"
  );

  assert.equal(
    workCenterStageForVisit("FOLLOW_UP", "VISIT_PROPOSED"),
    "work"
  );

  assert.equal(
    workCenterStageForVisit("UNKNOWN", "VISIT_PROPOSED"),
    null
  );
});

test("canonical commercial Alerts carry semantic Work Center presentation hints", () => {
  const quoteDelivery = readFileSync(
    join(__dirname, "..", "server", "authorization", "quoteDeliveryService.js"),
    "utf8"
  );
  const conversation = readFileSync(
    join(__dirname, "..", "server", "conversations", "conversationMessageService.js"),
    "utf8"
  );
  const deposit = readFileSync(
    join(__dirname, "..", "server", "finance", "preWorkDepositService.js"),
    "utf8"
  );

  assert.match(
    quoteDelivery,
    /workCenterStage:\s*"quote"/
  );

  assert.match(
    conversation,
    /workCenterStage:[\s\S]*approved && deposit\.state === "DEPOSIT_DUE"[\s\S]*\? "deposit"[\s\S]*: "quote"/
  );

  assert.match(
    deposit,
    /deposit\.required[\s\S]*workCenterStage:\s*"deposit"/
  );

  assert.match(
    deposit,
    /deposit\.satisfied[\s\S]*workCenterStage:\s*"deposit"/
  );
});


test("approved Quote with required deposit guides the professional to Deposit & Scheduling", () => {
  const conversation = readFileSync(
    join(
      __dirname,
      "..",
      "server",
      "conversations",
      "conversationMessageService.js"
    ),
    "utf8"
  );

  assert.match(
    conversation,
    /approved && deposit\.state === "DEPOSIT_DUE"/
  );
  assert.match(
    conversation,
    /\? "deposit"\s*:\s*"quote"/
  );
});
