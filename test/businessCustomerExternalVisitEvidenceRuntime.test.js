"use strict";

const assert = require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const test = require("node:test");

const source = readFileSync(
  "server/workflow/externalVisitConfirmationService.js",
  "utf8"
);

function body() {
  const start =
    source.indexOf(
      "if (\n        approvedWorkExternal\n      ) {"
    );

  const end =
    source.indexOf(
      "} else {",
      start
    );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return source.slice(
    start,
    end
  );
}

test(
  "Approved Work confirmation inherits exact source-aware identity from canonical external Quote approval evidence",
  () => {
    const text = body();

    assert.match(
      text,
      /canonical_quote_external_approval_evidence/
    );

    assert.match(
      text,
      /approvals\.external_approval_evidence_id/
    );

    assert.match(
      text,
      /approval_evidence\.customer_snapshot_hash/
    );

    assert.match(
      text,
      /approval_evidence\.business_contact_id/
    );

    assert.match(
      text,
      /approval_evidence\.business_customer_relationship_id/
    );
  }
);

test(
  "Visit evidence insert persists mutually exclusive external customer identity columns",
  () => {
    const text = body();

    assert.match(
      text,
      /customer_snapshot_hash,[\s\S]*business_contact_id,[\s\S]*business_customer_relationship_id/
    );

    assert.doesNotMatch(
      text,
      /JOIN canonical_quote_customer_snapshots snapshots/
    );
  }
);

test(
  "Approved Work confirmation remains exact approval and fail-closed evidence creation",
  () => {
    const text = body();

    assert.match(
      text,
      /approvals\.id[\s\S]*\$10/
    );

    assert.match(
      text,
      /approvals\.decision[\s\S]*'APPROVED'/
    );

    assert.match(
      text,
      /approvals\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/
    );

    assert.match(
      text,
      /RETURNING id/
    );

    assert.match(
      text,
      /!evidence\.rows\[0\]/
    );
  }
);
