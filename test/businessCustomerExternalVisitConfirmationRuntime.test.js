"use strict";

const assert = require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const {
  join,
} = require("node:path");
const test = require("node:test");

const source = readFileSync(
  join(
    __dirname,
    "..",
    "server",
    "workflow",
    "externalVisitConfirmationService.js"
  ),
  "utf8"
);

function region(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);

  assert.notEqual(
    a,
    -1,
    `missing ${start}`
  );

  assert.notEqual(
    b,
    -1,
    `missing ${end}`
  );

  return source.slice(a, b);
}

test(
  "Approved Work external Visit confirmation supports both business-owned Job origins",
  () => {
    const body = region(
      "const approvedWorkExternal =",
      "const businessCustomerEvaluation ="
    );

    assert.match(
      body,
      /"business_document"/
    );

    assert.match(
      body,
      /"business_customer"/
    );

    assert.match(
      body,
      /\.includes\([\s\S]*authorized\.context\.source_type/
    );

    assert.match(
      body,
      /current\.purpose[\s\S]*"APPROVED_WORK"/
    );

    assert.match(
      body,
      /current\.quote_approval_source[\s\S]*"EXTERNAL_EVIDENCE"/
    );

    assert.match(
      body,
      /current\.quote_approval_id/
    );
  }
);

test(
  "business_customer Evaluation Visit external confirmation remains separate from Approved Work",
  () => {
    const body = region(
      "const businessCustomerEvaluation =",
      "if (\n        !approvedWorkExternal"
    );

    assert.match(
      body,
      /authorized\.context\.source_type[\s\S]*"business_customer"/
    );

    assert.match(
      body,
      /current\.purpose[\s\S]*"EVALUATION"/
    );

    assert.match(
      body,
      /current\.quote_approval_id == null/
    );

    assert.match(
      body,
      /current\.quote_approval_source == null/
    );
  }
);

test(
  "Approved Work confirmation remains bound to exact Quote approval and external evidence ledger",
  () => {
    const body = region(
      "async function recordExternalVisitConfirmation",
      "module.exports="
    );

    assert.match(
      body,
      /quoteApprovalId !==[\s\S]*current\.quote_approval_id/
    );

    assert.match(
      body,
      /capability:[\s\S]*EXTERNAL_CONFIRMATION_CAPABILITY/
    );

    assert.match(
      body,
      /quoteApprovalId:[\s\S]*current\.quote_approval_id/
    );

    assert.match(
      body,
      /evaluateApprovedWorkDepositGateWithClient/
    );

    assert.match(
      body,
      /canonical_visit_external_confirmation_evidence/
    );

    assert.match(
      body,
      /canonical_evaluation_visit_external_confirmation_evidence/
    );

    assert.doesNotMatch(
      body,
      /CUSTOMER_REPRESENTATIVE/
    );
  }
);
