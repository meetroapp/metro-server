"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const {
  createPaymentReminderHandlers,
  registerPaymentReminderRoutes,
} = require(
  "../server/finance/paymentReminders"
);

function response() {
  return {
    headers: {},
    statusCode: 0,
    body: null,

    setHeader(name, value) {
      this.headers[name] = value;
    },

    status(value) {
      this.statusCode = value;
      return this;
    },

    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("Payment Reminder routes are authenticated and source scoped", () => {
  const routes = [];

  const app = {
    post(path, auth, handler) {
      routes.push([
        "POST",
        path,
        auth,
        handler,
      ]);
    },
  };

  const auth = () => {};

  registerPaymentReminderRoutes({
    app,
    authMiddleware: auth,
    getPool() {},
    sendPublicDatabaseError() {},
  });

  assert.deepEqual(
    routes.map(
      ([method, path]) =>
        `${method} ${path}`
    ),
    [
      "POST /professional/invoices/:invoiceId/reminders",
      "POST /jobs/:jobId/pre-work-deposit/reminders",
    ]
  );

  assert.equal(
    routes.every(
      (route) =>
        route[2] === auth
    ),
    true
  );
});

test("Invoice Reminder route forwards only bounded command fields", async () => {
  let input;

  const handlers =
    createPaymentReminderHandlers({
      getPool:
        () => "pool",

      sendPublicDatabaseError() {},

      paymentReminderService: {
        async sendInvoicePaymentReminder(
          value
        ) {
          input = value;

          return {
            ok: true,
            status: 201,
            code:
              "PAYMENT_REMINDER_SENT",
            reminder: {
              reminderId: "r1",
            },
          };
        },
      },
    });

  const res =
    response();

  await handlers.sendInvoiceReminder(
    {
      user: {
        id: 65,
      },

      params: {
        invoiceId:
          "invoice-path",
      },

      headers: {
        "idempotency-key":
          "reminder-1",
      },

      body: {
        expectedVersion: 3,
        messageText:
          "Friendly reminder.",
        amountMinor: 999999,
        classification:
          "OVERDUE",
        paidMinor: 0,
      },
    },
    res
  );

  assert.deepEqual(
    input,
    {
      pool: "pool",
      authenticatedActor: {
        id: 65,
      },
      invoiceId:
        "invoice-path",
      expectedVersion: 3,
      messageText:
        "Friendly reminder.",
      idempotencyKey:
        "reminder-1",
    }
  );

  assert.equal(
    res.headers[
      "Cache-Control"
    ],
    "private, no-store"
  );

  assert.equal(
    res.body.code,
    "PAYMENT_REMINDER_SENT"
  );
});

test("Deposit Reminder route forwards no payment or scheduling authority", async () => {
  let input;

  const handlers =
    createPaymentReminderHandlers({
      getPool:
        () => "pool",

      sendPublicDatabaseError() {},

      paymentReminderService: {
        async sendDepositPaymentReminder(
          value
        ) {
          input = value;

          return {
            ok: true,
            status: 201,
            code:
              "PAYMENT_REMINDER_SENT",
            reminder: {
              reminderId: "r2",
            },
          };
        },
      },
    });

  const res =
    response();

  await handlers.sendDepositReminder(
    {
      user: {
        id: 65,
      },

      params: {
        jobId:
          "job-path",
      },

      headers: {
        "idempotency-key":
          "reminder-2",
      },

      body: {
        expectedVersion: 2,
        messageText:
          "Deposit reminder.",
        amountMinor: 31000,
        schedulingLocked: false,
        paymentReceived: true,
      },
    },
    res
  );

  assert.deepEqual(
    input,
    {
      pool: "pool",
      authenticatedActor: {
        id: 65,
      },
      jobId:
        "job-path",
      expectedVersion: 2,
      messageText:
        "Deposit reminder.",
      idempotencyKey:
        "reminder-2",
    }
  );
});
