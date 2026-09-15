"use strict";

const {
  normalizeTimeZone,
} = require("../team/businessTimeSettingsService");

const {
  addLocalDays,
  localDateKey,
  localMidnightUtc,
} = require("../team/timeOperationsService");

const REVENUE_PERIODS = Object.freeze([
  "THIS_MONTH",
  "LAST_30_DAYS",
  "LAST_90_DAYS",
  "THIS_YEAR",
]);

function normalizeRevenuePeriod(value) {
  if (value == null || value === "") {
    return "THIS_MONTH";
  }

  const normalized =
    String(value).trim().toUpperCase();

  return REVENUE_PERIODS.includes(normalized)
    ? normalized
    : null;
}

function firstDayOfMonth(dateKey) {
  return `${dateKey.slice(0, 7)}-01`;
}

function firstDayOfNextMonth(dateKey) {
  const [year, month] =
    dateKey.split("-").map(Number);

  const next =
    month === 12
      ? { year: year + 1, month: 1 }
      : { year, month: month + 1 };

  return `${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}-01`;
}

function firstDayOfYear(dateKey) {
  return `${dateKey.slice(0, 4)}-01-01`;
}

function firstDayOfNextYear(dateKey) {
  const year =
    Number(dateKey.slice(0, 4));

  return `${String(year + 1).padStart(4, "0")}-01-01`;
}

function buildRevenuePeriod({
  period = "THIS_MONTH",
  timeZone,
  now = new Date(),
} = {}) {
  const normalizedPeriod =
    normalizeRevenuePeriod(period);

  if (!normalizedPeriod) {
    return null;
  }

  const normalizedTimeZone =
    normalizeTimeZone(timeZone);

  if (!normalizedTimeZone) {
    return null;
  }

  const instant =
    now instanceof Date
      ? now
      : new Date(now);

  if (Number.isNaN(instant.getTime())) {
    return null;
  }

  const today =
    localDateKey(
      instant,
      normalizedTimeZone
    );

  let localStartDate;
  let localEndDateExclusive;

  switch (normalizedPeriod) {
    case "THIS_MONTH":
      localStartDate =
        firstDayOfMonth(today);
      localEndDateExclusive =
        firstDayOfNextMonth(today);
      break;

    case "LAST_30_DAYS":
      localStartDate =
        addLocalDays(today, -29);
      localEndDateExclusive =
        addLocalDays(today, 1);
      break;

    case "LAST_90_DAYS":
      localStartDate =
        addLocalDays(today, -89);
      localEndDateExclusive =
        addLocalDays(today, 1);
      break;

    case "THIS_YEAR":
      localStartDate =
        firstDayOfYear(today);
      localEndDateExclusive =
        firstDayOfNextYear(today);
      break;

    default:
      return null;
  }

  const startsAt =
    localMidnightUtc(
      localStartDate,
      normalizedTimeZone
    );

  const endsAt =
    localMidnightUtc(
      localEndDateExclusive,
      normalizedTimeZone
    );

  if (
    Number.isNaN(startsAt.getTime()) ||
    Number.isNaN(endsAt.getTime()) ||
    startsAt >= endsAt
  ) {
    return null;
  }

  return Object.freeze({
    period: normalizedPeriod,
    timeZone: normalizedTimeZone,
    localStartDate,
    localEndDateExclusive,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  });
}

module.exports = {
  REVENUE_PERIODS,
  buildRevenuePeriod,
  firstDayOfMonth,
  firstDayOfNextMonth,
  firstDayOfNextYear,
  firstDayOfYear,
  normalizeRevenuePeriod,
};
