"use strict";

const baseSnapshot = require("../004-r1/snapshot");

const {
  ledgerIdentityFingerprint,
  objectFingerprint,
  prestateFingerprint,
} = require("./fingerprints");

async function readSnapshot(
  client,
  markers,
  { postconditions = false } = {}
) {
  const snapshot =
    await baseSnapshot.readSnapshot(
      client,
      markers,
      { postconditions }
    );

  snapshot.ledgerFingerprint =
    ledgerIdentityFingerprint(snapshot.ledger);

  snapshot.catalogFingerprint =
    objectFingerprint(snapshot.catalog);

  if (postconditions) {
    snapshot.prestateFingerprint =
      prestateFingerprint(snapshot, {
        postgresVersionPrefix: "18.6",
      });
  }

  return snapshot;
}

module.exports = Object.freeze({
  ...baseSnapshot,
  readSnapshot,
});
