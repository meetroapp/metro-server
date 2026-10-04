"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  confirmDepositReceived,
  preWorkDepositServiceInternals,
  reverseDepositAllocation,
} = require("../server/finance/preWorkDepositService");

const source = readFileSync(
  join(__dirname, "..", "server", "finance", "preWorkDepositService.js"),
  "utf8"
);

test("accepted Quote terms derive exact percentage, fixed, none, and unverified rules", () => {
  assert.deepEqual(
    preWorkDepositServiceInternals.deriveDepositRequirement({
      customerTermsSnapshot: { paymentTerms: "75% deposit" },
      totalMinor: 68000,
    }),
    {
      kind: "REQUIRED",
      paymentTerms: "75% deposit",
      ruleType: "PERCENT",
      percentBasisPoints: 7500,
      fixedMinor: null,
      requiredMinor: 51000,
    }
  );
  assert.deepEqual(
    preWorkDepositServiceInternals.deriveDepositRequirement({
      customerTermsSnapshot: {
        paymentTerms: "Deposit due on approval — $510.00",
      },
      totalMinor: 68000,
    }),
    {
      kind: "REQUIRED",
      paymentTerms: "Deposit due on approval — $510.00",
      ruleType: "FIXED",
      percentBasisPoints: null,
      fixedMinor: 51000,
      requiredMinor: 51000,
    }
  );
  assert.equal(
    preWorkDepositServiceInternals.deriveDepositRequirement({
      customerTermsSnapshot: { paymentTerms: "Balance due on completion" },
      totalMinor: 68000,
    }).kind,
    "NOT_REQUIRED"
  );
  assert.equal(
    preWorkDepositServiceInternals.deriveDepositRequirement({
      customerTermsSnapshot: { paymentTerms: "Deposit due on approval" },
      totalMinor: 68000,
    }).kind,
    "UNVERIFIED"
  );
});

test("payment and reversal commands reject browser-owned financial authority before SQL", async () => {
  const pool = { query() { throw new Error("database must not be reached"); } };
  const base = {
    pool,
    authenticatedActor: { id: 24 },
    jobId: "072c8736-5d97-4253-ba3e-dd1bce281a20",
    idempotencyKey: "deposit-command-key",
  };
  assert.equal((await confirmDepositReceived({
    ...base,
    amountMinor: 20000,
    currency: "USD",
    normalizedMethod: "ZELLE",
    receivedAt: "2026-08-28T15:00:00.000Z",
    depositSatisfied: true,
  })).code, "PRE_WORK_DEPOSIT_FIELD_REJECTED");
  assert.equal((await reverseDepositAllocation({
    ...base,
    allocationId: "11111111-1111-4111-8111-111111111111",
    amountMinor: 1000,
    reasonCategory: "REFUND",
    reason: "Verified refund",
    expectedVersion: 3,
    appliedMinor: 50000,
  })).code, "PRE_WORK_DEPOSIT_FIELD_REJECTED");
});

test("manual methods are extensible but bounded and no instruction creates receipt authority", () => {
  assert.match(source, /evidence_source[\s\S]*'MANUAL_EXTERNAL'/i);
  assert.match(source, /NORMALIZED_METHOD_PATTERN = \/\^\[A-Z\]/);
  assert.doesNotMatch(source, /new Set\(\["CASH", "CHECK", "VENMO"/);
  assert.match(source, /customer_terms_snapshot/i);
  const receiptInsert = source.match(
    /INSERT INTO canonical_pre_work_payment_receipts[\s\S]*?\) VALUES[\s\S]*?\);/i
  )?.[0] || "";
  assert.doesNotMatch(receiptInsert, /paymentTerms/);
});

test("monetary commands use serializable transactions and append-only evidence", () => {
  assert.match(source, /runTransaction\(input\.pool, "SERIALIZABLE"/);
  for (const table of [
    "canonical_pre_work_payment_receipts",
    "canonical_pre_work_payment_allocations",
    "canonical_pre_work_payment_allocation_reversals",
    "canonical_pre_work_deposit_versions",
    "canonical_pre_work_deposit_events",
  ]) {
    assert.match(source, new RegExp(`INSERT INTO ${table}`));
  }
  assert.doesNotMatch(
    source,
    /UPDATE canonical_pre_work_(?:deposit_obligations|deposit_versions|payment_receipts|payment_allocations|payment_allocation_reversals|deposit_events)/i
  );
});

test("runtime does not write Invoice, Quote, Visit, Work, or customer-decision authority", () => {
  assert.doesNotMatch(
    source,
    /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:canonical_invoice|canonical_quote|canonical_visit|canonical_work|jobs|posts|request_relationships)/i
  );
});
