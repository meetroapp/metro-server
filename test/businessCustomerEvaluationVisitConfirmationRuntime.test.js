"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const test =
  require("node:test");


const external = readFileSync(
  "server/workflow/externalVisitConfirmationService.js",
  "utf8"
);

const visit = readFileSync(
  "server/workflow/visitService.js",
  "utf8"
);

const business = readFileSync(
  "server/relationships/businessCustomerJobService.js",
  "utf8"
);

const evaluation = readFileSync(
  "server/authorization/evaluationService.js",
  "utf8"
);


test(
  "approved-work external confirmation remains Quote and deposit governed",
  () => {
    assert.match(
      external,
      /approvedWorkExternal[\s\S]*"business_document"[\s\S]*"business_customer"[\s\S]*authorized\.context\.source_type/
    );

    assert.match(
      external,
      /current\.purpose ===[\s\S]*"APPROVED_WORK"/
    );

    assert.match(
      external,
      /current\.quote_approval_source ===[\s\S]*"EXTERNAL_EVIDENCE"/
    );

    assert.match(
      external,
      /evaluateApprovedWorkDepositGateWithClient/
    );

    assert.match(
      external,
      /canonical_visit_external_confirmation_evidence/
    );
  }
);


test(
  "business customer Evaluation confirmation is a distinct source branch",
  () => {
    assert.match(
      external,
      /businessCustomerEvaluation/
    );

    assert.match(
      external,
      /source_type ===[\s\S]*"business_customer"/
    );

    assert.match(
      external,
      /current\.purpose ===[\s\S]*"EVALUATION"/
    );

    assert.match(
      external,
      /canonical_evaluation_visit_external_confirmation_evidence/
    );
  }
);


test(
  "business customer Evaluation confirmation has no Quote or deposit gate",
  () => {
    const start =
      external.indexOf(
        "const businessCustomerEvaluation"
      );

    const end =
      external.indexOf(
        "const participantId",
        start
      );

    const branch =
      external.slice(
        start,
        end
      );

    assert.match(
      branch,
      /quote_approval_id == null/
    );

    assert.match(
      branch,
      /quote_approval_source == null/
    );

    assert.doesNotMatch(
      branch,
      /evaluateApprovedWorkDepositGateWithClient/
    );
  }
);


test(
  "external Evaluation evidence remains Job and Visit scoped without evaluation id",
  () => {
    const start =
      external.indexOf(
        "INSERT INTO\n              canonical_evaluation_visit_external_confirmation_evidence"
      );

    assert.notEqual(
      start,
      -1
    );

    const end =
      external.indexOf(
        "RETURNING id",
        start
      );

    const insert =
      external.slice(
        start,
        end
      );

    assert.doesNotMatch(
      insert,
      /\bevaluation_id\b/i
    );

    assert.match(
      insert,
      /source_business_customer_job_id/
    );

    assert.match(
      insert,
      /proposed\.integrity_hash/
    );
  }
);


test(
  "Visit projection exposes Record Customer Confirmation for external Evaluation",
  () => {
    assert.match(
      visit,
      /row\.purpose === "EVALUATION"[\s\S]*context\?\.source_type ===[\s\S]*"business_customer"/
    );

    assert.match(
      visit,
      /canonical_evaluation_visit_external_confirmation_evidence/
    );
  }
);


test(
  "external professional receives evidence start and complete capabilities but no customer actions",
  () => {
    const start =
      business.indexOf(
        "const BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES"
      );

    const end =
      business.indexOf(
        "const UUID_PATTERN",
        start
      );

    const caps =
      business.slice(
        start,
        end
      );

    for (const required of [
      "visit.external_confirmation.record",
      "visit.start",
      "visit.complete",
    ]) {
      assert.match(
        caps,
        new RegExp(
          required.replace(
            ".",
            "\\."
          )
        )
      );
    }

    for (const forbidden of [
      "visit.confirm",
      "visit.change_request",
    ]) {
      assert.doesNotMatch(
        caps,
        new RegExp(
          forbidden.replace(
            ".",
            "\\."
          )
        )
      );
    }
  }
);


test(
  "009B-2 confirmation remains compatible with governed 009C physical Evaluation provenance",
  () => {
    assert.doesNotMatch(
      evaluation,
      /BUSINESS_CUSTOMER_EVALUATION_VISIT_UNAVAILABLE/
    );

    assert.doesNotMatch(
      evaluation,
      /BUSINESS_CUSTOMER_PHYSICAL_EVALUATION_UNAVAILABLE/
    );

    assert.match(
      evaluation,
      /loadEvaluationVisitForDraft/
    );

    assert.match(
      evaluation,
      /requireCompletedEvaluationVisitEvidence/
    );

    assert.match(
      evaluation,
      /COMPLETED_EVALUATION_VISIT_REQUIRED/
    );

    assert.match(
      visit,
      /linkDraftEvaluationOnVisitCompletion/
    );
  }
);
