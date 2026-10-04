"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  REVENUE_PERIODS,
  buildRevenuePeriod,
  normalizeRevenuePeriod,
} = require("../server/finance/revenuePeriod");

test("Revenue accepts exactly the governed reporting periods", () => {
  assert.deepEqual(
    REVENUE_PERIODS,
    [
      "THIS_MONTH",
      "LAST_30_DAYS",
      "LAST_90_DAYS",
      "THIS_YEAR",
      "CUSTOM_RANGE",
    ]
  );

  for (const period of REVENUE_PERIODS) {
    assert.equal(
      normalizeRevenuePeriod(period),
      period
    );
  }

  assert.equal(
    normalizeRevenuePeriod(),
    "THIS_MONTH"
  );

  assert.equal(
    normalizeRevenuePeriod(""),
    "THIS_MONTH"
  );

  for (const invalid of [
    "TODAY",
    "THIS_WEEK",
    "30_DAYS",
    "YEAR",
    "ALL_TIME",
    "CUSTOM",
    "DATE",
  ]) {
    assert.equal(
      normalizeRevenuePeriod(invalid),
      null
    );
  }
});

test("THIS_MONTH uses Business-local month boundaries", () => {
  const result =
    buildRevenuePeriod({
      period: "THIS_MONTH",
      timeZone: "America/New_York",
      now: new Date(
        "2026-09-15T16:30:00.000Z"
      ),
    });

  assert.deepEqual(
    result,
    {
      period: "THIS_MONTH",
      timeZone: "America/New_York",
      localStartDate: "2026-09-01",
      localEndDateExclusive: "2026-10-01",
      startsAt: "2026-09-01T04:00:00.000Z",
      endsAt: "2026-10-01T04:00:00.000Z",
    }
  );
});

test("LAST_30_DAYS means today plus the previous 29 Business-local calendar days", () => {
  const result =
    buildRevenuePeriod({
      period: "LAST_30_DAYS",
      timeZone: "America/New_York",
      now: new Date(
        "2026-09-15T16:30:00.000Z"
      ),
    });

  assert.equal(
    result.localStartDate,
    "2026-08-17"
  );

  assert.equal(
    result.localEndDateExclusive,
    "2026-09-16"
  );

  assert.equal(
    result.startsAt,
    "2026-08-17T04:00:00.000Z"
  );

  assert.equal(
    result.endsAt,
    "2026-09-16T04:00:00.000Z"
  );
});

test("LAST_90_DAYS means today plus the previous 89 Business-local calendar days", () => {
  const result =
    buildRevenuePeriod({
      period: "LAST_90_DAYS",
      timeZone: "America/New_York",
      now: new Date(
        "2026-09-15T16:30:00.000Z"
      ),
    });

  assert.equal(
    result.localStartDate,
    "2026-06-18"
  );

  assert.equal(
    result.localEndDateExclusive,
    "2026-09-16"
  );
});

test("THIS_YEAR uses Business-local calendar-year boundaries", () => {
  const result =
    buildRevenuePeriod({
      period: "THIS_YEAR",
      timeZone: "America/New_York",
      now: new Date(
        "2026-09-15T16:30:00.000Z"
      ),
    });

  assert.deepEqual(
    result,
    {
      period: "THIS_YEAR",
      timeZone: "America/New_York",
      localStartDate: "2026-01-01",
      localEndDateExclusive: "2027-01-01",
      startsAt: "2026-01-01T05:00:00.000Z",
      endsAt: "2027-01-01T05:00:00.000Z",
    }
  );
});

test("Revenue calendar ranges remain DST-safe", () => {
  const result =
    buildRevenuePeriod({
      period: "LAST_30_DAYS",
      timeZone: "America/New_York",
      now: new Date(
        "2026-03-09T16:00:00.000Z"
      ),
    });

  assert.equal(
    result.localStartDate,
    "2026-02-08"
  );

  assert.equal(
    result.localEndDateExclusive,
    "2026-03-10"
  );

  assert.equal(
    result.startsAt,
    "2026-02-08T05:00:00.000Z"
  );

  assert.equal(
    result.endsAt,
    "2026-03-10T04:00:00.000Z"
  );

  const hours =
    (
      new Date(result.endsAt) -
      new Date(result.startsAt)
    ) / 3600000;

  assert.equal(
    hours,
    719
  );
});

test("Revenue period calculation fails closed without a valid Business timezone", () => {
  for (const timeZone of [
    null,
    "",
    "UTC",
    "Not/A_Timezone",
  ]) {
    assert.equal(
      buildRevenuePeriod({
        period: "THIS_MONTH",
        timeZone,
        now: new Date(
          "2026-09-15T16:30:00.000Z"
        ),
      }),
      null
    );
  }
});

test("Revenue period calculation rejects an invalid instant", () => {
  assert.equal(
    buildRevenuePeriod({
      period: "THIS_MONTH",
      timeZone: "America/New_York",
      now: "not-a-date",
    }),
    null
  );
});

test("CUSTOM_RANGE treats both supplied dates as inclusive Business-local dates", () => {
  const result = buildRevenuePeriod({
    period: "CUSTOM_RANGE",
    timeZone: "America/New_York",
    startDate: "2026-10-02",
    endDate: "2026-10-02",
    now: new Date("2026-10-02T12:00:00.000Z"),
  });

  assert.deepEqual(result, {
    period: "CUSTOM_RANGE",
    timeZone: "America/New_York",
    localStartDate: "2026-10-02",
    localEndDateExclusive: "2026-10-03",
    startsAt: "2026-10-02T04:00:00.000Z",
    endsAt: "2026-10-03T04:00:00.000Z",
  });
});

test("CUSTOM_RANGE accepts an inclusive multi-day interval", () => {
  const result = buildRevenuePeriod({
    period: "CUSTOM_RANGE",
    timeZone: "America/New_York",
    startDate: "2026-10-02",
    endDate: "2026-10-09",
    now: new Date("2026-10-09T12:00:00.000Z"),
  });

  assert.equal(result.localStartDate, "2026-10-02");
  assert.equal(result.localEndDateExclusive, "2026-10-10");
});

test("CUSTOM_RANGE remains DST-safe", () => {
  const result = buildRevenuePeriod({
    period: "CUSTOM_RANGE",
    timeZone: "America/New_York",
    startDate: "2026-03-08",
    endDate: "2026-03-09",
    now: new Date("2026-03-09T16:00:00.000Z"),
  });

  assert.equal(result.localStartDate, "2026-03-08");
  assert.equal(result.localEndDateExclusive, "2026-03-10");
  assert.equal(result.startsAt, "2026-03-08T05:00:00.000Z");
  assert.equal(result.endsAt, "2026-03-10T04:00:00.000Z");
});

test("CUSTOM_RANGE rejects missing malformed impossible and reversed dates", () => {
  const base = {
    period: "CUSTOM_RANGE",
    timeZone: "America/New_York",
    now: new Date("2026-10-02T12:00:00.000Z"),
  };

  for (const range of [
    {},
    { startDate: "2026-10-02" },
    { endDate: "2026-10-02" },
    {
      startDate: "2026-02-30",
      endDate: "2026-03-01",
    },
    {
      startDate: "10/02/2026",
      endDate: "2026-10-03",
    },
    {
      startDate: "2026-10-03",
      endDate: "2026-10-02",
    },
  ]) {
    assert.equal(
      buildRevenuePeriod({
        ...base,
        ...range,
      }),
      null
    );
  }
});

test("preset periods reject caller-supplied custom dates", () => {
  assert.equal(
    buildRevenuePeriod({
      period: "THIS_MONTH",
      timeZone: "America/New_York",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      now: new Date("2026-10-02T12:00:00.000Z"),
    }),
    null
  );
});
