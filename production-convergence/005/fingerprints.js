"use strict";

const crypto = require("node:crypto");
const base = require("../004-r1/fingerprints");

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(value[key])}`
      )
      .join(",")}}`;
  }

  throw new TypeError("UNSUPPORTED_CANONICAL_VALUE");
}

function objectFingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex");
}

function ledgerIdentityFingerprint(entries) {
  const material = entries
    .map(({ filename, checksum }) => ({
      filename,
      checksum,
    }))
    .sort((left, right) =>
      left.filename.localeCompare(right.filename)
    )
    .map(
      ({ filename, checksum }) =>
        `${filename}\0${checksum}`
    )
    .join("\n");

  return crypto
    .createHash("sha256")
    .update(material)
    .digest("hex");
}

function prestateContract(snapshot, {
  postgresVersionPrefix = "18.6",
} = {}) {
  return Object.freeze({
    postgresVersionPrefix,

    ledger: (snapshot.ledger || []).map(
      ({ filename, checksum, executionTarget }) => ({
        filename,
        checksum,
        executionTarget,
      })
    ),

    catalog: snapshot.catalog,

    preservation: snapshot.preservation,

    ownerBackfillEligibility:
      snapshot.ownerBackfillEligibility,

    ownerMembership:
      snapshot.ownerMembership,

    operationalCounts:
      snapshot.operationalCounts,
  });
}

function prestateFingerprint(snapshot, options) {
  return objectFingerprint(
    prestateContract(snapshot, options)
  );
}

module.exports = Object.freeze({
  ...base,
  canonicalize,
  ledgerIdentityFingerprint,
  objectFingerprint,
  prestateContract,
  prestateFingerprint,
});
