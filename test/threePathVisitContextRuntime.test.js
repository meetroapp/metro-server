"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const test =
  require("node:test");

const {
  BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
} = require(
  "../server/relationships/businessCustomerJobService"
);

const visit = readFileSync(
  "server/workflow/visitService.js",
  "utf8"
);

const business = readFileSync(
  "server/relationships/businessCustomerJobService.js",
  "utf8"
);


test(
  "repeat Meetro Job is admitted without Request Selection",
  () => {
    assert.match(
      visit,
      /jobs\.source_type =\s*'existing_customer_request'[\s\S]*posts\.request_origin =\s*'existing_customer_request'[\s\S]*ordinary_authority_source =\s*'existing_customer_request'[\s\S]*source_request_selection_id[\s\S]*IS NULL/i
    );

    assert.match(
      visit,
      /source_evidence_type =\s*'existing_customer_request'/i
    );
  }
);


test(
  "business customer Visit context is professional-only",
  () => {
    assert.match(
      visit,
      /jobs\.source_type =\s*'business_customer'/i
    );

    assert.match(
      visit,
      /source_evidence_type =\s*'business_customer'/i
    );

    assert.match(
      visit,
      /jobs\.job_request_id IS NULL[\s\S]*source_request_selection_id[\s\S]*IS NULL[\s\S]*source_request_relationship_id[\s\S]*IS NULL[\s\S]*originating_business_document_id[\s\S]*IS NULL/i
    );

    assert.doesNotMatch(
      business,
      /CUSTOMER_REPRESENTATIVE/
    );
  }
);


test(
  "business customer Evaluation Visit authority uses business-recorded confirmation instead of Meetro customer authority",
  () => {
    assert.deepEqual(
      BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
      [
        "visit.read",
        "visit.propose",
        "visit.reschedule",
        "visit.cancel",
        "visit.external_confirmation.record",
        "visit.start",
        "visit.complete",
      ]
    );

    for (const forbidden of [
      "visit.confirm",
      "visit.change_request",
    ]) {
      assert.equal(
        BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES.includes(
          forbidden
        ),
        false,
        forbidden
      );
    }
  }
);


test(
  "business customer Visit grants use evaluation_visit scope",
  () => {
    assert.match(
      business,
      /business_customer_job:insert_evaluation_visit_grant[\s\S]*'evaluation_visit'[\s\S]*'business_customer'/i
    );
  }
);


test(
  "professional reschedule stays proposed and therefore needs fresh customer confirmation",
  () => {
    const start =
      visit.indexOf(
        "async function rescheduleVisit("
      );

    const end =
      visit.indexOf(
        "async function cancelVisit(",
        start
      );

    const command =
      visit.slice(start, end);

    assert.match(
      command,
      /targetState:\s*"PROPOSED"/
    );

    assert.match(
      command,
      /eventType:\s*"VISIT_SCHEDULE_PROPOSED"/
    );

    assert.doesNotMatch(
      command,
      /targetState:\s*"SCHEDULED"/
    );
  }
);


test(
  "business customer never receives Meetro counterpart alerts",
  () => {
    const start =
      visit.indexOf(
        "async function projectVisitLifecycleAlertWithClient("
      );

    const end =
      visit.indexOf(
        "async function requireActorRole(",
        start
      );

    const alerts =
      visit.slice(start, end);

    assert.match(
      alerts,
      /"business_document"/
    );

    assert.match(
      alerts,
      /"business_customer"/
    );

    assert.match(
      alerts,
      /\.includes\(context\?\.source_type\)/
    );

    assert.match(
      alerts,
      /return null;/
    );
  }
);


test(
  "business customer authority still does not fabricate canonical customer actions",
  () => {
    assert.match(
      business,
      /visit\.external_confirmation\.record/
    );

    assert.match(
      business,
      /"visit\.start"/
    );

    assert.match(
      business,
      /"visit\.complete"/
    );

    assert.doesNotMatch(
      business,
      /CUSTOMER_REPRESENTATIVE/
    );

    assert.doesNotMatch(
      business,
      /INSERT INTO request_relationships/
    );
  }
);
