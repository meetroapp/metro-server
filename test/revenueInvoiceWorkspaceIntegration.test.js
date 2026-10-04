"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const {
  join,
} = require("node:path");

const test =
  require("node:test");

const {
  getProfessionalInvoiceWorkspace,
} = require(
  "../server/finance/invoicePaymentService"
);

test("unsupported Revenue period is rejected before any transaction or database read", async () => {
  let queried = false;

  const pool = {
    async query() {
      queried = true;

      throw new Error(
        "Database must not be called for invalid Revenue period."
      );
    },
  };

  const result =
    await getProfessionalInvoiceWorkspace({
      pool,

      authenticatedActor: {
        id: 65,
      },

      limit: 20,

      period: "ALL_TIME",
    });

  assert.equal(
    queried,
    false
  );

  assert.equal(
    result.ok,
    false
  );

  assert.equal(
    result.status,
    400
  );

  assert.equal(
    result.code,
    "INVALID_REVENUE_PERIOD"
  );
});

test("workspace preserves the legacy exact response when period is omitted and adds Revenue only when explicitly requested", () => {
  const source =
    readFileSync(
      join(
        __dirname,
        "..",
        "server",
        "finance",
        "invoicePaymentService.js"
      ),
      "utf8"
    );

  const start =
    source.indexOf(
      "async function getProfessionalInvoiceWorkspace"
    );

  const end =
    source.indexOf(
      "\nmodule.exports",
      start
    );

  assert.ok(
    start >= 0 &&
    end > start
  );

  const workspace =
    source.slice(
      start,
      end
    );

  assert.match(
    workspace,
    /validateInput\(input,\s*\[\s*"limit",\s*"period",\s*"startDate",\s*"endDate",?\s*\]\)/
  );

  assert.match(
    workspace,
    /const revenueRequested\s*=\s*input\.period != null[\s\S]*String\(input\.period\)\.trim\(\) !== ""/
  );

  assert.match(
    workspace,
    /const period\s*=\s*revenueRequested[\s\S]*normalizeRevenuePeriod\(input\.period\)[\s\S]*:\s*null/
  );

  assert.match(
    workspace,
    /if \(revenueRequested && !period\)/
  );

  assert.match(
    workspace,
    /REPEATABLE READ READ ONLY/
  );

  assert.match(
    workspace,
    /if \(revenueRequested\)[\s\S]*loadProfessionalRevenueProjection\(\{[\s\S]*actorId:\s*validated\.actorId,[\s\S]*period,[\s\S]*startDate,[\s\S]*endDate,[\s\S]*now,[\s\S]*\}\)/
  );

  assert.match(
    workspace,
    /\.\.\.\(revenueRequested\s*\?\s*\{\s*revenue\s*\}\s*:\s*\{\}\)/
  );

  assert.match(
    workspace,
    /summary:\s*\{/
  );

  assert.match(
    workspace,
    /readyJobs,/
  );

  assert.match(
    workspace,
    /invoices:\s*rows/
  );

  assert.match(
    workspace,
    /limit,/
  );
});

test("Revenue projection stays independent of Invoice workspace display limit", () => {
  const source =
    readFileSync(
      join(
        __dirname,
        "..",
        "server",
        "finance",
        "invoicePaymentService.js"
      ),
      "utf8"
    );

  const start =
    source.indexOf(
      "async function getProfessionalInvoiceWorkspace"
    );

  const end =
    source.indexOf(
      "\nmodule.exports",
      start
    );

  const workspace =
    source.slice(
      start,
      end
    );

  const revenueCall =
    workspace.indexOf(
      "loadProfessionalRevenueProjection"
    );

  const readyDisplayLimit =
    workspace.indexOf(
      "LIMIT $2"
    );

  assert.ok(
    revenueCall >= 0
  );

  assert.ok(
    readyDisplayLimit > revenueCall
  );

  assert.match(
    workspace,
    /loadProfessionalRevenueProjection\(\{\s*client,\s*actorId:\s*validated\.actorId,\s*period,\s*startDate,\s*endDate,\s*now,\s*\}\)/
  );

  const revenueCallEnd =
    workspace.indexOf(
      "    });",
      revenueCall
    );

  assert.ok(
    revenueCallEnd > revenueCall
  );

  const revenueInvocation =
    workspace.slice(
      revenueCall,
      revenueCallEnd + 7
    );

  assert.match(
    revenueInvocation,
    /loadProfessionalRevenueProjection\(\{\s*client,\s*actorId:\s*validated\.actorId,\s*period,\s*startDate,\s*endDate,\s*now,\s*\}\)/
  );

  assert.doesNotMatch(
    revenueInvocation,
    /\blimit\b/i
  );
});

test("Invoice workspace rejects invalid Revenue custom dates before opening a transaction", async () => {
  for (const range of [
    {
      startDate: "2026-10-02",
    },
    {
      endDate: "2026-10-02",
    },
    {
      startDate: "2026-10-10",
      endDate: "2026-10-02",
    },
    {
      startDate: "2026-02-30",
      endDate: "2026-03-01",
    },
    {
      startDate: "10/02/2026",
      endDate: "2026-10-03",
    },
  ]) {
    let touchedDatabase = false;

    const pool = {
      async connect() {
        touchedDatabase = true;
        throw new Error(
          "Database must not be reached for invalid CUSTOM_RANGE."
        );
      },

      async query() {
        touchedDatabase = true;
        throw new Error(
          "Database must not be reached for invalid CUSTOM_RANGE."
        );
      },
    };

    const result =
      await getProfessionalInvoiceWorkspace({
        pool,

        authenticatedActor: {
          id: 65,
        },

        limit: 20,
        period: "CUSTOM_RANGE",
        ...range,
      });

    assert.equal(
      touchedDatabase,
      false
    );

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      result.status,
      400
    );

    assert.equal(
      result.code,
      "INVALID_REVENUE_RANGE"
    );
  }
});

test("Invoice workspace rejects custom dates attached to preset Revenue periods before opening a transaction", async () => {
  let touchedDatabase = false;

  const pool = {
    async connect() {
      touchedDatabase = true;
      throw new Error(
        "Database must not be reached for preset Revenue dates."
      );
    },

    async query() {
      touchedDatabase = true;
      throw new Error(
        "Database must not be reached for preset Revenue dates."
      );
    },
  };

  const result =
    await getProfessionalInvoiceWorkspace({
      pool,

      authenticatedActor: {
        id: 65,
      },

      limit: 20,
      period: "THIS_MONTH",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
    });

  assert.equal(
    touchedDatabase,
    false
  );

  assert.equal(
    result.ok,
    false
  );

  assert.equal(
    result.status,
    400
  );

  assert.equal(
    result.code,
    "INVALID_REVENUE_RANGE"
  );
});

test("Invoice workspace rejects custom dates when Revenue period is omitted", async () => {
  let touchedDatabase = false;

  const pool = {
    async connect() {
      touchedDatabase = true;
      throw new Error(
        "Database must not be reached for unowned Revenue dates."
      );
    },

    async query() {
      touchedDatabase = true;
      throw new Error(
        "Database must not be reached for unowned Revenue dates."
      );
    },
  };

  const result =
    await getProfessionalInvoiceWorkspace({
      pool,

      authenticatedActor: {
        id: 65,
      },

      limit: 20,
      startDate: "2026-10-02",
      endDate: "2026-10-02",
    });

  assert.equal(
    touchedDatabase,
    false
  );

  assert.equal(
    result.ok,
    false
  );

  assert.equal(
    result.code,
    "INVALID_REVENUE_RANGE"
  );
});
