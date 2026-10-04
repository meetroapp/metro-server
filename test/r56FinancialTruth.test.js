"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const read = (...parts) =>
  readFileSync(join(__dirname, "..", ...parts), "utf8");

test("Job History excludes an approved Quote superseded by an approved revision through common approval authority", () => {
  const runtime = require("node:fs").readFileSync(
    require("node:path").join(
      __dirname,
      "..",
      "server",
      "workflow",
      "jobCompletionService.js"
    ),
    "utf8"
  );

  const start = runtime.indexOf(
    "const HISTORY_BASE_SQL = `"
  );

  const end = runtime.indexOf(
    "const BUSINESS_DOCUMENT_HISTORY_SQL = `",
    start
  );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const historySql =
    runtime.slice(start, end);

  assert.match(
    historySql,
    /canonical_quote_approvals approvals/
  );

  assert.match(
    historySql,
    /approvals\.decision[\s\S]*'APPROVED'/
  );

  assert.match(
    historySql,
    /approvals\.approval_source[\s\S]*'MEETRO_CUSTOMER'/
  );

  assert.match(
    historySql,
    /approvals\.issued_quote_version/
  );

  assert.match(
    historySql,
    /NOT EXISTS/
  );

  assert.match(
    historySql,
    /FROM canonical_quotes revision/
  );

  assert.match(
    historySql,
    /canonical_quote_approvals revised/
  );

  assert.match(
    historySql,
    /revised\.decision[\s\S]*'APPROVED'/
  );

  assert.match(
    historySql,
    /revised\.approval_source[\s\S]*'MEETRO_CUSTOMER'/
  );

  assert.match(
    historySql,
    /revision\.parent_quote_id[\s\S]*approvals\.quote_id/
  );

  assert.match(
    historySql,
    /revision\.lineage_type[\s\S]*'REVISED_QUOTE'/
  );

  assert.doesNotMatch(
    historySql,
    /canonical_quote_customer_decisions/
  );
});

test("Customer History keeps canonical Invoice payment date separate from timestamps", () => {
  const source = read(
    "server",
    "relationships",
    "businessCustomerRelationshipService.js"
  );

  const start = source.indexOf(
    "business_customer_relationship:activity_payments"
  );
  const end = source.indexOf(
    "business_customer_relationship:activity_visits",
    start
  );

  assert.ok(start >= 0);
  assert.ok(end > start);

  const paymentsSql = source.slice(start, end);

  assert.match(
    paymentsSql,
    /receipt\.received_date AS received_date/
  );
  assert.match(
    paymentsSql,
    /NULL::timestamptz AS received_at/
  );
  assert.doesNotMatch(
    paymentsSql,
    /receipt\.received_date::timestamptz AS received_at/
  );

  assert.match(
    source,
    /receivedDate:dateOnly\(row\.received_date\)/
  );
});
