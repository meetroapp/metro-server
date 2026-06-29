"use strict";

const RESERVED_EMAIL_SUFFIX = "@example.test";
const PROHIBITED_VALUE_MARKERS = [
  "railway.app",
  "up.railway.app",
  "BEGIN PRIVATE KEY",
  "DATABASE_URL=",
  "JWT_SECRET=",
];

function collectScalarValues(value, values = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectScalarValues(item, values);
    }
    return values;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectScalarValues(item, values);
    }
    return values;
  }

  values.push(value);
  return values;
}

function validateSanitizedFixture(fixture) {
  const blockers = [];

  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    return {
      valid: false,
      blockers: ["Fixture must be a record object."],
    };
  }

  if (
    typeof fixture.email === "string" &&
    !fixture.email.endsWith(RESERVED_EMAIL_SUFFIX)
  ) {
    blockers.push("Fixture email must use the example.test reserved domain.");
  }

  for (const value of collectScalarValues(fixture)) {
    if (typeof value !== "string") {
      continue;
    }

    for (const marker of PROHIBITED_VALUE_MARKERS) {
      if (value.includes(marker)) {
        blockers.push(`Fixture contains prohibited value marker: ${marker}`);
      }
    }
  }

  for (const prohibitedKey of ["password", "token", "jwt", "database_url"]) {
    if (Object.prototype.hasOwnProperty.call(fixture, prohibitedKey)) {
      blockers.push(`Fixture must not contain ${prohibitedKey}.`);
    }
  }

  return {
    valid: blockers.length === 0,
    blockers,
  };
}

function createSeedShape(table, record) {
  const validation = validateSanitizedFixture(record);

  if (!validation.valid) {
    throw new Error(`Unsafe fixture: ${validation.blockers.join(" ")}`);
  }

  if (typeof table !== "string" || !/^[a-z][a-z0-9_]*$/.test(table)) {
    throw new Error("Seed table name is invalid.");
  }

  return Object.freeze({
    table,
    record: Object.freeze({ ...record }),
  });
}

module.exports = {
  RESERVED_EMAIL_SUFFIX,
  createSeedShape,
  validateSanitizedFixture,
};
