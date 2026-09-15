"use strict";

const assert =
  require("node:assert/strict");

const test =
  require("node:test");

const {
  loadProfessionalRevenueProjection,
  revenueFinancialProjectionInternals,
} = require(
  "../server/finance/revenueFinancialProjectionService"
);

const NOW =
  new Date(
    "2026-09-15T16:30:00.000Z"
  );

function marker(sql) {
  const match =
    /\/\*\s*(revenue:[a-z_]+)\s*\*\//i
      .exec(sql);

  return match?.[1] || "";
}

function fakeClient(
  overrides = {}
) {
  const calls = [];

  const data = {
    "revenue:time_zone": [
      {
        time_zone:
          "America/New_York",
      },
    ],

    "revenue:pre_work_receipts": [
      {
        receipt_id: "deposit-510",
        gross_amount_minor: "51000",
        currency: "USD",
        received_at:
          "2026-08-29T14:00:00.000Z",
      },
    ],

    "revenue:pre_work_reversals": [],

    "revenue:invoice_payments": [
      {
        payment_id: "payment-170",
        amount_minor: "17000",
        currency: "USD",
        received_date: "2026-09-12",
      },
    ],

    "revenue:invoice_issuances": [
      {
        invoice_id: "invoice-680",
        total_minor: "68000",
        currency: "USD",
        issued_at:
          "2026-09-10T16:00:00.000Z",
      },
    ],

    "revenue:current_invoices": [
      {
        invoice_id: "invoice-680",
        status: "PAID",
        balance_minor: "0",
        currency: "USD",
      },
    ],

    "revenue:first_paid": [
      {
        invoice_id: "invoice-680",
        first_paid_version: 3,
        currency: "USD",
        issued_version: 2,
        issued_at:
          "2026-09-10T16:00:00.000Z",
        received_date: "2026-09-12",
      },
    ],

    ...overrides,
  };

  return {
    calls,

    async query(sql, params = []) {
      const key =
        marker(sql);

      calls.push({
        key,
        sql,
        params,
      });

      if (!key) {
        throw new Error(
          "Unexpected Revenue query."
        );
      }

      return {
        rows:
          structuredClone(
            data[key] || []
          ),
      };
    },
  };
}

test("authorized projection preserves the certified $510 + $170 = $680 cash lifecycle", async () => {
  const client =
    fakeClient();

  const truth =
    await loadProfessionalRevenueProjection({
      client,
      actorId: 65,
      period: "LAST_30_DAYS",
      now: NOW,
    });

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    truth.currency,
    "USD"
  );

  assert.equal(
    truth.cashReceivedMinor,
    68000
  );

  assert.equal(
    truth.invoicedMinor,
    68000
  );

  assert.equal(
    truth.outstandingMinor,
    0
  );

  assert.equal(
    truth.paidInvoices,
    1
  );

  assert.notEqual(
    truth.cashReceivedMinor,
    119000
  );

  assert.notEqual(
    truth.cashReceivedMinor,
    136000
  );
});

test("missing or ambiguous Business timezone fails Revenue closed before financial reads", async () => {
  for (const rows of [
    [],
    [{ time_zone: null }],
    [
      {
        contractor_profile_id: 7,
        time_zone:
          "America/New_York",
      },
      {
        contractor_profile_id: 8,
        time_zone:
          "America/New_York",
      },
    ],
    [
      {
        contractor_profile_id: 7,
        time_zone:
          "America/New_York",
      },
      {
        contractor_profile_id: 8,
        time_zone:
          "America/Chicago",
      },
    ],
  ]) {
    const client =
      fakeClient({
        "revenue:time_zone": rows,
      });

    const truth =
      await loadProfessionalRevenueProjection({
        client,
        actorId: 65,
        period: "THIS_MONTH",
        now: NOW,
      });

    assert.equal(
      truth.state,
      "TIME_ZONE_REQUIRED"
    );

    assert.equal(
      truth.cashReceivedMinor,
      null
    );

    assert.deepEqual(
      client.calls.map(
        (call) => call.key
      ),
      ["revenue:time_zone"]
    );
  }
});

test("projection sends timestamp and DATE boundaries from the Business-local period", async () => {
  const client =
    fakeClient();

  await loadProfessionalRevenueProjection({
    client,
    actorId: 65,
    period: "THIS_MONTH",
    now: NOW,
  });

  const receipt =
    client.calls.find(
      (call) =>
        call.key ===
        "revenue:pre_work_receipts"
    );

  assert.deepEqual(
    receipt.params,
    [
      65,
      "2026-09-01T04:00:00.000Z",
      "2026-10-01T04:00:00.000Z",
    ]
  );

  const payment =
    client.calls.find(
      (call) =>
        call.key ===
        "revenue:invoice_payments"
    );

  assert.deepEqual(
    payment.params,
    [
      65,
      "2026-09-01",
      "2026-10-01",
    ]
  );
});

test("unresolved canonical PAID history fails closed", async () => {
  const client =
    fakeClient({
      "revenue:first_paid": [
        {
          invoice_id: "invoice-680",
          first_paid_version: 4,
          currency: "USD",
          issued_version: 2,
          issued_at:
            "2026-09-10T16:00:00.000Z",
          received_date: null,
        },
      ],
    });

  const truth =
    await loadProfessionalRevenueProjection({
      client,
      actorId: 65,
      period: "THIS_MONTH",
      now: NOW,
    });

  assert.equal(
    truth.state,
    "UNSAFE_FINANCIAL_HISTORY"
  );

  assert.equal(
    truth.paidInvoices,
    null
  );
});

test("current PAID Invoice set must exactly reconcile to first PAID transitions", async () => {
  const missing =
    fakeClient({
      "revenue:first_paid": [],
    });

  const truth =
    await loadProfessionalRevenueProjection({
      client: missing,
      actorId: 65,
      period: "THIS_MONTH",
      now: NOW,
    });

  assert.equal(
    truth.state,
    "UNSAFE_FINANCIAL_HISTORY"
  );
});

test("Revenue projection never overlaps queries on one transaction client", async () => {
  const client =
    fakeClient();

  const originalQuery =
    client.query.bind(client);

  let active = 0;
  let maximumActive = 0;

  client.query = async (...args) => {
    active += 1;

    maximumActive =
      Math.max(
        maximumActive,
        active
      );

    try {
      await new Promise(
        (resolve) =>
          setImmediate(resolve)
      );

      return await originalQuery(
        ...args
      );
    } finally {
      active -= 1;
    }
  };

  const truth =
    await loadProfessionalRevenueProjection({
      client,
      actorId: 65,
      period: "LAST_30_DAYS",
      now: NOW,
    });

  assert.equal(
    truth.state,
    "READY"
  );

  assert.equal(
    maximumActive,
    1
  );
});

test("Revenue SQL preserves both Job authority families and never limits financial aggregates", () => {
  const {
    AUTHORIZED_JOBS_CTE,
    SQL,
  } =
    revenueFinancialProjectionInternals;

  assert.doesNotMatch(
    SQL.timeZone,
    /SELECT\s+DISTINCT\s+time_zone/i
  );

  assert.match(
    SQL.timeZone,
    /contractor_profile_id/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /ordinary_request_selection/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /business_document/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /relationships\.professional_user_id\s*=\s*\$1/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /profiles\.user_id\s*=\s*\$1/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /business_customer_relationships/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /job_customer_parties/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /contacts\.status='ACTIVE'/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /business_contact_roles/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /roles\.role='CUSTOMER'/
  );

  assert.match(
    AUTHORIZED_JOBS_CTE,
    /PRIMARY_PROFESSIONAL/
  );

  for (const [
    name,
    sql,
  ] of Object.entries(SQL)) {
    if (name === "timeZone") {
      continue;
    }

    // Revenue event/result sets must never be page-limited.
    assert.doesNotMatch(
      sql,
      /\bLIMIT\s+\$\d/i,
      name
    );

    const numericLimits = [
      ...sql.matchAll(
        /\bLIMIT\s+(\d+)/gi
      ),
    ].map((match) => Number(match[1]));

    if (name === "currentInvoices") {
      // This LIMIT 1 resolves the latest canonical version
      // for each Invoice; it does not limit Invoice rows.
      assert.deepEqual(
        numericLimits,
        [1],
        name
      );
    } else {
      assert.deepEqual(
        numericLimits,
        [],
        name
      );
    }
  }

  assert.match(
    SQL.invoiceIssuances,
    /versions\.version\s*=\s*issuances\.invoice_version/
  );

  assert.match(
    SQL.currentInvoices,
    /canonical_invoice_issuances/
  );

  assert.match(
    SQL.firstPaidTransitions,
    /ORDER BY versions\.invoice_id ASC,\s*versions\.version ASC/
  );
});
