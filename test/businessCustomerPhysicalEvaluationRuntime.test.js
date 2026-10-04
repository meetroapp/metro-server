"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const test =
  require("node:test");


const evaluation = readFileSync(
  "server/authorization/evaluationService.js",
  "utf8"
);

const visit = readFileSync(
  "server/workflow/visitService.js",
  "utf8"
);


test(
  "business customer Evaluation can still be created and prepared before any Visit",
  () => {
    assert.doesNotMatch(
      evaluation,
      /BUSINESS_CUSTOMER_EVALUATION_VISIT_UNAVAILABLE/
    );

    assert.match(
      evaluation,
      /validated\.visitId[\s\S]*\?[\s\S]*loadEvaluationVisitForDraft[\s\S]*:[\s\S]*null/
    );
  }
);


test(
  "late physical Evaluation documentation accepts started or completed Evaluation Visit",
  () => {
    const start =
      evaluation.indexOf(
        "async function loadEvaluationVisitForDraft("
      );

    const end =
      evaluation.indexOf(
        "async function reserveVisitEvaluationLinkCommand(",
        start
      );

    const loader =
      evaluation.slice(
        start,
        end
      );

    assert.match(
      loader,
      /visits\.purpose = 'EVALUATION'/
    );

    assert.match(
      loader,
      /versions\.state = 'STARTED'/
    );

    assert.match(
      loader,
      /versions\.state = 'COMPLETED'/
    );

    assert.match(
      loader,
      /links\.visit_id IS NULL/
    );
  }
);


test(
  "pre-created draft remains independently available and Visit completion may auto-link it",
  () => {
    assert.match(
      visit,
      /async function linkDraftEvaluationOnVisitCompletion/
    );

    assert.match(
      visit,
      /if \(!evaluationId\)[\s\S]*linked: false/
    );

    assert.match(
      visit,
      /canonical_visit_evaluation_links/
    );
  }
);


test(
  "Visit completion never auto-completes Evaluation",
  () => {
    const start =
      visit.indexOf(
        "async function linkDraftEvaluationOnVisitCompletion("
      );

    const end =
      visit.indexOf(
        "async function runVersionCommand(",
        start
      );

    const link =
      visit.slice(
        start,
        end
      );

    assert.doesNotMatch(
      link,
      /UPDATE\s+canonical_evaluations/i
    );

    assert.doesNotMatch(
      link,
      /evaluation\.complete/
    );
  }
);


test(
  "business customer physical completion uses same completed Visit evidence gate",
  () => {
    assert.doesNotMatch(
      evaluation,
      /BUSINESS_CUSTOMER_PHYSICAL_EVALUATION_UNAVAILABLE/
    );

    assert.match(
      evaluation,
      /requireCompletedEvaluationVisitEvidence/
    );

    assert.match(
      evaluation,
      /COMPLETED_EVALUATION_VISIT_REQUIRED/
    );
  }
);


test(
  "physical and remote Evaluation provenance remain mutually exclusive",
  () => {
    assert.match(
      evaluation,
      /PHYSICAL_EVALUATION_REMOTE_PROVENANCE_CONFLICT/
    );

    assert.match(
      evaluation,
      /REMOTE_EVALUATION_PHYSICAL_PROVENANCE_CONFLICT/
    );

    assert.match(
      evaluation,
      /canonical_evaluation_remote_provenance/
    );
  }
);


test(
  "009C does not add Quote authority",
  () => {
    assert.doesNotMatch(
      evaluation,
      /INSERT INTO\s+canonical_quotes/i
    );

    assert.doesNotMatch(
      evaluation,
      /quote\.issue/
    );
  }
);
