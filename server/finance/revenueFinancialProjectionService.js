"use strict";

const {
  BUSINESS_JOB_CONTEXT_SQL,
} = require("../relationships/businessJobAuthority");

const {
  normalizeTimeZone,
} = require("../team/businessTimeSettingsService");

const {
  buildRevenuePeriod,
  normalizeRevenuePeriod,
} = require("./revenuePeriod");

const {
  buildRevenueFinancialTruth,
} = require("./revenueFinancialTruth");

const AUTHORIZED_JOBS_CTE = `
WITH authorized_jobs AS (
  SELECT jobs.id AS job_id
  FROM jobs
  INNER JOIN request_relationships relationships
    ON relationships.id = jobs.source_request_relationship_id
   AND relationships.professional_user_id = $1
  INNER JOIN relationship_participants professional
    ON professional.job_id = jobs.id
   AND professional.request_relationship_id = relationships.id
   AND professional.user_id = $1
  WHERE jobs.source_type = 'ordinary_request_selection'
    AND jobs.lifecycle_contract_version = 2
    AND relationships.status IN ('active', 'closed')
    AND EXISTS (
      SELECT 1
      FROM participant_role_assignments roles
      LEFT JOIN participant_role_revocations revocations
        ON revocations.role_assignment_id = roles.id
      WHERE roles.participant_id = professional.id
        AND roles.job_id = jobs.id
        AND roles.role = 'PRIMARY_PROFESSIONAL'
        AND roles.valid_from <= CURRENT_TIMESTAMP
        AND (
          roles.valid_until IS NULL
          OR roles.valid_until > CURRENT_TIMESTAMP
        )
        AND revocations.id IS NULL
    )

  UNION

  SELECT business.job_id
  FROM (
    ${BUSINESS_JOB_CONTEXT_SQL}
      AND profiles.user_id = $1
  ) business
)
`;

const SQL = Object.freeze({
  timeZone: `
    /* revenue:time_zone */
    SELECT
      id AS contractor_profile_id,
      time_zone
    FROM contractor_profiles
    WHERE user_id = $1
    ORDER BY id ASC
  `,

  preWorkReceipts: `
    /* revenue:pre_work_receipts */
    ${AUTHORIZED_JOBS_CTE}
    SELECT
      receipts.id AS receipt_id,
      receipts.gross_amount_minor,
      receipts.currency,
      receipts.received_at
    FROM canonical_pre_work_payment_receipts receipts
    INNER JOIN authorized_jobs
      ON authorized_jobs.job_id = receipts.job_id
    WHERE receipts.received_at >= $2::timestamptz
      AND receipts.received_at < $3::timestamptz
    ORDER BY receipts.received_at ASC, receipts.id ASC
  `,

  preWorkReversals: `
    /* revenue:pre_work_reversals */
    ${AUTHORIZED_JOBS_CTE}
    SELECT
      reversals.id AS reversal_id,
      reversals.reversed_minor,
      reversals.currency,
      reversals.reversal_effect,
      reversals.reversed_at
    FROM canonical_pre_work_payment_allocation_reversals reversals
    INNER JOIN authorized_jobs
      ON authorized_jobs.job_id = reversals.job_id
    WHERE reversals.reversed_at >= $2::timestamptz
      AND reversals.reversed_at < $3::timestamptz
    ORDER BY reversals.reversed_at ASC, reversals.id ASC
  `,

  invoicePayments: `
    /* revenue:invoice_payments */
    ${AUTHORIZED_JOBS_CTE}
    SELECT
      payments.id AS payment_id,
      payments.amount_minor,
      payments.currency,
      payments.received_date
    FROM canonical_invoice_payments payments
    INNER JOIN authorized_jobs
      ON authorized_jobs.job_id = payments.job_id
    WHERE payments.received_date >= $2::date
      AND payments.received_date < $3::date
    ORDER BY payments.received_date ASC, payments.id ASC
  `,

  invoiceIssuances: `
    /* revenue:invoice_issuances */
    ${AUTHORIZED_JOBS_CTE}
    SELECT
      issuances.invoice_id,
      versions.total_minor,
      versions.currency,
      issuances.issued_at
    FROM canonical_invoice_issuances issuances
    INNER JOIN authorized_jobs
      ON authorized_jobs.job_id = issuances.job_id
    INNER JOIN canonical_invoice_versions versions
      ON versions.invoice_id = issuances.invoice_id
     AND versions.version = issuances.invoice_version
     AND versions.job_id = issuances.job_id
    WHERE issuances.issued_at >= $2::timestamptz
      AND issuances.issued_at < $3::timestamptz
    ORDER BY issuances.issued_at ASC, issuances.invoice_id ASC
  `,

  currentInvoices: `
    /* revenue:current_invoices */
    ${AUTHORIZED_JOBS_CTE}
    SELECT
      invoices.id AS invoice_id,
      current.status,
      current.balance_minor,
      current.currency
    FROM canonical_invoices invoices
    INNER JOIN authorized_jobs
      ON authorized_jobs.job_id = invoices.job_id
    INNER JOIN canonical_invoice_issuances issuances
      ON issuances.invoice_id = invoices.id
     AND issuances.job_id = invoices.job_id
    INNER JOIN LATERAL (
      SELECT
        versions.status,
        versions.balance_minor,
        versions.currency
      FROM canonical_invoice_versions versions
      WHERE versions.invoice_id = invoices.id
        AND versions.job_id = invoices.job_id
      ORDER BY versions.version DESC
      LIMIT 1
    ) current ON TRUE
    ORDER BY invoices.id ASC
  `,

  firstPaidTransitions: `
    /* revenue:first_paid */
    ${AUTHORIZED_JOBS_CTE},
    first_paid AS (
      SELECT DISTINCT ON (versions.invoice_id)
        versions.invoice_id,
        versions.job_id,
        versions.version AS first_paid_version,
        versions.currency
      FROM canonical_invoice_versions versions
      INNER JOIN authorized_jobs
        ON authorized_jobs.job_id = versions.job_id
      INNER JOIN canonical_invoice_issuances issued
        ON issued.invoice_id = versions.invoice_id
       AND issued.job_id = versions.job_id
      WHERE versions.status = 'PAID'
      ORDER BY versions.invoice_id ASC, versions.version ASC
    )
    SELECT
      first_paid.invoice_id,
      first_paid.first_paid_version,
      first_paid.currency,
      issuances.invoice_version AS issued_version,
      issuances.issued_at,
      payments.received_date
    FROM first_paid
    INNER JOIN canonical_invoice_issuances issuances
      ON issuances.invoice_id = first_paid.invoice_id
     AND issuances.job_id = first_paid.job_id
    LEFT JOIN canonical_invoice_payments payments
      ON payments.invoice_id = first_paid.invoice_id
     AND payments.job_id = first_paid.job_id
     AND payments.invoice_version = first_paid.first_paid_version
    ORDER BY first_paid.invoice_id ASC
  `,
});

function positiveInteger(value) {
  const number = Number(value);

  return Number.isSafeInteger(number) &&
    number > 0
    ? number
    : null;
}

function iso(value) {
  if (!value) return null;

  const parsed =
    value instanceof Date
      ? value
      : new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString();
}

function sqlDate(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const normalized =
    String(value || "").slice(0, 10);

  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : null;
}

function unavailableRevenue(
  state,
  period,
  {
    timeZone = null,
    localStartDate = null,
    localEndDateExclusive = null,
  } = {}
) {
  return Object.freeze({
    state,
    period,
    timeZone,
    localStartDate,
    localEndDateExclusive,
    currency: null,
    cashReceivedMinor: null,
    invoicedMinor: null,
    outstandingMinor: null,
    paidInvoices: null,
  });
}

function actorTimeZone(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return null;
  }

  return normalizeTimeZone(
    rows[0]?.time_zone
  );
}

function mapFirstPaidTransition(row) {
  const firstPaidVersion =
    positiveInteger(row?.first_paid_version);

  const issuedVersion =
    positiveInteger(row?.issued_version);

  const base = {
    invoiceId:
      String(row?.invoice_id || "").trim(),
    currency:
      String(row?.currency || "").trim(),
  };

  if (
    firstPaidVersion &&
    issuedVersion &&
    firstPaidVersion === issuedVersion
  ) {
    return {
      ...base,
      source: "ISSUANCE",
      occurredAt: iso(row?.issued_at),
    };
  }

  const receivedDate =
    sqlDate(row?.received_date);

  if (
    firstPaidVersion &&
    issuedVersion &&
    firstPaidVersion > issuedVersion &&
    receivedDate
  ) {
    return {
      ...base,
      source: "PAYMENT",
      receivedDate,
    };
  }

  return {
    ...base,
    source: "UNRESOLVED",
  };
}

function samePaidInvoiceSet(
  currentInvoices,
  firstPaidTransitions
) {
  const currentPaid =
    currentInvoices
      .filter(
        (invoice) =>
          invoice.status === "PAID"
      )
      .map((invoice) => invoice.invoiceId)
      .sort();

  const transitions =
    firstPaidTransitions
      .map(
        (transition) =>
          transition.invoiceId
      )
      .sort();

  return (
    currentPaid.length === transitions.length &&
    currentPaid.every(
      (invoiceId, index) =>
        invoiceId === transitions[index]
    )
  );
}

async function loadProfessionalRevenueProjection({
  client,
  actorId,
  period = "THIS_MONTH",
  now = new Date(),
} = {}) {
  if (
    !client ||
    typeof client.query !== "function"
  ) {
    throw new TypeError(
      "A database client is required."
    );
  }

  const exactActorId =
    positiveInteger(actorId);

  if (!exactActorId) {
    throw new TypeError(
      "A valid actor is required."
    );
  }

  const normalizedPeriod =
    normalizeRevenuePeriod(period);

  if (!normalizedPeriod) {
    throw new TypeError(
      "Unsupported Revenue period."
    );
  }

  const timeZoneResult =
    await client.query(
      SQL.timeZone,
      [exactActorId]
    );

  const timeZone =
    actorTimeZone(
      timeZoneResult.rows
    );

  if (!timeZone) {
    return unavailableRevenue(
      "TIME_ZONE_REQUIRED",
      normalizedPeriod
    );
  }

  const range =
    buildRevenuePeriod({
      period: normalizedPeriod,
      timeZone,
      now,
    });

  if (!range) {
    return unavailableRevenue(
      "TIME_ZONE_REQUIRED",
      normalizedPeriod
    );
  }

  const timestampParams = [
    exactActorId,
    range.startsAt,
    range.endsAt,
  ];

  const dateParams = [
    exactActorId,
    range.localStartDate,
    range.localEndDateExclusive,
  ];

  const receiptResult =
    await client.query(
      SQL.preWorkReceipts,
      timestampParams
    );

  const reversalResult =
    await client.query(
      SQL.preWorkReversals,
      timestampParams
    );

  const paymentResult =
    await client.query(
      SQL.invoicePayments,
      dateParams
    );

  const issuanceResult =
    await client.query(
      SQL.invoiceIssuances,
      timestampParams
    );

  const currentInvoiceResult =
    await client.query(
      SQL.currentInvoices,
      [exactActorId]
    );

  const firstPaidResult =
    await client.query(
      SQL.firstPaidTransitions,
      [exactActorId]
    );

  const preWorkReceipts =
    receiptResult.rows.map((row) => ({
      receiptId: row.receipt_id,
      grossAmountMinor:
        Number(row.gross_amount_minor),
      currency: row.currency,
      receivedAt: iso(row.received_at),
    }));

  const preWorkReversals =
    reversalResult.rows.map((row) => ({
      reversalId: row.reversal_id,
      reversedMinor:
        Number(row.reversed_minor),
      currency: row.currency,
      reversalEffect:
        row.reversal_effect,
      reversedAt: iso(row.reversed_at),
    }));

  const invoicePayments =
    paymentResult.rows.map((row) => ({
      paymentId: row.payment_id,
      amountMinor:
        Number(row.amount_minor),
      currency: row.currency,
      receivedDate:
        sqlDate(row.received_date),
    }));

  const invoiceIssuances =
    issuanceResult.rows.map((row) => ({
      invoiceId: row.invoice_id,
      totalMinor:
        Number(row.total_minor),
      currency: row.currency,
      issuedAt: iso(row.issued_at),
    }));

  const currentInvoices =
    currentInvoiceResult.rows.map(
      (row) => ({
        invoiceId: row.invoice_id,
        status: row.status,
        balanceMinor:
          Number(row.balance_minor),
        currency: row.currency,
      })
    );

  const firstPaidTransitions =
    firstPaidResult.rows.map(
      mapFirstPaidTransition
    );

  if (
    !samePaidInvoiceSet(
      currentInvoices,
      firstPaidTransitions
    )
  ) {
    return unavailableRevenue(
      "UNSAFE_FINANCIAL_HISTORY",
      range.period,
      range
    );
  }

  return buildRevenueFinancialTruth({
    range,
    preWorkReceipts,
    preWorkReversals,
    invoicePayments,
    invoiceIssuances,
    currentInvoices,
    firstPaidTransitions,
  });
}

module.exports = {
  loadProfessionalRevenueProjection,

  revenueFinancialProjectionInternals:
    Object.freeze({
      AUTHORIZED_JOBS_CTE,
      SQL,
      actorTimeZone,
      mapFirstPaidTransition,
      samePaidInvoiceSet,
      sqlDate,
      unavailableRevenue,
    }),
};
