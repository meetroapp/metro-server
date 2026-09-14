"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const read = (...parts) =>
  readFileSync(join(__dirname, "..", ...parts), "utf8");

test("Job History excludes an approved Quote superseded by an approved revision", () => {
  const source = read("server", "workflow", "jobCompletionService.js");

  const start = source.indexOf("const HISTORY_BASE_SQL");
  const end = source.indexOf(
    "async function listProfessionalJobHistory",
    start
  );

  assert.ok(start >= 0);
  assert.ok(end > start);

  const historySql = source.slice(start, end);

  assert.match(
    historySql,
    /canonical_quote_customer_decisions revised_decisions/
  );
  assert.match(
    historySql,
    /revised_decisions\.decision = 'APPROVED'/
  );
  assert.match(
    historySql,
    /revision\.parent_quote_id = quotes\.id/
  );
  assert.match(
    historySql,
    /revision\.lineage_type = 'REVISED_QUOTE'/
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
